// Pass B — the only part that reads English.
//
// Pass A sees holes in the graph. It cannot read "we email the forwarder about
// anything missing" and notice there is no outbound channel, because that
// sentence is not a graph property. This reads what she wrote and proposes
// structure; everything it proposes is then re-elaborated, so any hole it opens
// becomes a Pass A question.
//
// Pass B feeds the type checker. It never bypasses it:
//
//   - It may only propose four things, each with a mutation the compiler's own
//     validator accepts. Anything that fails validation is dropped before
//     insert — a question the system can't apply is a question it can't ask.
//   - It never resolves a key. `prefills` answer a question Pass A already
//     decided to ask, turning a picker into a confirmation; the question, the
//     option set and the requirement all still come from the compiler.
//   - It sees the board and nothing else. No source documents, no fixtures, no
//     worked examples — the prompt is built from THIS board's labels and
//     THIS board's descriptions at call time.

import Anthropic from "@anthropic-ai/sdk";
import { validate } from "@engine/compiler";
import type { Board, Mutation, Node } from "@engine/compiler";

/** What Pass B may propose. Each maps to a mutation the validator accepts. */
export type ProposalCode = "missing_node" | "missing_edge" | "missing_field" | "cardinality";

export interface Proposal {
  code: ProposalCode;
  /** Why, in her words, quoting what she wrote. Becomes the comment body. */
  because: string;
  anchor: string;
  mutation: Mutation;
  preview: string;
}

/** A value inferred from her prose for a key Pass A is already asking about. */
export interface Prefill {
  node_id: string;
  key: string;
  value: unknown;
  /** What we read, in her words, so she can disagree with the reading. */
  because: string;
}

export interface PassB {
  proposals: Proposal[];
  prefills: Prefill[];
}

const TOOL: Anthropic.Tool = {
  name: "propose",
  description:
    "Read what the person who drew this board wrote on it, and propose structure they " +
    "described but did not draw, plus values their own words already answer. Propose " +
    "nothing you cannot ground in a specific sentence they wrote. Both lists may be " +
    "empty, and empty is the right answer when there is nothing to add.",
  input_schema: {
    type: "object",
    properties: {
      proposals: {
        type: "array",
        items: {
          type: "object",
          properties: {
            code: {
              type: "string",
              enum: ["missing_node", "missing_edge", "missing_field", "cardinality"],
            },
            because: {
              type: "string",
              description:
                "ONE short sentence, written TO the person who drew the board, in second " +
                "person: \"You wrote X, but there's no ...\". Never third person, never " +
                "\"she\". Quote the words that justify it. State what is MISSING, never " +
                "what already exists. Under 30 words. If you cannot say it that briefly " +
                "and that concretely, do not propose it.",
            },
            anchor_node: {
              type: "string",
              description: "The existing node id this concerns.",
            },
            new_primitive: {
              type: "string",
              enum: ["channel", "artifact", "policy", "output"],
              description: "missing_node only.",
            },
            new_label: { type: "string", description: "missing_node only: what she would call it." },
            new_describes: { type: "string", description: "missing_node only: what it is." },
            connect_from: { type: "string", description: "Node id the new edge starts at." },
            connect_to: { type: "string", description: "Node id the new edge ends at." },
            field: { type: "string", description: "missing_field only: the value to add." },
            edge_id: { type: "string", description: "cardinality only." },
            cardinality: { type: "string", enum: ["one", "many"], description: "cardinality only." },
          },
          required: ["code", "because"],
        },
      },
      prefills: {
        type: "array",
        items: {
          type: "object",
          properties: {
            node_id: { type: "string" },
            key: { type: "string", description: "Only a key listed as unanswered." },
            value: { description: "Only a value from the allowed list for that key." },
            because: {
              type: "string",
              description:
                "ONE short sentence, second person, quoting her words: \"You wrote X, " +
                "so this looks like Y\". Never third person, never \"she\". Under 25 words.",
            },
          },
          required: ["node_id", "key", "value", "because"],
        },
      },
    },
    required: ["proposals", "prefills"],
  },
};

export function proposalsAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * @param openKeys keys Pass A has decided to ask about, with the values it
 *   would accept. Pass B may fill one of these and nothing else — so it cannot
 *   invent a requirement, and cannot answer with a value the compiler would
 *   reject.
 */
