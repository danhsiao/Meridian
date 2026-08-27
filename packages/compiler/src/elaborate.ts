// One traversal, two outputs.
//
//   elaborate(nodes, edges) -> { ir, findings }
//
// Where it can resolve the graph, it writes IR. Where it hits a hole, it emits
// a Finding. Review renders the findings as pins; freeze is `no blocking
// findings`; codegen reads the IR that freeze wrote into the spec. A question
// exists exactly when the elaborator hit a hole it could not fill, and the IR
// is what it filled in everywhere else — which is why the review agent asks
// precisely the questions the compiler would ask. Same function.

import registryJson from "../registry.json" with { type: "json" };
import { edgeConditions, nodeConditions } from "./conditions.js";
import {
  Graph,
  fieldsOf,
  loopScopes,
  reachableFrom,
  reachesAny,
  splitPath,
  topoSort,
  unique,
} from "./graph.js";
import type {
  Board,
  Edge,
  EdgeRole,
  ElaborateResult,
  FailHandler,
  Finding,
  FindingCode,
  IR,
  Join,
  Node,
  NodeId,
  Rank,
  Registry,
  Severity,
} from "./types.js";

export const registry = registryJson as unknown as Registry;

interface Ctx {
  g: Graph;
  findings: Finding[];
}

/**
 * Queue order. Preconditions first, because they unblock the keys below them.
 * Then structural correction — collapsing five nodes that shouldn't exist
 * BEFORE asking five questions about them is the whole point of ranking it
 * high, even though it doesn't block freeze. Then ordinary blocking findings,
 * then the rest.
 */
const RANK_ORDER: Record<Rank, number> = {
  precondition: 0,
  structural: 1,
  blocking: 2,
  advisory: 3,
};

/** Severity is derived from rank, never passed in — they can't drift apart. */
const SEVERITY_OF: Record<Rank, Severity> = {
  precondition: "blocking",
  structural: "advisory",
  blocking: "blocking",
  advisory: "advisory",
};

function emit(
  ctx: Ctx,
  code: FindingCode,
  rank: Rank,
  anchor: Finding["anchor"],
  evidence: Record<string, unknown>,
  mutation: Finding["mutation"],
): void {
  ctx.findings.push({ code, severity: SEVERITY_OF[rank], rank, anchor, evidence, mutation });
}

export function elaborate(board: Board): ElaborateResult {
  const g = new Graph(board);
  const ctx: Ctx = { g, findings: [] };

  checkNodeKeys(ctx);
  checkEdgeKeys(ctx);
  const roles = resolveEdgeRoles(ctx);
  checkGraph(ctx);
  checkPolicyReads(ctx);

  // Computed once. A cyclic board yields order === null, and every downstream
  // consumer has to see that rather than silently receiving an empty order and
  // waving through checks it cannot actually evaluate.
  const dag = buildDataDag(ctx);
  checkOutputRows(ctx, dag);
  structuralCorrections(ctx);

  const ir = buildIR(ctx, roles, dag);

  ctx.findings.sort(
    (a, b) =>
      RANK_ORDER[a.rank] - RANK_ORDER[b.rank] ||
      a.code.localeCompare(b.code) ||
      anchorId(a).localeCompare(anchorId(b)),
  );

  return { ir, findings: ctx.findings };
}

function anchorId(f: Finding): string {
  return "node_id" in f.anchor ? f.anchor.node_id : f.anchor.edge_id;
}

// ── registry checks ─────────────────────────────────────────────────────

function checkNodeKeys(ctx: Ctx): void {
  for (const n of ctx.g.nodes) {
    const spec = registry.kinds[n.primitive];
    if (!spec) continue;

    for (const key of spec.required) {
      if (isEmpty(n.config[key])) {
        emit(ctx, "missing_required_key", "blocking", { node_id: n.id }, { key, primitive: n.primitive },
          { op: "set_config_key", node_id: n.id, key, value: null });
      }
    }

    for (const [condName, keys] of Object.entries(spec.required_if ?? {})) {
      const cond = nodeConditions[condName];
      if (!cond || !cond(n, ctx.g)) continue;
      for (const key of keys) {
        if (isEmpty(n.config[key])) {
          const code = registry.required_if_codes?.[condName] ?? "missing_conditional_key";
          emit(ctx, code as FindingCode, "blocking", { node_id: n.id },
            { key, condition: condName, primitive: n.primitive },
            { op: "set_config_key", node_id: n.id, key, value: null });
        }
      }
    }

    checkEnums(ctx, n);
  }
}

