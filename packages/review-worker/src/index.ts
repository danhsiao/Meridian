// The review worker. A separate process that sleeps on LISTEN and never talks
// to the browser — the canvas inserts a `review_runs` row, a trigger fires
// pg_notify, and this wakes up. That indirection is the architecture: it's why
// review can take four seconds without blocking the canvas, and why the CLI
// could queue a round without knowing a UI exists.
//
// Two passes.
//
// Pass A has no model in it. Every comment it writes is a finding elaborate()
// produced, rendered by render() — so the review agent asks precisely the
// questions the compiler would ask, because the same function produced both.
//
// The resolution loop is the half that listens: it reads what she wrote on a
// check and resolves it against the fields actually on her board. Without it
// the `derived` keys can never be filled, and a board sits blocked forever on
// questions nothing is able to answer. It needs ANTHROPIC_API_KEY; without one
// the worker runs Pass A alone and says so.

import { readFileSync } from "node:fs";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  elaborate, render, policyIsResolved,
  askKey, askedAlready, findingKey, mutationKey,
  EmptyOptionSet, NothingToConfirm, NotAQuestion,
} from "@engine/compiler";
import type { Board, Edge, Finding, Node } from "@engine/compiler";
import { resolutionAvailable, resolvePolicy } from "./resolve.js";
import { proposalsAvailable, proposeFromText } from "./propose.js";

// ── config ──────────────────────────────────────────────────────────────

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

function loadEnv(): void {
  const path = ROOT + ".env.local";
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"(.*)"$/, "$1");
  }
}
loadEnv();

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set. Run: npm run env:local");
  process.exit(1);
}

/** At most 7 per round, ranked by what blocks freeze. A queue of thirty is a
 *  worse experience than four rounds of seven, and the ranking is what makes
 *  the first seven the right seven. */
const PER_ROUND = 7;

// ── the loop ────────────────────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 });

async function main(): Promise<void> {
  const listener = new pg.Client({ connectionString: DATABASE_URL });
  await listener.connect();
  await listener.query("listen review_runs");
  console.log("review worker listening on review_runs");

  listener.on("notification", (msg) => {
    if (msg.payload) void handle(msg.payload).catch((e) => console.error("run failed:", e));
  });

  // Anything queued while the worker was down still needs picking up. A worker
  // that only reacts to notifications silently drops work across a restart.
  const { rows } = await pool.query(`select id from review_runs where status = 'queued'`);
  for (const r of rows) await handle(r.id).catch((e) => console.error("backlog failed:", e));
}

