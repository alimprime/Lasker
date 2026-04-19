// Offline opening theory lookup.
//
// Loads data/openings.json (built from the lichess-org/chess-openings dataset)
// once, on first demand, and serves:
//
//   - the current position's name and ECO code (if it's a known opening)
//   - named continuations: moves that lead to other named openings, so the UI
//     can say "Nf3 -> King's Knight Opening", "d4 -> Queen's Pawn Game" etc.
//
// The raw DB is sorted by ECO code, which would make the list open with a
// dozen obscure novelty openings (Barnes, Borg, Grob, etc.) before the
// mainline Sicilian / French / Italian. So `lookup()` re-sorts children by a
// hand-curated popularity tier first, then ECO, so the hints that matter sit
// at the top.
//
// Exposes window.LaskerOpeningBook with:
//   - lookup(fen) -> Promise<{ name, eco, moves } | null>
//       moves[i]: { san, uci, name, eco, popular }
//   - isEarly(plyCount) -> true while the game is still in the opening phase
//   - loadCatalog() -> Promise<{ version, categories: [...] }>  (hand-curated)
//   - sanToUci(grid, turn, san) -> "e2e4" | null  (for study-mode arrows)

(function () {
  "use strict";

  // Rough ordering of the opening families a chess.com user is most likely
  // to recognise. Continuations whose name STARTS WITH one of these strings
  // sort to the top (lower index = higher priority). Everything else falls
  // to a single "other" bucket and sorts by ECO within it.
  //
  // This is intentionally subjective; tweak at will.
  const POPULAR_FAMILIES = [
    "Sicilian Defense",
    "French Defense",
    "Caro-Kann Defense",
    "Italian Game",
    "Ruy Lopez",
    "Scotch Game",
    "King's Gambit",
    "Vienna Game",
    "Philidor Defense",
    "Petrov",
    "Petroff",
    "Scandinavian Defense",
    "Alekhine Defense",
    "Pirc Defense",
    "Modern Defense",
    "King's Pawn Game",
    "Queen's Gambit",
    "Slav Defense",
    "Semi-Slav",
    "Nimzo-Indian",
    "Queen's Indian",
    "King's Indian",
    "Grünfeld Defense",
    "Grunfeld Defense",
    "Benoni Defense",
    "Dutch Defense",
    "Catalan Opening",
    "London System",
    "Queen's Pawn Game",
    "Indian Defense",
    "English Opening",
    "Réti Opening",
    "Reti Opening",
    "King's Knight Opening",
    "King's Indian Attack",
  ];

  function popularityRank(name) {
    if (!name) return 9999;
    for (let i = 0; i < POPULAR_FAMILIES.length; i++) {
      if (name.startsWith(POPULAR_FAMILIES[i])) return i;
    }
    return POPULAR_FAMILIES.length;
  }

  function sortChildren(moves) {
    return moves.slice().sort((a, b) => {
      const pa = popularityRank(a.name);
      const pb = popularityRank(b.name);
      if (pa !== pb) return pa - pb;
      return (a.eco || "").localeCompare(b.eco || "");
    });
  }

  let DB = null;
  let dbPromise = null;

  function epdFromFen(fen) {
    if (!fen) return "";
    const parts = fen.split(/\s+/);
    return parts.slice(0, 4).join(" ");
  }

  function ensureDb() {
    if (DB) return Promise.resolve(DB);
    if (dbPromise) return dbPromise;
    dbPromise = (async () => {
      try {
        const url = chrome.runtime.getURL("data/openings.json");
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        DB = await resp.json();
        console.log(
          `[Lasker] openings DB loaded: ${Object.keys(DB.names || {}).length} named positions, ${Object.keys(DB.nextByEpd || {}).length} parents`
        );
        return DB;
      } catch (err) {
        console.warn("[Lasker] openings DB load failed:", err);
        DB = { names: {}, nextByEpd: {} };
        return DB;
      }
    })();
    return dbPromise;
  }

  // Kick off the load as early as possible so the first board-change has the
  // DB ready without a visible delay.
  ensureDb();

  async function lookup(fen) {
    if (!fen) return null;
    const db = await ensureDb();
    const epd = epdFromFen(fen);
    const named = db.names ? db.names[epd] : null;
    const rawKids = (db.nextByEpd && db.nextByEpd[epd]) || [];
    if (!named && rawKids.length === 0) {
      console.log(`[Lasker] opening lookup: no match for ${epd}`);
      return null;
    }
    const sorted = sortChildren(rawKids);
    const result = {
      name: named ? named.name : null,
      eco: named ? named.eco : null,
      moves: sorted.map((c) => {
        const rank = popularityRank(c.name);
        return {
          san: c.san,
          uci: c.move,
          eco: c.eco,
          name: c.name,
          popular: rank < POPULAR_FAMILIES.length,
        };
      }),
    };
    console.log(
      `[Lasker] opening lookup: ${named ? `${named.eco} ${named.name}` : "(unnamed position)"}, ${sorted.length} continuations`
    );
    return result;
  }

  // Be generous: cover typical theory depth (up to ~move 20). Beyond this the
  // DB runs out anyway, so the gating is mainly to save a lookup. The overlay
  // also hides the section automatically when the lookup returns null.
  function isEarly(plyCount) {
    return plyCount >= 0 && plyCount <= 40;
  }

  // -------------------------------------------------------------------------
  // Hand-curated catalog (data/opening-catalog.json).
  // -------------------------------------------------------------------------
  let CATALOG = null;
  let catalogPromise = null;

  function loadCatalog() {
    if (CATALOG) return Promise.resolve(CATALOG);
    if (catalogPromise) return catalogPromise;
    catalogPromise = (async () => {
      try {
        const url = chrome.runtime.getURL("data/opening-catalog.json");
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        CATALOG = await resp.json();
        return CATALOG;
      } catch (err) {
        console.warn("[Lasker] catalog load failed:", err);
        CATALOG = { version: 0, categories: [] };
        return CATALOG;
      }
    })();
    return catalogPromise;
  }

  // -------------------------------------------------------------------------
  // Minimal SAN -> UCI converter. We only need it for the curated catalog's
  // opening moves, which are always unambiguous or use standard disambiguation.
  // Full legality checks (pins, check-evasion) are NOT performed -- any move
  // we're asked to parse has already been vetted by a human curator.
  //
  // grid:  8x8 array of piece chars ("P", "n", null, ...) as produced by
  //        board-reader. grid[rank][file] where rank 0 = rank 1.
  // turn:  "w" or "b"
  // san:   SAN string ("Nf3", "O-O", "exd5", "Nbd2", "e8=Q+", ...)
  // Returns the UCI "e2e4" style string (with optional promo suffix), or null.
  // -------------------------------------------------------------------------
  function sanToUci(grid, turn, san) {
    if (!grid || !turn || !san) return null;
    const stripped = san.replace(/[+#!?]/g, "");
    const isWhite = turn === "w";

    if (stripped === "O-O" || stripped === "0-0") {
      const r = isWhite ? 0 : 7;
      return `e${r + 1}g${r + 1}`;
    }
    if (stripped === "O-O-O" || stripped === "0-0-0") {
      const r = isWhite ? 0 : 7;
      return `e${r + 1}c${r + 1}`;
    }

    // Extract promotion piece (e.g. "=Q").
    let promo = "";
    let body = stripped;
    const promoMatch = body.match(/=([QRBN])$/);
    if (promoMatch) {
      promo = promoMatch[1].toLowerCase();
      body = body.slice(0, -2);
    }

    // Target square = last two chars.
    const target = body.slice(-2);
    if (!/^[a-h][1-8]$/.test(target)) return null;
    const tFile = target.charCodeAt(0) - 97;
    const tRank = parseInt(target[1], 10) - 1;

    body = body.slice(0, -2);
    if (body.endsWith("x")) body = body.slice(0, -1); // drop capture

    // Remaining body: optional piece letter + optional disambiguation.
    let pieceLetter = "P";
    if (body.length > 0 && /[KQRBN]/.test(body[0])) {
      pieceLetter = body[0];
      body = body.slice(1);
    }
    // Disambiguation hint (e.g. "b" in "Nbd2" or "1" in "R1a3" or "b1" in "N1c3").
    let disFile = null;
    let disRank = null;
    if (body.length >= 1) {
      const c = body[0];
      if (/[a-h]/.test(c)) disFile = c.charCodeAt(0) - 97;
      else if (/[1-8]/.test(c)) disRank = parseInt(c, 10) - 1;
    }
    if (body.length >= 2) {
      const c = body[1];
      if (/[1-8]/.test(c)) disRank = parseInt(c, 10) - 1;
    }

    const wantChar = isWhite ? pieceLetter : pieceLetter.toLowerCase();

    // Generate candidate source squares whose piece matches AND can move to
    // the target under standard (non-check-evading) rules.
    const candidates = [];
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        if (grid[r][f] !== wantChar) continue;
        if (disFile != null && f !== disFile) continue;
        if (disRank != null && r !== disRank) continue;
        if (!canMoveGeometric(grid, pieceLetter, isWhite, f, r, tFile, tRank, san.includes("x"))) continue;
        candidates.push({ f, r });
      }
    }
    if (candidates.length === 0) return null;
    // Prefer the first match. If multiple match and no disambiguation was
    // provided, prefer the one that isn't pinned (approximate: favour
    // the first candidate -- catalog curator has already picked unambiguous
    // notation for most cases).
    const src = candidates[0];
    const fromSq = `${String.fromCharCode(97 + src.f)}${src.r + 1}`;
    const toSq = `${String.fromCharCode(97 + tFile)}${tRank + 1}`;
    return `${fromSq}${toSq}${promo}`;
  }

  // Piece-specific geometric reachability. Does NOT enforce legality (pins,
  // checks), which is sufficient for visualising curated opening moves.
  function canMoveGeometric(grid, piece, isWhite, fFile, fRank, tFile, tRank, isCapture) {
    if (fFile === tFile && fRank === tRank) return false;
    const df = tFile - fFile;
    const dr = tRank - fRank;
    const target = grid[tRank][tFile];
    const targetIsFriend = target && (isWhite ? target === target.toUpperCase() : target === target.toLowerCase());
    if (targetIsFriend) return false;

    switch (piece) {
      case "P": {
        const dir = isWhite ? 1 : -1;
        const startRank = isWhite ? 1 : 6;
        if (isCapture || Math.abs(df) === 1) {
          // Capture: one diagonal.
          return df !== 0 && Math.abs(df) === 1 && dr === dir;
        }
        // Non-capture push.
        if (df !== 0) return false;
        if (dr === dir) return !target;
        if (fRank === startRank && dr === 2 * dir) {
          return !target && !grid[fRank + dir][fFile];
        }
        return false;
      }
      case "N":
        return (Math.abs(df) === 1 && Math.abs(dr) === 2) ||
               (Math.abs(df) === 2 && Math.abs(dr) === 1);
      case "B":
        if (Math.abs(df) !== Math.abs(dr)) return false;
        return pathClear(grid, fFile, fRank, tFile, tRank);
      case "R":
        if (df !== 0 && dr !== 0) return false;
        return pathClear(grid, fFile, fRank, tFile, tRank);
      case "Q":
        if (df === 0 || dr === 0 || Math.abs(df) === Math.abs(dr)) {
          return pathClear(grid, fFile, fRank, tFile, tRank);
        }
        return false;
      case "K":
        return Math.abs(df) <= 1 && Math.abs(dr) <= 1;
    }
    return false;
  }

  function pathClear(grid, fFile, fRank, tFile, tRank) {
    const sf = Math.sign(tFile - fFile);
    const sr = Math.sign(tRank - fRank);
    let f = fFile + sf;
    let r = fRank + sr;
    while (f !== tFile || r !== tRank) {
      if (grid[r][f]) return false;
      f += sf;
      r += sr;
    }
    return true;
  }

  // Apply a (validated) UCI move to an 8x8 grid, returning the new grid.
  // Used by content.js to walk an opening line and produce a sequence of
  // intermediate grids (so we can turn SAN into UCI step by step).
  function applyUci(grid, uci) {
    if (!grid || !uci || uci.length < 4) return null;
    const next = grid.map((row) => row.slice());
    const fFile = uci.charCodeAt(0) - 97;
    const fRank = parseInt(uci[1], 10) - 1;
    const tFile = uci.charCodeAt(2) - 97;
    const tRank = parseInt(uci[3], 10) - 1;
    const promo = uci.slice(4, 5);
    const piece = next[fRank][fFile];
    if (!piece) return next;
    next[fRank][fFile] = null;
    // Castling: detect by king 2-file move and also shift the rook.
    if ((piece === "K" || piece === "k") && Math.abs(tFile - fFile) === 2) {
      next[tRank][tFile] = piece;
      if (tFile === 6) {       // O-O
        next[tRank][5] = next[tRank][7];
        next[tRank][7] = null;
      } else if (tFile === 2) { // O-O-O
        next[tRank][3] = next[tRank][0];
        next[tRank][0] = null;
      }
      return next;
    }
    if (promo) {
      const isWhite = piece === piece.toUpperCase();
      next[tRank][tFile] = isWhite ? promo.toUpperCase() : promo.toLowerCase();
    } else {
      next[tRank][tFile] = piece;
    }
    return next;
  }

  // Starting-position grid (rank 0 = rank 1).
  function startingGrid() {
    return [
      ["R", "N", "B", "Q", "K", "B", "N", "R"],
      ["P", "P", "P", "P", "P", "P", "P", "P"],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      [null, null, null, null, null, null, null, null],
      ["p", "p", "p", "p", "p", "p", "p", "p"],
      ["r", "n", "b", "q", "k", "b", "n", "r"],
    ];
  }

  // Compact 64-char hash of a grid: piece char or "." per square, rank 0
  // first. Matches the scheme used by board-reader's hashGrid so live
  // positions on chess.com can be compared against precomputed study lines
  // without any extra work on the hot path.
  function gridHash(grid) {
    let h = "";
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        h += (grid[r] && grid[r][f]) || ".";
      }
    }
    return h;
  }

  // Pre-compute a ply-by-ply UCI sequence for an opening.
  //
  // Returns:
  //   {
  //     startHash,  // hash of the position BEFORE any ply (= starting pos)
  //     line: [ { ply, san, uci, turn, hash }, ... ]
  //       ply       -- 0-based index
  //       turn      -- whose turn it is WHEN THIS PLY IS PLAYED ("w" for white's 1st move)
  //       hash      -- compact hash of the grid AFTER this ply is applied
  //   }
  //
  // The controller uses `hash` to find the current position in the line by
  // lookup rather than by counting moves, which is what makes Study mode
  // takeback- and scrub-safe.
  function expandLine(sanList) {
    if (!Array.isArray(sanList)) return { startHash: gridHash(startingGrid()), line: [] };
    let grid = startingGrid();
    let turn = "w";
    const out = [];
    for (let i = 0; i < sanList.length; i++) {
      const san = sanList[i];
      const uci = sanToUci(grid, turn, san);
      if (!uci) break;
      const next = applyUci(grid, uci);
      if (!next) break;
      grid = next;
      out.push({ ply: i, san, uci, turn, hash: gridHash(grid) });
      turn = turn === "w" ? "b" : "w";
    }
    return { startHash: gridHash(startingGrid()), line: out };
  }

  window.LaskerOpeningBook = {
    lookup,
    isEarly,
    loadCatalog,
    sanToUci,
    applyUci,
    startingGrid,
    gridHash,
    expandLine,
  };
})();
