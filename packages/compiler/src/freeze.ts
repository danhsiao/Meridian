// Freeze is a type check, not a save. Five predicates' worth of findings pass,
// or it fails naming the offending node ids.
//
// The only way to reach a hash is to leave the elaborator with nothing left to
// ask — which is what makes the frozen spec sufficient to hand to a coding
// agent without anyone having checked it by eye.

import { createHash } from "node:crypto";
import { blockingFindings, elaborate, registry } from "./elaborate.js";
import type { Board, Finding, IR } from "./types.js";

export interface FrozenSpec {
  spec_version: string;
  registry_version: string;
  process_id: string;
  spec_hash: string;
  nodes: unknown[];
  edges: unknown[];
  compiled: Partial<IR>;
  provenance: { comments: string[]; assumptions: unknown[] };
}

export type FreezeResult =
  | { ok: true; spec: FrozenSpec }
  | { ok: false; findings: Finding[]; node_ids: string[] };

export interface FreezeOptions {
  process_id: string;
  /** Comment ids that shaped this spec — provenance, queried later. */
  comments?: string[];
  /** Decisions the type system could not make, protected from the heal loop. */
  assumptions?: unknown[];
  /** Ids of comments still open. `open_comment` is a predicate too. */
  open_comments?: string[];
}

export function freeze(board: Board, opts: FreezeOptions): FreezeResult {
  const { ir, findings } = elaborate(board);

  const all = [...findings];
  for (const id of opts.open_comments ?? []) {
    all.push({
      code: "open_comment",
      severity: "blocking",
      rank: "blocking",
      // Circular as a comment: it would be a pin saying a pin is unanswered.
      askable: false,
      anchor: { node_id: id },
      evidence: { comment_id: id },
      mutation: { op: "set_config_key", node_id: id, key: "status", value: "resolved" },
    });
  }

  const blocking = blockingFindings(all);
  if (blocking.length > 0) {
    const node_ids = [
      ...new Set(blocking.map((f) => ("node_id" in f.anchor ? f.anchor.node_id : f.anchor.edge_id))),
    ];
    return { ok: false, findings: blocking, node_ids };
  }

  const spec: FrozenSpec = {
    spec_version: "1.0",
    registry_version: registry.registry_version,
    process_id: opts.process_id,
    spec_hash: "",
    nodes: board.nodes.map((n) => stripLayout(n as unknown as Record<string, unknown>)),
    edges: board.edges,
    compiled: ir,
    provenance: { comments: opts.comments ?? [], assumptions: opts.assumptions ?? [] },
  };

  spec.spec_hash = "sha256:" + createHash("sha256").update(canonical(spec)).digest("hex");
  return { ok: true, spec };
}

/**
 * x and y are stripped for the same reason a compiler ignores whitespace:
 * dragging a card is not a change to the process. `label` is NOT stripped — it
 * reaches the extraction prompt, so a label change changes behaviour and must
 * change the build id.
 */
function stripLayout(n: Record<string, unknown>): Record<string, unknown> {
  const { x, y, updated_at, ...rest } = n as Record<string, unknown>;
  return rest;
}

/** Deterministic serialisation: sorted keys, spec_hash excluded from its own input. */
export function canonical(spec: FrozenSpec): string {
  const { spec_hash, ...rest } = spec;
  return JSON.stringify(sortKeys(rest));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      out[k] = sortKeys((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}
