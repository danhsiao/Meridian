// Finding -> the question a non-engineer can answer.
//
// The registry says what's missing; this says how to ask a human. Keeping them
// apart is what lets the registry stay free of English and the wording stay
// free of graph logic.
//
// Everything here is deterministic. The model is called AFTER this, by the
// worker, and only to relabel machine-computed options into her language — it
// never produces a value, so it cannot invent one. That is why Pass A is
// honestly "no model": the questions exist before any model sees the board.

import { registry } from "./elaborate.js";
import { optionSources, type Option } from "./conditions.js";
import { Graph } from "./graph.js";
import type {
  AskSpec,
  Binding,
  Board,
  Edge,
  Finding,
  Node,
  Primitive,
} from "./types.js";

export interface Rendered {
  code: Finding["code"];
  /** Plain English for what accepting will change, derived from the mutation. */
  preview: string | null;
  severity: Finding["severity"];
  rank: Finding["rank"];
  anchor: Finding["anchor"];
  binding: Binding;
  answer_kind: "choice" | "text";
  /** Machine-generated English. The model may improve the wording, never the meaning. */
  body: string;
  options: Option[] | null;
  mutation: Finding["mutation"];
  /**
   * Handed to the model so it can relabel. Deliberately excludes the anchor:
   * if the model never sees which node this is about, it cannot move it.
   */
  model_context: {
    code: string;
    condition?: string;
    intent?: string;
    closed_because?: string;
    label?: string;
  };
}

/**
 * What accepting will do, in her words, derived from the mutation itself — so
 * it can never disagree with what actually happens.
 */
function previewOf(m: Finding["mutation"], g: Graph): string | null {
  const name = (id: string | null | undefined) =>
    id ? `“${g.node(id)?.label ?? id}”` : "something";
  switch (m.op) {
    case "delete_node":
      return `Removes ${name(m.node_id)} from the board.`;
    case "rename_node":
      return m.label
        ? `Renames ${name(m.node_id)} to “${m.label}”.`
        : `Renames ${name(m.node_id)}.`;
    case "demote_to_field":
      return `Removes ${name(m.node_id)} and adds “${m.field}” to ${name(m.parent_id)}'s values.`;
    case "merge_nodes":
      return `Folds ${name(m.drop)} into ${name(m.keep)}. One card, not two.`;
    case "add_edge":
      return m.edge.from && m.edge.to
        ? `Connects ${name(m.edge.from)} to ${name(m.edge.to)}.`
        : `Draws a connection into ${name(m.edge.to)}.`;
    case "add_node":
      return `Adds a new ${m.node.primitive} to the board.`;
    case "set_config_key":
      return `Saves your answer on ${name(m.node_id)}.`;
    case "set_edge_config": {
      const e = g.edges.find((x) => x.id === m.edge_id);
      return e
        ? `Saves your answer on ${name(e.from)} → ${name(e.to)}.`
        : `Saves your answer on that connection.`;
    }
    case "add_output_row":
      return `Adds a row to ${name(m.node_id)}.`;
    case "record_elicited":
      return `Records what you described. It still needs building before this can run.`;
    case "sequence": {
      // Read out in order, because the whole point of a sequence is that the
      // steps only make sense together.
      const parts = m.steps.map((s) => previewOf(s, g)).filter(Boolean);
      return parts.length ? parts.join(" ") : null;
    }
  }
}

/** Raised when a `control` question has nothing to offer. Never rendered. */
export class EmptyOptionSet extends Error {
  constructor(public readonly finding: Finding, public readonly askKey: string) {
    super(
      `${askKey} produced no options for ${JSON.stringify(finding.anchor)}. ` +
        `An empty dropdown is a precondition finding that elaborate() should ` +
        `have emitted first, not a question.`,
    );
  }
}

/**
 * Raised when a `derived` key would render with nothing resolved. Producing the
 * proposal is the policy resolution loop's job; until it has run there is
 * nothing to play back, and asking her to confirm a blank is worse than not
 * asking.
 */
export class NothingToConfirm extends Error {
  constructor(public readonly finding: Finding, public readonly askKey: string) {
    super(
      `${askKey} is a derived key with no resolution to show for ` +
        `${JSON.stringify(finding.anchor)}. A confirmation needs something to confirm.`,
    );
  }
}

