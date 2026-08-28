// Answering a comment IS the edit. These test that the fix each finding
// carries actually resolves the finding that produced it — the round trip
// that makes the loop structural rather than decorative.

import { describe, expect, it } from "vitest";
import { elaborate } from "../elaborate.js";
import { apply, fill, validate, MutationError } from "../mutations.js";
import type { Board, Edge, Node, Primitive } from "../types.js";

const node = (id: string, primitive: Primitive, config: Record<string, unknown> = {}): Node => ({
  id, primitive, label: id, config: { describes: `what ${id} is`, ...config },
});
const edge = (id: string, from: string, to: string, config: Record<string, unknown> = {}): Edge => ({
  id, from, to, config,
});

function cleanBoard(): Board {
  return {
    nodes: [
      node("c1", "channel", { tool: "composio.gmail", match: { subject: "x" } }),
      node("a1", "artifact", { fields: ["f1", "f2"] }),
      node("p1", "policy", {
        describes: "f1 has to be filled in",
        check: { relation: "present" },
        reads: ["a1.f1"],
        on_fail: "flag_and_continue",
        on_absent: "fail",
        confirmed_by: "c_01",
      }),
      node("o1", "output", { rows: [{ label: "n", fn: "count", of: "a1" }] }),
    ],
    edges: [edge("e1", "c1", "a1", { cardinality: "many" }), edge("e2", "a1", "p1"), edge("e3", "p1", "o1")],
  };
}

describe("validation gates what reaches the board", () => {
  it("rejects a mutation naming a node that doesn't exist", () => {
    const errs = validate({ op: "delete_node", node_id: "nope" }, cleanBoard());
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("unknown node");
  });

  it("rejects a self-loop", () => {
    const errs = validate(
      { op: "add_edge", edge: { id: "e9", from: "a1", to: "a1", config: {} } },
      cleanBoard(),
    );
    expect(errs[0]).toContain("self-loop");
  });

  it("allows a hole at insert time and refuses it at apply time", () => {
    const b = cleanBoard();
    const m = { op: "add_edge" as const, edge: { id: "e9", from: null, to: "p1", config: {} } };
    expect(validate(m, b, { allowHoles: true })).toHaveLength(0);
    expect(validate(m, b)).toHaveLength(1);
    expect(() => apply(b, m)).toThrow(MutationError);
  });

  it("her answer fills the hole, and only the hole", () => {
    // Filled with `o1`, not `a1`: a1 -> p1 already exists on cleanBoard, and
    // proposing an existing connection is now itself a validation error. The
    // subject here is `fill`, so the fixture uses a pair that is genuinely new.
    const m = { op: "add_edge" as const, edge: { id: "e9", from: null, to: "o1", config: {} } };
    const filled = fill(m, "a1");
    expect(filled).toMatchObject({ edge: { from: "a1", to: "o1" } });
    expect(validate(filled, cleanBoard())).toHaveLength(0);
  });

  it("refuses an edge between two cards that are already connected", () => {
    // The database carries `unique (map_id, from_node, to_node)`. Until this
    // existed, validate() only checked the edge ID, so a proposal to add a
    // connection that already exists passed and then died at the insert —
    // showing a constraint name to someone who had done nothing wrong.
    const errs = validate(
      { op: "add_edge", edge: { id: "e_new", from: "a1", to: "p1", config: {} } },
      cleanBoard(),
    );
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain("duplicates the existing connection");
  });

  it("still allows the reverse direction, which is a different edge", () => {
    // `unique (from, to)` is ordered. p1 -> a1 is not a1 -> p1, and the
    // compiler will judge it on its own merits.
    expect(
      validate(
        { op: "add_edge", edge: { id: "e_rev", from: "p1", to: "a1", config: {} } },
        cleanBoard(),
      ),
    ).toHaveLength(0);
  });
});

describe("each finding's own mutation resolves it", () => {
  it("missing_required_key — filling the key clears that finding", () => {
    const b = cleanBoard();
    // Only the values are missing; she has already said what the thing is.
    // (Wiping the whole config would leave `describes` missing too, and this
    // test is about one key at a time.)
    delete (b.nodes[1].config as Record<string, unknown>).fields;

    const f = elaborate(b).findings.find((x) => x.evidence.key === "fields")!;
    expect(f).toBeDefined();

    const after = apply(b, fill(f.mutation, ["f1", "f2"]));
    const left = elaborate(after).findings.filter((x) => x.evidence.key === "fields");
    expect(left).toEqual([]);
  });

  it("undeclared_join — the offered edge clears it", () => {
    const b = cleanBoard();
    b.nodes[1].config.identity_key = "f1";
    b.nodes.push(node("a2", "artifact", { fields: ["f1"], identity_key: "f1" }));
    b.edges.push(edge("e4", "c1", "a2"));
    b.edges.push(edge("e5", "a2", "p1"));
    const f = elaborate(b).findings.find((x) => x.code === "undeclared_join")!;
    const after = apply(b, f.mutation);
    expect(elaborate(after).findings.map((x) => x.code)).not.toContain("undeclared_join");
  });

  it("unreachable_node — connecting it clears it", () => {
    const b = cleanBoard();
    b.nodes.push(node("a9", "artifact", { fields: ["f1"] }));
    b.edges.push(edge("e9", "a9", "p1"));
    const f = elaborate(b).findings.find((x) => x.code === "unreachable_node")!;
    const after = apply(b, fill(f.mutation, "c1"));
    expect(elaborate(after).findings.map((x) => x.code)).not.toContain("unreachable_node");
  });
});

