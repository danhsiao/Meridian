// render() turns a Finding into a question a non-engineer can answer.
//
// The load-bearing assertions here are about what she is NOT shown: no finding
// codes, no relation names, no registry vocabulary. If any of those leak into
// `body`, the loop stops being usable by the person it exists for.

import { describe, expect, it } from "vitest";
import { elaborate } from "../elaborate.js";
import { render, EmptyOptionSet } from "../render.js";
import type { Board, Edge, Node, Primitive } from "../types.js";

const node = (id: string, primitive: Primitive, config: Record<string, unknown> = {}, label?: string): Node => ({
  id, primitive, label: label ?? id, config,
});
const edge = (id: string, from: string, to: string, config: Record<string, unknown> = {}): Edge => ({
  id, from, to, config,
});

function cleanBoard(): Board {
  return {
    nodes: [
      node("c1", "channel", { tool: "composio.gmail", match: { subject: "x" } }, "Inbox"),
      node("a1", "artifact", { fields: ["f1", "f2"] }, "Record"),
      node("p1", "policy", {
        describes: "f1 has to be filled in",
        check: { relation: "present" },
        reads: ["a1.f1"],
        on_fail: "flag_and_continue",
        on_absent: "fail",
        confirmed_by: "c_01",
      }, "The check"),
      node("o1", "output", { rows: [{ label: "n", fn: "count", of: "a1" }] }, "Result"),
    ],
    edges: [edge("e1", "c1", "a1", { cardinality: "many" }), edge("e2", "a1", "p1"), edge("e3", "p1", "o1")],
  };
}

/** Vocabulary she must never see. */
const JARGON = [
  "required_if", "missing_conditional_key", "missing_required_key", "elaborate",
  "exists_matching", "reference_exists", "field_presence", "verdict_on",
  "identity_key", "pair_on", "topo_order", "primitive", "binding",
];

function renderAll(b: Board) {
  return elaborate(b).findings.map((f) => render(f, b));
}

describe("no type-system vocabulary reaches her", () => {
  it("holds across every finding these boards produce", () => {
    const boards: Board[] = [];

    const missingKey = cleanBoard();
    missingKey.nodes[1].config = {};
    boards.push(missingKey);

    const twoSources = cleanBoard();
    twoSources.nodes.push(node("c2", "channel", { tool: "composio.gmail", match: { subject: "y" } }, "Other inbox"));
    twoSources.edges.push(edge("e4", "c2", "a1"));
    boards.push(twoSources);

    const demote = cleanBoard();
    demote.nodes.push(node("a2", "artifact", {}, "F3"));
    demote.edges.push(edge("e4", "a1", "a2", { rel: "contains" }));
    demote.edges.push(edge("e5", "a2", "p1"));
    boards.push(demote);

    const stranded = cleanBoard();
    stranded.nodes.push(node("a9", "artifact", { fields: ["f1"] }, "Orphan"));
    stranded.edges.push(edge("e9", "a9", "p1"));
    boards.push(stranded);

    const unresolved = cleanBoard();
    delete (unresolved.nodes[2].config as Record<string, unknown>).check;
    boards.push(unresolved);

    let rendered = 0;
    for (const b of boards) {
      for (const r of renderAll(b)) {
        rendered++;
        for (const word of JARGON) {
          expect(r.body.toLowerCase(), `"${r.body}" leaked "${word}"`).not.toContain(word);
        }
        expect(r.body.length, "an empty question is not a question").toBeGreaterThan(0);
      }
    }
    expect(rendered).toBeGreaterThan(5); // the sweep actually covered something
  });
});

describe("answer_kind is derived from binding, never chosen", () => {
  it("control renders a picker over computed options", () => {
    const b = cleanBoard();
    b.nodes.push(node("c2", "channel", { tool: "composio.gmail", match: { subject: "y" } }));
    b.edges.push(edge("e4", "c2", "a1"));
    const r = renderAll(b).find((x) => x.code === "missing_conditional_key")!;
    expect(r.binding).toBe("control");
    expect(r.answer_kind).toBe("choice");
    // options come from the board, not from a model
    expect(r.options!.map((o) => o.value)).toEqual(["f1", "f2"]);
  });

  it("prompt renders free text with no options", () => {
    const b = cleanBoard();
    b.nodes[1].config = {};
    const r = renderAll(b).find((x) => x.code === "missing_required_key")!;
    expect(r.binding).toBe("prompt"); // artifact.fields is prose bound for a prompt
    expect(r.answer_kind).toBe("text");
    expect(r.options).toBeNull();
  });
});

describe("the model is handed wording context, never the anchor", () => {
  it("model_context carries no node or edge id", () => {
    const b = cleanBoard();
    b.nodes[1].config = {};
    const r = renderAll(b)[0];
    expect(JSON.stringify(r.model_context)).not.toContain("a1");
    // it does get what it needs to write a good sentence
    expect(r.model_context.code).toBeTruthy();
  });
});

describe("an empty option set is a bug, not a dropdown", () => {
  it("throws rather than rendering a control question with nothing in it", () => {
    // Two parents sharing no field: a pairing rule cannot exist, so the
    // precondition should have fired first. If render is reached anyway it
    // must refuse loudly instead of showing her an empty list.
    const b = cleanBoard();
    b.nodes.push(node("a2", "artifact", { fields: ["z1"] }, "Left"));
    b.nodes.push(node("a3", "artifact", { fields: ["z2"] }, "Right"));
    b.nodes.push(node("a4", "artifact", { fields: ["out"] }, "Built from both"));
    b.edges.push(edge("e4", "c1", "a2"));
    b.edges.push(edge("e5", "c1", "a3"));
    b.edges.push(edge("e6", "a2", "a4", { rel: "builds_from" }));
    b.edges.push(edge("e7", "a3", "a4", { rel: "builds_from" }));
    b.edges.push(edge("e8", "a4", "p1"));

    const pairOn = elaborate(b).findings.find(
      (f) => f.evidence.key === "pair_on",
    );
    expect(pairOn, "expected a pair_on finding on the merge target").toBeDefined();
    expect(() => render(pairOn!, b)).toThrow(EmptyOptionSet);
  });
});

describe("wording explains why she is being asked", () => {
  it("keys the reason off the condition that fired", () => {
    const b = cleanBoard();
    b.nodes.push(node("c2", "channel", { tool: "composio.gmail", match: { subject: "y" } }));
    b.edges.push(edge("e4", "c2", "a1"));
    const r = renderAll(b).find((x) => x.code === "missing_conditional_key")!;
    expect(r.body).toContain("Record");
    expect(r.body.toLowerCase()).toContain("more than one place");
  });

  it("uses the node's label, so the question names what she drew", () => {
    const b = cleanBoard();
    b.nodes.push(node("a9", "artifact", { fields: ["f1"] }, "Orphan"));
    b.edges.push(edge("e9", "a9", "p1"));
    const r = renderAll(b).find((x) => x.code === "unreachable_node")!;
    expect(r.body).toContain("Orphan");
    expect(r.options!.map((o) => o.value)).toContain("c1");
  });
});

describe("every rendered comment carries its fix", () => {
  it("mutation is never dropped on the way through render", () => {
    const b = cleanBoard();
    b.nodes[1].config = {};
    b.nodes.push(node("a9", "artifact", { fields: ["f1"] }, "Orphan"));
    b.edges.push(edge("e9", "a9", "p1"));
    for (const r of renderAll(b)) {
      expect(r.mutation, `${r.code} rendered without a mutation`).toBeTruthy();
      expect(r.mutation.op).toBeTruthy();
    }
  });
});
