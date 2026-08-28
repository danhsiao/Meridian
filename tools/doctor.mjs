#!/usr/bin/env node
// `npm run doctor` — proves the checkout actually works, end to end.
//
// This is the answer to "how do I know it's set up right?". Each check states
// what it proved, and each failure says what to run. Exits non-zero if
// anything required is broken, so it works in CI too.

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const G = "\x1b[32m", R = "\x1b[31m", Y = "\x1b[33m", D = "\x1b[2m", X = "\x1b[0m";
let failed = 0, warned = 0;

const ok = (what, detail = "") => console.log(`  ${G}✓${X} ${what}${detail ? ` ${D}${detail}${X}` : ""}`);
const bad = (what, fix) => { failed++; console.log(`  ${R}✗${X} ${what}\n      ${D}fix: ${fix}${X}`); };
const warn = (what, why) => { warned++; console.log(`  ${Y}!${X} ${what}\n      ${D}${why}${X}`); };
const head = (s) => console.log(`\n${s}`);

// ── env ─────────────────────────────────────────────────────────────────
// Which block needs which key. This is also the honest answer to "what is
// NEXT_PUBLIC_SUPABASE_URL for?" — nothing yet; it's the browser's Realtime
// subscription, and only the NEXT_PUBLIC_ prefix is safe to ship to a client.
const KEYS = {
  DATABASE_URL:                 { need: "required", why: "the bus — canvas, worker and CLI all read and write here" },
  NEXT_PUBLIC_SUPABASE_URL:     { need: "later",    why: "browser Realtime subscription (block 4). NEXT_PUBLIC_ = inlined into the client bundle, so browser-safe only" },
  NEXT_PUBLIC_SUPABASE_ANON_KEY:{ need: "later",    why: "same; the anon key is the only Supabase key that may reach a browser" },
  SUPABASE_SERVICE_ROLE_KEY:    { need: "later",    why: "server-side only — the review worker and CLI. Never NEXT_PUBLIC_" },
  ANTHROPIC_API_KEY:            { need: "later",    why: "Pass B and the policy resolution loop. Pass A needs no key — the review loop still runs without this" },
  ANTHROPIC_MODEL:              { need: "required", why: "pinned: a model swap changes eval results with no code change" },
  COMPOSIO_API_KEY:             { need: "later",    why: "fetching real messages (block 7)" },
  COMPOSIO_USER_ID:             { need: "later",    why: "block 7" },
  COMPOSIO_GMAIL_CONNECTION_ID: { need: "later",    why: "block 7" },
  TEMPORAL_ADDRESS:             { need: "required", why: "block 6" },
  TEMPORAL_NAMESPACE:           { need: "required", why: "block 6" },
  TEMPORAL_TASK_QUEUE:          { need: "required", why: "block 6" },
  CHANNEL_MODE:                 { need: "required", why: "capture | live — defaults to capture so a heal loop can't send real email" },
};

function parseEnv(path) {
  if (!existsSync(path)) return null;
  const out = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^"(.*)"$/, "$1");
  }
  return out;
}

head("environment");
const env = parseEnv(join(ROOT, ".env.local"));
if (!env) {
  bad(".env.local is missing", "supabase start && npm run env:local");
} else {
  const mode = (statSync(join(ROOT, ".env.local")).mode & 0o777).toString(8);
  mode === "600" ? ok(".env.local present", `mode ${mode}`) : warn(`.env.local is mode ${mode}`, "expected 600; run: chmod 600 .env.local");

  // The template must be truthful: every key it lists has to exist here.
  const example = parseEnv(join(ROOT, ".env.example")) ?? {};
  const missing = Object.keys(example).filter((k) => !(k in env));
  const extra = Object.keys(env).filter((k) => !(k in example));
  missing.length === 0
    ? ok(".env.local matches .env.example", `${Object.keys(example).length} keys`)
    : bad(`.env.local is missing: ${missing.join(", ")}`, "npm run env:local");
  if (extra.length) warn(`.env.local has keys not in .env.example: ${extra.join(", ")}`, "the example should be the whole truth — add them or drop them");

  for (const [k, { need, why }] of Object.entries(KEYS)) {
    if (env[k]) continue;
    need === "required" ? bad(`${k} is empty`, why) : warn(`${k} is empty`, `not needed yet — ${why}`);
  }
}

