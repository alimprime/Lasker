// Post-game batch analyser.
//
// Takes the SAN list of a finished chess.com game, expands it into a
// ply-by-ply sequence of FENs, runs Stockfish at a fixed depth against
// EACH position, and returns an in-memory review object keyed by the
// grid hash. The content controller then serves this cache on every
// board-step instead of spinning up a live engine per position.
//
// The session owns exactly ONE LaskerEngine instance for the duration
// of the batch. It's torn down on completion or on cancel. During the
// "ready" phase (cache served), no engine is running at all.
//
// Exposes window.LaskerAnalyzeSession with:
//   - run({ sans, depth, onProgress, signal, playerColor })
//       -> Promise<{
//            plies: PlyEntry[],        // one per position (including start)
//            byHash: Map<hash, PlyEntry>,
//            playerColor: "w" | "b",
//            result: string | null,
//            startHash: string,
//            totalMoves: number,
//            depth: number,
//          }>
//
// PlyEntry shape:
//   {
//     ply,                          // 0..N; 0 = starting position
//     fen, hash, grid, turn,        // position AT this ply; turn = side-to-move
//     lastSan, lastUci, mover,      // the move that LED here (null for ply 0)
//     scoreCp, scoreMate,           // eval AT this position (raw, from side-to-move)
//     whiteCp, whiteMate,           // same, flipped to white's POV (handy for UI)
//     bestUci, bestSan,             // engine's best reply FROM this position
//     pv,                           // Stockfish PV, first ~8 UCIs
//     classification,               // classifyMove() output for the move that led
//                                   // here; null for ply 0
//     assessment,                   // assessPosition() output AT this position
//     opening,                      // { name, eco } | null (book name for this
//                                   // position, if any)
//     inBook,                       // true if opening lookup returned a name
//   }

