// Two cards with the same name.
//
// The graph is fine — ids are distinct — but every question the agent asks
// names things by her labels, so two cards sharing one makes each of those
// questions ambiguous. She is the only one who can say which is which.

import { describe, expect, it } from "vitest";
import { apply, elaborate, fill, render } from "@engine/compiler";

const N = (id: string, primitive: any, config: any, label: string) =>
  ({ id, primitive, label, config: { describes: "x", ...config } });

function board() {
  return {
    nodes: [
      N("cha_1", "channel", { tool: "composio.gmail", match: { s: 1 } }, "Inbox"),
      N("art_1", "artifact", { fields: ["a"] }, "Records"),
      N("art_2", "artifact", { fields: ["b"] }, "Records"),
      N("out_1", "output", { rows: [] }, "Result"),
    ],
    edges: [
      { id: "e1", from: "cha_1", to: "art_1", config: {} },
      { id: "e2", from: "cha_1", to: "art_2", config: {} },
      { id: "e3", from: "art_1", to: "out_1", config: {} },
      { id: "e4", from: "art_2", to: "out_1", config: {} },
    ],
  } as any;
}

describe("duplicate labels", () => {
  it("are found, once, on the later card", () => {
    const found = elaborate(board()).findings.filter((f) => f.code === "duplicate_label");
    expect(found).toHaveLength(1);
    expect(found[0].anchor).toEqual({ node_id: "art_2" });
  });

  it("do not block freeze — the spec is well formed either way", () => {
    const f = elaborate(board()).findings.find((x) => x.code === "duplicate_label")!;
    expect(f.severity).toBe("advisory");
    // But ranked structurally: left alone it produces rounds of questions she
    // cannot answer confidently.
    expect(f.rank).toBe("structural");
  });

  it("ask her for a name rather than inventing one", () => {
    const b = board();
    const f = elaborate(b).findings.find((x) => x.code === "duplicate_label")!;
    const r = render(f, b);
    expect(r.binding).toBe("prompt");
    expect(r.body).toContain("Records");
    expect(r.body.toLowerCase()).toContain("which one");
  });

  it("her answer renames it, and the finding goes", () => {
    const b = board();
    const f = elaborate(b).findings.find((x) => x.code === "duplicate_label")!;
    const after = apply(b, fill(f.mutation, "Attachments"));
    expect(after.nodes.find((n) => n.id === "art_2")!.label).toBe("Attachments");
    expect(elaborate(after).findings.map((x) => x.code)).not.toContain("duplicate_label");
  });

  it("case and spacing don't hide a collision", () => {
    const b = board();
    b.nodes[2].label = "  records  ";
    expect(elaborate(b).findings.map((f) => f.code)).toContain("duplicate_label");
  });
});
