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

/** `answer_kind` is derived from `binding`, never chosen. */
const ANSWER_KIND: Record<Binding, "choice" | "text"> = {
  control: "choice",
  derived: "choice", // confirm or reject — she agrees with a resolution, never types it
  prompt: "text",
};

export function render(finding: Finding, board: Board): Rendered {
  const g = new Graph(board);
  const subject = subjectOf(finding, g);
  const label = subject && "label" in subject ? (subject as Node).label : undefined;
  const key = finding.evidence.key as string | undefined;
  const primitive = primitiveOf(finding, g);

  const askKey = key && primitive ? `${primitive}.${key}` : undefined;
  const ask: AskSpec | undefined = askKey ? registry.ask[askKey] : undefined;

  // Findings with no registry key — graph shape, structural correction — have
  // no `ask` entry to consult, so they carry their own wording.
  if (!ask) {
    return withoutAsk(finding, label);
  }

  const binding = ask.binding;
  let options: Option[] | null = null;

  if (binding === "control") {
    options = computeOptions(ask, subject, g, key!, primitive!);
    if (ask.extensible) options = [...options, { value: "__other__", label: "Something else" }];
    if (options.length === 0) throw new EmptyOptionSet(finding, askKey!);
  } else if (binding === "derived") {
    // She is agreeing with a resolution, not choosing among candidates.
    options = [
      { value: "confirm", label: "Yes, that's right" },
      { value: "reject", label: "No — let me correct it" },
    ];
  }

  return {
    code: finding.code,
    severity: finding.severity,
    rank: finding.rank,
    anchor: finding.anchor,
    binding,
    answer_kind: ANSWER_KIND[binding],
    body: bodyFor(finding, ask, label, key!),
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

function bodyFor(finding: Finding, ask: AskSpec, label: string | undefined, key: string): string {
  const it = label ? `“${label}”` : "this";

  if (ask.binding === "derived") {
    return `${it} — here's what we understood. Does this look right?`;
  }

  // `intent` exists exactly for this: when the machine-derived wording would
  // read badly to a non-engineer, the registry overrides it in one line.
  if (ask.intent) {
    return `${it} — ${ask.intent}?`;
  }

  const condition = finding.evidence.condition as string | undefined;
  if (condition && CONDITION_WORDING[condition]) {
    return CONDITION_WORDING[condition](it);
  }

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
    `More than one thing arrives in the same message. How would you recognise ${it}?`,
  multiple_read_artifacts: (it) =>
    `${it} looks at more than one thing. When it fails, which one is at fault?`,
  has_outputs: (it) => `How do you recognise the messages that belong to ${it}?`,
  has_inputs: (it) => `What gets sent to ${it}, and what goes in it?`,
  endpoints_are_artifacts: () => `How do these two relate — does one sit inside the other, do they pair up, or is one built from several?`,
  rel_is_pairs_with: () => `These two pair up. Which value connects them?`,
};

/** Findings with no registry key: graph shape and structural correction. */
function withoutAsk(finding: Finding, label: string | undefined): Rendered {
  const it = label ? `“${label}”` : "this";
  const ev = finding.evidence;

  const spec: Record<string, { body: string; binding: Binding; options?: Option[] }> = {
    unreachable_node: {
      body: `Nothing reaches ${it}. Where does it come from?`,
      binding: "control",
      options: (ev.candidates as string[] | undefined)?.map((v) => ({ value: v, label: v })) ?? [],
    },
    unbound_policy: {
      body: `${it} doesn't look at anything yet. What should it check?`,
      binding: "control",
      options: (ev.candidates as string[] | undefined)?.map((v) => ({ value: v, label: v })) ?? [],
    },
    no_terminal_path: {
      body: `${it} doesn't feed into anything. Should it be removed?`,
      binding: "control",
      options: [
        { value: "remove", label: "Remove it" },
        { value: "keep", label: "No — it should connect to something" },
      ],
    },
    data_cycle: {
      body: `${it} ends up depending on itself, which can't run. Which link should go?`,
      binding: "control",
      options: [{ value: "remove", label: "Remove the loop" }],
    },
    undeclared_join: {
      body: `${it} and “${ev.other}” are both identified by the same value. Do they pair up?`,
      binding: "control",
      options: [
        { value: "confirm", label: "Yes, match them on it" },
        { value: "reject", label: "No, they're unrelated" },
      ],
    },
    demote_to_field: {
      body: `${it} looks like a value rather than a thing in its own right. Fold it into “${ev.parent}” as a field?`,
      binding: "control",
      options: [
        { value: "confirm", label: "Yes, fold it in" },
        { value: "reject", label: "No, keep it separate" },
      ],
    },
    compression: {
      body: `${it} and “${ev.same_as}” hold the same values and get the same checks. Are they the same thing?`,
      binding: "control",
      options: [
        { value: "confirm", label: "Yes, merge them" },
        { value: "reject", label: "No, they're different" },
      ],
    },
    output_row_unresolvable: {
      body: `The result “${ev.row}” can't be worked out — ${humanReason(String(ev.reason))}.`,
      binding: "control",
      options: [{ value: "remove", label: "Remove that result" }],
    },
    reads_unbound: {
      body: `${it} refers to “${ev.node}”, but nothing connects them yet. Should it?`,
      binding: "control",
      options: [
        { value: "confirm", label: "Yes, connect them" },
        { value: "reject", label: "No — I meant something else" },
      ],
    },
    missing_field: {
      body: `“${ev.wanted_by}” looks at “${ev.field}”, but ${it} doesn't have it. Add it?`,
      binding: "control",
      options: [
        { value: "confirm", label: "Yes, add it" },
        { value: "reject", label: "No — I meant a different value" },
      ],
    },
    unresolved_policy: {
      body: `${it} — what does this check?`,
      binding: "prompt",
    },
    open_comment: {
      body: `This is still waiting on an answer.`,
      binding: "control",
      options: [{ value: "acknowledge", label: "OK" }],
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
    options: s.binding === "prompt" ? null : (s.options ?? []),
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

function subjectOf(finding: Finding, g: Graph): Node | Edge | undefined {
  const a = finding.anchor;
  if ("node_id" in a) return g.node(a.node_id);
  return g.edges.find((e) => e.id === a.edge_id);
}

function primitiveOf(finding: Finding, g: Graph): Primitive | "edge" | undefined {
  if ("edge_id" in finding.anchor) return "edge";
  return g.primitiveOf(finding.anchor.node_id);
}
