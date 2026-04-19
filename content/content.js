// Lasker content-script controller.
//
// Responsibilities:
//   - Mount the overlay and restore preferences (enabled, depth, theme, size,
//     collapsed, and the one-time fair-play acknowledgement flag).
//   - Subscribe to LaskerFairPlay; hard-gate EVERYTHING on the current page
//     context. When classified "unsafe" we tear down the engine, stop
//     polling, and flip the overlay to its locked state.
//   - When on a safe context AND the user has accepted the fair-play terms:
//     poll the DOM every POLL_MS for position changes.
//   - On a position change:
//       * flip side-to-move (heuristic)
//       * query the offline opening book
//       * start a Stockfish analysis
//       * compute human-readable assessment + last-move classification
//       * derive principle chips (king safety, development, centre)
//       * push a dot onto the move timeline once the classification settles
//       * forward everything to the overlay

(function () {
  "use strict";

  const POLL_MS = 500;
  const STORAGE_KEY = "lasker.settings";
  const ACCEPT_KEY = "lasker.acceptedFairPlay";
  const DEFAULT_SETTINGS = {
    enabled: false,
    depth: 15,
    theme: "dark",
    size: "medium",
    collapsed: false,
    mode: "focus",            // "focus" | "advanced"
    advisor: "my-side",       // "my-side" | "both-sides"
    width: null,              // null = use size preset; number = drag-resized px
    showArrows: true,         // 0.8.0 -- SVG board-arrow guidance
    surface: "analyze",       // 0.9.0 -- "analyze" (engine review) | "learn" (Library + Study)
  };

  // 0.10.0: severity list is declared BEFORE `state` because `state.tally`
  // is seeded via `emptyTally()` at object-literal time, and emptyTally
  // reads SEVERITIES. A `const` declared after that line would be in the
  // temporal dead zone and throw `ReferenceError: Cannot access
  // 'SEVERITIES' before initialization` at module load.
  const SEVERITIES = [
    "brilliant", "great", "best", "good", "book",
    "inaccuracy", "mistake", "blunder",
  ];

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    acceptedFairPlay: false,
    context: null,           // latest LaskerFairPlay classification
    lastHash: null,
    turn: "w",
    plyCount: 0,
    playerColor: null,
    engine: null,
    pollHandle: null,
    currentFen: null,
    currentGrid: null,
    currentLines: { 1: null, 2: null, 3: null },
    currentDepth: 0,
    prevEval: null,
    prevRef: null,
    // 0.10.0: snapshot of the BEST move the engine suggested at the
    // previous position, so after the user plays we can tell them
    // "Best was Nxe5 -- missed +1.2" instead of just showing the swing.
    prevBest: null,          // { uci, san, whiteCp, whiteMate } | null
    prevBestRef: null,       // like prevRef but for the best snapshot
    prevGrid: null,          // grid at the prev position (for uci->SAN)
    lastMover: null,
    inBookNow: false,
    labelSnapshotted: false,
    timelineSeeded: false,
    moveTimeline: [],        // history of { ply, severity, color } dots
    // 0.10.0: per-session move-quality tally used by the summary card.
    // Keyed by severity; each bucket counts both-sides separately so the
    // UI can filter to the student's moves under advisor=my-side.
    tally: emptyTally(),
    // 0.8.0 -- Study mode. When the user picks an opening from the Library,
    // `studying` holds the per-ply expansion (SAN + UCI + turn) plus an
    // index of where we are in it. It is ENTIRELY opt-in; nothing else
    // about regular analysis changes when it's null.
    catalog: null,           // hand-curated opening catalog (lazy)
    studying: null,          // { op, cat, line: [{san, uci, turn}], idx, state }
  };

  function log(...args) { console.log("[Lasker]", ...args); }

  // ---------------------------------------------------------------------------
  // 0.10.0: Session tally -- per-severity move-quality counts, used by the
  // summary card at the bottom of Analyze.
  // ---------------------------------------------------------------------------
  // (SEVERITIES is declared above `state` so emptyTally can use it during
  // the state-literal initialization without hitting the TDZ.)
  function emptyTally() {
    const t = {};
    for (const s of SEVERITIES) t[s] = { w: 0, b: 0 };
    return t;
  }
  function updateSessionTally(result, mover) {
    if (!result || !mover) return;
    const sev = result.severity;
    if (!state.tally[sev]) state.tally[sev] = { w: 0, b: 0 };
    state.tally[sev][mover] = (state.tally[sev][mover] | 0) + 1;
    pushSummaryToOverlay();
  }
  // Project the current tally into the summary payload and hand it to
  // the overlay. Respects advisor=my-side (only count the student's
  // moves) so the panel reflects what the user is here to learn about.
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
  // Per-severity "accuracy points" used to roll counts up into a single
  // 0-100 number. Tuned so a clean book-to-best game lands in the high
  // 90s, a 1-blunder game drops into the 70s, and a blunder-fest hits
  // the 40s. Rough but directionally useful.
  const ACCURACY_POINTS = {
    brilliant: 100, great: 100, best: 98, good: 92, book: 95,
    inaccuracy: 72, mistake: 45, blunder: 20,
  };

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

  function saveSettings(s) {
    try { chrome.storage.local.set({ [STORAGE_KEY]: s }); } catch (_err) {}
  }

  function saveAcceptance(flag) {
    try { chrome.storage.local.set({ [ACCEPT_KEY]: !!flag }); } catch (_err) {}
  }

  // ---------------------------------------------------------------------------
  // Board / engine plumbing
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

  function ensureEngine() {
    if (state.engine) return state.engine;
    state.engine = new window.LaskerEngine({
      multiPv: 3,
      onInfo: handleEngineInfo,
      onBestMove: () => {},
      onError: (err) => {
        log("engine error:", err);
        window.LaskerOverlay.setStatus("engine error");
      },
    });
    return state.engine;
  }

  function tearDownEngine() {
    if (state.engine) {
      try { state.engine.terminate(); } catch (_err) {}
      state.engine = null;
    }
  }

  function handleEngineInfo(info) {
    const mpv = info.multipv || 1;
    if (mpv < 1 || mpv > 3) return;
    state.currentLines[mpv] = info;
    if (info.depth > state.currentDepth) state.currentDepth = info.depth;
    renderEvaluation();
    // Arrows follow the engine's primary line. Refresh lazily -- the SVG
    // path is tiny so redrawing per info update is cheap and keeps the
    // plan in step with deeper searches.
    if (mpv === 1) renderArrows();
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  function renderEvaluation() {
    const primary = state.currentLines[1];
    if (!primary) return;

    const lines = [state.currentLines[1], state.currentLines[2], state.currentLines[3]]
      .filter(Boolean)
      .map((i) => ({ scoreCp: i.scoreCp, scoreMate: i.scoreMate, pv: i.pv }));

    window.LaskerOverlay.setEvaluation({
      scoreCp: primary.scoreCp,
      scoreMate: primary.scoreMate,
      depth: state.currentDepth,
      lines,
      turn: state.turn,
      playerColor: state.playerColor,
    });

    const assess = window.LaskerLabels.assessPosition({
      scoreCp: primary.scoreCp,
      scoreMate: primary.scoreMate,
      turn: state.turn,
    });
    window.LaskerOverlay.setAssessment(assess);

    renderEngineHint();
    renderPrinciples();

    if (!state.labelSnapshotted &&
        state.currentDepth >= Math.max(10, state.settings.depth - 3)) {
      const white = window.LaskerLabels.toWhitePerspective(
        primary.scoreCp, primary.scoreMate, state.turn
      );
      state.prevEval = { whiteCp: white.cp, whiteMate: white.mate };
      // 0.10.0: also snapshot the engine's preferred move at THIS position
      // so after the student plays something else we can render
      // "Best was <san> -- missed <delta>" under the last-move card.
      const bestUci = primary.pv && primary.pv[0] ? primary.pv[0] : null;
      if (bestUci) {
        state.prevBest = {
          uci: bestUci,
          san: uciToPseudoSan(bestUci, state.currentGrid),
          whiteCp: white.cp,
          whiteMate: white.mate,
        };
      } else {
        state.prevBest = null;
      }
      state.prevGrid = state.currentGrid;
      state.labelSnapshotted = true;
      classifyLastMove();
      window.LaskerOverlay.setEngineThinking(false);
    }
  }

  function classifyLastMove() {
    if (!state.lastMover) {
      window.LaskerOverlay.setLastMove(null);
      return;
    }

    // My-side advisor: don't grade or timeline the opponent's moves. The
    // last-move row goes silent on their turns. Timeline stays sparse (only
    // my moves), which in a review makes it easy to spot your own mistakes.
    const isMySide = state.settings.advisor === "my-side";
    const itWasMyMove = !state.playerColor || state.lastMover === state.playerColor;
    if (isMySide && !itWasMyMove) {
      window.LaskerOverlay.setLastMove(null);
      return;
    }

    const primary = state.currentLines[1];
    if (!primary) return;
    if (!state.prevRef) {
      window.LaskerOverlay.setLastMove(null);
      return;
    }

    const currWhite = window.LaskerLabels.toWhitePerspective(
      primary.scoreCp, primary.scoreMate, state.turn
    );
    const result = window.LaskerLabels.classifyMove({
      prevWhiteCp: state.prevRef.whiteCp,
      prevWhiteMate: state.prevRef.whiteMate,
      currWhiteCp: currWhite.cp,
      currWhiteMate: currWhite.mate,
      mover: state.lastMover,
      inBook: state.inBookNow,
    });

    // 0.10.0: attach "best move" context if we have it. Shown under the
    // last-move label as "Best was Nxe5 -- missed +1.20". Suppressed when
    // the student's move was in book, when there's no snapshot, or when
    // the swing was too small to care about (<= 0.15 pawns).
    if (state.prevBestRef && state.prevBestRef.san && !state.inBookNow) {
      const moverSign = state.lastMover === "w" ? 1 : -1;
      const prevW = state.prevRef;
      const bestW = state.prevBestRef;
      // "Missed gain" from the mover's point of view: how much better the
      // best move's outcome would have been vs. what actually happened.
      let missedPawns = null;
      let bestScoreStr = null;
      if (bestW.whiteMate !== null && bestW.whiteMate !== undefined) {
        bestScoreStr = `M${Math.abs(bestW.whiteMate)}`;
      } else if (bestW.whiteCp !== null && bestW.whiteCp !== undefined &&
                 prevW.whiteCp !== null && prevW.whiteCp !== undefined &&
                 currWhite.cp !== null && currWhite.cp !== undefined) {
        const actualDeltaMover = (currWhite.cp - prevW.whiteCp) * moverSign / 100;
        const bestDeltaMover  = (bestW.whiteCp - prevW.whiteCp) * moverSign / 100;
        missedPawns = bestDeltaMover - actualDeltaMover;
        bestScoreStr = `${bestW.whiteCp >= 0 ? "+" : ""}${(bestW.whiteCp / 100).toFixed(2)}`;
      }
      const enoughSwing = missedPawns === null
        ? !!bestScoreStr              // any mate-based info is worth showing
        : Math.abs(missedPawns) >= 0.15;
      if (enoughSwing) {
        result.bestSan = state.prevBestRef.san;
        if (missedPawns !== null && Math.abs(missedPawns) >= 0.15) {
          const sign = missedPawns > 0 ? "+" : "";
          result.missedText = `missed ${sign}${missedPawns.toFixed(2)}`;
        } else if (bestScoreStr && bestScoreStr.startsWith("M")) {
          result.missedText = `forced ${bestScoreStr}`;
        }
      }
    }

    window.LaskerOverlay.setLastMove(result);

    // Push onto the timeline + bump the session tally exactly once per
    // move (after we have a stable classification; triggered both by the
    // snapshot branch and by lookupOpening's re-classify).
    if (result && !state.timelineSeeded) {
      state.timelineSeeded = true;
      state.moveTimeline.push({
        ply: state.plyCount,
        severity: result.severity,
        label: `${result.label}${result.badge ? " " + result.badge : ""}`,
        color: state.lastMover,
      });
      window.LaskerOverlay.pushTimelineMove(state.moveTimeline[state.moveTimeline.length - 1]);
      updateSessionTally(result, state.lastMover);
    }
  }

  // ---------------------------------------------------------------------------
  // Engine hint -> coach bubble text.
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

  function renderEngineHint() {
    const primary = state.currentLines[1];
    if (!primary || !primary.pv || primary.pv.length === 0) {
      window.LaskerOverlay.setEngineHint(null);
      return;
    }
    const uci = primary.pv[0];
    const san = uciToPseudoSan(uci, state.currentGrid);
    if (!san) {
      window.LaskerOverlay.setEngineHint(null);
      return;
    }
    const describeText = window.LaskerEngineHints.describeMove({
      san,
      mover: state.turn,
      currScoreCp: primary.scoreCp,
      currScoreMate: primary.scoreMate,
      inBook: state.inBookNow,
    });

    // My-side advisor: when it's the opponent's turn, the engine PV IS the
    // opponent's best reply. Show it muted and reframed so the player
    // anticipates it, rather than feeling the coach is telling them to make
    // opponent moves.
    const itIsPlayersTurn = !state.playerColor || state.turn === state.playerColor;
    const isMySide = state.settings.advisor === "my-side";

    let text = describeText;
    let muted = false;
    if (isMySide && !itIsPlayersTurn) {
      text = `Opponent likely: ${san}. Prepare to respond.`;
      muted = true;
    }

    const detail = formatCoachDetail();
    window.LaskerOverlay.setEngineHint({ text, detail, source: "stockfish", muted });
  }

  function formatCoachDetail() {
    const rows = [];
    for (let i = 1; i <= 3; i++) {
      const line = state.currentLines[i];
      if (!line) continue;
      const scoreStr = line.scoreMate !== null && line.scoreMate !== undefined
        ? `M${line.scoreMate}`
        : (line.scoreCp !== null && line.scoreCp !== undefined
          ? `${(line.scoreCp / 100).toFixed(2)}`
          : "--");
      const pv = (line.pv || []).slice(0, 5).join(" ");
      rows.push(`${i}. ${scoreStr}  ${pv}`);
    }
    if (rows.length === 0) return "";
    return `Top engine lines (depth ${state.currentDepth}):\n${rows.join("\n")}`;
  }

  // ---------------------------------------------------------------------------
  // Principle chips: simple heuristics on the current grid.
  // ---------------------------------------------------------------------------
  function renderPrinciples() {
    const p = computePrinciples(state.currentGrid, state.playerColor);
    window.LaskerOverlay.setPrinciples(p);
  }

  function computePrinciples(grid, playerColor) {
    if (!grid || !playerColor) return null;
    const isWhite = playerColor === "w";
    const ownKing = isWhite ? "K" : "k";
    const ownKnight = isWhite ? "N" : "n";
    const ownBishop = isWhite ? "B" : "b";
    const homeRank = isWhite ? 0 : 7;

    // King safety: find the king on its own back rank.
    let kingFile = -1;
    for (let f = 0; f < 8; f++) {
      if (grid[homeRank] && grid[homeRank][f] === ownKing) { kingFile = f; break; }
    }
    let king;
    if (kingFile === -1) {
      king = "exposed";
    } else if (kingFile === 6 || kingFile === 2) {
      king = "safe";
    } else if (kingFile === 4) {
      king = "home";
    } else {
      king = "exposed";
    }

    // Development: count knights + bishops still on their starting squares.
    const knightStart = isWhite ? [[0, 1], [0, 6]] : [[7, 1], [7, 6]];
    const bishopStart = isWhite ? [[0, 2], [0, 5]] : [[7, 2], [7, 5]];
    let onHome = 0;
    for (const [r, f] of knightStart) if (grid[r] && grid[r][f] === ownKnight) onHome++;
    for (const [r, f] of bishopStart) if (grid[r] && grid[r][f] === ownBishop) onHome++;
    const moved = 4 - onHome;
    const development = moved >= 3 ? "good" : moved >= 1 ? "partial" : "none";

    // Centre: at least one friendly pawn on d4/e4/d5/e5.
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
  // Position / poll loop
  // ---------------------------------------------------------------------------
  function initTurnFor(position) {
    if (position.isStartPos) { state.turn = "w"; state.plyCount = 0; return; }
    state.turn = position.naiveTurn;
    const pieceCount = position.hash.replace(/\./g, "").length;
    state.plyCount = Math.max(0, 32 - pieceCount);
  }

  // 0.9.0: the opening lookup only fuels the slim Analyze pill now. Learn
  // mode does its own thing via the curated catalog + Study card and does
  // NOT use this code path.
  async function lookupOpening(fen) {
    if (!window.LaskerOpeningBook) return;
    if (state.context && !state.context.bookAllowed) {
      window.LaskerOverlay.setOpeningPill(null);
      state.inBookNow = false;
      return;
    }
    if (!window.LaskerOpeningBook.isEarly(state.plyCount)) {
      window.LaskerOverlay.setOpeningPill(null);
      state.inBookNow = false;
      return;
    }
    const requestedFen = fen;
    const op = await window.LaskerOpeningBook.lookup(fen);
    if (state.currentFen !== requestedFen) return;
    if (!op || !op.name) {
      window.LaskerOverlay.setOpeningPill(null);
      state.inBookNow = false;
      return;
    }
    const catalogOpId = catalogOpIdForName(op.name);
    window.LaskerOverlay.setOpeningPill({
      name: op.name,
      eco: op.eco || "",
      catalogOpId,
    });
    state.inBookNow = true;
    classifyLastMove();
  }

  // Best-effort match from an ECO/book name back to a curated Library
  // entry id. Used by the "Study this" pill in Analyze so one click jumps
  // into Learn for the same opening.
  function catalogOpIdForName(name) {
    if (!state.catalog || !name) return null;
    const norm = (s) => (s || "").toLowerCase().trim();
    const target = norm(name.split(":")[0]); // drop variation suffix
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

  async function onPositionChanged(position, isFirst) {
    state.prevRef = isFirst ? null : state.prevEval;
    // 0.10.0: carry the previous position's best-move snapshot forward so
    // classifyLastMove can say "Best was <san> -- missed X".
    state.prevBestRef = isFirst ? null : state.prevBest;
    state.lastMover = isFirst ? null : (state.turn === "w" ? "b" : "w");

    const newGrid = position.grid || null;

    state.currentLines = { 1: null, 2: null, 3: null };
    state.currentDepth = 0;
    state.labelSnapshotted = false;
    state.prevEval = null;
    state.prevBest = null;
    state.inBookNow = false;
    state.timelineSeeded = false;

    const fen = window.LaskerBoardReader.toFen(position, state.turn);
    state.currentFen = fen;
    state.currentGrid = newGrid;
    log("analyzing", fen);

    state.playerColor = position.flipped ? "b" : "w";

    // Study sync FIRST -- it's position-hash based now so it takes the
    // new grid and finds where we are in the opening line, which makes
    // takebacks/scrubs Just Work.
    updateStudyForPosition();
    pushStudyToOverlay();
    renderArrows();

    // Learn surface: engine is OFF. Stop here after syncing study state.
    if (state.settings.surface === "learn") {
      window.LaskerOverlay.setStatus("learning");
      window.LaskerOverlay.setEngineThinking(false);
      window.LaskerOverlay.setOpeningPill(null);
      return;
    }

    // ----- Analyze surface: engine-driven review -----
    window.LaskerOverlay.setStatus("thinking...");
    renderPrinciples();
    lookupOpening(fen).catch(() => {});

    if (!state.context || !state.context.engineAllowed) return;
    const engine = ensureEngine();
    try {
      await engine.init();
      window.LaskerOverlay.setEngineThinking(true);
      engine.analyze(fen, state.settings.depth);
    } catch (err) {
      log("analyze failed:", err);
      window.LaskerOverlay.setStatus("engine error");
      window.LaskerOverlay.setEngineThinking(false);
    }
  }

  function tickPoll() {
    if (!canRun()) return;
    const pos = window.LaskerBoardReader.readPosition();
    if (!pos) return;

    if (state.lastHash === null) {
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

  function startPolling() {
    if (state.pollHandle) return;
    state.pollHandle = setInterval(tickPoll, POLL_MS);
    tickPoll();
  }

  function stopPolling() {
    if (state.pollHandle) { clearInterval(state.pollHandle); state.pollHandle = null; }
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
      // Hard stop: shut everything down, clear state, reset timeline.
      stopPolling();
      tearDownEngine();
      state.lastHash = null;
      state.prevEval = null;
      state.prevRef = null;
      state.prevBest = null;
      state.prevBestRef = null;
      state.lastMover = null;
      state.moveTimeline = [];
      state.tally = emptyTally();
      window.LaskerOverlay.resetTimeline();
      window.LaskerOverlay.clearAnalysis();
      window.LaskerOverlay.setOpeningPill(null);
      window.LaskerOverlay.setSummary(null);
      window.LaskerOverlay.setStatus("paused (fair-play)");
      if (window.LaskerBoardArrows) window.LaskerBoardArrows.clear();
      return;
    }

    // Safe again: resume polling if we were previously enabled.
    if (state.settings.enabled && state.acceptedFairPlay) {
      state.lastHash = null;
      state.moveTimeline = [];
      state.tally = emptyTally();
      window.LaskerOverlay.resetTimeline();
      window.LaskerOverlay.setSummary(null);
      window.LaskerOverlay.setStatus("starting engine...");
      startPolling();
    }
  }

  // ---------------------------------------------------------------------------
  // 0.9.1: Clean-state ("reset") action
  // ---------------------------------------------------------------------------
  // Wipes all RUNTIME state that accumulates across a review session:
  //   - move timeline, last eval snapshot, last-move classification
  //   - Study mode (if active) -- user exits the line and can pick another
  //   - engine worker (torn down and re-spawned so stale lines / depth go)
  //   - board arrows + opening pill
  //
  // Does NOT touch: user preferences (theme/size/surface/advisor/depth),
  // fair-play acceptance, the enabled toggle. You can reset mid-game
  // without losing your seat.
  function resetState() {
    log("clean state");
    stopPolling();
    tearDownEngine();

    state.lastHash = null;
    state.prevEval = null;
    state.prevRef = null;
    state.prevBest = null;
    state.prevBestRef = null;
    state.prevGrid = null;
    state.lastMover = null;
    state.currentFen = null;
    state.currentGrid = null;
    state.currentLines = { 1: null, 2: null, 3: null };
    state.currentDepth = 0;
    state.labelSnapshotted = false;
    state.timelineSeeded = false;
    state.inBookNow = false;
    state.moveTimeline = [];
    state.studying = null;
    state.tally = emptyTally();

    window.LaskerOverlay.resetTimeline();
    window.LaskerOverlay.clearAnalysis();
    window.LaskerOverlay.setSummary(null);
    window.LaskerOverlay.setOpeningPill(null);
    window.LaskerOverlay.clearStudy();
    window.LaskerOverlay.setEngineThinking(false);
    window.LaskerOverlay.setStatus(
      state.settings.surface === "learn" ? "learning" : "reset — waiting for a move"
    );
    if (window.LaskerBoardArrows) window.LaskerBoardArrows.clear();

    // Resume polling if we should be running. The next tick will see a
    // "first" position and kick the engine fresh.
    if (canRun()) startPolling();
  }

  // ---------------------------------------------------------------------------
  // Toggle handlers
  // ---------------------------------------------------------------------------
  function requestEnable(on) {
    // Turning OFF never requires acceptance.
    if (!on) { setEnabled(false); return; }

    // Turning ON: if the user hasn't accepted yet, show the modal.
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
      stopPolling();
      tearDownEngine();
      if (window.LaskerBoardArrows) window.LaskerBoardArrows.clear();
      return;
    }
    if (!state.context || !state.context.safe) {
      // Context will re-enable polling when/if it becomes safe.
      return;
    }
    state.lastHash = null;
    state.prevEval = null;
    state.prevRef = null;
    state.prevBest = null;
    state.prevBestRef = null;
    state.lastMover = null;
    state.moveTimeline = [];
    state.tally = emptyTally();
    window.LaskerOverlay.resetTimeline();
    window.LaskerOverlay.setSummary(null);
    startPolling();
  }

  function setDepth(n) {
    state.settings.depth = n;
    saveSettings(state.settings);
    if (canRun() && state.currentFen && state.engine && state.engine.ready) {
      state.currentLines = { 1: null, 2: null, 3: null };
      state.currentDepth = 0;
      state.labelSnapshotted = false;
      state.engine.analyze(state.currentFen, n);
    }
  }

  function setTheme(t) { state.settings.theme = t; saveSettings(state.settings); }
  function setSize(s) { state.settings.size = s; saveSettings(state.settings); }
  function setCollapsed(c) { state.settings.collapsed = !!c; saveSettings(state.settings); }
  function setMode(m) {
    state.settings.mode = m === "advanced" ? "advanced" : "focus";
    saveSettings(state.settings);
  }
  function setAdvisor(a) {
    state.settings.advisor = a === "both-sides" ? "both-sides" : "my-side";
    saveSettings(state.settings);
    // Re-render immediately so My-side filtering applies to the current
    // position without waiting for the next move.
    renderEngineHint();
    classifyLastMove();
    pushSummaryToOverlay();
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
    // If turning back on, re-render arrows for the current position.
    if (on) renderArrows();
  }

  // ---------------------------------------------------------------------------
  // 0.8.0: Opening Library & Study mode
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

  // Pick an opening from the curated catalog and enter Learn + Study mode.
  // If the user was on Analyze, flips them to Learn (engine off).
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
      line,               // [{ ply, san, uci, turn, hash }]
      idx: 0,             // index into `line` of the NEXT expected ply
      lastKnownIdx: 0,    // highest idx we've synced to (for off-book UI)
      state: "active",
      expectedSan: null,
    };

    // Surface flips to Learn whenever you pick an opening -- that's the
    // whole point of the Library.
    if (state.settings.surface !== "learn") {
      setSurface("learn");
    } else {
      // Already in Learn: just sync against the current live board.
      updateStudyForPosition();
      pushStudyToOverlay();
      renderArrows();
    }
  }

  // Entry point from the Analyze opening-pill's "Study this" button.
  function studyOpeningById({ opId }) {
    pickOpening({ opId });
  }

  function exitStudy() {
    state.studying = null;
    window.LaskerOverlay.clearStudy();
    renderArrows();
  }

  // 0.9.0: position-hash based study sync. Called on every position
  // change. Finds where the current live board sits within the opening's
  // expanded line; this makes takebacks, scrubs, and branching back to
  // book all Just Work.
  function updateStudyForPosition() {
    const s = state.studying;
    if (!s || !state.currentGrid) return;
    const currentHash = window.LaskerOpeningBook.gridHash(state.currentGrid);
    const k = findHashInLine(s, currentHash);
    if (k < 0) {
      // Off-book: remember which ply the student was expected to play
      // when they diverged so the UI can show "the book move would have
      // been Nf3". Keep s.idx frozen at the divergence point.
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
    else if (s.op && s.state === "active") why = "Stay on theory — this is a main-line continuation.";
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

  // 0.9.0: ONE arrow only. No more 2-ply animation -- it was busy and
  // confused beginners. Picks what to draw based on surface:
  //   - Learn + active study  -> next expected ply (solid "my" arrow)
  //   - Analyze + my turn     -> engine's best move (solid "my" arrow)
  //   - Analyze + opp turn    -> nothing when advisor=my-side
  //                              (both-sides shows opp's best as "reply")
  function renderArrows() {
    if (!window.LaskerBoardArrows) return;
    if (!state.settings.showArrows) { window.LaskerBoardArrows.clear(); return; }
    if (!state.context || !state.context.safe || !state.settings.enabled) {
      window.LaskerBoardArrows.clear();
      return;
    }
    const boardEl = window.LaskerBoardReader.findBoard();
    if (boardEl) window.LaskerBoardArrows.setBoard(boardEl);

    // --- Learn surface ---------------------------------------------------
    if (state.settings.surface === "learn") {
      const s = state.studying;
      if (s && s.state === "active" && s.line[s.idx]) {
        window.LaskerBoardArrows.showBest(s.line[s.idx].uci);
      } else {
        window.LaskerBoardArrows.clear();
      }
      return;
    }

    // --- Analyze surface -------------------------------------------------
    const primary = state.currentLines[1];
    if (!primary || !primary.pv || !primary.pv[0]) {
      window.LaskerBoardArrows.clear();
      return;
    }

    // 0.10.0: arrows are ONLY ever drawn for the student's own side.
    // Pointing at the opponent's best move was confusing beginners
    // (they'd grab an enemy piece). The advisor=both-sides setting
    // still affects the Insight bubble and last-move card, but the
    // board itself stays clean on the opponent's turn.
    const myTurn = !state.playerColor || state.turn === state.playerColor;
    if (!myTurn) {
      window.LaskerBoardArrows.clear();
      return;
    }
    window.LaskerBoardArrows.showBest(primary.pv[0]);
  }

  // ---------------------------------------------------------------------------
  // 0.9.0: Surface (Analyze / Learn) switch
  // ---------------------------------------------------------------------------
  function setSurface(s) {
    const surface = s === "learn" ? "learn" : "analyze";
    state.settings.surface = surface;
    saveSettings(state.settings);
    window.LaskerOverlay.setSurface(surface);

    if (surface === "learn") {
      // Engine off in Learn. Poll keeps running so takebacks on chess.com
      // keep the Study card in sync.
      tearDownEngine();
      state.currentLines = { 1: null, 2: null, 3: null };
      state.currentDepth = 0;
      window.LaskerOverlay.clearAnalysis();
      window.LaskerOverlay.setEngineThinking(false);
      window.LaskerOverlay.setOpeningPill(null);
      window.LaskerOverlay.setStatus("learning");
      ensureCatalog();
      renderArrows();
      return;
    }

    // Back to Analyze: if we have a live position and fair-play allows it,
    // re-kick the engine so the student sees immediate feedback.
    if (canRun() && state.currentFen && state.context && state.context.engineAllowed) {
      const eng = ensureEngine();
      window.LaskerOverlay.setStatus("thinking...");
      window.LaskerOverlay.setEngineThinking(true);
      eng.init().then(() => {
        if (state.currentFen) eng.analyze(state.currentFen, state.settings.depth);
      }).catch((err) => {
        log("resume analyze failed:", err);
        window.LaskerOverlay.setEngineThinking(false);
      });
    }
    // 0.10.0: re-render the summary so the tally we accumulated before
    // the Learn detour still shows the moment the user flips back.
    pushSummaryToOverlay();
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

    // Safety: acceptance must come before enabled is persisted. If they ever
    // get out of sync, force-disable until the user reaccepts.
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
    });
    // Apply mode + advisor FIRST so the overlay never flashes the default
    // layout before flipping to the user's preference.
    window.LaskerOverlay.setMode(state.settings.mode);
    window.LaskerOverlay.setAdvisor(state.settings.advisor);
    window.LaskerOverlay.setTheme(state.settings.theme);
    // Stash custom width before setSize -- setSize wipes it and fires
    // onWidthChange(null), which would clobber persisted value.
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
    // Apply persisted surface (Analyze / Learn) LAST so the rest of the
    // overlay is already bound before the CSS gating classes flip on.
    window.LaskerOverlay.setSurface(state.settings.surface || "analyze");

    // Board arrows -- mount the SVG overlay next to the real chess.com
    // board. Visibility follows the user's setting; the controller decides
    // what to draw in renderArrows().
    if (window.LaskerBoardArrows) {
      try {
        window.LaskerBoardArrows.mount();
        const boardEl = window.LaskerBoardReader.findBoard();
        if (boardEl) window.LaskerBoardArrows.setBoard(boardEl);
        window.LaskerBoardArrows.setVisible(!!state.settings.showArrows);
      } catch (err) { log("arrows mount failed:", err); }
    }

    // Load the curated opening catalog lazily but eagerly enough that the
    // modal opens instantly on first use.
    ensureCatalog();

    // Subscribe to fair-play context and drive lifecycle from it.
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
