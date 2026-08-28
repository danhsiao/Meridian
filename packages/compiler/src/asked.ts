// What counts as "already asked".
//
// In the compiler because two processes need the same answer and must not
// drift: the review worker asks it to decide whether a question has been posed
// before, and the canvas asks it to decide whether an open comment still has a
// finding behind it. Two spellings of one key is how a board ends up both
// refusing to re-ask a question and closing the comment that asked it.
//
// The tuple is (code, anchor, key). The key is the part that was missing and
// the part that matters: one finding code fires on one node for several
// different config keys — `missing_required_key` on a policy is `describes`,
// then `on_fail`, then `on_absent` — so without it, answering the first
// question suppressed every later one on that node forever. The failure is
// silent and terminal: blocking findings remain, no comment is written, and the
// agent looks like it has nothing left to say.

import type { Finding } from "./types.js";

/** One comment already on the board, as far as deduplication cares. */
export interface AskedComment {
  code: string;
  node_id: string | null;
  edge_id: string | null;
  /** The config key its mutation writes, if it writes one. */
  key: string | null;
}

export function askKey(
  code: string,
  node: string | null | undefined,
  edge: string | null | undefined,
  key: string | null | undefined,
): string {
  return `${code}|${node ?? ""}|${edge ?? ""}|${key ?? ""}`;
}

/** The config key a mutation writes. Null for ones that write no single key. */
export function mutationKey(m: unknown): string | null {
  const k = (m as { key?: unknown } | null | undefined)?.key;
  return typeof k === "string" ? k : null;
}

export function askedAlready(rows: AskedComment[]): Set<string> {
  return new Set(rows.map((r) => askKey(r.code, r.node_id, r.edge_id, r.key)));
}

export function findingKey(f: Finding): string {
  const node = "node_id" in f.anchor ? f.anchor.node_id : null;
  const edge = "edge_id" in f.anchor ? f.anchor.edge_id : null;
  return askKey(f.code, node, edge, f.evidence.key as string | undefined);
}