function checkEnums(ctx: Ctx, n: Node): void {
  const enums = registry.kinds[n.primitive]?.enums ?? {};
  for (const [key, allowed] of Object.entries(enums)) {
    if (!Array.isArray(allowed)) continue; // "@transport_registry" and friends
    // A policy's relation lives at config.check.relation, not config.relation.
    const value = key === "relation"
      ? (n.config.check as { relation?: unknown } | undefined)?.relation
      : n.config[key];
    if (value == null) continue;
    if (!allowed.includes(value as never)) {
      emit(ctx, "invalid_enum_value", "blocking", { node_id: n.id },
        { key, value, allowed },
        { op: "set_config_key", node_id: n.id, key, value: null });
    }
  }
}

function checkEdgeKeys(ctx: Ctx): void {
  const spec = registry.kinds.edge;
  if (!spec) return;
  for (const e of ctx.g.edges) {
    for (const [condName, keys] of Object.entries(spec.required_if ?? {})) {
      const cond = edgeConditions[condName];
      if (!cond || !cond(e, ctx.g)) continue;
      for (const key of keys) {
        if (isEmpty(e.config[key])) {
          const code = registry.required_if_codes?.[condName] ?? "missing_conditional_key";
          emit(ctx, code as FindingCode, "blocking", { edge_id: e.id },
            { key, condition: condName },
            { op: "set_edge_config", edge_id: e.id, key, value: null });
        }
      }
    }
    for (const [key, allowed] of Object.entries(spec.enums ?? {})) {
      if (!Array.isArray(allowed)) continue;
      const value = e.config[key];
      // `on` is overloaded: a join key on artifact->artifact, a trigger literal
      // on policy->channel. It has no enum, so nothing to check here.
      if (value == null) continue;
      if (!allowed.includes(value as never)) {
        emit(ctx, "invalid_enum_value", "blocking", { edge_id: e.id }, { key, value, allowed },
          { op: "set_edge_config", edge_id: e.id, key, value: null });
      }
    }
  }
}

// ── edge roles ──────────────────────────────────────────────────────────

function resolveEdgeRoles(ctx: Ctx): Record<string, EdgeRole> {
  const roles: Record<string, EdgeRole> = {};
  for (const e of ctx.g.edges) {
    const from = ctx.g.primitiveOf(e.from);
    const to = ctx.g.primitiveOf(e.to);
    if (!from || !to) continue;

    if (from === "channel" && to === "artifact") roles[e.id] = "derive";
    else if (from === "artifact" && to === "policy") roles[e.id] = "read";
    else if (from === "artifact" && to === "channel") roles[e.id] = "input";
    else if (from === "policy" && to === "output") roles[e.id] = "outcome";
    else if (from === "policy" && to === "channel") roles[e.id] = "fail";
    else if (from === "artifact" && to === "artifact") {
      // Declared, never inferred. Inferring containment from a missing `on`
      // means a join drawn without a key compiles as extraction — a silently
      // wrong compile, which is the failure class this design exists to stop.
      const rel = e.config.rel;
      roles[e.id] =
        rel === "pairs_with" ? "join" : rel === "builds_from" ? "merge" : "contain";
    }
  }
  return roles;
}

// ── graph predicates ────────────────────────────────────────────────────

