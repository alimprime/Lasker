# ChessMate -- Project Context

This document is the living "state of the project" reference. It captures
what ChessMate is, how it's built, where every piece lives, how to run it,
and the known limitations and next steps. Keep it up to date when you
change the architecture.

Current version: **0.4.0**

---

## 1. What this project is

**ChessMate** is a Chrome extension (Manifest V3) that adds a live chess
position evaluation overlay to **chess.com**. When enabled, it:

- Reads the current board state from the chess.com page DOM
- Runs Stockfish 18 (WebAssembly) locally in the user's browser
- Looks up opening names and named continuations in a bundled offline
  database built from the `lichess-org/chess-openings` dataset. The
  builder walks the full PGN of every one of the 3690 upstream entries,
  yielding **7601 named positions** and **5290 parent positions with
  7789 continuation pointers** -- enough depth for every mainline ply
  through at least move 10.
- Turns Stockfish's top move into a human-readable hint
  ("Play Nf3 - natural developing square; fights for the centre.
  Holds a small plus (+0.32).")
- Offers "Read on Wikipedia" and "Study on Lichess" deep-links for the
  current opening / position.
- Displays everything in a small floating panel injected into the page

The extension is **fully offline**: no network calls at runtime, no
external APIs, no account, no API keys, no telemetry.

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
5. **Opening section** (while the position is in book -- typically the
   first 10-15 plies of mainlines): opening name, ECO code, two
   read-more links ("Read on Wikipedia" goes to a Wikipedia search for
   the parent opening; "Study on Lichess" deep-links to the exact FEN
   on `lichess.org/analysis`), and a scrollable list of **named
   continuations** -- each row shows `SAN | opening name | ECO`, so the
   user can see e.g. `Nf3 | King's Knight Opening | C40` or
   `c5 | Sicilian Defense | B20`. Thanks to the full-path builder the
   list stays populated through mainline move 5+ for every major
   opening family.
6. **Stockfish suggests** section -- one-line plain-English advice
   generated from the engine's top PV move, e.g.
   *"Play Bb5 - good diagonal for the bishop. Holds a small plus
   (+0.52)."* Hidden until the engine reports a line.
7. **Top engine lines** -- up to 3 principal variations, each with its
   own score and the first ~8 plies in UCI notation.
8. **Depth slider** (8 to 22) controlling Stockfish search depth.
9. **Settings panel** (toggled via the gear):
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
├── package.json / package-lock.json  npm (Stockfish + chess.js devDep)
├── .gitignore                      ignores node_modules, .DS_Store, *.zip
├── README.md                       User-facing install + usage
├── CONTEXT.md                      This file
├── content/
│   ├── board-reader.js             DOM -> FEN extraction (also exposes grid)
│   ├── analysis-labels.js          pure helpers: assessPosition + classifyMove
│   ├── opening-book.js             offline ECO DB client
│   ├── engine-hints.js             describeMove(): UCI/SAN -> human sentence
│   ├── overlay.js                  Shadow-DOM panel (theme + size aware)
│   ├── overlay.css                 stub (all styles live in Shadow DOM)
│   └── content.js                  controller: poll loop + orchestration
├── engine/
│   ├── stockfish.js                Stockfish 18 Lite single-thread loader (~20KB)
│   ├── stockfish.wasm              Stockfish WASM binary (~7MB)
│   └── stockfish-worker.js         UCI handshake + info parser (Blob-worker)
├── data/
│   └── openings.json               pre-built ECO DB (~2.0 MB) -- names + children
├── scripts/
│   └── build-openings.mjs          one-shot builder (node, uses chess.js)
├── icons/
│   ├── icon16.png / icon48.png / icon128.png
│   └── make_icons.py               placeholder icon generator (stdlib)
└── node_modules/                   gitignored; source of engine/stockfish.*
```

Total extension bundle size: approximately 9.5 MB (7 MB WASM binary +
~2 MB openings DB).

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
│     │  └──────> opening-book.js ──fetch──> data/openings.json        │
│     │                     (offline ECO DB, 3.7k entries)             │
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
- **Bundled ECO database** (`data/openings.json`, ~965 KB) instead of
  hitting the Lichess Opening Explorer. Zero network, works offline,
  no 401s, no rate limits. The file is built ahead of time by
  `scripts/build-openings.mjs` from the public
  `lichess-org/chess-openings` dataset (CC0).

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
  4. `content/engine-hints.js`    -> `window.ChessMateEngineHints`
  5. `engine/stockfish-worker.js` -> `window.ChessMateEngine`
  6. `content/overlay.js`         -> `window.ChessMateOverlay`
  7. `content/content.js`         -> controller
- `web_accessible_resources`: `engine/stockfish.js`,
  `engine/stockfish.wasm`, and `data/openings.json`.
- `host_permissions`: `https://www.chess.com/*` only. All opening data
  is offline and Wikipedia/Lichess read-more links open in a new tab
  (no extension-side fetches needed).
- `permissions`: only `storage`.
- `background.service_worker`: `background.js`.
- `action`: toolbar button (icon only, no popup).

### `background.js`

Tiny MV3 service worker. Logs installation; listens for toolbar icon
clicks (`chrome.action.onClicked`) and sends a
`{ type: "chessmate:toggle" }` message to the active tab's content
script. No network access.

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

`window.ChessMateOpeningBook`. Pure offline lookup against the bundled
ECO database.

- On first call (or at script load) lazily fetches
  `chrome.runtime.getURL("data/openings.json")` and parses it. The DB
  has two tables:
    - `names : { [epd]: { eco, name } }` (7601 entries -- every
      terminal position of an ECO entry plus every intermediate
      position on its PGN path that nobody else claims with a more
      specific name).
    - `nextByEpd : { [parentEpd]: [{ move, san, eco, name }, ...] }`
      (5290 parent positions, 7789 total continuation pointers -- one
      per distinct `(parent, move)` pair encountered along any opening
      path. The child's displayed `name`/`eco` come from `names[childEpd]`
      so the two tables are always consistent.)
- `lookup(fen)` -> `Promise<{ name, eco, moves[] } | null>`. Computes
  the EPD from the FEN (first 4 fields), then returns the current
  position's name (if any) plus the list of named continuations sorted
  by a hand-picked `POPULAR_FAMILIES` priority list first, then ECO.
  So after `1. e4` the list opens with Sicilian / French / Caro-Kann /
  Scandinavian / Alekhine, not Barnes / Borg / Carr.
  Each `moves[i]` is `{ san, uci, eco, name, popular }`.
- `isEarly(plyCount)` -> true for the first 40 plies (i.e. through
  move 20); used by the controller to skip the lookup once the game is
  past the opening phase. The underlying DB runs out well before that,
  so this is mostly a micro-optimisation.

### `content/engine-hints.js`

`window.ChessMateEngineHints.describeMove({ san, mover, currScoreCp,
currScoreMate, inBook })` -> string.

Pure helper. Parses the SAN (produced by `content.js` via a small
UCI->pseudo-SAN converter that uses the live piece grid) and emits a
one-line sentence built from:

- **Action clause** -- "push to e4", "knight to f3", "bishop takes on
  c6", "castle short", "promote on e8".
- **Thematic clause(s)** -- good knight/bishop development squares,
  fights-for-the-centre, claims-centre-space, active queen warning,
  check / checkmate / promotion flags.
- **Eval clause** -- "retains a small plus (+0.52)", "keeps the
  balance (-0.10)", "forces mate in 3", etc. Uses White-positive cp
  but speaks from the mover's perspective.
- **Book prefix** -- "Book move: ..." when the resulting position is
  in our offline ECO database.

Intentionally approximate: we don't disambiguate (e.g. we'll say
"Nc3" even if two knights could go there) and we don't probe deeper
tactics. The section is advisory, a companion to the top engine lines.