export async function proposeFromText(
  board: Board,
  openKeys: { node_id: string; key: string; allowed: (string | number)[] | null }[],
): Promise<PassB> {
  const written = board.nodes.filter((n) => String(n.config?.describes ?? "").trim());
  if (written.length === 0) return { proposals: [], prefills: [] };

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

  const res = await client.messages.create({
    model,
    max_tokens: 2048,
    tools: [TOOL],
    tool_choice: { type: "tool", name: "propose" },
    messages: [{ role: "user", content: describeBoard(board, openKeys) }],
  });

  const call = res.content.find((c): c is Anthropic.ToolUseBlock => c.type === "tool_use");
  if (!call) return { proposals: [], prefills: [] };
  const out = call.input as { proposals?: unknown[]; prefills?: unknown[] };

  return {
    proposals: (out.proposals ?? [])
      .map((p) => toProposal(p as Record<string, unknown>, board))
      .filter((p): p is Proposal => p !== null),
    prefills: (out.prefills ?? [])
      .map((p) => toPrefill(p as Record<string, unknown>, openKeys))
      .filter((p): p is Prefill => p !== null),
  };
}

/**
 * The prompt is this board, at this moment. No worked examples: a few-shot case
 * about one industry would survive the noun lint if phrased carefully and still
 * teach the model to see that industry everywhere.
 */
function describeBoard(
  board: Board,
  openKeys: { node_id: string; key: string; allowed: (string | number)[] | null }[],
): string {
  const label = (id: string) => board.nodes.find((n) => n.id === id)?.label ?? id;
  const lines = [
    `A process owner drew this board and wrote descriptions on it. Everything below`,
    `is hers — the labels, the sentences, the shape.`,
    ``,
    `The four kinds of card, and what each one means:`,
    `  channel   — where things arrive from, or get sent to. The only card that`,
    `              touches the outside world.`,
    `  artifact  — a record pulled out of what arrived. Values live on these.`,
    `  policy    — a check over one or more records. Passes or fails them.`,
    `  output    — what the run reports at the end. An output is where a board is`,
    `              SUPPOSED to end: it has no outgoing edge and needs none. It is`,
    `              a summary that gets read, not a message that gets delivered.`,
    ``,
    `Cards:`,
    ...board.nodes.map(
      (n) =>
        `  ${n.id}  [${n.primitive}]  "${n.label}"` +
        (n.config?.describes ? `\n      she wrote: "${n.config.describes}"` : "") +
        (Array.isArray(n.config?.fields) && n.config.fields.length
          ? `\n      values: ${(n.config.fields as string[]).join(", ")}`
          : ""),
    ),
    ``,
    board.edges.length ? `Connections:` : `Connections: none yet`,
    ...board.edges.map((e) => `  ${e.id}  ${label(e.from)} -> ${label(e.to)}`),
    ``,
    `Two jobs.`,
    ``,
    `1. proposals — structure she DESCRIBED but did not DRAW.`,
    ``,
    `   Return an EMPTY list if everything she described is already on the board.`,
    `   That is the common case and the right answer. Never return an entry whose`,
    `   text says nothing was found — an entry IS a proposal to change something.`,
    ``,
    `   If she wrote about sending something and no card exists that SENDS, that`,
    `   is a missing_node. A channel things arrive from is not one that sends, and`,
    `   pointing a failure back at it would make the process talk to itself.`,
    `   If she described two things being related and no line joins them, that is`,
    `   a missing_edge — including a check she described as comparing two records`,
    `   that only has one record wired into it.`,
    ``,
    `   Reachability, terminality and dead cards have ALREADY been decided by the`,
    `   type checker, which sees the same board you do. Never propose anything on`,
    `   the grounds that a card has no outgoing edge, is unreached, or leads`,
    `   nowhere — if that were true it would already be a question, and if it is`,
    `   not a question then the checker has ruled it fine. In particular an output`,
    `   with no outgoing edge is a finished board, not a missing sender. Propose`,
    `   only what she SAID and did not DRAW.`,
    ``,
    `   Write each one TO her, in second person, saying what is MISSING.`,
    ``,
    `2. prefills — keys the board is already going to ask her about, where what`,
    `   she wrote already answers the question. Empty is fine. Use ONLY these,`,
    `   and only values from the allowed list:`,
    ...(openKeys.length
      ? openKeys.map(
          (k) =>
            `   ${k.node_id}.${k.key} on "${label(k.node_id)}"` +
            (k.allowed ? ` — allowed: ${k.allowed.join(", ")}` : ` — free text`),
        )
      : ["   (none)"]),
    ``,
    `Never invent an id. Never propose a key that is not listed above.`,
  ];
  return lines.join("\n");
}

// ── turning a proposal into a mutation the compiler will accept ──────────