/**
 * Raised when a status finding is handed to render().
 *
 * `askable: false` means the compiler knows something is wrong and does NOT
 * know what she should do about it — the mutation has an endpoint it cannot
 * choose, or removes work she may want to keep. Offering a multiple choice
 * there is the compiler guessing: "Nothing reaches this" with "Inbox" as an
 * option is an edge endpoint invented out of nothing.
 *
 * These belong on the card as a marker and in the freeze-blocking list, and
 * she fixes them by drawing the connection herself. render() refusing them is
 * what stops a future caller quietly turning status back into questions.
 */
export class NotAQuestion extends Error {
  constructor(public readonly finding: Finding) {
    super(
      `${finding.code} at ${JSON.stringify(finding.anchor)} is status, not a question — ` +
        `its mutation has no endpoint the compiler can justify choosing.`,
    );
  }
}

/** `answer_kind` is derived from `binding`, never chosen. */
const ANSWER_KIND: Record<Binding, "choice" | "text"> = {
  control: "choice",
  derived: "choice", // confirm or reject — she agrees with a resolution, never types it
  prompt: "text",
};

export function render(finding: Finding, board: Board): Rendered {
  if (!finding.askable) throw new NotAQuestion(finding);

  const g = new Graph(board);
  const subject = subjectOf(finding, g);
  const label = subject ? nameOf(subject, g) : undefined;
  const key = finding.evidence.key as string | undefined;
  const primitive = primitiveOf(finding, g);

  const askKey = key && primitive ? `${primitive}.${key}` : undefined;
  const ask: AskSpec | undefined = askKey ? registry.ask[askKey] : undefined;

  // A finding with its own wording wins over the ask entry for whatever key it
  // happens to name. `unresolved_policy` names `check` only because the
  // registry needed one key to hang the requirement on — but the question is
  // "tell me more about what this does", not "confirm the check we resolved",
  // and there is no resolution to confirm.
  if (!ask || hasOwnWording(finding.code)) {
    return withoutAsk(finding, label, g);
  }

  // A confirmation with nothing to confirm is not a question. This mirrors the
  // `derived_has_proposal` constraint, so it fails here with an explanation
  // rather than at the insert with a constraint name.
  if (ask.binding === "derived") {
    throw new NothingToConfirm(finding, askKey!);
  }

  const binding = ask.binding;
  let options: Option[] | null = null;

  if (binding === "control") {
    options = computeOptions(ask, subject, g, key!, primitive!)
      // An enum value is the type system's name for something. `pairs_with` is
      // not a phrase anyone says out loud — and on an edge, a label that names
      // neither end is ambiguous in both directions.
      .map((o) => ({
        ...o,
        label: endpointNames(
          ask.option_labels?.[String(o.value)] ?? o.label,
          subject,
          g,
        ),
      }));
    if (options.length === 0) throw new EmptyOptionSet(finding, askKey!);
    // No multiple choice may be a dead end. What "none of these" MEANS differs
    // by tier — an extensible enum captures a gap, a closed one redirects using
    // closed_because, and a graph-derived set means her board is missing
    // something — but she always has a next action.
    options = [...options, { value: "__escape__", label: "None of these — let me explain", escape: true }];
  }
  // No `derived` branch: it throws above. Rendering a confirmation is the
  // policy resolution loop's job, and it hands over a proposal to play back —
  // there is nothing here that could produce one.

  return {
    code: finding.code,
    severity: finding.severity,
    rank: finding.rank,
    anchor: finding.anchor,
    binding,
    answer_kind: ANSWER_KIND[binding],
    body: bodyFor(finding, ask, label, key!, "edge_id" in finding.anchor),
    preview: previewOf(finding.mutation, g),
    options,
    mutation: finding.mutation,
    model_context: {
      code: finding.code,
      condition: finding.evidence.condition as string | undefined,
      intent: ask.intent,
      closed_because: ask.closed_because,
      label,
    },
  };
}

/** Codes whose wording is written here rather than taken from an ask entry. */
function hasOwnWording(code: Finding["code"]): boolean {
  return code === "unresolved_policy";
}

/**
 * Fill {from} and {to} with the labels she typed.
 *
 * Her labels go in verbatim — no attempt to pluralise or inflect them. Against
 * a plural label the sentence reads a little oddly, and every alternative reads
 * worse: guessing at grammar for a noun we have never seen produces confident
 * nonsense, and she recognises her own words either way.
 */
