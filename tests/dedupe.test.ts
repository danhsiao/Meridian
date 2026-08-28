// A board that still has blocking findings must still have questions.
//
// The review loop dedupes against every prior round, and the tuple it dedupes
// on decides whether that holds. It used to be (code, anchor): one finding code
// fires on one node for several different config keys, so answering the first
// question on a card silenced every later one on that card, permanently. The
// board reached ten blocking findings and zero comments — which looks exactly
// like an agent with nothing left to say, and is the worst failure this system
// has, because there is no way forward and nothing on screen saying so.
//
// The invariant, stated as a test: dedupe suppresses a question only when the
// same question has been asked.

import { describe, expect, it } from "vitest";
import { askKey, askedAlready, elaborate, findingKey, mutationKey } from "@engine/compiler";
import type { Board } from "@engine/compiler";

const N = (id: string, primitive: any, config: any, label: string) =>
  ({ id, primitive, label, config });

/** A policy with nothing filled in: several required keys, one anchor. */
function board(): Board {
  return {
    nodes: [
      N("cha_1", "channel", { describes: "mail arrives" }, "Inbox"),
      N("art_1", "artifact", { describes: "the form", fields: ["ref"] }, "Form"),
      N("pol_1", "policy", { describes: "the reference has to be filled in" }, "Check"),
      N("out_1", "output", { describes: "the result" }, "Result"),
    ],
    edges: [
      { id: "e1", from: "cha_1", to: "art_1", config: {} },
      { id: "e2", from: "art_1", to: "pol_1", config: {} },
      { id: "e3", from: "pol_1", to: "out_1", config: {} },
    ],
  };
}

describe("dedupe suppresses only the question that was actually asked", () => {
  it("distinguishes two keys behind one code on one card", () => {
    const findings = elaborate(board()).findings.filter(
      (f) => f.code === "missing_required_key" && "node_id" in f.anchor && f.anchor.node_id === "pol_1",
    );
    // The premise: one code, one anchor, more than one key.
    expect(new Set(findings.map((f) => f.evidence.key)).size).toBeGreaterThan(1);
    // And therefore more than one dedupe key.
    expect(new Set(findings.map(findingKey)).size).toBe(findings.length);
  });

  it("answering one key leaves the others askable", () => {
    const findings = elaborate(board()).findings.filter((f) => f.askable);
    const first = findings.find(
      (f) => f.code === "missing_required_key" && "node_id" in f.anchor && f.anchor.node_id === "pol_1",
    )!;

    // Exactly the row the worker would read back for that comment.
    const already = askedAlready([
      { code: first.code, node_id: "pol_1", edge_id: null, key: mutationKey(first.mutation) },
    ]);

    const left = findings.filter((f) => !already.has(findingKey(f)));
    expect(left).not.toContain(first);
    expect(left.length).toBe(findings.length - 1);
  });

  it("the same question twice is still one question", () => {
    const f = elaborate(board()).findings.find((x) => x.askable)!;
    const already = askedAlready([
      {
        code: f.code,
        node_id: "node_id" in f.anchor ? f.anchor.node_id : null,
        edge_id: "edge_id" in f.anchor ? f.anchor.edge_id : null,
        key: mutationKey(f.mutation),
      },
    ]);
    expect(already.has(findingKey(f))).toBe(true);
  });

  it("a comment whose mutation writes no single key dedupes on the anchor alone", () => {
    // Pass B's structural proposals and `record_elicited` carry no `key`, so
    // null has to round-trip: postgres returns null for `mutation->>'key'` and
    // the worker passes null when it looks one up.
    expect(mutationKey({ op: "record_elicited", node_id: "pol_1", proposal: {} })).toBeNull();
    expect(mutationKey({ op: "add_edge", edge: {} })).toBeNull();
    expect(mutationKey(null)).toBeNull();
    expect(askedAlready([{ code: "missing_node", node_id: "out_1", edge_id: null, key: null }]))
      .toContain(askKey("missing_node", "out_1", null, null));
  });

  it("an edge-anchored finding never collides with a node-anchored one", () => {
    expect(askKey("c", "n1", null, "k")).not.toBe(askKey("c", null, "n1", "k"));
  });
});
