// Board arrows overlay.
//
// Draws animated SVG arrows and square highlights directly on top of the
// chess.com board so beginners can see, visually, which piece to move and
// where. Used in two modes:
//
//   1. "Suggested move" (default): a single solid arrow showing the engine's
//      best move for the side to move.
//   2. "Plan" (2-ply animation, when enabled by the controller): a short
//      sequence -- your move -> likely opponent reply -> your follow-up --
//      animated in a loop. Each step draws after a short delay so the eye
//      can follow the line.
//
// The SVG lives in its OWN host element (not inside chess.com's DOM) so we
// never fight the board's z-index, transforms, or event handlers. It is
// positioned absolutely over the board via getBoundingClientRect() and kept
// in sync with a ResizeObserver + window scroll/resize listeners.
//
// Orientation: chess.com adds `.flipped` when Black is at the bottom.
// `isFlipped` is read from the live element each time we draw so that mid-
// game flips (orientation button) stay correct without a reload.
//
// Exposes window.LaskerBoardArrows with:
//   mount()                 -- attach the SVG host to <body>
//   setBoard(el)            -- point us at the current <wc-chess-board>
//   setVisible(bool)        -- global on/off (user can toggle in settings)
//   setOrientation(flipped) -- optional manual override
//   showBest(uci)           -- single solid arrow from uci ("e2e4")
//   showPlan(plan)          -- [{uci, kind: "my"|"reply"|"next"}, ...]
//   clear()                 -- erase all arrows immediately
//
// The module is deliberately engine-agnostic; the caller passes UCI strings.

