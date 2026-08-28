// Every comment carries its fix. Answering one is a structural edit, not a note
// — which is the whole reason `comments.mutation` is `not null`.
//
// These appliers are pure: Board in, Board out. The transaction that also flips
// the comment to `resolved` belongs to the worker; keeping it out of here is
// what lets the compiler stay dependency-free and testable without a database.
//
// No inverses and no event log. Nothing in the canvas is undone, so
// reversibility would be machinery paying for a capability the product doesn't
// have. Provenance lives on the comment row instead.

import { Graph, fieldsOf, splitPath } from "./graph.js";
import type { Board, Edge, Mutation, Node, NodeId } from "./types.js";

export class MutationError extends Error {}

/** A hole the compiler could not fill. Her answer supplies it before apply. */
const HOLE = null;

// ── validation ──────────────────────────────────────────────────────────

/**
 * Dropped-before-insert gate. A Pass B proposal whose mutation doesn't validate
 * never reaches the board — "a question the system can't apply is a question it
 * can't generate", enforced rather than intended.
 *
 * `allowHoles` is true at insert time (the answer hasn't arrived yet) and false
 * at apply time (it has, so nothing may still be null).
 */
export function validate(
  m: Mutation,
  board: Board,
  { allowHoles = false }: { allowHoles?: boolean } = {},
): string[] {
  const errs: string[] = [];
  const ids = new Set(board.nodes.map((n) => n.id));
  const edgeIds = new Set(board.edges.map((e) => e.id));
  const need = (id: string | null, what: string) => {
    if (id === HOLE) {
      if (!allowHoles) errs.push(`${what} is still unfilled at apply time`);
      return;
    }
    if (!ids.has(id)) errs.push(`${what} references unknown node "${id}"`);
  };

  switch (m.op) {
    case "set_config_key":
      need(m.node_id, "set_config_key.node_id");
      if (!m.key) errs.push("set_config_key.key is empty");
      if (m.value === HOLE && !allowHoles) errs.push("set_config_key.value is still unfilled");
      break;
    case "set_edge_config":
      if (!edgeIds.has(m.edge_id)) errs.push(`set_edge_config references unknown edge "${m.edge_id}"`);
      if (!m.key) errs.push("set_edge_config.key is empty");
      break;
    case "add_node":
      if (ids.has(m.node.id)) errs.push(`add_node would collide with existing "${m.node.id}"`);
      if (m.near) need(m.near, "add_node.near");
      break;
    case "add_edge":
      need(m.edge.from, "add_edge.from");
      need(m.edge.to, "add_edge.to");
      if (edgeIds.has(m.edge.id)) errs.push(`add_edge would collide with existing "${m.edge.id}"`);
      if (m.edge.from !== HOLE && m.edge.from === m.edge.to) errs.push("add_edge is a self-loop");
      break;
    case "delete_node":
      need(m.node_id, "delete_node.node_id");
      break;
    case "rename_node":
      need(m.node_id, "rename_node.node_id");
      if (m.label === HOLE) {
        if (!allowHoles) errs.push("rename_node.label is still unfilled");
      } else if (!m.label.trim()) {
        errs.push("rename_node.label is empty");
      }
      break;
    case "merge_nodes":
      need(m.keep, "merge_nodes.keep");
      need(m.drop, "merge_nodes.drop");
      if (m.keep === m.drop) errs.push("merge_nodes.keep === drop");
      break;
    case "demote_to_field":
      need(m.node_id, "demote_to_field.node_id");
      need(m.parent_id, "demote_to_field.parent_id");
      if (!m.field) errs.push("demote_to_field.field is empty");
      for (const p of m.rewire_policies) need(p, "demote_to_field.rewire_policies");
      break;
    case "add_output_row":
      need(m.node_id, "add_output_row.node_id");
      break;
    case "record_elicited":
      need(m.node_id, "record_elicited.node_id");
      break;
    case "sequence": {
      if (m.steps.length === 0) errs.push("sequence has no steps");
      // Each step is validated against the board AS IT WILL BE when that step
      // runs, so a sequence may add a node and then connect it. Validating every
      // step against the original board would reject exactly the case batches
      // exist for.
      let staged = board;
      for (const [i, step] of m.steps.entries()) {
        const stepErrs = validate(step, staged, { allowHoles });
        errs.push(...stepErrs.map((e) => `step ${i + 1}: ${e}`));
        if (stepErrs.length === 0 && !allowHoles) {
          try { staged = apply(staged, step); } catch { /* reported above */ }
        } else if (stepErrs.length === 0) {
          staged = stage(staged, step);
        }
      }
      break;
    }
    default: {
      const never: never = m;
      errs.push(`unknown mutation op: ${JSON.stringify(never)}`);
    }
  }
  return errs;
}