(function () {
  "use strict";

  // Default cap on how many PV plies we store (keeps memory predictable
  // and matches what the overlay renders).
  const MAX_PV = 8;

  function log(...args) { console.log("[Lasker/batch]", ...args); }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function settleBoardStable(boardReader, signal) {
    let last = null;
    for (let k = 0; k < 45; k++) {
      if (signal && signal.aborted) throw new Error("aborted");
      const p = boardReader.readPosition();
      if (!p) {
        await sleep(45);
        continue;
      }
      if (last !== null && p.hash === last) return;
      last = p.hash;
      await sleep(38);
    }
  }

  /**
   * When SAN→UCI replay fails (broken tokens like "xd5"), step chess.com's own
   * move list and read the live board after each ply. Grids/hashes then match
   * navigation — no SAN parsing required.
   */
  async function expandPositionsFromBoardWalk(sans, signal) {
    const reader = window.LaskerMoveListReader;
    const boardReader = window.LaskerBoardReader;
    if (!reader || !reader.goToStart || !reader.goToNext) {
      throw new Error("LaskerMoveListReader missing");
    }
    if (!boardReader || !boardReader.readPosition || !boardReader.toFen) {
      throw new Error("LaskerBoardReader missing");
    }
    const book = window.LaskerOpeningBook;
    if (!book || !book.gridHash) {
      throw new Error("LaskerOpeningBook.gridHash missing");
    }

    const STEP_MS = 88;
    reader.goToStart();
    await sleep(170);
    await settleBoardStable(boardReader, signal);

    const out = [];
    const n = sans.length;

    for (let i = 0; i <= n; i++) {
      if (signal && signal.aborted) throw new Error("aborted");
      const rp = boardReader.readPosition();
      if (!rp) throw new Error("board read failed during DOM walk");

      const sideToMove = i % 2 === 0 ? "w" : "b";
      const fen = boardReader.toFen(rp, sideToMove);
      const gridCopy = rp.grid.map((row) => row.slice());
      const hash = book.gridHash(gridCopy);

      out.push({
        fen,
        grid: gridCopy,
        hash,
        turn: sideToMove,
        lastSan: i > 0 ? sans[i - 1] : null,
        lastUci: null,
        mover: i > 0 ? ((i - 1) % 2 === 0 ? "w" : "b") : null,
        fromGrid: rp.grid.map((row) => row.slice()),
      });

      if (i < n) {
        reader.goToNext();
        await sleep(STEP_MS);
        await settleBoardStable(boardReader, signal);
      }
    }

    return {
      positions: out,
      startHash: out[0].hash,
      replayMeta: {
        inputSans: sans.length,
        replayedMoves: sans.length,
        stopped: false,
        stopReason: null,
        stopIndex: null,
        stopSan: null,
        source: "dom_board_walk",
      },
    };
  }

  // Wait for a single Stockfish analysis to fully settle at depth `d`.
  // We latch on the highest-depth multipv=1 info and resolve when
  // `bestmove` arrives. If the worker never emits `bestmove` (shouldn't
  // happen in practice but guard anyway), we resolve with whatever we
  // have at the given timeout.
  function analyzePosition(engine, fen, depth, signal, timeoutMs) {
    return new Promise((resolve, reject) => {
      let best = null;
      let pv = [];
      let doneResolved = false;

      const onInfo = (info) => {
        if (info.multipv !== 1) return;
        if (best === null || info.depth >= best.depth) {
          best = {
            depth: info.depth,
            scoreCp: info.scoreCp,
            scoreMate: info.scoreMate,
          };
          pv = (info.pv || []).slice(0, MAX_PV);
        }
      };
      const onBestMove = (bestMove) => {
        if (doneResolved) return;
        doneResolved = true;
        cleanup();
        resolve({
          scoreCp: best ? best.scoreCp : null,
          scoreMate: best ? best.scoreMate : null,
          depth: best ? best.depth : 0,
          bestUci: bestMove && bestMove !== "(none)" ? bestMove : null,
          pv,
        });
      };
      const onAbort = () => {
        if (doneResolved) return;
        doneResolved = true;
        cleanup();
        try { engine.stop(); } catch (_err) {}
        reject(new Error("aborted"));
      };
      const cleanup = () => {
        engine.onInfo = null;
        engine.onBestMove = null;
        if (signal) signal.removeEventListener("abort", onAbort);
        if (timer) clearTimeout(timer);
      };

      engine.onInfo = onInfo;
      engine.onBestMove = onBestMove;
      if (signal) {
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener("abort", onAbort, { once: true });
      }

      // Safety timeout. Depth 22 on a 40-piece middlegame should finish
      // in < 5s on Stockfish Lite; give it 20s before we bail. This only
      // ever fires if the worker gets wedged.
      const timer = timeoutMs ? setTimeout(() => {
        if (doneResolved) return;
        doneResolved = true;
        cleanup();
        try { engine.stop(); } catch (_err) {}
        log("position timed out at depth", best ? best.depth : 0);
        resolve({
          scoreCp: best ? best.scoreCp : null,
          scoreMate: best ? best.scoreMate : null,
          depth: best ? best.depth : 0,
          bestUci: null,
          pv,
        });
      }, timeoutMs) : null;

      try {
        engine.analyze(fen, depth);
      } catch (err) {
        if (doneResolved) return;
        doneResolved = true;
        cleanup();
        reject(err);
      }
    });
  }

  // uciToSan using the grid the move is played FROM. Matches the
  // pseudo-SAN converter in content.js; duplicated here to keep the
  // batch module self-contained.
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

  async function run(opts) {
    const sans = Array.isArray(opts && opts.sans) ? opts.sans : [];
    const depth = opts && opts.depth ? Math.max(6, Math.min(28, opts.depth)) : 18;
    const onProgress = (opts && opts.onProgress) || (() => {});
    const signal = opts && opts.signal;
    const playerColor = opts && opts.playerColor === "b" ? "b" : "w";
    const result = opts && opts.result ? opts.result : null;
    const perPlyTimeoutMs = (opts && opts.perPlyTimeoutMs) || 20000;

    if (sans.length === 0) {
      throw new Error("no moves to analyze");
    }

    const book = window.LaskerOpeningBook;
    const labels = window.LaskerLabels;
    if (!book || !book.expandLineWithFens) {
      throw new Error("LaskerOpeningBook.expandLineWithFens is not available");
    }
    if (!labels) {
      throw new Error("LaskerLabels is not available");
    }

    const expanded = book.expandLineWithFens(sans);
    let rm = expanded.replayMeta;

    let positions;
    let startHashForReturn = expanded.startHash;

    const buildPositionsFromSan = () => {
      const startPly = {
        fen: expanded.startFen,
        grid: expanded.startGrid,
        hash: expanded.startHash,
        turn: "w",
        lastSan: null,
        lastUci: null,
        mover: null,
        fromGrid: expanded.startGrid,
      };
      const movePlies = expanded.line.map((m) => ({
        fen: m.fen,
        grid: m.grid,
        hash: m.hash,
        turn: m.turn === "w" ? "b" : "w",
        lastSan: m.san,
        lastUci: m.uci,
        mover: m.turn,
        fromGrid: m.grid,
      }));
      return [startPly, ...movePlies];
    };

    if (rm && rm.stopped) {
      log(
        `SAN replay truncated at index ${rm.stopIndex}: "${rm.stopSan}" (${rm.stopReason}) — ` +
        `${rm.replayedMoves}/${rm.inputSans} half-moves. Trying DOM board walk…`
      );
      try {
        const bw = await expandPositionsFromBoardWalk(sans, signal);
        positions = bw.positions;
        rm = bw.replayMeta;
        startHashForReturn = bw.startHash;
        log(`DOM board walk OK — ${positions.length} positions (cache matches chess.com navigation).`);
      } catch (err) {
        log("DOM board walk failed:", err && err.message ? err.message : err);
        positions = buildPositionsFromSan();
      }
    } else {
      positions = buildPositionsFromSan();
    }

    const total = positions.length;

    // One engine for the whole batch.
    const engine = new window.LaskerEngine({
      multiPv: 1,                          // no need for multipv 3 in batch
    });
    try {
      await engine.init();
    } catch (err) {
      try { engine.terminate(); } catch (_) {}
      throw err;
    }

    const plies = new Array(total);
    const byHash = new Map();
    const startedAt = Date.now();

    try {
      for (let i = 0; i < total; i++) {
        if (signal && signal.aborted) {
          throw new Error("aborted");
        }
        const pos = positions[i];
        onProgress({
          done: i,
          total,
          currentPly: i,
          currentSan: pos.lastSan || null,
          startedAt,
        });

        // Engine analysis at THIS position.
        const info = await analyzePosition(engine, pos.fen, depth, signal, perPlyTimeoutMs);
        const turn = pos.turn;

        // Normalise to white's POV so downstream code can do simple
        // comparisons without juggling signs per ply.
        const white = labels.toWhitePerspective(info.scoreCp, info.scoreMate, turn);

        // Targeted debug for the opening plies. chess.com shows ~+0.3 for
        // 1.e4 and ~0.0 for 2.d4 (Center Game) -- if our pipeline reports
        // something wildly different we need to see whether it's the FEN,
        // the turn, the sign, or the engine's own evaluation. Default-on,
        // matches the [Lasker/debug] stream in content.js.
        const verboseDebug = (() => {
          try {
            if (typeof localStorage !== "undefined") {
              const v = localStorage.getItem("laskerReviewDebug");
              if (v === "0" || v === "false") return false;
            }
          } catch (_e) {}
          return true;
        })();
        if (i <= 4 && verboseDebug) {
          // Pull the side-to-move letter directly out of the FEN so we
          // can compare it against `pos.turn` without trusting either.
          const fenParts = (pos.fen || "").split(/\s+/);
          const fenStm = fenParts[1] || null;
          console.log("[Lasker/debug]", {
            domain: "analyzeSession",
            event: "plyEval",
            t: Date.now(),
            ply: i,
            lastSan: pos.lastSan,
            mover: pos.mover,
            sideToMoveInCache: turn,
            fenSideToMove: fenStm,
            turnFenAgree: turn === fenStm,
            fenSentToEngine: pos.fen,
            engineRaw: { scoreCp: info.scoreCp, scoreMate: info.scoreMate, depth: info.depth },
            whiteNormalised: { whiteCp: white.cp, whiteMate: white.mate },
            bestUci: info.bestUci || null,
            note: "If turnFenAgree=false the white-perspective sign will be inverted.",
          });
        }
        // Decode the engine line from the position being analyzed (`grid` ==
        // `fromGrid` in normal paths; `grid` is authoritative for UCI→SAN).
        const bestSan = info.bestUci ? uciToPseudoSan(info.bestUci, pos.grid) : null;
        const assessment = labels.assessPosition({
          scoreCp: info.scoreCp,
          scoreMate: info.scoreMate,
          turn,
        });

        // Opening lookup (offline, cheap).
        let opening = null;
        let inBook = false;
        try {
          const op = await book.lookup(pos.fen);
          if (op && op.name) {
            opening = { name: op.name, eco: op.eco || "" };
            inBook = true;
          }
        } catch (_err) { /* ignore; opening is advisory */ }

        // Classification of the move that LED here (null for ply 0).
        let classification = null;
        if (i > 0) {
          const prev = plies[i - 1];
          classification = labels.classifyMove({
            prevWhiteCp:   prev.whiteCp,
            prevWhiteMate: prev.whiteMate,
            currWhiteCp:   white.cp,
            currWhiteMate: white.mate,
            mover:         pos.mover,
            inBook,
          });

          // Mirror the eval probe above with the inputs and output of
          // classifyMove, so a misclassification is traceable to either
          // a bad delta or a bad threshold without re-deriving anything.
          if (i <= 4 && verboseDebug) {
            console.log("[Lasker/debug]", {
              domain: "analyzeSession",
              event: "plyClassify",
              t: Date.now(),
              ply: i,
              lastSan: pos.lastSan,
              mover: pos.mover,
              inBook,
              prevWhiteCp: prev.whiteCp,
              prevWhiteMate: prev.whiteMate,
              currWhiteCp: white.cp,
              currWhiteMate: white.mate,
              moverSign: pos.mover === "w" ? "+1" : "-1",
              deltaMoverPawns:
                prev.whiteCp !== null && prev.whiteCp !== undefined &&
                white.cp !== null && white.cp !== undefined
                  ? ((white.cp - prev.whiteCp) * (pos.mover === "w" ? 1 : -1)) / 100
                  : null,
              classification: classification && {
                label: classification.label,
                badge: classification.badge,
                severity: classification.severity,
              },
              note: "deltaMoverPawns < 0 = mover lost ground (their POV).",
            });
          }

          // First full move of the game (1.e4, 1.d4, …): the eval swing from
          // the initial position is often engine noise at fixed batch depth,
          // so sound openers can be mislabeled as blunders. Never treat the
          // first move as inaccuracy / mistake / blunder in the review cache.
          if (i === 1 && classification) {
            const s = classification.severity;
            if (s === "inaccuracy" || s === "mistake" || s === "blunder") {
              classification = {
                ...classification,
                label: inBook ? "Book move" : "Good move",
                badge: "",
                severity: inBook ? "book" : "good",
              };
            }
          }

          // 0.10.0 "Best was X -- missed Y" enrichment, using the prev
          // position's best move.
          if (classification && prev.bestSan && !inBook && i !== 1) {
            const moverSign = pos.mover === "w" ? 1 : -1;
            let missedPawns = null;
            if (prev.whiteCp !== null && prev.whiteCp !== undefined &&
                white.cp !== null && white.cp !== undefined) {
              const actualDeltaMover = (white.cp - prev.whiteCp) * moverSign / 100;
              // The engine's recommended move keeps the prev eval (the
              // PV was pinned at prev.whiteCp when it settled), so
              // missedPawns = bestDelta - actualDelta where bestDelta is
              // roughly 0 (best move preserves the eval).
              missedPawns = 0 - actualDeltaMover;
            }
            if (missedPawns !== null && Math.abs(missedPawns) >= 0.15) {
              classification = {
                ...classification,
                bestSan: prev.bestSan,
                missedText: `missed ${missedPawns > 0 ? "+" : ""}${missedPawns.toFixed(2)}`,
              };
            } else if (prev.whiteMate !== null && prev.whiteMate !== undefined) {
              classification = {
                ...classification,
                bestSan: prev.bestSan,
                missedText: `forced M${Math.abs(prev.whiteMate)}`,
              };
            }
          }
        }

        const entry = {
          ply: i,
          fen: pos.fen,
          hash: pos.hash,
          grid: pos.grid,
          turn,
          lastSan: pos.lastSan,
          lastUci: pos.lastUci,
          mover: pos.mover,
          scoreCp: info.scoreCp,
          scoreMate: info.scoreMate,
          whiteCp: white.cp,
          whiteMate: white.mate,
          depth: info.depth,
          bestUci: info.bestUci,
          bestSan,
          pv: info.pv,
          classification,
          assessment,
          opening,
          inBook,
        };
        plies[i] = entry;
        // Last writer wins for repeated hashes (threefold etc.): that's
        // fine for our purposes -- we want the latest known eval at a
        // given board state.
        byHash.set(pos.hash, entry);
      }

      onProgress({ done: total, total, currentPly: total - 1, startedAt });
      log(
        `batch done: ${total} positions, depth ${depth}, ${Math.round((Date.now() - startedAt) / 100) / 10}s | ` +
        `sans=${sans.length} replayedMoves=${rm ? rm.replayedMoves : "?"} truncated=${rm && rm.stopped}`
      );
    } finally {
      try { engine.terminate(); } catch (_err) {}
    }

    return {
      plies,
      byHash,
      playerColor,
      result,
      startHash: startHashForReturn,
      totalMoves: sans.length,
      depth,
      replayMeta: rm || null,
    };
  }

  window.LaskerAnalyzeSession = { run };
})();