describe("demote_to_field — five boxes become five fields", () => {
  /** a2 is a value pretending to be a record: no fields, one parent, read by p1. */
  function boardWithDemotable(): Board {
    const b = cleanBoard();
    b.nodes.push({ ...node("a2", "artifact", {}), label: "F3" });
    b.edges.push(edge("e4", "a1", "a2", { rel: "contains" }));
    b.edges.push(edge("e5", "a2", "p1"));
    (b.nodes[2].config as Record<string, unknown>).reads = ["a1.f1", "a2.f3"];
    (b.nodes[2].config as Record<string, unknown>).verdict_on = "a2";
    return b;
  }

  it("collapses the node, adds the field, and rewires the check", () => {
    const b = boardWithDemotable();
    const f = elaborate(b).findings.find((x) => x.code === "demote_to_field")!;
    const after = apply(b, f.mutation);

    // the node is gone
    expect(after.nodes.map((n) => n.id)).not.toContain("a2");
    // the field arrived on the parent
    expect(after.nodes.find((n) => n.id === "a1")!.config.fields).toEqual(["f1", "f2", "f3"]);
    // the check now reads the parent's field, not the vanished record
    expect(after.nodes.find((n) => n.id === "p1")!.config.reads).toEqual(["a1.f1", "a1.f3"]);
    // and a verdict on a record that no longer exists moved to what contained it
    expect(after.nodes.find((n) => n.id === "p1")!.config.verdict_on).toBe("a1");
    // no dangling edges
    expect(after.edges.some((e) => e.from === "a2" || e.to === "a2")).toBe(false);
  });

  it("leaves the board clean — the collapse is a complete fix, not a partial one", () => {
    const b = boardWithDemotable();
    const f = elaborate(b).findings.find((x) => x.code === "demote_to_field")!;
    const after = apply(b, f.mutation);
    expect(elaborate(after).findings).toEqual([]);
  });

  it("does not duplicate an edge the parent already had", () => {
    const b = boardWithDemotable();
    const f = elaborate(b).findings.find((x) => x.code === "demote_to_field")!;
    const after = apply(b, f.mutation);
    const a1ToP1 = after.edges.filter((e) => e.from === "a1" && e.to === "p1");
    expect(a1ToP1).toHaveLength(1);
  });
});

describe("compression", () => {
  it("repoints everything at the survivor and drops duplicate edges", () => {
    const b = cleanBoard();
    b.nodes.push(node("a2", "artifact", { fields: ["f1", "f2"] }));
    b.edges.push(edge("e4", "c1", "a2"));
    b.edges.push(edge("e5", "a2", "p1"));
    const f = elaborate(b).findings.find((x) => x.code === "compression")!;
    const after = apply(b, f.mutation);

    expect(after.nodes.map((n) => n.id)).not.toContain("a2");
    // c1->a1 existed and c1->a2 became c1->a1: one edge, not two
    expect(after.edges.filter((e) => e.from === "c1" && e.to === "a1")).toHaveLength(1);
    expect(elaborate(after).findings.map((x) => x.code)).not.toContain("compression");
  });
});

describe("record_elicited is the one mutation that does not unblock", () => {
  it("writes the draft but leaves the policy unresolved", () => {
    const b = cleanBoard();
    delete (b.nodes[2].config as Record<string, unknown>).check;
    const before = elaborate(b).findings.find((x) => x.code === "unresolved_policy")!;
    expect(before).toBeDefined();

    const after = apply(b, {
      op: "record_elicited",
      node_id: "p1",
      proposal: { describes: "f1 has to be filled in, but as a range" },
    });
    // the draft landed
    expect(after.nodes.find((n) => n.id === "p1")!.config.describes).toContain("range");
    // and the build is still blocked, deliberately
    expect(elaborate(after).findings.map((x) => x.code)).toContain("unresolved_policy");
  });
});
