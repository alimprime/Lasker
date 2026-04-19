// Pure helpers for turning numeric Stockfish scores into human-readable text.
//
// Exposes window.LaskerLabels with:
//   - assessPosition({ scoreCp, scoreMate, turn }) -> { label, severity }
//   - classifyMove({ prevWhiteCp, prevWhiteMate, currWhiteCp, currWhiteMate,
//                    mover, inBook }) -> { label, severity, detail }
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

    // Blunder / mistake / inaccuracy trump "book".
    if (delta <= -300) return { label: "Blunder", badge: "??", severity: "blunder", detail };
    if (delta <= -150) return { label: "Mistake", badge: "?",  severity: "mistake",    detail };
    if (delta <= -70)  return { label: "Inaccuracy", badge: "?!", severity: "inaccuracy", detail };

    if (inBook) return { label: "Book move", badge: "", severity: "book", detail };

    if (delta >= 200) return { label: "Brilliant", badge: "!!", severity: "brilliant", detail };
    if (delta >= 80)  return { label: "Great move", badge: "!", severity: "great", detail };
    if (Math.abs(delta) < 25) return { label: "Best", badge: "", severity: "best", detail };
    return { label: "Good move", badge: "", severity: "good", detail };
  }

  window.LaskerLabels = {
    assessPosition,
    classifyMove,
    whiteValueOf,
    toWhitePerspective,
  };
})();
