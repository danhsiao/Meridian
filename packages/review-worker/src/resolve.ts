// The policy resolution loop — the half that listens.
//
// Pass A can only see holes in the graph. It cannot read "it's a cross
// reference between two nodes" and turn that into a check, which is why a
// board could sit at eleven blocking findings with no way forward: the keys
// that resolve a policy are `derived`, and nothing was deriving them.
//
// This reads what she wrote, resolves it against the fields actually on her
// board, and plays the result back IN HER FIELD NAMES for confirmation. The
// model never sees a node id and never picks a relation that isn't in the
// registry — it maps English onto a closed set, and the set is the same one
// codegen has templates for.
//
// No model runs at execution time. This runs once, at review time, and what it
// produces is confirmed by her before it can freeze.

import Anthropic from "@anthropic-ai/sdk";
import type { Board, Node } from "@engine/compiler";

/** The ten, with the one line each that lets a model map English onto them. */
const RELATIONS: Record<string, string> = {
  present: "a value has to be filled in",
  absent: "a value has to be empty",
  exists_matching: "a record must have a matching record somewhere else, joined on a shared value",
  equals: "two values have to be the same",
  in_set: "a value has to be one of a fixed list",
  greater_than: "a value has to be larger than another",
  less_than: "a value has to be smaller than another",
  within: "a value has to fall inside a range or a time window of another",
  older_than: "a date has to be earlier than a threshold",
  newer_than: "a date has to be later than a threshold",
};

export interface Resolution {
  kind: "relation" | "unclear";
  check?: { relation: string; params?: Record<string, unknown> };
  reads?: string[];
  verdict_on?: string;
  /** What we understood, in her words. Never a relation name. */
  playback: string;
  /** When we couldn't tell: the one thing that would settle it. */
  question?: string;
}

const TOOL: Anthropic.Tool = {
  name: "resolve_check",
  description:
    "Map a plain-English description of a check onto one of the available relations, " +
    "using only the field paths supplied. If the description does not determine a " +
    "relation, or the fields needed are not on the board, return unclear with the " +
    "single question that would settle it.",
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["relation", "unclear"] },
      relation: { type: "string", enum: Object.keys(RELATIONS) },
      params: {
        type: "object",
        description:
          "Extra the relation needs: `on` for exists_matching, `value`/`unit` for a window, `set` for in_set.",
      },
      reads: {
        type: "array",
        items: { type: "string" },
        description: "Field paths this check looks at, exactly as supplied. Operands in order.",
      },
      verdict_on: {
        type: "string",
        description: "Which record id takes the failure. Required when reads span two records.",
      },
      playback: {
        type: "string",
        description:
          "One sentence, in HER words, describing when this fails. Use the record and field " +
          "labels she typed, never ids and never the relation name. The shape to aim for is " +
          "\"Fails when a <record she named> has no <other record she named> with the same " +
          "<field she named>.\"",
      },
      question: {
        type: "string",
        description: "When unclear: the single question that would settle it, in plain English.",
      },
    },
    required: ["kind", "playback"],
  },
};

export function resolutionAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

/**
 * Resolve one policy. Returns null when there is nothing to work with — no
 * description, or no records feeding it — because those are Pass A's questions
 * and asking a model about them would be guessing at an empty board.
 */
export async function resolvePolicy(policy: Node, board: Board): Promise<Resolution | null> {
  const describes = String(policy.config?.describes ?? "").trim();
  if (!describes) return null;

  const reads = board.edges
    .filter((e) => e.to === policy.id)
    .map((e) => board.nodes.find((n) => n.id === e.from))
    .filter((n): n is Node => !!n && n.primitive === "artifact");
  if (reads.length === 0) return null;

  // Only what is actually on her board. The model cannot invent a field,
  // because every operand it may return is enumerated here.
  const available = reads.flatMap((r) =>
    (Array.isArray(r.config?.fields) ? (r.config.fields as string[]) : []).map((f) => ({
      path: `${r.id}.${f}`,
      reads_like: `${r.label} — ${f}`,
    })),
  );
  if (available.length === 0) return null;

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.ANTHROPIC_MODEL || "claude-sonnet-5";

  const res = await client.messages.create({
    model,
    max_tokens: 1024,
    tools: [TOOL],
    tool_choice: { type: "tool", name: "resolve_check" },
    messages: [
      {
        role: "user",
        content: [
          `A process owner described a check on her whiteboard. Map it onto one of the`,
          `available relations, using only the field paths listed.`,
          ``,
          `She called the check: "${policy.label}"`,
          `She described it as: "${describes}"`,
          ``,
          `Records it looks at:`,
          ...reads.map((r) => `  ${r.id} — she calls it "${r.label}"`),
          ``,
          `Field paths available (use these exactly):`,
          ...available.map((a) => `  ${a.path}   (she reads this as "${a.reads_like}")`),
          ``,
          `Relations available:`,
          ...Object.entries(RELATIONS).map(([k, v]) => `  ${k} — ${v}`),
          ``,
          `Rules:`,
          `- Use only the field paths above. If the check needs a value that isn't there,`,
          `  return kind "unclear" and ask for it.`,
          `- If reads span two records, set verdict_on to the record id that is at fault`,
          `  when it fails.`,
          `- playback must use her labels, never ids, never a relation name.`,
        ].join("\n"),
      },
    ],
  });

  const call = res.content.find((c): c is Anthropic.ToolUseBlock => c.type === "tool_use");
  if (!call) return null;
  const out = call.input as Record<string, unknown>;

  if (out.kind === "unclear") {
    return { kind: "unclear", playback: String(out.playback ?? ""), question: String(out.question ?? "") };
  }

  const relation = String(out.relation ?? "");
  if (!(relation in RELATIONS)) return null;

  // Defence in depth: the schema constrains the model, and this constrains the
  // result. A path it invented would name a field that does not exist, and the
  // compiler would reject it later — better to catch it here and ask instead.
  const allowed = new Set(available.map((a) => a.path));
  const chosen = (Array.isArray(out.reads) ? out.reads.map(String) : []).filter((p) => allowed.has(p));
  if (chosen.length === 0) {
    return {
      kind: "unclear",
      playback: String(out.playback ?? ""),
      question: "Which values on this board should it look at?",
    };
  }

  const spanned = new Set(chosen.map((p) => p.split(".")[0]));
  const verdict = String(out.verdict_on ?? "");

  return {
    kind: "relation",
    check: {
      relation,
      ...(out.params && Object.keys(out.params as object).length
        ? { params: out.params as Record<string, unknown> }
        : {}),
    },
    reads: chosen,
    // Only meaningful when it spans two, and only if the model named one we know.
    verdict_on: spanned.size > 1 && spanned.has(verdict) ? verdict : [...spanned][0],
    playback: String(out.playback ?? ""),
  };
}