function toProposal(p: Record<string, unknown>, board: Board): Proposal | null {
  const code = String(p.code ?? "") as ProposalCode;
  const because = String(p.because ?? "").trim();
  if (!because) return null;

  // A proposal is a proposal to CHANGE something. Text reporting that nothing
  // was found is the model filling in a schema for the sake of it, and it
  // reaches her as a comment that asks her to approve nothing.
  const narrating =
    /\b(no additional|nothing (?:further|else|more)|already (?:drawn|exists|fine)|this is fine|no changes?)\b/i
      .test(because);
  if (narrating) return null;
  // Wording ABOUT her rather than TO her reads like a canned template.
  if (/\bshe\b|\bher\b/i.test(because)) return null;
  if (because.split(/\s+/).length > 40) return null;

  const has = (id: unknown) => typeof id === "string" && board.nodes.some((n) => n.id === id);
  const label = (id: unknown) => board.nodes.find((n) => n.id === id)?.label ?? String(id);
  const anchor = String(p.anchor_node ?? p.connect_from ?? p.connect_to ?? "");
  if (!has(anchor)) return null;

  let mutation: Mutation | null = null;
  let preview = "";

  if (code === "missing_node") {
    const primitive = String(p.new_primitive ?? "");
    const newLabel = String(p.new_label ?? "").trim();
    if (!["channel", "artifact", "policy", "output"].includes(primitive) || !newLabel) return null;

    const id = `${primitive.slice(0, 3)}_b${Date.now().toString(36).slice(-4)}`;
    const node: Node = {
      id,
      primitive: primitive as Node["primitive"],
      label: newLabel,
      config: { describes: String(p.new_describes ?? because) },
      // Placed beside what it came from; she can move it.
      x: (board.nodes.find((n) => n.id === anchor)?.x ?? 0) + 300,
      y: board.nodes.find((n) => n.id === anchor)?.y ?? 0,
    };
    const from = has(p.connect_from) ? String(p.connect_from) : anchor;
    const to = has(p.connect_to) ? String(p.connect_to) : id;
    // A card and the line to it are one answer, not two.
    mutation = {
      op: "sequence",
      steps: [
        { op: "add_node", node },
        { op: "add_edge", edge: { id: `e_b${Date.now().toString(36).slice(-4)}`, from: from === id ? anchor : from, to: to === anchor ? id : to, config: {} } },
      ],
    };
    preview = `Adds a ${primitive} called “${newLabel}” and connects it.`;
  }

  if (code === "missing_edge") {
    if (!has(p.connect_from) || !has(p.connect_to)) return null;
    // A notice must not be sent back into the channel the work arrives from.
    // elaborate() also refuses this, so a proposal that slipped through would
    // be caught downstream — but there is no reason to show her a proposal we
    // already know the compiler rejects.
    const target = board.nodes.find((n) => n.id === String(p.connect_to));
    const source = board.nodes.find((n) => n.id === String(p.connect_from));
    if (
      source?.primitive === "policy" &&
      target?.primitive === "channel" &&
      board.edges.some((e) => e.from === target.id)
    ) {
      return null;
    }
    mutation = {
      op: "add_edge",
      edge: {
        id: `e_b${Date.now().toString(36).slice(-4)}`,
        from: String(p.connect_from),
        to: String(p.connect_to),
        config: {},
      },
    };
    preview = `Connects ${label(p.connect_from)} to ${label(p.connect_to)}.`;
  }

  if (code === "missing_field") {
    const field = String(p.field ?? "").trim();
    const node = board.nodes.find((n) => n.id === anchor);
    if (!field || !node || node.primitive !== "artifact") return null;
    const fields = Array.isArray(node.config?.fields) ? (node.config.fields as string[]) : [];
    if (fields.includes(field)) return null;
    mutation = { op: "set_config_key", node_id: anchor, key: "fields", value: [...fields, field] };
    preview = `Adds “${field}” to ${label(anchor)}.`;
  }

  if (code === "cardinality") {
    const edgeId = String(p.edge_id ?? "");
    const value = String(p.cardinality ?? "");
    if (!board.edges.some((e) => e.id === edgeId) || !["one", "many"].includes(value)) return null;
    mutation = { op: "set_edge_config", edge_id: edgeId, key: "cardinality", value };
    preview = value === "many" ? `Loops over them instead of taking one.` : `Takes one at a time.`;
  }

  if (!mutation) return null;

  // The compiler's own validator has the final say. A proposal it rejects never
  // becomes a comment.
  const errs = validate(mutation, board, { allowHoles: true });
  if (errs.length) return null;

  return { code, because, anchor, mutation, preview };
}

function toPrefill(
  p: Record<string, unknown>,
  openKeys: { node_id: string; key: string; allowed: (string | number)[] | null }[],
): Prefill | null {
  const node_id = String(p.node_id ?? "");
  const key = String(p.key ?? "");
  const because = String(p.because ?? "").trim();
  const slot = openKeys.find((k) => k.node_id === node_id && k.key === key);
  // Only a key Pass A already decided to ask about — Pass B cannot invent a
  // requirement, only answer one in advance.
  if (!slot || !because) return null;
  // And only a value the compiler would have offered.
  if (slot.allowed && !slot.allowed.map(String).includes(String(p.value))) return null;
  return { node_id, key, value: p.value, because };
}
