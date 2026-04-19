// ChessMate content script controller.
//
// Responsibilities:
//   - Wait for a chess.com board to appear.
//   - Mount the overlay and restore preferences (enabled, depth, theme, size).
//   - When enabled, poll the DOM every POLL_MS for position changes.
//   - On a position change:
//       * flip side-to-move (heuristic)
//       * query the Lichess opening explorer in parallel (via background)
//       * start a Stockfish analysis
//       * once engine has a first evaluation, compute:
//           - human-readable position assessment
//           - quality of the last move (using the previous eval + book flag)
//         and push everything to the overlay.

(function () {
  "use strict";

  const POLL_MS = 500;
  const STORAGE_KEY = "chessmate.settings";
  const DEFAULT_SETTINGS = {
    enabled: false,
    depth: 15,
    theme: "dark",
    size: "medium",
  };

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    lastHash: null,
    turn: "w",
    plyCount: 0,
    playerColor: null,       // "w" | "b" | null (inferred from board.flipped)
    engine: null,
    pollHandle: null,
    currentFen: null,
    currentGrid: null,       // 8x8 grid of piece chars for the position we're analysing
    currentLines: { 1: null, 2: null, 3: null },
    currentDepth: 0,
    prevEval: null,          // { whiteCp, whiteMate } -- current position's eval, snapshotted once deep enough
    prevRef: null,           // { whiteCp, whiteMate } -- previous position's eval (reference for last-move classification)
    lastMover: null,         // "w" | "b" | null -- who made the last played move
    inBookNow: false,        // is the current FEN in master theory?
    labelSnapshotted: false,
  };

  function log(...args) { console.log("[ChessMate]", ...args); }

  function loadSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get([STORAGE_KEY], (result) => {
          const s = { ...DEFAULT_SETTINGS, ...(result[STORAGE_KEY] || {}) };
          resolve(s);
        });
      } catch (_err) {
        resolve({ ...DEFAULT_SETTINGS });
      }
    });
  }

  function saveSettings(s) {
    try { chrome.storage.local.set({ [STORAGE_KEY]: s }); } catch (_err) {}
  }

  function waitForBoard() {
    return new Promise((resolve) => {
      const existing = window.ChessMateBoardReader.findBoard();
      if (existing) return resolve(existing);
      const observer = new MutationObserver(() => {
        const b = window.ChessMateBoardReader.findBoard();
        if (b) { observer.disconnect(); resolve(b); }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
    });
  }

  function ensureEngine() {
    if (state.engine) return state.engine;
    state.engine = new window.ChessMateEngine({
      multiPv: 3,
      onInfo: handleEngineInfo,
      onBestMove: () => {},
      onError: (err) => {
        log("engine error:", err);
        window.ChessMateOverlay.setStatus("engine error");
      },
    });
    return state.engine;
  }

  function handleEngineInfo(info) {
    const mpv = info.multipv || 1;
    if (mpv < 1 || mpv > 3) return;
    state.currentLines[mpv] = info;
    if (info.depth > state.currentDepth) state.currentDepth = info.depth;
    renderEvaluation();
  }

  function renderEvaluation() {
    const primary = state.currentLines[1];
    if (!primary) return;

    const lines = [state.currentLines[1], state.currentLines[2], state.currentLines[3]]
      .filter(Boolean)
      .map((i) => ({ scoreCp: i.scoreCp, scoreMate: i.scoreMate, pv: i.pv }));

    window.ChessMateOverlay.setEvaluation({
      scoreCp: primary.scoreCp,
      scoreMate: primary.scoreMate,
      depth: state.currentDepth,
      lines,
      turn: state.turn,
      playerColor: state.playerColor,
    });

    const assess = window.ChessMateLabels.assessPosition({
      scoreCp: primary.scoreCp,
      scoreMate: primary.scoreMate,
      turn: state.turn,
    });
    window.ChessMateOverlay.setAssessment(assess);

    renderEngineHint();

    // Once the engine has reached a decent depth on THIS position, snapshot
    // its white-perspective eval as the reference for the NEXT move's quality.
    if (!state.labelSnapshotted && state.currentDepth >= Math.max(10, state.settings.depth - 3)) {
      const white = window.ChessMateLabels.toWhitePerspective(
        primary.scoreCp, primary.scoreMate, state.turn
      );
      state.prevEval = { whiteCp: white.cp, whiteMate: white.mate };
      state.labelSnapshotted = true;

      // Re-classify now that we have a more accurate current eval.
      classifyLastMove();
    }
  }

  function classifyLastMove() {
    if (!state.lastMover) {
      window.ChessMateOverlay.setLastMove(null);
      return;
    }
    const primary = state.currentLines[1];
    if (!primary) return;
    if (!state.prevRef) {
      window.ChessMateOverlay.setLastMove(null);
      return;
    }

    const currWhite = window.ChessMateLabels.toWhitePerspective(
      primary.scoreCp, primary.scoreMate, state.turn
    );
    const result = window.ChessMateLabels.classifyMove({
      prevWhiteCp: state.prevRef.whiteCp,
      prevWhiteMate: state.prevRef.whiteMate,
      currWhiteCp: currWhite.cp,
      currWhiteMate: currWhite.mate,
      mover: state.lastMover,
      inBook: state.inBookNow,
    });
    window.ChessMateOverlay.setLastMove(result);
  }

  // ---------------------------------------------------------------------------
  // Engine hint: turn Stockfish's top move into a short human sentence.
  // The PV we get from stockfish is in UCI ("e2e4"); we convert to a very
  // simple SAN-ish string using the live grid so hint phrasing can reason
  // about piece type, castling, captures, and centre squares. For ambiguous
  // piece moves we don't bother with disambiguation -- the hint is
  // descriptive, not a substitute for the PV line itself.
  function uciToPseudoSan(uci, grid) {
    if (!uci || uci.length < 4 || !grid) return null;
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promo = uci.slice(4, 5);

    const fFile = from.charCodeAt(0) - 97;     // a=0..h=7
    const fRank = parseInt(from[1], 10) - 1;   // 1=0..8=7
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
      window.ChessMateOverlay.setEngineHint(null);
      return;
    }
    const uci = primary.pv[0];
    const san = uciToPseudoSan(uci, state.currentGrid);
    if (!san) {
      window.ChessMateOverlay.setEngineHint(null);
      return;
    }
    const text = window.ChessMateEngineHints.describeMove({
      san,
      mover: state.turn,
      currScoreCp: primary.scoreCp,
      currScoreMate: primary.scoreMate,
      inBook: state.inBookNow,
    });
    window.ChessMateOverlay.setEngineHint({ text, source: "stockfish" });
  }

  function initTurnFor(position) {
    if (position.isStartPos) { state.turn = "w"; state.plyCount = 0; return; }
    state.turn = position.naiveTurn;
    const pieceCount = position.hash.replace(/\./g, "").length;
    state.plyCount = Math.max(0, 32 - pieceCount);
  }

  async function lookupOpening(fen) {
    if (!window.ChessMateOpeningBook) return;
    if (!window.ChessMateOpeningBook.isEarly(state.plyCount)) {
      window.ChessMateOverlay.setOpening(null);
      state.inBookNow = false;
      return;
    }
    const requestedFen = fen;
    const op = await window.ChessMateOpeningBook.lookup(fen);
    if (state.currentFen !== requestedFen) return;
    // Hand the FEN back to the overlay so it can build a "Study on Lichess"
    // deep-link for the exact current position.
    const enriched = op ? { ...op, fen } : null;
    window.ChessMateOverlay.setOpening(enriched);
    state.inBookNow = !!(op && op.name);
    // The move's "Book" classification depends on whether the NEW position is
    // in theory; re-classify with the fresh flag.
    classifyLastMove();
  }

  async function onPositionChanged(position, isFirst) {
    // Freeze the previous position's eval as the reference BEFORE we reset.
    // For the very first position we have no reference.
    state.prevRef = isFirst ? null : state.prevEval;
    // The last mover is the color opposite to the new side-to-move; null on first load.
    state.lastMover = isFirst ? null : (state.turn === "w" ? "b" : "w");

    state.currentLines = { 1: null, 2: null, 3: null };
    state.currentDepth = 0;
    state.labelSnapshotted = false;
    state.prevEval = null;
    state.inBookNow = false;

    const fen = window.ChessMateBoardReader.toFen(position, state.turn);
    state.currentFen = fen;
    state.currentGrid = position.grid || null;
    log("analyzing", fen);
    window.ChessMateOverlay.setStatus("thinking...");

    // Track player color from board orientation.
    state.playerColor = position.flipped ? "b" : "w";

    lookupOpening(fen).catch(() => {});

    const engine = ensureEngine();
    try {
      await engine.init();
      engine.analyze(fen, state.settings.depth);
    } catch (err) {
      log("analyze failed:", err);
      window.ChessMateOverlay.setStatus("engine error");
    }
  }

  function tickPoll() {
    if (!state.settings.enabled) return;
    const pos = window.ChessMateBoardReader.readPosition();
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

  function startPolling() {
    if (state.pollHandle) return;
    state.pollHandle = setInterval(tickPoll, POLL_MS);
    tickPoll();
  }

  function stopPolling() {
    if (state.pollHandle) { clearInterval(state.pollHandle); state.pollHandle = null; }
  }

  function setEnabled(on) {
    state.settings.enabled = !!on;
    saveSettings(state.settings);
    window.ChessMateOverlay.setEnabled(state.settings.enabled);
    if (state.settings.enabled) {
      state.lastHash = null;
      state.prevEval = null;
      state.prevRef = null;
      state.lastMover = null;
      startPolling();
    } else {
      stopPolling();
      if (state.engine) { state.engine.terminate(); state.engine = null; }
    }
  }

  function setDepth(n) {
    state.settings.depth = n;
    saveSettings(state.settings);
    if (state.settings.enabled && state.currentFen && state.engine && state.engine.ready) {
      state.currentLines = { 1: null, 2: null, 3: null };
      state.currentDepth = 0;
      state.labelSnapshotted = false;
      state.engine.analyze(state.currentFen, n);
    }
  }

  function setTheme(t) {
    state.settings.theme = t;
    saveSettings(state.settings);
  }

  function setSize(s) {
    state.settings.size = s;
    saveSettings(state.settings);
  }

  async function main() {
    if (window.__chessmateLoaded) return;
    window.__chessmateLoaded = true;

    state.settings = await loadSettings();

    await waitForBoard();
    log("board found, mounting overlay");

    window.ChessMateOverlay.mount({
      onToggle: (on) => setEnabled(on),
      onDepthChange: (n) => setDepth(n),
      onThemeChange: (t) => setTheme(t),
      onSizeChange: (s) => setSize(s),
    });
    window.ChessMateOverlay.setTheme(state.settings.theme);
    window.ChessMateOverlay.setSize(state.settings.size);
    window.ChessMateOverlay.setDepth(state.settings.depth);
    window.ChessMateOverlay.setEnabled(state.settings.enabled);

    if (state.settings.enabled) startPolling();

    try {
      chrome.runtime.onMessage.addListener((msg) => {
        if (msg && msg.type === "chessmate:toggle") {
          setEnabled(!state.settings.enabled);
        }
      });
    } catch (_err) {}
  }

  main().catch((err) => log("fatal:", err));
})();
