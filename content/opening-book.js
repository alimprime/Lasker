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

  window.LaskerOpeningBook = { lookup, isEarly };
})();
