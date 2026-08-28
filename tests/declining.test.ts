// Declining must not do the thing.
//
// Answering a comment applies its mutation. A "no" option is therefore only a
// no if it carries `rejects: true` — the flag CommentCard keys off to route to
// reject instead of answer. Miss it on one option in one finding and the button
// labelled "No, they're different" runs the merge it was declining, and a card
// she just said to keep disappears off her board.
//
// That is not a wording bug, so a wording review will not find it: both options
// read correctly and only one of them behaves. It is also silent — the mutation
// applies cleanly, the comment resolves, and the only evidence is a node that
// is gone. Hence a test over every option set the renderer can produce, rather
// than over the one finding that got it wrong.

import { describe, expect, it } from "vitest";
import { elaborate, render } from "@engine/compiler";
import type { Board, Finding } from "@engine/compiler";

const N = (id: string, primitive: any, config: any = {}, label?: string) =>
  ({ id, primitive, label: label ?? id, config: { describes: "x", ...config } });

/**
 * Boards chosen to fire as many option-bearing findings as possible between
 * them. Each is deliberately mid-review — a finished board has nothing to ask.
 */
const boards: Record<string, Board> = {
  // Her board, in miniature: two records that carry the same one value, arrive
  // off the same channel, and feed the same cross-check. That fires
  // `compression`, whose mutation DROPS one of the two cards — which is what
  // made its "no" the expensive one to get wrong. No identity_key on either,
  // because compression stands down when there is one and lets
  // `undeclared_join` ask instead.
  twins: {
    nodes: [
      N("cha_1", "channel", { tool: "composio.gmail", match: { s: 1 } }),
      N("art_1", "artifact", { fields: ["ref"], source_hint: "one" }, "Left"),
      N("art_2", "artifact", { fields: ["ref"], source_hint: "two" }, "Right"),
      N("pol_1", "policy", {
        check: { relation: "exists_matching", params: { on: "ref" } },
        reads: ["art_1.ref", "art_2.ref"], verdict_on: "art_1",
        on_fail: "halt", on_absent: "fail", confirmed_by: "c_1",
      }),
      N("out_1", "output", { rows: [{ label: "n", fn: "count", of: "art_1" }] }),
    ],
    edges: [
      { id: "e1", from: "cha_1", to: "art_1", config: {} },
      { id: "e2", from: "cha_1", to: "art_2", config: {} },
      { id: "e3", from: "art_1", to: "pol_1", config: {} },
      { id: "e4", from: "art_2", to: "pol_1", config: {} },
      { id: "e5", from: "pol_1", to: "out_1", config: {} },
    ],
  } as any,

  // The same two records once they DO carry an identity key and no line joins
  // them: `undeclared_join` instead, which proposes an edge rather than a
  // deletion.
  paired: {
    nodes: [
      N("cha_1", "channel", { tool: "composio.gmail", match: { s: 1 } }),
      N("art_1", "artifact",
        { fields: ["ref", "total"], identity_key: "ref", source_hint: "one" }, "Left"),
      N("art_2", "artifact",
        { fields: ["ref"], identity_key: "ref", source_hint: "two" }, "Right"),
      N("pol_1", "policy", {
        check: { relation: "exists_matching", params: { on: "ref" } },
        reads: ["art_1.ref", "art_2.ref"], verdict_on: "art_1",
        on_fail: "halt", on_absent: "fail", confirmed_by: "c_1",
      }),
      N("out_1", "output", { rows: [{ label: "n", fn: "count", of: "art_1" }] }),
    ],
    edges: [
      { id: "e1", from: "cha_1", to: "art_1", config: {} },
      { id: "e2", from: "cha_1", to: "art_2", config: {} },
      { id: "e3", from: "art_1", to: "pol_1", config: {} },
      { id: "e4", from: "art_2", to: "pol_1", config: {} },
      { id: "e5", from: "pol_1", to: "out_1", config: {} },
    ],
  } as any,

  // A record with no values of its own hanging off a parent: demote_to_field,
  // whose mutation also removes a card. Plus an edge whose relationship has not
  // been declared.
  thin: {
    nodes: [
      N("cha_1", "channel", { tool: "composio.gmail", match: { s: 1 } }),
      N("art_1", "artifact", { fields: ["ref"] }, "Parent"),
      N("art_2", "artifact", {}, "Child"),
      N("pol_1", "policy", {
        check: { relation: "present" }, reads: ["art_1.ref"],
        on_fail: "halt", on_absent: "fail", confirmed_by: "c_1",
      }),
      N("out_1", "output", { rows: [{ label: "n", fn: "count", of: "art_1" }] }),
    ],
    edges: [
      { id: "e1", from: "cha_1", to: "art_1", config: {} },
      { id: "e2", from: "art_1", to: "art_2", config: {} },
      { id: "e3", from: "art_1", to: "pol_1", config: {} },
      { id: "e4", from: "pol_1", to: "out_1", config: {} },
    ],
  } as any,

  // A check reading a field on a record nothing connects: reads_unbound and
  // missing_field.
  unbound: {
    nodes: [
      N("cha_1", "channel", { tool: "composio.gmail", match: { s: 1 } }),
      N("art_1", "artifact", { fields: ["ref"] }, "Form"),
      N("art_2", "artifact", { fields: ["ref"] }, "Other"),
      N("pol_1", "policy", {
        check: { relation: "equals" }, reads: ["art_1.ref", "art_2.missing"],
        verdict_on: "art_1", on_fail: "halt", on_absent: "fail", confirmed_by: "c_1",
      }),
      N("out_1", "output", { rows: [{ label: "n", fn: "count", of: "art_1" }] }),
    ],
    edges: [
      { id: "e1", from: "cha_1", to: "art_1", config: {} },
      { id: "e2", from: "cha_1", to: "art_2", config: {} },
      { id: "e3", from: "art_1", to: "pol_1", config: {} },
      { id: "e4", from: "pol_1", to: "out_1", config: {} },
    ],
  } as any,

  // Nothing filled in at all: the missing-key questions and their pickers.
  bare: {
    nodes: [
      N("cha_1", "channel", {}),
      N("art_1", "artifact", { fields: ["ref"] }),
      N("pol_1", "policy", {}),
      N("out_1", "output", {}),
    ],
    edges: [
      { id: "e1", from: "cha_1", to: "art_1", config: {} },
      { id: "e2", from: "art_1", to: "pol_1", config: {} },
      { id: "e3", from: "pol_1", to: "out_1", config: {} },
    ],
  } as any,
};

