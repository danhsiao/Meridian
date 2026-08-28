// The type system's own types. No domain nouns, by construction: a Node knows
// its primitive and carries an opaque config, and nothing here names an industry.

export type Primitive = "channel" | "artifact" | "policy" | "output";

export type NodeId = string;
export type EdgeId = string;

export interface Node {
  id: NodeId;
  primitive: Primitive;
  label: string; // reaches the extraction prompt, so it is inside the hash
  config: Record<string, unknown>;
  x?: number; // stripped before hashing
  y?: number;
}

export interface Edge {
  id: EdgeId;
  from: NodeId;
  to: NodeId;
  config: Record<string, unknown>;
}

export interface Board {
  nodes: Node[];
  edges: Edge[];
}

/**
 * An edge's resolved role. Derived from endpoint primitives at compile time —
 * there is no `kind` column on the edges table, and there must not be one.
 */
export type EdgeRole =
  | "derive"   // channel  -> artifact
  | "read"     // artifact -> policy
  | "input"    // artifact -> channel
  | "outcome"  // policy   -> output
  | "value"    // artifact -> output    (an output row reading a field directly)
  | "fail"     // policy   -> channel   (stripped from the data DAG)
  /**
   * output -> channel. The finished report goes somewhere: emailed at the end
   * of the run, posted, filed.
   *
   * Distinct from `fail`, and the distinction is the arity. A fail edge fires
   * per failing record, mid-run, and is stripped from the data DAG because it
   * is control flow. A report fires once, after the output is computed, and
   * stays IN topo_order — it is the last step of the run, not a handler.
   */
  | "report"   // output   -> channel
  | "contain"  // artifact -> artifact, rel = contains
  | "join"     // artifact -> artifact, rel = pairs_with
  | "merge";   // artifact -> artifact, rel = builds_from

export interface FailHandler {
  edge: EdgeId;
  signal: string;
  from: NodeId;
  to: NodeId;
  await: { channel: NodeId; correlate_on: string } | null;
  rescope_order: NodeId[];
  max_attempts: number;
  timeout: string | null;
  on_exhausted: "escalate" | "halt" | "continue";
}

export interface Join {
  edge: EdgeId;
  left: NodeId;
  right: NodeId;
  on: string;
}

/**
 * A containment edge a verdict travels along.
 *
 * `verdict_on` names one target per policy, and nothing else walks a
 * containment edge upward — so without this the grammar simply cannot express
 * "the parent fails when one of its children does", and a metric as ordinary as
 * "how many parents were clean" is unreachable on every board the system can
 * draw. Cycle-free by construction: the data subgraph already is, and these are
 * a subset of its edges.
 */
export interface Propagation {
  edge: EdgeId;
  /** The child whose verdicts are read. */
  from: NodeId;
  /** The parent that inherits them. */
  to: NodeId;
}

/**
 * What freeze() writes into the spec and codegen reads. Every field here is
 * something the compiler resolved so that Python never re-derives it.
 */
export interface IR {
  edge_roles: Record<EdgeId, EdgeRole>;
  topo_order: NodeId[];                    // fail edges stripped
  loop_scopes: Record<NodeId, EdgeId[]>;   // which `many` edges enclose this node
  verdict_targets: Record<NodeId, NodeId>; // policy -> artifact that takes the failure
  identity_merges: Record<NodeId, string>;
  joins: Join[];
  /** contains edges carrying on_child_fail: "fail_parent" */
  propagations: Propagation[];
  fail_handlers: FailHandler[];
}

/**
 * Two orthogonal axes, deliberately not collapsed into one.
 *
 * `severity` answers ONE question: does this stop freeze? Binary.
 * `rank` answers a different one: where does it sit in the comment queue?
 *
 * They diverge in both directions, which is why one enum can't carry both.
 * A `missing_field` precondition blocks AND sorts first. A `demote_to_field`
 * does NOT block — collapsing five nodes into five fields is an improvement,
 * not a correctness gap — but it still sorts above ordinary missing-key
 * questions, because fixing a modelling mistake in round one is what stops
 * round two asking five questions about five nodes that shouldn't exist.
 */
export type Severity = "blocking" | "advisory";

export type Rank = "precondition" | "structural" | "blocking" | "advisory";