function endpointNames(template: string, subject: Node | Edge | undefined, g: Graph): string {
  if (!template.includes("{from}") && !template.includes("{to}")) return template;
  const e = subject as Edge | undefined;
  if (!e || !("from" in e)) return template;
  return template
    .replaceAll("{from}", g.node(e.from)?.label ?? e.from)
    .replaceAll("{to}", g.node(e.to)?.label ?? e.to);
}

function computeOptions(
  ask: AskSpec,
  subject: Node | Edge | undefined,
  g: Graph,
  key: string,
  primitive: string,
): Option[] {
  const source = ask.options_from ? optionSources[ask.options_from] : undefined;
  if (!source || !subject) return [];
  const enums = registry.kinds[primitive]?.enums as Record<string, unknown> | undefined;
  return source(subject, g, key, enums);
}

// ── wording ─────────────────────────────────────────────────────────────
// Her language, never the type system's. She never sees `exists_matching`,
// `required_if`, or a finding code.

function bodyFor(
  finding: Finding, ask: AskSpec, label: string | undefined, key: string, isEdge: boolean,
): string {
  // A node label is something she typed, so it takes quotes. An edge name is
  // one we made up out of its two endpoints, so it doesn't.
  const it = label ? (isEdge ? label : `“${label}”`) : "this";

  // Wording that explains WHY she is being asked beats wording that only says
  // what is wanted, so a fired condition wins over the key's generic intent.
  const condition = finding.evidence.condition as string | undefined;
  if (condition && CONDITION_WORDING[condition]) {
    return CONDITION_WORDING[condition](it);
  }

  // `intent` is a question template. {it} is the thing she named, so the
  // registry controls the whole sentence rather than contributing a fragment
  // that render() then has to staple a question mark onto.
  if (ask.intent) {
    const q = ask.intent.includes("{it}")
      ? ask.intent.replaceAll("{it}", it)
      : `${it} — ${ask.intent}`;
    return /[?.!]$/.test(q) ? q : `${q}?`;
  }

  // Unreachable: tests/wording.test.ts asserts every askable key has one of the
  // two above. Kept so a new key fails loudly in review rather than silently
  // shipping a key name to her.
  return `${it} — what should ${key.replace(/_/g, " ")} be?`;
}

/**
 * One line per condition. The condition NAME is what fired, so the wording that
 * explains *why she's being asked* keys off the same name — the question and
 * the reason can't drift apart.
 */
const CONDITION_WORDING: Record<string, (it: string) => string> = {
  multiple_sources: (it) =>
    `${it} can arrive from more than one place. Which value tells you two of them are the same one?`,
  multiple_inbound_artifacts: (it) =>
    `${it} is built from several things at once. Which value says which ones go together?`,
  sibling_artifacts_from_same_channel: (it) =>
    `More than one thing comes from the same place. How would you tell ${it} apart from the rest?`,
  multiple_read_artifacts: (it) =>
    `${it} looks at more than one thing. When it fails, which one is at fault?`,
  has_outputs: (it) => `How do you recognise what belongs to ${it}, and what to ignore?`,
  has_inputs: (it) => `What gets sent through ${it}, and what goes in it?`,
  endpoints_are_artifacts: () => `How do these two relate — does one sit inside the other, do they pair up, or is one built from several?`,
  rel_is_pairs_with: () => `These two pair up. Which value connects them?`,
  holds_no_child_records: (it) =>
    `What values do you pull out of ${it}?`,
};

