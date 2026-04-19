# LASKER -- Project Context

This document is the living "state of the project" reference. It captures
what LASKER is, how it's built, where every piece lives, how to run it,
and the known limitations and next steps. Keep it up to date when you
change the architecture.

Current version: **0.10.0**

---

## 1. What this project is

**Lasker** is a Chrome extension (Manifest V3) that adds a live chess
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

Lasker is a **learning and post-game analysis tool**. It is NOT meant
for use during live rated games -- that violates chess.com's Fair Play
policy and can result in account closure. The extension enforces this
itself: see the **Fair-Play policy** section below.

### Fair-Play policy (0.5.0+)

Lasker refuses to run anywhere a human could use it to cheat. There is
no user-facing override. The context classifier lives in
`content/fair-play.js` and hard-gates the engine, polling, and opening
theory.

| chess.com route                                       | Classified as       | Engine | Book |
|-------------------------------------------------------|---------------------|--------|------|
| `/analysis` ...                                       | `analysis`          |   YES  |  YES |
| `/play/computer`, `/play/bot` ...                     | `bot`               |   YES  |  YES |
| `/lessons` ...                                        | `lesson`            |   YES  |  YES |
| `/game/live/<id>` + game-over markers visible         | `review`            |   YES  |  YES |
| `/game/daily/<id>` + game-over markers visible        | `review`            |   YES  |  YES |
| `/game/live/<id>` (no game-over markers)              | `live-in-progress`  |   no   |  no  |
| `/game/daily/<id>` (no game-over markers)             | `daily-in-progress` |   no   |  no  |
| `/play/*`, `/live/*`                                  | `live-in-progress`  |   no   |  no  |
| `/daily/*`                                            | `daily-in-progress` |   no   |  no  |
| `/puzzles` ...                                        | `puzzle-attempt`    |   no   |  no  |
| anything else (home page, archive, profile, ...)      | `other`             |   no   |  no  |

We intentionally do **not** use chess.com's "books allowed in daily
games" carve-out -- cleanest story is "Lasker stays off during any
game in progress".

When the classifier flips to an unsafe context, `content.js` tears down
the Stockfish worker, stops the poll loop, clears the timeline, and the
overlay replaces its body with a **locked view** explaining which
context was detected plus a link to chess.com's Fair Play policy.

