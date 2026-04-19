// Reads the move list from chess.com's DOM and exposes helpers for
// navigating the board by simulating the chess.com toolbar buttons.
//
// chess.com has shipped a few move-list widgets over the years:
//   - <wc-simple-move-list>   (current, review/analysis/bot)
//   - <vertical-move-list>    (older live-review panel)
//   - .move-list-wrapper-component / .move-list-component
// We try them in order. Each renders its plies as a nested element tree
// whose text content is the SAN -- we just collect the leaf SANs.
//
// Navigation: chess.com exposes prev/next/first/last buttons with
// recognisable aria-labels ("Move forward", "Move backward", etc.) and
// also listens on the window for ArrowLeft/ArrowRight/Home/End. We try
// the DOM buttons first and fall back to synthetic keyboard events on
// document.body.
//
// Exposes window.LaskerMoveListReader with:
//   - findMoveList()
//   - readMoves()                       -> string[] of SAN tokens (in order)
//   - goToStart() / goToEnd()
//   - goToNext() / goToPrev()
//   - goToPly(n, { poll })              -> Promise<void>
//   - detectResult()                    -> "1-0" | "0-1" | "1/2-1/2" | null

(function () {
  "use strict";

  const MOVE_LIST_SELECTORS = [
    "wc-simple-move-list",
    "vertical-move-list",
    ".move-list-wrapper-component",
    ".move-list-component",
    "[data-cy='move-list']",
  ];

  // Individual move nodes inside the list. We look for the narrowest
  // containers first and fall back to text-node sweeping if nothing
  // matches. The SAN text lives in a leaf span whose class usually
  // contains "node" or "move" and which has NO further .node / .move
  // descendants.
  const MOVE_NODE_SELECTORS = [
    ".node",
    ".move",
    ".main-line-ply",
    "[data-ply]",
  ];

  // Aria / title lookups for the four navigation buttons. The first
  // string that matches (case-insensitive, substring on aria-label or
  // title) wins. Kept liberal so chess.com A/B tests don't break us.
  const NAV_LABELS = {
    start:   ["go to start", "first move", "start of game", "jump to start"],
    back:    ["move backward", "previous move", "go back"],
    forward: ["move forward", "next move", "go forward"],
    end:     ["go to end", "last move", "end of game", "jump to end"],
  };

  function findMoveList() {
    for (const sel of MOVE_LIST_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // Collect all move-ish nodes under `root` that are LEAVES (i.e. don't
  // themselves contain nested move-ish nodes). That's where the SAN text
  // lives in every chess.com variant we've seen.
  function collectShadowRoots(el, acc) {
    if (!el) return;
    if (el.shadowRoot) {
      acc.push(el.shadowRoot);
      collectShadowRoots(el.shadowRoot, acc);
    }
    const ch = el.children;
    if (ch) {
      for (let i = 0; i < ch.length; i++) collectShadowRoots(ch[i], acc);
    }
  }

  function collectMoveNodes(root) {
    if (!root) return [];
    const seeds = [root];
    collectShadowRoots(root, seeds);
    const candidates = [];
    for (const subRoot of seeds) {
      for (const sel of MOVE_NODE_SELECTORS) {
        try {
          const found = subRoot.querySelectorAll(sel);
          if (found && found.length > 0) {
            for (const el of found) candidates.push(el);
          }
        } catch (_e) {}
      }
    }
    const dedup = [];
    const seenEl = new Set();
    for (const el of candidates) {
      if (seenEl.has(el)) continue;
      seenEl.add(el);
      dedup.push(el);
    }
    if (dedup.length === 0) return [];

    // Keep only leaves: nodes that don't contain other candidates as
    // descendants. Use a Set + contains check.
    const asSet = new Set(dedup);
    const leaves = [];
    for (const el of dedup) {
      let hasInner = false;
      for (const other of candidates) {
        if (other !== el && el.contains(other)) { hasInner = true; break; }
      }
      if (!hasInner) leaves.push(el);
    }

    // De-duplicate while preserving document order. querySelectorAll
    // already returns document order, so use a visited Set.
    const seen = new Set();
    const ordered = [];
    for (const el of leaves) {
      if (seen.has(el)) continue;
      seen.add(el);
      ordered.push(el);
    }
    return ordered;
  }

  // Clean the raw text of one move node into a pure SAN token. Strips
  // move numbers, NAG glyphs, result markers and whitespace.
  function normalizeSan(raw) {
    if (!raw) return "";
    let s = String(raw);
    s = s.replace(/\u00A0/g, " ");          // NBSP
    s = s.replace(/\u00d7/g, "x");         // '×' used as capture glyph on some UIs
    s = s.replace(/\s+/g, " ").trim();
    // Drop leading move number + punctuation, e.g. "12.", "12...", "12…".
    s = s.replace(/^\d+\s*\.\.?\.?\s*/, "");
    s = s.replace(/^\d+\s*[\u2026]\s*/, ""); // "12… Nf6"
    // Strip trailing NAGs / annotations.
    s = s.replace(/[!?]+$/, "");
    // Strip trailing result markers.
    if (/^(1-0|0-1|1\/2-1\/2|\u00BD-\u00BD)$/.test(s)) return "";
    return s.trim();
  }

  // Leaf nodes sometimes contain only "xd5" while the parent row still has full
  // text ("exd5", "Bxd5"). Replay fails if we keep the truncated token.
  function enrichSanFromAncestors(node, leafSan) {
    if (!node || !leafSan) return leafSan;
    if (!/^x[a-h][1-8]$/i.test(leafSan)) return leafSan;
    const targetSq = leafSan.slice(-2);
    let best = leafSan;
    for (let el = node.parentElement, depth = 0; el && depth < 8; el = el.parentElement, depth++) {
      const chunks = [];
      const tc = el.textContent || "";
      const it = el.innerText || "";
      if (tc) chunks.push(tc);
      if (it && it !== tc) chunks.push(it);
      for (const chunk of chunks) {
        const t = normalizeSan(chunk);
        if (!t || !looksLikeSan(t)) continue;
        if (/^x[a-h][1-8]$/i.test(t)) continue;
        if (!t.endsWith(targetSq)) continue;
        if (t.length > best.length) best = t;
      }
    }
    return best;
  }

  function looksLikeSan(s) {
    if (!s) return false;
    // Castles.
    if (s === "O-O" || s === "O-O-O" || s === "0-0" || s === "0-0-0") return true;
    // Anything else must end with a square (a1..h8), optionally
    // with a check/mate suffix (stripped upstream) or a promotion =Q/R/B/N.
    return /^([KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](=[QRBN])?)$/.test(s);
  }

  function rawFromMoveNode(node) {
    if (!node) return "";
    try {
      const direct = node.getAttribute && node.getAttribute("data-san");
      if (direct) {
        const nd = normalizeSan(direct);
        if (nd && looksLikeSan(nd)) return direct.trim();
      }
      const host = node.closest && node.closest("[data-san]");
      if (host && host !== node) {
        const ds = host.getAttribute("data-san");
        if (ds) {
          const nd = normalizeSan(ds);
          if (nd && looksLikeSan(nd)) return ds.trim();
        }
      }
    } catch (_e) {}
    return (node.innerText || node.textContent || "").trim();
  }

  function readMovesFromListAggregate(list) {
    const text = list.innerText || list.textContent || "";
    const tokens = [];
    const re =
      /\b(O-O-O|O-O|0-0-0|0-0|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?)\b/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const t = normalizeSan(m[1]);
      if (!t || !looksLikeSan(t)) continue;
      tokens.push(t);
    }
    return tokens;
  }

  function mergeBareCaptureFromAggregate(sans, agg) {
    if (!sans.length || agg.length !== sans.length) return sans;
    for (let i = 0; i < sans.length; i++) {
      if (!/^x[a-h][1-8]$/i.test(sans[i])) continue;
      const a = agg[i];
      if (!a || a === sans[i]) continue;
      if (/^x[a-h][1-8]$/i.test(a)) continue;
      const sq = sans[i].slice(-2);
      if (a.endsWith(sq)) sans[i] = a;
    }
    return sans;
  }

  function readMoves() {
    const list = findMoveList();
    if (!list) return [];
    const nodes = collectMoveNodes(list);
    const agg = readMovesFromListAggregate(list);
    const sans = [];
    for (const node of nodes) {
      let raw = rawFromMoveNode(node);
      const prev = node.previousElementSibling;
      if (prev) {
        const pt = (prev.textContent || "").trim();
        if (/^[NBRQK]$/i.test(pt) || /^[\u2654-\u265f]$/u.test(pt)) {
          raw = pt + raw;
        }
      }
      let san = normalizeSan(raw);
      san = enrichSanFromAncestors(node, san);
      if (!san) continue;
      if (!looksLikeSan(san)) continue;
      sans.push(san);
    }
    return mergeBareCaptureFromAggregate(sans, agg);
  }

  // Find a chess.com nav button by aria-label / title / data attrs.
  // `kind` in NAV_LABELS keys.
  function findNavButton(kind) {
    const needles = NAV_LABELS[kind] || [];
    const buttons = document.querySelectorAll(
      "button, [role='button'], .nav-icon-component, [aria-label], [title]"
    );
    for (const b of buttons) {
      const aria = (b.getAttribute("aria-label") || "").toLowerCase();
      const title = (b.getAttribute("title") || "").toLowerCase();
      const hay = `${aria} ${title}`;
      for (const n of needles) {
        if (hay.includes(n)) return b;
      }
    }
    return null;
  }

  // Dispatch a synthetic keyboard event. chess.com's move-nav handler
  // listens on `window` / `document` for these, so targeting `document`
  // is usually enough.
  function pressKey(key) {
    const opts = { key, code: keyCode(key), bubbles: true, cancelable: true };
    try {
      document.dispatchEvent(new KeyboardEvent("keydown", opts));
      document.dispatchEvent(new KeyboardEvent("keyup", opts));
    } catch (_err) { /* no-op */ }
  }
  function keyCode(key) {
    switch (key) {
      case "ArrowLeft":  return "ArrowLeft";
      case "ArrowRight": return "ArrowRight";
      case "Home":       return "Home";
      case "End":        return "End";
      default:           return key;
    }
  }

  function clickOrKey(kind, fallbackKey) {
    const btn = findNavButton(kind);
    if (btn) {
      try { btn.click(); return true; } catch (_err) {}
    }
    if (fallbackKey) pressKey(fallbackKey);
    return !!btn;
  }

  function goToStart()   { return clickOrKey("start",   "Home"); }
  function goToEnd()     { return clickOrKey("end",     "End"); }
  function goToNext()    { return clickOrKey("forward", "ArrowRight"); }
  function goToPrev()    { return clickOrKey("back",    "ArrowLeft"); }

  // Step the board to ply `n` (0 = starting position, 1 = after white's
  // 1st move, ...). This is best-effort: we click start, then click
  // forward n times with a small await between each, giving chess.com's
  // own animation / hash-change a chance to settle. Consumers should
  // treat the board-poll loop as the source of truth for "did it land".
  async function goToPly(n, opts) {
    const step = (opts && opts.stepMs) || 60;
    goToStart();
    await sleep(step);
    for (let i = 0; i < n; i++) {
      goToNext();
      await sleep(step);
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Scrape the result pill chess.com shows above or beside the move
  // list once a game has finished. We look for the standard result
  // strings inside the game-over modal, the result banner, or the
  // scoring footer row -- whichever comes first.
  function detectResult() {
    // 1) Explicit result markers directly embedded in the move list.
    const list = findMoveList();
    if (list) {
      const raw = (list.textContent || "").replace(/\s+/g, " ");
      const m = raw.match(/(1-0|0-1|1\/2-1\/2|\u00BD-\u00BD)\b/);
      if (m) return normalizeResult(m[1]);
    }
    // 2) Game-over modal / header.
    const bannerSelectors = [
      ".game-over-header-component",
      ".game-over-modal-component",
      ".header-result",
      "[data-cy='game-over-header']",
    ];
    for (const sel of bannerSelectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const t = (el.textContent || "").toLowerCase();
      if (t.includes("white won") || t.includes("white wins")) return "1-0";
      if (t.includes("black won") || t.includes("black wins")) return "0-1";
      if (t.includes("draw") || t.includes("stalemate")) return "1/2-1/2";
    }
    return null;
  }
  function normalizeResult(s) {
    if (s === "\u00BD-\u00BD") return "1/2-1/2";
    return s;
  }

  // Best-effort "who are you" hint. chess.com puts a `.flipped` class
  // on <wc-chess-board> when the viewer is black. We prefer the live
  // board-reader's `flipped` flag if available but expose this here so
  // the idle card can say "You played BLACK" without re-reading the
  // board.
  function detectPlayerColor() {
    if (window.LaskerBoardReader) {
      const pos = window.LaskerBoardReader.readPosition();
      if (pos) return pos.flipped ? "b" : "w";
    }
    const board = document.querySelector("wc-chess-board, chess-board");
    if (board && board.classList.contains("flipped")) return "b";
    return "w";
  }

  window.LaskerMoveListReader = {
    findMoveList,
    readMoves,
    findNavButton,
    goToStart,
    goToEnd,
    goToNext,
    goToPrev,
    goToPly,
    detectResult,
    detectPlayerColor,
  };
})();
