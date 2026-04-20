// Lasker content-script controller.
//
// 0.11.0 reshape: the Analyze surface is no longer a live engine advisor.
// It's a post-game batch reviewer. On explicit click, Lasker reads the
// finished game's SAN list from chess.com's DOM, runs Stockfish against
// EVERY ply once, caches the full review in memory, rewinds the board
// to the starting position, and thereafter serves instant cached
// feedback as the user steps through the game. Learn is unchanged --
// engine stays off, study mode drives the display.
//
// Responsibilities:
//   - Mount the overlay and restore preferences.
//   - Subscribe to LaskerFairPlay; hard-gate EVERYTHING on the current page
//     context. An unsafe context tears down the engine, cancels any running
//     batch, and flips the overlay to its locked state.
//   - Poll the board every POLL_MS so we can detect the user stepping
//     through the game (even in ready-review state).
//   - On a position change:
//       * Analyze surface: if we have a review cache, look up the current
//         position in it and paint everything from cache. If the hash isn't
//         in the cache (user played a new move), flip to "stale". If no
//         review has been run yet, show the idle card.
//       * Learn surface: update the Study card against the new grid hash.
//   - Expose a `startBatchAnalysis()` entry point to the overlay, which
//     orchestrates LaskerAnalyzeSession.run over the move-list SANs.

