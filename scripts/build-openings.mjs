#!/usr/bin/env node
//
// Build a local opening database for ChessMate.
//
// Source: https://github.com/lichess-org/chess-openings (CC0).
//
// Pulls the five TSV files (a-e), replays every PGN with chess.js, and emits
// data/openings.json with two indices:
//
//   names      : { [epd]: { eco, name } }
//                Every named position -- both the terminal position of each
//                ECO entry AND every intermediate position reached along the
//                way (if no other entry terminates at it, the shortest-named
//                entry that passes through it claims the label).
//
//   nextByEpd  : { [parentEpd]: [{ move, san, eco, name }, ...] }
//                For every (parent, move) pair that appears on ANY opening's
//                PGN path, a pointer to the child position -- with the
//                child's canonical name/eco taken from `names`. This means
//                mainline positions 4-5 moves deep get hints for every
//                reasonable continuation, not just for the final move of
//                whichever opening happened to terminate there.
//
// Run with: `npm run build:openings`. The output JSON is ~1.3 MB.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Chess } from "chess.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const OUT_PATH = resolve(ROOT, "data", "openings.json");

const BASE = "https://raw.githubusercontent.com/lichess-org/chess-openings/master";
const FILES = ["a.tsv", "b.tsv", "c.tsv", "d.tsv", "e.tsv"];

