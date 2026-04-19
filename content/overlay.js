// Lasker on-page overlay.
//
// Floating panel attached to document.body with its own Shadow DOM so
// chess.com's CSS cannot leak in or out.
//
// Exposes window.LaskerOverlay with:
//   mount(handlers)
//   setEnabled(bool)
//   setStatus(text)
//   setAssessment({label, severity})
//   setLastMove({headline, label, badge, severity, detail, bestSan, bestLineNote, missedText})
//   setMistakeLesson({why, better, next, tour?: {index, total}} | null)
//   setOpening({name, eco, moves, fen})
//   setEngineHint({text, source})
//   setPrinciples({king, development, centre}) -- "safe"|"home"|"exposed", "good"|"partial"|"none", "good"|"weak"
//   pushTimelineMove({ply, severity, label, color})
//   resetTimeline()
//   setContext({kind, label, safe, policyUrl}) -- fair-play lock indicator
//   setCollapsed(bool)                           -- pill (float) / drawer-closed (right/bottom)
//   showFairPlayModal(onAccept)                  -- first-run gate
//   setEvaluation({scoreCp, scoreMate, depth, lines, turn, playerColor})
//   setDepth(n)
//   setTheme("dark"|"light")
//   setSize("small"|"medium"|"large")
//   setMode("focus"|"advanced")                  -- hide/show engine lines + full eval panel
//   setAdvisor("my-side"|"both-sides")           -- affects what the controller feeds us
//   setWidth(px | null)                          -- custom drawer width; null = use S/M/L preset
//   setEngineThinking(bool)                      -- drives the edge-tab state dot
//   clearAnalysis()
//   setArrows(bool)                              -- 0.8: arrows-toggle (settings)
//   setCatalog(catalog)                          -- 0.8: hand-curated library data
//   setStudy(study | null)                       -- 0.8: directive Study-mode card
//   clearStudy()                                 -- 0.8: hide Study card
//   setSurface("analyze"|"learn")                -- 0.9: segmented surfaces
//   setOpeningPill({name, eco, id?})             -- 0.9: slim analyze-mode pill
//   setSummary({counts,total,accuracy,scope})    -- 0.10: session summary card
//
// 0.7.0 note: the dock is always a right-side drawer. Float/bottom were
// removed to focus the surface area. Use setWidth to override S/M/L.
// 0.8.0 note: Library button in the header, Study-mode card above Opening
// theory, animated SVG arrows on the real board (via content/board-arrows.js).
// 0.10.0 note: rebranded to LASKER (all-caps), swapped Inter -> Space Grotesk,
// arrows are strictly for the student's side, last-move card shows the
// engine's preferred move + missed eval, and a session summary (accuracy
// % + per-severity chips) sits below the engine lines on Analyze.

