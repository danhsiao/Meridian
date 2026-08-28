// Folding is a VIEW concern. These tests exist to pin the one thing that must
// stay true about it: the canvas may fold as aggressively as it likes, and the
// spec never loses a node. `cardOf` is what makes that safe — every node maps
// to exactly one card, so a comment anchored to a folded node still has
// somewhere to pin.

import { describe, expect, it } from "vitest";
import type { Board, Edge, Node, Primitive } from "@engine/compiler/client";
import { fold } from "./fold";

const node = (id: string, primitive: Primitive, config: Record<string, unknown> = {}): Node =>
  ({ id, primitive, label: id, config: { describes: `what ${id} is`, ...config } });
const edge = (id: string, from: string, to: string, config: Record<string, unknown> = {}): Edge =>
  ({ id, from, to, config });

/** channel -> record (2 children, one nested) -> two checks -> output */
function board(): Board {
  return {
    nodes: [
      node("c1", "channel", { tool: "t", match: {} }),
      node("a1", "artifact", { fields: ["f1"] }),
      node("a2", "artifact", { fields: ["f2"] }),      // contained by a1
      node("a3", "artifact", { fields: ["f3"] }),      // contained by a2 — nested
      node("p_one", "policy", { describes: "d", check: { relation: "present" },
        reads: ["a1.f1"], on_fail: "halt", on_absent: "fail", confirmed_by: "c_1" }),
      node("o1", "output", { rows: [] }),
    ],
    edges: [
      edge("e1", "c1", "a1", { cardinality: "many" }),
      edge("e2", "a1", "a2", { rel: "contains" }),
      edge("e3", "a2", "a3", { rel: "contains" }),
      edge("e4", "a1", "p_one"),
      edge("e5", "p_one", "o1"),
    ],
  };
}

describe("folding", () => {
  it("draws six nodes as three cards", () => {
    const f = fold(board());
    expect(f.cards.map((c) => c.node.id).sort()).toEqual(["c1", "o1"].concat("a1").sort());
    expect(f.cards).toHaveLength(3);
  });

  it("every node lands on exactly one card, including the folded ones", () => {
    const b = board();
    const f = fold(b);
    for (const n of b.nodes) {
      expect(f.cardOf[n.id], `${n.id} has no card`).toBeTruthy();
    }
    // covers is the union of every card's claim, with no node claimed twice
    const claimed = f.cards.flatMap((c) => c.covers);
    expect(new Set(claimed).size).toBe(claimed.length);
    expect(new Set(claimed).size).toBe(b.nodes.length);
  });

  it("a contained record becomes an indented row, not a box", () => {
    const f = fold(board());
    const host = f.cards.find((c) => c.node.id === "a1")!;
    const children = host.rows.filter((r) => r.kind === "child");
    expect(children.map((r) => (r as { node: Node }).node.id)).toEqual(["a2", "a3"]);
    // nesting shows as depth, so a thing inside a thing reads as one
    expect(children.map((r) => (r as { depth: number }).depth)).toEqual([1, 2]);
  });

  it("a check reading exactly one record folds into that record's card", () => {
    const f = fold(board());
    const host = f.cards.find((c) => c.node.id === "a1")!;
    expect(host.rows.some((r) => r.kind === "check")).toBe(true);
    expect(host.checkCount).toBe(1);
    expect(f.cards.some((c) => c.node.id === "p_one")).toBe(false);
  });

  it("a check reading two records keeps its own box — it belongs to neither", () => {
    const b = board();
    b.nodes.push(node("a9", "artifact", { fields: ["f9"] }));
    b.edges.push(edge("e6", "c1", "a9"));
    b.edges.push(edge("e7", "a9", "p_one"));
    const f = fold(b);
    expect(f.cards.some((c) => c.node.id === "p_one")).toBe(true);
  });

  it("folded edges are not drawn twice — the indentation IS the containment", () => {
    const f = fold(board());
    const drawn = f.edges.map((e) => e.edge.id);
    expect(drawn).not.toContain("e2"); // containment
    expect(drawn).not.toContain("e3"); // nested containment
    expect(drawn).not.toContain("e4"); // the single read, folded as a row
    expect(drawn).toContain("e1");
    expect(drawn).toContain("e5");
  });

  it("a join carries its key on the line", () => {
    const b = board();
    b.nodes.push(node("a9", "artifact", { fields: ["f1"] }));
    b.edges.push(edge("e6", "c1", "a9"));
    b.edges.push(edge("e7", "a1", "a9", { rel: "pairs_with", on: "f1" }));
    const j = fold(b).edges.find((e) => e.kind === "join");
    expect(j?.label).toBe("f1");
  });

  it("a fail edge is its own kind, so it can be drawn differently", () => {
    const b = board();
    b.nodes.push(node("c_out", "channel", { tool: "t", request: {} }));
    b.edges.push(edge("e6", "p_one", "c_out", { on: "fail" }));
    const f = fold(b);
    expect(f.edges.find((e) => e.edge.id === "e6")?.kind).toBe("fail");
  });

  it("edges between two folded nodes resolve to their cards, not to nothing", () => {
    // a3 is folded into a1's card. An edge out of a3 must still be drawn, and
    // must start from a1 — otherwise it would silently disappear.
    const b = board();
    b.edges.push(edge("e6", "a3", "o1"));
    const f = fold(b);
    const drawn = f.edges.find((e) => e.edge.id === "e6");
    expect(drawn?.fromCard).toBe("a1");
    expect(drawn?.toCard).toBe("o1");
  });
});