(function () {
  "use strict";

  const POLL_MS = 500;

  /** Require this many consecutive cache misses before marking review stale
   * (avoids "Outside cached analysis" during chess.com board animations). */
  const REVIEW_STALE_MISS_STREAK = 5;
  const STORAGE_KEY = "lasker.settings";
  const ACCEPT_KEY = "lasker.acceptedFairPlay";
  // 0.11.0: `depth` is now the BATCH depth, applied at the start of the
  // next run. The live engine is gone, so changing depth no longer
  // re-kicks anything.
  const DEFAULT_SETTINGS = {
    enabled: false,
    depth: 18,                // batch depth; 14/18/22 presets in settings
    theme: "dark",
    size: "medium",
    collapsed: false,
    mode: "focus",            // "focus" | "advanced"
    advisor: "my-side",       // "my-side" | "both-sides"
    width: null,              // null = use size preset; number = drag-resized px
    showArrows: true,         // 0.8 -- SVG board-arrow guidance
    surface: "analyze",       // 0.9 -- "analyze" (batch review) | "learn"
  };

  const SEVERITIES = [
    "brilliant", "great", "best", "good", "book",
    "inaccuracy", "mistake", "blunder",
  ];

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    acceptedFairPlay: false,
    context: null,
    lastHash: null,
    turn: "w",
    plyCount: 0,
    playerColor: null,
    pollHandle: null,
    currentFen: null,
    currentGrid: null,
    inBookNow: false,
    tally: emptyTally(),

    // 0.11.0: the in-memory review cache. Replaces the live-engine state.
    review: {
      status: "idle",        // "idle" | "running" | "ready" | "stale"
      sans: [],
      plies: null,           // PlyEntry[] once ready
      byHash: null,          // Map<hash, PlyEntry>
      playerColor: "w",
      result: null,          // "1-0" | "0-1" | "1/2-1/2" | null
      depth: DEFAULT_SETTINGS.depth,
      startHash: null,
      totalMoves: 0,
      currentPly: null,
      abortCtrl: null,
      startedAt: null,
      lastProgress: null,    // { done, total, currentPly, currentSan, ... }
      error: null,
      // Interactive navigation (ready state): chess.com board sync + UX grace.
      navGraceUntil: 0,
      expectedPly: null,
      replayMeta: null,
      cacheMissStreak: 0,
      lastStablePly: null,
    },

    // Learn surface (unchanged).
    catalog: null,
    studying: null,
  };

  function log(...args) { console.log("[Lasker]", ...args); }

  // Extra review/nav logs: in DevTools console run
  //   localStorage.setItem("laskerReviewDebug","1")
  // then reload chess.com (disable with removeItem).
  function reviewVerbose() {
    try {
      return typeof localStorage !== "undefined"
        && localStorage.getItem("laskerReviewDebug") === "1";
    } catch (_e) {
      return false;
    }
  }

  /** Structured diagnostics for cache misses & navigation (prefix [Lasker/review]). */
  function logReview(tag, payload) {
    try {
      if (payload !== undefined && payload !== null && typeof payload === "object") {
        console.log("[Lasker/review]", tag, payload);
      } else if (payload !== undefined) {
        console.log("[Lasker/review]", tag, payload);
      } else {
        console.log("[Lasker/review]", tag);
      }
    } catch (_e) {
      console.log("[Lasker/review]", tag, payload);
    }
  }

  // After reloading the extension in chrome://extensions, this tab may still
  // be running an old isolate; chrome.runtime APIs throw "Extension context
  // invalidated." until the user refreshes chess.com.
  let extensionContextDead = false;

  function extensionContextAlive() {
    if (extensionContextDead) return false;
    const chk = window.LaskerExtensionContext;
    if (chk && typeof chk.alive === "function") return chk.alive();
    try {
      chrome.runtime.getURL("/");
      return true;
    } catch (_e) {
      return false;
    }
  }

  function isInvalidatedError(err) {
    const msg = err && (err.message || String(err));
    return !!(msg && /extension context invalidated/i.test(msg));
  }

  function handleExtensionInvalidated() {
    if (extensionContextDead) return;
    extensionContextDead = true;
    log("extension context invalidated — refresh this chess.com tab (F5)");
    try {
      cancelBatchAnalysis();
      stopPolling();
      state.lastHash = null;
      resetReviewTo("idle");
      state.review.error = "extension invalidated";
    } catch (_e) {}
    try {
      window.LaskerOverlay.setEngineThinking(false);
      window.LaskerOverlay.setStatus("reload tab — extension updated");
      window.LaskerOverlay.setReviewState("idle", {
        moveCount: 0,
        result: null,
        playerColor: state.playerColor || "w",
        depth: state.settings.depth,
        hasMoveList: false,
        error:
          "Chrome disconnected this tab from LASKER (happens after you reload the extension). Refresh this page (F5), then enable LASKER again.",
      });
    } catch (_e) {}
  }

  // ---------------------------------------------------------------------------
  // Tally / session summary
  // ---------------------------------------------------------------------------
  function emptyTally() {
    const t = {};
    for (const s of SEVERITIES) t[s] = { w: 0, b: 0 };
    return t;
  }
  const ACCURACY_POINTS = {
    brilliant: 100, great: 100, best: 98, good: 92, book: 95,
    inaccuracy: 72, mistake: 45, blunder: 20,
  };
  // 0.11.0: tally is rebuilt from the full review cache at batch
  // completion (and whenever the advisor scope changes). There's no
  // longer an incremental per-move add -- we have the whole game up
  // front.
  function rebuildTallyFromReview() {
    state.tally = emptyTally();
    const r = state.review;
    if (!r || !Array.isArray(r.plies)) return;
    for (const entry of r.plies) {
      const c = entry && entry.classification;
      if (!c || !entry.mover) continue;
      const sev = c.severity;
      if (!state.tally[sev]) state.tally[sev] = { w: 0, b: 0 };
      state.tally[sev][entry.mover] = (state.tally[sev][entry.mover] | 0) + 1;
    }
  }
  function pushSummaryToOverlay() {
    const isMySide = state.settings.advisor === "my-side";
    const mine = state.playerColor || "w";
    const counts = {};
    let total = 0;
    let points = 0;
    for (const s of SEVERITIES) {
      const bucket = state.tally[s] || { w: 0, b: 0 };
      const c = isMySide ? (bucket[mine] | 0) : ((bucket.w | 0) + (bucket.b | 0));
      counts[s] = c;
      total += c;
      points += c * ACCURACY_POINTS[s];
    }
    const hasAny = total > 0;
    const accuracy = hasAny ? Math.max(0, Math.min(100, Math.round(points / total))) : null;
    window.LaskerOverlay.setSummary({
      counts,
      total,
      accuracy,
      scope: isMySide ? "my-side" : "both-sides",
    });
  }

  // ---------------------------------------------------------------------------
  // Storage
  // ---------------------------------------------------------------------------
  function loadAll() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([STORAGE_KEY, ACCEPT_KEY], (result) => {
          resolve({
            settings: { ...DEFAULT_SETTINGS, ...(result[STORAGE_KEY] || {}) },
            acceptedFairPlay: !!result[ACCEPT_KEY],
          });
        });
      } catch (_err) {
        resolve({ settings: { ...DEFAULT_SETTINGS }, acceptedFairPlay: false });
      }
    });
  }
  function saveSettings(s) { try { chrome.storage.local.set({ [STORAGE_KEY]: s }); } catch (_err) {} }
  function saveAcceptance(flag) { try { chrome.storage.local.set({ [ACCEPT_KEY]: !!flag }); } catch (_err) {} }

  // ---------------------------------------------------------------------------
  // Board plumbing
  // ---------------------------------------------------------------------------
  function waitForBoard() {
    return new Promise((resolve) => {
      const existing = window.LaskerBoardReader.findBoard();
      if (existing) return resolve(existing);
      const observer = new MutationObserver(() => {
        const b = window.LaskerBoardReader.findBoard();
        if (b) { observer.disconnect(); resolve(b); }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  // ---------------------------------------------------------------------------
  // Pseudo-SAN from UCI (used for engine-hint text when rendering cached
  // best moves; duplicate of the helper in analyze-session.js on purpose,
  // so Learn can reuse it too without a cross-module dependency).
  // ---------------------------------------------------------------------------
  function uciToPseudoSan(uci, grid) {
    if (!uci || uci.length < 4 || !grid) return null;
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promo = uci.slice(4, 5);
    const fFile = from.charCodeAt(0) - 97;
    const fRank = parseInt(from[1], 10) - 1;
    const tFile = to.charCodeAt(0) - 97;
    const tRank = parseInt(to[1], 10) - 1;
    if (fFile < 0 || fFile > 7 || fRank < 0 || fRank > 7) return null;
    const piece = grid[fRank] && grid[fRank][fFile];
    if (!piece) return null;
    const target = grid[tRank] && grid[tRank][tFile];
    const isCapture = !!target;
    const pieceUpper = piece.toUpperCase();
    if (pieceUpper === "K" && Math.abs(tFile - fFile) === 2) {
      return tFile === 6 ? "O-O" : "O-O-O";
    }
    if (pieceUpper === "P") {
      const capStr = isCapture ? `${from[0]}x` : "";
      const promoStr = promo ? `=${promo.toUpperCase()}` : "";
      return `${capStr}${to}${promoStr}`;
    }
    return `${pieceUpper}${isCapture ? "x" : ""}${to}`;
  }

  /** Normalise SAN-like strings so we can detect "best === played". */
  function normalizeSanCompare(s) {
    const t = String(s || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "");
    if (!t) return "";
    if (t === "o-o" || t === "0-0") return "castle-k";
    if (t === "o-o-o" || t === "0-0-0") return "castle-q";
    return t.replace(/[=+#]/g, "");
  }

  /**
   * True when the engine’s best move from the pre-mistake position is the
   * same as the move the player played (UCI preferred; SAN fallback).
   */
  function engineBestMatchesPlayed(prev, mistakeEntry) {
    if (!prev || !mistakeEntry) return false;
    const bu = prev.bestUci && String(prev.bestUci).toLowerCase().trim();
    const lu = mistakeEntry.lastUci && String(mistakeEntry.lastUci).toLowerCase().trim();
    if (bu && lu && bu === lu) return true;
    const prevGrid = prev.grid || prev.fromGrid;
    const bestSan = prev.bestSan || uciToPseudoSan(prev.bestUci, prevGrid);
    const played = mistakeEntry.lastSan;
    if (!bestSan || !played) return false;
    return normalizeSanCompare(bestSan) === normalizeSanCompare(played);
  }

  /** Best reply from the position before the mistake (prev ply), or null if unusable / duplicate of played. */
  function bestFromPreMistakePosition(prev, mistakeEntry) {
    if (!prev || !mistakeEntry) return null;
    if (engineBestMatchesPlayed(prev, mistakeEntry)) return null;
    const prevGrid = prev.grid || prev.fromGrid;
    return prev.bestSan || uciToPseudoSan(prev.bestUci, prevGrid) || null;
  }

  // ---------------------------------------------------------------------------
  // Principles (same heuristic as 0.10).
  // ---------------------------------------------------------------------------
  function computePrinciples(grid, playerColor) {
    if (!grid || !playerColor) return null;
    const isWhite = playerColor === "w";
    const ownKing = isWhite ? "K" : "k";
    const ownKnight = isWhite ? "N" : "n";
    const ownBishop = isWhite ? "B" : "b";
    const homeRank = isWhite ? 0 : 7;

    let kingFile = -1;
    for (let f = 0; f < 8; f++) {
      if (grid[homeRank] && grid[homeRank][f] === ownKing) { kingFile = f; break; }
    }
    let king;
    if (kingFile === -1) king = "exposed";
    else if (kingFile === 6 || kingFile === 2) king = "safe";
    else if (kingFile === 4) king = "home";
    else king = "exposed";

    const knightStart = isWhite ? [[0, 1], [0, 6]] : [[7, 1], [7, 6]];
    const bishopStart = isWhite ? [[0, 2], [0, 5]] : [[7, 2], [7, 5]];
    let onHome = 0;
    for (const [r, f] of knightStart) if (grid[r] && grid[r][f] === ownKnight) onHome++;
    for (const [r, f] of bishopStart) if (grid[r] && grid[r][f] === ownBishop) onHome++;
    const moved = 4 - onHome;
    const development = moved >= 3 ? "good" : moved >= 1 ? "partial" : "none";

    const ownPawn = isWhite ? "P" : "p";
    const centreSquares = [[3, 3], [3, 4], [4, 3], [4, 4]];
    let centreHeld = false;
    for (const [r, f] of centreSquares) {
      if (grid[r] && grid[r][f] === ownPawn) { centreHeld = true; break; }
    }
    const centre = centreHeld ? "good" : "weak";
    return { king, development, centre };
  }

  // ---------------------------------------------------------------------------
  // Paint the overlay from a cached PlyEntry.
  // ---------------------------------------------------------------------------
  function paintFromCache(entry, navSyncing) {
    if (!entry) return;
    state.review.currentPly = entry.ply;
    state.review.lastStablePly = entry.ply;
    state.review.cacheMissStreak = 0;
    // Keep poll / FEN composer in sync with the analyst grid (hash toggles
    // alone can drift turn during rapid chess.com navigation).
    if (entry.turn === "w" || entry.turn === "b") {
      state.turn = entry.turn;
    }

    // Eval bar + score + top line.
    window.LaskerOverlay.setEvaluation({
      scoreCp: entry.scoreCp,
      scoreMate: entry.scoreMate,
      depth: entry.depth,
      lines: [{ scoreCp: entry.scoreCp, scoreMate: entry.scoreMate, pv: entry.pv || [] }],
      turn: entry.turn,
      playerColor: state.playerColor,
    });

    // Assessment line (pre-computed in the batch).
    window.LaskerOverlay.setAssessment(entry.assessment || null);

    // Last-move card, with my-side muting.
    paintLastMove(entry);

    // Principles from the CURRENT live grid (not cache, since the user
    // may have taken back or scrubbed).
    window.LaskerOverlay.setPrinciples(
      computePrinciples(state.currentGrid || entry.grid, state.playerColor)
    );

    // Opening pill + learn-link (slim variant).
    if (entry.opening && entry.opening.name) {
      const catalogOpId = catalogOpIdForName(entry.opening.name);
      window.LaskerOverlay.setOpeningPill({
        name: entry.opening.name,
        eco: entry.opening.eco || "",
        catalogOpId,
      });
      state.inBookNow = true;
    } else {
      window.LaskerOverlay.setOpeningPill(null);
      state.inBookNow = false;
    }

    // Engine hint bubble.
    paintEngineHint(entry);

    // Board arrows (cached best move).
    renderArrows();

    pushReviewNavUi(entry, !!navSyncing);
  }

  function paintLastMove(entry) {
    if (!entry || !entry.classification || !entry.mover) {
      window.LaskerOverlay.setLastMove(null);
      return;
    }
    const isMySide = state.settings.advisor === "my-side";
    const itWasMyMove = !state.playerColor || entry.mover === state.playerColor;
    if (isMySide && !itWasMyMove) {
      window.LaskerOverlay.setLastMove(null);
      return;
    }
    const c = entry.classification;
    const played = entry.lastSan || "—";
    const mover = entry.mover;
    const who = !state.playerColor
      ? (mover === "w" ? "White" : "Black")
      : (itWasMyMove ? "You" : "Your opponent");
    const prev = entry.ply > 0 ? state.review.plies[entry.ply - 1] : null;
    const bestSan = prev ? bestFromPreMistakePosition(prev, entry) : null;
    const headline = `${who} played ${played}. Quality: ${c.label}.`;
    let bestLineNote = "";
    if (bestSan) {
      bestLineNote = "The line below is what the engine wanted from the position before that move — not a random suggestion from later in the game.";
    }
    window.LaskerOverlay.setLastMove({
      headline,
      severity: c.severity,
      badge: c.badge || "",
      detail: c.detail || "",
      bestSan,
      bestLineNote,
      missedText: c.missedText || "",
    });
  }

  function paintEngineHint(entry) {
    if (!entry || !entry.bestUci) {
      window.LaskerOverlay.setEngineHint(null);
      return;
    }
    const san = entry.bestSan
      || uciToPseudoSan(entry.bestUci, entry.grid)
      || null;
    if (!san) { window.LaskerOverlay.setEngineHint(null); return; }

    const describeText = window.LaskerEngineHints.describeMove({
      san,
      mover: entry.turn,
      currScoreCp: entry.scoreCp,
      currScoreMate: entry.scoreMate,
      inBook: !!entry.inBook,
    });
    const itIsPlayersTurn = !state.playerColor || entry.turn === state.playerColor;
    const isMySide = state.settings.advisor === "my-side";
    let text = describeText;
    let muted = false;
    if (isMySide && !itIsPlayersTurn) {
      text = `Opponent likely: ${san}. Prepare to respond.`;
      muted = true;
    }
    const detail = formatCachedCoachDetail(entry);
    window.LaskerOverlay.setEngineHint({ text, detail, source: "stockfish", muted });
  }

  function formatCachedCoachDetail(entry) {
    if (!entry) return "";
    const scoreStr = entry.scoreMate !== null && entry.scoreMate !== undefined
      ? `M${entry.scoreMate}`
      : (entry.scoreCp !== null && entry.scoreCp !== undefined
          ? `${(entry.scoreCp / 100).toFixed(2)}`
          : "--");
    const pv = (entry.pv || []).slice(0, 8).join(" ");
    return `Engine line (depth ${entry.depth || "?"}):\n1. ${scoreStr}  ${pv}`;
  }

  function clearMistakeLesson() {
    try {
      if (state.review) state.review.activeMistakePly = null;
      if (window.LaskerOverlay.setMistakeLesson) window.LaskerOverlay.setMistakeLesson(null);
    } catch (_e) {}
  }

  /**
   * True when plain-language eval text already quotes a pawn swing close to
   * `magPawns` (avoids repeating the same number in the “vs best” sentence).
   */
  function plainAlreadyStatesSimilarSwing(plain, magPawns, epsilon = 0.35) {
    if (!plain || magPawns == null || Number.isNaN(magPawns)) return false;
    const re =
      /(?:about|roughly|close to|approximately)?\s*(\d+(?:\.\d+)?)\s+pawns/gi;
    let m;
    while ((m = re.exec(plain)) !== null) {
      const n = parseFloat(m[1], 10);
      if (Math.abs(n - magPawns) <= epsilon) return true;
    }
    return false;
  }

  /** Turn classification.missedText into one coaching sentence fragment. */
  function friendlyMissedComparedToBest(missedText, bestSan, moveRef, plainForDedup) {
    if (!missedText || !bestSan) return "";
    const whoMoved = moveRef || "your move";
    const forced = missedText.match(/forced\s+M(\d+)/i);
    if (forced) {
      return (
        `Compared with ${bestSan}, ${whoMoved} walked past a mating attack — the stored line had mate in ${forced[1]}.`
      );
    }
    const m = missedText.match(/missed\s+([+-]?\d+(?:\.\d+)?)/i);
    if (!m) return "";
    const v = parseFloat(m[1], 10);
    const mag = Math.abs(v);

    if (plainForDedup && plainAlreadyStatesSimilarSwing(plainForDedup, mag)) {
      return (
        `From that same diagram, the analysis preferred ${bestSan} — a different idea than ${whoMoved}.`
      );
    }

    if (mag >= 5) {
      return (
        `Against ${bestSan}, ${whoMoved} costs on the order of ${mag.toFixed(1)} pawns of advantage — a huge swing.`
      );
    }
    if (mag >= 1.5) {
      return (
        `Against ${bestSan}, ${whoMoved} gave back roughly ${mag.toFixed(1)} pawns of advantage.`
      );
    }
    return (
      `Against ${bestSan}, the slip is closer to ${mag.toFixed(2)} pawns — small in isolation, but it adds up.`
    );
  }

  function buildMistakeLesson(entry, prev) {
    const hints = window.LaskerEngineHints;
    const labels = window.LaskerLabels;
    if (!entry || !entry.classification || !hints) return null;
    const c = entry.classification;
    const played = entry.lastSan || "that move";
    const mover = entry.mover;
    const isYou = !state.playerColor || state.playerColor === mover;
    const who = isYou ? "You" : (mover === "w" ? "White" : "Black");

    const plain =
      (c.detailPlain ||
        (labels && labels.plainEvalSummary
          ? labels.plainEvalSummary({
              prevWhiteCp: prev ? prev.whiteCp : null,
              prevWhiteMate: prev ? prev.whiteMate : null,
              currWhiteCp: entry.whiteCp,
              currWhiteMate: entry.whiteMate,
              mover,
            })
          : "")) || "";

    let why;
    if (plain) {
      why = `${who} played ${played} — ${c.label}. ${plain}`;
    } else {
      why =
        `${who} played ${played}. The move is labeled ${c.label}: the evaluation swings sharply against your side.`;
    }

    const moveRef = isYou ? "your move" : `${who}'s move`;
    const compare = friendlyMissedComparedToBest(
      c.missedText,
      c.bestSan,
      moveRef,
      plain
    );
    if (compare) {
      why += ` ${compare}`;
    }

    let better = "";
    const best = prev ? bestFromPreMistakePosition(prev, entry) : null;
    if (best && prev) {
      const dm = hints.describeMove({
        san: best,
        mover: prev.turn,
        currScoreCp: null,
        currScoreMate: null,
        inBook: !!prev.inBook,
      });
      const fluid = dm.replace(/^Book move:\s*/i, "").replace(/^Play\s+/, "");
      better =
        `From the diagram before ${played}, the strongest try in the saved analysis starts with ${best}: ${fluid}`.trim();
    } else {
      better =
        "No clearer alternative was stored for this branch (or it matched your move after normalisation). " +
        "Use the eval bar and “Tell me more” on the suggestion bubble to compare lines.";
    }

    const swing = c.moverDeltaCp;
    const next =
      (hints.severityTheory &&
        hints.severityTheory(c.severity, { moverDeltaCp: swing })) ||
      "";

    return { why, better, next };
  }

  function collectMistakePlies() {
    const r = state.review;
    if (!r || !Array.isArray(r.plies)) return [];
    const isMySide = state.settings.advisor === "my-side";
    const out = [];
    for (const ent of r.plies) {
      const c = ent.classification;
      if (!c || !ent.mover) continue;
      if (isMySide && state.playerColor && ent.mover !== state.playerColor) continue;
      if (!["inaccuracy", "mistake", "blunder"].includes(c.severity)) continue;
      out.push(ent.ply);
    }
    return out;
  }

  function mistakeTourMeta(mistakePly) {
    const plies = collectMistakePlies();
    const idx = plies.indexOf(mistakePly);
    if (idx < 0 || plies.length === 0) return null;
    return { index: idx + 1, total: plies.length };
  }

  async function mistakeTourStep(delta) {
    const plies = collectMistakePlies();
    if (plies.length === 0) return;
    let idx = state.review.activeMistakePly != null
      ? plies.indexOf(state.review.activeMistakePly)
      : (delta > 0 ? -1 : plies.length);
    let nextIdx = idx + delta;
    nextIdx = Math.max(0, Math.min(plies.length - 1, nextIdx));
    const mistakePly = plies[nextIdx];
    showMistakeLessonOnly(mistakePly);
    await jumpToPly(mistakePly);
  }

  function showMistakeLessonOnly(mistakePly) {
    const r = state.review;
    if (!r || !Array.isArray(r.plies) || !window.LaskerOverlay.setMistakeLesson) return;
    const entry = r.plies[mistakePly];
    if (!entry || !entry.classification) return;
    const prev = mistakePly > 0 ? r.plies[mistakePly - 1] : null;
    const lesson = buildMistakeLesson(entry, prev);
    if (!lesson) {
      window.LaskerOverlay.setMistakeLesson(null);
      return;
    }
    r.activeMistakePly = mistakePly;
    const tour = mistakeTourMeta(mistakePly);
    window.LaskerOverlay.setMistakeLesson({ ...lesson, tour });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /** First FEN field only — comparable between batch cache and board-reader. */
  function piecePlacementFromFen(fen) {
    if (!fen || typeof fen !== "string") return "";
    return fen.trim().split(/\s+/)[0] || "";
  }

  function gridsEqual(a, b) {
    if (!a || !b || !Array.isArray(a) || !Array.isArray(b)) return false;
    for (let r = 0; r < 8; r++) {
      if (!a[r] || !b[r]) return false;
      for (let f = 0; f < 8; f++) {
        const x = a[r][f];
        const y = b[r][f];
        if ((x == null ? null : x) !== (y == null ? null : y)) return false;
      }
    }
    return true;
  }

  /**
   * Resolve the cached PlyEntry for the live board: hash map first, then
   * scan by piece placement (handles occasional hash / timing mismatches).
   */
  function resolveReviewEntry(position, r) {
    if (!position || !r || !Array.isArray(r.plies)) return null;
    let e = r.byHash && r.byHash.get(position.hash);
    if (e) return e;
    const bp = position.boardFen || "";
    if (!bp) return null;
    for (let i = 0; i < r.plies.length; i++) {
      const ent = r.plies[i];
      if (!ent || !ent.fen) continue;
      if (piecePlacementFromFen(ent.fen) === bp) return ent;
    }
    const g = position.grid;
    if (g) {
      for (let i = 0; i < r.plies.length; i++) {
        const ent = r.plies[i];
        if (!ent || !ent.grid) continue;
        if (gridsEqual(g, ent.grid)) return ent;
      }
    }
    return null;
  }

  function reviewMaxPlyIndex(r) {
    if (!r || !Array.isArray(r.plies) || r.plies.length === 0) return 0;
    return r.plies.length - 1;
  }

  function pushReviewNavUi(entry, syncing) {
    const r = state.review;
    if (!r || r.status !== "ready" || !window.LaskerOverlay.setReviewNav) return;
    const max = reviewMaxPlyIndex(r);
    const ply = entry && Number.isFinite(entry.ply)
      ? Math.max(0, Math.min(max, entry.ply))
      : (r.expectedPly != null
          ? Math.max(0, Math.min(max, r.expectedPly))
          : 0);
    window.LaskerOverlay.setReviewNav({
      ply,
      maxPly: max,
      syncing: !!syncing,
    });
  }

  /** Best-effort current ply index from the live board + cache (not slider state). */
  function inferCurrentReviewPly(r) {
    if (!r || !Array.isArray(r.plies)) return 0;
    const pos = window.LaskerBoardReader.readPosition();
    if (pos) {
      const ent = resolveReviewEntry(pos, r);
      if (ent && Number.isFinite(ent.ply)) return ent.ply;
    }
    if (Number.isFinite(r.currentPly)) return r.currentPly;
    return 0;
  }

  /** Poll until live board matches cached ply (hash or piece placement). */
  async function waitForBoardAligned(targetPly, maxMs) {
    const r = state.review;
    if (!r || !Array.isArray(r.plies)) return false;
    const entry = r.plies[targetPly];
    if (!entry) return false;
    const deadline = Date.now() + maxMs;
    const targetPiece = piecePlacementFromFen(entry.fen);
    while (Date.now() < deadline) {
      const pos = window.LaskerBoardReader.readPosition();
      if (!pos) {
        await sleep(40);
        continue;
      }
      if (pos.hash === entry.hash) return true;
      if (targetPiece && pos.boardFen === targetPiece) return true;
      await sleep(45);
    }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Timeline rebuild (called once when review becomes ready, and whenever
  // advisor scope changes in-place).
  // ---------------------------------------------------------------------------
  function rebuildTimelineFromReview() {
    window.LaskerOverlay.resetTimeline();
    const r = state.review;
    if (!r || !Array.isArray(r.plies)) return;
    const isMySide = state.settings.advisor === "my-side";
    for (const entry of r.plies) {
      const c = entry.classification;
      if (!c || !entry.mover) continue;
      if (isMySide && state.playerColor && entry.mover !== state.playerColor) continue;
      window.LaskerOverlay.pushTimelineMove({
        ply: entry.ply,
        severity: c.severity,
        label: `${c.label}${c.badge ? " " + c.badge : ""}`,
        color: entry.mover,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Mistake list -- plies classified as inaccuracy/mistake/blunder,
  // sent to the overlay's clickable list.
  // ---------------------------------------------------------------------------
  function pushMistakeListToOverlay() {
    const r = state.review;
    if (!r || !Array.isArray(r.plies) || r.status !== "ready") {
      window.LaskerOverlay.setMistakeList(null);
      return;
    }
    const isMySide = state.settings.advisor === "my-side";
    state.review.activeMistakePly = null;
    const out = [];
    for (const entry of r.plies) {
      const c = entry.classification;
      if (!c || !entry.mover) continue;
      if (isMySide && state.playerColor && entry.mover !== state.playerColor) continue;
      if (!["inaccuracy", "mistake", "blunder"].includes(c.severity)) continue;
      // Present a 1-based move number (1.e4 = ply 1, 1...e5 = ply 2, etc.).
      const moveNumber = Math.floor((entry.ply - 1) / 2) + 1;
      const dotText = entry.mover === "w" ? `${moveNumber}.` : `${moveNumber}...`;
      const plyAfter = entry.ply;
      const plyBefore = entry.ply > 0 ? entry.ply - 1 : null;
      out.push({
        ply: plyAfter,
        plyBefore,
        plyAfter,
        mover: entry.mover,
        moveLabel: `${dotText} ${entry.lastSan || ""}`.trim(),
        severity: c.severity,
        badge: c.badge || "",
        label: c.label,
        missedText: c.missedText || null,
      });
    }
    window.LaskerOverlay.setMistakeList(out);
  }

  // ---------------------------------------------------------------------------
  // 0.11.0: Batch Analyze orchestration
  // ---------------------------------------------------------------------------
  function resetReviewTo(status, extra) {
    const r = state.review;
    // Abort any in-flight batch.
    if (r && r.abortCtrl) {
      try { r.abortCtrl.abort(); } catch (_err) {}
    }
    state.review = {
      status,
      sans: [],
      plies: null,
      byHash: null,
      playerColor: state.playerColor || "w",
      result: null,
      depth: state.settings.depth,
      startHash: null,
      totalMoves: 0,
      currentPly: null,
      abortCtrl: null,
      startedAt: null,
      lastProgress: null,
      error: null,
      navGraceUntil: 0,
      expectedPly: null,
      replayMeta: null,
      cacheMissStreak: 0,
      lastStablePly: null,
      activeMistakePly: null,
      ...(extra || {}),
    };
  }

  // Update the idle card with a fresh game summary (move count + result
  // + which side the user played). Called whenever the move list or
  // player colour changes and the review is in idle/stale state.
  function refreshIdleCard() {
    const reader = window.LaskerMoveListReader;
    // Defensive: always at least put the overlay into the idle state so
    // the "Analyze this game" card is visible. Everything else is best
    // effort -- we never want a missing helper to leave the user with a
    // blank pane and no button.
    let sans = [];
    let result = null;
    let detected = state.playerColor || "w";
    let hasMoveList = false;
    if (reader) {
      try { sans = reader.readMoves() || []; } catch (_err) {}
      try { result = reader.detectResult(); } catch (_err) {}
      try {
        if (reader.detectPlayerColor) detected = reader.detectPlayerColor();
      } catch (_err) {}
      try { hasMoveList = !!reader.findMoveList(); } catch (_err) {}
    }
    log(
      "idle card:",
      `moves=${sans.length}`,
      `hasMoveList=${hasMoveList}`,
      `result=${result || "none"}`,
      `playerColor=${detected}`,
      `depth=${state.settings.depth}`
    );
    window.LaskerOverlay.setReviewState("idle", {
      moveCount: sans.length,
      result,
      playerColor: detected,
      depth: state.settings.depth,
      hasMoveList,
    });
    // Keep the status line in sync so users never see a stale
    // "starting engine..." or "waiting for game..." after the idle
    // card has taken over the surface.
    if (sans.length > 0) {
      window.LaskerOverlay.setStatus("ready to review");
    } else {
      window.LaskerOverlay.setStatus("waiting for game...");
    }
  }

  async function startBatchAnalysis() {
    if (!canRun()) {
      const msg = fairPlayGateMessage();
      log("batch: fair-play gate prevents run", fairPlayGateDebug(), msg);
      const reader = window.LaskerMoveListReader;
      let sans = [];
      let hasMoveList = false;
      let result = null;
      let detected = state.playerColor || "w";
      if (reader) {
        try { sans = reader.readMoves() || []; } catch (_e) {}
        try { hasMoveList = !!reader.findMoveList(); } catch (_e) {}
        try { result = reader.detectResult(); } catch (_e) {}
        try {
          if (reader.detectPlayerColor) detected = reader.detectPlayerColor();
        } catch (_e) {}
      }
      window.LaskerOverlay.setReviewState("idle", {
        moveCount: sans.length,
        result,
        playerColor: detected,
        depth: state.settings.depth,
        hasMoveList,
        error: msg || "Fair Play blocked this analysis run.",
      });
      window.LaskerOverlay.setStatus("blocked");
      return;
    }
    if (!extensionContextAlive()) {
      handleExtensionInvalidated();
      return;
    }
    if (!state.context || !state.context.engineAllowed) {
      log("batch: engine not allowed in current context");
      return;
    }
    const reader = window.LaskerMoveListReader;
    const session = window.LaskerAnalyzeSession;
    if (!reader || !session) {
      log("batch: missing reader/session module");
      return;
    }
    const sans = reader.readMoves();
    if (!sans || sans.length === 0) {
      window.LaskerOverlay.setReviewState("idle", {
        moveCount: 0,
        result: null,
        playerColor: state.playerColor || "w",
        depth: state.settings.depth,
        hasMoveList: !!reader.findMoveList(),
        error: "No moves found on the page. Open a finished game or the analysis board with a game loaded.",
      });
      return;
    }

    const result = reader.detectResult();
    const playerColor = reader.detectPlayerColor
      ? reader.detectPlayerColor()
      : (state.playerColor || "w");

    const ctrl = new AbortController();
    resetReviewTo("running", {
      sans,
      result,
      playerColor,
      depth: state.settings.depth,
      totalMoves: sans.length,
      abortCtrl: ctrl,
      startedAt: Date.now(),
    });
    state.playerColor = playerColor;

    window.LaskerOverlay.setReviewState("running", {
      moveCount: sans.length,
      result,
      playerColor,
      depth: state.settings.depth,
    });
    window.LaskerOverlay.setReviewProgress({
      done: 0,
      total: sans.length + 1,
      currentPly: 0,
      etaSec: null,
    });
    window.LaskerOverlay.setEngineThinking(true);
    window.LaskerOverlay.setStatus(`analyzing (depth ${state.settings.depth})...`);
    // Keep the timeline / summary / mistakes blank while the batch runs.
    window.LaskerOverlay.resetTimeline();
    window.LaskerOverlay.setSummary(null);
    window.LaskerOverlay.setMistakeList(null);
    if (window.LaskerBoardArrows) window.LaskerBoardArrows.clear();

    try {
      const review = await session.run({
        sans,
        depth: state.settings.depth,
        playerColor,
        result,
        signal: ctrl.signal,
        onProgress: (p) => {
          if (state.review.status !== "running") return;
          state.review.lastProgress = p;
          const elapsedMs = Date.now() - (state.review.startedAt || Date.now());
          const rate = p.done > 0 ? elapsedMs / p.done : 0;    // ms / ply
          const etaSec = rate > 0 && p.total > p.done
            ? Math.round(rate * (p.total - p.done) / 1000)
            : null;
          window.LaskerOverlay.setReviewProgress({
            done: p.done,
            total: p.total,
            currentPly: p.currentPly,
            currentSan: p.currentSan,
            etaSec,
          });
        },
      });

      // User may have cancelled while the session was finalising; bail.
      if (ctrl.signal.aborted) return;

      state.review.plies = review.plies;
      state.review.byHash = review.byHash;
      state.review.startHash = review.startHash;
      state.review.status = "ready";
      state.review.cacheMissStreak = 0;
      state.review.lastStablePly = null;
      state.review.abortCtrl = null;
      state.review.replayMeta = review.replayMeta || null;
      if (review.replayMeta && review.replayMeta.stopped) {
        logReview("replay shorter than DOM move list — review will go stale past expanded plies", {
          domSansRead: sans.length,
          replayedSans: review.replayMeta.replayedMoves,
          stopIndex: review.replayMeta.stopIndex,
          stopSan: review.replayMeta.stopSan,
          stopReason: review.replayMeta.stopReason,
          cachedPositions: Array.isArray(review.plies) ? review.plies.length : 0,
        });
      }

      rebuildTallyFromReview();
      rebuildTimelineFromReview();
      pushSummaryToOverlay();
      pushMistakeListToOverlay();

      window.LaskerOverlay.setReviewState("ready", {
        moveCount: review.totalMoves,
        result: review.result,
        playerColor: review.playerColor,
        depth: review.depth,
      });
      const maxPi = Array.isArray(review.plies) ? review.plies.length - 1 : 0;
      if (window.LaskerOverlay.setReviewNav) {
        window.LaskerOverlay.setReviewNav({
          ply: 0,
          maxPly: maxPi,
          syncing: true,
        });
      }
      window.LaskerOverlay.setEngineThinking(false);
      window.LaskerOverlay.setStatus("review ready");

      // Rewind the chess.com board to the start so the user begins the
      // review at ply 0, matching the "reset to back" spec.
      try { reader.goToStart(); } catch (_err) {}

      // The poll loop will pick up the new position and call
      // paintFromCache, but kick it immediately so there's no 500 ms
      // of stale UI.
      setTimeout(() => { try { tickPoll(true); } catch (_err) {} }, 80);
    } catch (err) {
      if (isInvalidatedError(err)) {
        handleExtensionInvalidated();
        return;
      }
      const aborted = err && /abort/i.test(err.message || "");
      state.review.status = aborted ? "idle" : "idle";
      state.review.abortCtrl = null;
      state.review.error = aborted ? null : (err && err.message) || "batch failed";
      window.LaskerOverlay.setEngineThinking(false);
      if (aborted) {
        log("batch: cancelled");
        window.LaskerOverlay.setStatus("cancelled");
      } else {
        log("batch: failed", err);
        window.LaskerOverlay.setStatus("error");
      }
      refreshIdleCard();
    }
  }

  function cancelBatchAnalysis() {
    const r = state.review;
    if (!r || r.status !== "running" || !r.abortCtrl) return;
    try { r.abortCtrl.abort(); } catch (_err) {}
  }

  function reanalyze() {
    // Drop cache, go back to idle, then re-run. We leave the board
    // where it is; the batch will rewind it on completion.
    resetReviewTo("idle");
    refreshIdleCard();
    startBatchAnalysis();
  }

  /**
   * Drive chess.com's board to a target ply.
   * Important: we step **relative** to the current board (next/prev only)
   * for small jumps so we never rewind to start on every click — that was
   * causing "replay all moves" and hash / turn drift (stale analysis).
   * Large jumps still use goToPly(start + n) for reliability.
   */
  async function jumpToPly(plyOrZero) {
    const r = state.review;
    if (!r || r.status !== "ready" || !Array.isArray(r.plies) || r.plies.length === 0) {
      log("jumpToPly: review not ready");
      return;
    }
    const maxP = r.plies.length - 1;
    const target = Math.max(0, Math.min(maxP, Number(plyOrZero) || 0));
    const reader = window.LaskerMoveListReader;
    if (!reader || !reader.goToPly) return;

    const fromPly = inferCurrentReviewPly(r);
    const diff = target - fromPly;

    if (diff === 0) {
      try {
        tickPoll(true);
      } catch (_err) {}
      return;
    }

    if (reviewVerbose()) {
      logReview("jumpToPly.request", {
        target,
        fromPly,
        diff,
        maxP,
        strategy: Math.abs(diff) <= 28 ? "relative-steps" : "absolute-goToPly",
      });
    }

    r.expectedPly = target;
    r.navGraceUntil = Date.now() + Math.min(18000, 5200 + Math.abs(diff) * 140);

    const stepMs = 52;
    try {
      if (Math.abs(diff) <= 28) {
        if (diff > 0) {
          for (let i = 0; i < diff; i++) {
            reader.goToNext();
            await sleep(stepMs);
          }
        } else {
          for (let i = 0; i < -diff; i++) {
            reader.goToPrev();
            await sleep(stepMs);
          }
        }
      } else {
        await reader.goToPly(target, { stepMs: 88 });
      }
      const alignBudget = Math.min(12000, 3200 + Math.abs(diff) * 130);
      const aligned = await waitForBoardAligned(target, alignBudget);
      if (reviewVerbose()) {
        logReview("jumpToPly.align", { target, aligned });
      }
    } catch (err) {
      log("jumpToPly failed:", err);
    }

    try {
      tickPoll(true);
    } catch (_err) {}
  }

  function reviewNavStep(delta) {
    const r = state.review;
    if (!r || r.status !== "ready" || !Array.isArray(r.plies)) return;
    clearMistakeLesson();
    const maxP = r.plies.length - 1;
    const fromPly = inferCurrentReviewPly(r);
    const next = Math.max(0, Math.min(maxP, fromPly + delta));
    jumpToPly(next);
  }

  async function reviewNavStart() {
    clearMistakeLesson();
    const reader = window.LaskerMoveListReader;
    const r = state.review;
    if (!reader || !r || r.status !== "ready" || !Array.isArray(r.plies)) return;
    r.expectedPly = 0;
    r.navGraceUntil = Date.now() + 6000;
    try {
      reader.goToStart();
      await sleep(95);
      await waitForBoardAligned(0, 4000);
    } catch (_e) {}
    try {
      tickPoll(true);
    } catch (_e) {}
  }

  async function reviewNavEnd() {
    clearMistakeLesson();
    const reader = window.LaskerMoveListReader;
    const r = state.review;
    if (!reader || !r || r.status !== "ready" || !Array.isArray(r.plies) || r.plies.length === 0) {
      return;
    }
    const maxP = r.plies.length - 1;
    r.expectedPly = maxP;
    r.navGraceUntil = Date.now() + 8000;
    try {
      reader.goToEnd();
      await sleep(130);
      await waitForBoardAligned(maxP, 5500);
    } catch (_e) {}
    try {
      tickPoll(true);
    } catch (_e) {}
  }

  let reviewNavSliderTimer = null;
  function reviewNavSliderInput(val) {
    if (reviewNavSliderTimer) clearTimeout(reviewNavSliderTimer);
    reviewNavSliderTimer = setTimeout(() => {
      reviewNavSliderTimer = null;
      const r = state.review;
      if (!r || !Array.isArray(r.plies)) return;
      clearMistakeLesson();
      const maxP = r.plies.length - 1;
      const n = Math.max(0, Math.min(maxP, Number(val) || 0));
      jumpToPly(n);
    }, 160);
  }

  // ---------------------------------------------------------------------------
  // Position / poll loop
  // ---------------------------------------------------------------------------
  function initTurnFor(position) {
    if (position.isStartPos) { state.turn = "w"; state.plyCount = 0; return; }
    state.turn = position.naiveTurn;
    const pieceCount = position.hash.replace(/\./g, "").length;
    state.plyCount = Math.max(0, 32 - pieceCount);
  }

  function tickPoll(force) {
    if (!canRun()) return;
    if (!extensionContextAlive()) {
      handleExtensionInvalidated();
      return;
    }
    const pos = window.LaskerBoardReader.readPosition();
    if (!pos) return;

    if (state.lastHash === null || force) {
      initTurnFor(pos);
      state.lastHash = pos.hash;
      onPositionChanged(pos, true);
      return;
    }

    if (pos.hash !== state.lastHash) {
      state.turn = state.turn === "w" ? "b" : "w";
      state.plyCount++;
      state.lastHash = pos.hash;
      onPositionChanged(pos, false);
    }
  }

  function canRun() {
    return state.settings.enabled
      && state.acceptedFairPlay
      && state.context
      && state.context.safe;
  }

  /** Human-readable reason `canRun()` is false — for logs + idle-card copy. */
  function fairPlayGateMessage() {
    if (!state.settings.enabled) {
      return "Turn LASKER on with the green toggle in the panel header.";
    }
    if (!state.acceptedFairPlay) {
      return "Accept the Fair Play checkbox (first-time prompt) — open the panel toggle or reload and confirm.";
    }
    if (!state.context) {
      return "Still classifying this page — wait a moment or refresh the tab.";
    }
    if (!state.context.safe) {
      const k = state.context.kind;
      if (k === "live-in-progress" || k === "daily-in-progress") {
        return "This tab is still treated as a game in progress. Finish the game, wait for the result on the board, then refresh — or open the game from Archives / Analysis.";
      }
      if (k === "puzzle-attempt") {
        return "Batch analysis is disabled on puzzle pages (Fair Play).";
      }
      if (k === "other") {
        return "Open a finished chess.com game or the Analysis board — not the home screen or an unsupported URL.";
      }
      return `${state.context.label || "This page"} is blocked by Fair Play for engine use.`;
    }
    return "";
  }

  function fairPlayGateDebug() {
    return {
      enabled: !!state.settings.enabled,
      acceptedFairPlay: !!state.acceptedFairPlay,
      hasContext: !!state.context,
      kind: state.context ? state.context.kind : null,
      safe: state.context ? state.context.safe : null,
      label: state.context ? state.context.label : null,
    };
  }

  function startPolling() {
    if (state.pollHandle) return;
    state.pollHandle = setInterval(tickPoll, POLL_MS);
    tickPoll();
  }
  function stopPolling() {
    if (state.pollHandle) { clearInterval(state.pollHandle); state.pollHandle = null; }
  }

  function onPositionChanged(position, _isFirst) {
    const newGrid = position.grid || null;
    state.currentGrid = newGrid;
    state.playerColor = position.flipped ? "b" : "w";
    const fen = window.LaskerBoardReader.toFen(position, state.turn);
    state.currentFen = fen;

    // Study sync FIRST -- position-hash based so takebacks / scrubs
    // Just Work in Learn mode.
    updateStudyForPosition();
    pushStudyToOverlay();

    // Learn surface: no engine, no review cache.
    if (state.settings.surface === "learn") {
      window.LaskerOverlay.setStatus("learning");
      window.LaskerOverlay.setEngineThinking(false);
      window.LaskerOverlay.setOpeningPill(null);
      window.LaskerOverlay.clearAnalysis();
      renderArrows();
      return;
    }

    // Analyze surface: serve from review cache, or show idle / stale.
    const r = state.review;
    if (r && r.status === "ready" && r.byHash && Array.isArray(r.plies)) {
      const graceActive = Date.now() < (r.navGraceUntil || 0);

      let entry = resolveReviewEntry(position, r);
      if (entry) {
        r.navGraceUntil = 0;
        r.expectedPly = null;
        paintFromCache(entry, false);
        window.LaskerOverlay.setStatus(
          entry.ply === 0 ? "review ready" : `ply ${entry.ply} / ${r.plies.length - 1}`
        );
        return;
      }

      // Navigation in progress — board hash can lag chess.com's animation.
      if (graceActive && r.expectedPly != null && r.plies[r.expectedPly]) {
        r.cacheMissStreak = 0;
        paintFromCache(r.plies[r.expectedPly], true);
        window.LaskerOverlay.setStatus(`matching chess.com board… (${r.expectedPly})`);
        renderArrows();
        return;
      }

      r.cacheMissStreak = (r.cacheMissStreak || 0) + 1;
      if (r.cacheMissStreak < REVIEW_STALE_MISS_STREAK) {
        window.LaskerOverlay.setStatus(
          `matching cached game… (${r.cacheMissStreak}/${REVIEW_STALE_MISS_STREAK})`
        );
        return;
      }

      // Truly off the analyzed tree (new line, different game, etc.).
      {
        const bp = position.boardFen || "";
        let fenScanMatchedPly = null;
        if (Array.isArray(r.plies)) {
          for (let pi = 0; pi < r.plies.length; pi++) {
            const ent = r.plies[pi];
            if (!ent || !ent.fen) continue;
            if (piecePlacementFromFen(ent.fen) === bp) {
              fenScanMatchedPly = pi;
              break;
            }
          }
        }
        let hint = null;
        if (r.replayMeta && r.replayMeta.stopped) {
          hint =
            `SAN replay stopped at index ${r.replayMeta.stopIndex} ("${r.replayMeta.stopSan}"). ` +
            `Only ${r.replayMeta.replayedMoves}/${r.replayMeta.inputSans} DOM moves were replayed in our grid — ` +
            `stepping past ply ${r.replayMeta.replayedMoves} cannot match cache.`;
        } else if (fenScanMatchedPly != null) {
          hint =
            "Piece placement matched cached ply " + fenScanMatchedPly +
            " but hash lookup failed — often timing/animation or castling-rights drift between DOM grid and batch FEN.";
        }
        r.cacheMissStreak = 0;
        logReview("cache-miss -> Outside cached analysis (stale)", {
          liveHashSample: (position.hash || "").slice(0, 48),
          liveBoardFen: bp,
          turnState: state.turn,
          graceHadBeenActive: graceActive,
          expectedPlyDuringNav: r.expectedPly,
          cachePositions: r.plies.length,
          byHashEntries: r.byHash ? r.byHash.size : 0,
          directHashHit: r.byHash ? r.byHash.has(position.hash) : false,
          fenScanMatchedPly,
          currentPlyField: r.currentPly,
          inferredPly: inferCurrentReviewPly(r),
          batchTotalMovesField: r.totalMoves,
          replayMeta: r.replayMeta,
          hint,
          verboseNav: "Set localStorage laskerReviewDebug=1 and reload for per-jump logs.",
        });
      }
      r.navGraceUntil = 0;
      r.expectedPly = null;
      r.status = "stale";
      window.LaskerOverlay.setReviewState("stale", {
        moveCount: r.totalMoves,
        result: r.result,
        playerColor: r.playerColor,
        depth: r.depth,
      });
      window.LaskerOverlay.clearAnalysis();
      window.LaskerOverlay.setOpeningPill(null);
      window.LaskerOverlay.setStatus("off-book");
      if (window.LaskerBoardArrows) window.LaskerBoardArrows.clear();
      return;
    }

    if (r && r.status === "running") {
      // Don't paint anything new while the batch is running; the progress
      // card owns the UI.
      return;
    }

    if (r && r.status === "stale") {
      // Stay in stale until the user re-runs.
      return;
    }

    // Idle: no review yet. Show the idle card with the game summary.
    window.LaskerOverlay.clearAnalysis();
    window.LaskerOverlay.setOpeningPill(null);
    window.LaskerOverlay.setEngineThinking(false);
    if (window.LaskerBoardArrows) window.LaskerBoardArrows.clear();
    refreshIdleCard();
  }

  // ---------------------------------------------------------------------------
  // Fair-play orchestration
  // ---------------------------------------------------------------------------
  function applyContext(ctx) {
    state.context = ctx;
    window.LaskerOverlay.setContext({
      kind: ctx.kind,
      label: ctx.label,
      safe: ctx.safe,
      engineAllowed: ctx.engineAllowed,
      bookAllowed: ctx.bookAllowed,
      policyUrl: window.LaskerFairPlay.POLICY_URL,
    });

    if (!ctx.safe) {
      // Hard stop: cancel any batch, shut everything down, clear state.
      cancelBatchAnalysis();
      stopPolling();
      state.lastHash = null;
      resetReviewTo("idle");
      state.tally = emptyTally();
      window.LaskerOverlay.resetTimeline();
      window.LaskerOverlay.clearAnalysis();
      window.LaskerOverlay.setOpeningPill(null);
      window.LaskerOverlay.setSummary(null);
      window.LaskerOverlay.setMistakeList(null);
      window.LaskerOverlay.setReviewState("idle", {
        moveCount: 0,
        result: null,
        playerColor: state.playerColor || "w",
        depth: state.settings.depth,
        hasMoveList: false,
      });
      window.LaskerOverlay.setStatus("paused (fair-play)");
      if (window.LaskerBoardArrows) window.LaskerBoardArrows.clear();
      return;
    }

    if (state.settings.enabled && state.acceptedFairPlay) {
      state.lastHash = null;
      resetReviewTo("idle");
      state.tally = emptyTally();
      window.LaskerOverlay.resetTimeline();
      window.LaskerOverlay.setSummary(null);
      window.LaskerOverlay.setMistakeList(null);
      window.LaskerOverlay.setStatus("ready to review");
      startPolling();
      refreshIdleCard();
    }
  }

  // ---------------------------------------------------------------------------
  // 0.9.1 clean-state button -- now also drops the review cache.
  // ---------------------------------------------------------------------------
  function resetState() {
    log("clean state");
    cancelBatchAnalysis();
    stopPolling();

    state.lastHash = null;
    state.currentFen = null;
    state.currentGrid = null;
    state.inBookNow = false;
    state.studying = null;
    state.tally = emptyTally();
    resetReviewTo("idle");

    window.LaskerOverlay.resetTimeline();
    window.LaskerOverlay.clearAnalysis();
    window.LaskerOverlay.setSummary(null);
    window.LaskerOverlay.setMistakeList(null);
    window.LaskerOverlay.setOpeningPill(null);
    window.LaskerOverlay.clearStudy();
    window.LaskerOverlay.setEngineThinking(false);
    window.LaskerOverlay.setStatus(
      state.settings.surface === "learn" ? "learning" : "cache cleared"
    );
    if (window.LaskerBoardArrows) window.LaskerBoardArrows.clear();

    if (canRun()) {
      startPolling();
      refreshIdleCard();
    }
  }

  // ---------------------------------------------------------------------------
  // Toggle handlers
  // ---------------------------------------------------------------------------
  function requestEnable(on) {
    if (!on) { setEnabled(false); return; }
    if (!state.acceptedFairPlay) {
      window.LaskerOverlay.showFairPlayModal(() => {
        state.acceptedFairPlay = true;
        saveAcceptance(true);
        setEnabled(true);
      }, window.LaskerFairPlay.POLICY_URL);
      return;
    }
    setEnabled(true);
  }

  function setEnabled(on) {
    state.settings.enabled = !!on;
    saveSettings(state.settings);
    window.LaskerOverlay.setEnabled(state.settings.enabled);
    if (!state.settings.enabled) {
      cancelBatchAnalysis();
      stopPolling();
      resetReviewTo("idle");
      // Still repaint the idle card (with moveCount=0 / button disabled)
      // so the user knows the surface is off rather than staring at
      // whatever the previous state left behind.
      try { refreshIdleCard(); } catch (_err) {}
      if (window.LaskerBoardArrows) window.LaskerBoardArrows.clear();
      return;
    }
    // 0.11.1: always repaint the idle card on enable, even if the
    // fair-play context hasn't been classified yet. Worst case the
    // button is disabled with a "no game detected" label -- far better
    // than showing the user a blank pane with no call to action.
    refreshIdleCard();
    if (!state.context || !state.context.safe) return;
    state.lastHash = null;
    resetReviewTo("idle");
    state.tally = emptyTally();
    window.LaskerOverlay.resetTimeline();
    window.LaskerOverlay.setSummary(null);
    window.LaskerOverlay.setMistakeList(null);
    startPolling();
    refreshIdleCard();
  }

  function setDepth(n) {
    // 0.11.0: batch depth, applied at the NEXT run. No live engine to re-kick.
    state.settings.depth = n;
    saveSettings(state.settings);
    if (state.review && state.review.status === "idle") refreshIdleCard();
  }

  function syncBoardArrowPalette() {
    try {
      if (!window.LaskerBoardArrows || !window.LaskerOverlay || !window.LaskerOverlay.getArrowPalette) return;
      window.LaskerBoardArrows.setPalette(window.LaskerOverlay.getArrowPalette());
    } catch (_e) {}
  }

  function setTheme(t) {
    state.settings.theme = t;
    saveSettings(state.settings);
    syncBoardArrowPalette();
  }
  function setSize(s) { state.settings.size = s; saveSettings(state.settings); }
  function setCollapsed(c) { state.settings.collapsed = !!c; saveSettings(state.settings); }
  function setMode(m) {
    state.settings.mode = m === "advanced" ? "advanced" : "focus";
    saveSettings(state.settings);
  }
  function setAdvisor(a) {
    state.settings.advisor = a === "both-sides" ? "both-sides" : "my-side";
    saveSettings(state.settings);
    // Re-render scope-sensitive blocks from the existing cache.
    if (state.review && state.review.status === "ready") {
      rebuildTimelineFromReview();
      pushSummaryToOverlay();
      pushMistakeListToOverlay();
      // Also re-paint the current ply so last-move / engine-hint pick up
      // the new scope.
      const pos = window.LaskerBoardReader.readPosition();
      if (pos) {
        const entry = resolveReviewEntry(pos, state.review);
        if (entry) paintFromCache(entry, false);
      }
    }
  }
  function setWidth(px) {
    state.settings.width = Number.isFinite(px) ? Math.round(px) : null;
    saveSettings(state.settings);
  }
  function setArrows(on) {
    state.settings.showArrows = !!on;
    saveSettings(state.settings);
    if (window.LaskerBoardArrows) {
      window.LaskerBoardArrows.setVisible(!!on);
      if (!on) window.LaskerBoardArrows.clear();
    }
    if (on) renderArrows();
  }

  // ---------------------------------------------------------------------------
  // 0.8 Opening Library & Study mode (unchanged except for integration hooks)
  // ---------------------------------------------------------------------------
  async function ensureCatalog() {
    if (state.catalog) return state.catalog;
    if (!window.LaskerOpeningBook || !window.LaskerOpeningBook.loadCatalog) return null;
    try {
      state.catalog = await window.LaskerOpeningBook.loadCatalog();
      window.LaskerOverlay.setCatalog(state.catalog);
      return state.catalog;
    } catch (err) {
      log("catalog load failed:", err);
      return null;
    }
  }

  function catalogOpIdForName(name) {
    if (!state.catalog || !name) return null;
    const norm = (s) => (s || "").toLowerCase().trim();
    const target = norm(name.split(":")[0]);
    let exact = null;
    let prefix = null;
    for (const cat of state.catalog.categories || []) {
      for (const op of cat.openings || []) {
        const nn = norm(op.name);
        if (nn === target) { exact = op.id; continue; }
        if (!prefix && (target.startsWith(nn) || nn.startsWith(target))) {
          prefix = op.id;
        }
      }
    }
    return exact || prefix || null;
  }

  function pickOpening({ opId, catId }) {
    if (!state.catalog || !opId) return;
    let cat = null;
    let op = null;
    for (const c of state.catalog.categories || []) {
      if (catId && c.id !== catId) continue;
      for (const o of c.openings || []) {
        if (o.id === opId) { cat = c; op = o; break; }
      }
      if (op) break;
    }
    if (!op) return;

    const expanded = window.LaskerOpeningBook.expandLine(op.moves || []);
    const line = (expanded && expanded.line) || [];
    if (line.length === 0) {
      log("pickOpening: could not expand line for", op.id);
      return;
    }

    state.studying = {
      opId: op.id,
      catId: cat ? cat.id : null,
      op,
      cat,
      startHash: expanded.startHash,
      line,
      idx: 0,
      lastKnownIdx: 0,
      state: "active",
      expectedSan: null,
    };

    if (state.settings.surface !== "learn") {
      setSurface("learn");
    } else {
      updateStudyForPosition();
      pushStudyToOverlay();
      renderArrows();
    }
  }

  function studyOpeningById({ opId }) { pickOpening({ opId }); }
  function exitStudy() {
    state.studying = null;
    window.LaskerOverlay.clearStudy();
    renderArrows();
  }

  function updateStudyForPosition() {
    const s = state.studying;
    if (!s || !state.currentGrid) return;
    const currentHash = window.LaskerOpeningBook.gridHash(state.currentGrid);
    const k = findHashInLine(s, currentHash);
    if (k < 0) {
      const expected = s.line[s.lastKnownIdx | 0];
      s.expectedSan = expected ? expected.san : null;
      s.state = "off-book";
      return;
    }
    s.idx = k;
    s.lastKnownIdx = k;
    s.expectedSan = null;
    s.state = k >= s.line.length ? "complete" : "active";
  }
  function findHashInLine(s, currentHash) {
    if (!s || !s.line) return -1;
    if (currentHash === s.startHash) return 0;
    for (let i = 0; i < s.line.length; i++) {
      if (s.line[i].hash === currentHash) return i + 1;
    }
    return -1;
  }
  function pushStudyToOverlay() {
    const s = state.studying;
    if (!s) { window.LaskerOverlay.clearStudy(); return; }
    const totalPly = s.line.length;
    const next = s.line[s.idx];
    const myTurn = state.playerColor && next && next.turn === state.playerColor;
    let why = "";
    if (s.op && s.idx === 0) why = s.op.why || s.op.blurb || "";
    else if (s.op && s.state === "active") why = "Stay on theory -- this is a main-line continuation.";
    else if (s.op && s.state === "complete") why = s.op.why || s.op.blurb || "";
    window.LaskerOverlay.setStudy({
      name: s.op.name,
      eco: s.op.eco,
      totalPly,
      currentPly: s.idx,
      state: s.state,
      nextSan: next ? next.san : null,
      expectedSan: s.expectedSan || null,
      whoseTurn: next ? (myTurn ? "you" : "opponent") : null,
      nextWhy: why,
    });
  }

  function renderArrows() {
    if (!window.LaskerBoardArrows) return;
    if (!state.settings.showArrows) { window.LaskerBoardArrows.clear(); return; }
    if (!state.context || !state.context.safe || !state.settings.enabled) {
      window.LaskerBoardArrows.clear();
      return;
    }
    const boardEl = window.LaskerBoardReader.findBoard();
    if (boardEl) window.LaskerBoardArrows.setBoard(boardEl);

    if (state.settings.surface === "learn") {
      const s = state.studying;
      if (s && s.state === "active" && s.line[s.idx]) {
        window.LaskerBoardArrows.showBest(s.line[s.idx].uci);
      } else {
        window.LaskerBoardArrows.clear();
      }
      return;
    }

    // Analyze surface: cache-driven.
    const r = state.review;
    if (!r || r.status !== "ready" || !r.byHash) {
      window.LaskerBoardArrows.clear();
      return;
    }
    const pos = window.LaskerBoardReader.readPosition();
    if (!pos) { window.LaskerBoardArrows.clear(); return; }
    const entry = r.byHash.get(pos.hash);
    if (!entry || !entry.bestUci) {
      window.LaskerBoardArrows.clear();
      return;
    }
    // Student-side only (0.10 policy, carried over).
    const myTurn = !state.playerColor || entry.turn === state.playerColor;
    if (!myTurn) { window.LaskerBoardArrows.clear(); return; }
    window.LaskerBoardArrows.showBest(entry.bestUci);
  }

  // ---------------------------------------------------------------------------
  // Surface switch
  // ---------------------------------------------------------------------------
  function setSurface(s) {
    const surface = s === "learn" ? "learn" : "analyze";
    const wasSurface = state.settings.surface;
    state.settings.surface = surface;
    saveSettings(state.settings);
    window.LaskerOverlay.setSurface(surface);

    if (surface === "learn") {
      // Cancel any running batch; drop the review cache.
      cancelBatchAnalysis();
      resetReviewTo("idle");
      window.LaskerOverlay.setMistakeList(null);
      window.LaskerOverlay.setSummary(null);
      window.LaskerOverlay.clearAnalysis();
      window.LaskerOverlay.setEngineThinking(false);
      window.LaskerOverlay.setOpeningPill(null);
      window.LaskerOverlay.setStatus("learning");
      ensureCatalog();
      renderArrows();
      return;
    }

    // Analyze: show whichever review-state we're in, rebinding against
    // the current board position.
    if (wasSurface === "learn") {
      state.lastHash = null;       // re-bootstrap on next tick
    }
    if (state.review && state.review.status === "ready") {
      rebuildTimelineFromReview();
      pushSummaryToOverlay();
      pushMistakeListToOverlay();
      const pos = window.LaskerBoardReader.readPosition();
      if (pos) {
        const entry = resolveReviewEntry(pos, state.review);
        if (entry) paintFromCache(entry, false);
      }
      window.LaskerOverlay.setReviewState("ready", {
        moveCount: state.review.totalMoves,
        result: state.review.result,
        playerColor: state.review.playerColor,
        depth: state.review.depth,
      });
    } else {
      refreshIdleCard();
    }
    renderArrows();
  }

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------
  async function main() {
    if (window.__laskerLoaded) return;
    window.__laskerLoaded = true;

    const loaded = await loadAll();
    state.settings = loaded.settings;
    state.acceptedFairPlay = loaded.acceptedFairPlay;

    if (state.settings.enabled && !state.acceptedFairPlay) {
      state.settings.enabled = false;
      saveSettings(state.settings);
    }

    await waitForBoard();
    log("board found, mounting overlay");

    window.LaskerOverlay.mount({
      onToggle: (on) => requestEnable(on),
      onDepthChange: (n) => setDepth(n),
      onThemeChange: (t) => setTheme(t),
      onSizeChange: (s) => setSize(s),
      onCollapseChange: (c) => setCollapsed(c),
      onModeChange: (m) => setMode(m),
      onAdvisorChange: (a) => setAdvisor(a),
      onWidthChange: (w) => setWidth(w),
      onArrowsChange: (on) => setArrows(on),
      onSurfaceChange: (s) => setSurface(s),
      onPickOpening: (sel) => pickOpening(sel),
      onStudyOpeningById: (sel) => studyOpeningById(sel),
      onExitStudy: () => exitStudy(),
      onResetState: () => resetState(),
      // 0.11.0: batch Analyze handlers.
      onStartBatch: () => startBatchAnalysis(),
      onCancelBatch: () => cancelBatchAnalysis(),
      onReanalyze: () => reanalyze(),
      onJumpToPly: (ply) => {
        clearMistakeLesson();
        jumpToPly(ply);
      },
      onMistakeNavigate: (p) => {
        if (!p) return;
        (async () => {
          if (p.lessonPly != null) showMistakeLessonOnly(p.lessonPly);
          if (p.targetPly != null) await jumpToPly(p.targetPly);
        })();
      },
      onMistakeTourPrev: () => { mistakeTourStep(-1); },
      onMistakeTourNext: () => { mistakeTourStep(1); },
      onReviewNavPrev: () => reviewNavStep(-1),
      onReviewNavNext: () => reviewNavStep(1),
      onReviewNavStart: () => reviewNavStart(),
      onReviewNavEnd: () => reviewNavEnd(),
      onReviewNavSlider: (ply) => reviewNavSliderInput(ply),
    });
    window.LaskerOverlay.setMode(state.settings.mode);
    window.LaskerOverlay.setAdvisor(state.settings.advisor);
    window.LaskerOverlay.setTheme(state.settings.theme);
    const persistedWidth = state.settings.width;
    window.LaskerOverlay.setSize(state.settings.size);
    if (persistedWidth) {
      window.LaskerOverlay.setWidth(persistedWidth);
      state.settings.width = persistedWidth;
      saveSettings(state.settings);
    }
    window.LaskerOverlay.setDepth(state.settings.depth);
    window.LaskerOverlay.setEnabled(state.settings.enabled);
    window.LaskerOverlay.setCollapsed(!!state.settings.collapsed);
    window.LaskerOverlay.setArrows(!!state.settings.showArrows);
    window.LaskerOverlay.setSurface(state.settings.surface || "analyze");

    if (window.LaskerBoardArrows) {
      try {
        window.LaskerBoardArrows.mount();
        const boardEl = window.LaskerBoardReader.findBoard();
        if (boardEl) window.LaskerBoardArrows.setBoard(boardEl);
        window.LaskerBoardArrows.setVisible(!!state.settings.showArrows);
        syncBoardArrowPalette();
      } catch (err) { log("arrows mount failed:", err); }
    }

    ensureCatalog();

    window.LaskerFairPlay.subscribe((ctx) => {
      log("context:", ctx.kind, "(safe:", ctx.safe, ")");
      applyContext(ctx);
    });

    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === "lasker:toggle") {
          requestEnable(!state.settings.enabled);
        }
      });
    } catch (_err) {}
  }

  main().catch((err) => log("fatal:", err));
})();
