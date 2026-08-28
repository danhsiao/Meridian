// The only BoardStore. The database is the bus: the canvas writes rows, the
// review worker wakes on LISTEN, the CLI reads and writes the same tables, and
// none of them calls another directly.
//
// There is deliberately no in-memory alternative. A second implementation
// living inside the Next.js process would be invisible to the worker and the
// CLI, so it could never be the bus — and it would mean writing the apply
// transaction twice, which is the drift this whole design argues against.

import { Pool, type PoolClient } from "pg";
import { apply, askKey, elaborate, fill, findingKey, freeze, validate } from "@engine/compiler";
import type { Board, Edge, Mutation, Node } from "@engine/compiler";
import type { BoardMeta, BoardStore, CommentRow } from "./types";

let pool: Pool | undefined;

function db(): Pool {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
      throw new Error(
        "DATABASE_URL is not set. Start the stack with `supabase start` and copy " +
          "the DB URL into .env.local — see .env.example.",
      );
    }
    pool = new Pool({ connectionString, max: 8 });
  }
  return pool;
}

export class PostgresStore implements BoardStore {
  async listBoards(): Promise<BoardMeta[]> {
    const { rows } = await db().query(
      `select id, title, status from process_maps order by created_at`,
    );
    return rows;
  }

  async getBoard(mapId: string) {
    const client = await db().connect();
    try {
      const meta = await client.query(
        `select id, title, status from process_maps where id = $1`,
        [mapId],
      );
      if (meta.rowCount === 0) return null;
      return { meta: meta.rows[0] as BoardMeta, board: await readBoard(client, mapId) };
    } finally {
      client.release();
    }
  }

  async listComments(mapId: string): Promise<CommentRow[]> {
    const { rows } = await db().query(
      `select * from comments where map_id = $1 order by round, created_at`,
      [mapId],
    );
    return rows as CommentRow[];
  }

