// Lasker fair-play classifier.
//
// Lasker is a learning / post-game analysis tool. Using an engine during any
// rated chess.com game violates the Fair Play policy, so this module is the
// one and only place where we decide whether it is ethically permissible for
// the rest of the extension to do anything at all.
//
// Policy (strictest interpretation):
//
//   SAFE (engine + theory both allowed):
//     /analysis ...                Analysis board
//     /play/computer*, /play/bot*  Unrated bot games
//     /lessons ...                 Chess.com lessons
//     /game/live/* OR /game/daily/*  ONLY when the "game over" markers are
//                                  present in the DOM -- i.e. the game is
//                                  finished and the user is reviewing it.
//
//   UNSAFE (engine AND opening theory both disabled):
//     everything else -- including live games in progress, daily games in
//     progress (we do NOT use the "books allowed in daily" carve-out; cleanest
//     story is "Lasker stays off during any game in progress"), puzzle
//     attempts, the home page, and any unknown route.
//
// There is intentionally no escape hatch. If the classifier says "unsafe", the
// extension refuses to run even if the user clicks the enable toggle.
//
// Exposes:
//   window.LaskerFairPlay.classify() -> { kind, label, path, safe, engineAllowed, bookAllowed }
//   window.LaskerFairPlay.subscribe(cb) -> unsubscribe
//     cb fires immediately with the current classification, then again any
//     time SPA navigation or a DOM change flips the result.
//   window.LaskerFairPlay.POLICY_URL -> canonical chess.com fair-play URL

(function () {
  "use strict";

  const POLICY_URL =
    "https://support.chess.com/en/articles/8568003-what-is-chess-com-s-fair-play-policy";

  const KIND_META = {
    analysis: {
      label: "Analysis board",
      safe: true,
      engineAllowed: true,
      bookAllowed: true,
    },
    review: {
      label: "Finished-game review",
      safe: true,
      engineAllowed: true,
      bookAllowed: true,
    },
    bot: {
      label: "Bot game (unrated)",
      safe: true,
      engineAllowed: true,
      bookAllowed: true,
    },
    lesson: {
      label: "Lesson",
      safe: true,
      engineAllowed: true,
      bookAllowed: true,
    },
    "live-in-progress": {
      label: "Live game in progress",
      safe: false,
      engineAllowed: false,
      bookAllowed: false,
    },
    "daily-in-progress": {
      label: "Daily game in progress",
      safe: false,
      engineAllowed: false,
      bookAllowed: false,
    },
    "puzzle-attempt": {
      label: "Puzzle (solve on your own)",
      safe: false,
      engineAllowed: false,
      bookAllowed: false,
    },
    other: {
      label: "Unsupported page",
      safe: false,
      engineAllowed: false,
      bookAllowed: false,
    },
  };

  // DOM markers chess.com renders once a game has ended -- the game-over
  // modal, the review-game card, the result banner, etc. We check a basket
  // because chess.com's class names shift between layouts.
  const GAME_OVER_SELECTORS = [
    ".game-over-modal-content",
    ".game-over-header-component",
    ".game-review-buttons-component",
    ".game-result",
    "[data-cy='game-over-modal']",
    ".board-modal-header-component",
    ".live-game-over-message",
    // chess.com refreshes layouts often — cast a slightly wider net.
    "[data-cy='game-result']",
    "[class*='game-over-modal']",
    "[class*='GameOverModal']",
  ];

  function gameIsOver() {
    for (const sel of GAME_OVER_SELECTORS) {
      try {
        if (document.querySelector(sel)) return true;
      } catch (_e) { /* invalid selector in older browsers — skip */ }
    }
    // Fallback: finished games usually print the result inside the move list.
    const ml = document.querySelector(
      "wc-simple-move-list, vertical-move-list, .move-list-wrapper-component, .move-list-component, [data-cy='move-list']"
    );
    if (ml) {
      const t = (ml.textContent || "").replace(/\s+/g, " ");
      if (/\b(1-0|0-1|1\/2-1\/2)\b/.test(t)) return true;
      if (/\u00BD-\u00BD/.test(t)) return true;
    }
    return false;
  }

  function classifyPath(path) {
    if (path.startsWith("/analysis")) return "analysis";
    if (path.startsWith("/play/computer") || path.startsWith("/play/bot")) return "bot";
    if (path.startsWith("/lessons")) return "lesson";
    if (path.startsWith("/puzzles")) return "puzzle-attempt";

    if (path.startsWith("/game/live/")) {
      return gameIsOver() ? "review" : "live-in-progress";
    }
    if (path.startsWith("/game/daily/")) {
      return gameIsOver() ? "review" : "daily-in-progress";
    }
    // chess.com also uses /live/<id> for spectating/playing live games and
    // /play/* for matchmaking. Both are "in progress" unless clearly finished.
    if (path.startsWith("/live")) {
      return gameIsOver() ? "review" : "live-in-progress";
    }
    if (path.startsWith("/play")) {
      return "live-in-progress";
    }
    if (path.startsWith("/daily")) {
      return gameIsOver() ? "review" : "daily-in-progress";
    }

    return "other";
  }

  function classify() {
    const path = window.location.pathname || "/";
    const kind = classifyPath(path);
    const meta = KIND_META[kind] || KIND_META.other;
    return { kind, path, ...meta };
  }

  // -------------------------------------------------------------------------
  // Subscription: callers get re-notified whenever the classification might
  // have changed. We listen to popstate/hashchange, patch history.pushState/
  // replaceState for SPA navigation, and watch the whole DOM for the
  // game-over markers appearing / disappearing.
  // -------------------------------------------------------------------------

  const subs = new Set();
  let lastSig = null;

  function signatureOf(c) {
    return `${c.kind}|${c.path}`;
  }

  function notify() {
    const c = classify();
    const sig = signatureOf(c);
    if (sig === lastSig) return;
    lastSig = sig;
    for (const cb of subs) {
      try { cb(c); } catch (_err) { /* subscriber error, ignore */ }
    }
  }

  function subscribe(cb) {
    subs.add(cb);
    try { cb(classify()); } catch (_err) {}
    return () => { subs.delete(cb); };
  }

  // History patch -- one-time, idempotent guarded by a flag on history.
  (function patchHistory() {
    if (history.__laskerPatched) return;
    history.__laskerPatched = true;
    const _push = history.pushState;
    const _replace = history.replaceState;
    history.pushState = function () {
      const ret = _push.apply(this, arguments);
      setTimeout(notify, 0);
      return ret;
    };
    history.replaceState = function () {
      const ret = _replace.apply(this, arguments);
      setTimeout(notify, 0);
      return ret;
    };
  })();

  window.addEventListener("popstate", notify);
  window.addEventListener("hashchange", notify);

  // Debounced DOM observer so we don't re-classify every keystroke.
  let moTimer = null;
  const mo = new MutationObserver(() => {
    if (moTimer) return;
    moTimer = setTimeout(() => { moTimer = null; notify(); }, 300);
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // Prime the cache so the first subscriber gets "current" immediately.
  lastSig = signatureOf(classify());

  window.LaskerFairPlay = { classify, subscribe, POLICY_URL };
})();