// ── stack ───────────────────────────────────────────────────────────────
head("stack");
const url = env?.DATABASE_URL;
const isLocal = !!url && /127\.0\.0\.1|localhost/.test(url);

if (isLocal) {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
    ok("docker daemon is running");
  } catch {
    bad("docker daemon is not running", "open Docker Desktop (macOS: open -a Docker), then: supabase start");
  }
}

let pg;
if (url) {
  try {
    pg = (await import("pg")).default;
  } catch {
    bad("the pg driver isn't installed", "npm install");
  }
}

const TABLES = ["users", "process_maps", "nodes", "edges", "review_runs", "comments", "frozen_specs", "spec_builds"];

if (pg && url) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 4000 });
  try {
    await client.connect();
    ok("database reachable", isLocal ? "local" : "remote");

    const { rows } = await client.query(
      `select table_name from information_schema.tables where table_schema = 'public'`,
    );
    const have = new Set(rows.map((r) => r.table_name));
    const absent = TABLES.filter((t) => !have.has(t));
    absent.length === 0
      ? ok("schema applied", `${TABLES.length} tables`)
      : bad(`tables missing: ${absent.join(", ")}`, "npm run db:seed");

    if (absent.length === 0) {
      const counts = await client.query(
        `select (select count(*) from process_maps) maps,
                (select count(*) from nodes) nodes,
                (select count(*) from edges) edges`,
      );
      const { maps, nodes, edges } = counts.rows[0];
      Number(maps) > 0
        ? ok("boards seeded", `${maps} boards, ${nodes} nodes, ${edges} edges`)
        : bad("no boards in the database", "npm run db:seed");

      // The review worker wakes on LISTEN rather than polling. If the trigger
      // isn't firing, block 3 silently never runs — worth proving, not assuming.
      const listener = new pg.Client({ connectionString: url });
      await listener.connect();
      const heard = new Promise((res) => listener.on("notification", (n) => res(n.payload)));
      await listener.query("listen review_runs");
      const probe = `doctor_${Date.now().toString(36)}`;
      const anyMap = await client.query(`select id from process_maps limit 1`);
      if (anyMap.rowCount) {
        await client.query(`insert into review_runs (id, map_id, round) values ($1,$2,0)`, [probe, anyMap.rows[0].id]);
        const got = await Promise.race([heard, new Promise((r) => setTimeout(() => r(null), 3000))]);
        got === probe
          ? ok("LISTEN/NOTIFY fires", "the review worker will wake on a queued run")
          : bad("the review_runs trigger did not fire", "npm run db:seed (the migration creates the trigger)");
        await client.query(`delete from review_runs where id = $1`, [probe]);
      }
      await listener.end();
    }
  } catch (e) {
    bad(`database: ${String(e.message).split("\n")[0]}`, isLocal ? "supabase start && npm run env:local" : "check DATABASE_URL");
  } finally {
    try { await client.end(); } catch {}
  }
}

// ── the code ────────────────────────────────────────────────────────────
head("code");
const res = spawnSync("npx", ["vitest", "run", "--reporter=dot"], { cwd: ROOT, encoding: "utf8" });
const out = (res.stdout ?? "") + (res.stderr ?? "");
const m = out.match(/Tests\s+(\d+) passed/);
res.status === 0
  ? ok("test suite passes", m ? `${m[1]} tests` : "")
  : bad("tests are failing", "npx vitest run");

const nouns = spawnSync("node", [join(ROOT, "tools", "check-nouns.mjs")], { cwd: ROOT, encoding: "utf8" });
nouns.status === 0
  ? ok("no domain nouns in the engine")
  : bad("a domain noun leaked into the engine", "node tools/check-nouns.mjs");

// ── verdict ─────────────────────────────────────────────────────────────
console.log();
if (failed) {
  console.log(`${R}${failed} problem${failed === 1 ? "" : "s"}${X}${warned ? `, ${warned} not needed yet` : ""}`);
  process.exit(1);
}
console.log(`${G}everything works${X}${warned ? ` ${D}(${warned} keys not needed yet)${X}` : ""}`);
console.log(`${D}canvas: npm run dev  ·  studio: http://127.0.0.1:54323${X}`);
