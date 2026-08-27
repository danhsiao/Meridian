// The `required_if` conditions. The registry NAMES these; it never expresses
// them. That split is what keeps registry.json free of graph-traversal logic
// and free of target-language syntax at the same time.

import { Graph, fieldsOf, splitPath } from "./graph.js";
import type { Edge, Node } from "./types.js";

export type NodeCondition = (n: Node, g: Graph) => boolean;
export type EdgeCondition = (e: Edge, g: Graph) => boolean;

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
  // Built from several parents, so something has to say which rows combine.
  multiple_inbound_artifacts: (n, g) => g.inboundArtifacts(n.id).length > 1,
  // Two artifacts off one channel: something has to say which attachment is which.
  sibling_artifacts_from_same_channel: (n, g) => {
    if (n.primitive !== "artifact") return false;
    const channels = g.inboundChannels(n.id).map((c) => c.id);
    return channels.some((cid) =>
      g.outboundOf(cid, "artifact").filter((a) => a.id !== n.id).length > 0,
    );
  },

  // ── policy ───────────────────────────────────────────────────────────
  resolved_to_relation: (n) => n.config?.check != null,
  resolved_to_impl: (n) => n.config?.impl != null,
  // Fires exactly when neither shape has resolved. The registry then requires
  // `check` — arbitrary, since `impl` would satisfy it equally, which is why
  // `required_if_codes` renames the finding to `unresolved_policy` rather than
  // letting the freeze error imply a relation is mandatory.
  neither_resolved: (n) => n.config?.check == null && n.config?.impl == null,
  // Reads span more than one artifact, so something must name which one takes
  // the failure — otherwise two different counts collapse into one.
  multiple_read_artifacts: (n) => {
    const reads = n.config?.reads;
    if (!Array.isArray(reads)) return false;
    const artifacts = new Set(reads.map((p) => splitPath(String(p)).node));
    return artifacts.size > 1;
  },
};

export const edgeConditions: Record<string, EdgeCondition> = {
  // `rel` means nothing on a channel->artifact edge; it only discriminates
  // the three artifact->artifact shapes.
  endpoints_are_artifacts: (e, g) =>
    g.primitiveOf(e.from) === "artifact" && g.primitiveOf(e.to) === "artifact",
  rel_is_pairs_with: (e) => e.config?.rel === "pairs_with",
};

// ── option sources ──────────────────────────────────────────────────────
// Computed BEFORE the model is called. The model relabels these into plain
// English; it never produces a value, so it cannot invent one.

export interface Option {
  value: string | number;
  label: string;
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