### `data/openings.json`

Pre-built from `scripts/build-openings.mjs`. Structure:

```
{
  "version": 1,
  "source": "lichess-org/chess-openings (CC0)",
  "generatedAt": "...",
  "totalEntries": 3690,
  "names":     { "<epd>": { "eco", "name" }, ... },
  "nextByEpd": { "<epd>": [ { "move", "san", "eco", "name" } ], ... }
}
```

EPD here is the first four fields of a FEN:
`board turn castling en_passant` (no move clocks).

### `scripts/build-openings.mjs`

Developer-only Node script; run with `npm run build:openings`. Fetches
five TSVs from the `lichess-org/chess-openings` repo, parses each row
(`eco`, `name`, `pgn`), replays the SAN tokens with `chess.js`, and
populates the two indices above.

- `names`: "most specific name wins" when multiple entries share an EPD.
- `nextByEpd[parent]`: one entry per `(parent, move)` pair, sorted by
  ECO for deterministic output.
- Output path: `data/openings.json` (~965 KB raw, well under 200 KB
  gzipped).

`chess.js` is pulled in as a `devDependency` only; it is never loaded
by the extension at runtime.

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
    - `setOpening({ name, eco, moves, fen })` -- `fen` powers the
      "Study on Lichess" deep-link for the current position.
    - `setEngineHint({ text, source })` -- the "Stockfish suggests"
      section; pass `null` to hide it.
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
- **content -> worker**: UCI commands via `worker.postMessage(cmd)`.
- **worker -> content**: UCI output via `worker.onmessage`.
- **content fetch from extension origin**:
    - `chrome-extension://<id>/engine/stockfish.js` (as text, for the Blob worker)
    - `chrome-extension://<id>/data/openings.json`  (the ECO DB)
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
- `data/openings.json` present in the repo (committed). To regenerate
  from the upstream Lichess dataset, run `npm run build:openings`.

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