function checkGraph(ctx: Ctx): void {
  const { g } = ctx;
  const sources = g.sourceChannels().map((n) => n.id);

  // Reachability traverses fail edges — an outbound channel is only ever
  // reachable through one. Cycle detection below does not. Two different
  // traversals over the same graph; they must not share a visited set.
  const reachable = reachableFrom(sources, g.edges);
  for (const n of g.nodes) {
    if (!reachable.has(n.id)) {
      // `from` is null on purpose: the compiler knows the node is stranded but
      // not what should feed it. Her answer picks from `candidates`, and the
      // applier rejects a null that survives to apply time. The finding still
      // carries a real mutation, so every comment is still an edit.
      emit(ctx, "unreachable_node", "blocking", { node_id: n.id },
        { candidates: sources },
        { op: "add_edge", edge: { id: `e_in_${n.id}`, from: null, to: n.id, config: {} } });
    }
  }

  const terminals = g.nodes
    .filter((n) => n.primitive === "output" || g.isOutboundChannel(n.id))
    .map((n) => n.id);
  const productive = reachesAny(terminals, g.edges);
  for (const n of g.nodes) {
    if (!productive.has(n.id)) {
      emit(ctx, "no_terminal_path", "blocking", { node_id: n.id }, { terminals },
        { op: "delete_node", node_id: n.id });
    }
  }

  // Fail edges make the graph cyclic by design: the loop body is a DAG, the
  // loop is control flow. So strip them, then any surviving cycle is a real one.
  const dataEdges = g.dataEdges();
  if (topoSort(g.nodes, dataEdges) === null) {
    const anchor = findCycleNode(g.nodes, dataEdges) ?? g.nodes[0]?.id ?? "";
    emit(ctx, "data_cycle", "blocking", { node_id: anchor }, {},
      { op: "delete_node", node_id: anchor });
  }

  for (const p of g.byPrimitive("policy")) {
    if (g.inboundArtifacts(p.id).length === 0) {
      // Same hole, same reason: a check reading nothing needs an artifact, and
      // which one is hers to say.
      emit(ctx, "unbound_policy", "blocking", { node_id: p.id },
        { candidates: g.byPrimitive("artifact").map((a) => a.id) },
        { op: "add_edge", edge: { id: `e_read_${p.id}`, from: null, to: p.id, config: {} } });
    }
  }

  // Two artifacts keyed the same way, with no edge saying how they relate,
  // is a join the author meant to draw and didn't.
  const artifacts = g.byPrimitive("artifact");
  for (let i = 0; i < artifacts.length; i++) {
    for (let j = i + 1; j < artifacts.length; j++) {
      const a = artifacts[i], b = artifacts[j];
      const ka = a.config.identity_key, kb = b.config.identity_key;
      if (!ka || ka !== kb) continue;
      const joined = g.edges.some(
        (e) =>
          (e.from === a.id && e.to === b.id) || (e.from === b.id && e.to === a.id),
      );
      if (!joined) {
        emit(ctx, "undeclared_join", "blocking", { node_id: b.id }, { other: a.id, key: ka },
          { op: "add_edge", edge: { id: `e_${a.id}_${b.id}`, from: a.id, to: b.id,
                                    config: { rel: "pairs_with", on: ka } } });
      }
    }
  }
}

function findCycleNode(nodes: Node[], edges: Edge[]): NodeId | null {
  const order = new Set(topoSort(nodes, edges) ?? []);
  return nodes.find((n) => !order.has(n.id))?.id ?? null;
}

// ── policy reads ────────────────────────────────────────────────────────

function checkPolicyReads(ctx: Ctx): void {
  for (const p of ctx.g.byPrimitive("policy")) {
    const reads = p.config.reads;
    if (!Array.isArray(reads)) continue;
    const bound = new Set(ctx.g.inboundArtifacts(p.id).map((a) => a.id));
    for (const path of reads) {
      const { node, field } = splitPath(String(path));
      if (!bound.has(node)) {
        emit(ctx, "reads_unbound", "blocking", { node_id: p.id }, { path, node },
          { op: "add_edge", edge: { id: `e_${node}_${p.id}`, from: node, to: p.id, config: {} } });
        continue;
      }
      // A read naming a field the artifact doesn't declare is a precondition:
      // the field has to exist before the read can resolve.
      if (field && !fieldsOf(ctx.g.node(node)).includes(field)) {
        emit(ctx, "missing_field", "precondition", { node_id: node }, { field, wanted_by: p.id },
          { op: "set_config_key", node_id: node, key: "fields",
            value: [...fieldsOf(ctx.g.node(node)), field] });
      }
    }
  }
}

