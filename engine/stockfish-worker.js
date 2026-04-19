// Thin wrapper around the Stockfish WASM Web Worker.
//
// Loads `engine/stockfish.js` (bundled with the extension) as a Worker.
// The Stockfish Emscripten loader reads the wasm path from `self.location.hash`,
// so we pass the wasm URL as a hash fragment to keep paths unambiguous.
//
// Exposes window.LaskerEngine as an instance controller:
//   const engine = new LaskerEngine({ onLine, onInfo, onBestMove, onError });
//   await engine.init(); // sends uci, waits for "uciok"; sets MultiPV
//   engine.analyze(fen, depth); // stops any prior search, starts fresh
//   engine.stop();
//   engine.terminate();

(function () {
  "use strict";

  // After `chrome://extensions` → Reload, existing tabs keep running their
  // old content scripts; `chrome.runtime.getURL` then throws "Extension
  // context invalidated." Callers should stop polling and ask the user to
  // refresh the chess.com tab.
  function extensionContextAlive() {
    try {
      chrome.runtime.getURL("/");
      return true;
    } catch (_e) {
      return false;
    }
  }

  function parseInfoLine(line) {
    // Parses a Stockfish "info ..." line into a structured object.
    // We only care about depth, multipv, score (cp/mate), and pv.
    const tokens = line.split(/\s+/);
    if (tokens[0] !== "info") return null;

    const info = {
      depth: null,
      multipv: 1,
      scoreCp: null,
      scoreMate: null,
      pv: [],
    };

    for (let i = 1; i < tokens.length; i++) {
      const t = tokens[i];
      switch (t) {
        case "depth":
          info.depth = parseInt(tokens[++i], 10);
          break;
        case "multipv":
          info.multipv = parseInt(tokens[++i], 10);
          break;
        case "score": {
          const kind = tokens[++i];
          const val = parseInt(tokens[++i], 10);
          if (kind === "cp") info.scoreCp = val;
          else if (kind === "mate") info.scoreMate = val;
          break;
        }
        case "pv":
          info.pv = tokens.slice(i + 1);
          i = tokens.length;
          break;
        default:
          break;
      }
    }

    if (info.depth === null) return null;
    if (info.scoreCp === null && info.scoreMate === null) return null;
    return info;
  }

  class LaskerEngine {
    constructor(opts = {}) {
      this.onLine = opts.onLine || null;
      this.onInfo = opts.onInfo || null;
      this.onBestMove = opts.onBestMove || null;
      this.onError = opts.onError || null;
      this.multiPv = opts.multiPv || 3;

      this.worker = null;
      this.ready = false;
      this._pendingReady = null;
      this._analyzing = false;
    }

    init() {
      if (this.ready) return Promise.resolve();
      if (this._pendingReady) return this._pendingReady;

      this._pendingReady = this._initAsync();
      return this._pendingReady;
    }

    // Content scripts run in the page's origin, so Chrome refuses to let us
    // construct `new Worker("chrome-extension://...")` directly. We work around
    // this by fetching the script as text (allowed via web_accessible_resources)
    // and spawning the Worker from a Blob URL. The Stockfish Emscripten loader
    // reads the wasm URL from `self.location.hash`, so we pass the wasm's
    // chrome-extension URL in the hash -- that fetch works fine from a blob:
    // Worker because the wasm is also web-accessible.
    async _initAsync() {
      if (!extensionContextAlive()) {
        const err = new Error(
          "Extension context invalidated. Reload this chess.com tab after updating LASKER."
        );
        if (this.onError) this.onError(err);
        throw err;
      }
      const jsUrl = chrome.runtime.getURL("engine/stockfish.js");
      const wasmUrl = chrome.runtime.getURL("engine/stockfish.wasm");

      let source;
      try {
        const resp = await fetch(jsUrl);
        if (!resp.ok) throw new Error(`fetch ${jsUrl} -> ${resp.status}`);
        source = await resp.text();
      } catch (err) {
        if (this.onError) this.onError(err);
        throw err;
      }

      const blob = new Blob([source], { type: "application/javascript" });
      const blobUrl = URL.createObjectURL(blob);
      const workerUrl = `${blobUrl}#${encodeURIComponent(wasmUrl)}`;

      try {
        this.worker = new Worker(workerUrl);
      } catch (err) {
        URL.revokeObjectURL(blobUrl);
        if (this.onError) this.onError(err);
        throw err;
      }

      this._blobUrl = blobUrl;
      this.worker.onmessage = (e) => this._onMessage(e.data);
      this.worker.onerror = (e) => {
        if (this.onError) this.onError(e.message || "worker error");
      };

      const readyPromise = new Promise((resolve) => {
        this._resolveReady = resolve;
      });

      this._send("uci");
      return readyPromise;
    }

    _onMessage(data) {
      if (typeof data !== "string") return;
      const lines = data.split("\n");
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        if (this.onLine) this.onLine(line);

        if (!this.ready && line === "uciok") {
          this._send(`setoption name MultiPV value ${this.multiPv}`);
          this._send("ucinewgame");
          this._send("isready");
          continue;
        }
        if (!this.ready && line === "readyok") {
          this.ready = true;
          if (this._resolveReady) this._resolveReady();
          continue;
        }

        if (line.startsWith("info")) {
          const info = parseInfoLine(line);
          if (info && this.onInfo) this.onInfo(info);
          continue;
        }

        if (line.startsWith("bestmove")) {
          this._analyzing = false;
          const parts = line.split(/\s+/);
          const best = parts[1];
          if (this.onBestMove) this.onBestMove(best);
        }
      }
    }

    _send(cmd) {
      if (!this.worker) return;
      this.worker.postMessage(cmd);
    }

    setMultiPv(n) {
      this.multiPv = n;
      if (this.ready) this._send(`setoption name MultiPV value ${n}`);
    }

    async analyze(fen, depth) {
      if (!this.ready) await this.init();
      if (this._analyzing) this._send("stop");
      this._analyzing = true;
      this._send(`position fen ${fen}`);
      this._send(`go depth ${depth}`);
    }

    stop() {
      if (!this.worker) return;
      this._send("stop");
      this._analyzing = false;
    }

    terminate() {
      if (!this.worker) return;
      try {
        this._send("quit");
      } catch (_) {}
      try {
        this.worker.terminate();
      } catch (_) {}
      if (this._blobUrl) {
        try { URL.revokeObjectURL(this._blobUrl); } catch (_) {}
        this._blobUrl = null;
      }
      this.worker = null;
      this.ready = false;
      this._pendingReady = null;
      this._analyzing = false;
    }
  }

  window.LaskerEngine = LaskerEngine;
  window.LaskerParseInfo = parseInfoLine;
  window.LaskerExtensionContext = { alive: extensionContextAlive };
})();