export type FindingCode =
  // blocking, decided in code — these ARE the freeze predicates
  | "missing_required_key"
  | "missing_conditional_key"
  | "invalid_enum_value"
  | "unreachable_node"
  | "no_terminal_path"
  | "data_cycle"
  | "unbound_policy"
  | "output_row_unresolvable"
  | "undeclared_join"
  | "unmatched_reference"
  | "edge_not_expressible"
  | "channel_talks_to_itself"
  | "duplicate_label"
  | "unresolved_policy"
  | "reads_unbound"
  | "open_comment"
  // precondition — must be fixed before the key it unblocks is even askable
  | "missing_field"
  // advisory, structural correction
  | "demote_to_field"
  | "compression"
  | "dead_node"
  // Pass B proposals only
  | "missing_node"
  | "missing_edge"
  | "cardinality"
  | "lifecycle";

export type Anchor = { node_id: NodeId } | { edge_id: EdgeId };

export interface Finding {
  code: FindingCode;
  /**
   * Can this be ASKED yet, as opposed to merely being required?
   *
   * "What should on_absent be?" is meaningless on a bare card — she hasn't said
   * what the check does or what it looks at. Such a finding still blocks
   * freeze, because the key really is required; it just isn't a question worth
   * putting to her until the thing it depends on exists. The review agent only
   * raises askable findings; freeze counts them all.
   */
  askable: boolean;
  /** Does this stop freeze? */
  severity: Severity;
  /** Where does it sit in the queue? */
  rank: Rank;
  /** Exactly one. A diagnostic detached from its location is worth far less. */
  anchor: Anchor;
  /** The facts that fired it — render() turns these into English, never the reverse. */
  evidence: Record<string, unknown>;
  mutation: Mutation;
}

/**
 * An edge whose endpoint the compiler cannot choose. `null` means "her answer
 * supplies this" — the finding still carries a real mutation (so `mutation not
 * null` holds and every comment is still an edit), but one field is a hole the
 * option set fills. The applier rejects a null that survives to apply time.
 */
export interface EdgeTemplate extends Omit<Edge, "from" | "to"> {
  from: NodeId | null;
  to: NodeId | null;
}

export type Mutation =
  | { op: "set_config_key"; node_id: NodeId; key: string; value: unknown }
  | { op: "set_edge_config"; edge_id: EdgeId; key: string; value: unknown }
  | { op: "add_node"; node: Node; near?: NodeId }
  | { op: "add_edge"; edge: EdgeTemplate }
  | { op: "delete_node"; node_id: NodeId }
  /**
   * A label is not config — it is how she refers to the thing, and the only
   * name any question ever uses. That makes renaming a real edit rather than a
   * cosmetic one, so it goes through the same path as everything else.
   */
  | { op: "rename_node"; node_id: NodeId; label: string | null }
  | { op: "merge_nodes"; keep: NodeId; drop: NodeId }
  | { op: "demote_to_field"; node_id: NodeId; parent_id: NodeId; field: string;
      rewire_policies: NodeId[] }
  | { op: "add_output_row"; node_id: NodeId; row: Record<string, unknown> }
  | { op: "record_elicited"; node_id: NodeId; proposal: Record<string, unknown> }
  /**
   * Several edits that only make sense together.
   *
   * Proposing a card is really proposing a card AND the line that connects it —
   * added separately, the first step leaves the board briefly stranded and the
   * compiler complains about a node the agent is halfway through adding. One
   * comment, one answer, one transaction.
   */
  | { op: "sequence"; steps: Mutation[] };

export interface ElaborateResult {
  ir: Partial<IR>;
  findings: Finding[];
}

// ── registry shape ──────────────────────────────────────────────────────

export type Binding = "control" | "prompt" | "derived";

export interface KindSpec {
  required: string[];
  required_if?: Record<string, string[]>;
  optional?: string[];
  defaults?: Record<string, unknown>;
  enums?: Record<string, unknown>;
}

export interface AskSpec {
  binding: Binding;
  /** Raw enum value -> what she should see. She never reads an enum value. */
  option_labels?: Record<string, string>;
  options_from?: string;
  extensible?: boolean;
  closed_because?: string;
  intent?: string;
  multi?: boolean;
}

export interface Registry {
  registry_version: string;
  kinds: Record<string, KindSpec>;
  /** key -> the named condition that must hold before it's worth asking. */
  askable_if?: Record<string, string>;
  required_if_codes?: Record<string, FindingCode>;
  ask: Record<string, AskSpec>;
  templates: Record<string, { reads: string[] }>;
  reads_compiler: string[];
}