// ── output rows ─────────────────────────────────────────────────────────

function checkOutputRows(ctx: Ctx, dag: DataDag): void {
  // No order means a cycle, which is already blocking. Re-checking `copy` rows
  // against a fabricated empty order would report passes we cannot justify.
  if (!dag.order) return;
  const scopes = dag.loop_scopes;

  for (const o of ctx.g.byPrimitive("output")) {
    const rows = o.config.rows;
    if (!Array.isArray(rows)) continue;
    for (const row of rows as Record<string, unknown>[]) {
      const of = row.of == null ? null : String(row.of);
      if (!of) continue;
      const { node, field } = splitPath(of);
      const target = ctx.g.node(node);
      if (!target) {
        emit(ctx, "output_row_unresolvable", "blocking", { node_id: o.id },
          { row: row.label, reason: "unknown node", of },
          { op: "add_output_row", node_id: o.id, row });
        continue;
      }
      if (field && !fieldsOf(target).includes(field)) {
        emit(ctx, "output_row_unresolvable", "blocking", { node_id: o.id },
          { row: row.label, reason: "unknown field", of },
          { op: "add_output_row", node_id: o.id, row });
        continue;
      }
      // `copy` takes one value. Reaching its target through a `many` edge means
      // there are N of them, and the row has no way to say which.
      if (row.fn === "copy" && (scopes[node]?.length ?? 0) > 0) {
        emit(ctx, "output_row_unresolvable", "blocking", { node_id: o.id },
          { row: row.label, reason: "copy across a many edge", of, loops: scopes[node] },
          { op: "add_output_row", node_id: o.id, row });
      }
    }
  }
}

// ── structural correction ───────────────────────────────────────────────
// Ranked above most missing-key questions: fixing a modelling mistake in round
// one means round two isn't asking five questions about five nodes that
// shouldn't exist.

function structuralCorrections(ctx: Ctx): void {
  const { g } = ctx;

  for (const a of g.byPrimitive("artifact")) {
    const parents = g.inboundArtifacts(a.id);
    const children = g.outboundOf(a.id, "artifact");
    // No fields, no children, exactly one artifact parent: a value pretending
    // to be a record. A verdict on "the code" has no meaning — the record is
    // missing a code.
    if (fieldsOf(a).length === 0 && children.length === 0 && parents.length === 1) {
      const parent = parents[0];
      const field = slug(a.label);
      const rewire = g.outboundOf(a.id, "policy").map((p) => p.id);
      emit(ctx, "demote_to_field", "structural", { node_id: a.id },
        { parent: parent.id, field, rewire_policies: rewire },
        { op: "demote_to_field", node_id: a.id, parent_id: parent.id, field,
          rewire_policies: rewire });
    }
  }

  // Identical fields AND identical checks. Only identical — anything less is a
  // deliberate split, and merging it would be wrong.
  const artifacts = g.byPrimitive("artifact");
  for (let i = 0; i < artifacts.length; i++) {
    for (let j = i + 1; j < artifacts.length; j++) {
      const a = artifacts[i], b = artifacts[j];

      // Two artifacts joined by an edge are RELATED, not duplicated. A record
      // and the document that matches it routinely share a key field and get
      // read by the same check — that is what a join looks like, and merging
      // them would destroy the join. Nothing is ever a duplicate of something
      // it points at.
      const related = ctx.g.edges.some(
        (e) => (e.from === a.id && e.to === b.id) || (e.from === b.id && e.to === a.id),
      );
      if (related) continue;

      const fa = [...fieldsOf(a)].sort().join("|");
      const fb = [...fieldsOf(b)].sort().join("|");
      if (!fa || fa !== fb) continue;
      const pa = g.outboundOf(a.id, "policy").map((p) => p.id).sort().join("|");
      const pb = g.outboundOf(b.id, "policy").map((p) => p.id).sort().join("|");
      if (pa !== pb) continue;
      emit(ctx, "compression", "structural", { node_id: b.id }, { same_as: a.id, fields: fieldsOf(a) },
        { op: "merge_nodes", keep: a.id, drop: b.id });
    }
  }
}