(function () {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const HOST_ID = "lasker-arrows-host";

  // Arrow visual presets keyed by "kind".
  //   my    -- solid accent-green. The primary "play this" arrow.
  //   reply -- dashed amber. The predicted opponent reply.
  //   next  -- solid teal. Your follow-up after the predicted reply.
  const STYLES = {
    my:    { color: "#3ea966", width: 0.14, opacity: 0.95, dash: null, glow: true },
    reply: { color: "#e0b441", width: 0.11, opacity: 0.85, dash: "0.22 0.16", glow: false },
    next:  { color: "#26a3a3", width: 0.11, opacity: 0.85, dash: null, glow: false },
    // "hint" is a muted single-move preview (not part of a plan).
    hint:  { color: "#8aa4d8", width: 0.11, opacity: 0.85, dash: null, glow: false },
  };

  class BoardArrows {
    constructor() {
      this.host = null;        // .lasker-arrows-host div
      this.svg = null;         // <svg> inside host
      this.defs = null;
      this.board = null;       // current wc-chess-board element
      this.visible = true;
      this.plan = null;        // current plan (array of steps) or null
      this.animTimer = null;
      this.resizeObserver = null;
      this.mutationObserver = null;
      this.manualFlipped = null; // override; null = read from board class
      this._bound = {
        onResize: () => this._reposition(),
        onScroll: () => this._reposition(),
      };
    }

    mount() {
      if (this.host) return;
      const host = document.createElement("div");
      host.id = HOST_ID;
      // Inline styles -- no CSS file, no chance chess.com's stylesheet leaks
      // in. `pointer-events: none` is critical: clicks/drags must pass
      // through to the real board underneath.
      host.style.cssText = [
        "position: fixed",
        "top: 0",
        "left: 0",
        "width: 0",
        "height: 0",
        "pointer-events: none",
        "z-index: 2147482000", // just below the drawer (2147483000)
        "overflow: visible",
      ].join(";");

      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("viewBox", "0 0 8 8");
      svg.setAttribute("preserveAspectRatio", "none");
      svg.style.cssText = [
        "position: absolute",
        "top: 0",
        "left: 0",
        "width: 100%",
        "height: 100%",
        "overflow: visible",
      ].join(";");

      const defs = document.createElementNS(SVG_NS, "defs");
      svg.appendChild(defs);
      this._ensureMarkers(defs);

      host.appendChild(svg);
      document.body.appendChild(host);

      this.host = host;
      this.svg = svg;
      this.defs = defs;

      window.addEventListener("resize", this._bound.onResize, { passive: true });
      window.addEventListener("scroll", this._bound.onScroll, { passive: true });
    }

    // Add one arrowhead marker per colour so each arrow's tip matches its
    // stroke. Markers live in <defs> and are referenced by url(#id).
    _ensureMarkers(defs) {
      for (const [kind, s] of Object.entries(STYLES)) {
        const id = `lasker-arrowhead-${kind}`;
        if (defs.querySelector(`#${id}`)) continue;
        const m = document.createElementNS(SVG_NS, "marker");
        m.setAttribute("id", id);
        m.setAttribute("viewBox", "0 0 10 10");
        m.setAttribute("refX", "6");
        m.setAttribute("refY", "5");
        m.setAttribute("markerWidth", "4");
        m.setAttribute("markerHeight", "4");
        m.setAttribute("orient", "auto");
        const p = document.createElementNS(SVG_NS, "path");
        p.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
        p.setAttribute("fill", s.color);
        p.setAttribute("opacity", String(s.opacity));
        m.appendChild(p);
        defs.appendChild(m);
      }
    }

    setBoard(el) {
      if (this.board === el) return;
      this.board = el || null;
      if (this.resizeObserver) { this.resizeObserver.disconnect(); this.resizeObserver = null; }
      if (this.mutationObserver) { this.mutationObserver.disconnect(); this.mutationObserver = null; }
      if (!this.board) { this.clear(); return; }

      // Keep in sync with board size + orientation changes.
      try {
        this.resizeObserver = new ResizeObserver(() => this._reposition());
        this.resizeObserver.observe(this.board);
      } catch (_e) {}
      try {
        this.mutationObserver = new MutationObserver(() => {
          // Orientation-flip mutates class; piece moves mutate children.
          // We only need to reposition on attribute changes; piece children
          // are handled by the controller's poll loop via redraw calls.
          this._reposition();
        });
        this.mutationObserver.observe(this.board, { attributes: true, attributeFilter: ["class", "style"] });
      } catch (_e) {}

      this._reposition();
    }

    setVisible(on) {
      this.visible = !!on;
      if (!this.host) return;
      this.host.style.display = this.visible ? "" : "none";
      if (!this.visible) this._stopAnimation();
    }

    setOrientation(flipped) {
      this.manualFlipped = flipped == null ? null : !!flipped;
      this._redraw();
    }

    showBest(uci) {
      if (!uci || uci.length < 4) { this.clear(); return; }
      this.plan = [{ uci, kind: "my" }];
      this._stopAnimation();
      this._redraw();
    }

    showPlan(steps) {
      if (!Array.isArray(steps) || steps.length === 0) { this.clear(); return; }
      this.plan = steps.filter((s) => s && s.uci && s.uci.length >= 4);
      if (this.plan.length === 0) { this.clear(); return; }
      this._startAnimation();
    }

    clear() {
      this.plan = null;
      this._stopAnimation();
      this._clearGeometry();
    }

    // -----------------------------------------------------------------
    // Internal: positioning + drawing
    // -----------------------------------------------------------------

    _reposition() {
      if (!this.svg || !this.host) return;
      if (!this.board) { this._clearGeometry(); return; }
      const rect = this.board.getBoundingClientRect();
      if (rect.width < 10 || rect.height < 10) { this._clearGeometry(); return; }
      this.host.style.top = `${rect.top}px`;
      this.host.style.left = `${rect.left}px`;
      this.host.style.width = `${rect.width}px`;
      this.host.style.height = `${rect.height}px`;
      this._redraw();
    }

    _isFlipped() {
      if (this.manualFlipped != null) return this.manualFlipped;
      return !!(this.board && this.board.classList && this.board.classList.contains("flipped"));
    }

    // Convert "e4" to a board-coordinate point (in SVG 0..8 units) centred
    // on the square. With flipped=false, a1 is bottom-left (file 0, rank 0
    // from bottom). SVG y grows downward, so rank 0 is at y=7 (centre 7.5).
    _squareToXY(sq, flipped) {
      if (!sq || sq.length < 2) return null;
      const file = sq.charCodeAt(0) - 97;
      const rank = parseInt(sq[1], 10) - 1;
      if (!Number.isFinite(file) || file < 0 || file > 7) return null;
      if (!Number.isFinite(rank) || rank < 0 || rank > 7) return null;
      const col = flipped ? 7 - file : file;
      const row = flipped ? rank : 7 - rank;
      return { x: col + 0.5, y: row + 0.5, col, row };
    }

    _clearGeometry() {
      if (!this.svg) return;
      // Remove everything EXCEPT <defs>.
      const kids = Array.from(this.svg.childNodes);
      for (const k of kids) if (k !== this.defs) this.svg.removeChild(k);
    }

    _redraw() {
      if (!this.svg) return;
      this._clearGeometry();
      if (!this.visible || !this.plan || !this.board) return;

      const flipped = this._isFlipped();

      // If animating, we only draw steps whose index <= this.animStep.
      const cutoff = this.animStep != null ? this.animStep : this.plan.length - 1;

      for (let i = 0; i <= cutoff && i < this.plan.length; i++) {
        const step = this.plan[i];
        this._drawArrow(step.uci, step.kind || "my", flipped, i, i === cutoff);
      }
    }

    _drawArrow(uci, kind, flipped, index, isCurrent) {
      const from = this._squareToXY(uci.slice(0, 2), flipped);
      const to = this._squareToXY(uci.slice(2, 4), flipped);
      if (!from || !to) return;

      const style = STYLES[kind] || STYLES.my;

      // Highlight source square with a rounded-rect glow so the player
      // knows which piece to pick up.
      const src = document.createElementNS(SVG_NS, "rect");
      src.setAttribute("x", String(from.col + 0.04));
      src.setAttribute("y", String(from.row + 0.04));
      src.setAttribute("width", "0.92");
      src.setAttribute("height", "0.92");
      src.setAttribute("rx", "0.12");
      src.setAttribute("ry", "0.12");
      src.setAttribute("fill", "none");
      src.setAttribute("stroke", style.color);
      src.setAttribute("stroke-width", "0.06");
      src.setAttribute("opacity", String(style.opacity * 0.85));
      if (isCurrent && style.glow) {
        const pulse = document.createElementNS(SVG_NS, "animate");
        pulse.setAttribute("attributeName", "opacity");
        pulse.setAttribute("values", `${style.opacity * 0.85};${style.opacity * 0.35};${style.opacity * 0.85}`);
        pulse.setAttribute("dur", "1.6s");
        pulse.setAttribute("repeatCount", "indefinite");
        src.appendChild(pulse);
      }
      this.svg.appendChild(src);

      // Arrow shaft -- stop SHORT of the target centre so the arrowhead
      // marker sits cleanly inside the destination square.
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const len = Math.hypot(dx, dy) || 1;
      const back = 0.36; // shorten so marker fits
      const endX = to.x - (dx / len) * back;
      const endY = to.y - (dy / len) * back;

      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", String(from.x));
      line.setAttribute("y1", String(from.y));
      line.setAttribute("x2", String(endX));
      line.setAttribute("y2", String(endY));
      line.setAttribute("stroke", style.color);
      line.setAttribute("stroke-width", String(style.width));
      line.setAttribute("stroke-linecap", "round");
      line.setAttribute("opacity", String(style.opacity));
      line.setAttribute("marker-end", `url(#lasker-arrowhead-${kind})`);
      if (style.dash) line.setAttribute("stroke-dasharray", style.dash);

      // Draw-in animation on the current arrow: animate stroke-dashoffset
      // from the line length down to 0 so it looks like a fluid draw.
      if (isCurrent && !style.dash) {
        const drawLen = len - back;
        line.setAttribute("stroke-dasharray", String(drawLen));
        line.setAttribute("stroke-dashoffset", String(drawLen));
        const anim = document.createElementNS(SVG_NS, "animate");
        anim.setAttribute("attributeName", "stroke-dashoffset");
        anim.setAttribute("from", String(drawLen));
        anim.setAttribute("to", "0");
        anim.setAttribute("dur", "0.45s");
        anim.setAttribute("fill", "freeze");
        anim.setAttribute("begin", "0s");
        line.appendChild(anim);
      }

      this.svg.appendChild(line);
    }

    // -----------------------------------------------------------------
    // Plan-sequence animation: cycle through steps with delays, then
    // pause, then loop. Gives the eye time to read each arrow.
    // -----------------------------------------------------------------
    _startAnimation() {
      this._stopAnimation();
      if (!this.plan || this.plan.length === 0) return;
      if (this.plan.length === 1) { this.animStep = 0; this._redraw(); return; }

      const STEP_MS = 900;
      const LOOP_PAUSE_MS = 1600;
      let i = 0;
      this.animStep = 0;
      this._redraw();

      const tick = () => {
        i++;
        if (i >= this.plan.length) {
          // Hold the final frame, then clear and restart.
          this.animTimer = setTimeout(() => {
            i = 0;
            this.animStep = 0;
            this._redraw();
            this.animTimer = setTimeout(tick, STEP_MS);
          }, LOOP_PAUSE_MS);
          return;
        }
        this.animStep = i;
        this._redraw();
        this.animTimer = setTimeout(tick, STEP_MS);
      };
      this.animTimer = setTimeout(tick, STEP_MS);
    }

    _stopAnimation() {
      if (this.animTimer) {
        clearTimeout(this.animTimer);
        this.animTimer = null;
      }
      this.animStep = null;
    }
  }

  window.LaskerBoardArrows = new BoardArrows();
})();
