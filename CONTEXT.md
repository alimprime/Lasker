# ChessMate -- Project Context

This document is the living "state of the project" reference. It captures
what ChessMate is, how it's built, where every piece lives, how to run it,
and the known limitations and next steps. Keep it up to date when you
change the architecture.

Current version: **0.2.1**

---

## 1. What this project is

**ChessMate** is a Chrome extension (Manifest V3) that adds a live chess
position evaluation overlay to **chess.com**. When enabled, it:

- Reads the current board state from the chess.com page DOM
- Runs Stockfish 18 (WebAssembly) locally in the user's browser
- Queries the Lichess Opening Explorer for theory names and popular moves
- Displays everything in a small floating panel injected into the page

All engine analysis is done **locally**. The only network call is to
`explorer.lichess.ovh` for opening theory (public, free, no auth).
That fetch is proxied through the extension's background service
worker because Lichess sometimes 401s requests coming from the
`https://www.chess.com` origin. No account, no API keys, no telemetry.

### What the overlay shows (top to bottom)

1. **Header** with the title, a dot status indicator, a settings gear, and
   the ON/OFF toggle.
2. **Evaluation** section: the vertical eval bar on the left (flipped so
   the player's color sits at the bottom), the numeric score from
   white's perspective (e.g. `+1.35`, `-0.80`, `M3`), a small depth
   status line, and a `You [WHITE|BLACK]` caption making the player
   perspective explicit.
3. **Assessment line** -- human-readable summary of the position, e.g.
   "Balanced", "White has a slight edge", "Black is completely winning",
   "White mates in 5". Color-coded by severity.
4. **Last move line** -- quality of the move just played, computed from
   the eval swing: **Brilliant !!**, **Great move !**, **Best**,
   **Good move**, **Book move**, **Inaccuracy ?!**, **Mistake ?**,
   **Blunder ??**. Includes a `?` "clarify" button that expands to show
   the raw delta, e.g. `Eval (from mover): +0.20 -> -1.50 (Δ -1.70)`.
5. **Opening section** (only during the first ~24 plies): opening name,
   ECO code, and a row of pill-shaped top theory moves (from master
   games in the Lichess database).
6. **Top engine lines** -- up to 3 principal variations, each with its
   own score and the first ~8 plies in UCI notation.
7. **Depth slider** (8 to 22) controlling Stockfish search depth.
8. **Settings panel** (toggled via the gear):
    - Theme: **Dark / Light**
    - Size: **Small (280px) / Medium (340px) / Large (480px)**

### Intended use

ChessMate is a **learning and post-game analysis tool**. It is NOT meant
for use during live rated games -- that violates chess.com's Fair Play
policy and can result in account closure. The README states this
explicitly.

---

## 2. Final folder structure

```
ChessMate/
├── manifest.json                   MV3 manifest
├── background.js                   Service worker; toolbar icon -> toggle
├── package.json / package-lock.json  npm (only used to pull Stockfish)
├── .gitignore                      ignores node_modules, .DS_Store, *.zip
├── README.md                       User-facing install + usage
├── CONTEXT.md                      This file
├── content/
│   ├── board-reader.js             DOM -> FEN extraction
│   ├── analysis-labels.js          pure helpers: assessPosition + classifyMove
│   ├── opening-book.js             Lichess Opening Explorer client (cached)
│   ├── overlay.js                  Shadow-DOM panel (theme + size aware)
│   ├── overlay.css                 stub (all styles live in Shadow DOM)
│   └── content.js                  controller: poll loop + orchestration
├── engine/
│   ├── stockfish.js                Stockfish 18 Lite single-thread loader (~20KB)
│   ├── stockfish.wasm              Stockfish WASM binary (~7MB)
│   └── stockfish-worker.js         UCI handshake + info parser (Blob-worker)
├── icons/
│   ├── icon16.png / icon48.png / icon128.png
│   └── make_icons.py               placeholder icon generator (stdlib)
└── node_modules/                   gitignored; source of engine/stockfish.*
```

Total extension bundle size: approximately 7.4 MB (dominated by the WASM
binary).

---

## 3. Architecture at a glance

```
┌──────────────────────────────────────────────────────────────────────┐
│                         chess.com page (tab)                         │
│                                                                      │
│  ┌──────────────────┐                                                │
│  │ board-reader.js  │───> <wc-chess-board> / <chess-board> DOM       │
│  └──────────────────┘                                                │
│           │                                                          │
│           │ fen, hash                                                │
│           ▼                                                          │
│  ┌──────────────────────────┐   UCI    ┌────────────────────────┐    │
│  │ content.js (controller)  │──────────> engine/stockfish-worker│    │
│  │                          │<──────── (Blob: Worker -> wasm)   │    │
│  └──┬──┬────────────────────┘  info     └────────────────────────┘   │
│     │  │  fen                                                        │
│     │  └──────> opening-book.js ──fetch──> explorer.lichess.ovh      │
│     │                                                                │
│     │ assessPosition / classifyMove (pure fn in analysis-labels.js)  │
│     ▼                                                                │
│  ┌──────────────────┐                                                │
│  │ overlay.js       │  theme, size, settings persist in storage      │
│  │ (Shadow DOM UI)  │                                                │
│  └──────────────────┘                                                │
└──────────────────────────────────────────────────────────────────────┘
                               │ chrome.runtime
                               ▼
                      ┌──────────────────┐
                      │  background.js   │  (toolbar icon -> toggle msg)
                      └──────────────────┘
```

### Why this layout

- **Stockfish Lite single-threaded** is used. It's ~7 MB and needs no
  SharedArrayBuffer or cross-origin isolation, so it runs as a Web
  Worker directly from the content script -- no offscreen document.
- **Blob-based Worker**. Chrome MV3 refuses to construct
  `new Worker("chrome-extension://...")` from a content script running
  on `https://www.chess.com`. We fetch the Stockfish JS as text (allowed
  via `web_accessible_resources`), wrap it in a `Blob`, and spawn the
  Worker from a `blob:` URL. The wasm URL is passed to the Stockfish
  loader via the URL hash fragment.
- **Shadow DOM** overlay so chess.com's CSS can't bleed into our panel
  and vice-versa.
- **Lichess for opening theory** instead of bundling a book. The Masters
  DB is high quality, cache-friendly, and keeps the extension small.

---

## 4. File-by-file responsibilities

### `manifest.json`

Manifest V3. Declares:

- `content_scripts` matched against `https://www.chess.com/*`, loaded at
  `document_idle`. JS files are loaded in this order (later files depend
  on globals set by earlier ones):
  1. `content/board-reader.js`    -> `window.ChessMateBoardReader`
  2. `content/analysis-labels.js` -> `window.ChessMateLabels`
  3. `content/opening-book.js`    -> `window.ChessMateOpeningBook`
  4. `engine/stockfish-worker.js` -> `window.ChessMateEngine`
  5. `content/overlay.js`         -> `window.ChessMateOverlay`
  6. `content/content.js`         -> controller
- `web_accessible_resources`: `engine/stockfish.js` and `engine/stockfish.wasm`.
- `host_permissions`: `https://www.chess.com/*` and
  `https://explorer.lichess.ovh/*` (opening book).
- `permissions`: only `storage`.
- `background.service_worker`: `background.js`.
- `action`: toolbar button (icon only, no popup).

### `background.js`

MV3 service worker. Two responsibilities:

- Logs installation; listens for toolbar icon clicks
  (`chrome.action.onClicked`) and sends a `{ type: "chessmate:toggle" }`
  message to the active tab's content script.
- Proxies opening-book fetches. When a content script sends
  `{ type: "chessmate:opening", fen }`, the worker fetches
  `https://explorer.lichess.ovh/masters?fen=...` from the extension
  origin (avoiding the 401s Lichess returns for requests from
  `https://www.chess.com`) and replies with `{ ok, data }`.

### `content/board-reader.js`

`window.ChessMateBoardReader` with:

- `findBoard()` -- queries `"wc-chess-board, chess-board"`.
- `readPosition()` -- returns `{ board, grid, boardFen, flipped, hash,
  isStartPos, naiveTurn }` or `null`.
- `toFen(position, turn)` -- composes a full FEN given a `turn`
  (castling inferred from king/rook positions, en-passant always `-`).

### `content/analysis-labels.js`

`window.ChessMateLabels` with pure functions:

- `toWhitePerspective(scoreCp, scoreMate, turn)` -- flips signs so the
  caller is always reasoning from white's POV.
- `whiteValueOf(scoreCp, scoreMate)` -- single number for comparing
  positions; mate scores are mapped to sentinel values (`+/-100000`).
- `assessPosition({ scoreCp, scoreMate, turn })` -- returns
  `{ label, severity }`. Thresholds (absolute cp from white POV):
    - `< 30` -> "Position is balanced"
    - `< 80` -> "`{side}` has a slight edge"
    - `< 200` -> "`{side}` is clearly better"
    - `< 500` -> "`{side}` has a winning advantage"
    - `>= 500` -> "`{side}` is completely winning"
    - mate -> "`{side}` mates in `N`"
- `classifyMove({ prevWhiteCp, prevWhiteMate, currWhiteCp,
  currWhiteMate, mover, inBook })` -> `{ label, badge, severity, detail }`.
  Computes `delta` in centipawns from the mover's POV
  (positive = improved for the mover). `detail` is a ready-to-display
  string like `Eval (from mover): +0.20 -> -1.50 (Δ -1.70)`.
  Thresholds (checked top to bottom):
    - `delta <= -300` -> **Blunder** (`??`, severity `blunder`)
    - `delta <= -150` -> **Mistake** (`?`, severity `mistake`)
    - `delta <= -70`  -> **Inaccuracy** (`?!`, severity `inaccuracy`)
    - else if `inBook` -> **Book move** (severity `book`)
    - `delta >= 200` -> **Brilliant** (`!!`, severity `brilliant`)
    - `delta >= 80`  -> **Great move** (`!`, severity `great`)
    - `|delta| < 25` -> **Best** (severity `best`)
    - else           -> **Good move** (severity `good`)

### `content/opening-book.js`

`window.ChessMateOpeningBook` with:

- `lookup(fen)` -> `Promise<{ name, eco, moves[] } | null>`. Sends a
  `{ type: "chessmate:opening", fen }` runtime message to the background
  service worker, which performs the actual Lichess fetch from the
  extension origin. Each `moves[i]` is `{ san, uci, total, winRate, drawRate }`.
  In-memory LRU-style cache (max 256 entries) keyed by FEN.
- `isEarly(plyCount)` -> true for the first 24 plies; used by the
  controller to skip API calls once the game is past the opening phase.

### `engine/stockfish-worker.js`

`window.ChessMateEngine` class.

Initialization (async):

1. `fetch(chrome.runtime.getURL("engine/stockfish.js"))` -- gets the JS
   source as text (web-accessible fetch is allowed from content scripts).
2. Wraps the source in a `Blob`, creates a `blob:` URL.
3. `new Worker(blobUrl + "#" + encodeURIComponent(wasmUrl))` -- the
   Stockfish Emscripten loader reads the wasm URL from the hash.
4. Sends `uci` -> waits for `uciok`, then `setoption name MultiPV value 3`,
   `ucinewgame`, `isready` -> waits for `readyok`.

Runtime:

- `analyze(fen, depth)` sends `stop` (if analyzing) + `position fen ...`
  + `go depth ...`.
- `parseInfoLine` handles `info depth ... multipv ... score cp/mate ... pv ...`.
- On `bestmove`: fires `onBestMove`.
- `terminate()` sends `quit`, terminates the worker, revokes the Blob URL.

### `content/overlay.js`

`window.ChessMateOverlay` singleton.

- `mount({ onToggle, onDepthChange, onThemeChange, onSizeChange })`
  builds the DOM inside a Shadow root and wires up all the controls.
- State-updating methods:
    - `setEnabled`, `setStatus`, `setDepth`
    - `setAssessment({ label, severity })`
    - `setLastMove({ label, badge, severity, detail })` -- the
      `detail` string powers the popover shown when the user clicks the
      round `?` "clarify" button next to the move label.
    - `setOpening({ name, eco, moves })`
    - `setEvaluation({ scoreCp, scoreMate, depth, lines, turn, playerColor })`
      -- when `playerColor === "b"` the eval bar is flipped via
      `transform: scaleY(-1)` so the player's color sits at the bottom,
      and the `You [WHITE|BLACK]` caption is updated accordingly.
    - `setTheme("dark" | "light")`
    - `setSize("small" | "medium" | "large")`
    - `clearAnalysis()`
- Theme swap is implemented via CSS custom properties on the root
  element. A fixed dictionary `THEMES` holds the palette for each mode.
- Size presets (`SIZE_WIDTHS`):
    - small: 280px, 13px base font, 92px bar
    - medium: 340px, 14px base font, 112px bar
    - large: 480px, 16px base font, 148px bar
- Panel is draggable by the header (excluding the toggle and gear
  buttons).

### `content/content.js`

The controller, guarded by `window.__chessmateLoaded`.

Startup:

1. Load settings from `chrome.storage.local["chessmate.settings"]`.
   Defaults: `{ enabled: false, depth: 15, theme: "dark", size: "medium" }`.
2. Wait for the chess.com board via MutationObserver.
3. Mount the overlay with handlers for toggle / depth / theme / size.
4. Reflect settings into the UI. If `enabled`, start polling.

Polling (every 500 ms when enabled):

- Read current position hash.
- On first tick: seed `turn` (to "w" for the starting position, else from
  piece counts), seed `plyCount` (roughly `32 - total_pieces`).
- On subsequent ticks, if the hash changed: flip `turn`, increment
  `plyCount`, and call `onPositionChanged(pos)`.

`onPositionChanged(position, isFirst)` does four things:

- Freezes `state.prevEval` (the already-snapshotted eval of the prior
  position) into `state.prevRef` for use by `classifyLastMove`.
  Both are `null` on the first position of a session.
- Sets `lastMover` to the color that just moved (opposite of `turn`),
  or `null` on the first position.
- Records `state.playerColor` from `position.flipped` so the overlay can
  flip the bar and show the `You [WHITE|BLACK]` caption.
- Fires off an opening-book lookup (no await). The `inBook` boolean from
  that lookup feeds into `classifyMove` so moves that lead to a position
  in master theory can be labeled **Book move**.
- Calls the engine (`analyze(fen, depth)`).

As the engine streams `info` lines, `handleEngineInfo` stores them by
`multipv` and calls `renderEvaluation()`, which:

- Pushes the 3 lines + primary score + depth to the overlay.
- Computes and sets the "assessment" label.
- When depth reaches `max(10, desired - 3)`, snapshots the current
  white-perspective eval into `state.prevEval`. This becomes the
  reference for classifying the NEXT move's quality.

`classifyLastMove()` is called shortly after a position change using
`state.prevEval` (captured before this position) and the fresh eval.
The result is shown in the "Last move" row.

Note: on the very first position of a session there is no `prevEval`,
so no move-quality label is shown until after the first move.

---

## 5. Messaging surface

- **content <- background**: `{ type: "chessmate:toggle" }`.
- **content -> background**: `{ type: "chessmate:opening", fen }`,
  reply `{ ok: bool, data?: lichessPayload, error?: string }`.
- **background -> Lichess**: `GET https://explorer.lichess.ovh/masters?fen=...`
  with `credentials: "omit"` and the extension origin.
- **content -> worker**: UCI commands via `worker.postMessage(cmd)`.
- **worker -> content**: UCI output via `worker.onmessage`.
- **content <-> storage**: `chrome.storage.local["chessmate.settings"] =
  { enabled, depth, theme, size }`.

---

## 6. How to run / try it

### Prerequisites

- Chrome (or any Chromium-based browser with MV3 support).
- `engine/stockfish.js` + `engine/stockfish.wasm` present in the repo.
  If rebuilding from scratch, run `npm install` once and copy
  `node_modules/stockfish/bin/stockfish-18-lite-single.{js,wasm}`
  to `engine/stockfish.{js,wasm}`.

### Install unpacked

1. Open `chrome://extensions`.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select the `ChessMate/` folder.
4. Visit a chess.com page with a board (`/analysis`, `/play/*`,
   `/puzzles/*`, a specific game URL).
5. Click the ChessMate toggle in the bottom-right panel.

### Usage tips

- Click the **gear icon** to change theme or size.
- Drag the **header** to reposition the panel.
- Use the **depth slider** to trade speed vs. accuracy (8 fast, 22 deep).
- Click the ChessMate **toolbar icon** to toggle analysis without
  touching the overlay.

### Reloading after code changes

- Edit files in place (no build step).
- Go to `chrome://extensions` -> click the circular reload icon on the
  ChessMate card.
- Reload the chess.com tab.

---

## 7. Dependencies

### Runtime (bundled)

- **Stockfish 18 Lite single-threaded** (GPL-3.0).

### Runtime (network, optional)

- **Lichess Opening Explorer** `https://explorer.lichess.ovh/masters`.
  If the user is offline or the endpoint fails, the opening section
  simply stays hidden; the engine continues to work.

### Development

- **npm** -- only used to pull Stockfish; not used for bundling.
- **python3** -- only used by `icons/make_icons.py` (stdlib only).

No bundler, no transpiler, no framework. Plain ES2019+ JS.

---

## 8. Known limitations

- **Castling rights** inferred from king/rook positions (assumes they
  haven't moved if they're on their starting squares). Usually correct;
  edge cases may cost a few centipawns.
- **En passant target** always `-`. An available en-passant capture in
  the first evaluated ply is the only real consequence.
- **Half-move clock** and **full-move number** are fixed to `0` and `1`.
  Stockfish rarely needs these for correct evaluation.
- **Side-to-move** is heuristic -- flipped on every detected board
  change. Toggle OFF/ON to re-seed from piece counts.
- **Move quality on first move of a session** is not labeled (no prior
  eval to compare against).
- **MutationObserver reliability on chess.com** is known to be flaky,
  so we poll at 500 ms instead.
- **chess.com UI changes**: all DOM selectors live in `content/board-reader.js`
  so fixes are single-file.
- **Lichess opening DB is masters-only**: positions that never appeared
  in master games return no opening, even if they're from popular
  amateur theory. Switching to the `lichess` database (a different
  endpoint) is trivial if you prefer broader coverage.
- **No SAN in engine lines**: the 3 top engine lines use UCI coordinate
  notation (`e2e4`). A small FEN+UCI-to-SAN converter would fix this.

---

## 9. Testing checklist (manual)

1. Load unpacked; open a chess.com page with a board.
2. Overlay appears in the bottom-right.
3. Click the ChessMate toggle -> "thinking..." appears, then a real
   score within ~2-3 seconds.
4. Opening section shows a name + ECO + a few pill moves while in
   known theory.
5. Play or observe a move:
   - Eval updates within a poll cycle.
   - "Last move" row shows a quality label (Brilliant / Great / Best /
     Good / Book / Inaccuracy / Mistake / Blunder) with a matching `!!`,
     `!`, `?!`, `?`, or `??` badge.
   - Click the round `?` button on the right of that row to see the raw
     eval delta popover.
   - Assessment label updates.
6. Flip the board (play as black) -> the numeric score stays from
   white's perspective, but the eval bar flips so the player's color is
   on the bottom, and the `You BLACK` caption appears.
7. Click the gear:
   - Switch to Light theme -> all colors flip instantly.
   - Switch to Small (280) / Medium (340) / Large (480) -> panel width,
     font size, and bar height scale together.
   - Re-load the page -> preferences persist.
8. Opening pills:
   - In `/analysis` from the starting position, expect the opening
     section to appear after ~1-2 moves (no 401s in the console).
   - Open DevTools -> Network tab: the `explorer.lichess.ovh` requests
     should come from the **service worker**, not the page.
9. Toggle OFF -> score clears, engine worker is terminated (check the
   Chrome DevTools Memory tab).

---

## 10. Roadmap / possible next steps

- **SAN move notation** in the 3 engine lines (requires a tiny
  FEN+UCI->SAN converter or `chess.js`).
- **Best-move arrow** drawn on the actual board (like Lichess).
- **Chess.com move-list parsing** to reliably determine side-to-move,
  castling rights, en-passant target, and move number instead of
  relying on heuristics.
- **Lichess opening DB option** in settings (masters-only vs
  wider lichess DB).
- **Show theory move popularity bars** with actual win/draw/loss
  percentages in the opening pills.
- **Options page** exposing MultiPV count (1/2/3/5), search mode
  (depth vs time), engine variant (lite vs full when we figure out
  COOP/COEP in extension origin).
- **Lichess support** as a second content-script match.
- **Chrome Web Store listing** once the UI is polished.
- **Unit tests** for `parseInfoLine`, the FEN builder,
  `assessPosition`, and `classifyMove` (pure functions, Node-only).

---

## 11. Licensing

- ChessMate source code: MIT (author's choice).
- Stockfish (`engine/stockfish.{js,wasm}`): **GPL-3.0**. Any distributed
  build must comply with GPL-3.0.

---

## 12. Quick reference

- **Target site**: `https://www.chess.com/*` (www only).
- **Poll interval**: 500 ms (`POLL_MS` in `content.js`).
- **Default settings**: `{ enabled: false, depth: 15, theme: "dark", size: "medium" }`.
- **MultiPV**: 3.
- **Storage key**: `chessmate.settings` in `chrome.storage.local`.
- **Overlay root id**: `chessmate-overlay-host` (attached to `document.body`).
- **One-load guard**: `window.__chessmateLoaded` on the page.
- **Opening-book ply cutoff**: 24 plies (12 full moves) via `isEarly`.
- **Move-quality thresholds** (cp, from mover's POV):
  `>= 300` blunder, `>= 150` mistake, `>= 70` inaccuracy,
  `<= -50` great, `<= 20` good, else solid.
- **Size widths**: small 240px, medium 300px, large 380px.
- **Themes**: `THEMES` dict in `overlay.js` (dark, light).