function slug(label: string): string {
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

// ── IR ──────────────────────────────────────────────────────────────────

interface DataDag {
  order: NodeId[] | null;
  loop_scopes: Record<NodeId, string[]>;
}

/**
 * The data DAG is what's reachable from a source channel over data edges. An
 * outbound channel hangs off a fail edge only, so it is NOT in topo_order — it
 * lives in fail_handlers and runs as a signal handler. Ordering and
 * reachability are deliberately different traversals of the same graph and
 * must not share a visited set.
 */
function buildDataDag(ctx: Ctx): DataDag {
  const { g } = ctx;
  const dataEdges = g.dataEdges();
  const inDag = reachableFrom(g.sourceChannels().map((n) => n.id), dataEdges);
  const dataNodes = g.nodes.filter((n) => inDag.has(n.id));
  const order = topoSort(dataNodes, dataEdges);
  return { order, loop_scopes: order ? loopScopes(g, order) : {} };
}

function buildIR(ctx: Ctx, roles: Record<string, EdgeRole>, dag: DataDag): Partial<IR> {
  const { g } = ctx;

  const ir: Partial<IR> = { edge_roles: roles };
  if (dag.order) {
    ir.topo_order = dag.order;
    ir.loop_scopes = dag.loop_scopes;
  }

  const verdict_targets: Record<NodeId, NodeId> = {};
  for (const p of g.byPrimitive("policy")) {
    const declared = p.config.verdict_on;
    if (typeof declared === "string") verdict_targets[p.id] = declared;
    else {
      // Derivable for a single-read policy, and only asked when it isn't.
      const inbound = g.inboundArtifacts(p.id);
      if (inbound.length === 1) verdict_targets[p.id] = inbound[0].id;
    }
  }
  ir.verdict_targets = verdict_targets;

  const identity_merges: Record<NodeId, string> = {};
  for (const a of g.byPrimitive("artifact")) {
    const k = a.config.identity_key;
    if (typeof k === "string") identity_merges[a.id] = k;
  }
  ir.identity_merges = identity_merges;

  const joins: Join[] = [];
  for (const e of g.edges) {
    if (roles[e.id] !== "join") continue;
    const on = e.config.on;
    if (typeof on === "string") joins.push({ edge: e.id, left: e.from, right: e.to, on });
  }
  ir.joins = joins;

  ir.fail_handlers = g.failEdges().map((e): FailHandler => {
    const awaitCfg = e.config.await as { channel?: string; correlate_on?: string } | undefined;
    const rescope = Array.isArray(e.config.rescope) ? (e.config.rescope as NodeId[]) : [];
    return {
      edge: e.id,
      signal: "reply_received",
      from: e.from,
      to: e.to,
      await: awaitCfg?.channel && awaitCfg?.correlate_on
        ? { channel: awaitCfg.channel, correlate_on: awaitCfg.correlate_on }
        : null,
      // The rescoped artifacts plus the policy that failed — re-checking the
      // narrowed records is the point, so the policy has to run again too.
      rescope_order: unique([...rescope, e.from]),
      max_attempts: numberOr(e.config.max_attempts, 1),
      timeout: typeof e.config.timeout === "string" ? e.config.timeout : null,
      on_exhausted: (e.config.on_exhausted as FailHandler["on_exhausted"]) ?? "escalate",
    };
  });

  return ir;
}

// ── helpers ─────────────────────────────────────────────────────────────

function isEmpty(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return Object.keys(v as object).length === 0;
  return false;
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function blockingFindings(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.severity === "blocking");
}