The first time a user toggles Lasker on, a **fair-play acknowledgement
modal** (rendered inside the overlay's Shadow DOM) blocks the action
until the user checks a box confirming they will use Lasker only for
learning / review. The acceptance flag is persisted in
`chrome.storage.local` under the key `lasker.acceptedFairPlay`; the
toggle is inert again if we ever find `enabled=true` with
`acceptedFairPlay=false` (defense in depth).

Context is re-classified on: SPA navigation (patched `pushState` /
`replaceState`), `popstate`, `hashchange`, and DOM mutations (debounced
300 ms) so that finishing a live game and seeing the game-over modal
automatically unlocks the analysis features.

### Interactive UI (0.5.0+)

- **Context pill** in the header (green "analysis"/"review"/"bot" when
  safe, red "paused" when locked).
- **Collapse-to-pill** button next to the gear: shrinks Lasker to just
  the header strip. Clicking the header while collapsed re-expands.
  Persisted via `lasker.settings.collapsed`.
- **Move timeline strip** at the top of the body: one colored dot per
  classified ply (green = best/great, yellow = inaccuracy, orange =
  mistake, red = blunder, blue = book, teal = brilliant), with a hover
  tooltip showing the ply / label. Scrollable. Auto-scrolls to latest.
- **Principle chips row** under the last-move row: three tiny
  status chips for **King safety**, **Development**, and **Centre**
  derived from the live grid. Chip tooltips explain what each status
  means and how to improve it.
- **Coach bubble** styling on the engine-hint section: white "L"
  avatar, speech-bubble border, and a **Tell me more** expander that
  reveals the top-3 PV lines with their raw numeric scores.
- **Keyboard shortcuts** (page-scoped, ignored while the user is
  typing): `L` toggles Lasker on/off, `C` collapses/expands.

### Focus mode, Advisor scope, Dock (0.6.0+)

v0.6 was driven by the feedback that the overlay was "overloaded" and the
font looked dated. Three new settings collapse the overlay into a
minimal-but-deep surface.

**Typography** -- single cross-platform stack:
`"Avenir Next", "Avenir", "Helvetica Neue", -apple-system, "Segoe UI",
"Inter", "Roboto", Arial, sans-serif`. Three size tokens derived from the
existing S/M/L size setting: `--fs-display` (score / title),
`--fs-body` (everything else), `--fs-caption` (captions / pills).

**Mode** (`lasker.settings.mode`, default `"focus"`):

| block                                     | focus | advanced |
|-------------------------------------------|:-----:|:--------:|
| Insight bubble (hint + inline eval strip) |   y   |    y     |
| Opening theory card                       |   y   |    y     |
| Last-move label + clarify                 |   y   |    y     |
| Move timeline strip                       |   y   |    y     |
| Principle warning (silent-unless-bad)     |   y   |    n     |
| Full principle chips row                  |   n   |    y     |
| Big vertical eval bar + numeric score     |   n   |    y     |
| Separate "Balanced / White has edge ..."  |   n   |    y     |
| Top engine lines (3 PVs with scores)      |   n   |    y     |
| Depth slider                              |   n   |    y     |

Focus mode is the default because a learning player mostly needs the one
next move to play, a plain-English reason, and a small eval for context.
Advanced is a one-click reveal for everything else.

**Advisor scope** (`lasker.settings.advisor`, default `"my-side"`):

| advisor      | my move graded? | opponent move graded? | Insight shows ... |
|--------------|:---------------:|:---------------------:|-------------------|
| `my-side`    |       y         |           n           | on my turn: what to play; on opponent's turn: muted "Opponent likely: Nf6" |
| `both-sides` |       y         |           y           | engine's best for whoever is to move (0.5.x behaviour) |

In `my-side`, the move timeline only collects my plies -- which makes a
review feel like *your* game's story instead of a dense dotted line.

### Brand rename, Space Grotesk, student-side arrows, deeper move review (0.10.0+)

The 0.10.0 release is a polish pass that answers four direct pieces of
user feedback in one shot.

**Rename to LASKER.** Title-case "Lasker" felt timid; the full all-caps
wordmark reads as a brand. The manifest `name` is `"LASKER"`, the header
title is `LASKER` (tracked ~0.18em, text-transform: uppercase, slightly
larger than body text), and the edge-tab label / fair-play lock / learn
mode copy all use the same casing.

**Space Grotesk replaces Inter.** The previous Inter bundle was
technically correct but nobody ever noticed it. Space Grotesk --
geometric, tighter, more distinctive counters -- actually reads
*different* from chess.com's own UI. Four weights (400 / 500 / 600 /
700) are bundled as WOFF2 in `fonts/SpaceGrotesk-*.woff2` and wired up
via `@font-face` inside the Shadow DOM. The `font-family` stack is
`"LaskerSans", "Space Grotesk", "Inter", ..., sans-serif`. The Inter
files are gone from the bundle.