/** Every option set the renderer produces across those boards. */
function rendered(): { board: string; finding: Finding; r: ReturnType<typeof render> }[] {
  const out = [];
  for (const [name, board] of Object.entries(boards)) {
    for (const f of elaborate(board).findings) {
      if (!f.askable) continue;
      try {
        out.push({ board: name, finding: f, r: render(f, board) });
      } catch {
        // EmptyOptionSet / NothingToConfirm / NotAQuestion — no options, so
        // nothing here to get wrong.
      }
    }
  }
  return out;
}

describe("a no is only a no if it is marked as one", () => {
  it("the boards fire the findings this is meant to cover", () => {
    const codes = new Set(rendered().map((x) => x.finding.code));
    for (const c of ["compression", "undeclared_join", "demote_to_field"]) {
      expect(codes).toContain(c);
    }
  });

  it("every declining option carries `rejects`", () => {
    const bad = rendered().flatMap(({ board, finding, r }) =>
      (r.options ?? [])
        .filter((o) => o.value === "reject" && !o.rejects)
        .map((o) => `${board}: ${finding.code} — “${o.label}” answers instead of declining`),
    );
    expect(bad).toEqual([]);
  });

  it("and every option that reads like a refusal is one of them", () => {
    // The flag is what the UI acts on, but the label is what she acts on. If
    // those two ever disagree, the label is the one telling the truth to her.
    const refusing = /^(no\b|none\b|neither\b|don't\b|do not\b|leave it\b|keep )/i;
    const bad = rendered().flatMap(({ board, finding, r }) =>
      (r.options ?? [])
        .filter((o) => refusing.test(o.label) && !o.rejects && !o.escape)
        .map((o) => `${board}: ${finding.code} — “${o.label}” reads as a no but applies the mutation`),
    );
    expect(bad).toEqual([]);
  });

  it("and no confirming option is marked as declining", () => {
    const bad = rendered().flatMap(({ board, finding, r }) =>
      (r.options ?? [])
        .filter((o) => o.value === "confirm" && o.rejects)
        .map(() => `${board}: ${finding.code} — confirming would decline`),
    );
    expect(bad).toEqual([]);
  });
});