// ── filling holes ───────────────────────────────────────────────────────

/**
 * Her answer supplies what the compiler couldn't choose. The shape of the hole
 * is fixed by the mutation type, so an answer can only land where a hole is —
 * it can never introduce a field the mutation didn't already declare.
 */
export function fill(m: Mutation, answer: unknown): Mutation {
  switch (m.op) {
    case "set_config_key":
      return m.value === HOLE ? { ...m, value: answer } : m;
    case "set_edge_config":
      return m.value === HOLE ? { ...m, value: answer } : m;
    case "rename_node":
      return m.label === HOLE && typeof answer === "string" ? { ...m, label: answer } : m;
    case "add_edge": {
      const edge = { ...m.edge };
      if (edge.from === HOLE && typeof answer === "string") edge.from = answer;
      else if (edge.to === HOLE && typeof answer === "string") edge.to = answer;
      return { ...m, edge };
    }
    default:
      return m;
  }
}

// ── appliers ────────────────────────────────────────────────────────────

export function apply(board: Board, m: Mutation): Board {
  const errs = validate(m, board);
  if (errs.length) throw new MutationError(errs.join("; "));

  switch (m.op) {
    case "set_config_key":
      return mapNode(board, m.node_id, (n) => ({
        ...n,
        config: { ...n.config, [m.key]: coerce(m.key, m.value) },
      }));

    case "set_edge_config":
      return {
        ...board,
        edges: board.edges.map((e) =>
          e.id === m.edge_id ? { ...e, config: { ...e.config, [m.key]: m.value } } : e,
        ),
      };

    case "add_node":
      return { ...board, nodes: [...board.nodes, m.node] };

    case "add_edge":
      // Holes are gone by now — validate() rejected any that survived.
      return { ...board, edges: [...board.edges, m.edge as Edge] };

    case "delete_node":
      return dropNodes(board, [m.node_id]);

    case "rename_node":
      return mapNode(board, m.node_id, (n) => ({ ...n, label: String(m.label).trim() }));

    case "merge_nodes":
      return mergeNodes(board, m.keep, m.drop);

    case "demote_to_field":
      return demoteToField(board, m.node_id, m.parent_id, m.field, m.rewire_policies);

    case "add_output_row":
      return mapNode(board, m.node_id, (n) => ({
        ...n,
        config: { ...n.config, rows: [...asRows(n.config.rows), m.row] },
      }));

    case "record_elicited":
      // The one mutation that does NOT unblock the build. It writes the draft
      // onto the node; the policy stays unresolved until she confirms.
      return mapNode(board, m.node_id, (n) => ({
        ...n,
        config: { ...n.config, ...m.proposal },
      }));

    case "sequence":
      return m.steps.reduce(apply, board);
  }
}

/**
 * A cheap forward-guess used only while validating a sequence with holes still in
 * it: enough for later steps to see that an earlier one added a node.
 */
function stage(board: Board, m: Mutation): Board {
  if (m.op === "add_node") return { ...board, nodes: [...board.nodes, m.node] };
  return board;
}

export function applyAll(board: Board, ms: Mutation[]): Board {
  return ms.reduce(apply, board);
}

// ── the fiddly one ──────────────────────────────────────────────────────

