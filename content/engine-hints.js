// Human-readable hints for Stockfish's top move.
//
// The engine speaks UCI / SAN; a beginner wants a sentence. This module turns
// a SAN string + the evaluation around it into one or two lines like:
//
//   "Develop the knight to f3 - fights for the centre."
//   "Play Bb5 - pins the knight, threatens to trade for the defender of e5."
//   "Forces mate in 3."
//
// We deliberately stay side-to-move agnostic: the caller (content.js) already
// knows whose turn it is, and the phrasing works either way.
//
// The module is a pure-JS helper; no DOM, no chrome APIs. Exposes:
//
//   window.ChessMateEngineHints.describeMove({
//     san, prevScoreCp, prevScoreMate, currScoreCp, currScoreMate, plyCount,
//   }) -> string
//
// Inputs may be null/undefined; the function fails soft and returns "".

(function () {
  "use strict";

  const PIECE_NAMES = {
    K: "king",
    Q: "queen",
    R: "rook",
    B: "bishop",
    N: "knight",
  };

  // Squares that count as "central" vs "extended centre" for thematic hints.
  const CENTRE = new Set(["d4", "d5", "e4", "e5"]);
  const EXT_CENTRE = new Set(["c4", "c5", "d4", "d5", "e4", "e5", "f4", "f5"]);

  // Natural developing squares for knights / bishops in the opening.
  const GOOD_KNIGHT_SQUARES = new Set(["f3", "c3", "f6", "c6", "d2", "d7", "e2", "e7"]);
  const GOOD_BISHOP_SQUARES = new Set([
    "c4", "f4", "b5", "g5", "e3", "d3", "g2", "b2",
    "c5", "f5", "b4", "g4", "e6", "d6", "g7", "b7",
  ]);

  function pieceFromSan(san) {
    if (!san) return null;
    if (san.startsWith("O-O")) return "K";
    const c = san[0];
    if (/[KQRBN]/.test(c)) return c;
    return "P";
  }

  function targetSquare(san) {
    if (!san) return null;
    if (san === "O-O" || san === "O-O+" || san === "O-O#") return "g-side";
    if (san === "O-O-O" || san === "O-O-O+" || san === "O-O-O#") return "c-side";
    const m = san.replace(/[+#!?]/g, "").match(/[a-h][1-8](?=[^a-h1-8]*$)/);
    return m ? m[0] : null;
  }

  function isCastle(san) {
    return san === "O-O" || san === "O-O-O" ||
           san === "O-O+" || san === "O-O-O+" ||
           san === "O-O#" || san === "O-O-O#";
  }

  function actionClause(san, piece, target) {
    const isCapture = san.includes("x");
    const isCheck = san.endsWith("+");
    const isMate = san.endsWith("#");
    const isPromo = san.includes("=");

    if (isCastle(san)) {
      return san === "O-O" || san.startsWith("O-O+") || san.startsWith("O-O#")
        ? "castle short"
        : "castle long";
    }

    const name = PIECE_NAMES[piece];
    if (piece === "P") {
      if (isCapture) return `pawn takes on ${target}`;
      if (isPromo) return `promote on ${target}`;
      return `push to ${target}`;
    }
    if (isCapture) return `${name} takes on ${target}`;
    return `${name} to ${target}`;
    // "check" / "checkmate" gets appended separately so the sentence scans.
  }

  function thematicClause(san, piece, target) {
    const thoughts = [];

    if (isCastle(san)) {
      thoughts.push("puts the king in safety and activates the rook");
      return thoughts;
    }

    if (piece === "N" && GOOD_KNIGHT_SQUARES.has(target)) {
      thoughts.push("a natural developing square");
    } else if (piece === "B" && GOOD_BISHOP_SQUARES.has(target)) {
      thoughts.push("good diagonal for the bishop");
    }

    if (CENTRE.has(target)) {
      thoughts.push("fights for the centre");
    } else if (EXT_CENTRE.has(target) && piece === "P") {
      thoughts.push("claims space in the centre");
    }

    if (piece === "Q") {
      thoughts.push("active queen move - watch for tactics on both sides");
    }

    if (san.endsWith("#")) {
      thoughts.push("delivers checkmate");
    } else if (san.endsWith("+")) {
      thoughts.push("gives check");
    }

    if (san.includes("=")) {
      thoughts.push("promotes the pawn");
    }

    return thoughts;
  }

  // Returns a short phrase describing the evaluation AFTER the move from the
  // mover's perspective.
  //
  // mover: "w" or "b"
  // currCp/currMate: evaluation AFTER the move, in White-positive convention
  //                  (same as what we feed the overlay bar).
  function evalClause({ mover, currScoreCp, currScoreMate }) {
    if (currScoreMate !== null && currScoreMate !== undefined) {
      const moverMate = mover === "w" ? currScoreMate : -currScoreMate;
      if (moverMate > 0) return `forces mate in ${moverMate}`;
      if (moverMate < 0) return `avoids a faster loss (mate in ${-moverMate})`;
    }
    if (currScoreCp === null || currScoreCp === undefined) return null;

    const moverCp = mover === "w" ? currScoreCp : -currScoreCp;
    const pawns = moverCp / 100;
    if (pawns >= 3) return `keeps a winning advantage (${formatPawns(pawns)})`;
    if (pawns >= 1.5) return `holds a clear edge (${formatPawns(pawns)})`;
    if (pawns >= 0.5) return `retains a small plus (${formatPawns(pawns)})`;
    if (pawns > -0.5) return `keeps the balance (${formatPawns(pawns)})`;
    if (pawns > -1.5) return `stays only slightly worse (${formatPawns(pawns)})`;
    return `best defence in a rough spot (${formatPawns(pawns)})`;
  }

  function formatPawns(p) {
    const sign = p > 0 ? "+" : p < 0 ? "" : ""; // minus already in the number
    return `${sign}${p.toFixed(2)}`;
  }

  // Public: build a one-line advice string for a single engine move.
  //
  // Inputs (all optional):
  //   san           : SAN of the move ("Nf3", "O-O", "e4", ...)
  //   mover         : "w" | "b" - whose turn it is in the position before san
  //   currScoreCp   : cp score AFTER the move, White-positive (number|null)
  //   currScoreMate : mate-in-N AFTER the move, White-positive (number|null)
  //   inBook        : boolean - the move (or resulting position) is in theory
  function describeMove({
    san,
    mover,
    currScoreCp,
    currScoreMate,
    inBook,
  } = {}) {
    if (!san) return "";

    const piece = pieceFromSan(san);
    const target = targetSquare(san);
    const action = actionClause(san, piece, target);

    const themes = thematicClause(san, piece, target);

    const evalStr = evalClause({ mover, currScoreCp, currScoreMate });

    // Compose.
    //
    //   "Play Nf3 - a natural developing square, fights for the centre. Holds a clear edge (+0.73)."
    //
    // If it's a book move, note that up front so players understand why the
    // engine's choice matches theory.
    const pieces = [];
    pieces.push(`Play ${san}`);
    if (themes.length > 0) {
      pieces.push(` - ${themes.slice(0, 2).join("; ")}`);
    }
    let sentence = pieces.join("") + ".";

    if (inBook) {
      sentence = `Book move: ${sentence}`;
    }

    if (evalStr) {
      sentence += ` ${capitalise(evalStr)}.`;
    }

    return sentence;
  }

  function capitalise(s) {
    if (!s) return s;
    return s[0].toUpperCase() + s.slice(1);
  }

  window.ChessMateEngineHints = { describeMove };
})();
