// ChessMate on-page overlay.
//
// Floating panel attached to document.body with its own Shadow DOM so
// chess.com's CSS cannot leak in or out.
//
// Exposes window.ChessMateOverlay with:
//   mount(handlers)
//   setEnabled(bool)
//   setStatus(text)
//   setAssessment({label, severity})
//   setLastMove({label, badge, severity, detail})
//   setOpening({name, eco, moves})
//   setEvaluation({scoreCp, scoreMate, depth, lines, turn, playerColor})
//   setDepth(n)
//   setTheme("dark"|"light")
//   setSize("small"|"medium"|"large")
//   clearAnalysis()

(function () {
  "use strict";

  const SIZE_WIDTHS = { small: 280, medium: 340, large: 480 };

  const BASE_STYLE = `
    :host {
      all: initial;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .root {
      position: fixed;
      bottom: 20px;
      right: 20px;
      background: var(--bg);
      color: var(--fg);
      border: 1px solid var(--border);
      border-radius: 10px;
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
      font-size: var(--fs);
      z-index: 2147483000;
      user-select: none;
      overflow: hidden;
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
    .title {
      font-weight: 700;
      letter-spacing: 0.3px;
      font-size: var(--fs);
      display: flex;
      align-items: center;
      gap: 6px;
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
    .assessment.hidden, .last-move.hidden, .opening.hidden, .player-tip.hidden { display: none; }

    .last-move {
      font-size: calc(var(--fs));
      padding: 8px 12px;
      border-top: 1px solid var(--border);
      display: flex;
      align-items: center;
      gap: 8px;
      position: relative;
    }
    .last-move .prefix { color: var(--muted); text-transform: uppercase; letter-spacing: 0.4px; font-size: calc(var(--fs) - 3px); }
    .last-move .quality { font-weight: 800; }
    .last-move .badge {
      font-weight: 800;
      font-family: "SF Mono", Menlo, Consolas, monospace;
      margin-left: -2px;
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

    .opening {
      padding: 10px 12px;
      border-top: 1px solid var(--border);
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .opening .title-row {
      display: flex;
      align-items: baseline;
      gap: 6px;
    }
    .opening .op-name {
      font-weight: 700;
      font-size: calc(var(--fs));
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
      font-size: calc(var(--fs) - 3px);
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }
    .opening .op-moves {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .opening .op-move {
      font-family: "SF Mono", Menlo, Consolas, monospace;
      font-size: calc(var(--fs) - 1px);
      background: var(--hover);
      color: var(--fg);
      padding: 3px 9px;
      border-radius: 4px;
      border: 1px solid var(--border);
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
  `;

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
      this.elements = {};
      this.handlers = {};
      this.enabled = false;
      this.theme = "dark";
      this.size = "medium";
    }

    mount(handlers = {}) {
      if (this.host) return;
      this.handlers = handlers;

      this.host = document.createElement("div");
      this.host.id = "chessmate-overlay-host";
      this.host.style.all = "initial";
      this.shadow = this.host.attachShadow({ mode: "open" });

      const style = document.createElement("style");
      style.textContent = BASE_STYLE;
      this.shadow.appendChild(style);

      const root = document.createElement("div");
      root.className = "root";
      root.innerHTML = `
        <div class="header" data-drag>
          <div class="title"><span class="dot"></span>ChessMate</div>
          <button class="icon-btn settings-btn" title="Settings">&#9881;</button>
          <button class="toggle" title="Toggle analysis"></button>
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
          <span class="prefix">Last move</span>
          <span class="quality sev-neutral">Solid</span>
          <span class="badge"></span>
          <button class="clarify" title="Why this label?">?</button>
          <div class="detail"></div>
        </div>
        <div class="opening hidden">
          <div class="title-row">
            <span class="op-name"></span>
            <span class="op-eco"></span>
          </div>
          <div class="op-caption">Theory moves</div>
          <div class="op-moves"></div>
        </div>
        <div class="lines">
          <div class="caption">Top engine lines</div>
          <div class="line empty" data-line="1">line 1: --</div>
          <div class="line empty" data-line="2">line 2: --</div>
          <div class="line empty" data-line="3">line 3: --</div>
        </div>
        <div class="footer">
          <span>depth</span>
          <input type="range" min="8" max="22" value="15" />
          <span class="depth-label">15</span>
        </div>
        <div class="settings">
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
      this.elements.lastMoveText = q(".last-move .quality");
      this.elements.lastMoveBadge = q(".last-move .badge");
      this.elements.lastMoveDetail = q(".last-move .detail");
      this.elements.clarify = q(".last-move .clarify");
      this.elements.opening = q(".opening");
      this.elements.opName = q(".op-name");
      this.elements.opEco = q(".op-eco");
      this.elements.opMoves = q(".op-moves");
      this.elements.lines = [
        q('[data-line="1"]'),
        q('[data-line="2"]'),
        q('[data-line="3"]'),
      ];
      this.elements.depthSlider = q('input[type="range"]');
      this.elements.depthLabel = q(".depth-label");
      this.elements.header = q(".header");
      this.elements.settingsBtn = q(".settings-btn");
      this.elements.settings = q(".settings");
      this.elements.themeSeg = q(".theme-seg");
      this.elements.sizeSeg = q(".size-seg");

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
      this.elements.clarify.addEventListener("click", () => {
        this.elements.lastMove.classList.toggle("show-detail");
      });
      // Dismiss the detail popover when clicking elsewhere.
      this.shadow.addEventListener("click", (e) => {
        if (!e.target.closest(".last-move")) {
          this.elements.lastMove.classList.remove("show-detail");
        }
      });

      this._wireDrag(root, this.elements.header);
      document.body.appendChild(this.host);

      this._highlightSegs();
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
      const width = SIZE_WIDTHS[this.size] || SIZE_WIDTHS.medium;
      const fs = this.size === "small" ? 13 : this.size === "large" ? 16 : 14;
      const barH = this.size === "small" ? 92 : this.size === "large" ? 148 : 112;
      this.root.style.width = `${width}px`;
      this.root.style.setProperty("--fs", `${fs}px`);
      this.root.style.setProperty("--bar-h", `${barH}px`);
    }

    _highlightSegs() {
      if (!this.elements.themeSeg) return;
      for (const b of this.elements.themeSeg.querySelectorAll("button")) {
        b.classList.toggle("active", b.dataset.theme === this.theme);
      }
      for (const b of this.elements.sizeSeg.querySelectorAll("button")) {
        b.classList.toggle("active", b.dataset.size === this.size);
      }
    }

    _wireDrag(root, handle) {
      let dragging = false;
      let startX = 0, startY = 0, origLeft = 0, origTop = 0;
      handle.addEventListener("mousedown", (e) => {
        if (e.target.closest(".toggle") || e.target.closest(".icon-btn")) return;
        dragging = true;
        startX = e.clientX;
        startY = e.clientY;
        const rect = root.getBoundingClientRect();
        origLeft = rect.left;
        origTop = rect.top;
        root.style.right = "auto";
        root.style.bottom = "auto";
        root.style.left = `${origLeft}px`;
        root.style.top = `${origTop}px`;
        e.preventDefault();
      });
      window.addEventListener("mousemove", (e) => {
        if (!dragging) return;
        root.style.left = `${origLeft + e.clientX - startX}px`;
        root.style.top = `${origTop + e.clientY - startY}px`;
      });
      window.addEventListener("mouseup", () => { dragging = false; });
    }

    setTheme(t) {
      this.theme = t === "light" ? "light" : "dark";
      this._applyThemeVars();
      this._highlightSegs();
    }

    setSize(s) {
      this.size = ["small", "medium", "large"].includes(s) ? s : "medium";
      this._applySizeVars();
      this._highlightSegs();
    }

    setEnabled(on) {
      this.enabled = !!on;
      if (!this.elements.toggle) return;
      this.elements.toggle.classList.toggle("on", this.enabled);
      this.elements.dot.classList.toggle("on", this.enabled);
      if (!this.enabled) {
        this.setStatus("off");
        this.clearAnalysis();
      } else {
        this.setStatus("starting engine...");
      }
    }

    setStatus(text) {
      if (!this.elements.status) return;
      this.elements.status.textContent = text;
    }

    setDepth(n) {
      if (!this.elements.depthSlider) return;
      this.elements.depthSlider.value = String(n);
      this.elements.depthLabel.textContent = String(n);
    }

    setAssessment(a) {
      if (!this.elements.assessment) return;
      if (!a || !a.label) {
        this.elements.assessment.classList.add("hidden");
        return;
      }
      this.elements.assessment.classList.remove("hidden");
      this.elements.assessment.className = `assessment sev-${a.severity || "neutral"}`;
      this.elements.assessText.textContent = a.label;
    }

    setLastMove(m) {
      if (!this.elements.lastMove) return;
      if (!m || !m.label) {
        this.elements.lastMove.classList.add("hidden");
        this.elements.lastMove.classList.remove("show-detail");
        return;
      }
      this.elements.lastMove.classList.remove("hidden");
      this.elements.lastMoveText.textContent = m.label;
      this.elements.lastMoveText.className = `quality sev-${m.severity || "neutral"}`;
      this.elements.lastMoveBadge.textContent = m.badge || "";
      this.elements.lastMoveBadge.className = `badge sev-${m.severity || "neutral"}`;
      this.elements.lastMoveDetail.textContent = m.detail || "";
    }

    setOpening(op) {
      const el = this.elements.opening;
      if (!el) return;
      if (!op || !op.name) {
        el.classList.add("hidden");
        return;
      }
      el.classList.remove("hidden");
      this.elements.opName.textContent = op.name;
      this.elements.opEco.textContent = op.eco || "";
      this.elements.opEco.style.display = op.eco ? "" : "none";

      this.elements.opMoves.innerHTML = "";
      const top = (op.moves || []).slice(0, 5);
      for (const m of top) {
        const span = document.createElement("span");
        span.className = "op-move";
        span.textContent = m.san;
        span.title = `${m.total.toLocaleString()} master games`;
        this.elements.opMoves.appendChild(span);
      }
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
      for (let i = 0; i < 3; i++) {
        const el = this.elements.lines[i];
        el.className = "line empty";
        el.textContent = `line ${i + 1}: --`;
      }
    }

    setEvaluation(evalData) {
      if (!evalData || !this.elements.score) return;
      const { scoreCp, scoreMate, depth, lines, turn, playerColor } = evalData;
      const { text, whiteAdvantagePct, cls } = this._formatMainScore(scoreCp, scoreMate, turn);
      this.elements.score.textContent = text;
      this.elements.score.className = `score ${cls}`;
      this.elements.barFill.style.height = `${100 - whiteAdvantagePct}%`;
      this.setStatus(`depth ${depth}`);

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

  window.ChessMateOverlay = new Overlay();
})();