/** Findings with no registry key: graph shape and structural correction. */
function withoutAsk(finding: Finding, label: string | undefined, g: Graph): Rendered {
  const it = label ? `“${label}”` : "this";
  const ev = finding.evidence;
  // Evidence carries node ids because the compiler works in ids. She never
  // does — every id that reaches her is resolved to the label she typed.
  const name = (id: unknown): string => {
    const n = typeof id === "string" ? g.node(id) : undefined;
    return `“${n?.label ?? String(id)}”`;
  };

  // Only questions live here. unreachable_node, unbound_policy,
  // no_terminal_path, data_cycle and open_comment used to, and each one
  // fabricated its options — the compiler does not know what should feed a
  // stranded card, so any list it offers is invented. They are status now, and
  // render() refuses them above.
  const spec: Record<string, { body: string; binding: Binding; options?: Option[] }> = {
    undeclared_join: {
      body: `${it} and ${name(ev.other)} are both identified by the same value. Do they pair up?`,
      binding: "control",
      options: [
        { value: "confirm", label: "Yes, match them on it" },
        { value: "reject", label: "No, they're unrelated", rejects: true },
      ],
    },
    demote_to_field: {
      body: `${it} looks like a value rather than a thing in its own right. Fold it into ${name(ev.parent)} as a field?`,
      binding: "control",
      options: [
        { value: "confirm", label: "Yes, fold it in" },
        { value: "reject", label: "No, keep it separate", rejects: true },
      ],
    },
    compression: {
      body: `${it} and ${name(ev.same_as)} hold the same values and get the same checks. Are they the same thing?`,
      binding: "control",
      options: [
        { value: "confirm", label: "Yes, merge them" },
        { value: "reject", label: "No, they're different", rejects: true },
      ],
    },
    output_row_unresolvable: {
      body: `The result “${ev.row}” can't be worked out — ${humanReason(String(ev.reason))}.`,
      binding: "control",
      options: [{ value: "remove", label: "Remove that result" }],
    },
    reads_unbound: {
      body: `${it} refers to ${name(ev.node)}, but nothing connects them yet. Should it?`,
      binding: "control",
      options: [
        { value: "confirm", label: "Yes, connect them" },
        { value: "reject", label: "No — I meant something else", rejects: true },
      ],
    },
    missing_field: {
      body: `${name(ev.wanted_by)} looks at “${ev.field}”, but ${it} doesn't have it. Add it?`,
      binding: "control",
      options: [
        { value: "confirm", label: "Yes, add it" },
        { value: "reject", label: "No — I meant a different value", rejects: true },
      ],
    },
    duplicate_label: {
      // Every question the agent asks names things by her labels. Two cards
      // called the same thing makes each of those questions ambiguous, and she
      // is the only one who knows which is which.
      body:
        `There are ${ev.count} cards called ${it}. Questions about them can't say which ` +
        `one they mean — what would you call this one to tell them apart?`,
      binding: "prompt",
    },
    unresolved_policy: {
      // She may already have described it — in which case the description
      // wasn't enough to pin down a check, and saying so is more honest than
      // asking the same question again.
      // The answer replaces `describes`, so the question has to ask for the
      // whole description rather than an addition to it — otherwise she writes
      // the missing half and the half that was already right disappears.
      body: ev.describes
        ? `${it} — you said “${ev.describes}”. I can't tell yet what to compare. ` +
          `Say the whole thing again, this time naming the values it looks at ` +
          `and what makes it fail.`
        : `${it} — what does this check? Describe it in your own words.`,
      binding: "prompt",
    },
  };

  const s = spec[finding.code] ?? {
    body: `${it} needs attention.`,
    binding: "control" as Binding,
    options: [{ value: "acknowledge", label: "OK" }],
  };

  return {
    code: finding.code,
    severity: finding.severity,
    rank: finding.rank,
    anchor: finding.anchor,
    binding: s.binding,
    answer_kind: ANSWER_KIND[s.binding],
    body: s.body,
    preview: previewOf(finding.mutation, g),
    options: s.binding === "prompt"
      ? null
      : [...(s.options ?? []), { value: "__escape__", label: "None of these — let me explain", escape: true }],
    mutation: finding.mutation,
    model_context: { code: finding.code, label },
  };
}

function humanReason(reason: string): string {
  if (reason === "copy across a many edge") return "there's more than one of them, so there's no single value to show";
  if (reason === "unknown node") return "it points at something that isn't on the board";
  if (reason === "unknown field") return "it points at a value that doesn't exist";
  return reason;
}

// ── anchor resolution ───────────────────────────────────────────────────

/**
 * What to call the thing a finding is about.
 *
 * A node has a label she typed. An edge has none — it is the line between two
 * cards — so it is named by its endpoints. Without this an edge question reads
 * "this — how do these two relate?", which names neither of them.
 */
function nameOf(subject: Node | Edge, g: Graph): string {
  if ("label" in subject) return (subject as Node).label;
  const e = subject as Edge;
  return `${g.node(e.from)?.label ?? e.from} → ${g.node(e.to)?.label ?? e.to}`;
}

function subjectOf(finding: Finding, g: Graph): Node | Edge | undefined {
  const a = finding.anchor;
  if ("node_id" in a) return g.node(a.node_id);
  return g.edges.find((e) => e.id === a.edge_id);
}

function primitiveOf(finding: Finding, g: Graph): Primitive | "edge" | undefined {
  if ("edge_id" in finding.anchor) return "edge";
  return g.primitiveOf(finding.anchor.node_id);
}
