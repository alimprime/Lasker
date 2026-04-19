// Opening theory lookup proxied through the background service worker.
//
// Content scripts run in the chess.com origin, which Lichess sometimes 401s.
// The background service worker runs in the extension origin and holds the
// `https://explorer.lichess.ovh/*` host permission, so it can fetch freely.
//
// Exposes window.ChessMateOpeningBook with:
//   - lookup(fen) -> Promise<{ name, eco, moves } | null>
//   - isEarly(plyCount) -> true for the first ~24 plies

(function () {
  "use strict";

  const cache = new Map();
  const MAX_CACHE = 256;

  function sendMessage(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (response) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(response || null);
        });
      } catch (_err) {
        resolve(null);
      }
    });
  }

  async function lookup(fen) {
    if (!fen) return null;
    if (cache.has(fen)) return cache.get(fen);

    const response = await sendMessage({ type: "chessmate:opening", fen });
    if (!response || !response.ok || !response.data) {
      setCache(fen, null);
      return null;
    }
    const data = response.data;
    if (!Array.isArray(data.moves) || data.moves.length === 0) {
      setCache(fen, null);
      return null;
    }

    const moves = data.moves.map((m) => {
      const total = (m.white || 0) + (m.black || 0) + (m.draws || 0);
      return {
        san: m.san,
        uci: m.uci,
        total,
        winRate: total > 0 ? (m.white || 0) / total : 0,
        drawRate: total > 0 ? (m.draws || 0) / total : 0,
      };
    });

    const result = {
      name: data.opening ? data.opening.name : null,
      eco: data.opening ? data.opening.eco : null,
      moves,
    };
    setCache(fen, result);
    return result;
  }

  function setCache(key, value) {
    if (cache.size >= MAX_CACHE) {
      const firstKey = cache.keys().next().value;
      cache.delete(firstKey);
    }
    cache.set(key, value);
  }

  function isEarly(plyCount) {
    return plyCount >= 0 && plyCount <= 24;
  }

  window.ChessMateOpeningBook = { lookup, isEarly };
})();