### Runtime (bundled, offline)

- **lichess-org/chess-openings** (CC0) -- the ECO dataset, re-packaged
  into `data/openings.json` by the build script. No runtime dependency
  on lichess.org; the data lives inside the extension.

### Development

- **npm** -- pulls Stockfish and `chess.js` (devDependency for the
  build script only).
- **node >= 18** -- for `npm run build:openings` (uses the builtin
  `fetch`).
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
- **Popularity sorting is subjective**: continuations are sorted by a
  hand-picked priority list in `content/opening-book.js`
  (`POPULAR_FAMILIES`). Openings whose name starts with a known family
  ("Sicilian Defense", "Italian Game", "Ruy Lopez", ...) bubble to the
  top; everything else falls to an "other" bucket sorted by ECO. Tweak
  the list to taste.
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
8. Opening section:
   - In `/analysis` from the starting position, the list opens with
     `e4 | King's Pawn Game`, `d4 | Queen's Pawn Game`, `c4 | English
     Opening` at the top (not Barnes / Grob / Polish).
   - Play `1. e4`: the list becomes Black's options headed by
     `c5 | Sicilian Defense`, `e6 | French Defense`, `c6 | Caro-Kann`,
     `d5 | Scandinavian`, `Nf6 | Alekhine`, ...
   - Play through `1. e4 e5 2. Nf3 Nc6 3. d4`: the panel title should
     read `Scotch Game (C44)`, with continuations `exd4` and `Nxd4`
     below.
   - Open DevTools console: you should see a single
     `[ChessMate] openings DB loaded: N named positions, M parents`
     log on first board change, and one
     `[ChessMate] opening lookup: ... continuations` per move played.
   - Open DevTools -> Network tab: the only `chrome-extension://`
     fetches should be `engine/stockfish.js` (once) and
     `data/openings.json` (once).
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
- **Optional online popularity booster**: re-enable the Lichess
  proxy (already prototyped in git history) as a secondary overlay
  showing master game counts next to each named continuation.
- **Popularity data** per continuation. Right now continuations are
  hand-sorted by family; a master-games popularity count per move
  (from a one-time dump) would give us the same effect more uniformly
  and let us surface win/draw/loss stats per move.
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
