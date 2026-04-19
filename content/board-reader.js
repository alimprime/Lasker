// Reads the current chess.com board state from the DOM and produces a FEN.
//
// chess.com renders its board via a <wc-chess-board> (or legacy <chess-board>)
// custom element. Pieces are child divs with CSS classes:
//   - a 2-char piece code like "wp" (white pawn), "bn" (black knight), etc.
//   - a "square-FR" class where F is the file 1..8 (a..h) and R is the rank 1..8.
// Empty squares have no DOM element. We reconstruct the FEN by iterating
// rank 8 down to 1, file 1 up to 8, checking for a piece at each square.
//
// This module exposes window.ChessMateBoardReader with two methods:
//   - findBoard()  -> the <wc-chess-board> element or null
//   - readPosition() -> { fen, turn, flipped, hash } or null
//
// `turn` is inferred by counting pieces in a naive way and by tracking
// transitions (the controller flips side-to-move whenever the board hash changes).
// `hash` is a compact signature of the piece layout used for change detection.

(function () {
  "use strict";

  const BOARD_SELECTOR = "wc-chess-board, chess-board";

  const PIECE_CHAR = {
    wp: "P", wn: "N", wb: "B", wr: "R", wq: "Q", wk: "K",
    bp: "p", bn: "n", bb: "b", br: "r", bq: "q", bk: "k",
  };

  function findBoard() {
    return document.querySelector(BOARD_SELECTOR);
  }

  function extractPieceCode(el) {
    for (const cls of el.classList) {
      if (cls.length === 2 && (cls[0] === "w" || cls[0] === "b")) {
        return cls;
      }
    }
    return null;
  }

  function extractSquareCode(el) {
    for (const cls of el.classList) {
      if (cls.startsWith("square-") && cls.length === 9) {
        return cls.slice(7);
      }
    }
    return null;
  }

  // Build an 8x8 grid [rank][file] indexed 0..7, where rank 0 = rank 1 (bottom).
  function buildGrid(board) {
    const grid = Array.from({ length: 8 }, () => Array(8).fill(null));
    const pieces = board.querySelectorAll(".piece");
    for (const el of pieces) {
      const pieceCode = extractPieceCode(el);
      const squareCode = extractSquareCode(el);
      if (!pieceCode || !squareCode) continue;
      const file = parseInt(squareCode[0], 10) - 1;
      const rank = parseInt(squareCode[1], 10) - 1;
      if (file < 0 || file > 7 || rank < 0 || rank > 7) continue;
      grid[rank][file] = PIECE_CHAR[pieceCode] || null;
    }
    return grid;
  }

  function gridToBoardFen(grid) {
    const rows = [];
    for (let rank = 7; rank >= 0; rank--) {
      let row = "";
      let empties = 0;
      for (let file = 0; file < 8; file++) {
        const p = grid[rank][file];
        if (p) {
          if (empties > 0) {
            row += empties;
            empties = 0;
          }
          row += p;
        } else {
          empties++;
        }
      }
      if (empties > 0) row += empties;
      rows.push(row);
    }
    return rows.join("/");
  }

  function hashGrid(grid) {
    let h = "";
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        h += grid[r][f] || ".";
      }
    }
    return h;
  }

  // Naive turn heuristic. When we cannot be certain, we assume white to move.
  // The controller overrides this by toggling turn on every detected change.
  function naiveTurn(grid) {
    let whitePieces = 0;
    let blackPieces = 0;
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const p = grid[r][f];
        if (!p) continue;
        if (p === p.toUpperCase()) whitePieces++;
        else blackPieces++;
      }
    }
    return whitePieces > blackPieces ? "w" : "b";
  }

  function isStartingPosition(grid) {
    const expected = [
      ["R", "N", "B", "Q", "K", "B", "N", "R"],
      ["P", "P", "P", "P", "P", "P", "P", "P"],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      ["p", "p", "p", "p", "p", "p", "p", "p"],
      ["r", "n", "b", "q", "k", "b", "n", "r"],
    ];
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        if (grid[r][f] !== expected[r][f]) return false;
      }
    }
    return true;
  }

  function readPosition() {
    const board = findBoard();
    if (!board) return null;

    const grid = buildGrid(board);
    const boardFen = gridToBoardFen(grid);
    const flipped = board.classList.contains("flipped");
    const hash = hashGrid(grid);
    const startPos = isStartingPosition(grid);

    return {
      board,
      grid,
      boardFen,
      flipped,
      hash,
      isStartPos: startPos,
      naiveTurn: naiveTurn(grid),
    };
  }

  // Compose a full FEN from a partial position and a known turn.
  // Castling rights default to "KQkq" (best-effort; if king or rook moved,
  // the evaluation will still be reasonable, and this cannot be reliably
  // determined from the DOM alone).
  function toFen(position, turn) {
    if (!position) return null;
    const castling = inferCastling(position.grid);
    const enPassant = "-";
    const halfMove = 0;
    const fullMove = 1;
    return `${position.boardFen} ${turn} ${castling || "-"} ${enPassant} ${halfMove} ${fullMove}`;
  }

  function inferCastling(grid) {
    let rights = "";
    if (grid[0][4] === "K") {
      if (grid[0][7] === "R") rights += "K";
      if (grid[0][0] === "R") rights += "Q";
    }
    if (grid[7][4] === "k") {
      if (grid[7][7] === "r") rights += "k";
      if (grid[7][0] === "r") rights += "q";
    }
    return rights;
  }

  window.ChessMateBoardReader = {
    findBoard,
    readPosition,
    toFen,
  };
})();
