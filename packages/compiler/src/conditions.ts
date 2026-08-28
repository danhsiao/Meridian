// The `required_if` conditions. The registry NAMES these; it never expresses
// them. That split is what keeps registry.json free of graph-traversal logic
// and free of target-language syntax at the same time.

import { Graph, fieldsOf, splitPath } from "./graph.js";
import type { Edge, Node } from "./types.js";

export type NodeCondition = (n: Node, g: Graph) => boolean;
export type EdgeCondition = (e: Edge, g: Graph) => boolean;

/**
 * Has this policy resolved to something that can be compiled?
 *
 * Presence is not resolution. `check` and `impl` are `derived` keys — the shape
 * the agent produced from her description — and a non-null value that is a
 * sentence rather than a relation resolves nothing. Four consumers test a
 * policy for "settled" (these conditions, the resolution loop, the canvas fold
 * rule, freeze), and every one of them used `!= null`. Prose in `check` therefore
 * read as resolved everywhere at once: the resolver skipped the policy, the
 * canvas folded it into its parent record, and the board went quiet holding a
 * check nothing downstream could compile. One structural predicate, shared, so
 * "resolved" cannot mean different things in different files.
 */
export function resolvedToRelation(n: Node): boolean {
  const c = n.config?.check;
  return isPlainObject(c) && typeof c.relation === "string" && c.relation.length > 0;
}

export function resolvedToImpl(n: Node): boolean {
  const i = n.config?.impl;
  return isPlainObject(i) && typeof i.body === "string" && i.body.length > 0;
}

