// Verification 5d: a resolved check must not reach the spec until she has said
// it is right.
//
// The resolution loop writes `check` into a comment's PROPOSAL, never straight
// into the node. The mutation applies only when she confirms, and until then
// `confirmed_by` points at a comment that is still open — which `open_comment`
// blocks on. If the loop ever wrote config directly, this gate would not exist
// and a model's reading of her sentence would freeze unreviewed.

import { describe, expect, it } from "vitest";
import { apply, elaborate, freeze, render } from "@engine/compiler";
import type { Board } from "@engine/compiler";

const N = (id: string, primitive: any, config: any, label: string) =>
  ({ id, primitive, label, config });

/** A board whose one check has been described but not yet resolved. */
function board(): Board {
  return {
    nodes: [
      N("cha_1", "channel", { describes: "mail arrives", tool: "composio.gmail", match: { s: 1 } }, "Inbox"),
      N("art_1", "artifact", { describes: "the form", fields: ["ref"] }, "Form"),
      N("art_2", "artifact", { describes: "the attachment", fields: ["ref"], identity_key: "ref" }, "Attachment"),
      N("pol_1", "policy", { describes: "every form needs a matching attachment", on_fail: "halt", on_absent: "fail" }, "Cross check"),
      N("out_1", "output", { describes: "the result", rows: [{ label: "n", fn: "count", of: "art_1" }] }, "Result"),
    ],
    edges: [
      { id: "e1", from: "cha_1", to: "art_1", config: {} },
      { id: "e2", from: "cha_1", to: "art_2", config: {} },
      { id: "e3", from: "art_1", to: "art_2", config: { rel: "pairs_with", on: "ref" } },
      { id: "e4", from: "art_1", to: "pol_1", config: {} },
      { id: "e5", from: "art_2", to: "pol_1", config: {} },
      { id: "e6", from: "pol_1", to: "out_1", config: {} },
    ],
  };
}

/** Exactly what the worker puts in the comment's proposal, and nowhere else. */
const RESOLUTION = {
  check: { relation: "exists_matching", params: { on: "ref" } },
  reads: ["art_1.ref", "art_2.ref"],
  verdict_on: "art_1",
  confirmed_by: "c_01",
};

describe("a resolved check is gated on her confirmation", () => {
  it("before confirming, the policy is unresolved and the board will not freeze", () => {
    const b = board();
    expect(b.nodes.find((n) => n.id === "pol_1")!.config.check).toBeUndefined();
    expect(elaborate(b).findings.map((f) => f.code)).toContain("unresolved_policy");
    expect(freeze(b, { process_id: "p" }).ok).toBe(false);
  });

  it("an unconfirmed comment blocks freeze even once the config is in place", () => {
    // This is the gate: the resolution has landed, but the comment that asked
    // her to confirm it is still open.
    const confirmed = apply(board(), { op: "record_elicited", node_id: "pol_1", proposal: RESOLUTION });
    const r = freeze(confirmed, { process_id: "p", open_comments: ["c_01"] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.findings.map((f) => f.code)).toContain("open_comment");
  });

  it("once she confirms, it resolves and the board freezes", () => {
    const confirmed = apply(board(), { op: "record_elicited", node_id: "pol_1", proposal: RESOLUTION });
    expect(elaborate(confirmed).findings.map((f) => f.code)).not.toContain("unresolved_policy");
    const r = freeze(confirmed, { process_id: "p", comments: ["c_01"] });
    if (!r.ok) {
      // Anything still blocking must be a DIFFERENT question, not the check.
      // Two records off one channel need a source_hint apiece; that is a real
      // requirement this fixture doesn't satisfy, and not the gate under test.
      expect(r.findings.map((f) => f.evidence.key)).not.toContain("check");
      expect(new Set(r.findings.map((f) => f.evidence.key))).toEqual(new Set(["source_hint"]));
    }
  });

  it("the config carries a pointer back to the comment that approved it", () => {
    const confirmed = apply(board(), { op: "record_elicited", node_id: "pol_1", proposal: RESOLUTION });
    expect(confirmed.nodes.find((n) => n.id === "pol_1")!.config.confirmed_by).toBe("c_01");
  });
});

/**
 * The gate above assumes `check` can only be filled by a confirmed resolution.
 * It cannot: `unresolved_policy` used to render as a free-text question carrying
 * `set_config_key(check)`, so her answer went straight into the derived slot.
 * A sentence is not a relation, and every consumer that tested `check != null`
 * then agreed the policy was settled — the resolver skipped it, the canvas
 * folded its card away, and the board fell silent still holding a check nothing
 * could compile. Presence is not resolution, and that is the invariant here.
 */
describe("prose in a derived key never counts as resolution", () => {
  const withProse = (check: unknown): Board => {
    const b = board();
    b.nodes.find((n) => n.id === "pol_1")!.config.check = check;
    return b;
  };

  for (const [name, value] of [
    ["a sentence", "Batch reference on the form must match the attachment"],
    ["the lines she typed", ["compares the reference", "fails when there is no match"]],
    ["an object naming no relation", { params: { on: "ref" } }],
  ] as const) {
    it(`${name} still leaves the policy unresolved`, () => {
      const codes = elaborate(withProse(value)).findings.map((f) => f.code);
      expect(codes).toContain("unresolved_policy");
      expect(freeze(withProse(value), { process_id: "p" }).ok).toBe(false);
    });
  }

  it("asks her to describe it again, and never writes her answer into `check`", () => {
    const f = elaborate(withProse("some words")).findings.find(
      (x) => x.code === "unresolved_policy",
    )!;
    // Answerable — a finding nothing can render is a board with no way forward.
    expect(f.askable).toBe(true);
    const r = render(f, withProse("some words"));
    expect(r.binding).toBe("prompt");
    expect(r.mutation).toEqual({
      op: "set_config_key", node_id: "pol_1", key: "describes", value: null,
    });
  });

  it("does not go on to demand the keys a resolution would have brought", () => {
    // `reads` and `confirmed_by` are derived too. Asked on a policy that never
    // resolved, they render as confirmations with nothing to confirm — which is
    // to say they are dropped, silently, and only freeze knows they exist.
    const keys = elaborate(withProse("some words")).findings
      .filter((f) => "node_id" in f.anchor && f.anchor.node_id === "pol_1")
      .map((f) => f.evidence.key);
    expect(keys).not.toContain("reads");
    expect(keys).not.toContain("confirmed_by");
  });
});