async function fetchTsv(filename) {
  const url = `${BASE}/${filename}`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Failed to fetch ${url}: ${resp.status}`);
  return await resp.text();
}

// Upstream TSV has just three columns: eco \t name \t pgn. UCI / EPD are
// derived here via chess.js.
function parseTsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const header = lines[0].split("\t").map((s) => s.trim().toLowerCase());
  const idx = {
    eco: header.indexOf("eco"),
    name: header.indexOf("name"),
    pgn: header.indexOf("pgn"),
  };
  if (idx.eco < 0 || idx.name < 0 || idx.pgn < 0) {
    throw new Error(`unexpected TSV header: ${header.join(" | ")}`);
  }
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    out.push({
      eco: (cols[idx.eco] || "").trim(),
      name: (cols[idx.name] || "").trim(),
      pgn: (cols[idx.pgn] || "").trim(),
    });
  }
  return out;
}

// Strip move numbers, NAG glyphs, comments and variations, leaving a pure
// whitespace-separated list of SAN tokens.
function sanTokensFromPgn(pgn) {
  return pgn
    .replace(/\{[^}]*\}/g, " ")
    .replace(/\d+\.\.\./g, " ")
    .replace(/\d+\./g, " ")
    .replace(/\([^)]*\)/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0 && !/^[*01/-]/.test(t));
}

// The ECO repo uses EPDs with four fields (board turn castling ep) -- no
// half-move/full-move counters. chess.js gives us a full FEN so trim it.
function fenToEpd(fen) {
  return fen.split(/\s+/).slice(0, 4).join(" ");
}

function moveToUci(m) {
  if (!m) return null;
  return `${m.from}${m.to}${m.promotion || ""}`;
}

async function main() {
  let entries = [];
  for (const f of FILES) {
    process.stdout.write(`fetching ${f}... `);
    const text = await fetchTsv(f);
    const parsed = parseTsv(text);
    entries = entries.concat(parsed);
    console.log(`${parsed.length} entries`);
  }
  console.log(`total: ${entries.length} named openings`);

  // -------------------------------------------------------------------------
  // Precompute the path of each entry: the sequence of (epd, san, uci) tuples.
  // We'll reuse this for both the names pass and the nextByEpd pass.
  // -------------------------------------------------------------------------
  const paths = [];
  let skipped = 0;
  for (const e of entries) {
    if (!e.pgn) continue;
    const tokens = sanTokensFromPgn(e.pgn);
    if (tokens.length === 0) continue;

    const chess = new Chess();
    const plies = []; // { parentEpd, san, uci, childEpd }
    try {
      let parentEpd = fenToEpd(chess.fen());
      for (const tok of tokens) {
        const move = chess.move(tok, { strict: false });
        if (!move) throw new Error(`illegal SAN "${tok}"`);
        const childEpd = fenToEpd(chess.fen());
        plies.push({
          parentEpd,
          san: move.san,
          uci: moveToUci(move),
          childEpd,
        });
        parentEpd = childEpd;
      }
      paths.push({ entry: e, plies });
    } catch (err) {
      skipped++;
      if (skipped < 10) console.warn(`  skip "${e.name}" [${e.eco}]: ${err.message}`);
    }
  }
  console.log(`parsed ${paths.length} entry paths, skipped ${skipped}`);

  // -------------------------------------------------------------------------
  // PASS 1a: every TERMINAL epd gets the name of the entry that terminates
  // there. When multiple entries terminate at the same epd (rare), prefer
  // the shorter (more canonical) name.
  // -------------------------------------------------------------------------
  const names = Object.create(null);
  const isTerminal = Object.create(null);

  for (const { entry, plies } of paths) {
    const finalEpd = plies[plies.length - 1].childEpd;
    const existing = names[finalEpd];
    if (
      !existing ||
      (!isTerminal[finalEpd]) ||
      entry.name.length < existing.name.length
    ) {
      names[finalEpd] = { eco: entry.eco, name: entry.name };
      isTerminal[finalEpd] = true;
    }
  }

  // -------------------------------------------------------------------------
  // PASS 1b: for every INTERMEDIATE epd on any entry's path, record a name
  // iff it isn't already the terminal epd of some entry. Among competing
  // intermediate names for the same epd, keep the shortest (most canonical).
  // -------------------------------------------------------------------------
  for (const { entry, plies } of paths) {
    // All plies except the last one reach "intermediate" positions.
    for (let i = 0; i < plies.length - 1; i++) {
      const epd = plies[i].childEpd;
      if (isTerminal[epd]) continue; // don't clobber a terminal name
      const existing = names[epd];
      if (!existing || entry.name.length < existing.name.length) {
        names[epd] = { eco: entry.eco, name: entry.name };
      }
    }
  }

  // -------------------------------------------------------------------------
  // PASS 2: build nextByEpd. For every (parentEpd, san) pair seen on ANY
  // entry path, record one child pointer; the child's display name/eco
  // comes from `names[childEpd]` so it's consistent no matter which entry
  // we happened to sample it from.
  // -------------------------------------------------------------------------
  const nextByEpd = Object.create(null);

  for (const { entry, plies } of paths) {
    for (const p of plies) {
      const bucket = nextByEpd[p.parentEpd] || (nextByEpd[p.parentEpd] = Object.create(null));
      if (bucket[p.san]) continue; // first write wins; all are equivalent

      const childName = names[p.childEpd];
      bucket[p.san] = {
        move: p.uci,
        san: p.san,
        eco: childName ? childName.eco : entry.eco,
        name: childName ? childName.name : entry.name,
      };
    }
  }

  // Convert per-parent object -> sorted array (by ECO for deterministic output).
  for (const epd of Object.keys(nextByEpd)) {
    nextByEpd[epd] = Object.values(nextByEpd[epd]).sort((a, b) =>
      (a.eco || "").localeCompare(b.eco || "")
    );
  }

  // -------------------------------------------------------------------------
  // Output.
  // -------------------------------------------------------------------------
  const output = {
    version: 2,
    source: "lichess-org/chess-openings (CC0)",
    generatedAt: new Date().toISOString(),
    totalEntries: entries.length,
    names,
    nextByEpd,
  };

  await mkdir(dirname(OUT_PATH), { recursive: true });
  const json = JSON.stringify(output);
  await writeFile(OUT_PATH, json);

  const sizeKb = (Buffer.byteLength(json) / 1024).toFixed(1);
  console.log(`wrote ${OUT_PATH} (${sizeKb} KB)`);
  console.log(`  names entries:       ${Object.keys(names).length}`);
  console.log(`  nextByEpd entries:   ${Object.keys(nextByEpd).length}`);

  const totalPointers = Object.values(nextByEpd).reduce((a, arr) => a + arr.length, 0);
  console.log(`  total child pointers: ${totalPointers}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