  async insertComments(rows: CommentRow[]): Promise<number> {
    if (rows.length === 0) return 0;
    const client = await db().connect();
    try {
      await client.query("begin");
      let n = 0;
      for (const r of rows) {
        const res = await client.query(
          `insert into comments (
             map_id, id, node_id, edge_id, parent_id, supersedes, round, run_id,
             code, severity, rank, pass, binding, answer_kind,
             author_type, author_id, body, preview, options, answer, proposal, mutation, status
           ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
           on conflict (map_id, id) do nothing`,
          [
            r.map_id, r.id, r.node_id, r.edge_id, r.parent_id, r.supersedes, r.round, r.run_id,
            r.code, r.severity, r.rank, r.pass, r.binding, r.answer_kind,
            r.author_type, r.author_id, r.body, r.preview,
            r.options ? JSON.stringify(r.options) : null,
            r.answer === undefined ? null : JSON.stringify(r.answer),
            r.proposal ? JSON.stringify(r.proposal) : null,
            JSON.stringify(r.mutation), r.status,
          ],
        );
        n += res.rowCount ?? 0;
      }
      await client.query("commit");
      return n;
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * The transaction that makes the loop structural rather than decorative.
   *
   * Reading the board, applying the mutation and settling the comment all
   * happen inside one transaction, with the board rows locked for the duration.
   * If `apply` throws — an answer that doesn't validate, a mutation whose
   * target moved — nothing is written and the comment stays open. The board
   * changes because she answered, or it doesn't change at all.
   */
  async answerComment(mapId: string, commentId: string, answer: unknown) {
    const client = await db().connect();
    try {
      await client.query("begin");

      // Serialise concurrent answers on the same board. Two comments answered
      // at once would otherwise both read the pre-edit board and the second
      // write would silently drop the first edit.
      await client.query(`select id from process_maps where id = $1 for update`, [mapId]);

      const found = await client.query(
        `select * from comments where map_id = $1 and id = $2`,
        [mapId, commentId],
      );
      if (found.rowCount === 0) throw new Error(`no comment ${commentId}`);
      const comment = found.rows[0] as CommentRow;
      if (comment.status === "resolved" || comment.status === "rejected") {
        throw new Error(`comment ${commentId} is already settled`);
      }

      const board = await readBoard(client, mapId);
      const next = apply(board, fill(comment.mutation, answer));
      await writeBoard(client, mapId, next);

      // Confirming a resolution settles it like any other answer. If the merge
      // did not actually resolve the policy, elaborate() will say so again next
      // round — the board stays the source of truth either way.
      const status = "resolved";
      const updated = await client.query(
        `update comments set answer = $3, status = $4
           where map_id = $1 and id = $2 returning *`,
        [mapId, commentId, JSON.stringify(answer ?? null), status],
      );

      // One answer can settle several comments: collapsing a card resolves
      // every question that was about it.
      await reconcileComments(client, mapId);
      await client.query("commit");
      return { board: next, comment: updated.rows[0] as CommentRow };
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * Deriving the org from an existing board only worked while boards were
   * seeded — the first board on an empty workspace had nothing to copy from.
   * The owner is what actually anchors an org, and the seed always creates one.
   * Multi-tenancy and real auth are out of scope; one owner, one org.
   */
  async createBoard(title: string): Promise<string> {
    const { rows } = await db().query(
      `insert into process_maps (org_id, title, status)
       values (
         coalesce(
           (select org_id from users order by created_at limit 1),
           '00000000-0000-0000-0000-000000000001'::uuid
         ),
         $1, 'draft'
       ) returning id`,
      [title],
    );
    return rows[0].id;
  }

  /**
   * A new card is deliberately almost empty: a primitive, a label, a position.
   * Everything else — what values it carries, what identifies it, what a check
   * actually checks — is what the review agent is for. Prefilling it would be
   * the system guessing at her process instead of asking.
   */
  async createNode(mapId: string, primitive: string, label: string, x: number, y: number) {
    const client = await db().connect();
    try {
      await client.query("begin");
      // Ids are stable and readable, and never derived from the label — she can
      // rename a card without changing what the spec calls it.
      const { rows } = await client.query(
        `select coalesce(max(substring(id from '[0-9]+$')::int), 0) + 1 as n
           from nodes where map_id = $1 and id like $2`,
        [mapId, `${primitive.slice(0, 3)}_%`],
      );
      const id = `${primitive.slice(0, 3)}_${rows[0].n}`;
      await client.query(
        `insert into nodes (map_id, id, primitive, label, config, x, y)
         values ($1,$2,$3,$4,'{}'::jsonb,$5,$6)`,
        [mapId, id, primitive, label, Math.round(x), Math.round(y)],
      );
      await client.query("commit");
      return id;
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }

  /**
   * A direct edit goes through the compiler's own applier, not a raw UPDATE —
   * so typing a field and answering a comment about that field take the exact
   * same path, and neither can write something the other would reject.
   */
  async setConfigKey(mapId: string, nodeId: string, key: string, value: unknown) {
    const client = await db().connect();
    try {
      await client.query("begin");
      await client.query(`select id from process_maps where id = $1 for update`, [mapId]);
      const board = await readBoard(client, mapId);
      const next = apply(board, { op: "set_config_key", node_id: nodeId, key, value });
      await writeBoard(client, mapId, next);
      await reconcileComments(client, mapId);
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }

  async renameNode(mapId: string, nodeId: string, label: string) {
    await db().query(`update nodes set label = $3, updated_at = now() where map_id = $1 and id = $2`,
      [mapId, nodeId, label]);
  }

  async countCommentsOn(mapId: string, nodeId: string): Promise<number> {
    const { rows } = await db().query(
      `select count(*)::int as n from comments where map_id = $1 and node_id = $2`,
      [mapId, nodeId],
    );
    return rows[0].n;
  }

  async deleteNode(mapId: string, nodeId: string) {
    await this.inTransaction(mapId, async (client) => {
      await client.query(`delete from edges where map_id = $1 and (from_node = $2 or to_node = $2)`,
        [mapId, nodeId]);
      await client.query(`delete from nodes where map_id = $1 and id = $2`, [mapId, nodeId]);
    });
  }

  async connect(mapId: string, from: string, to: string) {
    const client = await db().connect();
    try {
      await client.query("begin");
      const { rows } = await client.query(
        `select coalesce(max(substring(id from '[0-9]+$')::int), 0) + 1 as n
           from edges where map_id = $1 and id like 'e_%'`,
        [mapId],
      );
      const id = `e_${rows[0].n}`;
      const { rowCount } = await client.query(
        `insert into edges (map_id, id, from_node, to_node, config) values ($1,$2,$3,$4,'{}'::jsonb)
         on conflict (map_id, from_node, to_node) do nothing`,
        [mapId, id, from, to],
      );
      if (rowCount === 0) {
        // Already connected. Silently doing nothing looks like a broken drop.
        await client.query("rollback");
        throw new Error("those two are already connected");
      }
      // Drawing the edge herself answers "nothing reaches this" — the comment
      // has to notice.
      await reconcileComments(client, mapId);
      await client.query("commit");
      return id;
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }

  async disconnect(mapId: string, edgeId: string) {
    await this.inTransaction(mapId, async (client) => {
      await client.query(`delete from edges where map_id = $1 and id = $2`, [mapId, edgeId]);
    });
  }

  async setEdgeConfig(mapId: string, edgeId: string, key: string, value: unknown) {
    await this.inTransaction(mapId, async (client) => {
      const board = await readBoard(client, mapId);
      const next = apply(board, { op: "set_edge_config", edge_id: edgeId, key, value });
      await writeBoard(client, mapId, next);
    });
  }

  async unfold(mapId: string, nodeId: string) {
    await this.inTransaction(mapId, async (client) => {
      // Only the containment edge goes. Everything else this node takes part
      // in — checks reading it, records it contains — is untouched.
      await client.query(
        `delete from edges
          where map_id = $1 and to_node = $2 and config->>'rel' = 'contains'`,
        [mapId, nodeId],
      );
    });
  }

  /** Any board edit, with the comment reconciliation that has to follow it. */
  private async inTransaction(
    mapId: string, fn: (c: PoolClient) => Promise<void>,
  ): Promise<void> {
    const client = await db().connect();
    try {
      await client.query("begin");
      await client.query(`select id from process_maps where id = $1 for update`, [mapId]);
      await fn(client);
      await reconcileComments(client, mapId);
      await client.query("commit");
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }

  async moveNode(mapId: string, nodeId: string, x: number, y: number) {
    await db().query(`update nodes set x = $3, y = $4 where map_id = $1 and id = $2`,
      [mapId, nodeId, x, y]);
  }

  async explainInstead(mapId: string, commentId: string, text: string) {
    // `answered`, not `resolved`: she has told us something, and the question
    // is still not settled. Non-terminal, so it still blocks freeze — but it
    // has visibly received her words, which `open` did not convey.
    const { rowCount } = await db().query(
      `update comments set answer = $3, status = 'answered'
        where map_id = $1 and id = $2 and status in ('open','answered')`,
      [mapId, commentId, JSON.stringify({ none_of_these: text })],
    );
    if (rowCount === 0) throw new Error("that comment is already settled");
  }

  async rejectComment(mapId: string, commentId: string) {
    const { rows, rowCount } = await db().query(
      `update comments set status = 'rejected'
         where map_id = $1 and id = $2 and status in ('open','answered')
         returning *`,
      [mapId, commentId],
    );
    if (rowCount === 0) throw new Error(`no open comment ${commentId}`);
    return rows[0] as CommentRow;
  }

  /**
   * Queue a round. The insert fires a trigger that pg_notify's 'review_runs',
   * which is how the worker wakes — the browser never calls it.
   */
  async requestReview(mapId: string) {
    const client = await db().connect();
    try {
      await client.query("begin");
      const { rows } = await client.query(
        `select coalesce(max(round), 0) + 1 as round from review_runs where map_id = $1`,
        [mapId],
      );
      const round = Number(rows[0].round);
      const runId = `run_${Date.now().toString(36)}_${round}`;
      await client.query(
        `insert into review_runs (id, map_id, round, status) values ($1, $2, $3, 'queued')`,
        [runId, mapId, round],
      );
      await client.query("commit");
      return { runId, round };
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }

  async reviewStatus(runId: string) {
    const { rows } = await db().query(`select status from review_runs where id = $1`, [runId]);
    return (rows[0]?.status ?? "gone") as "queued" | "running" | "done" | "failed" | "gone";
  }

  async freezeBoard(mapId: string, processId: string) {
    const client = await db().connect();
    try {
      await client.query("begin");
      await client.query(`select id from process_maps where id = $1 for update`, [mapId]);

      const board = await readBoard(client, mapId);
      const comments = await client.query(
        `select id, status from comments where map_id = $1`,
        [mapId],
      );
      const open = comments.rows.filter((c) => c.status === "open" || c.status === "answered");
      const resolved = comments.rows.filter((c) => c.status === "resolved");

      const result = freeze(board, {
        process_id: processId,
        comments: resolved.map((c) => c.id),
        open_comments: open.map((c) => c.id),
      });

      if (!result.ok) {
        await client.query("rollback");
        return {
          ok: false as const,
          nodeIds: result.node_ids,
          reasons: [...new Set(result.findings.map((f) => f.code))],
        };
      }

      const versionRow = await client.query(
        `select coalesce(max(version), 0) + 1 as v from frozen_specs where map_id = $1`,
        [mapId],
      );
      const version = Number(versionRow.rows[0].v);

      await client.query(
        `insert into frozen_specs (map_id, version, registry_version, spec, spec_hash)
         values ($1, $2, $3, $4, $5)`,
        [mapId, version, result.spec.registry_version, JSON.stringify(result.spec), result.spec.spec_hash],
      );
      await client.query(`update process_maps set status = 'frozen' where id = $1`, [mapId]);

      await client.query("commit");
      return { ok: true as const, specHash: result.spec.spec_hash, version };
    } catch (e) {
      await client.query("rollback");
      throw e;
    } finally {
      client.release();
    }
  }
}

/**
 * Close comments the board has outgrown.
 *
 * She can always fix something directly instead of answering the comment about
 * it — connect the node, type the field, delete the card. When she does, the
 * finding stops holding, but the comment row doesn't know that, so the board
 * goes on saying "this doesn't feed into anything" next to an edge she can see.
 *
 * The board is the source of truth. Any open comment whose finding no longer
 * exists is settled here, credited to her rather than to the agent.
 *
 * That rule holds for Pass A and ONLY for Pass A, and the difference is not a
 * detail — see the split below.
 */
async function reconcileComments(client: PoolClient, mapId: string): Promise<number> {
  const board = await readBoard(client, mapId);
  // Only ASKABLE findings keep a comment alive. A finding that has since been
  // reclassified as status — the compiler knows something is wrong but not
  // what she should do — leaves behind a pin offering options it can no longer
  // justify. Those retire themselves here rather than sitting on the board
  // asking a question nothing would ask today.
  //
  // Keyed with the config key, same as the review worker's dedupe: one code
  // fires on one node for several keys, and a three-part key makes a live
  // finding about `on_fail` vouch for an open comment about `describes`.
  const live = new Set(
    elaborate(board)
      .findings.filter((f) => f.askable)
      .map(findingKey),
  );

  const open = await client.query(
    `select id, code, node_id, edge_id, pass, mutation, mutation->>'key' as key
       from comments where map_id = $1 and status in ('open','answered')`,
    [mapId],
  );

  let closed = 0;
  for (const c of open.rows) {
    if (!retired(c, live, board)) continue;
    await client.query(
      `update comments set status = 'resolved', answer = $3 where map_id = $1 and id = $2`,
      [mapId, c.id, JSON.stringify({ resolved_directly: true })],
    );
    closed++;
  }
  return closed;
}

/**
 * Has the board outgrown this comment?
 *
 * Pass A mirrors a finding, so the finding's absence is the answer. Pass B does
 * not, and this is where that distinction earns its keep: a proposal exists
 * PRECISELY BECAUSE the compiler cannot see what it is proposing. "You wrote
 * about emailing the forwarder and no card sends anything" is not a graph
 * property — if it were, Pass A would have asked it. So `live` can never
 * contain a proposal, and matching on it closed every Pass B comment on the
 * next answer she gave, unanswered, with its mutation never applied. The
 * confirmation that resolves a policy went the same way, and the worker's
 * dedupe then refused to ask again: one policy, permanently unresolvable, and
 * a board with blocking findings and no questions left.
 *
 * A proposal is retired when she settles it, or when it has become impossible
 * to apply — she deleted the card it hung off. Nothing else.
 */
export function retired(
  c: { code: string; node_id: string | null; edge_id: string | null; pass: string | null;
       mutation: unknown; key: string | null },
  live: Set<string>,
  board: Board,
): boolean {
  if (c.pass === "B") {
    return validate(c.mutation as Mutation, board, { allowHoles: true }).length > 0;
  }
  return !live.has(askKey(c.code, c.node_id, c.edge_id, c.key));
}

// ── board <-> rows ──────────────────────────────────────────────────────

async function readBoard(client: PoolClient, mapId: string): Promise<Board> {
  const nodes = await client.query(
    `select id, primitive, label, config, x, y from nodes where map_id = $1 order by id`,
    [mapId],
  );
  const edges = await client.query(
    `select id, from_node, to_node, config from edges where map_id = $1 order by id`,
    [mapId],
  );
  return {
    nodes: nodes.rows as Node[],
    edges: edges.rows.map((r) => ({
      id: r.id, from: r.from_node, to: r.to_node, config: r.config,
    })) as Edge[],
  };
}

/**
 * Writes the board inside the caller's transaction, as a diff.
 *
 * The obvious implementation — delete everything, insert everything — is
 * wrong in a way that is invisible until it isn't: it deletes rows that other
 * rows point at, and it rewrites nodes she never touched. A mutation like
 * demote_to_field adds, removes and rewires in one step, so the diff is
 * computed rather than assumed, and only what actually changed is written.
 */
async function writeBoard(client: PoolClient, mapId: string, board: Board): Promise<void> {
  const before = await readBoard(client, mapId);

  const keepNodes = new Set(board.nodes.map((n) => n.id));
  const keepEdges = new Set(board.edges.map((e) => e.id));

  // Edges first: they reference nodes, so a node can only go once nothing
  // points at it.
  for (const e of before.edges) {
    if (!keepEdges.has(e.id)) {
      await client.query(`delete from edges where map_id = $1 and id = $2`, [mapId, e.id]);
    }
  }
  for (const n of before.nodes) {
    if (!keepNodes.has(n.id)) {
      await client.query(`delete from nodes where map_id = $1 and id = $2`, [mapId, n.id]);
    }
  }

  for (const n of board.nodes) {
    await client.query(
      `insert into nodes (map_id, id, primitive, label, config, x, y)
       values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (map_id, id) do update set
         primitive = excluded.primitive,
         label     = excluded.label,
         config    = excluded.config,
         x         = excluded.x,
         y         = excluded.y,
         updated_at = now()`,
      [mapId, n.id, n.primitive, n.label, JSON.stringify(n.config ?? {}), n.x ?? 0, n.y ?? 0],
    );
  }
  for (const e of board.edges) {
    await client.query(
      `insert into edges (map_id, id, from_node, to_node, config)
       values ($1,$2,$3,$4,$5)
       on conflict (map_id, id) do update set
         from_node = excluded.from_node,
         to_node   = excluded.to_node,
         config    = excluded.config`,
      [mapId, e.id, e.from, e.to, JSON.stringify(e.config ?? {})],
    );
  }
}

export const store: BoardStore = new PostgresStore();
