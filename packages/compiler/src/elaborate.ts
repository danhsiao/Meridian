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
import {
  askableConditions, askableEdgeConditions, edgeConditions,
  existsMatchingWithoutJoin, nodeConditions,
} from "./conditions.js";
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
  Propagation,
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

/**
 * A mutation the compiler cannot justify offering.
 *
 * Two shapes qualify. `add_edge` with a null endpoint means "something should
 * feed this, and I don't know what" — the candidates are every node on the
 * board, so any multiple choice is fabricated, and answering it produces an
 * edge the compiler had no basis for. `delete_node` means "this doesn't reach
 * anything" — true, and not grounds for offering to remove work she may be
 * midway through.
 *
 * Both are STATUS: a marker on the card and a line in the blocking list, fixed
 * by direct manipulation rather than by an interview. Comments are only for
 * keys where an option source produces real values from her board or the
 * registry; if the option set is invented, it isn't a question.
 */
function cannotBeAsked(m: Finding["mutation"]): boolean {
  if (m.op === "add_edge") return m.edge.from === null || m.edge.to === null;
  if (m.op === "delete_node") return true;
  return false;
}

function emit(
  ctx: Ctx,
  code: FindingCode,
  rank: Rank,
  anchor: Finding["anchor"],
  evidence: Record<string, unknown>,
  mutation: Finding["mutation"],
  askable = true,
): void {
  ctx.findings.push({
    code,
    severity: SEVERITY_OF[rank],
    rank,
    anchor,
    evidence,
    mutation,
    askable: askable && !cannotBeAsked(mutation),
  });
}

/**
 * Is this key worth asking about yet? Still required either way — freeze counts
 * every blocking finding — but the review agent only raises askable ones.
 */
function askableNow(primitive: string, key: string, subject: Node | Edge, g: Graph): boolean {
  const name = registry.askable_if?.[`${primitive}.${key}`];
  if (!name) return true;
  const nodeCond = askableConditions[name];
  if (nodeCond) return nodeCond(subject as Node, g);
  const edgeCond = askableEdgeConditions[name];
  if (edgeCond) return edgeCond(subject as Edge, g);
  return true;
}