async function handle(runId: string): Promise<void> {
  const client = await pool.connect();
  try {
    const run = await client.query(
      `select id, map_id, round, status from review_runs where id = $1`, [runId],
    );
    if (run.rowCount === 0 || run.rows[0].status !== "queued") return;
    const { map_id: mapId, round } = run.rows[0];

    await client.query(`update review_runs set status = 'running' where id = $1`, [runId]);
    const started = Date.now();

    const board = await readBoard(client, mapId);
    const { findings } = elaborate(board);

    // Deduped against every prior round on (code, anchor, key): asking the same
    // question twice is how a review loop stops being believable.
    //
    // The key belongs in that tuple. One code fires on one node for several
    // different config keys — `missing_required_key` on a policy is `describes`,
    // then `on_fail`, then `on_absent` — and without the key, answering the
    // first one silently suppressed the other two forever. A board can reach a
    // state with blocking findings and no comments at all, which reads as the
    // agent having nothing to say when in fact it has been gagged. The comments
    // table doesn't store the key on its own; the mutation carries it.
    // A comment reconciliation closed because its finding had gone away was
    // never answered, so it is not evidence the question has been settled — and
    // if the finding is back, the honest thing is to ask again. Counting those
    // is what turns a transient auto-close into a question that can never be
    // posed a second time.
    //
    // A RESOLVED comment does not suppress either, and the reason is the same
    // one turned up a level. Dedupe exists so a question that is already on
    // screen is not asked twice, and so something she declined is not asked
    // again. A resolved comment is neither: it means the question was answered
    // and its mutation applied. If the finding it was about is STILL LIVE --
    // and every finding tested here is, by construction -- then the answer did
    // not fix it, and asking again is the honest thing.
    //
    // Suppressing it instead is terminal: one board answered seven questions
    // whose mutation appended a duplicate row rather than setting its target,
    // so every finding survived, every comment read as settled, and the agent
    // reported "7 findings, 0 new" forever with nothing on screen to act on.
    // A question that comes back is annoying; a board that goes quiet while
    // blocked cannot be recovered from the UI at all.
    const seen = await client.query(
      `select code, node_id, edge_id, coalesce(mutation->>'key', mutation->'row'->>'label') as key from comments
        where map_id = $1
          and status <> 'resolved'
          and coalesce(answer->>'resolved_directly', 'false') <> 'true'`,
      [mapId],
    );
    const already = askedAlready(seen.rows);

    // Askable only. A key can be required without yet being a fair question —
    // "what should happen when the value is empty?" means nothing before she
    // has said what the check does. Freeze still counts every blocking finding.
    const fresh = findings.filter((f) => f.askable && !already.has(findingKey(f)));

    // What she just touched gets asked about first.
    //
    // Seven per round keeps a queue readable, but combined with dedupe it also
    // meant a card added after the last round could sit behind older findings
    // and draw no comment at all — she adds a node, presses Review, and the
    // agent appears to have ignored it. Ranking still decides order within each
    // group; recency only decides which group goes first.
    const touched = await client.query(
      `select id from nodes
        where map_id = $1
          and updated_at > coalesce(
            (select max(created_at) from review_runs
              where map_id = $1 and id <> $2), 'epoch')`,
      [mapId, runId],
    );
    const recent = new Set(touched.rows.map((r) => r.id));
    const isRecent = (f: Finding) => {
      const n = anchorNode(f);
      return n != null && recent.has(n);
    };
    const ordered = [...fresh.filter(isRecent), ...fresh.filter((f) => !isRecent(f))];

    let written = 0;
    let n = await nextCommentNumber(client, mapId);

    // The resolution loop runs FIRST. A check she described but never
    // formalised blocks on `derived` keys, and only this can fill them — so
    // asking her anything else first is asking around the actual obstacle.
    if (resolutionAvailable()) {
      for (const policy of board.nodes.filter((x) => x.primitive === "policy")) {
        // Structurally resolved, not merely non-null — see policyIsResolved().
        if (policyIsResolved(policy)) continue;
        if (already.has(askKey("policy_resolution", policy.id, null, null))) continue;

        let r;
        try {
          r = await resolvePolicy(policy, board);
        } catch (e) {
          console.warn(`  could not resolve ${policy.id}: ${(e as Error).message}`);
          continue;
        }
        if (!r) continue;

        if (r.kind === "unclear") {
          // It read her description and still couldn't tell. Saying which one
          // thing would settle it beats asking the same question again.
          await insert(client, {
            mapId, id: `c_${String(n++).padStart(2, "0")}`, nodeId: policy.id, round, runId,
            code: "unresolved_policy", severity: "blocking", rank: "blocking",
            pass: "B", binding: "prompt", answerKind: "text",
            body: `“${policy.label}” — ${r.question || "tell me a little more about what this checks."}`,
            preview: null, options: null, proposal: null,
            mutation: { op: "set_config_key", node_id: policy.id, key: "describes", value: null },
          });
          written++;
          continue;
        }

        // Played back in her field names, for her to confirm. The mutation
        // merges the whole resolution at once, because half a resolved check
        // is not a state the board should ever be in.
        const proposal = {
          check: r.check, reads: r.reads, verdict_on: r.verdict_on,
          confirmed_by: `c_${String(n).padStart(2, "0")}`,
        };
        await insert(client, {
          mapId, id: `c_${String(n++).padStart(2, "0")}`, nodeId: policy.id, round, runId,
          code: "policy_resolution", severity: "advisory", rank: "structural",
          pass: "B", binding: "derived", answerKind: "choice",
          body: `“${policy.label}” — here's what I understood. Is that right?`,
          preview: `Sets up “${policy.label}” so it can run.`,
          options: [
            { value: "confirm", label: "Yes, that's right" },
            { value: "reject", label: "No — let me say it differently", rejects: true },
          ],
          proposal: { reads_as: r.playback, ...proposal },
          mutation: { op: "record_elicited", node_id: policy.id, proposal },
        });
        written++;
      }
    } else if (findings.some((f) => f.code === "unresolved_policy")) {
      console.warn("  no ANTHROPIC_API_KEY: checks described in English cannot be resolved");
    }

    // ── Pass B ────────────────────────────────────────────────────────
    // Reads what she wrote. Runs BEFORE the Pass A comments are written, so a
    // question her own words already answer can be posed as a confirmation
    // rather than asked from scratch.
    const prefilled = new Map<string, { value: unknown; because: string }>();

    if (proposalsAvailable()) {
      // The only keys Pass B may fill are ones Pass A has decided to ask about,
      // with the values Pass A would have offered.
      const openKeys = ordered
        .filter((f) => f.evidence.key && "node_id" in f.anchor)
        .map((f) => {
          let allowed: (string | number)[] | null = null;
          try {
            const o = render(f, board).options;
            if (o) allowed = o.filter((x) => !x.escape).map((x) => x.value);
          } catch { /* unrenderable findings offer nothing */ }
          return {
            node_id: (f.anchor as { node_id: string }).node_id,
            key: String(f.evidence.key),
            allowed,
          };
        });

      try {
        const b = await proposeFromText(board, openKeys);

        for (const pf of b.prefills) prefilled.set(`${pf.node_id}|${pf.key}`, pf);

        for (const prop of b.proposals) {
          if (already.has(askKey(prop.code, prop.anchor, null, mutationKey(prop.mutation)))) {
            continue;
          }
          await insert(client, {
            mapId, id: `c_${String(n++).padStart(2, "0")}`, nodeId: prop.anchor, round, runId,
            code: prop.code, severity: "advisory", rank: "structural",
            pass: "B", binding: "control", answerKind: "choice",
            body: prop.because,
            preview: prop.preview,
            options: [
              { value: "confirm", label: "Yes, do that" },
              { value: "reject", label: "No, leave it", rejects: true },
            ],
            // No playback: the body is the reason and the preview is the
            // consequence. A third copy of the same sentence is not a feature.
            proposal: null,
            mutation: prop.mutation,
          });
          written++;
        }
        if (b.proposals.length || b.prefills.length) {
          console.log(
            `  pass B: ${b.proposals.length} proposed, ${b.prefills.length} answered from her own words`,
          );
        }
      } catch (e) {
        // Pass B is an improvement on Pass A, never a precondition for it.
        console.warn(`  pass B unavailable this round: ${(e as Error).message}`);
      }
    }

    for (const f of ordered.slice(0, PER_ROUND)) {
      let r;
      try {
        r = render(f, board);
      } catch (e) {
        // Two cases where the honest move is to say nothing rather than ask a
        // broken question: an option set with nothing in it, and a
        // confirmation with nothing to confirm. Both mean something upstream
        // has to happen first, and both still block freeze.
        if (e instanceof EmptyOptionSet || e instanceof NothingToConfirm || e instanceof NotAQuestion) {
          console.warn(`  skipped ${f.code}: ${e.message}`);
          continue;
        }
        throw e;
      }

      // If her own words already answer this, ask her to confirm the reading
      // instead of making her pick from a list she has effectively filled in.
      const pre = anchorNode(f) && f.evidence.key
        ? prefilled.get(`${anchorNode(f)}|${f.evidence.key}`)
        : undefined;

      await insert(client, {
        mapId, id: `c_${String(n++).padStart(2, "0")}`,
        nodeId: anchorNode(f), edgeId: anchorEdge(f), round, runId,
        code: r.code, severity: r.severity, rank: r.rank,
        pass: pre ? "B" : "A",
        binding: pre ? "derived" : r.binding,
        answerKind: pre ? "choice" : r.answer_kind,
        body: pre ? `${r.body}` : r.body,
        preview: r.preview,
        options: pre
          ? [
              { value: "confirm", label: "Yes, that's right" },
              { value: "reject", label: "No — let me pick", rejects: true },
            ]
          : r.options,
        proposal: pre ? { reads_as: pre.because, value: pre.value } : null,
        mutation: pre
          ? { op: "set_config_key", node_id: anchorNode(f)!, key: String(f.evidence.key), value: pre.value }
          : r.mutation,
      });
      written++;
    }

    await client.query(`update review_runs set status = 'done' where id = $1`, [runId]);
    console.log(
      `round ${round} on ${mapId}: ${findings.length} findings ` +
        `(${findings.filter((f) => f.askable).length} askable), ${fresh.length} new` +
        `${recent.size ? ` (${ordered.filter(isRecent).length} on cards you just changed)` : ""}` +
        `, wrote ${written} in ${Date.now() - started}ms`,
    );
  } catch (e) {
    await client.query(`update review_runs set status = 'failed' where id = $1`, [runId]);
    throw e;
  } finally {
    client.release();
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

async function insert(client: pg.PoolClient, c: {
  mapId: string; id: string; nodeId?: string | null; edgeId?: string | null;
  round: number; runId: string; code: string; severity: string; rank: string;
  pass?: "A" | "B";
  binding: string; answerKind: string; body: string; preview: string | null;
  options: unknown; proposal: unknown; mutation: unknown;
}): Promise<void> {
  await client.query(
    `insert into comments (
       map_id, id, node_id, edge_id, round, run_id,
       code, severity, rank, pass, binding, answer_kind,
       author_type, body, preview, options, proposal, mutation, status
     ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'agent',$13,$14,$15,$16,$17,'open')`,
    [
      c.mapId, c.id, c.nodeId ?? null, c.edgeId ?? null, c.round, c.runId,
      c.code, c.severity, c.rank, c.pass ?? "A", c.binding, c.answerKind,
      c.body, c.preview,
      c.options ? JSON.stringify(c.options) : null,
      c.proposal ? JSON.stringify(c.proposal) : null,
      JSON.stringify(c.mutation),
    ],
  );
}

const anchorNode = (f: Finding) => ("node_id" in f.anchor ? f.anchor.node_id : null);
const anchorEdge = (f: Finding) => ("edge_id" in f.anchor ? f.anchor.edge_id : null);

async function nextCommentNumber(client: pg.PoolClient, mapId: string): Promise<number> {
  const { rows } = await client.query(
    `select coalesce(max(substring(id from 3)::int), 0) + 1 as n
       from comments where map_id = $1 and id ~ '^c_[0-9]+$'`,
    [mapId],
  );
  return Number(rows[0].n);
}

async function readBoard(client: pg.PoolClient, mapId: string): Promise<Board> {
  const nodes = await client.query(
    `select id, primitive, label, config, x, y from nodes where map_id = $1 order by id`, [mapId],
  );
  const edges = await client.query(
    `select id, from_node, to_node, config from edges where map_id = $1 order by id`, [mapId],
  );
  return {
    nodes: nodes.rows as Node[],
    edges: edges.rows.map((r) => ({
      id: r.id, from: r.from_node, to: r.to_node, config: r.config,
    })) as Edge[],
  };
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
