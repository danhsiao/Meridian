// What counts as "already asked".
//
// In the compiler because two processes need the same answer and must not
// drift: the review worker asks it to decide whether a question has been posed
// before, and the canvas asks it to decide whether an open comment still has a
// finding behind it. Two spellings of one key is how a board ends up both
// refusing to re-ask a question and closing the comment that asked it.
//
// The tuple is (code, anchor, subject). The subject is the part that was
// missing and the part that matters: one finding code fires on one node for
// several different things — `missing_required_key` on a policy is `describes`,
// then `on_fail`, then `on_absent` — so without it, answering the first
// question suppressed every later one on that node forever. The failure is
// silent and terminal: blocking findings remain, no comment is written, and the
// agent looks like it has nothing left to say.
//
// A config key is the usual subject, but not the only one. `output_row_unresolvable`
// fires once PER ROW on a single output node and names no key at all, so
// fourteen distinct findings collapsed onto one tuple, one question was asked,
// and answering it silenced the other thirteen permanently — the same failure
// in its second form. The row label is that finding's subject, so the key
// falls back to it.

import type { Finding } from "./types.js";

/** One comment already on the board, as far as deduplication cares. */
export interface AskedComment {
  code: string;
  node_id: string | null;
  edge_id: string | null;
  /** The config key its mutation writes, if it writes one. */
  key: string | null;
  /** Only `shouldAsk` reads it: declining settles a proposal, not a requirement. */
  status?: string;
}

export function askKey(
  code: string,
  node: string | null | undefined,
  edge: string | null | undefined,
  key: string | null | undefined,
): string {
  return `${code}|${node ?? ""}|${edge ?? ""}|${key ?? ""}`;
}

/**
 * What a mutation is ABOUT, within its anchor. Null when the anchor alone
 * identifies it.
 *
 * Usually the config key it writes. For a row mutation it is the row's label,
 * because a node can carry many rows and the anchor cannot tell them apart.
 * This has to agree with `findingKey` below, or a question is asked forever or
 * never asked again.
 */
export function mutationKey(m: unknown): string | null {
  const mut = m as { key?: unknown; row?: { label?: unknown } } | null | undefined;
  if (typeof mut?.key === "string") return mut.key;
  const rowLabel = mut?.row?.label;
  if (typeof rowLabel === "string") return rowLabel;
  return null;
}

export function askedAlready(rows: AskedComment[]): Set<string> {
  return new Set(rows.map((r) => askKey(r.code, r.node_id, r.edge_id, r.key)));
}

/**
 * Should this finding be put to her, given what is already on the board?
 *
 * `rows` are the comments that have not been resolved. Three cases, and the
 * third is the one that had no answer:
 *
 *   nothing asked          — ask.
 *   asked and still open   — don't. It is on screen; asking twice is the whole
 *                            thing dedupe exists to prevent.
 *   asked and DECLINED     — depends on severity.
 *
 * Declining is a real answer to a proposal: "no, those two aren't related" has
 * to stick, or the same suggestion returns every round. It is not an answer to
 * a requirement. A blocking finding is a key the board cannot freeze without,
 * so a declined blocking question leaves the canvas showing "1 to resolve" with
 * an empty queue and no way forward — the board has gone quiet while still
 * refusing to compile, and nothing in the UI can recover it.
 *
 * Same failure as dedupe-on-anchor, arriving by a different door, and the same
 * rule closes it: suppress a question only when the answer it already has can
 * settle it.
 */
export function shouldAsk(f: Finding, rows: AskedComment[]): boolean {
  const k = findingKey(f);
  const matching = rows.filter((r) => askKey(r.code, r.node_id, r.edge_id, r.key) === k);
  if (matching.length === 0) return true;
  // Waiting on her. Includes any row whose status this caller did not supply —
  // an unknown status is treated as live, never as declined.
  if (matching.some((r) => r.status !== "rejected")) return false;
  return f.severity === "blocking";
}

export function findingKey(f: Finding): string {
  const node = "node_id" in f.anchor ? f.anchor.node_id : null;
  const edge = "edge_id" in f.anchor ? f.anchor.edge_id : null;
  // `key` when the finding names one, the row label when it is about a row.
  // Mirrors mutationKey, which is what the stored side is read through.
  const subject =
    (f.evidence.key as string | undefined) ?? (f.evidence.row as string | undefined);
  return askKey(f.code, node, edge, subject);
}