/**
 * Five boxes for five codes become one comment and one collapse.
 *
 * The rewire is what makes this safe: any check attached to the demoted node
 * has to move to the parent with the field name substituted, or the collapse
 * would silently drop a policy's subject. That's why `rewire_policies` is part
 * of the mutation rather than a follow-up question.
 */
function demoteToField(
  board: Board,
  nodeId: NodeId,
  parentId: NodeId,
  field: string,
  rewirePolicies: NodeId[],
): Board {
  const g = new Graph(board);
  const parent = g.node(parentId);
  if (!parent) throw new MutationError(`demote_to_field: no parent "${parentId}"`);

  let nodes = board.nodes.map((n) => {
    if (n.id !== parentId) return n;
    const fields = fieldsOf(n);
    return fields.includes(field)
      ? n
      : { ...n, config: { ...n.config, fields: [...fields, field] } };
  });

  const rewire = new Set(rewirePolicies);
  nodes = nodes.map((n) => {
    if (!rewire.has(n.id)) return n;

    // A read of the demoted record becomes a read of the parent's new field.
    const reads = Array.isArray(n.config.reads)
      ? (n.config.reads as string[]).map((path) =>
          splitPath(path).node === nodeId ? `${parentId}.${field}` : path,
        )
      : n.config.reads;

    // A verdict on the demoted record has no meaning once it stops being a
    // record — the verdict belongs to whatever contained it.
    const verdict_on = n.config.verdict_on === nodeId ? parentId : n.config.verdict_on;

    return { ...n, config: { ...n.config, ...(reads ? { reads } : {}), ...(verdict_on ? { verdict_on } : {}) } };
  });

  // Every policy that read the demoted node now needs an edge from the parent,
  // unless the parent already reaches it.
  const extraEdges: Edge[] = [];
  for (const pid of rewirePolicies) {
    const already = board.edges.some((e) => e.from === parentId && e.to === pid);
    if (!already) {
      extraEdges.push({ id: `e_${parentId}_${pid}`, from: parentId, to: pid, config: {} });
    }
  }

  const edges = [
    ...board.edges.filter((e) => e.from !== nodeId && e.to !== nodeId),
    ...extraEdges,
  ];

  return { nodes: nodes.filter((n) => n.id !== nodeId), edges };
}

/**
 * Compression. Only ever called for artifacts with identical fields AND
 * identical checks, so nothing is lost: everything pointing at `drop` is
 * repointed at `keep`, and duplicate edges collapse.
 */
function mergeNodes(board: Board, keep: NodeId, drop: NodeId): Board {
  const seen = new Set<string>();
  const edges: Edge[] = [];
  for (const e of board.edges) {
    const from = e.from === drop ? keep : e.from;
    const to = e.to === drop ? keep : e.to;
    if (from === to) continue; // the merge turned this into a self-loop
    const key = `${from}->${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({ ...e, from, to });
  }
  return { nodes: board.nodes.filter((n) => n.id !== drop), edges };
}

// ── helpers ─────────────────────────────────────────────────────────────

function mapNode(board: Board, id: NodeId, f: (n: Node) => Node): Board {
  return { ...board, nodes: board.nodes.map((n) => (n.id === id ? f(n) : n)) };
}

function dropNodes(board: Board, ids: NodeId[]): Board {
  const gone = new Set(ids);
  return {
    nodes: board.nodes.filter((n) => !gone.has(n.id)),
    edges: board.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to)),
  };
}

/**
 * `rows` is the one key whose answer arrives as prose and has to become
 * structure. She writes what she wants to know, one line each; every line
 * becomes a row that still needs a subject, which the compiler then asks about
 * one at a time. Nothing is invented — `of` is left empty on purpose.
 */
function coerce(key: string, value: unknown): unknown {
  if (key !== "rows") return value;
  const lines = Array.isArray(value)
    ? value.map(String)
    : String(value ?? "").split(/[\n,]/);
  const wanted = lines.map((l) => l.trim()).filter(Boolean);
  if (wanted.length === 0) return value;
  return wanted.map((label) => ({ label, fn: "count" }));
}

function asRows(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}
