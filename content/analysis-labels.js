// Pure helpers for turning numeric Stockfish scores into human-readable text.
//
// Exposes window.LaskerLabels with:
//   - assessPosition({ scoreCp, scoreMate, turn }) -> { label, severity }
//   - classifyMove({ prevWhiteCp, prevWhiteMate, currWhiteCp, currWhiteMate,
//                    mover, inBook }) -> { label, severity, detail, detailPlain,
//                    moverDeltaCp }
//   - plainEvalSummary({ ...same as classifyMove }) -> string (coaching tone)
//   - toWhitePerspective(scoreCp, scoreMate, turn) -> { cp, mate }
//   - whiteValueOf(scoreCp, scoreMate) -> centipawn value (mate mapped high)
//
// `severity` values (used by overlay for colors):
//   "brilliant" | "great" | "best" | "good" | "book" | "neutral" |
//   "inaccuracy" | "mistake" | "blunder"

(function () {
  "use strict";

  function toWhitePerspective(scoreCp, scoreMate, turn) {
    if (scoreMate !== null && scoreMate !== undefined) {
      return { cp: null, mate: turn === "w" ? scoreMate : -scoreMate };
    }
    if (scoreCp !== null && scoreCp !== undefined) {
      return { cp: turn === "w" ? scoreCp : -scoreCp, mate: null };
    }
    return { cp: null, mate: null };
  }

  function whiteValueOf(scoreCp, scoreMate) {
    if (scoreMate !== null && scoreMate !== undefined) {
      if (scoreMate > 0) return 100000 - scoreMate;
      if (scoreMate < 0) return -100000 - scoreMate;
      return 0;
    }
    if (scoreCp !== null && scoreCp !== undefined) return scoreCp;
    return null;
  }

  function assessPosition({ scoreCp, scoreMate, turn }) {
    const { cp, mate } = toWhitePerspective(scoreCp, scoreMate, turn);

    if (mate !== null) {
      if (mate === 0) return { label: "Checkmate", severity: "neutral" };
      if (mate > 0) return { label: `White mates in ${mate}`, severity: "great" };
      return { label: `Black mates in ${Math.abs(mate)}`, severity: "great" };
    }

    if (cp === null) return { label: "", severity: "neutral" };

    const mag = Math.abs(cp);
    const side = cp > 0 ? "White" : "Black";
    if (mag < 30) return { label: "Position is balanced", severity: "neutral" };
    if (mag < 80) return { label: `${side} has a slight edge`, severity: "neutral" };
    if (mag < 200) return { label: `${side} is clearly better`, severity: "good" };
    if (mag < 500) return { label: `${side} has a winning advantage`, severity: "good" };
    return { label: `${side} is completely winning`, severity: "great" };
  }

  function formatPawnsSigned(cp) {
    const pawns = cp / 100;
    const sign = pawns > 0 ? "+" : "";
    return `${sign}${pawns.toFixed(2)}`;
  }

  function formatDelta(delta) {
    // delta is in centipawns; positive means things got better for the mover.
    const sign = delta > 0 ? "+" : "";
    return `${sign}${(delta / 100).toFixed(2)}`;
  }

  /** Mover-relative mate (positive = mover can mate). */
  function moverMateFromWhite(whiteMate, mover) {
    if (whiteMate === null || whiteMate === undefined) return null;
    return mover === "w" ? whiteMate : -whiteMate;
  }

  /** Mover-relative centipawns (positive = good for mover). */
  function moverCpFromWhite(whiteCp, mover) {
    if (whiteCp === null || whiteCp === undefined) return null;
    return mover === "w" ? whiteCp : -whiteCp;
  }

  /**
   * Short qualitative description of the mover's standing from their cp alone.
   */
  function standingPhraseFromMoverCp(cpCenti) {
    const p = cpCenti / 100;
    const a = Math.abs(p);
    if (a < 0.35) return "roughly equal chances";
    if (p > 0) {
      if (a < 1) return "a slight edge";
      if (a < 2.5) return "a comfortable edge";
      if (a < 5) return "a commanding advantage";
      return "a dominant, nearly winning advantage";
    }
    if (a < 1) return "a slightly worse position";
    if (a < 2.5) return "a worse position";
    if (a < 5) return "a difficult, worse position";
    return "a very tough position";
  }

  /**
   * Beginner-friendly eval story (no "Δ" / "from mover" jargon).
   * Mate and mixedmate/cp positions get short, explicit wording.
   */
  function plainEvalSummary({
    prevWhiteCp,
    prevWhiteMate,
    currWhiteCp,
    currWhiteMate,
    mover,
  }) {
    if (!mover) return "";

    const side = mover === "w" ? "White" : "Black";

    const prevM = moverMateFromWhite(prevWhiteMate, mover);
    const currM = moverMateFromWhite(currWhiteMate, mover);
    const hasPrevMate = prevWhiteMate !== null && prevWhiteMate !== undefined;
    const hasCurrMate = currWhiteMate !== null && currWhiteMate !== undefined;

    const prevC = moverCpFromWhite(prevWhiteCp, mover);
    const currC = moverCpFromWhite(currWhiteCp, mover);

    // Pure cp — most common for suboptimal moves.
    if (!hasPrevMate && !hasCurrMate && prevC != null && currC != null) {
      const delta = currC - prevC;
      const before = standingPhraseFromMoverCp(prevC);
      const after = standingPhraseFromMoverCp(currC);
      const lostPawns = -delta / 100;
      let s =
        `Right before this move ${side} had ${before}. After this move, the picture looks more like ${after}.`;
      if (delta <= -300) {
        s += ` On the computer's scale that is about ${lostPawns.toFixed(1)} pawns of value gone in one go — very costly.`;
      } else if (delta <= -150) {
        s += ` On the computer's scale ${side} gave back roughly ${lostPawns.toFixed(1)} pawns of value.`;
      } else if (delta <= -70) {
        s += ` The swing is close to ${Math.abs(lostPawns).toFixed(2)} pawns on the computer's scale.`;
      } else {
        const d = Math.abs(lostPawns).toFixed(2);
        s += ` The change is small (about ${d} pawns on the computer's scale) but enough to matter at this level.`;
      }
      return s;
    }

    // Mate on the board — avoid fake "pawn" readings.
    let before = "";
    if (hasPrevMate && prevM != null && prevM !== 0) {
      before = prevM > 0
        ? `${side} was on track to force mate in ${prevM}`
        : `${side} was defending against mate in ${Math.abs(prevM)}`;
    } else if (prevC != null) {
      before = `${side} had ${standingPhraseFromMoverCp(prevC)}`;
    }

    let after = "";
    if (hasCurrMate && currM != null && currM !== 0) {
      after = currM > 0
        ? `after the move the analysis still shows mate in ${currM} for ${side}`
        : `after the move ${side} can be mated in ${Math.abs(currM)} if the other side finds the line`;
    } else if (currC != null) {
      after = `after the move ${side} has ${standingPhraseFromMoverCp(currC)}`;
    }

    if (!before && !after) return "";
    if (before && after) {
      return `${before.charAt(0).toUpperCase() + before.slice(1)}. ${after.charAt(0).toUpperCase() + after.slice(1)}.`;
    }
    const one = before || after;
    return `${one.charAt(0).toUpperCase() + one.slice(1)}.`;
  }

  // Classifies the move that was just played.
  //
  // Works in "mover perspective": we compute the mover's value before and
  // after the move, then `delta = after - before` (positive = good for the
  // mover). Thresholds are tuned to roughly mirror chess.com's own labels.
  //
  // `inBook` indicates the NEW position (after the move) is found in master
  // theory. When true and the move was not a blunder/mistake we label it "Book".
  function classifyMove({
    prevWhiteCp,
    prevWhiteMate,
    currWhiteCp,
    currWhiteMate,
    mover,
    inBook,
  }) {
    if (!mover) return null;

    const prevWhite = whiteValueOf(prevWhiteCp, prevWhiteMate);
    const currWhite = whiteValueOf(currWhiteCp, currWhiteMate);
    if (prevWhite === null || currWhite === null) return null;

    // Express both in the mover's POV.
    const prevMover = mover === "w" ? prevWhite : -prevWhite;
    const currMover = mover === "w" ? currWhite : -currWhite;
    const delta = currMover - prevMover;

    const prevPawns = mover === "w" ? formatPawnsSigned(prevWhite)
                                    : formatPawnsSigned(-prevWhite);
    const currPawns = mover === "w" ? formatPawnsSigned(currWhite)
                                    : formatPawnsSigned(-currWhite);
    const deltaStr = formatDelta(delta);
    const detail = `Eval (from mover): ${prevPawns} -> ${currPawns} (Δ ${deltaStr})`;

    let moverDeltaCp = null;
    if ((prevWhiteMate == null || prevWhiteMate === undefined) &&
        (currWhiteMate == null || currWhiteMate === undefined) &&
        prevWhiteCp != null && currWhiteCp != null) {
      const pm = mover === "w" ? prevWhiteCp : -prevWhiteCp;
      const cm = mover === "w" ? currWhiteCp : -currWhiteCp;
      moverDeltaCp = cm - pm;
    }

    const detailPlain = plainEvalSummary({
      prevWhiteCp,
      prevWhiteMate,
      currWhiteCp,
      currWhiteMate,
      mover,
    });

    const extra = { detail, detailPlain, moverDeltaCp };

    // Blunder / mistake / inaccuracy trump "book".
    if (delta <= -300) return { label: "Blunder", badge: "??", severity: "blunder", ...extra };
    if (delta <= -150) return { label: "Mistake", badge: "?",  severity: "mistake",    ...extra };
    if (delta <= -70)  return { label: "Inaccuracy", badge: "?!", severity: "inaccuracy", ...extra };

    if (inBook) return { label: "Book move", badge: "", severity: "book", ...extra };

    if (delta >= 200) return { label: "Brilliant", badge: "!!", severity: "brilliant", ...extra };
    if (delta >= 80)  return { label: "Great move", badge: "!", severity: "great", ...extra };
    if (Math.abs(delta) < 25) return { label: "Best", badge: "", severity: "best", ...extra };
    return { label: "Good move", badge: "", severity: "good", ...extra };
  }

  window.LaskerLabels = {
    assessPosition,
    classifyMove,
    plainEvalSummary,
    whiteValueOf,
    toWhitePerspective,
  };
})();