export function elaborate(board: Board): ElaborateResult {
  const g = new Graph(board);
  const ctx: Ctx = { g, findings: [] };

  checkNodeKeys(ctx);
  checkEdgeKeys(ctx);
  const roles = resolveEdgeRoles(ctx);
  checkGraph(ctx);
  checkReferenceJoins(ctx);
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
          { op: "set_config_key", node_id: n.id, key, value: null },
          askableNow(n.primitive, key, n, ctx.g));
      }
    }

    for (const [condName, keys] of Object.entries(spec.required_if ?? {})) {
      const cond = nodeConditions[condName];
      if (!cond || !cond(n, ctx.g)) continue;
      const code = registry.required_if_codes?.[condName] ?? "missing_conditional_key";

      // A condition that names its own finding code IS the predicate. The
      // generic path asks "is the key empty?", but `neither_resolved` already
      // asked a sharper question — has this resolved to something compilable —
      // and the key it names is only the peg the requirement hangs on. Testing
      // emptiness on top of it means a `check` holding a sentence reads as
      // filled, the condition fires, and no finding comes out: the board sits
      // blocked with nothing to say.
      const named = registry.required_if_codes?.[condName] != null;

      for (const key of keys) {
        if (!named && !isEmpty(n.config[key])) continue;

        // `unresolved_policy` names `check` because `required_if` has no "one
        // of" grammar. But `check` is a `derived` key holding a compiled
        // relation, and the question this finding asks is "say more about what
        // this does" — prose. Pointed at `check`, her answer lands in the slot
        // the agent was meant to fill, and the policy then reads as resolved to
        // everything downstream while holding a sentence. Her words belong in
        // `describes`, which is exactly what the resolution loop reads.
        const target = code === "unresolved_policy" ? "describes" : key;

        emit(ctx, code as FindingCode, "blocking", { node_id: n.id },
          { key: target, condition: condName, primitive: n.primitive,
            describes: n.config.describes },
          { op: "set_config_key", node_id: n.id, key: target, value: null },
          askableNow(n.primitive, key, n, ctx.g));
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
            { op: "set_edge_config", edge_id: e.id, key, value: null },
            askableNow("edge", key, e, ctx.g));
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
    // "verdicts from policies, values from artifacts" — an output may read a
    // field straight off a record without a check in between.
    else if (from === "artifact" && to === "output") roles[e.id] = "value";
    else if (from === "policy" && to === "channel") roles[e.id] = "fail";
    // The finished report goes somewhere. Once, at the end — so unlike a fail
    // edge this is a data edge and stays in topo_order.
    else if (from === "output" && to === "channel") roles[e.id] = "report";
    else if (from === "artifact" && to === "artifact") {
      // Declared, never inferred. Inferring containment from a missing `on`
      // means a join drawn without a key compiles as extraction — a silently
      // wrong compile, which is the failure class this design exists to stop.
      const rel = e.config.rel;
      if (rel === "pairs_with") roles[e.id] = "join";
      else if (rel === "builds_from") roles[e.id] = "merge";
      else if (rel === "contains") roles[e.id] = "contain";
      // No rel yet: leave it out. `required_if: endpoints_are_artifacts` is
      // already asking, and defaulting to containment would let a join she
      // hasn't described compile as an extraction.
    } else {
      // No role means codegen has nothing to emit for this edge. Dropping it
      // quietly would let her draw a connection that does nothing — the same
      // silently-wrong-compile class the `rel` discriminator exists to stop.
      emit(ctx, "edge_not_expressible", "blocking", { edge_id: e.id },
        { from_primitive: from, to_primitive: to },
        { op: "set_edge_config", edge_id: e.id, key: "rel", value: null });
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
  const described = (n: Node) => askableConditions.described(n, g);

  const reachable = reachableFrom(sources, g.edges);
  for (const n of g.nodes) {
    if (!reachable.has(n.id)) {
      // `from` is null on purpose: the compiler knows the node is stranded but
      // not what should feed it. Her answer picks from `candidates`, and the
      // applier rejects a null that survives to apply time. The finding still
      // carries a real mutation, so every comment is still an edit.
      emit(ctx, "unreachable_node", "blocking", { node_id: n.id },
        { candidates: sources },
        { op: "add_edge", edge: { id: `e_in_${n.id}`, from: null, to: n.id, config: {} } },
        described(n));
    }
  }

  const terminals = g.nodes
    .filter((n) => n.primitive === "output" || g.isOutboundChannel(n.id))
    .map((n) => n.id);
  const productive = reachesAny(terminals, g.edges);
  for (const n of g.nodes) {
    if (!productive.has(n.id)) {
      emit(ctx, "no_terminal_path", "blocking", { node_id: n.id }, { terminals },
        { op: "delete_node", node_id: n.id }, described(n));
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
        { op: "add_edge", edge: { id: `e_read_${p.id}`, from: null, to: p.id, config: {} } },
        described(p));
    }
  }

  /**
   * Nothing this process sends may be sent to the place its work arrives from.
   *
   * An edge pointing at a channel that also feeds the process makes it talk to
   * itself: the generated agent polls that mailbox AND posts into it, so its
   * own messages come back as new work. It also forces one channel to carry
   * both `match` and `request`, which are answers to two different questions.
   *
   * Both send edges are covered. A fail edge does it per failing record; a
   * report edge does it once at the end. The loop is the same either way, and
   * limiting the check to fail edges would have let the second one through the
   * moment reports existed.
   *
   * This is caught here rather than in a prompt on purpose. Pass B proposing
   * such an edge cannot survive validation regardless of how the prompt is
   * worded, and prompt discipline is the weaker of the two guarantees.
   */
  for (const c of g.byPrimitive("channel")) {
    const isSource = g.outboundOf(c.id, "artifact").length > 0;
    const sendInto = g.incoming(c.id).filter((e) => {
      const from = g.primitiveOf(e.from);
      return from === "policy" || from === "output";
    });
    if (isSource && sendInto.length > 0) {
      emit(ctx, "channel_talks_to_itself", "blocking", { edge_id: sendInto[0].id },
        { channel: c.id },
        { op: "set_edge_config", edge_id: sendInto[0].id, key: "on", value: null },
        false);
    }
  }

  /**
   * Two cards with the same name.
   *
   * Legal — ids are distinct and the graph compiles — but every question the
   * review agent asks refers to things by the label she typed, and the playback
   * of a resolved check is deliberately written in those labels too. Two cards
   * sharing a name makes all of that ambiguous, and only she can say which is
   * which. Advisory, because the spec is fine; ranked structurally, because
   * leaving it produces rounds of questions she cannot answer confidently.
   */
  const byLabel = new Map<string, NodeId[]>();
  for (const n of g.nodes) {
    const k = n.label.trim().toLowerCase();
    if (!k) continue;
    byLabel.set(k, [...(byLabel.get(k) ?? []), n.id]);
  }
  for (const ids of byLabel.values()) {
    if (ids.length < 2) continue;
    // Anchored to the later ones: the first keeps the name it had.
    for (const id of ids.slice(1)) {
      emit(ctx, "duplicate_label", "structural", { node_id: id },
        { count: ids.length, others: ids.filter((x) => x !== id) },
        { op: "rename_node", node_id: id, label: null });
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

/**
 * An `exists_matching` policy with nothing pairing its two sides.
 *
 * The relation looks a subject value up in a pool of candidates; a `pairs_with`
 * edge is what says those two sets of records are related at all. Without one
 * the policy still compiles and still runs — it just compares values that were
 * never paired, so every record fails, or some pass by coincidence.
 *
 * Its own check rather than a `required_if` entry, because the fix is an edge
 * and the generic conditional-key path can only emit `set_config_key`. Same
 * shape as `undeclared_join`, which exists for the same reason.
 */
function checkReferenceJoins(ctx: Ctx): void {
  const { g } = ctx;
  for (const p of g.byPrimitive("policy")) {
    if (!existsMatchingWithoutJoin(p, g)) continue;

    const reads = Array.isArray(p.config.reads) ? p.config.reads : [];
    const artifacts = unique(reads.map((r) => splitPath(String(r)).node)).filter((id) =>
      g.primitiveOf(id) === "artifact",
    );
    if (artifacts.length < 2) continue;
    const [left, right] = artifacts;

    // The join key is the field the two share. Where they share none, the
    // option set is empty and render() throws EmptyOptionSet rather than
    // showing a blank dropdown — the real gap is a `missing_field` on one of
    // the parents, which checkPolicyReads already raises.
    const shared = fieldsOf(g.node(left)).filter((f) => fieldsOf(g.node(right)).includes(f));
    emit(ctx, "unmatched_reference", "blocking", { node_id: p.id },
      { left, right, shared },
      { op: "add_edge", edge: { id: `e_${left}_${right}`, from: left, to: right,
                                config: { rel: "pairs_with", on: shared[0] ?? null } } });
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
      /**
       * A count with no target is a label, not a metric.
       *
       * This fired on absence for the first time after a board froze cleanly
       * with two rows reading `{ fn: "count", label: "How many we processed" }`
       * and produced `null` for both at run time. The check only ever tested
       * whether a PRESENT `of` resolved, so an absent one skipped every branch
       * below and the board shipped unable to produce a single number.
       *
       * The option set is real — every artifact on the board and every field on
       * one — so this is a question she can answer, not a status.
       */
      if (!of) {
        emit(ctx, "output_row_unresolvable", "blocking", { node_id: o.id },
          { row: row.label, reason: "no target", of: null },
          { op: "add_output_row", node_id: o.id, row });
        continue;
      }
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

      // Sharing an identity key means these are two records that pair up, and
      // `undeclared_join` is already asking her to connect them. Proposing a
      // merge as well would be contradictory advice about the same two nodes.
      const ka = a.config.identity_key, kb = b.config.identity_key;
      if (ka && ka === kb) continue;

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

  /**
   * Containment edges a verdict travels along. Codegen walks these after every
   * policy has run — propagation reads verdicts, so it cannot run earlier.
   */
  const propagations: Propagation[] = [];
  for (const e of g.edges) {
    if (roles[e.id] !== "contain") continue;
    if (e.config.on_child_fail !== "fail_parent") continue;
    propagations.push({ edge: e.id, from: e.to, to: e.from });
  }
  ir.propagations = propagations;

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
