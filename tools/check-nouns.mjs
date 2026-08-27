#!/usr/bin/env node
// The noun lint. Pharmaceutical import receiving is ONE CONSUMER of this system;
// nothing in the engine may know it exists. That degrades silently unless something
// checks it, so this checks it — in CI and as a pre-commit hook.
//
// Domain nouns are legal in exactly three places: processes/, examples/, and
// database rows. Everywhere else is the engine, and the engine ships no nouns.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

// Scanned: the engine. Not scanned: processes/, examples/, docs/, evals fixtures.
const SCAN = ["packages", "runtime", "apps", "skills", "cli", "tools"];

const DENY = [
  "invoice", "batch", "certificate", "coa", "hts", "anda", "ndc", "fda",
  "shipment", "container", "pharma", "pre-alert", "prealert", "rosuvastatin",
];

const EXT = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs", ".py", ".json", ".jsonc", ".sql", ".md", ".j2"]);
const SKIP_DIR = new Set(["node_modules", "dist", ".git", "__pycache__", ".venv", ".pytest_cache"]);

// A denied word only counts as a whole word. `batch` is a domain noun;
// `batched` in a comment about request batching is not what we're hunting,
// but we keep the rule strict and let real hits be renamed rather than
// carving out exceptions that erode the check.
const pattern = new RegExp(`\\b(${DENY.join("|")})\\b`, "i");

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return; // directory doesn't exist yet — fine, the tree fills in over the build
  }
  for (const name of entries) {
    if (SKIP_DIR.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) yield* walk(full);
    else if (EXT.has(extname(full))) yield full;
  }
}

const hits = [];
for (const base of SCAN) {
  for (const file of walk(join(ROOT, base))) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const m = line.match(pattern);
      if (m) hits.push({ file: relative(ROOT, file), line: i + 1, word: m[1], text: line.trim() });
    });
  }
}

if (hits.length === 0) {
  console.log("check-nouns: clean — the engine ships no domain nouns.");
  process.exit(0);
}

console.error(`check-nouns: ${hits.length} domain noun${hits.length === 1 ? "" : "s"} leaked into the engine.\n`);
for (const h of hits) {
  console.error(`  ${h.file}:${h.line}  "${h.word}"`);
  console.error(`    ${h.text.slice(0, 100)}`);
}
console.error(`
Domain nouns belong in processes/, examples/, or database rows — never in the
engine. If this is a genuine hit, rename it to what the code actually does
(present, not check_good_fields). If the word means something non-domain here,
rename it anyway: the check is only worth keeping while it has no exceptions.`);
process.exit(1);