(function () {
  "use strict";

  // 0.7.1: size tiers shift up one step. The old "medium" (420 px) was
  // the most common request, so the new S matches the old L and every
  // tier gains ~120 px of breathing room.
  const SIZE_WIDTHS = { small: 600, medium: 720, large: 840 };
  const SIZE_FS = { small: 15, medium: 17, large: 19 };
  const MIN_WIDTH = 420;
  const MAX_WIDTH_CAP = 960;

  function escapeHtml(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // 0.8.0: font + icon sizing refactor.
  //
  // Inter is bundled in /fonts (WOFF2) so the UI doesn't fall through to the
  // OS default when Avenir Next / system-ui isn't present. We declare four
  // weights and reference them via chrome.runtime.getURL at mount-time (the
  // CSS is built as a function so the URL can be substituted).
  //
  // Icon sizes are expressed as CSS custom properties (--ic-*) so they scale
  // with the S/M/L preset via _applySizeVars.
  function buildBaseStyle(urls) {
    // 0.10.0: switched the bundled typeface from Inter to Space Grotesk.
    // Space Grotesk has tighter geometry, more distinctive rounds, and
    // reads as a "tool" font rather than a generic UI sans -- which
    // matches LASKER's coach-y tone better. Falls back to the old Inter
    // files (still bundled at runtime via the web_accessible_resources
    // list) and finally system-ui if nothing loads.
    const fontUrl = (w) => urls && urls[w] ? `url("${urls[w]}") format("woff2")` : "local('Space Grotesk')";
    return `
    @font-face {
      font-family: "LaskerSans";
      font-weight: 400;
      font-style: normal;
      font-display: block;
      src: ${fontUrl("regular")};
    }
    @font-face {
      font-family: "LaskerSans";
      font-weight: 500;
      font-style: normal;
      font-display: block;
      src: ${fontUrl("medium")};
    }
    @font-face {
      font-family: "LaskerSans";
      font-weight: 600;
      font-style: normal;
      font-display: block;
      src: ${fontUrl("semibold")};
    }
    @font-face {
      font-family: "LaskerSans";
      font-weight: 700;
      font-style: normal;
      font-display: block;
      src: ${fontUrl("bold")};
    }
    :host {
      all: initial;
      font-family: "LaskerSans", "Space Grotesk", "Inter", "Inter var",
        -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue",
        Arial, sans-serif;
      letter-spacing: -0.006em;
      --fs-display: 17px;
      --fs-body: 15px;
      --fs-caption: 12px;
      --fs: 15px; /* legacy alias -- all pre-0.6 rules use this */
      --ic-sm: 16px;
      --ic-md: 22px;
      --ic-lg: 30px;
      --ic-xl: 44px;
    }
    .root {
      position: fixed;
      background: var(--bg);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 10px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      font-size: var(--fs-body);
      z-index: 2147483000;
      user-select: none;
      overflow: hidden;
      transition: transform 0.22s ease-out;
    }
    /* Right-side drawer: full-height slab pinned to the right edge.
       Right-only is the ONE dock mode as of 0.7.0.
       0.9.1: --drawer-bottom-gap reserves a strip at the bottom of the
       viewport so chess.com's move-nav / prev-next controls remain
       clickable. Both the drawer and the edge tab respect it. */
    .root {
      --drawer-bottom-gap: 140px;
      top: 0;
      right: 0;
      height: calc(100vh - var(--drawer-bottom-gap));
      border-radius: 10px 0 0 10px;
      border-right: none;
      border-bottom: 1px solid var(--border);
      display: flex;
      flex-direction: column;
    }
    .root.drawer-closed {
      transform: translateX(100%);
    }
    .body-scroll {
      flex: 1 1 auto;
      overflow-y: auto;
      overflow-x: hidden;
    }
    /* Left-edge grabber that resizes the drawer width. */
    .resize-handle {
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 6px;
      cursor: col-resize;
      background: transparent;
      transition: background 0.15s;
      z-index: 1;
    }
    .resize-handle:hover,
    .resize-handle.dragging {
      background: var(--accent);
      opacity: 0.5;
    }
    /* Edge tab (0.7.1 redesign): accent-green slab pinned near the top
       right so it's impossible to miss when the drawer is collapsed. */
    .edge-tab {
      position: fixed;
      z-index: 2147483000;
      top: 120px;
      right: 0;
      width: 56px;
      height: 200px;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 14px 0 0 14px;
      cursor: pointer;
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      padding: 12px 0;
      font-family: inherit;
      font-weight: 700;
      box-shadow:
        -6px 6px 20px rgba(0, 0, 0, 0.38),
        0 0 0 0 rgba(62, 169, 102, 0.55);
      transition: transform 0.18s ease, box-shadow 0.18s ease;
      animation: et-breathe 2.6s ease-in-out infinite;
    }
    .edge-tab.show { display: flex; }
    .edge-tab:hover {
      transform: translateX(-4px) scale(1.04);
      box-shadow:
        -10px 6px 26px rgba(0, 0, 0, 0.45),
        0 0 0 6px rgba(62, 169, 102, 0.25);
    }
    .edge-tab:active { transform: translateX(-2px) scale(1.02); }
    .edge-tab .et-chevron {
      font-size: calc(var(--fs-display) + 10px);
      color: #fff;
      line-height: 1;
      font-weight: 900;
    }
    .edge-tab .et-mono {
      font-size: calc(var(--fs-display) + 8px);
      line-height: 1;
      color: #fff;
    }
    .edge-tab .et-label {
      writing-mode: vertical-rl;
      transform: rotate(180deg);
      font-size: var(--fs-caption);
      font-weight: 800;
      letter-spacing: 4px;
      color: rgba(255, 255, 255, 0.96);
      text-transform: uppercase;
      margin-top: 4px;
    }
    .edge-tab .et-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.4);
      border: 1px solid rgba(255, 255, 255, 0.7);
    }
    .edge-tab .et-dot.on {
      background: #fff;
      border-color: #fff;
    }
    .edge-tab .et-dot.thinking {
      background: #fff;
      border-color: #fff;
      animation: et-pulse 1.2s ease-in-out infinite;
    }
    /* Extra 3-pulse burst when the drawer is first closed, on top of the
       always-on gentle breathe. */
    .edge-tab.attention {
      animation:
        et-breathe 2.6s ease-in-out infinite,
        et-attention 0.8s ease-in-out 3;
    }
    @keyframes et-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    @keyframes et-breathe {
      0%, 100% {
        box-shadow:
          -6px 6px 20px rgba(0, 0, 0, 0.38),
          0 0 0 0 rgba(62, 169, 102, 0.55);
      }
      50% {
        box-shadow:
          -6px 6px 20px rgba(0, 0, 0, 0.38),
          -2px 0 28px 10px rgba(62, 169, 102, 0.35);
      }
    }
    @keyframes et-attention {
      0%, 100% { transform: none; }
      50%      { transform: translateX(-8px); }
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      padding: 10px 12px;
      background: var(--bg-2);
      cursor: move;
    }
    /* 0.10.0: LASKER brand -- all-caps, tracked wider, a touch bigger
       than body text. Gives the header an editorial / tool feel. */
    .title {
      font-weight: 700;
      letter-spacing: 0.18em;
      font-size: calc(var(--fs) + 1px);
      text-transform: uppercase;
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 1;
      min-width: 0;
    }
    .dot {
      display: inline-block;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--muted);
      flex-shrink: 0;
    }
    .dot.on { background: var(--accent); }
    .icon-btn {
      background: transparent;
      border: none;
      color: var(--muted);
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: calc(var(--fs) + 2px);
      line-height: 1;
      flex-shrink: 0;
    }
    .icon-btn:hover { color: var(--fg); background: var(--hover); }
    /* 0.9.1: clean-state button flashes accent + spins its glyph when clicked
       so the user sees feedback for what is otherwise an invisible action. */
    .reset-btn .reset-glyph,
    .reset-btn {
      transition: color 0.15s;
    }
    .reset-btn.just-clicked {
      color: var(--accent);
      animation: reset-spin 0.55s ease-out;
    }
    @keyframes reset-spin {
      from { transform: rotate(0deg); }
      to   { transform: rotate(-360deg); }
    }
    .toggle {
      appearance: none;
      width: 38px;
      height: 22px;
      background: var(--track);
      border-radius: 999px;
      position: relative;
      cursor: pointer;
      outline: none;
      border: none;
      transition: background 0.15s;
      flex-shrink: 0;
    }
    .toggle::after {
      content: "";
      position: absolute;
      top: 2px;
      left: 2px;
      width: 18px;
      height: 18px;
      background: #fff;
      border-radius: 50%;
      transition: left 0.15s;
    }
    .toggle.on { background: var(--accent); }
    .toggle.on::after { left: 18px; }
    .body {
      display: flex;
      padding: 12px;
      gap: 12px;
    }
    .bar-wrap {
      width: 20px;
      background: var(--white-sq);
      border: 1px solid var(--border);
      border-radius: 4px;
      overflow: hidden;
      position: relative;
      flex-shrink: 0;
      height: var(--bar-h);
      align-self: stretch;
    }
    /* Default orientation: white at bottom (flipped white rule for board). */
    .bar-fill {
      position: absolute;
      left: 0;
      right: 0;
      top: 0;
      background: var(--black-sq);
      transition: height 0.25s ease;
      height: 50%;
    }
    /* Player=Black: flip vertically so black is at the bottom. */
    .bar-wrap.black-bottom {
      transform: scaleY(-1);
    }
    .bar-midline {
      position: absolute;
      left: -2px;
      right: -2px;
      top: 50%;
      height: 1px;
      background: var(--accent);
      opacity: 0.5;
      pointer-events: none;
    }
    .info {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }
    .score {
      font-size: calc(var(--fs) + 11px);
      font-weight: 700;
      font-variant-numeric: tabular-nums;
      line-height: 1.15;
    }
    .score.neutral { color: var(--muted); }
    .status {
      color: var(--muted);
      font-size: calc(var(--fs) - 2px);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .side-caption {
      color: var(--muted);
      font-size: calc(var(--fs) - 3px);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-top: 4px;
    }
    .side-caption .pov-pill {
      display: inline-block;
      padding: 1px 6px;
      margin-left: 4px;
      border-radius: 3px;
      background: var(--hover);
      color: var(--fg);
      font-weight: 700;
      letter-spacing: 0.8px;
    }

    .assessment {
      font-size: calc(var(--fs));
      font-weight: 600;
      padding: 8px 12px;
      border-top: 1px solid var(--border);
      background: var(--bg-3);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .assessment .sev-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .assessment.hidden, .last-move.hidden, .opening.hidden, .player-tip.hidden, .engine-hint.hidden { display: none; }

    .last-move {
      font-size: calc(var(--fs));
      padding: 8px 12px;
      border-top: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 4px;
      position: relative;
    }
    .last-move .lm-head {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .last-move .lm-headline {
      flex: 1 1 auto;
      font-weight: 700;
      line-height: 1.35;
      font-size: calc(var(--fs) - 1px);
    }
    .last-move .lm-best-note {
      font-size: calc(var(--fs-caption) - 1px);
      color: var(--muted);
      line-height: 1.35;
      padding-left: 2px;
      display: none;
    }
    .last-move .lm-best-note.visible { display: block; }
    .last-move .badge {
      font-weight: 800;
      font-family: "SF Mono", Menlo, Consolas, monospace;
      margin-left: -2px;
    }
    /* 0.10.0: secondary row under the last-move label -- shows the
       engine's preferred move and the swing the student missed.
       Hidden by .hidden when the move was already best or in book. */
    .last-move .lm-best {
      display: flex;
      align-items: baseline;
      gap: 6px;
      font-size: calc(var(--fs) - 2px);
      color: var(--muted);
      padding-left: 2px;
    }
    .last-move .lm-best.hidden { display: none; }
    .last-move .lm-best .lm-best-label {
      text-transform: uppercase;
      letter-spacing: 0.06em;
      font-weight: 600;
      font-size: calc(var(--fs) - 4px);
      color: var(--muted);
    }
    .last-move .lm-best .lm-best-san {
      font-weight: 700;
      color: var(--accent);
      font-family: "SF Mono", Menlo, Consolas, monospace;
    }
    .last-move .lm-best .lm-best-miss {
      font-family: "SF Mono", Menlo, Consolas, monospace;
      color: var(--muted);
    }
    .last-move .clarify {
      margin-left: auto;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--muted);
      width: 20px;
      height: 20px;
      line-height: 18px;
      padding: 0;
      text-align: center;
      border-radius: 50%;
      cursor: pointer;
      font-weight: 700;
      font-size: calc(var(--fs) - 2px);
    }
    .last-move .clarify:hover { color: var(--fg); border-color: var(--accent); }
    .last-move .detail {
      display: none;
      position: absolute;
      right: 12px;
      top: calc(100% - 2px);
      background: var(--bg-2);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 8px 10px;
      font-size: calc(var(--fs) - 2px);
      box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
      z-index: 10;
      max-width: 260px;
      white-space: normal;
      line-height: 1.35;
    }
    .last-move.show-detail .detail { display: block; }

    .sev-brilliant   { color: #26d0ad; }
    .sev-great       { color: #4ac26b; }
    .sev-best        { color: #4ac26b; }
    .sev-good        { color: #7ac074; }
    .sev-book        { color: #8aa4d8; }
    .sev-neutral     { color: var(--muted); }
    .sev-inaccuracy  { color: #e0b441; }
    .sev-mistake     { color: #e08541; }
    .sev-blunder     { color: #e04141; }
    .sev-brilliant .sev-dot  { background: #26d0ad; }
    .sev-great .sev-dot      { background: #4ac26b; }
    .sev-good .sev-dot       { background: #7ac074; }
    .sev-neutral .sev-dot    { background: var(--muted); }

    /* Opening theory card (0.7.0): peer status with the Insight bubble
       instead of a demoted plain strip under it. */
    .opening {
      margin: 8px 12px 4px;
      padding: 12px 14px 12px 14px;
      border-radius: 12px;
      background: var(--bg-2);
      border: 1px solid var(--border);
      border-left: 3px solid var(--accent);
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .opening .title-row {
      display: flex;
      align-items: baseline;
      gap: 6px;
    }
    .opening .op-name {
      font-weight: 700;
      font-size: var(--fs-display);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
      flex: 1;
    }
    .opening .op-eco {
      font-size: calc(var(--fs) - 3px);
      font-family: "SF Mono", Menlo, Consolas, monospace;
      color: var(--muted);
      background: var(--hover);
      padding: 1px 5px;
      border-radius: 3px;
      flex-shrink: 0;
    }
    .opening .op-caption {
      font-size: var(--fs-caption);
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.6px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .opening .op-caption::before {
      content: "\\265E"; /* Black chess knight glyph as a theory marker */
      font-size: calc(var(--fs-body) + 2px);
      color: var(--accent);
    }
    .opening .op-moves {
      display: flex;
      flex-direction: row;
      flex-wrap: wrap;
      gap: 6px;
      max-height: 220px;
      overflow-y: auto;
    }
    .opening .op-row {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 9px 5px 6px;
      border-radius: 999px;
      background: var(--bg-3);
      border: 1px solid var(--border);
      transition: background 0.15s, border-color 0.15s;
      cursor: default;
    }
    .opening .op-row:hover {
      background: var(--hover);
      border-color: var(--accent);
    }
    .opening .op-san {
      font-family: "SF Mono", Menlo, Consolas, monospace;
      font-size: var(--fs-caption);
      background: var(--accent);
      color: #fff;
      padding: 2px 7px;
      border-radius: 10px;
      font-weight: 700;
      min-width: 36px;
      text-align: center;
      flex-shrink: 0;
    }
    .opening .op-child-name {
      font-size: var(--fs-caption);
      color: var(--fg);
      font-weight: 600;
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      min-width: 0;
    }
    .opening .op-child-eco {
      font-size: var(--fs-caption);
      font-family: "SF Mono", Menlo, Consolas, monospace;
      color: var(--muted);
      flex-shrink: 0;
    }
    .opening .op-child-name:empty,
    .opening .op-child-eco:empty { display: none; }
    /* The "No named continuations" empty state needs to render full-width
       rather than as a chip, so override the flex wrap behaviour. */
    .opening .op-moves > .op-empty {
      flex: 1 0 100%;
      font-style: italic;
      color: var(--muted);
      font-size: var(--fs-caption);
      padding: 4px 0;
    }
    .opening .op-resources-caption {
      font-size: var(--fs-caption);
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.4px;
      margin-top: 2px;
    }
    /* When the "More resources" links block is empty, the label above it
       should disappear too. */
    .opening:has(.op-links.hidden) .op-resources-caption { display: none; }
    .opening .op-links {
      display: flex;
      gap: 10px;
      flex-wrap: wrap;
      font-size: calc(var(--fs) - 3px);
      margin-top: 2px;
    }
    .opening .op-links a {
      color: var(--accent);
      text-decoration: none;
      border-bottom: 1px dotted var(--accent);
    }
    .opening .op-links a:hover { opacity: 0.8; }
    .opening .op-links.hidden { display: none; }

    .engine-hint {
      padding: 10px 12px;
      border-top: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 4px;
      background: var(--bg-3);
    }
    .engine-hint .eh-sub {
      font-size: calc(var(--fs-caption) - 1px);
      color: var(--muted);
      line-height: 1.4;
      margin: 0 0 8px 0;
      max-width: 34em;
    }
    .mistake-list .ml-intro {
      font-size: calc(var(--fs-caption) - 1px);
      color: var(--muted);
      line-height: 1.4;
      margin: -4px 0 6px 0;
      max-width: 36em;
    }
    .mistake-list .ml-tour {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--bg-3);
      font-size: calc(var(--fs-caption));
      font-weight: 600;
    }
    .mistake-list .ml-tour.hidden { display: none; }
    .mistake-list .ml-tour-text {
      color: var(--fg);
      font-variant-numeric: tabular-nums;
    }
    .mistake-list .ml-tour-btns {
      display: flex;
      gap: 6px;
    }
    .mistake-list .ml-tour-prev,
    .mistake-list .ml-tour-next {
      padding: 5px 10px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--bg-2);
      color: var(--fg);
      font-size: calc(var(--fs-caption) - 1px);
      font-weight: 600;
      cursor: pointer;
    }
    .mistake-list .ml-tour-prev:hover,
    .mistake-list .ml-tour-next:hover {
      background: var(--hover);
      border-color: var(--accent);
    }
    .mistake-list .ml-tour-prev:disabled,
    .mistake-list .ml-tour-next:disabled {
      opacity: 0.45;
      cursor: default;
      pointer-events: none;
    }
    .mistake-list .ml-subcap {
      font-size: calc(var(--fs-caption) - 2px);
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--muted);
      margin: 10px 0 4px 0;
    }
    .mistake-list .ml-lesson {
      margin-top: 8px;
      padding: 10px 10px 12px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--bg-2);
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .mistake-list .ml-lesson.hidden { display: none; }
    .mistake-list .ml-lesson-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .mistake-list .ml-lesson-title {
      font-weight: 800;
      font-size: calc(var(--fs) - 2px);
    }
    .mistake-list .ml-lesson-close {
      border: 1px solid var(--border);
      background: var(--bg-3);
      color: var(--fg);
      width: 28px;
      height: 28px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
    }
    .mistake-list .ml-lesson-close:hover { border-color: var(--accent); }
    .mistake-list .ml-lesson-block .ml-lb {
      display: block;
      font-size: calc(var(--fs-caption) - 1px);
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 4px;
    }
    .mistake-list .ml-lesson-block > div:last-child {
      font-size: calc(var(--fs-body) - 1px);
      line-height: 1.45;
      color: var(--fg);
    }
    .engine-hint .eh-caption {
      font-size: calc(var(--fs) - 3px);
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .engine-hint .eh-text {
      font-size: calc(var(--fs));
      line-height: 1.4;
      color: var(--fg);
    }

    .lines {
      border-top: 1px solid var(--border);
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 5px;
      min-height: 60px;
    }
    .lines .caption {
      font-size: calc(var(--fs) - 3px);
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.4px;
      margin-bottom: 2px;
    }
    .line {
      display: flex;
      gap: 10px;
      align-items: baseline;
      font-size: calc(var(--fs) - 1px);
      line-height: 1.35;
    }
    .line .lscore {
      color: var(--muted);
      font-variant-numeric: tabular-nums;
      width: 58px;
      flex-shrink: 0;
      font-weight: 600;
    }
    .line .lmoves {
      color: var(--fg);
      font-family: "SF Mono", Menlo, Consolas, monospace;
      font-size: calc(var(--fs) - 1.5px);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .line.empty { color: var(--muted); font-style: italic; }

    .footer {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 12px 12px;
      border-top: 1px solid var(--border);
      font-size: calc(var(--fs) - 2px);
      color: var(--muted);
    }
    .footer input[type="range"] {
      flex: 1;
      accent-color: var(--accent);
    }
    .depth-label {
      font-variant-numeric: tabular-nums;
      min-width: 52px;
      text-align: right;
    }

    .settings {
      display: none;
      flex-direction: column;
      gap: 10px;
      padding: 12px;
      border-top: 1px solid var(--border);
      background: var(--bg-3);
    }
    .settings.open { display: flex; }
    .settings .row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .settings .row > span { font-size: calc(var(--fs) - 2px); color: var(--muted); text-transform: uppercase; letter-spacing: 0.4px; }
    .seg {
      display: inline-flex;
      border: 1px solid var(--border);
      border-radius: 6px;
      overflow: hidden;
    }
    .seg button {
      background: var(--bg);
      color: var(--fg);
      border: none;
      padding: 6px 12px;
      cursor: pointer;
      font-size: calc(var(--fs) - 2px);
      border-right: 1px solid var(--border);
    }
    .seg button:last-child { border-right: none; }
    .seg button.active {
      background: var(--accent);
      color: #fff;
    }

    /* ====== Interactive UI additions ====== */

    /* Context pill (fair-play status) in the header */
    .ctx-pill {
      font-size: calc(var(--fs) - 4px);
      text-transform: uppercase;
      letter-spacing: 0.4px;
      padding: 2px 7px;
      border-radius: 999px;
      background: var(--hover);
      color: var(--muted);
      border: 1px solid var(--border);
      flex-shrink: 0;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .ctx-pill.safe { background: rgba(62, 169, 102, 0.15); color: #3ea966; border-color: #3ea966; }
    .ctx-pill.unsafe { background: rgba(224, 65, 65, 0.15); color: #e04141; border-color: #e04141; }

    /* Pill-mode (collapsed overlay): only header is visible */
    /* (0.7.0 removed the old float-mode pill collapsed styling; the drawer
       now slides fully off-screen via .drawer-closed instead.) */
    /* (drawer-closed handles the collapsed state via transform.) */

    /* Collapse button in the header */
    .collapse-btn {
      background: transparent;
      border: none;
      color: var(--muted);
      cursor: pointer;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: calc(var(--fs) + 2px);
      line-height: 1;
      flex-shrink: 0;
    }
    .collapse-btn:hover { color: var(--fg); background: var(--hover); }

    /* Move timeline strip */
    .timeline {
      display: flex;
      align-items: center;
      gap: 2px;
      padding: 8px 12px;
      border-top: 1px solid var(--border);
      background: var(--bg-3);
      overflow-x: auto;
      scrollbar-width: thin;
      min-height: 28px;
    }
    .timeline.hidden { display: none; }
    .timeline .tl-caption {
      font-size: calc(var(--fs) - 4px);
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.4px;
      margin-right: 6px;
      flex-shrink: 0;
    }
    .timeline .tl-track {
      display: flex;
      gap: 3px;
      align-items: center;
    }
    .timeline .tl-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--muted);
      flex-shrink: 0;
      cursor: default;
      border: 1.5px solid transparent;
      transition: transform 0.12s;
    }
    .timeline .tl-dot:hover { transform: scale(1.35); }
    .timeline .tl-dot.sev-brilliant { background: #26d0ad; }
    .timeline .tl-dot.sev-great { background: #4ac26b; }
    .timeline .tl-dot.sev-best { background: #4ac26b; }
    .timeline .tl-dot.sev-good { background: #7ac074; }
    .timeline .tl-dot.sev-book { background: #8aa4d8; }
    .timeline .tl-dot.sev-neutral { background: var(--muted); }
    .timeline .tl-dot.sev-inaccuracy { background: #e0b441; }
    .timeline .tl-dot.sev-mistake { background: #e08541; }
    .timeline .tl-dot.sev-blunder { background: #e04141; }
    .timeline .tl-dot.white { border-color: #e7e8ea; }
    .timeline .tl-dot.black { border-color: #1a1d22; }
    .timeline .tl-empty {
      color: var(--muted);
      font-style: italic;
      font-size: calc(var(--fs) - 3px);
    }

    /* 0.10.0: Session summary card.
       Appears at the bottom of Analyze once the player has made at
       least one rated move. Rolls the move timeline into a compact
       "N moves, X% accuracy" + per-severity chip list so the student
       can see their game's shape at a glance. */
    .summary {
      padding: 10px 12px 12px;
      border-top: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: linear-gradient(180deg, transparent, rgba(255,255,255,0.02));
    }
    .summary.hidden { display: none; }
    .summary .sum-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
    }
    .summary .sum-title {
      font-weight: 700;
      font-size: calc(var(--fs) - 1px);
      letter-spacing: 0.02em;
    }
    .summary .sum-sub {
      color: var(--muted);
      font-size: calc(var(--fs) - 3px);
    }
    .summary .sum-acc {
      display: flex;
      align-items: baseline;
      gap: 6px;
    }
    .summary .sum-acc-num {
      font-weight: 800;
      font-size: calc(var(--fs) + 8px);
      font-variant-numeric: tabular-nums;
      color: var(--accent);
      letter-spacing: -0.01em;
    }
    .summary .sum-acc-unit {
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-size: calc(var(--fs) - 4px);
    }
    .summary .sum-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 4px 6px;
    }
    .sum-chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 7px;
      border: 1px solid var(--border);
      border-radius: 999px;
      font-size: calc(var(--fs) - 3px);
      font-weight: 600;
      color: var(--muted);
      background: var(--bg-2);
    }
    .sum-chip.nonzero { color: var(--fg); }
    .sum-chip.nonzero.sev-brilliant   { color: #26d0ad; border-color: rgba(38,208,173,0.45); }
    .sum-chip.nonzero.sev-great       { color: #4ac26b; border-color: rgba(74,194,107,0.45); }
    .sum-chip.nonzero.sev-best        { color: #4ac26b; border-color: rgba(74,194,107,0.45); }
    .sum-chip.nonzero.sev-good        { color: #7ac074; border-color: rgba(122,192,116,0.45); }
    .sum-chip.nonzero.sev-book        { color: #8aa4d8; border-color: rgba(138,164,216,0.45); }
    .sum-chip.nonzero.sev-inaccuracy  { color: #e0b441; border-color: rgba(224,180,65,0.5); }
    .sum-chip.nonzero.sev-mistake     { color: #e08541; border-color: rgba(224,133,65,0.5); }
    .sum-chip.nonzero.sev-blunder     { color: #e04141; border-color: rgba(224,65,65,0.5); }
    .sum-chip .sc-label { text-transform: capitalize; }
    .sum-chip .sc-count {
      font-family: "SF Mono", Menlo, Consolas, monospace;
      font-weight: 700;
    }

    /* Principle chips */
    .chips {
      display: flex;
      gap: 6px;
      padding: 8px 12px;
      border-top: 1px solid var(--border);
      flex-wrap: wrap;
    }
    .chips.hidden { display: none; }
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--hover);
      font-size: calc(var(--fs) - 3px);
      color: var(--muted);
      cursor: help;
    }
    .chip .chip-dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--muted);
    }
    .chip.status-good { color: #4ac26b; border-color: rgba(74, 194, 107, 0.6); }
    .chip.status-good .chip-dot { background: #4ac26b; }
    .chip.status-partial { color: #e0b441; border-color: rgba(224, 180, 65, 0.6); }
    .chip.status-partial .chip-dot { background: #e0b441; }
    .chip.status-bad { color: #e08541; border-color: rgba(224, 133, 65, 0.6); }
    .chip.status-bad .chip-dot { background: #e08541; }

    /* Coach bubble styling -- re-uses .engine-hint container */
    .engine-hint {
      position: relative;
    }
    .engine-hint.bubble {
      border-top: none;
      margin: 8px 12px 4px;
      padding: 12px 14px 12px 48px;
      border-radius: 12px;
      background: var(--bg-2);
      border: 1px solid var(--border);
    }
    .engine-hint.bubble::before {
      content: "\\265E"; /* Black chess knight -- 0.7.0 replaced the L monogram */
      position: absolute;
      top: 9px;
      left: 8px;
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: var(--accent);
      color: #fff;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 400; /* glyph, not a letter -- thin weight reads cleaner */
      font-size: calc(var(--fs-body) + 6px);
      line-height: 1;
      letter-spacing: 0;
      padding-bottom: 2px; /* visual centering of the tall knight glyph */
      box-sizing: border-box;
    }
    .engine-hint .eh-more {
      background: transparent;
      border: none;
      color: var(--accent);
      cursor: pointer;
      padding: 0;
      margin-top: 4px;
      font-size: calc(var(--fs) - 3px);
      text-align: left;
    }
    .engine-hint .eh-more:hover { text-decoration: underline; }
    .engine-hint .eh-detail {
      display: none;
      margin-top: 6px;
      font-size: calc(var(--fs) - 2px);
      color: var(--muted);
      line-height: 1.4;
    }
    .engine-hint.show-detail .eh-detail { display: block; }

    /* Locked overlay (fair-play gating) */
    .locked {
      padding: 18px 16px;
      border-top: 1px solid var(--border);
      display: none;
      flex-direction: column;
      gap: 8px;
      align-items: flex-start;
      background: var(--bg-3);
    }
    .root.ctx-unsafe .body-scroll,
    .root.ctx-unsafe .body,
    .root.ctx-unsafe .assessment,
    .root.ctx-unsafe .last-move,
    .root.ctx-unsafe .chips,
    .root.ctx-unsafe .opening,
    .root.ctx-unsafe .engine-hint,
    .root.ctx-unsafe .lines,
    .root.ctx-unsafe .footer,
    .root.ctx-unsafe .timeline,
    .root.ctx-unsafe .study {
      display: none !important;
    }
    .root.ctx-unsafe .locked { display: flex; }
    .locked .lk-title {
      font-weight: 800;
      font-size: calc(var(--fs) + 1px);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .locked .lk-ctx {
      font-size: calc(var(--fs) - 2px);
      color: var(--muted);
    }
    .locked .lk-body {
      font-size: calc(var(--fs) - 2px);
      color: var(--fg);
      line-height: 1.4;
    }
    .locked .lk-link {
      font-size: calc(var(--fs) - 2px);
      color: var(--accent);
      text-decoration: none;
      border-bottom: 1px dotted var(--accent);
    }

    /* First-run fair-play modal */
    .fp-modal {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.55);
      z-index: 2147483001;
      align-items: center;
      justify-content: center;
      font-size: var(--fs);
    }
    .fp-modal.show { display: flex; }
    .fp-card {
      background: var(--bg);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 22px 24px;
      max-width: 440px;
      width: calc(100vw - 60px);
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.55);
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .fp-card h2 {
      all: unset;
      font-family: inherit;
      font-weight: 800;
      font-size: calc(var(--fs) + 4px);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .fp-card p {
      all: unset;
      display: block;
      font-family: inherit;
      font-size: calc(var(--fs) - 1px);
      line-height: 1.5;
      color: var(--fg);
    }
    .fp-card ul {
      margin: 0;
      padding-left: 18px;
      color: var(--muted);
      font-size: calc(var(--fs) - 2px);
      line-height: 1.5;
    }
    .fp-card ul li::marker { color: var(--accent); }
    .fp-check {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      font-size: calc(var(--fs) - 2px);
      color: var(--fg);
      margin-top: 6px;
      cursor: pointer;
    }
    .fp-check input {
      margin: 3px 0 0 0;
      flex-shrink: 0;
    }
    .fp-actions {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      margin-top: 8px;
    }
    .fp-link {
      color: var(--accent);
      text-decoration: none;
      align-self: center;
      font-size: calc(var(--fs) - 2px);
      border-bottom: 1px dotted var(--accent);
    }
    .fp-accept {
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 6px;
      padding: 8px 18px;
      font-weight: 700;
      cursor: pointer;
      font-size: calc(var(--fs) - 1px);
    }
    .fp-accept:disabled {
      background: var(--track);
      cursor: not-allowed;
    }

    /* ====== 0.6.0: Focus mode, inline eval, warning row, icon links ====== */

    /* Focus mode hides the advanced/verbose blocks. Default is focus. */
    .root.mode-focus .bar-wrap,
    .root.mode-focus .score,
    .root.mode-focus .assessment,
    .root.mode-focus .lines,
    .root.mode-focus .footer,
    .root.mode-focus .chips {
      display: none !important;
    }
    /* In focus mode the .body wrapper no longer has an eval bar so zero its
       side padding + height-stretch tricks. */
    .root.mode-focus .body {
      padding: 8px 12px 4px;
      gap: 0;
    }
    .root.mode-focus .info {
      gap: 2px;
    }

    /* The .status line ("depth 15") is noisy in focus mode. */
    .root.mode-focus .status {
      display: none;
    }

    /* Inline compact eval strip -- lives INSIDE the coach bubble. Rendered
       only in focus mode. */
    .coach-eval {
      display: none;
      align-items: center;
      gap: 8px;
      margin-top: 8px;
      font-size: var(--fs-caption);
      color: var(--muted);
    }
    .root.mode-focus .coach-eval.visible { display: flex; }
    .coach-eval .ce-bar {
      flex: 1;
      height: 4px;
      background: var(--white-sq);
      border-radius: 2px;
      overflow: hidden;
      position: relative;
    }
    .coach-eval .ce-fill {
      position: absolute;
      left: 50%;
      top: 0;
      bottom: 0;
      background: var(--accent);
      transition: all 0.25s ease;
    }
    .coach-eval .ce-score {
      font-weight: 700;
      color: var(--fg);
      font-variant-numeric: tabular-nums;
      min-width: 48px;
      text-align: right;
    }
    .coach-eval .ce-label { flex-shrink: 0; }

    /* Muted "opponent's reply" styling in My-side advisor mode. */
    .engine-hint.muted .eh-text {
      color: var(--muted);
      font-style: italic;
    }
    .engine-hint.muted::before {
      opacity: 0.55;
    }

    /* Single-line principle warning (replaces the chips row in focus mode). */
    .principle-warning {
      display: none;
      align-items: flex-start;
      gap: 6px;
      padding: 6px 12px 8px;
      font-size: var(--fs-caption);
      color: #e08541;
    }
    .principle-warning.show { display: flex; }
    .root.mode-focus .principle-warning.show { display: flex; }
    .root.mode-advanced .principle-warning { display: none !important; }
    .principle-warning .pw-icon { font-size: var(--fs-body); line-height: 1.1; }

    /* Opening section: convert read-more links into icon buttons. */
    .op-links {
      display: flex;
      gap: 6px;
      margin-top: 4px;
    }
    .op-links.hidden { display: none; }
    .op-links a {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 28px;
      height: 28px;
      border-radius: 6px;
      background: var(--hover);
      border: 1px solid var(--border);
      color: var(--muted);
      text-decoration: none;
      font-size: var(--fs-caption);
      font-weight: 700;
      transition: background 0.15s, color 0.15s;
    }
    .op-links a:hover {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }
    .op-links a .op-icon { font-size: var(--fs-body); line-height: 1; }

    /* Segmented controls for the three new settings rows. */
    .seg button { font-family: inherit; }

    /* Coach bubble -- tighter typography for 0.6. */
    .engine-hint.bubble .eh-caption {
      font-size: var(--fs-caption);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--muted);
      margin-bottom: 4px;
    }
    .engine-hint.bubble .eh-text {
      font-size: var(--fs-body);
      line-height: 1.45;
    }
    .engine-hint.bubble::before {
      font-size: var(--fs-body);
    }

    /* ====== 0.9.0: Analyze / Learn surface split =========================
       The drawer now has two mutually-exclusive surfaces:
         surface-analyze: engine-driven review (default)
         surface-learn:   Opening Library + directive Study mode (no engine)

       Sections are tagged with data-surface in the markup and hidden via
       CSS gating here so the controller just needs to flip one class on
       .root to switch between the two. */

    /* Surface segmented control lives where the old Library button was. */
    .surface-seg {
      display: inline-flex;
      border: 1px solid var(--border);
      border-radius: 999px;
      overflow: hidden;
      flex-shrink: 0;
      background: var(--bg);
    }
    .surface-seg button {
      background: transparent;
      color: var(--muted);
      border: none;
      padding: 6px 14px;
      cursor: pointer;
      font: inherit;
      font-size: calc(var(--fs-body) - 2px);
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    .surface-seg button.active {
      background: var(--accent);
      color: #fff;
    }
    .surface-seg button:not(.active):hover {
      background: var(--hover);
      color: var(--fg);
    }

    /* Analyze-only sections -- hide when Learn surface is active. */
    .root.surface-learn .timeline,
    .root.surface-learn .body,
    .root.surface-learn .assessment,
    .root.surface-learn .last-move,
    .root.surface-learn .chips,
    .root.surface-learn .engine-hint,
    .root.surface-learn .principle-warning,
    .root.surface-learn .lines,
    .root.surface-learn .footer,
    .root.surface-learn .op-pill,
    .root.surface-learn .summary {
      display: none !important;
    }

    /* Learn-only sections -- hide when Analyze surface is active. */
    .root.surface-analyze .study,
    .root.surface-analyze .lib-picker {
      display: none !important;
    }

    /* ====== 0.11.0: Post-game batch Analyze state gating ================
       The Analyze surface is a state machine now:
         data-review-state="idle"     -> idle card (Analyze this game button)
         data-review-state="running"  -> progress card
         data-review-state="ready"    -> full review (cache-fed)
         data-review-state="stale"    -> banner + Re-analyze button
       Only the "ready" state shows the existing eval / last-move /
       timeline / lines / summary / mistake-list. Non-ready states hide
       all of them and show a single focused card. */

    .review-card {
      display: none;
      flex-direction: column;
      gap: 10px;
      margin: 10px 12px;
      padding: 14px 16px;
      border-radius: 10px;
      background: var(--bg-2);
      border: 1px solid var(--border);
    }
    /* Fail-open default: on the Analyze surface the IDLE card is visible
       unless another review-state is explicitly active. This keeps the
       "Analyze this game" button reachable even if the controller hasn't
       yet painted a state (e.g. fair-play context is still classifying,
       or this is first boot before the first poll tick). */
    .root.surface-analyze .review-idle    { display: flex; }
    .root.surface-analyze[data-review-state="running"] .review-idle { display: none; }
    .root.surface-analyze[data-review-state="ready"]   .review-idle { display: none; }
    .root.surface-analyze[data-review-state="stale"]   .review-idle { display: none; }
    .root.surface-analyze[data-review-state="running"] .review-running { display: flex; }
    .root.surface-analyze[data-review-state="stale"]   .review-stale   { display: flex; }
    /* Learn surface always hides review-state cards -- they're analyze-only. */
    .root.surface-learn .review-card { display: none !important; }
    .root.surface-learn .review-nav { display: none !important; }

    /* In every non-ready review state, hide the cache-driven panels so
       we don't leak the old live-advisor UI through. The idle / running
       / stale cards own the surface in those states. The default
       (attribute missing) is treated as idle. */
    .root.surface-analyze:not([data-review-state="ready"]) .review-nav,
    .root.surface-analyze:not([data-review-state="ready"]) .timeline,
    .root.surface-analyze:not([data-review-state="ready"]) .body,
    .root.surface-analyze:not([data-review-state="ready"]) .assessment,
    .root.surface-analyze:not([data-review-state="ready"]) .last-move,
    .root.surface-analyze:not([data-review-state="ready"]) .chips,
    .root.surface-analyze:not([data-review-state="ready"]) .op-pill,
    .root.surface-analyze:not([data-review-state="ready"]) .engine-hint,
    .root.surface-analyze:not([data-review-state="ready"]) .principle-warning,
    .root.surface-analyze:not([data-review-state="ready"]) .lines,
    .root.surface-analyze:not([data-review-state="ready"]) .summary,
    .root.surface-analyze:not([data-review-state="ready"]) .mistake-list,
    .root.surface-analyze:not([data-review-state="ready"]) .footer {
      display: none !important;
    }

    /* Review navigation (batch ready): drives chess.com prev/next via content.js */
    .review-nav {
      display: none;
      flex-direction: column;
      gap: 8px;
      margin: 6px 12px 4px;
      padding: 10px 12px;
      border-radius: 10px;
      background: var(--bg-2);
      border: 1px solid var(--border);
    }
    .root.surface-analyze[data-review-state="ready"] .review-nav {
      display: flex !important;
    }
    .review-nav .rn-hint {
      font-size: var(--fs-caption);
      color: var(--muted);
      line-height: 1.35;
    }
    .review-nav .rn-row {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: center;
      justify-content: flex-start;
    }
    .review-nav .rn-btn {
      flex: 0 0 auto;
      min-width: 40px;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--bg-3);
      color: var(--fg);
      font-weight: 700;
      font-size: calc(var(--fs-caption) + 1px);
      cursor: pointer;
    }
    .review-nav .rn-btn:hover {
      background: var(--hover);
    }
    .review-nav .rn-scrub {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .review-nav .rn-slider {
      width: 100%;
      accent-color: var(--accent);
    }
    .review-nav .rn-pty {
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: var(--fs-caption);
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }
    .review-nav .rn-sync {
      display: none;
      font-weight: 700;
      color: var(--accent);
      letter-spacing: 1px;
    }

    /* Idle card. */
    .review-idle .ri-title {
      font-size: calc(var(--fs-display) + 2px);
      font-weight: 700;
      letter-spacing: -0.01em;
    }
    .review-idle .ri-summary {
      font-size: var(--fs-body);
      color: var(--muted);
      line-height: 1.4;
    }
    .review-idle .ri-summary .ri-tag {
      display: inline-block;
      font-family: "SF Mono", Menlo, Consolas, monospace;
      font-size: calc(var(--fs-caption) - 1px);
      padding: 1px 6px;
      border-radius: 4px;
      background: var(--bg-3);
      color: var(--fg);
      margin-right: 6px;
    }
    .review-idle .ri-depth {
      font-size: var(--fs-caption);
      color: var(--muted);
    }
    .review-idle .ri-depth-num {
      color: var(--fg);
      font-weight: 600;
    }
    .review-idle .ri-btn {
      margin-top: 2px;
      padding: 10px 14px;
      border-radius: 8px;
      border: 1px solid var(--accent);
      background: var(--accent);
      color: #fff;
      font-weight: 700;
      font-size: var(--fs-body);
      cursor: pointer;
      transition: filter 0.12s ease;
    }
    .review-idle .ri-btn:hover { filter: brightness(1.08); }
    .review-idle .ri-btn:disabled {
      background: var(--bg-3);
      border-color: var(--border);
      color: var(--muted);
      cursor: not-allowed;
      filter: none;
    }
    .review-idle .ri-hint {
      font-size: var(--fs-caption);
      color: var(--muted);
      line-height: 1.4;
    }
    .review-idle .ri-error {
      font-size: var(--fs-caption);
      color: #e27272;
      display: none;
    }
    .review-idle.has-error .ri-error { display: block; }

    /* Running card. */
    .review-running .rr-title {
      font-size: var(--fs-display);
      font-weight: 700;
    }
    .review-running .rr-progress-text {
      font-variant-numeric: tabular-nums;
      font-size: calc(var(--fs-body) - 1px);
      color: var(--muted);
    }
    .review-running .rr-bar {
      height: 8px;
      background: var(--bg-3);
      border-radius: 4px;
      overflow: hidden;
    }
    .review-running .rr-bar-fill {
      height: 100%;
      width: 0%;
      background: linear-gradient(90deg, var(--accent), color-mix(in srgb, var(--accent) 70%, #fff 30%));
      transition: width 0.25s ease;
    }
    .review-running .rr-eta {
      font-size: var(--fs-caption);
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }
    .review-running .rr-current {
      font-family: "SF Mono", Menlo, Consolas, monospace;
      font-size: calc(var(--fs-caption) + 1px);
      color: var(--fg);
      min-height: 1em;
    }
    .review-running .rr-cancel {
      align-self: flex-start;
      padding: 6px 12px;
      border-radius: 6px;
      background: transparent;
      color: var(--muted);
      border: 1px solid var(--border);
      font-size: var(--fs-caption);
      cursor: pointer;
      font-weight: 600;
    }
    .review-running .rr-cancel:hover {
      color: var(--fg);
      border-color: #e27272;
    }

    /* Stale card. */
    .review-stale .rs-title {
      font-size: var(--fs-display);
      font-weight: 700;
      color: #e2a063;
    }
    .review-stale .rs-body {
      font-size: var(--fs-body);
      color: var(--muted);
      line-height: 1.4;
    }
    .review-stale .rs-reanalyze {
      align-self: flex-start;
      padding: 8px 12px;
      border-radius: 6px;
      background: var(--accent);
      color: #fff;
      border: 1px solid var(--accent);
      font-weight: 700;
      font-size: var(--fs-caption);
      cursor: pointer;
    }
    .review-stale .rs-reanalyze:hover { filter: brightness(1.08); }

    /* Mistake list (ready state). */
    .mistake-list {
      margin: 6px 12px 0;
      padding: 10px 12px 8px;
      border-top: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .mistake-list.hidden { display: none; }
    .mistake-list .ml-title {
      font-weight: 700;
      font-size: calc(var(--fs) - 1px);
      letter-spacing: 0.02em;
    }
    .mistake-list .ml-empty {
      font-size: var(--fs-caption);
      color: var(--muted);
    }
    .mistake-list .ml-row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 6px;
      background: var(--bg-2);
      border: 1px solid var(--border);
      font-size: calc(var(--fs-body) - 1px);
    }
    .mistake-list .ml-row:hover {
      border-color: var(--accent);
      background: var(--hover);
    }
    .mistake-list .ml-main {
      flex: 1 1 140px;
      cursor: pointer;
      text-align: left;
      border: none;
      background: transparent;
      color: inherit;
      font: inherit;
      padding: 0;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      align-items: baseline;
    }
    .mistake-list .ml-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 4px;
      align-items: center;
    }
    .mistake-list .ml-jump {
      padding: 4px 8px;
      border-radius: 6px;
      border: 1px solid var(--border);
      background: var(--bg-3);
      color: var(--fg);
      font-size: calc(var(--fs-caption) - 1px);
      font-weight: 600;
      cursor: pointer;
    }
    .mistake-list .ml-jump:hover {
      background: var(--hover);
    }
    .mistake-list .ml-move {
      font-family: "SF Mono", Menlo, Consolas, monospace;
      font-weight: 600;
      min-width: 64px;
    }
    .mistake-list .ml-label {
      font-weight: 600;
      flex: 0 0 auto;
    }
    .mistake-list .ml-badge {
      font-family: "SF Mono", Menlo, Consolas, monospace;
      font-weight: 700;
      color: var(--muted);
    }
    .mistake-list .ml-miss {
      margin-left: auto;
      color: var(--muted);
      font-variant-numeric: tabular-nums;
    }
    .mistake-list .sev-inaccuracy { border-left: 3px solid #e6c06d; padding-left: 6px; }
    .mistake-list .sev-mistake    { border-left: 3px solid #e28f6a; padding-left: 6px; }
    .mistake-list .sev-blunder    { border-left: 3px solid #e27272; padding-left: 6px; }
    .mistake-list .ml-body {
      max-height: 220px;
      overflow-y: auto;
    }

    /* Batch-depth preset buttons in Settings (0.11.0). */
    .batch-depth-seg button {
      padding: 6px 10px;
      background: transparent;
      color: var(--muted);
      border: 1px solid var(--border);
      border-right-width: 0;
      font-size: var(--fs-caption);
      font-weight: 600;
      cursor: pointer;
    }
    .batch-depth-seg button:last-child { border-right-width: 1px; }
    .batch-depth-seg button:first-child { border-top-left-radius: 6px; border-bottom-left-radius: 6px; }
    .batch-depth-seg button:last-child  { border-top-right-radius: 6px; border-bottom-right-radius: 6px; }
    .batch-depth-seg button.active {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }


    /* ====== Opening Library (inline picker + directive Study card)
       ========================================================= */

    /* Inline picker lives in the drawer body (no more modal). */
    .lib-picker {
      padding: 16px 16px 24px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .lib-picker .lib-title {
      font-weight: 700;
      font-size: calc(var(--fs-display) + 2px);
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .lib-picker .lib-title::before {
      content: "\\265E";
      font-size: var(--ic-lg);
      color: var(--accent);
      line-height: 1;
    }
    .lib-picker .lib-intro {
      font-size: calc(var(--fs-body) - 1px);
      color: var(--muted);
      line-height: 1.45;
      margin-top: -6px;
    }
    .lib-picker .lib-body {
      display: flex;
      flex-direction: column;
      gap: 18px;
    }
    /* Small opening-name pill shown inline in Analyze when the live
       position is in book. Replaces the big Opening-theory card from
       0.8.x -- the Library / Study surface is the authoritative place
       to learn an opening now. */
    .op-pill {
      display: none;
      align-items: center;
      gap: 8px;
      margin: 8px 12px 0;
      padding: 8px 12px;
      background: var(--bg-3);
      border: 1px solid var(--border);
      border-left: 3px solid var(--accent);
      border-radius: 10px;
      font-size: var(--fs-body);
    }
    .op-pill.show { display: flex; }
    .op-pill .op-pill-name {
      font-weight: 700;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .op-pill .op-pill-eco {
      font-family: "SF Mono", Menlo, Consolas, monospace;
      font-size: var(--fs-caption);
      color: var(--muted);
      background: var(--hover);
      padding: 1px 6px;
      border-radius: 4px;
    }
    .op-pill .op-pill-study {
      margin-left: auto;
      background: transparent;
      border: 1px solid var(--accent);
      color: var(--accent);
      border-radius: 999px;
      font: inherit;
      font-size: var(--fs-caption);
      font-weight: 700;
      padding: 3px 10px;
      cursor: pointer;
      white-space: nowrap;
      flex-shrink: 0;
    }
    .op-pill .op-pill-study:hover { background: var(--accent); color: #fff; }
    .op-pill .op-pill-study.disabled {
      opacity: 0.4;
      cursor: default;
      border-color: var(--border);
      color: var(--muted);
    }
    .op-pill .op-pill-study.disabled:hover {
      background: transparent;
      color: var(--muted);
    }

    .lib-cat .lib-cat-head {
      font-size: calc(var(--fs-body));
      font-weight: 700;
      color: var(--fg);
      letter-spacing: 0.02em;
      margin-bottom: 2px;
    }
    .lib-cat .lib-cat-blurb {
      font-size: var(--fs-caption);
      color: var(--muted);
      margin-bottom: 10px;
      line-height: 1.4;
    }
    .lib-cat .lib-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
      gap: 10px;
    }
    .lib-op {
      background: var(--bg-2);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 12px 14px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      cursor: pointer;
      transition: border-color 0.15s, transform 0.15s, background 0.15s;
      text-align: left;
      font: inherit;
      color: inherit;
    }
    .lib-op:hover {
      border-color: var(--accent);
      transform: translateY(-2px);
      background: var(--bg-3);
    }
    .lib-op .lib-op-head {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px;
    }
    .lib-op .lib-op-name {
      font-weight: 700;
      font-size: var(--fs-body);
    }
    .lib-op .lib-op-eco {
      font-family: "SF Mono", Menlo, Consolas, monospace;
      font-size: var(--fs-caption);
      color: var(--muted);
      background: var(--hover);
      padding: 1px 6px;
      border-radius: 4px;
      flex-shrink: 0;
    }
    .lib-op .lib-op-blurb {
      font-size: var(--fs-caption);
      color: var(--fg);
      line-height: 1.45;
    }
    .lib-op .lib-op-why {
      font-size: var(--fs-caption);
      color: var(--muted);
      line-height: 1.4;
      font-style: italic;
    }
    .lib-op .lib-op-moves {
      font-family: "SF Mono", Menlo, Consolas, monospace;
      font-size: var(--fs-caption);
      color: var(--accent);
      letter-spacing: 0.02em;
      margin-top: 2px;
    }
    .lib-op .lib-op-tags {
      display: flex;
      gap: 4px;
      flex-wrap: wrap;
      margin-top: 2px;
    }
    .lib-op .lib-tag {
      font-size: calc(var(--fs-caption) - 1px);
      color: var(--muted);
      background: var(--hover);
      padding: 1px 6px;
      border-radius: 3px;
      text-transform: lowercase;
    }

    /* Active study-mode card -- pinned above the opening-theory card. */
    .study {
      margin: 8px 12px 4px;
      padding: 14px 16px 14px 16px;
      border-radius: 12px;
      background: var(--bg-2);
      border: 1px solid var(--accent);
      display: none;
      flex-direction: column;
      gap: 8px;
      position: relative;
    }
    .study.show { display: flex; }
    .study .st-head {
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .study .st-kind {
      font-size: var(--fs-caption);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--accent);
      font-weight: 700;
    }
    .study .st-exit {
      margin-left: auto;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--muted);
      border-radius: 999px;
      font-size: var(--fs-caption);
      padding: 3px 10px;
      cursor: pointer;
      font-weight: 600;
    }
    .study .st-exit:hover { color: var(--fg); border-color: var(--accent); }
    .study .st-title {
      font-weight: 700;
      font-size: var(--fs-display);
      display: flex;
      align-items: baseline;
      gap: 6px;
    }
    .study .st-eco {
      font-family: "SF Mono", Menlo, Consolas, monospace;
      font-size: var(--fs-caption);
      color: var(--muted);
      background: var(--hover);
      padding: 1px 6px;
      border-radius: 4px;
    }
    .study .st-progress {
      display: flex;
      gap: 4px;
      align-items: center;
    }
    .study .st-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--hover);
      border: 1.5px solid var(--border);
    }
    .study .st-dot.done { background: var(--accent); border-color: var(--accent); }
    .study .st-dot.now  {
      background: #fff;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(62, 169, 102, 0.25);
    }
    .study .st-directive {
      font-size: var(--fs-body);
      line-height: 1.5;
      color: var(--fg);
    }
    .study .st-directive .st-move {
      font-family: "SF Mono", Menlo, Consolas, monospace;
      font-weight: 700;
      color: var(--accent);
      background: var(--hover);
      padding: 2px 8px;
      border-radius: 6px;
      margin: 0 2px;
    }
    .study .st-why {
      font-size: var(--fs-caption);
      color: var(--muted);
      line-height: 1.4;
    }
    .study.state-complete { border-color: #26d0ad; }
    .study.state-off      { border-color: #e08541; }
    .study.state-complete .st-kind { color: #26d0ad; }
    .study.state-off      .st-kind { color: #e08541; }

    /* ====== 0.8.0: bigger icons/glyphs across the whole UI ========== */
    .icon-btn {
      font-size: var(--ic-md);
      padding: 6px 10px;
    }
    .collapse-btn {
      font-size: var(--ic-md);
      padding: 6px 10px;
    }
    .engine-hint.bubble {
      padding: 14px 16px 14px 62px;
    }
    .engine-hint.bubble::before {
      top: 11px;
      left: 10px;
      width: var(--ic-xl);
      height: var(--ic-xl);
      font-size: calc(var(--ic-xl) * 0.72);
      padding-bottom: 3px;
    }
    .opening .op-caption::before {
      font-size: var(--ic-md);
    }
    .op-links a {
      width: 40px;
      height: 40px;
      border-radius: 8px;
      font-size: calc(var(--fs-body) - 1px);
    }
    .op-links a .op-icon {
      font-size: var(--ic-md);
    }
    .timeline .tl-dot {
      width: 13px;
      height: 13px;
      border-width: 2px;
    }
    .edge-tab .et-chevron {
      font-size: calc(var(--ic-xl) - 4px);
    }
    .edge-tab .et-mono {
      font-size: calc(var(--ic-xl) - 8px);
    }
    .edge-tab .et-label {
      font-size: calc(var(--fs-caption) + 1px);
      letter-spacing: 5px;
    }
    .edge-tab .et-dot {
      width: 12px;
      height: 12px;
    }
    .principle-warning .pw-icon {
      font-size: var(--ic-md);
    }
  `;
  }

  const THEMES = {
    dark: {
      bg: "#1f2227",
      bg2: "#2a2e35",
      bg3: "#262a31",
      fg: "#f0f1f2",
      muted: "#9aa0a6",
      accent: "#3ea966",
      border: "#3a3f47",
      hover: "#30353d",
      track: "#4a4f57",
      whiteSq: "#f0f1f2",
      blackSq: "#1a1d22",
    },
    light: {
      bg: "#ffffff",
      bg2: "#f3f5f7",
      bg3: "#f8f9fb",
      fg: "#1a1d22",
      muted: "#6b7280",
      accent: "#1f8a4c",
      border: "#d8dce1",
      hover: "#eceef2",
      track: "#c8cdd4",
      whiteSq: "#f0f1f2",
      blackSq: "#1a1d22",
    },
  };

  function formatCp(cp) {
    const pawn = cp / 100;
    const sign = pawn > 0 ? "+" : pawn < 0 ? "" : "";
    return `${sign}${pawn.toFixed(2)}`;
  }

  function formatMate(n) {
    if (n === 0) return "#";
    return n > 0 ? `M${n}` : `-M${Math.abs(n)}`;
  }

  class Overlay {
    constructor() {
      this.host = null;
      this.shadow = null;
      this.root = null;
      this.edgeTab = null;
      this.elements = {};
      this.handlers = {};
      this.enabled = false;
      this.theme = "dark";
      this.size = "medium";
      this.collapsed = false;
      this.mode = "focus";
      this.advisor = "my-side";
      this.customWidth = null; // null = use S/M/L preset; number = user-dragged
      this.engineThinking = false;
      this.context = { kind: "other", label: "Unsupported page", safe: false };
      this._fpAcceptCallback = null;
      this.catalog = null;    // set via setCatalog()
      this.showArrows = true; // 0.8.0 — interactive board arrows toggle
      this.surface = "analyze"; // 0.9.0 — "analyze" | "learn"
      this.openingPill = null;  // 0.9.0 — { name, eco, catalogOpId|null }
    }

    mount(handlers = {}) {
      if (this.host) return;
      this.handlers = handlers;

      this.host = document.createElement("div");
      this.host.id = "lasker-overlay-host";
      this.host.style.all = "initial";
      this.shadow = this.host.attachShadow({ mode: "open" });

      const style = document.createElement("style");
      // 0.10.0: Space Grotesk WOFF2 files live in fonts/ -- bundle them
      // via chrome.runtime.getURL so the typeface renders identically on
      // every OS regardless of what's installed locally.
      let fontUrls = null;
      try {
        fontUrls = {
          regular:  chrome.runtime.getURL("fonts/SpaceGrotesk-Regular.woff2"),
          medium:   chrome.runtime.getURL("fonts/SpaceGrotesk-Medium.woff2"),
          semibold: chrome.runtime.getURL("fonts/SpaceGrotesk-SemiBold.woff2"),
          bold:     chrome.runtime.getURL("fonts/SpaceGrotesk-Bold.woff2"),
        };
      } catch (_err) { /* ignore -- falls back to local/system stack */ }
      style.textContent = buildBaseStyle(fontUrls);
      this.shadow.appendChild(style);

      const root = document.createElement("div");
      // Initial classes: defaults to focus mode. 0.7.0 dropped float/bottom
      // docks -- the panel is always a right-side drawer.
      root.className = `root mode-${this.mode} surface-${this.surface}`;
      root.innerHTML = `
        <div class="resize-handle" title="Drag to resize"></div>
        <div class="header" data-drag>
          <div class="title"><span class="dot"></span>LASKER</div>
          <span class="ctx-pill" title="Fair-play context">learning</span>
          <div class="seg surface-seg" role="tablist" title="Switch between review and learning">
            <button data-surface="analyze" title="Post-game engine review">Analyze</button>
            <button data-surface="learn" title="Opening Library + guided study">Learn</button>
          </div>
          <button class="icon-btn reset-btn" title="Clean state — wipe timeline, study & engine cache">&#8634;</button>
          <button class="collapse-btn" title="Collapse / expand (C)">&#9196;</button>
          <button class="icon-btn settings-btn" title="Settings">&#9881;</button>
          <button class="toggle" title="Toggle analysis (L)"></button>
        </div>
        <div class="body-scroll">
        <!-- 0.11.0: post-game batch Analyze state machine. These cards
             are mutually exclusive with the cache-driven panels below
             (see data-review-state gating in CSS). -->
        <div class="review-card review-idle">
          <div class="ri-title">Analyze this game</div>
          <div class="ri-summary">Finish a game on chess.com, then click below. LASKER will run Stockfish against every move once, cache the review, and rewind the board so you can step through with instant feedback.</div>
          <div class="ri-depth">Batch depth: <span class="ri-depth-num">18</span></div>
          <button class="ri-btn" type="button">Analyze this game</button>
          <div class="ri-hint">Nothing is sent to a server. The engine runs locally in your browser and tears down as soon as the batch finishes.</div>
          <div class="ri-error"></div>
        </div>
        <div class="review-card review-running">
          <div class="rr-title">Analyzing your game...</div>
          <div class="rr-progress-text">0 / 0 plies</div>
          <div class="rr-bar"><div class="rr-bar-fill"></div></div>
          <div class="rr-eta">estimating...</div>
          <div class="rr-current"></div>
          <button class="rr-cancel" type="button">Cancel</button>
        </div>
        <div class="review-card review-stale">
          <div class="rs-title">Outside cached analysis</div>
          <div class="rs-body">This board doesn&rsquo;t match the main line we analyzed (explorer line, transposition, or the page was still animating). Use LASKER&rsquo;s <b>Prev / Next</b>, chess.com&rsquo;s move list, or <b>Re-analyze</b> to resync.</div>
          <button class="rs-reanalyze" type="button">Re-analyze from start</button>
        </div>
        <div class="timeline hidden">
          <span class="tl-caption">Moves</span>
          <div class="tl-track"></div>
        </div>
        <div class="review-nav">
          <div class="rn-hint">Interactive review — buttons forward clicks to chess.com (same as its move arrows / keyboard).</div>
          <div class="rn-row">
            <button type="button" class="rn-btn" data-rn="start" title="Start position">|◀</button>
            <button type="button" class="rn-btn" data-rn="prev" title="Previous move">◀</button>
            <button type="button" class="rn-btn" data-rn="next" title="Next move">▶</button>
            <button type="button" class="rn-btn" data-rn="end" title="Final position">▶|</button>
          </div>
          <div class="rn-scrub">
            <input type="range" class="rn-slider" min="0" max="0" value="0" step="1" aria-label="Go to ply" />
            <div class="rn-pty">
              <span class="rn-ply-text">Ply 0 / 0</span>
              <span class="rn-sync" aria-hidden="true">&middot;&middot;&middot;</span>
            </div>
          </div>
        </div>
        <div class="body">
          <div class="bar-wrap">
            <div class="bar-fill"></div>
            <div class="bar-midline"></div>
          </div>
          <div class="info">
            <div class="score neutral">--</div>
            <div class="status">off</div>
            <div class="side-caption">You<span class="pov-pill">--</span></div>
          </div>
        </div>
        <div class="assessment hidden sev-neutral">
          <span class="sev-dot"></span>
          <span class="assess-text">Balanced</span>
        </div>
        <div class="last-move hidden">
          <div class="lm-head">
            <span class="lm-headline sev-neutral">—</span>
            <span class="badge"></span>
            <button class="clarify" title="Show numeric eval change (from batch)">?</button>
          </div>
          <div class="lm-best hidden">
            <span class="lm-best-label">Stronger try from the same diagram</span>
            <span class="lm-best-san"></span>
            <span class="lm-best-miss"></span>
          </div>
          <div class="lm-best-note"></div>
          <div class="detail"></div>
        </div>
        <div class="chips hidden">
          <div class="chip chip-king" title="King safety">
            <span class="chip-dot"></span>
            <span class="chip-label">King</span>
          </div>
          <div class="chip chip-dev" title="Piece development">
            <span class="chip-dot"></span>
            <span class="chip-label">Develop</span>
          </div>
          <div class="chip chip-centre" title="Central control">
            <span class="chip-dot"></span>
            <span class="chip-label">Centre</span>
          </div>
        </div>
        <div class="study">
          <div class="st-head">
            <span class="st-kind">Studying</span>
            <div class="st-progress"></div>
            <button class="st-exit" title="Leave study mode">Exit</button>
          </div>
          <div class="st-title">
            <span class="st-name"></span>
            <span class="st-eco"></span>
          </div>
          <div class="st-directive"></div>
          <div class="st-why"></div>
        </div>
        <div class="op-pill" title="Your current position is in the opening book">
          <span class="op-pill-name"></span>
          <span class="op-pill-eco"></span>
          <button class="op-pill-study" type="button" title="Open this opening in Learn mode">Study this &rsaquo;</button>
        </div>
        <div class="lib-picker">
          <div class="lib-title">Opening library</div>
          <div class="lib-intro">Pick an opening to study. Lasker will walk you through the key moves with on-board arrows and a per-move coach note. The engine stays off in Learn — switch back to <b>Analyze</b> when you want feedback.</div>
          <div class="lib-body"></div>
        </div>
        <div class="engine-hint bubble hidden">
          <div class="eh-caption">Suggested move (engine)</div>
          <div class="eh-sub">For whoever is to move on the board now (not necessarily your mistake — see the move card above / lesson below).</div>
          <div class="eh-text"></div>
          <div class="coach-eval">
            <span class="ce-label">Eval</span>
            <div class="ce-bar"><div class="ce-fill"></div></div>
            <span class="ce-score">--</span>
          </div>
          <button class="eh-more" title="Show the raw numbers behind this suggestion">Tell me more &raquo;</button>
          <div class="eh-detail"></div>
        </div>
        <div class="principle-warning">
          <span class="pw-icon">&#9888;</span>
          <span class="pw-text"></span>
        </div>
        <div class="lines">
          <div class="caption">Top engine lines</div>
          <div class="line empty" data-line="1">line 1: --</div>
          <div class="line empty" data-line="2">line 2: --</div>
          <div class="line empty" data-line="3">line 3: --</div>
        </div>
        <div class="mistake-list hidden">
          <div class="ml-title">Improve your play</div>
          <div class="ml-intro">Coach notes and “Play instead” appear here first. Step through mistakes with Next / Previous, or open any row below.</div>
          <div class="ml-tour hidden" aria-label="Mistake tour">
            <span class="ml-tour-text"></span>
            <div class="ml-tour-btns">
              <button type="button" class="ml-tour-prev">Previous</button>
              <button type="button" class="ml-tour-next">Next</button>
            </div>
          </div>
          <div class="ml-lesson hidden" aria-live="polite">
            <div class="ml-lesson-top">
              <div class="ml-lesson-title">Lesson</div>
              <button type="button" class="ml-lesson-close" title="Dismiss">&times;</button>
            </div>
            <div class="ml-lesson-block"><span class="ml-lb">What went wrong</span><div class="ml-lesson-why"></div></div>
            <div class="ml-lesson-block"><span class="ml-lb">Stronger try</span><div class="ml-lesson-better"></div></div>
            <div class="ml-lesson-block"><span class="ml-lb">Practice habit</span><div class="ml-lesson-next"></div></div>
          </div>
          <div class="ml-subcap">All flagged moves</div>
          <div class="ml-body"></div>
        </div>
        <div class="summary hidden">
          <div class="sum-head">
            <span class="sum-title">Session summary</span>
            <span class="sum-sub"></span>
          </div>
          <div class="sum-acc">
            <span class="sum-acc-num">--</span>
            <span class="sum-acc-unit">accuracy</span>
          </div>
          <div class="sum-chips"></div>
        </div>
        <div class="footer" hidden>
          <!-- 0.11.0: depth moved into Settings (Batch depth). Footer kept
               as a hidden element so legacy references don't break. -->
          <input type="range" min="8" max="24" value="18" hidden />
          <span class="depth-label" hidden>18</span>
        </div>
        <div class="settings">
          <div class="row">
            <span>Batch depth</span>
            <div class="depth-control">
              <div class="seg batch-depth-seg">
                <button data-depth="14" title="Fast (14 plies)">Fast</button>
                <button data-depth="18" title="Normal (18 plies)">Normal</button>
                <button data-depth="22" title="Deep (22 plies)">Deep</button>
              </div>
              <div class="depth-slider-row">
                <input type="range" min="8" max="24" value="18" class="depth-slider-settings" />
                <span class="depth-label-settings">18</span>
              </div>
              <div class="depth-hint">Applies on the next batch run. Deeper is slower.</div>
            </div>
          </div>
          <div class="row">
            <span>Mode</span>
            <div class="seg mode-seg">
              <button data-mode="focus">Focus</button>
              <button data-mode="advanced">Advanced</button>
            </div>
          </div>
          <div class="row">
            <span>Advisor</span>
            <div class="seg advisor-seg">
              <button data-advisor="my-side">My side</button>
              <button data-advisor="both-sides">Both sides</button>
            </div>
          </div>
          <div class="row">
            <span>Theme</span>
            <div class="seg theme-seg">
              <button data-theme="dark">Dark</button>
              <button data-theme="light">Light</button>
            </div>
          </div>
          <div class="row">
            <span>Size</span>
            <div class="seg size-seg">
              <button data-size="small">S</button>
              <button data-size="medium">M</button>
              <button data-size="large">L</button>
            </div>
          </div>
          <div class="row">
            <span>Board arrows</span>
            <div class="seg arrows-seg">
              <button data-arrows="on">On</button>
              <button data-arrows="off">Off</button>
            </div>
          </div>
        </div>
        </div>
        <div class="locked">
          <div class="lk-title"><span>&#128274;</span> LASKER is paused here</div>
          <div class="lk-ctx"></div>
          <div class="lk-body">
            Engine and theory stay off during live games, daily games in progress, and puzzle attempts. Lasker only runs in learning contexts: the Analysis board, bot games, lessons, and finished-game review.
          </div>
          <a class="lk-link" target="_blank" rel="noopener noreferrer">Read chess.com's Fair Play policy &rarr;</a>
        </div>
        <div class="fp-modal">
          <div class="fp-card">
            <h2><span>&#9812;</span> LASKER - Learning mode</h2>
            <p>LASKER is a <b>learning and post-game analysis tool</b>. It helps you understand positions, review games, and explore opening theory - <b>never</b> to get an edge during a real game.</p>
            <ul>
              <li><b>Safe contexts:</b> Analysis board, bot games, lessons, finished-game review.</li>
              <li><b>Paused automatically:</b> live games, daily games in progress, puzzle attempts.</li>
              <li><b>No override:</b> there is no setting to force Lasker on during live play.</li>
            </ul>
            <label class="fp-check">
              <input type="checkbox" class="fp-check-input" />
              <span>I understand, and I will not use Lasker to assist my play during any rated or puzzle game. Using an engine during real play violates chess.com's Fair Play policy.</span>
            </label>
            <div class="fp-actions">
              <a class="fp-link" target="_blank" rel="noopener noreferrer">Fair Play policy</a>
              <button class="fp-accept" disabled>Enable Lasker</button>
            </div>
          </div>
        </div>
      `;
      this.shadow.appendChild(root);
      this.root = root;

      const q = (s) => root.querySelector(s);
      this.elements.dot = q(".dot");
      this.elements.toggle = q(".toggle");
      this.elements.barWrap = q(".bar-wrap");
      this.elements.barFill = q(".bar-fill");
      this.elements.score = q(".score");
      this.elements.status = q(".status");
      this.elements.povPill = q(".pov-pill");
      this.elements.assessment = q(".assessment");
      this.elements.assessText = q(".assess-text");
      this.elements.lastMove = q(".last-move");
      this.elements.lastMoveHeadline = q(".last-move .lm-headline");
      this.elements.lastMoveBadge = q(".last-move .badge");
      this.elements.lastMoveDetail = q(".last-move .detail");
      this.elements.clarify = q(".last-move .clarify");
      this.elements.lmBest = q(".last-move .lm-best");
      this.elements.lmBestSan = q(".last-move .lm-best-san");
      this.elements.lmBestMiss = q(".last-move .lm-best-miss");
      this.elements.lmBestNote = q(".last-move .lm-best-note");
      // 0.9.0: the big Opening card is gone. We keep a tiny inline pill
      // in Analyze so you still see "Italian Game · C50" without another
      // full card fighting for vertical space.
      this.elements.opPill = q(".op-pill");
      this.elements.opPillName = q(".op-pill-name");
      this.elements.opPillEco = q(".op-pill-eco");
      this.elements.opPillStudy = q(".op-pill-study");
      this.elements.engineHint = q(".engine-hint");
      this.elements.engineHintText = q(".eh-text");
      this.elements.engineHintMore = q(".eh-more");
      this.elements.engineHintDetail = q(".eh-detail");
      this.elements.timeline = q(".timeline");
      this.elements.timelineTrack = q(".tl-track");
      this.elements.chips = q(".chips");
      this.elements.chipKing = q(".chip-king");
      this.elements.chipDev = q(".chip-dev");
      this.elements.chipCentre = q(".chip-centre");
      this.elements.ctxPill = q(".ctx-pill");
      this.elements.collapseBtn = q(".collapse-btn");
      this.elements.locked = q(".locked");
      this.elements.lockedCtx = q(".lk-ctx");
      this.elements.lockedLink = q(".lk-link");
      this.elements.fpModal = q(".fp-modal");
      this.elements.fpCheck = q(".fp-check-input");
      this.elements.fpAccept = q(".fp-accept");
      this.elements.fpLink = q(".fp-link");
      this.elements.lines = [
        q('[data-line="1"]'),
        q('[data-line="2"]'),
        q('[data-line="3"]'),
      ];
      // 0.11.0: "Batch depth" lives in Settings now. The old footer
      // slider is kept in the tree but hidden; we bind to the Settings
      // slider as the canonical depthSlider/depthLabel so setDepth(n)
      // continues to work unchanged.
      this.elements.depthSlider = q(".depth-slider-settings");
      this.elements.depthLabel = q(".depth-label-settings");
      this.elements.batchDepthSeg = q(".batch-depth-seg");
      this.elements.riDepthNum = q(".review-idle .ri-depth-num");
      this.elements.header = q(".header");
      this.elements.settingsBtn = q(".settings-btn");
      this.elements.resetBtn = q(".reset-btn");
      this.elements.settings = q(".settings");
      this.elements.themeSeg = q(".theme-seg");
      this.elements.sizeSeg = q(".size-seg");
      this.elements.modeSeg = q(".mode-seg");
      this.elements.advisorSeg = q(".advisor-seg");
      this.elements.resizeHandle = q(".resize-handle");
      this.elements.coachEval = q(".coach-eval");
      this.elements.ceFill = q(".ce-fill");
      this.elements.ceScore = q(".ce-score");
      this.elements.principleWarning = q(".principle-warning");
      this.elements.principleWarningText = q(".pw-text");
      this.elements.summary = q(".summary");
      this.elements.summarySub = q(".sum-sub");
      this.elements.summaryAccNum = q(".sum-acc-num");
      this.elements.summaryChips = q(".sum-chips");

      // 0.8.0 / 0.9.0: Library + study-mode card + surface segmented control.
      this.elements.surfaceSeg = q(".surface-seg");
      this.elements.libPicker = q(".lib-picker");
      this.elements.libBody = q(".lib-body");
      this.elements.study = q(".study");
      this.elements.studyName = q(".study .st-name");
      this.elements.studyEco = q(".study .st-eco");
      this.elements.studyProgress = q(".study .st-progress");
      this.elements.studyDirective = q(".study .st-directive");
      this.elements.studyWhy = q(".study .st-why");
      this.elements.studyExit = q(".study .st-exit");
      this.elements.arrowsSeg = q(".arrows-seg");

      // 0.11.0: post-game batch Analyze state cards + mistake list.
      this.elements.reviewIdle = q(".review-idle");
      this.elements.reviewIdleSummary = q(".review-idle .ri-summary");
      this.elements.reviewIdleDepth = q(".review-idle .ri-depth-num");
      this.elements.reviewIdleError = q(".review-idle .ri-error");
      this.elements.reviewIdleBtn = q(".review-idle .ri-btn");
      this.elements.reviewRunning = q(".review-running");
      this.elements.reviewRunningText = q(".review-running .rr-progress-text");
      this.elements.reviewRunningFill = q(".review-running .rr-bar-fill");
      this.elements.reviewRunningEta = q(".review-running .rr-eta");
      this.elements.reviewRunningCurrent = q(".review-running .rr-current");
      this.elements.reviewRunningCancel = q(".review-running .rr-cancel");
      this.elements.reviewStale = q(".review-stale");
      this.elements.reviewStaleBtn = q(".review-stale .rs-reanalyze");
      this.elements.mistakeList = q(".mistake-list");
      this.elements.mistakeListBody = q(".mistake-list .ml-body");
      this.elements.mistakeTour = q(".mistake-list .ml-tour");
      this.elements.mistakeTourText = q(".mistake-list .ml-tour-text");
      this.elements.mistakeTourPrev = q(".mistake-list .ml-tour-prev");
      this.elements.mistakeTourNext = q(".mistake-list .ml-tour-next");
      this.elements.mistakeLesson = q(".mistake-list .ml-lesson");
      this.elements.mistakeLessonWhy = q(".mistake-list .ml-lesson-why");
      this.elements.mistakeLessonBetter = q(".mistake-list .ml-lesson-better");
      this.elements.mistakeLessonNext = q(".mistake-list .ml-lesson-next");
      this.elements.mistakeLessonClose = q(".mistake-list .ml-lesson-close");
      this.elements.reviewNav = q(".review-nav");
      this.elements.reviewNavSlider = q(".rn-slider");
      this.elements.reviewNavPlyText = q(".rn-ply-text");
      this.elements.reviewNavSync = q(".rn-sync");

      // Initial review state: idle (no cache yet).
      this.root.setAttribute("data-review-state", "idle");

      this._applyThemeVars();
      this._applySizeVars();

      this.elements.toggle.addEventListener("click", () => {
        if (this.handlers.onToggle) this.handlers.onToggle(!this.enabled);
      });
      this.elements.depthSlider.addEventListener("input", (e) => {
        const v = parseInt(e.target.value, 10);
        this.elements.depthLabel.textContent = String(v);
        if (this.handlers.onDepthChange) this.handlers.onDepthChange(v);
      });
      this.elements.settingsBtn.addEventListener("click", () => {
        this.elements.settings.classList.toggle("open");
      });
      // 0.9.1: Clean-state button -- one click wipes runtime analysis state
      // (timeline, eval cache, study, arrows) and re-kicks the engine.
      // Does NOT touch user preferences or fair-play acceptance.
      this.elements.resetBtn.addEventListener("click", () => {
        // Little tactile flash so the click is visibly acknowledged.
        this.elements.resetBtn.classList.remove("just-clicked");
        void this.elements.resetBtn.offsetWidth; // restart animation
        this.elements.resetBtn.classList.add("just-clicked");
        if (this.handlers.onResetState) {
          try { this.handlers.onResetState(); } catch (_err) {}
        }
      });
      this.elements.themeSeg.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-theme]");
        if (!btn) return;
        const t = btn.dataset.theme;
        this.setTheme(t);
        if (this.handlers.onThemeChange) this.handlers.onThemeChange(t);
      });
      this.elements.sizeSeg.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-size]");
        if (!btn) return;
        const s = btn.dataset.size;
        this.setSize(s);
        if (this.handlers.onSizeChange) this.handlers.onSizeChange(s);
      });
      this.elements.modeSeg.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-mode]");
        if (!btn) return;
        const m = btn.dataset.mode;
        this.setMode(m);
        if (this.handlers.onModeChange) this.handlers.onModeChange(m);
      });
      this.elements.advisorSeg.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-advisor]");
        if (!btn) return;
        const a = btn.dataset.advisor;
        this.setAdvisor(a);
        if (this.handlers.onAdvisorChange) this.handlers.onAdvisorChange(a);
      });
      this.elements.arrowsSeg.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-arrows]");
        if (!btn) return;
        const on = btn.dataset.arrows === "on";
        this.setArrows(on);
        if (this.handlers.onArrowsChange) this.handlers.onArrowsChange(on);
      });
      // 0.11.0: Batch depth preset buttons (Fast 14 / Normal 18 / Deep 22).
      if (this.elements.batchDepthSeg) {
        this.elements.batchDepthSeg.addEventListener("click", (e) => {
          const btn = e.target.closest("button[data-depth]");
          if (!btn) return;
          const v = parseInt(btn.dataset.depth, 10);
          if (!Number.isFinite(v)) return;
          this.setDepth(v);
          if (this.handlers.onDepthChange) this.handlers.onDepthChange(v);
        });
      }
      // 0.11.0: Review state buttons.
      if (this.elements.reviewIdleBtn) {
        this.elements.reviewIdleBtn.addEventListener("click", () => {
          if (this.elements.reviewIdleBtn.disabled) return;
          if (this.handlers.onStartBatch) {
            try { this.handlers.onStartBatch(); } catch (_err) {}
          }
        });
      }
      if (this.elements.reviewRunningCancel) {
        this.elements.reviewRunningCancel.addEventListener("click", () => {
          if (this.handlers.onCancelBatch) {
            try { this.handlers.onCancelBatch(); } catch (_err) {}
          }
        });
      }
      if (this.elements.reviewStaleBtn) {
        this.elements.reviewStaleBtn.addEventListener("click", () => {
          if (this.handlers.onReanalyze) {
            try { this.handlers.onReanalyze(); } catch (_err) {}
          }
        });
      }
      if (this.elements.mistakeListBody) {
        this.elements.mistakeListBody.addEventListener("click", (e) => {
          const jmp = e.target.closest(".ml-jump");
          if (jmp && jmp.dataset.ply != null) {
            e.preventDefault();
            const targetPly = parseInt(jmp.dataset.ply, 10);
            if (!Number.isFinite(targetPly)) return;
            const lessonPly = jmp.dataset.lessonPly != null
              ? parseInt(jmp.dataset.lessonPly, 10)
              : null;
            if (this.handlers.onMistakeNavigate) {
              try {
                this.handlers.onMistakeNavigate({
                  targetPly,
                  lessonPly: Number.isFinite(lessonPly) ? lessonPly : null,
                });
              } catch (_err) {}
            } else if (this.handlers.onJumpToPly) {
              try { this.handlers.onJumpToPly(targetPly); } catch (_err) {}
            }
            return;
          }
          const main = e.target.closest(".ml-main");
          if (main && main.dataset.ply != null) {
            const ply = parseInt(main.dataset.ply, 10);
            if (!Number.isFinite(ply)) return;
            if (this.handlers.onMistakeNavigate) {
              try { this.handlers.onMistakeNavigate({ targetPly: ply, lessonPly: ply }); } catch (_err) {}
            } else if (this.handlers.onJumpToPly) {
              try { this.handlers.onJumpToPly(ply); } catch (_err) {}
            }
          }
        });
      }
      if (this.elements.mistakeLessonClose) {
        this.elements.mistakeLessonClose.addEventListener("click", () => {
          this.setMistakeLesson(null);
        });
      }
      if (this.elements.mistakeTourPrev) {
        this.elements.mistakeTourPrev.addEventListener("click", () => {
          if (this.handlers.onMistakeTourPrev) {
            try { this.handlers.onMistakeTourPrev(); } catch (_err) {}
          }
        });
      }
      if (this.elements.mistakeTourNext) {
        this.elements.mistakeTourNext.addEventListener("click", () => {
          if (this.handlers.onMistakeTourNext) {
            try { this.handlers.onMistakeTourNext(); } catch (_err) {}
          }
        });
      }
      if (this.elements.reviewNav) {
        this.elements.reviewNav.addEventListener("click", (e) => {
          const b = e.target.closest("button[data-rn]");
          if (!b) return;
          const a = b.dataset.rn;
          if (a === "start" && this.handlers.onReviewNavStart) {
            try { this.handlers.onReviewNavStart(); } catch (_err) {}
          } else if (a === "prev" && this.handlers.onReviewNavPrev) {
            try { this.handlers.onReviewNavPrev(); } catch (_err) {}
          } else if (a === "next" && this.handlers.onReviewNavNext) {
            try { this.handlers.onReviewNavNext(); } catch (_err) {}
          } else if (a === "end" && this.handlers.onReviewNavEnd) {
            try { this.handlers.onReviewNavEnd(); } catch (_err) {}
          }
        });
      }
      if (this.elements.reviewNavSlider) {
        this.elements.reviewNavSlider.addEventListener("input", (e) => {
          const el = e.target;
          const max = parseInt(el.max, 10) || 0;
          const v = parseInt(el.value, 10) || 0;
          if (this.elements.reviewNavPlyText) {
            this.elements.reviewNavPlyText.textContent = `Ply ${v} / ${max}`;
          }
          if (this.handlers.onReviewNavSlider) {
            try { this.handlers.onReviewNavSlider(v); } catch (_err) {}
          }
        });
      }
      // 0.9.0: surface segmented control (Analyze / Learn). The controller
      // listens for onSurfaceChange so it can tear down the engine before
      // Learn takes over.
      this.elements.surfaceSeg.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-surface]");
        if (!btn) return;
        const s = btn.dataset.surface;
        this.setSurface(s);
        if (this.handlers.onSurfaceChange) this.handlers.onSurfaceChange(s);
      });
      // Library picker (delegated click): data-op-id carries the catalog
      // entry id so the controller can look the opening up and enter study mode.
      this.elements.libBody.addEventListener("click", (e) => {
        const card = e.target.closest(".lib-op");
        if (!card) return;
        const opId = card.dataset.opId;
        const catId = card.dataset.catId;
        if (this.handlers.onPickOpening) {
          try { this.handlers.onPickOpening({ opId, catId }); } catch (_err) {}
        }
      });
      this.elements.studyExit.addEventListener("click", () => {
        if (this.handlers.onExitStudy) {
          try { this.handlers.onExitStudy(); } catch (_err) {}
        }
      });
      // "Study this" pill in Analyze -- jump into Learn for the named opening.
      this.elements.opPillStudy.addEventListener("click", () => {
        if (this.elements.opPillStudy.classList.contains("disabled")) return;
        const pill = this.openingPill;
        if (!pill || !pill.catalogOpId) return;
        if (this.handlers.onStudyOpeningById) {
          try { this.handlers.onStudyOpeningById({ opId: pill.catalogOpId }); } catch (_err) {}
        }
      });
      this.elements.clarify.addEventListener("click", () => {
        this.elements.lastMove.classList.toggle("show-detail");
      });
      // Dismiss the detail popover when clicking elsewhere.
      this.shadow.addEventListener("click", (e) => {
        if (!e.target.closest(".last-move")) {
          this.elements.lastMove.classList.remove("show-detail");
        }
      });

      this.elements.collapseBtn.addEventListener("click", () => {
        this.setCollapsed(!this.collapsed);
      });
      // Clicking anywhere on the (now tiny) header while collapsed expands us.
      this.elements.header.addEventListener("click", (e) => {
        if (!this.collapsed) return;
        if (e.target.closest(".toggle") || e.target.closest(".icon-btn") ||
            e.target.closest(".collapse-btn")) return;
        this.setCollapsed(false);
      });

      this.elements.engineHintMore.addEventListener("click", () => {
        this.elements.engineHint.classList.toggle("show-detail");
        this.elements.engineHintMore.textContent =
          this.elements.engineHint.classList.contains("show-detail")
            ? "Hide details \u00ab" : "Tell me more \u00bb";
      });

      // First-run modal: only enables "Enable Lasker" after the checkbox ticks.
      this.elements.fpCheck.addEventListener("change", () => {
        this.elements.fpAccept.disabled = !this.elements.fpCheck.checked;
      });
      this.elements.fpAccept.addEventListener("click", () => {
        if (!this.elements.fpCheck.checked) return;
        this._hideFairPlayModal();
        if (this._fpAcceptCallback) {
          const cb = this._fpAcceptCallback;
          this._fpAcceptCallback = null;
          try { cb(); } catch (_err) {}
        }
      });

      // Keyboard shortcuts -- only fire when the user isn't typing in a field.
      document.addEventListener("keydown", (e) => {
        if (e.ctrlKey || e.metaKey || e.altKey) return;
        const tag = (e.target && e.target.tagName) || "";
        if (/^(INPUT|TEXTAREA|SELECT)$/.test(tag) ||
            (e.target && e.target.isContentEditable)) return;
        if (e.key === "l" || e.key === "L") {
          if (this.handlers.onToggle) this.handlers.onToggle(!this.enabled);
          e.preventDefault();
        } else if (e.key === "c" || e.key === "C") {
          this.setCollapsed(!this.collapsed);
          e.preventDefault();
        }
      });

      // Edge tab -- only shown when dock is right/bottom AND the drawer is
      // collapsed. Lives alongside `root` in the same shadow tree so themes
      // apply to it too.
      const edgeTab = document.createElement("div");
      edgeTab.className = "edge-tab";
      edgeTab.innerHTML = `
        <span class="et-chevron">&lsaquo;</span>
        <span class="et-mono">&#9822;</span>
        <span class="et-label">LASKER</span>
        <span class="et-dot"></span>
      `;
      edgeTab.title = "Open Lasker";
      edgeTab.addEventListener("click", () => this.setCollapsed(false));
      this.shadow.appendChild(edgeTab);
      this.edgeTab = edgeTab;
      this.elements.edgeTab = edgeTab;
      this.elements.edgeTabDot = edgeTab.querySelector(".et-dot");

      this._wireResize(root, this.elements.resizeHandle);
      document.body.appendChild(this.host);

      this._highlightSegs();
      this._applyCollapseVisibility();
    }

    _applyThemeVars() {
      if (!this.root) return;
      const t = THEMES[this.theme] || THEMES.dark;
      const s = this.root.style;
      s.setProperty("--bg", t.bg);
      s.setProperty("--bg-2", t.bg2);
      s.setProperty("--bg-3", t.bg3);
      s.setProperty("--fg", t.fg);
      s.setProperty("--muted", t.muted);
      s.setProperty("--accent", t.accent);
      s.setProperty("--border", t.border);
      s.setProperty("--hover", t.hover);
      s.setProperty("--track", t.track);
      s.setProperty("--white-sq", t.whiteSq);
      s.setProperty("--black-sq", t.blackSq);
    }

    _applySizeVars() {
      if (!this.root) return;
      const presetW = SIZE_WIDTHS[this.size] || SIZE_WIDTHS.medium;
      const fs = SIZE_FS[this.size] || SIZE_FS.medium;
      const barH = this.size === "small" ? 140 : this.size === "large" ? 200 : 168;
      // If the user has dragged the left edge to a custom width, that wins
      // until they explicitly pick another S/M/L preset.
      const effectiveWidth = this.customWidth != null
        ? this._clampWidth(this.customWidth)
        : presetW;
      this.root.style.width = `${effectiveWidth}px`;
      this.root.style.setProperty("--fs", `${fs}px`);
      this.root.style.setProperty("--fs-body", `${fs}px`);
      this.root.style.setProperty("--fs-display", `${fs + 2}px`);
      this.root.style.setProperty("--fs-caption", `${Math.max(10, fs - 2)}px`);
      this.root.style.setProperty("--bar-h", `${barH}px`);
    }

    _clampWidth(w) {
      const maxW = Math.min(MAX_WIDTH_CAP, Math.floor(window.innerWidth * 0.8));
      return Math.max(MIN_WIDTH, Math.min(maxW, w));
    }

    _highlightSegs() {
      if (!this.elements.themeSeg) return;
      for (const b of this.elements.themeSeg.querySelectorAll("button")) {
        b.classList.toggle("active", b.dataset.theme === this.theme);
      }
      for (const b of this.elements.sizeSeg.querySelectorAll("button")) {
        b.classList.toggle("active", b.dataset.size === this.size);
      }
      if (this.elements.modeSeg) {
        for (const b of this.elements.modeSeg.querySelectorAll("button")) {
          b.classList.toggle("active", b.dataset.mode === this.mode);
        }
      }
      if (this.elements.advisorSeg) {
        for (const b of this.elements.advisorSeg.querySelectorAll("button")) {
          b.classList.toggle("active", b.dataset.advisor === this.advisor);
        }
      }
      if (this.elements.arrowsSeg) {
        for (const b of this.elements.arrowsSeg.querySelectorAll("button")) {
          const isOn = b.dataset.arrows === "on";
          b.classList.toggle("active", isOn === this.showArrows);
        }
      }
      if (this.elements.surfaceSeg) {
        for (const b of this.elements.surfaceSeg.querySelectorAll("button")) {
          b.classList.toggle("active", b.dataset.surface === this.surface);
        }
      }
    }

    _applyCollapseVisibility() {
      if (!this.root || !this.edgeTab) return;
      if (this.collapsed) {
        this.root.classList.add("drawer-closed");
        this.edgeTab.classList.add("show");
        // One-shot attention pulse so the tab catches the eye the first time
        // it appears. Automatically removed so it doesn't loop forever.
        this.edgeTab.classList.add("attention");
        if (this._attentionTimer) clearTimeout(this._attentionTimer);
        this._attentionTimer = setTimeout(() => {
          this.edgeTab.classList.remove("attention");
        }, 3200);
      } else {
        this.root.classList.remove("drawer-closed");
        this.edgeTab.classList.remove("show", "attention");
      }
    }

    setMode(m) {
      this.mode = m === "advanced" ? "advanced" : "focus";
      if (this.root) {
        this.root.classList.remove("mode-focus", "mode-advanced");
        this.root.classList.add(`mode-${this.mode}`);
      }
      this._highlightSegs();
    }

    setAdvisor(a) {
      this.advisor = a === "both-sides" ? "both-sides" : "my-side";
      this._highlightSegs();
    }

    setWidth(px) {
      if (px == null || !Number.isFinite(px)) {
        this.customWidth = null;
      } else {
        this.customWidth = this._clampWidth(px);
      }
      this._applySizeVars();
    }

    setArrows(on) {
      this.showArrows = !!on;
      this._highlightSegs();
    }

    // 0.9.0: flip the top-level surface between "analyze" (engine review)
    // and "learn" (Opening Library + Study). The controller is responsible
    // for actually starting/stopping the engine.
    setSurface(s) {
      this.surface = s === "learn" ? "learn" : "analyze";
      if (this.root) {
        this.root.classList.remove("surface-analyze", "surface-learn");
        this.root.classList.add(`surface-${this.surface}`);
      }
      this._highlightSegs();
      // Entering Learn with no selected opening: make sure the picker is
      // rendered so the user sees the catalog straight away.
      if (this.surface === "learn" && this.elements.libBody && !this.elements.libBody.children.length) {
        this._renderCatalog();
      }
    }

    // Show / hide the slim opening-name pill in Analyze. Pass null to hide.
    //
    // pill = null | { name, eco, catalogOpId?: string }
    //   catalogOpId -- if set, the "Study this" button is enabled and
    //                  jumping into Learn will pick that catalog entry.
    setOpeningPill(pill) {
      this.openingPill = pill || null;
      const el = this.elements.opPill;
      if (!el) return;
      if (!pill || !pill.name) {
        el.classList.remove("show");
        return;
      }
      el.classList.add("show");
      this.elements.opPillName.textContent = pill.name;
      this.elements.opPillEco.textContent = pill.eco || "";
      this.elements.opPillEco.style.display = pill.eco ? "" : "none";
      // Only enable the CTA when we actually have a matching catalog entry
      // to flip into Learn with.
      const canStudy = !!pill.catalogOpId;
      this.elements.opPillStudy.classList.toggle("disabled", !canStudy);
      this.elements.opPillStudy.title = canStudy
        ? "Open this opening in Learn mode"
        : "This opening isn't in the curated library yet";
    }

    setCatalog(catalog) {
      this.catalog = catalog || { categories: [] };
      // Picker is inline now (0.9.0) -- just render whenever the catalog
      // changes. If the picker element doesn't exist yet (early boot) we
      // bail and the first setSurface("learn") will render it.
      if (this.elements.libBody) {
        this._renderCatalog();
      }
    }

    // Render or clear the Study-mode directive card.
    //
    // study = null | {
    //   name, eco,
    //   totalPly, currentPly,
    //   state: "active" | "complete" | "off-book",
    //   nextSan, nextWhy, whoseTurn: "you" | "opponent",
    // }
    setStudy(study) {
      const el = this.elements.study;
      if (!el) return;
      if (!study || !study.name) {
        el.classList.remove("show", "state-complete", "state-off");
        return;
      }
      el.classList.add("show");
      el.classList.remove("state-complete", "state-off");
      if (study.state === "complete") el.classList.add("state-complete");
      if (study.state === "off-book") el.classList.add("state-off");

      this.elements.studyName.textContent = study.name;
      this.elements.studyEco.textContent = study.eco || "";
      this.elements.studyEco.style.display = study.eco ? "" : "none";

      // Progress dots.
      const total = Math.max(0, study.totalPly | 0);
      const curr = Math.max(0, Math.min(total, study.currentPly | 0));
      this.elements.studyProgress.innerHTML = "";
      for (let i = 0; i < total; i++) {
        const d = document.createElement("span");
        let cls = "st-dot";
        if (i < curr) cls += " done";
        else if (i === curr) cls += " now";
        d.className = cls;
        this.elements.studyProgress.appendChild(d);
      }

      // Directive line.
      const kindEl = el.querySelector(".st-kind");
      if (study.state === "complete") {
        if (kindEl) kindEl.textContent = "Completed";
        this.elements.studyDirective.textContent =
          "You've played through the whole sequence — keep going with engine hints, or pick another opening.";
      } else if (study.state === "off-book") {
        if (kindEl) kindEl.textContent = "Off book";
        this.elements.studyDirective.textContent =
          "You (or your opponent) left the study line. The book move would have been " +
          (study.expectedSan || "different") + ". Lasker will keep coaching the position.";
      } else if (study.nextSan) {
        if (kindEl) kindEl.textContent = study.whoseTurn === "opponent" ? "Expected reply" : "Your move";
        const whoseText = study.whoseTurn === "opponent"
          ? "Opponent should play "
          : "Play ";
        this.elements.studyDirective.innerHTML =
          whoseText + `<span class="st-move"></span>.`;
        this.elements.studyDirective.querySelector(".st-move").textContent = study.nextSan;
      } else {
        if (kindEl) kindEl.textContent = "Studying";
        this.elements.studyDirective.textContent = "";
      }

      this.elements.studyWhy.textContent = study.nextWhy || study.why || "";
      this.elements.studyWhy.style.display = (study.nextWhy || study.why) ? "" : "none";
    }

    _renderCatalog() {
      const body = this.elements.libBody;
      if (!body) return;
      body.innerHTML = "";
      if (!this.catalog || !Array.isArray(this.catalog.categories) || this.catalog.categories.length === 0) {
        const empty = document.createElement("div");
        empty.style.color = "var(--muted)";
        empty.style.fontStyle = "italic";
        empty.textContent = "Catalog not loaded yet — try again in a moment.";
        body.appendChild(empty);
        return;
      }
      for (const cat of this.catalog.categories) {
        const catEl = document.createElement("div");
        catEl.className = "lib-cat";
        const head = document.createElement("div");
        head.className = "lib-cat-head";
        head.textContent = cat.label || cat.id || "Uncategorised";
        catEl.appendChild(head);
        if (cat.blurb) {
          const blurb = document.createElement("div");
          blurb.className = "lib-cat-blurb";
          blurb.textContent = cat.blurb;
          catEl.appendChild(blurb);
        }
        const grid = document.createElement("div");
        grid.className = "lib-grid";
        for (const op of (cat.openings || [])) {
          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "lib-op";
          btn.dataset.opId = op.id;
          btn.dataset.catId = cat.id;
          btn.innerHTML = `
            <div class="lib-op-head">
              <span class="lib-op-name"></span>
              <span class="lib-op-eco"></span>
            </div>
            <div class="lib-op-moves"></div>
            <div class="lib-op-blurb"></div>
            <div class="lib-op-why"></div>
            <div class="lib-op-tags"></div>
          `;
          btn.querySelector(".lib-op-name").textContent = op.name || op.id;
          btn.querySelector(".lib-op-eco").textContent = op.eco || "";
          btn.querySelector(".lib-op-moves").textContent =
            (op.moves || []).slice(0, 6).map((m, i) =>
              i % 2 === 0 ? `${Math.floor(i / 2) + 1}. ${m}` : m
            ).join(" ");
          btn.querySelector(".lib-op-blurb").textContent = op.blurb || "";
          btn.querySelector(".lib-op-why").textContent = op.why || "";
          const tagsEl = btn.querySelector(".lib-op-tags");
          for (const t of (op.tags || [])) {
            const tagEl = document.createElement("span");
            tagEl.className = "lib-tag";
            tagEl.textContent = t;
            tagsEl.appendChild(tagEl);
          }
          grid.appendChild(btn);
        }
        catEl.appendChild(grid);
        body.appendChild(catEl);
      }
    }

    setEngineThinking(on) {
      this.engineThinking = !!on;
      if (!this.elements.edgeTabDot) return;
      this.elements.edgeTabDot.classList.toggle("on", this.enabled && !this.engineThinking);
      this.elements.edgeTabDot.classList.toggle("thinking", this.enabled && this.engineThinking);
    }

    _wireResize(root, handle) {
      if (!handle) return;
      let dragging = false;
      let startX = 0;
      let startWidth = 0;
      handle.addEventListener("mousedown", (e) => {
        dragging = true;
        startX = e.clientX;
        startWidth = root.getBoundingClientRect().width;
        handle.classList.add("dragging");
        e.preventDefault();
      });
      window.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        // Dragging the left edge to the LEFT grows the drawer; to the right
        // shrinks it. So the delta is (startX - clientX).
        const newW = this._clampWidth(startWidth + (startX - e.clientX));
        this.customWidth = newW;
        root.style.width = `${newW}px`;
      });
      window.addEventListener("mouseup", () => {
        if (!dragging) return;
        dragging = false;
        handle.classList.remove("dragging");
        if (this.handlers.onWidthChange) {
          try { this.handlers.onWidthChange(this.customWidth); } catch (_err) {}
        }
      });
    }

    setTheme(t) {
      this.theme = t === "light" ? "light" : "dark";
      this._applyThemeVars();
      this._highlightSegs();
    }

    setSize(s) {
      this.size = ["small", "medium", "large"].includes(s) ? s : "medium";
      // Explicit preset pick wipes any custom-drag width -- clicking L must
      // snap to the L preset regardless of earlier drag.
      this.customWidth = null;
      if (this.handlers.onWidthChange) {
        try { this.handlers.onWidthChange(null); } catch (_err) {}
      }
      this._applySizeVars();
      this._highlightSegs();
    }

    setEnabled(on) {
      this.enabled = !!on;
      if (!this.elements.toggle) return;
      this.elements.toggle.classList.toggle("on", this.enabled);
      this.elements.dot.classList.toggle("on", this.enabled);
      if (this.elements.edgeTabDot) {
        this.elements.edgeTabDot.classList.toggle("on", this.enabled && !this.engineThinking);
        this.elements.edgeTabDot.classList.toggle("thinking", this.enabled && this.engineThinking);
      }
      if (!this.enabled) {
        this.setStatus("off");
        this.clearAnalysis();
      } else {
        // 0.11.0: no live engine anymore. The controller will set a more
        // specific status (e.g. "ready to review") as soon as it picks
        // up the board and repaints the idle card.
        this.setStatus("waiting for game...");
      }
    }

    setStatus(text) {
      if (!this.elements.status) return;
      this.elements.status.textContent = text;
    }

    setDepth(n) {
      const v = Math.max(8, Math.min(24, Number(n) || 18));
      if (this.elements.depthSlider) {
        this.elements.depthSlider.value = String(v);
        this.elements.depthLabel.textContent = String(v);
      }
      // Light up the matching preset button if the value is exactly on
      // one of our presets; otherwise clear all actives (the slider
      // itself shows the chosen value).
      if (this.elements.batchDepthSeg) {
        for (const b of this.elements.batchDepthSeg.querySelectorAll("button")) {
          const d = parseInt(b.dataset.depth, 10);
          b.classList.toggle("active", d === v);
        }
      }
      if (this.elements.riDepthNum) {
        this.elements.riDepthNum.textContent = String(v);
      }
      this.currentDepth = v;
    }

    // 0.11.0: Post-game batch Analyze state machine.
    //
    //   status: "idle" | "running" | "ready" | "stale"
    //   payload (optional): {
    //     moveCount, result, playerColor, depth,
    //     hasMoveList, error   (idle-only)
    //   }
    setReviewState(status, payload) {
      const allowed = new Set(["idle", "running", "ready", "stale"]);
      const next = allowed.has(status) ? status : "idle";
      if (this.root) this.root.setAttribute("data-review-state", next);
      const p = payload || {};

      if (next === "idle" && this.elements.reviewIdle) {
        const mc = p.moveCount | 0;
        const res = p.result ? p.result : null;
        const col = p.playerColor === "b" ? "BLACK" : "WHITE";
        const hasMoves = mc > 0 && (p.hasMoveList !== false);
        if (this.elements.reviewIdleSummary) {
          if (hasMoves) {
            // Normal happy-path summary: X moves, player colour, result.
            const parts = [];
            parts.push(`<span class="ri-tag">${mc} ${mc === 1 ? "move" : "moves"}</span>`);
            parts.push(`You played <b>${col}</b>`);
            if (res) parts.push(`Result <b>${escapeHtml(res)}</b>`);
            else parts.push("Result pending");
            this.elements.reviewIdleSummary.innerHTML = parts.join(" &middot; ");
          } else {
            // Empty-state copy: tell the user *what to do* rather than
            // showing "0 moves . You played WHITE" which reads like a bug.
            this.elements.reviewIdleSummary.innerHTML =
              "No chess.com move list detected on this page. " +
              "Open a <b>finished</b> game (or the analysis board with a PGN loaded), " +
              "then come back -- the button below will light up automatically.";
          }
        }
        if (this.elements.reviewIdleDepth) {
          this.elements.reviewIdleDepth.textContent = String(p.depth || this.currentDepth || 18);
        }
        if (this.elements.reviewIdleBtn) {
          this.elements.reviewIdleBtn.disabled = !hasMoves;
          this.elements.reviewIdleBtn.textContent = hasMoves
            ? "Analyze this game"
            : "Waiting for a game...";
        }
        if (this.elements.reviewIdle) {
          this.elements.reviewIdle.classList.toggle("has-error", !!p.error);
          if (this.elements.reviewIdleError) {
            this.elements.reviewIdleError.textContent = p.error || "";
          }
        }
      }

      if (next === "running" && this.elements.reviewRunning) {
        // The running card is mostly repainted by setReviewProgress.
        // Only reset fields here so the transition doesn't show stale
        // text from a previous run.
        if (this.elements.reviewRunningText) {
          this.elements.reviewRunningText.textContent = "0 / 0 plies";
        }
        if (this.elements.reviewRunningFill) {
          this.elements.reviewRunningFill.style.width = "0%";
        }
        if (this.elements.reviewRunningEta) {
          this.elements.reviewRunningEta.textContent = "estimating...";
        }
        if (this.elements.reviewRunningCurrent) {
          this.elements.reviewRunningCurrent.textContent = "";
        }
      }

      if (next === "stale" && this.elements.reviewStale) {
        // No per-instance data for stale -- the copy is fixed.
      }
    }

    setReviewProgress(progress) {
      if (!this.elements.reviewRunning) return;
      const p = progress || {};
      const done = Math.max(0, p.done | 0);
      const total = Math.max(1, p.total | 0);
      const pct = Math.min(100, Math.round((done / total) * 100));
      if (this.elements.reviewRunningText) {
        this.elements.reviewRunningText.textContent =
          `${done} / ${total} plies (${pct}%)`;
      }
      if (this.elements.reviewRunningFill) {
        this.elements.reviewRunningFill.style.width = `${pct}%`;
      }
      if (this.elements.reviewRunningEta) {
        if (p.etaSec === null || p.etaSec === undefined) {
          this.elements.reviewRunningEta.textContent = "estimating...";
        } else if (p.etaSec <= 1) {
          this.elements.reviewRunningEta.textContent = "almost done";
        } else {
          this.elements.reviewRunningEta.textContent = `~${p.etaSec}s remaining`;
        }
      }
      if (this.elements.reviewRunningCurrent) {
        const ply = p.currentPly | 0;
        const san = p.currentSan ? ` &middot; ${escapeHtml(p.currentSan)}` : "";
        this.elements.reviewRunningCurrent.innerHTML = ply > 0
          ? `analyzing ply ${ply}${san}`
          : "warming up engine...";
      }
    }

    setReviewNav(nav) {
      const n = nav || {};
      const max = Math.max(0, n.maxPly | 0);
      const ply = Math.max(0, Math.min(max, n.ply | 0));
      const syncing = !!n.syncing;
      if (this.elements.reviewNavSlider) {
        const sl = this.elements.reviewNavSlider;
        sl.max = String(max);
        sl.value = String(ply);
      }
      if (this.elements.reviewNavPlyText) {
        this.elements.reviewNavPlyText.textContent = `Ply ${ply} / ${max}`;
      }
      if (this.elements.reviewNavSync) {
        this.elements.reviewNavSync.style.display = syncing ? "inline" : "none";
      }
    }

    setMistakeList(entries) {
      this.setMistakeLesson(null);
      if (!this.elements.mistakeList) return;
      const body = this.elements.mistakeListBody;
      if (!body) return;
      body.innerHTML = "";
      if (!Array.isArray(entries) || entries.length === 0) {
        this.elements.mistakeList.classList.add("hidden");
        return;
      }
      this.elements.mistakeList.classList.remove("hidden");
      for (const e of entries) {
        const row = document.createElement("div");
        row.className = `ml-row sev-${e.severity || "inaccuracy"}`;
        const plyAfter = e.plyAfter != null ? e.plyAfter : e.ply;
        const plyBefore = e.plyBefore != null ? e.plyBefore : null;
        row.title =
          plyBefore != null
            ? `Open lesson · before ply ${plyBefore} · after ply ${plyAfter}`
            : `Open lesson · ply ${plyAfter}`;
        const miss = e.missedText
          ? `<span class="ml-miss">${escapeHtml(e.missedText)}</span>`
          : "";
        const beforeBtn =
          plyBefore != null && Number.isFinite(plyBefore)
            ? `<button type="button" class="ml-jump" data-ply="${plyBefore}" data-lesson-ply="${plyAfter}" title="Go to the position before this move (lesson stays on this mistake)">Before</button>`
            : "";
        row.innerHTML = `
          <button type="button" class="ml-main" data-ply="${plyAfter}"
            title="Jump here and show why this move hurt">
            <span class="ml-move">${escapeHtml(e.moveLabel || "")}</span>
            <span class="ml-label">${escapeHtml(e.label || "")}</span>
            <span class="ml-badge">${escapeHtml(e.badge || "")}</span>
            ${miss}
          </button>
          <div class="ml-actions">
            ${beforeBtn}
            <button type="button" class="ml-jump" data-ply="${plyAfter}" data-lesson-ply="${plyAfter}"
              title="Jump to position after this move and show the lesson">After</button>
          </div>
        `;
        body.appendChild(row);
      }
    }

    setMistakeLesson(lesson) {
      const box = this.elements.mistakeLesson;
      if (!box) return;
      const tourEl = this.elements.mistakeTour;
      if (!lesson || (!lesson.why && !lesson.better && !lesson.next)) {
        box.classList.add("hidden");
        if (this.elements.mistakeLessonWhy) this.elements.mistakeLessonWhy.textContent = "";
        if (this.elements.mistakeLessonBetter) this.elements.mistakeLessonBetter.textContent = "";
        if (this.elements.mistakeLessonNext) this.elements.mistakeLessonNext.textContent = "";
        if (tourEl) tourEl.classList.add("hidden");
        if (this.elements.mistakeTourPrev) this.elements.mistakeTourPrev.disabled = true;
        if (this.elements.mistakeTourNext) this.elements.mistakeTourNext.disabled = true;
        return;
      }
      const tour = lesson.tour;
      if (tourEl) {
        if (tour && tour.total > 0 && tour.index > 0) {
          tourEl.classList.remove("hidden");
          if (this.elements.mistakeTourText) {
            this.elements.mistakeTourText.textContent =
              tour.total === 1 ? "Mistake 1 of 1" : `Mistake ${tour.index} of ${tour.total}`;
          }
          if (this.elements.mistakeTourPrev) {
            this.elements.mistakeTourPrev.disabled = tour.index <= 1;
          }
          if (this.elements.mistakeTourNext) {
            this.elements.mistakeTourNext.disabled = tour.index >= tour.total;
          }
        } else {
          tourEl.classList.add("hidden");
          if (this.elements.mistakeTourPrev) this.elements.mistakeTourPrev.disabled = true;
          if (this.elements.mistakeTourNext) this.elements.mistakeTourNext.disabled = true;
        }
      }
      box.classList.remove("hidden");
      if (this.elements.mistakeLessonWhy) {
        this.elements.mistakeLessonWhy.textContent = lesson.why || "";
      }
      if (this.elements.mistakeLessonBetter) {
        this.elements.mistakeLessonBetter.textContent = lesson.better || "";
      }
      if (this.elements.mistakeLessonNext) {
        this.elements.mistakeLessonNext.textContent = lesson.next || "";
      }
      try {
        box.scrollIntoView({ block: "nearest", behavior: "smooth" });
      } catch (_e) {}
    }

    setAssessment(a) {
      if (!this.elements.assessment) return;
      if (!a || !a.label) {
        this.elements.assessment.classList.add("hidden");
        this._lastAssessLabel = null;
        return;
      }
      this.elements.assessment.classList.remove("hidden");
      this.elements.assessment.className = `assessment sev-${a.severity || "neutral"}`;
      this.elements.assessText.textContent = a.label;
      // Cache so the next setEvaluation call can render the same label as
      // the caption of the inline coach-eval strip.
      this._lastAssessLabel = a.label;
    }

    setLastMove(m) {
      if (!this.elements.lastMove) return;
      const headline = (m && (m.headline || m.label)) || "";
      if (!m || !headline) {
        this.elements.lastMove.classList.add("hidden");
        this.elements.lastMove.classList.remove("show-detail");
        if (this.elements.lmBestNote) {
          this.elements.lmBestNote.textContent = "";
          this.elements.lmBestNote.classList.remove("visible");
        }
        return;
      }
      this.elements.lastMove.classList.remove("hidden");
      if (this.elements.lastMoveHeadline) {
        this.elements.lastMoveHeadline.textContent = headline;
        this.elements.lastMoveHeadline.className = `lm-headline sev-${m.severity || "neutral"}`;
      }
      this.elements.lastMoveBadge.textContent = m.badge || "";
      this.elements.lastMoveBadge.className = `badge sev-${m.severity || "neutral"}`;
      this.elements.lastMoveDetail.textContent = m.detail || "";

      if (this.elements.lmBestNote) {
        const note = m.bestLineNote || "";
        this.elements.lmBestNote.textContent = note;
        this.elements.lmBestNote.classList.toggle("visible", !!note);
      }

      if (this.elements.lmBest) {
        if (m.bestSan) {
          this.elements.lmBest.classList.remove("hidden");
          this.elements.lmBestSan.textContent = m.bestSan;
          this.elements.lmBestMiss.textContent = m.missedText
            ? "\u00b7 " + m.missedText
            : "";
        } else {
          this.elements.lmBest.classList.add("hidden");
          this.elements.lmBestSan.textContent = "";
          this.elements.lmBestMiss.textContent = "";
        }
      }
    }

    // 0.10.0: Session summary card.
    // data = { counts: {severity -> n}, total, accuracy, scope } | null
    // Null hides the card (e.g. on reset or on Learn surface).
    setSummary(data) {
      const root = this.elements.summary;
      if (!root) return;
      if (!data || !data.total) {
        root.classList.add("hidden");
        return;
      }
      root.classList.remove("hidden");
      const sub = this.elements.summarySub;
      if (sub) {
        const moves = data.total === 1 ? "move" : "moves";
        const scopeNote = data.scope === "my-side" ? " \u00b7 your moves" : "";
        sub.textContent = `${data.total} ${moves}${scopeNote}`;
      }
      const accEl = this.elements.summaryAccNum;
      if (accEl) {
        accEl.textContent = data.accuracy === null || data.accuracy === undefined
          ? "--"
          : `${data.accuracy}%`;
      }
      const chipsEl = this.elements.summaryChips;
      if (chipsEl) {
        const order = [
          "brilliant", "great", "best", "good", "book",
          "inaccuracy", "mistake", "blunder",
        ];
        const labels = {
          brilliant: "Brilliant", great: "Great", best: "Best", good: "Good",
          book: "Book", inaccuracy: "Inaccuracy", mistake: "Mistake", blunder: "Blunder",
        };
        chipsEl.textContent = "";
        for (const sev of order) {
          const n = (data.counts && data.counts[sev]) | 0;
          const chip = document.createElement("span");
          chip.className = `sum-chip sev-${sev}` + (n > 0 ? " nonzero" : "");
          const label = document.createElement("span");
          label.className = "sc-label";
          label.textContent = labels[sev];
          const count = document.createElement("span");
          count.className = "sc-count";
          count.textContent = `\u00d7${n}`;
          chip.appendChild(label);
          chip.appendChild(count);
          chipsEl.appendChild(chip);
        }
      }
    }

    // Back-compat shim so any caller still invoking setOpening() funnels
    // into the new slim opening-pill API. 0.9.0 dropped the big Opening
    // card -- callers should prefer setOpeningPill() directly.
    setOpening(op) {
      if (!op || !op.name) { this.setOpeningPill(null); return; }
      this.setOpeningPill({
        name: op.name,
        eco: op.eco || "",
        catalogOpId: op.catalogOpId || null,
      });
    }

    // Wikipedia's "Go" endpoint: if the exact page exists it redirects
    // straight there, otherwise it shows the search results. Works for any
    // opening name without us hard-coding URL slugs.
    _wikipediaUrl(name) {
      if (!name) return null;
      // Strip variation suffix after ":" so we link to the parent article.
      const base = name.split(":")[0].trim();
      if (!base) return null;
      const q = encodeURIComponent(`${base} chess`);
      return `https://en.wikipedia.org/w/index.php?title=Special:Search&go=Go&search=${q}`;
    }

    _lichessAnalysisUrl(fen) {
      if (!fen) return null;
      // Lichess expects underscores in place of spaces in its analysis URL.
      const safe = fen.replace(/\s+/g, "_");
      return `https://lichess.org/analysis/standard/${safe}`;
    }

    setEngineHint(hint) {
      const el = this.elements.engineHint;
      if (!el) return;
      if (!hint || !hint.text) {
        el.classList.add("hidden");
        el.classList.remove("show-detail", "muted");
        this.elements.engineHintMore.textContent = "Tell me more \u00bb";
        return;
      }
      el.classList.remove("hidden");
      el.classList.toggle("muted", !!hint.muted);
      this.elements.engineHintText.textContent = hint.text;

      if (hint.detail) {
        this.elements.engineHintDetail.textContent = hint.detail;
        this.elements.engineHintMore.style.display = "";
      } else {
        this.elements.engineHintDetail.textContent = "";
        this.elements.engineHintMore.style.display = "none";
        el.classList.remove("show-detail");
      }
    }

    // Inline compact eval strip, rendered inside the coach bubble in focus mode.
    // Called from setEvaluation with the already-formatted score + signed
    // advantage percent (0-100 from white's perspective).
    _updateCoachEval(text, whiteAdvantagePct, playerColor, assessLabel) {
      const el = this.elements.coachEval;
      if (!el) return;
      if (text == null) {
        el.classList.remove("visible");
        return;
      }
      el.classList.add("visible");
      this.elements.ceScore.textContent = text;
      // Convert 0-100 white percent into a centered-bar fill. 50% = even.
      // Positive pct - white is winning; fill grows to the right of centre.
      // From the player's perspective we flip if they play black.
      const youPct = playerColor === "b"
        ? 100 - whiteAdvantagePct
        : whiteAdvantagePct;
      const delta = youPct - 50;            // -50 ... +50
      const fill = this.elements.ceFill;
      if (delta >= 0) {
        fill.style.left = "50%";
        fill.style.right = "";
        fill.style.width = `${Math.min(50, delta)}%`;
      } else {
        fill.style.right = "50%";
        fill.style.left = "";
        fill.style.width = `${Math.min(50, Math.abs(delta))}%`;
      }
      if (assessLabel) {
        this.elements.coachEval.querySelector(".ce-label").textContent = assessLabel;
      }
    }

    // ------- Principle chips (king safety / development / centre) -------
    setPrinciples(p) {
      const el = this.elements.chips;
      if (!el) return;
      this._renderPrincipleWarning(p);
      if (!p) {
        el.classList.add("hidden");
        return;
      }
      el.classList.remove("hidden");
      this._paintChip(this.elements.chipKing, {
        safe:     { cls: "status-good",    label: "King: castled",  title: "King is castled - good safety." },
        home:     { cls: "status-partial", label: "King: home",     title: "King is still on its starting square; consider castling soon." },
        exposed:  { cls: "status-bad",     label: "King exposed",   title: "King has walked off its home square without castling; watch for attacks." },
      }[p.king] || { cls: "status-partial", label: "King: ?", title: "" });

      this._paintChip(this.elements.chipDev, {
        good:    { cls: "status-good",    label: "Developed",  title: "Most minor pieces (knights + bishops) are off their starting squares." },
        partial: { cls: "status-partial", label: "Developing", title: "Some minor pieces are still on their starting squares." },
        none:    { cls: "status-bad",     label: "Undeveloped", title: "No minor pieces have moved yet; get your knights and bishops out." },
      }[p.development] || { cls: "status-partial", label: "Develop: ?", title: "" });

      this._paintChip(this.elements.chipCentre, {
        good: { cls: "status-good", label: "Centre held", title: "You have a pawn on the central d4/e4/d5/e5 squares." },
        weak: { cls: "status-bad",  label: "Weak centre", title: "No central pawn; consider claiming space with e4/d4 (or e5/d5 as Black)." },
      }[p.centre] || { cls: "status-partial", label: "Centre: ?", title: "" });
    }

    // Silent-unless-bad: only shown in focus mode when at least one of the
    // three principles is in a bad state. Picks the single most urgent
    // warning so we never spam the user.
    _renderPrincipleWarning(p) {
      const el = this.elements.principleWarning;
      const textEl = this.elements.principleWarningText;
      if (!el || !textEl) return;
      if (!p) { el.classList.remove("show"); return; }

      // Priority order: exposed king > no development > weak centre.
      let warning = null;
      if (p.king === "exposed") {
        warning = "King exposed - castle or walk it to safety soon.";
      } else if (p.development === "none") {
        warning = "No pieces developed - get your knights and bishops out.";
      } else if (p.king === "home" && p.development === "good") {
        warning = "King still on e-file - time to castle.";
      } else if (p.centre === "weak" && p.development === "partial") {
        warning = "Weak centre - claim d4/e4 (or d5/e5) before your opponent does.";
      }
      if (!warning) { el.classList.remove("show"); return; }
      textEl.textContent = warning;
      el.classList.add("show");
    }

    _paintChip(chipEl, info) {
      if (!chipEl) return;
      // Preserve the stable identity class (e.g. "chip-king") while swapping
      // the status class ("status-good" | "status-partial" | "status-bad").
      const idClass = [...chipEl.classList].find(
        (c) => c.startsWith("chip-") && c !== "chip-dot"
      ) || "";
      chipEl.className = `chip ${idClass} ${info.cls}`.trim();
      const labelEl = chipEl.querySelector(".chip-label");
      if (labelEl) labelEl.textContent = info.label;
      chipEl.title = info.title || "";
    }

    // ------- Move timeline --------------------------------------------------
    pushTimelineMove(m) {
      if (!m || !this.elements.timelineTrack) return;
      const dot = document.createElement("span");
      dot.className = `tl-dot sev-${m.severity || "neutral"} ${m.color || ""}`;
      dot.title = m.label
        ? `Ply ${m.ply}${m.color ? " (" + (m.color === "w" ? "White" : "Black") + ")" : ""}: ${m.label}`
        : `Ply ${m.ply}`;
      this.elements.timelineTrack.appendChild(dot);
      this.elements.timeline.classList.remove("hidden");
      // Auto-scroll to latest so the current move is always visible.
      this.elements.timeline.scrollLeft = this.elements.timeline.scrollWidth;
    }

    resetTimeline() {
      if (!this.elements.timelineTrack) return;
      this.elements.timelineTrack.innerHTML = "";
      this.elements.timeline.classList.add("hidden");
    }

    // ------- Fair-play context / locked state -------------------------------
    setContext(ctx) {
      this.context = ctx || { kind: "other", label: "Unknown", safe: false };
      if (!this.root) return;

      this.root.classList.toggle("ctx-unsafe", !this.context.safe);

      // Header context pill -- green when safe, red when locked.
      const pill = this.elements.ctxPill;
      if (pill) {
        pill.classList.remove("safe", "unsafe");
        pill.classList.add(this.context.safe ? "safe" : "unsafe");
        pill.textContent = this.context.safe
          ? (this.context.kind === "analysis" ? "analysis"
             : this.context.kind === "review" ? "review"
             : this.context.kind === "bot" ? "bot"
             : this.context.kind === "lesson" ? "lesson"
             : "safe")
          : "paused";
        pill.title = `${this.context.label} - engine ${this.context.engineAllowed ? "allowed" : "blocked"}`;
      }

      // Locked body copy + policy link.
      if (this.elements.lockedCtx) {
        this.elements.lockedCtx.textContent = `Detected: ${this.context.label}`;
      }
      if (this.elements.lockedLink && this.context.policyUrl) {
        this.elements.lockedLink.href = this.context.policyUrl;
      }
    }

    // ------- Collapse-to-pill ----------------------------------------------
    setCollapsed(on) {
      this.collapsed = !!on;
      if (!this.root) return;
      this._applyCollapseVisibility();
      if (this.handlers.onCollapseChange) {
        try { this.handlers.onCollapseChange(this.collapsed); } catch (_err) {}
      }
    }

    // ------- First-run fair-play modal -------------------------------------
    showFairPlayModal(onAccept, policyUrl) {
      if (!this.elements.fpModal) return;
      this._fpAcceptCallback = onAccept || null;
      this.elements.fpCheck.checked = false;
      this.elements.fpAccept.disabled = true;
      if (policyUrl) {
        this.elements.fpLink.href = policyUrl;
      }
      this.elements.fpModal.classList.add("show");
    }

    _hideFairPlayModal() {
      if (!this.elements.fpModal) return;
      this.elements.fpModal.classList.remove("show");
    }

    clearAnalysis() {
      if (!this.elements.score) return;
      this.elements.score.textContent = "--";
      this.elements.score.className = "score neutral";
      this.elements.barFill.style.height = "50%";
      this.elements.povPill.textContent = "--";
      this.setAssessment(null);
      this.setLastMove(null);
      this.setOpening(null);
      this.setEngineHint(null);
      this.setPrinciples(null);
      if (this.elements.coachEval) this.elements.coachEval.classList.remove("visible");
      for (let i = 0; i < 3; i++) {
        const el = this.elements.lines[i];
        el.className = "line empty";
        el.textContent = `line ${i + 1}: --`;
      }
    }

    // Also hide the study card -- called by the controller on locked / off
    // contexts and when the user exits study mode.
    clearStudy() { this.setStudy(null); }

    setEvaluation(evalData) {
      if (!evalData || !this.elements.score) return;
      const { scoreCp, scoreMate, depth, lines, turn, playerColor } = evalData;
      const { text, whiteAdvantagePct, cls } = this._formatMainScore(scoreCp, scoreMate, turn);
      this.elements.score.textContent = text;
      this.elements.score.className = `score ${cls}`;
      this.elements.barFill.style.height = `${100 - whiteAdvantagePct}%`;
      this.setStatus(`depth ${depth}`);

      // Inline compact eval for focus-mode coach bubble.
      this._updateCoachEval(text, whiteAdvantagePct, playerColor, this._lastAssessLabel);

      // Flip the bar so the player's color sits on the bottom.
      if (playerColor === "b") {
        this.elements.barWrap.classList.add("black-bottom");
        this.elements.povPill.textContent = "BLACK";
      } else {
        this.elements.barWrap.classList.remove("black-bottom");
        this.elements.povPill.textContent = playerColor === "w" ? "WHITE" : "--";
      }

      const list = Array.isArray(lines) ? lines : [];
      for (let i = 0; i < 3; i++) {
        const el = this.elements.lines[i];
        const ln = list[i];
        if (!ln) {
          el.className = "line empty";
          el.textContent = `line ${i + 1}: --`;
          continue;
        }
        el.className = "line";
        const scoreText = this._formatLineScore(ln.scoreCp, ln.scoreMate, turn);
        const moveText = (ln.pv || []).slice(0, 8).join(" ");
        el.innerHTML = `<span class="lscore"></span><span class="lmoves"></span>`;
        el.querySelector(".lscore").textContent = scoreText;
        el.querySelector(".lmoves").textContent = moveText;
      }
    }

    _formatMainScore(scoreCp, scoreMate, turn) {
      let whiteCp = null;
      let whiteMate = null;
      if (scoreMate !== null && scoreMate !== undefined) {
        whiteMate = turn === "w" ? scoreMate : -scoreMate;
      } else if (scoreCp !== null && scoreCp !== undefined) {
        whiteCp = turn === "w" ? scoreCp : -scoreCp;
      }
      if (whiteMate !== null) {
        const pct = whiteMate > 0 ? 100 : 0;
        return { text: formatMate(whiteMate), whiteAdvantagePct: pct, cls: "" };
      }
      if (whiteCp !== null) {
        const clamped = Math.max(-1000, Math.min(1000, whiteCp));
        const pct = 50 + (clamped / 1000) * 50;
        return { text: formatCp(whiteCp), whiteAdvantagePct: pct, cls: "" };
      }
      return { text: "--", whiteAdvantagePct: 50, cls: "neutral" };
    }

    _formatLineScore(scoreCp, scoreMate, turn) {
      if (scoreMate !== null && scoreMate !== undefined) {
        const m = turn === "w" ? scoreMate : -scoreMate;
        return formatMate(m);
      }
      if (scoreCp !== null && scoreCp !== undefined) {
        const cp = turn === "w" ? scoreCp : -scoreCp;
        return formatCp(cp);
      }
      return "--";
    }
  }

  window.LaskerOverlay = new Overlay();
})();