**Arrows only ever point for the student.** The 0.9 build drew a dashed
"reply" arrow on the opponent's turn when `advisor=both-sides`; in
practice it confused beginners into grabbing the wrong piece. The
`renderArrows()` helper now clears the overlay whenever it isn't the
student's turn, regardless of the advisor setting. The advisor setting
still affects the Insight bubble and the last-move card (both-sides
users still get commentary on the opponent's move); only the on-board
arrow is silenced.

**Last-move card shows "Best was X \u2014 missed Y".** When the engine
settles on a position, we now snapshot *both* the eval **and** the PV's
first move (plus the grid, so we can convert the UCI back to SAN). On
the next position change that snapshot becomes `prevBestRef`. During
`classifyLastMove`, if the student's move wasn't the engine's #1, we
compute the eval delta from the mover's perspective, compare it to the
delta the engine's preferred move would have delivered, and emit
`{ bestSan, missedText }` onto the last-move result. The overlay
renders that as a second row under the label (`Best was Nxe5 \u00b7
missed +1.20`). Swings below 0.15 pawns are suppressed so "you played
the 2nd-best move within engine tolerance" doesn't spam the UI. In
mate-forced positions we show `forced M3` instead of pawn eval.

**Session summary card.** A new `.summary` block lives at the bottom of
the Analyze surface (between the engine-lines block and the depth
footer). It aggregates every graded move into a per-severity tally,
then projects that tally into:

- a big tabular-nums accuracy % (rough heuristic: per-severity points
  × 100 → mean)
- a subtitle (`"N moves \u00b7 your moves"` when `advisor=my-side`)
- a wrapping row of chips: `Brilliant \u00d71 \u00b7 Best \u00d76 \u00b7
  Good \u00d73 \u00b7 Inaccuracy \u00d71 \u00b7 Mistake \u00d70 \u00b7
  Blunder \u00d71`, colour-coded per severity

The tally lives on `state.tally` (a `{severity: {w, b}}` map) and is
cleared by `resetState()`, `applyContext(unsafe)`, `setEnabled(false)`,
and first-position bootstrap. It's hidden via `.root.surface-learn
.summary { display: none }` on Learn mode so only the review surface
sees it.

Files touched:

- `manifest.json` -- version bump, description, font resources
- `content/content.js` -- prev-best snapshot, tally, setSurface hooks
- `content/overlay.js` -- branding, font wiring, summary DOM/CSS/method,
  last-move "Best was \u2026" row, arrow gate simplification
- `fonts/SpaceGrotesk-{Regular,Medium,SemiBold,Bold}.woff2` -- new
- `fonts/Inter-*.woff2` -- deleted

### Clean-state button + bottom-gap (0.9.1+)

Two small but frequently-requested UX fixes:

**Clean state button.** A small circular-arrow icon (`\u21BA`) now lives
in the header between the collapse button and the settings gear. One
click calls the controller's `resetState()` which wipes every piece of
runtime analysis state:

- `moveTimeline` emptied, overlay timeline reset
- `prevEval`, `prevRef`, `lastMover`, `labelSnapshotted`, `timelineSeeded`
  all cleared so the next move is classified from a clean baseline
- Study mode exited (the line, the index, the off-book state)
- `currentLines`, `currentDepth`, `currentFen`, `currentGrid` nulled
- Board-arrows overlay cleared, opening pill hidden
- Stockfish worker torn down and re-spawned on the next position -- a
  reliable escape hatch for stuck depth or stale PVs

It does **not** touch user preferences (theme, size, surface, advisor,
depth slider), the fair-play acceptance flag, or the on/off toggle, so
you can reset mid-review without losing your seat. The button spins +
flashes accent green on click for immediate feedback.

**Drawer bottom-gap.** chess.com's move-navigation / prev-next
controls live in the bottom-right of the page, and the full-height
Lasker drawer was covering them. The drawer's height is now
`calc(100vh - var(--drawer-bottom-gap))` where the gap defaults to
**140px**. The bottom of the viewport is fully clickable for chess.com
UI. The edge-tab (collapsed state) lives near the top already, so it
isn't affected. If the 140px default ever needs tweaking per-user we
can promote `--drawer-bottom-gap` to a settings slider later.

### Analyze / Learn surface split + takeback-safe Study (0.9.0+)

v0.9 responds to the core complaint against 0.8: *Analyze* and *Learn*
information was fighting for the same vertical real estate, with the
old ECO "Opening theory" card redundant against the new curated
**Library**, a busy 2-ply arrow animation that was "too many arrows"
for beginners, and Study mode that desynced the moment the user used
chess.com's takeback / scrub-back.

**Two explicit surfaces, picked in the header.** A new segmented
control in the drawer header flips between:

- **Analyze** -- engine-driven post-game review. Shows the eval bar,
  score, assessment, last-move label, timeline, principle chips,
  Insight bubble, a slim opening-name pill, and the depth slider.
- **Learn** -- Opening Library + directive Study. **The engine is
  completely off** here: no Stockfish, no eval, no chips, no timeline,
  no Insight. Just the library picker and, once an opening is selected,
  the Study card.

The overlay gates visibility entirely in CSS (`.root.surface-analyze`
vs `.root.surface-learn`). The controller is responsible for actually
tearing down the engine in Learn and re-starting it when the user
flips back to Analyze. The current surface is persisted in
`chrome.storage.local` so the user gets the same mode on reload.

**Analyze: slim opening pill replaces the big Opening card.** The
previous `Opening theory` card (opening name + ECO + named
continuations list + Wikipedia/Lichess links) is gone. In its place a
single-line `op-pill` shows `<Name> <ECO>` with a **Study this ›**
button. Clicking it flips straight into Learn for that opening by
matching the book name against the catalog. If no catalog match
exists the button is greyed out (still in the book, but not in the
curated Library).

**Learn: inline Library picker + Study card.** The 0.8 modal is gone.
The library now renders inline inside the drawer body. Picking an
opening expands the moves and hands control to the Study card with
progress dots, a directive (`Play Nf3.` / `Opponent should play e5.`)
and a "why" line. An **Exit** button clears the study state and hands
the surface back to the empty picker.

**Takeback-safe Study sync (position-hash lookup).** 0.8 advanced
Study mode with a monotonic index: every time a new position arrived
we compared the last-move UCI to the expected one and incremented.
That broke the moment the user took a move back on chess.com.

0.9 replaces that with a position-hash lookup:
`LaskerOpeningBook.expandLine(sanList)` now returns `{ startHash,
line: [{ ply, san, uci, turn, hash }] }` where `hash` is a compact
64-char grid fingerprint identical in shape to what
`board-reader.js` produces for live positions. On every position
change the controller asks:

> "Where does the current grid hash sit inside this line?"

If the answer is `k ∈ [0..n]` we set `idx = k` and mark the study
`active` (or `complete` when `k === n`). If not found we mark
`off-book` and remember the last matched index so the UI can say
"the book move would have been Nf3". Takebacks, scrub-to-start, and
branching off and back are all handled uniformly -- there's no
per-event bookkeeping.

**One arrow, not three.** The 2-ply animation (my -> reply -> next ->
loop) was replaced with a single arrow chosen by surface + turn:

- Learn with active study -> the one expected ply, solid green.
- Analyze on my turn -> the engine's best move, solid green.
- Analyze on opponent's turn with advisor=my-side -> no arrow.
- Analyze on opponent's turn with advisor=both-sides -> dashed amber
  "reply" arrow (their expected best reply).

`content/board-arrows.js` still supports `showPlan()` for multi-step
sequences, but the controller only ever passes a single step in 0.9.

**Study-this round trip.** Because Analyze's opening pill carries a
catalog id, and `onStudyOpeningById` dispatches straight into
`pickOpening`, the flow is:

1. In Analyze, the student sees `Italian Game C50 [Study this ›]`.
2. One click flips to Learn + enters Study for that opening.
3. Completing the whole line keeps the student in Learn (option **(a)**
   from the 0.9 plan) -- the Study card flips to a "complete" state
   and the Library reappears below so they can pick the next line.

### Opening Library + board arrows + typography (0.8.0+)

v0.8 tackles three user-reported gaps at once: confusion about *which*
opening to play, no visual guidance on the board itself, and a font that
didn't look meaningfully different from chess.com's own UI.

**Opening Library (hand-curated)** — a new **Library** button in the
header opens a modal with four beginner-friendly categories:

- *Play as White — 1.e4* (Italian, Ruy Lopez, Scotch, Vienna, King's Gambit)
- *Play as White — 1.d4* (Queen's Gambit, London, Catalan, English)
- *Play as Black — vs 1.e4* (Najdorf, French, Caro-Kann, Scandinavian, Petrov)
- *Play as Black — vs 1.d4* (KID, QGD, Nimzo-Indian, Slav, Dutch)

Each card shows the name, ECO, the first 4-6 plies of the main line, a
one-sentence blurb, a "why you'd play this" learning note, and a small
tag strip (e.g. `classical / beginner`). Data lives in
`data/opening-catalog.json` (hand-written, ~11 KB). The overlay loads it
lazily via `LaskerOpeningBook.loadCatalog()`.

**Directive Study mode** — clicking any Library card enters a guided
walkthrough. A new **Study card** pins to the top of the drawer:

- Shows the opening name + ECO + a row of progress dots (one per ply;
  filled = done, ringed = next, hollow = upcoming).
- Names the next expected move (`Play Nf3.` or `Opponent should play
  e5.`) along with a short coaching rationale.
- If the user plays the expected UCI, the index advances; if they
  diverge, the card flips to **off-book** state and tells them what the
  book move was. A finished line flips to **complete** state.
- A small **Exit** button leaves study mode; the drawer returns to
  ordinary engine-driven analysis.

Matching is done in `content.js` by diffing the grid before and after
each position change (`diffUci`) and comparing against the pre-expanded
per-ply `{san, uci, turn}` line from `LaskerOpeningBook.expandLine`.

**Animated on-board arrows** — a new `content/board-arrows.js` module
mounts a *separate* SVG host outside chess.com's DOM, positioned over
the live `<wc-chess-board>` via `getBoundingClientRect()` and kept in
sync with `ResizeObserver` + a `MutationObserver` on the board element.
Every square is one SVG unit (viewBox `0 0 8 8`), and orientation is
read live from the board's `.flipped` class so manual mid-game flips
Just Work. `pointer-events: none` on the host ensures the real board
still receives every click and drag.

Three arrow "kinds" with distinct strokes + arrowhead markers:

- **my** (solid green, thicker, animated draw-in, pulsing source-square
  glow): the move the student should play next.
- **reply** (dashed amber): the likely opponent reply.
- **next** (solid teal): the student's follow-up after that reply.

In regular analysis the module cycles through the engine's top PV as
`my → reply → next → pause → loop`, giving the eye time to read each
arrow (`_startAnimation` in `board-arrows.js`). In Study mode the module
draws the single expected ply so the student isn't distracted by
engine-generated variations. A **Board arrows** setting in the gear menu
(`On | Off`) lets the user disable the feature entirely.

**Typography / bundled Inter** — the extension now ships the Inter
typeface as four WOFF2 weights in `fonts/` (~100 KB total). A
`buildBaseStyle(urls)` function on mount substitutes
`chrome.runtime.getURL()` URLs into four `@font-face` declarations, and
the `:host` font stack leads with `"LaskerInter"` so the overlay looks
identical on every OS. Base sizes were bumped (body 15 px, caption
12 px, display 17 px at size M) and a new `--ic-*` icon-size scale
(16/22/30/44 px) drives the Insight avatar (now 44 px), the opening
knight glyph, the edge-tab chevron, timeline dots, resource icons, etc.

### Right-only drawer + resize (0.7.0+)

v0.7 collapsed the dock setting down to a single layout: a **right-side
drawer**. Float and bottom docks were removed to reduce surface area and
eliminate an entire class of drag-positioning bugs.

- `.root` is `position: fixed; top: 0; right: 0; height: 100vh; display: flex`
- Collapsing toggles `.drawer-closed`, which transforms `translateX(100%)`
  out of the viewport (the 220 ms transition makes the slide feel fluid)
- While collapsed, the **edge tab** appears on the right edge: 44x160 px,
  containing a left chevron, the knight glyph (was "L" in 0.6), a
  vertical-rotated "LASKER" label, and the engine state dot. A one-shot
  `et-attention` keyframe pulses the tab box-shadow three times right after
  it appears so users notice it on their first collapse

| dot state   | meaning                                  |
|-------------|------------------------------------------|
| grey        | Lasker off (or analysis paused)          |
| pulsing     | engine analyzing -- animation `et-pulse` |
| solid green | engine has settled, result shown         |

A 6 px `.resize-handle` on the left edge lets the user drag-resize the
drawer:

- min width: `300 px`
- max width: `min(80vw, 900 px)`
- Custom widths persist as `lasker.settings.width` (integer px or `null`)
- Picking any S/M/L preset wipes `width` back to `null` and snaps to the
  preset (320 / 420 / 600 px respectively) -- the preset is always a
  one-click escape from a bad drag

The **Insight bubble** (renamed from "Coach" in 0.7) keeps the speech-
bubble styling and absorbs the inline eval strip in focus mode. The
avatar glyph is now a chess knight (`\265E`) on the accent green, not the
old "L" monogram, because it visually ties the overlay to the chess
domain.

The **Opening theory card** (promoted from a plain strip in 0.7) has its
own rounded container, accent left-border, and renders named continuations
as pill chips (`[3.Bb5] Ruy Lopez C60`) that wrap horizontally instead of
stacking vertically. "More resources" icon buttons (W for Wikipedia,
bishop glyph for Lichess) are labelled by a small caption above them so
they're discoverable.

---

## 2. Final folder structure

```
Lasker/
├── manifest.json                   MV3 manifest
├── background.js                   Service worker; toolbar icon -> toggle
├── package.json / package-lock.json  npm (Stockfish + chess.js devDep)
├── .gitignore                      ignores node_modules, .DS_Store, *.zip
├── README.md                       User-facing install + usage
├── CONTEXT.md                      This file
├── content/
│   ├── fair-play.js                page-context classifier (safe / unsafe gate)
│   ├── board-reader.js             DOM -> FEN extraction (also exposes grid)
│   ├── analysis-labels.js          pure helpers: assessPosition + classifyMove
│   ├── opening-book.js             offline ECO DB client + curated catalog + san->uci
│   ├── engine-hints.js             describeMove(): UCI/SAN -> human sentence
│   ├── board-arrows.js             SVG overlay drawn over <wc-chess-board> (0.8+)
│   ├── overlay.js                  Shadow-DOM panel (theme + size + timeline + library)
│   ├── overlay.css                 stub (all styles live in Shadow DOM)
│   └── content.js                  controller: poll loop + orchestration + study mode
├── engine/
│   ├── stockfish.js                Stockfish 18 Lite single-thread loader (~20KB)
│   ├── stockfish.wasm              Stockfish WASM binary (~7MB)
│   └── stockfish-worker.js         UCI handshake + info parser (Blob-worker)
├── data/
│   ├── openings.json               pre-built ECO DB (~2.0 MB) -- names + children
│   └── opening-catalog.json        hand-curated Library data (0.8+, ~12 KB)
├── fonts/
│   ├── Inter-Regular.woff2         bundled Inter weights (0.8+, ~24 KB each)
│   ├── Inter-Medium.woff2
│   ├── Inter-SemiBold.woff2
│   └── Inter-Bold.woff2
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
  1. `content/board-reader.js`    -> `window.LaskerBoardReader`
  2. `content/analysis-labels.js` -> `window.LaskerLabels`
  3. `content/opening-book.js`    -> `window.LaskerOpeningBook`
  4. `content/engine-hints.js`    -> `window.LaskerEngineHints`
  5. `engine/stockfish-worker.js` -> `window.LaskerEngine`
  6. `content/overlay.js`         -> `window.LaskerOverlay`
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
`{ type: "lasker:toggle" }` message to the active tab's content
script. No network access.

### `content/fair-play.js`

`window.LaskerFairPlay` -- the single source of truth for whether it is
ethically permissible for the extension to run on the current page.

API:

- `classify()` -> `{ kind, path, label, safe, engineAllowed, bookAllowed }`.
  Inspects `window.location.pathname` plus a basket of "game over"
  DOM selectors to decide the page context (see the policy table in
  section 1). Falls back to `"other"` (fully disabled) when uncertain.
- `subscribe(cb)` -> unsubscribe function. Fires `cb` immediately with
  the current classification and again whenever SPA navigation or a DOM
  mutation flips the result. Internally patches `history.pushState` /
  `replaceState` once and installs a debounced `MutationObserver` on
  the whole document.
- `POLICY_URL` -- the chess.com fair-play policy link shown in the
  locked view and in the first-run modal.

The file is loaded FIRST in `manifest.json` so every later module
(including the engine worker and the content controller) can depend on
it being present.

### `content/board-reader.js`

`window.LaskerBoardReader` with:

- `findBoard()` -- queries `"wc-chess-board, chess-board"`.
- `readPosition()` -- returns `{ board, grid, boardFen, flipped, hash,
  isStartPos, naiveTurn }` or `null`.
- `toFen(position, turn)` -- composes a full FEN given a `turn`
  (castling inferred from king/rook positions, en-passant always `-`).

### `content/analysis-labels.js`

`window.LaskerLabels` with pure functions:

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

`window.LaskerOpeningBook`. Pure offline lookup against the bundled
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

`window.LaskerEngineHints.describeMove({ san, mover, currScoreCp,
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

`window.LaskerEngine` class.

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

`window.LaskerOverlay` singleton.

- `mount({ onToggle, onDepthChange, onThemeChange, onSizeChange,
  onCollapseChange })` builds the DOM inside a Shadow root and wires up
  all the controls. `onToggle` is called with the DESIRED new state; the
  controller decides whether to actually flip it (e.g. the first-run
  modal may intercept).
- State-updating methods:
    - `setEnabled`, `setStatus`, `setDepth`
    - `setAssessment({ label, severity })`
    - `setLastMove({ label, badge, severity, detail })` -- the
      `detail` string powers the popover shown when the user clicks the
      round `?` "clarify" button next to the move label.
    - `setOpening({ name, eco, moves, fen })` -- `fen` powers the
      "Study on Lichess" deep-link for the current position.
    - `setEngineHint({ text, detail, source })` -- coach-bubble
      content; `detail` (optional) is rendered behind the "Tell me more"
      expander. Pass `null` to hide the bubble.
    - `setPrinciples({ king, development, centre })` -- paints the three
      principle chips. `king` in `"safe"|"home"|"exposed"`,
      `development` in `"good"|"partial"|"none"`, `centre` in
      `"good"|"weak"`. Pass `null` to hide.
    - `pushTimelineMove({ ply, severity, label, color })` -- append one
      dot to the move timeline (auto-shows the strip, auto-scrolls).
    - `resetTimeline()` -- clear all dots and hide the strip.
    - `setEvaluation({ scoreCp, scoreMate, depth, lines, turn, playerColor })`
      -- when `playerColor === "b"` the eval bar is flipped via
      `transform: scaleY(-1)` so the player's color sits at the bottom,
      and the `You [WHITE|BLACK]` caption is updated accordingly.
    - `setContext({ kind, label, safe, engineAllowed, bookAllowed, policyUrl })`
      -- paints the header context pill, and toggles the `ctx-unsafe`
      class on the root which (via CSS) hides the analysis body and
      shows the locked view.
    - `setCollapsed(bool)` -- pill mode; fires `onCollapseChange`.
    - `showFairPlayModal(onAccept, policyUrl)` -- renders the first-run
      acknowledgement modal (Shadow-DOM fixed overlay). Resolves
      `onAccept` only after the user both ticks the checkbox and
      clicks "Enable Lasker".
    - `setTheme("dark" | "light")`
    - `setSize("small" | "medium" | "large")`
    - `clearAnalysis()` (also clears principles; timeline is cleared
      separately via `resetTimeline`).
- Theme swap is implemented via CSS custom properties on the root
  element. A fixed dictionary `THEMES` holds the palette for each mode.
- Size presets (`SIZE_WIDTHS`):
    - small: 280px, 13px base font, 92px bar
    - medium: 340px, 14px base font, 112px bar
    - large: 480px, 16px base font, 148px bar
- Panel is draggable by the header (excluding the toggle and gear
  buttons).

### `content/content.js`

The controller, guarded by `window.__laskerLoaded`.

Startup:

1. Load settings from `chrome.storage.local["lasker.settings"]` and
   the fair-play acceptance flag from `chrome.storage.local["lasker.acceptedFairPlay"]`.
   Defaults: `{ enabled: false, depth: 15, theme: "dark", size: "medium", collapsed: false }`.
2. Safety gate: if `enabled=true` but `acceptedFairPlay=false`, force
   `enabled=false` so the toggle starts OFF until the modal is accepted.
3. Wait for the chess.com board via MutationObserver.
4. Mount the overlay with handlers for toggle / depth / theme / size /
   collapsed.
5. Subscribe to `LaskerFairPlay`; the subscriber callback (`applyContext`)
   is what actually drives the lifecycle -- see below.

Toggle flow (`requestEnable(on)`):

- Turning OFF: immediate `setEnabled(false)`.
- Turning ON, first time ever: show the fair-play acknowledgement modal.
  `setEnabled(true)` only runs after the user ticks the checkbox and
  clicks Enable; only then do we persist `acceptedFairPlay=true`.
- Turning ON once already accepted: `setEnabled(true)` directly.

Fair-play lifecycle (`applyContext(ctx)`):

- `ctx.safe === false` -> stop polling, tear down the Stockfish worker,
  clear the timeline and analysis, set status to `"paused (fair-play)"`.
  The overlay flips into locked view automatically via `setContext`.
- `ctx.safe === true && enabled && accepted` -> reset move-tracking
  state, clear the timeline, resume polling.

`canRun()` -- the single predicate gate -- returns true only when
`settings.enabled && acceptedFairPlay && context && context.safe`. It
is checked in `tickPoll`, `setDepth`, and by the engine path in
`onPositionChanged` (via `ctx.engineAllowed`). Book lookups are
separately gated on `ctx.bookAllowed`.

Polling (every 500 ms when active):

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

The classification is also pushed onto the move timeline **exactly
once per ply** (guarded by `state.timelineSeeded`). The controller can
be called multiple times in a tight window (snapshot branch + book
lookup) but only the first successful classification gets a dot.

`renderPrinciples()` walks `state.currentGrid` each time the engine
updates and paints the three principle chips:

- **King**: `"safe"` if on g-file or c-file of the home rank
  (castled), `"home"` if still on e-file, else `"exposed"`.
- **Development**: counts knights + bishops NOT on their starting
  squares; 3-4 moved = `"good"`, 1-2 = `"partial"`, 0 = `"none"`.
- **Centre**: `"good"` if at least one of our pawns occupies
  d4/e4/d5/e5, else `"weak"`.

Note: on the very first position of a session there is no `prevEval`,
so no move-quality label is shown until after the first move.

---

## 5. Messaging surface

- **content <- background**: `{ type: "lasker:toggle" }`.
- **content -> worker**: UCI commands via `worker.postMessage(cmd)`.
- **worker -> content**: UCI output via `worker.onmessage`.
- **content fetch from extension origin**:
    - `chrome-extension://<id>/engine/stockfish.js` (as text, for the Blob worker)
    - `chrome-extension://<id>/data/openings.json`  (the ECO DB)
- **content <-> storage**: `chrome.storage.local["lasker.settings"] =
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
3. Click **Load unpacked** and select the `Lasker/` folder.
4. Visit a chess.com page with a board (`/analysis`, `/play/*`,
   `/puzzles/*`, a specific game URL).
5. Click the Lasker toggle in the bottom-right panel.

### Usage tips

- Click the **gear icon** to change theme or size.
- Drag the **header** to reposition the panel.
- Use the **depth slider** to trade speed vs. accuracy (8 fast, 22 deep).
- Click the Lasker **toolbar icon** to toggle analysis without
  touching the overlay.

### Reloading after code changes

- Edit files in place (no build step).
- Go to `chrome://extensions` -> click the circular reload icon on the
  Lasker card.
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
3. Click the Lasker toggle -> "thinking..." appears, then a real
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
     `[Lasker] openings DB loaded: N named positions, M parents`
     log on first board change, and one
     `[Lasker] opening lookup: ... continuations` per move played.
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

- Lasker source code: MIT (author's choice).
- Stockfish (`engine/stockfish.{js,wasm}`): **GPL-3.0**. Any distributed
  build must comply with GPL-3.0.

---

## 12. Quick reference

- **Target site**: `https://www.chess.com/*` (www only).
- **Poll interval**: 500 ms (`POLL_MS` in `content.js`).
- **Default settings**: `{ enabled: false, depth: 15, theme: "dark", size: "medium" }`.
- **MultiPV**: 3.
- **Storage key**: `lasker.settings` in `chrome.storage.local`.
- **Overlay root id**: `lasker-overlay-host` (attached to `document.body`).
- **One-load guard**: `window.__laskerLoaded` on the page.
- **Opening-book ply cutoff**: 24 plies (12 full moves) via `isEarly`.
- **Move-quality thresholds** (cp, from mover's POV):
  `>= 300` blunder, `>= 150` mistake, `>= 70` inaccuracy,
  `<= -50` great, `<= 20` good, else solid.
- **Size widths**: small 240px, medium 300px, large 380px.
- **Themes**: `THEMES` dict in `overlay.js` (dark, light).