/** Resolved either way. What the canvas and the review worker actually ask. */
export function policyIsResolved(n: Node): boolean {
  return resolvedToRelation(n) || resolvedToImpl(n);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export const nodeConditions: Record<string, NodeCondition> = {
  // ── channel ──────────────────────────────────────────────────────────
  // Something is derived FROM this channel, so it needs to know which
  // messages belong to the process.
  has_outputs: (n, g) => g.outgoing(n.id).length > 0,
  // Something points AT this channel, so it needs to know what to send.
  has_inputs: (n, g) => g.incoming(n.id).length > 0,

  // ── artifact ─────────────────────────────────────────────────────────
  // The same record can arrive twice, so it needs a key to merge on.
  multiple_sources: (n, g) => g.incoming(n.id).length > 1,
  /**
   * Built from several parents, so something has to say which rows combine.
   *
   * Counts only the edges that CONTRIBUTE records — containment and
   * `builds_from`. A `pairs_with` edge is a lookup that runs against records
   * already extracted; it adds no second source, so it cannot create the
   * ambiguity `pair_on` exists to settle.
   *
   * Counting it produced a question with no answer: a record contained by one
   * parent and paired with another read as having two sources, `pair_on` was
   * required, and its option source is the fields those two share — which for a
   * containment parent and a join partner is routinely empty. render() then
   * threw EmptyOptionSet, so the board carried a blocking finding that could
   * never be asked and never be cleared.
   */
  multiple_inbound_artifacts: (n, g) =>
    g.incoming(n.id).filter((e) => {
      const from = g.node(e.from);
      return from?.primitive === "artifact" && e.config?.rel !== "pairs_with";
    }).length > 1,
  /**
   * A record with no child records must carry values of its own, or nothing is
   * ever extracted from it. One that DOES contain child records need not: the
   * values live on the children, and two records hanging off it already answer
   * "what do you pull out of this?".
   */
  holds_no_child_records: (n, g) =>
    n.primitive === "artifact" && g.outboundOf(n.id, "artifact").length === 0,

  // Two artifacts off one channel: something has to say which attachment is which.
  sibling_artifacts_from_same_channel: (n, g) => {
    if (n.primitive !== "artifact") return false;
    const channels = g.inboundChannels(n.id).map((c) => c.id);
    return channels.some((cid) =>
      g.outboundOf(cid, "artifact").filter((a) => a.id !== n.id).length > 0,
    );
  },

  // ── policy ───────────────────────────────────────────────────────────
  resolved_to_relation: (n) => resolvedToRelation(n),
  resolved_to_impl: (n) => resolvedToImpl(n),
  // Fires exactly when neither shape has resolved. The registry then requires
  // `check` — arbitrary, since `impl` would satisfy it equally, which is why
  // `required_if_codes` renames the finding to `unresolved_policy` rather than
  // letting the freeze error imply a relation is mandatory.
  neither_resolved: (n) => !resolvedToRelation(n) && !resolvedToImpl(n),
  /**
   * Named by nothing in `required_if`, deliberately. The finding it drives
   * carries an `add_edge` mutation, and the generic conditional-key path can
   * only emit `set_config_key` — so it is a dedicated graph check, the same
   * shape as `undeclared_join`. Declared here anyway so it stays a named,
   * implemented, testable predicate rather than a lambda inside elaborate().
   */
  relation_is_exists_matching: (n, g) => existsMatchingWithoutJoin(n, g),

  // Reads span more than one artifact, so something must name which one takes
  // the failure — otherwise two different counts collapse into one.
  multiple_read_artifacts: (n) => {
    const reads = n.config?.reads;
    if (!Array.isArray(reads)) return false;
    const artifacts = new Set(reads.map((p) => splitPath(String(p)).node));
    return artifacts.size > 1;
  },
};

/**
 * Askability, not requirement.
 *
 * A bare policy card genuinely requires `on_absent` — but asking "what should
 * happen when the value is empty?" before she has said what the check even
 * does is a question about nothing. These say when a key becomes a real
 * question. The requirement is unchanged; only the asking waits.
 *
 * The rule of thumb this enforces: a new empty card produces exactly ONE
 * question, and it is about what the thing is. Everything else follows.
 */
export const askableConditions: Record<string, NodeCondition> = {
  policy_described_and_bound: (n, g) =>
    nonEmpty(n.config?.describes) && g.inboundArtifacts(n.id).length > 0,
  artifact_has_fields: (n) => Array.isArray(n.config?.fields) && n.config.fields.length > 0,
  channel_described: (n) => nonEmpty(n.config?.describes),
  artifact_described: (n) => nonEmpty(n.config?.describes),
  /** Where does it fit in the process? Only fair once she's said what it IS. */
  described: (n) => nonEmpty(n.config?.describes),
  output_described: (n) => nonEmpty(n.config?.describes),
};

export const askableEdgeConditions: Record<string, EdgeCondition> = {
  // Asking "which value connects them?" is only meaningful once there IS one.
  endpoints_share_a_field: (e, g) => {
    const a = fieldsOf(g.node(e.from));
    const b = fieldsOf(g.node(e.to));
    return a.some((x) => b.includes(x));
  },
};

function nonEmpty(v: unknown): boolean {
  return typeof v === "string" ? v.trim().length > 0 : v != null;
}

export const edgeConditions: Record<string, EdgeCondition> = {
  // `rel` means nothing on a channel->artifact edge; it only discriminates
  // the three artifact->artifact shapes.
  endpoints_are_artifacts: (e, g) =>
    g.primitiveOf(e.from) === "artifact" && g.primitiveOf(e.to) === "artifact",
  rel_is_pairs_with: (e) => e.config?.rel === "pairs_with",
  /**
   * A containment edge has to say whether a verdict travels along it.
   *
   * Not a fifth primitive: containment already encodes parent-child, and this
   * only says whether failure is inherited across that existing line. Without
   * it the grammar cannot express "the parent fails when one of its children
   * does" — `verdict_on` names a single target and nothing walks a containment
   * edge upward — so a whole class of ordinary metric is unreachable on any
   * board the system can draw.
   */
  rel_is_contains: (e) => e.config?.rel === "contains",
};

/**
 * An `exists_matching` policy with nothing to match against.
 *
 * The relation looks a subject value up in a pool of candidate values, and what
 * pairs the two sides is a `pairs_with` edge. Read two artifacts with no join
 * between them and the policy compiles, runs, and compares values that were
 * never related — every record fails, or worse, some pass by coincidence.
 *
 * The predicate is the whole condition rather than just "is the relation
 * exists_matching", for the same reason `neither_resolved` is: a condition that
 * names its own finding code IS the test, and the generic emptiness check is
 * skipped for it. Named for the registry key it hangs off; documented here for
 * what it actually decides.
 */
export function existsMatchingWithoutJoin(n: Node, g: Graph): boolean {
  if (n.primitive !== "policy") return false;
  const relation = (n.config?.check as { relation?: unknown } | undefined)?.relation;
  if (relation !== "exists_matching") return false;

  const reads = n.config?.reads;
  if (!Array.isArray(reads)) return false;
  const artifacts = [...new Set(reads.map((p) => splitPath(String(p)).node))];
  if (artifacts.length < 2) return false;

  // Any join between any two of the artifacts it reads is enough: the policy
  // needs *a* pairing, not one per combination.
  for (let i = 0; i < artifacts.length; i++) {
    for (let j = i + 1; j < artifacts.length; j++) {
      const joined = g.edges.some(
        (e) =>
          e.config?.rel === "pairs_with" &&
          ((e.from === artifacts[i] && e.to === artifacts[j]) ||
            (e.from === artifacts[j] && e.to === artifacts[i])),
      );
      if (joined) return false;
    }
  }
  return true;
}

// ── option sources ──────────────────────────────────────────────────────
// Computed BEFORE the model is called. The model relabels these into plain
// English; it never produces a value, so it cannot invent one.

export interface Option {
  value: string | number;
  label: string;
  /**
   * Declining. Answering applies the comment's mutation, so an option that
   * means "no" must say so — otherwise "No, they're unrelated" runs the
   * add_edge it was declining, and "No, it should connect to something" runs
   * the delete_node. Both did, until this existed.
   */
  rejects?: true;
  /** "None of these — let me explain." Opens free text instead of answering. */
  escape?: true;
}

const opt = (v: string | number, label?: string): Option => ({ value: v, label: label ?? String(v) });

export type OptionSource = (
  subject: Node | Edge,
  g: Graph,
  key: string,
  enums?: Record<string, unknown>,
) => Option[];

export const optionSources: Record<string, OptionSource> = {
  enum: (_s, _g, key, enums) => {
    const values = enums?.[key];
    return Array.isArray(values) ? values.map((v) => opt(v as string | number)) : [];
  },

  own_fields: (s, g) => fieldsOf(g.node((s as Node).id)).map((f) => opt(f)),

  shared_fields_of_inbound_artifacts: (s, g) => {
    const parents = g.inboundArtifacts((s as Node).id);
    if (parents.length === 0) return [];
    const lists = parents.map((p) => fieldsOf(p));
    return lists.reduce((a, b) => a.filter((x) => b.includes(x))).map((f) => opt(f));
  },

  inbound_artifact_nodes: (s, g) =>
    g.inboundArtifacts((s as Node).id).map((p) => opt(p.id, p.label)),

  shared_fields_of_endpoints: (s, g) => {
    const e = s as Edge;
    const a = fieldsOf(g.node(e.from));
    const b = fieldsOf(g.node(e.to));
    return a.filter((x) => b.includes(x)).map((f) => opt(f));
  },

  // Union, not intersection: a policy reading two artifacts must be able to
  // require a field that only one of them has.
  read_artifact_fields: (s, g) => {
    const seen = new Set<string>();
    const out: Option[] = [];
    for (const p of g.inboundArtifacts((s as Node).id)) {
      for (const f of fieldsOf(p)) {
        const path = `${p.id}.${f}`;
        if (!seen.has(path)) {
          seen.add(path);
          out.push(opt(path, `${p.label} — ${f}`));
        }
      }
    }
    return out;
  },

  // The artifacts the policy reads. Note this is a property of the GRAPH, not
  // of any run: no records exist while she is drawing the board, so the option
  // set cannot be "the failed ones". Narrowing to failed records happens in
  // logic.rescope at execution time.
  upstream_artifacts_of_policy: (s, g) =>
    g.inboundArtifacts((s as Edge).from).map((p) => opt(p.id, p.label)),

  inbound_channels: (s, g) => g.sourceChannels().map((c) => opt(c.id, c.label)),

  resolvable_row_targets: (s, g) => {
    const out: Option[] = [];
    for (const a of g.byPrimitive("artifact")) {
      out.push(opt(a.id, a.label));
      for (const f of fieldsOf(a)) out.push(opt(`${a.id}.${f}`, `${a.label} — ${f}`));
    }
    return out;
  },

  // Resolved at load from the runtime's channel dispatch table. Kept as a
  // function so adding a transport never touches the compiler.
  transport_registry: () => transportRegistry.map((t) => opt(t.value, t.label)),
};

/** Mirrors runtime/channels/registry.py. One row today; rows tomorrow. */
export const transportRegistry: Option[] = [
  { value: "composio.gmail", label: "Gmail" },
];
