// One synthetic fixture per finding code. IDs are a1/p1/o1, never domain ones,
// so the tests cannot quietly encode an industry — the same reason the runtime
// is built against a domain-free spec before any real process exists.

import { describe, expect, it } from "vitest";
import { blockingFindings, elaborate } from "../elaborate.js";
import type { Board, Edge, FindingCode, Node, Primitive } from "../types.js";

// `describes` is required on every primitive, so the helper supplies one
// unless a test is specifically about its absence.
const node = (id: string, primitive: Primitive, config: Record<string, unknown> = {}): Node => ({
  id,
  primitive,
  label: id,
  config: { describes: `what ${id} is`, ...config },
});

const edge = (id: string, from: string, to: string, config: Record<string, unknown> = {}): Edge => ({
  id,
  from,
  to,
  config,
});

const codes = (board: Board): FindingCode[] => elaborate(board).findings.map((f) => f.code);

/** A minimal board that elaborates clean: channel -> artifact -> policy -> output. */
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
    edges: [
      edge("e1", "c1", "a1", { cardinality: "many" }),
      edge("e2", "a1", "p1"),
      edge("e3", "p1", "o1"),
    ],
  };
}

describe("a clean board", () => {
  it("produces no findings at all", () => {
    expect(codes(cleanBoard())).toEqual([]);
  });

  it("resolves an IR codegen can walk without re-deriving anything", () => {
    const { ir } = elaborate(cleanBoard());
    expect(ir.edge_roles).toEqual({ e1: "derive", e2: "read", e3: "outcome" });
    expect(ir.topo_order).toEqual(["c1", "a1", "p1", "o1"]);
    // Edge ids, not node ids: two `many` edges from one parent are only
    // distinguishable by edge, and each needs its own iterator.
    expect(ir.loop_scopes).toEqual({ a1: ["e1"], p1: ["e1"] });
    // Derivable for a single-read policy, so never asked.
    expect(ir.verdict_targets).toEqual({ p1: "a1" });
  });
});

describe("registry findings", () => {
  it("missing_required_key — a card with nothing said about it", () => {
    const b = cleanBoard();
    b.nodes[1].config = {};
    // `describes` is required on every primitive; `fields` is conditional on
    // the record having no children, so it arrives as a conditional key.
    const f = elaborate(b).findings.filter((x) => x.code === "missing_required_key");
    expect(f.map((x) => x.evidence.key)).toContain("describes");
  });

  it("missing_conditional_key — two sources, so it needs an identity_key", () => {
    const b = cleanBoard();
    b.nodes.push(node("c2", "channel", { tool: "composio.gmail", match: { subject: "y" } }));
    b.edges.push(edge("e4", "c2", "a1"));
    const f = elaborate(b).findings.find((x) => x.code === "missing_conditional_key");
    expect(f?.evidence).toMatchObject({ key: "identity_key", condition: "multiple_sources" });
  });

  it("invalid_enum_value — a relation outside the ten", () => {
    const b = cleanBoard();
    (b.nodes[2].config as Record<string, unknown>).check = { relation: "vibes" };
    expect(codes(b)).toContain("invalid_enum_value");
  });

  it("unresolved_policy — described but resolved to neither shape", () => {
    const b = cleanBoard();
    delete (b.nodes[2].config as Record<string, unknown>).check;
    const found = elaborate(b).findings.filter((f) => f.code === "unresolved_policy");
    expect(found).toHaveLength(1);
    // The freeze error must name the policy, not "missing key: check" — which
    // would imply a relation is mandatory, the opposite of the design.
    expect(found[0].anchor).toEqual({ node_id: "p1" });
  });

  it("an impl satisfies the same condition a relation does", () => {
    const b = cleanBoard();
    const cfg = b.nodes[2].config as Record<string, unknown>;
    delete cfg.check;
    cfg.impl = { signature: ["a1.f1"], reads_fields: ["a1.f1"], helpers: [], body: "def check(f1): return bool(f1)\n" };
    expect(codes(b)).not.toContain("unresolved_policy");
  });
});

describe("graph findings", () => {
  it("unreachable_node — nothing flows into it, and it is status not a question", () => {
    const b = cleanBoard();
    b.nodes.push(node("a9", "artifact", { fields: ["f1"] }));
    const f = elaborate(b).findings.find((x) => x.code === "unreachable_node")!;
    expect(f).toBeDefined();
    // The compiler knows it is stranded and cannot know what should feed it,
    // so any option set would be invented.
    expect(f.askable).toBe(false);
  });

  it("no_terminal_path — reaches no output and no outbound channel", () => {
    const b = cleanBoard();
    b.nodes.push(node("a9", "artifact", { fields: ["f1"] }));
    b.edges.push(edge("e9", "a1", "a9", { rel: "contains" }));
    expect(codes(b)).toContain("no_terminal_path");
  });

  it("data_cycle — a cycle that survives fail-edge stripping", () => {
    const b = cleanBoard();
    b.nodes.push(node("a2", "artifact", { fields: ["f1"] }));
    b.edges.push(edge("e4", "a1", "a2", { rel: "contains" }));
    b.edges.push(edge("e5", "a2", "a1", { rel: "contains" }));
    expect(codes(b)).toContain("data_cycle");
  });

  it("unbound_policy — a check reading nothing", () => {
    const b = cleanBoard();
    b.edges = b.edges.filter((e) => e.id !== "e2");
    expect(codes(b)).toContain("unbound_policy");
  });

  it("undeclared_join — same identity_key, no edge saying how they relate", () => {
    const b = cleanBoard();
    b.nodes[1].config.identity_key = "f1";
    b.nodes.push(node("a2", "artifact", { fields: ["f1"], identity_key: "f1" }));
    b.edges.push(edge("e4", "c1", "a2"));
    const f = elaborate(b).findings.find((x) => x.code === "undeclared_join");
    expect(f).toBeDefined();
    // The mutation is the fix, written at creation: answering IS the edit.
    expect(f!.mutation).toMatchObject({
      op: "add_edge",
      edge: { config: { rel: "pairs_with", on: "f1" } },
    });
  });

  it("reads_unbound — a read naming an artifact with no edge into the policy", () => {
    const b = cleanBoard();
    (b.nodes[2].config as Record<string, unknown>).reads = ["a7.f1"];
    expect(codes(b)).toContain("reads_unbound");
  });

  it("missing_field — a read naming a field the artifact does not declare", () => {
    const b = cleanBoard();
    (b.nodes[2].config as Record<string, unknown>).reads = ["a1.nope"];
    const f = elaborate(b).findings.find((x) => x.code === "missing_field");
    // A precondition: the field must exist before the read can resolve, so it
    // outranks the key it unblocks — and it still blocks freeze.
    expect(f?.rank).toBe("precondition");
    expect(f?.severity).toBe("blocking");
    expect(f?.anchor).toEqual({ node_id: "a1" });
  });
});

describe("output rows", () => {
  it("output_row_unresolvable — an unknown node", () => {
    const b = cleanBoard();
    b.nodes[3].config.rows = [{ label: "n", fn: "count", of: "nope" }];
    expect(codes(b)).toContain("output_row_unresolvable");
  });

  it("output_row_unresolvable — copy across a many edge", () => {
    const b = cleanBoard();
    b.nodes[3].config.rows = [{ label: "n", fn: "copy", of: "a1.f1" }];
    const f = elaborate(b).findings.find((x) => x.code === "output_row_unresolvable");
    expect(f?.evidence).toMatchObject({ reason: "copy across a many edge" });
  });

  it("allows copy when nothing loops", () => {
    const b = cleanBoard();
    b.edges[0].config = {}; // cardinality one
    b.nodes[3].config.rows = [{ label: "n", fn: "copy", of: "a1.f1" }];
    expect(codes(b)).not.toContain("output_row_unresolvable");
  });
});

describe("structural correction", () => {
  it("demote_to_field — a value pretending to be a record", () => {
    const b = cleanBoard();
    b.nodes.push(node("a2", "artifact", {}));
    b.nodes[b.nodes.length - 1].label = "F3";
    b.edges.push(edge("e4", "a1", "a2", { rel: "contains" }));
    b.edges.push(edge("e5", "a2", "p1"));
    const f = elaborate(b).findings.find((x) => x.code === "demote_to_field");
    expect(f?.severity).toBe("advisory");
    // Any check attached to a demoted node has to move to the parent.
    expect(f?.mutation).toMatchObject({
      op: "demote_to_field",
      parent_id: "a1",
      field: "f3",
      rewire_policies: ["p1"],
    });
  });

  it("compression — identical fields AND identical checks", () => {
    const b = cleanBoard();
    b.nodes.push(node("a2", "artifact", { fields: ["f1", "f2"] }));
    b.edges.push(edge("e4", "c1", "a2"));
    b.edges.push(edge("e5", "a2", "p1"));
    expect(codes(b)).toContain("compression");
  });

  it("does not compress artifacts whose checks differ — that split is deliberate", () => {
    // a2 gets its OWN policy rather than none. With no policy at all it would
    // also be a dead branch, so the board would be invalid for an unrelated
    // reason and the fixture wouldn't isolate what it claims to.
    const b = cleanBoard();
    b.nodes.push(node("a2", "artifact", { fields: ["f1", "f2"] }));
    b.nodes.push(
      node("p2", "policy", {
        describes: "f2 has to be filled in",
        check: { relation: "present" },
        reads: ["a2.f2"],
        on_fail: "flag_and_continue",
        on_absent: "fail",
        confirmed_by: "c_02",
      }),
    );
    b.edges.push(edge("e4", "c1", "a2"));
    b.edges.push(edge("e5", "a2", "p2"));
    b.edges.push(edge("e6", "p2", "o1"));
    const found = codes(b);
    expect(found).not.toContain("compression");
    // and the board is otherwise clean, so nothing else explains the absence
    expect(found).not.toContain("no_terminal_path");
  });
});

describe("the fail edge", () => {
  function boardWithFailEdge(): Board {
    const b = cleanBoard();
    b.nodes.push(
      node("c2", "channel", { tool: "composio.gmail", request: { to: "x@y.z", subject: "s", body: "b" } }),
    );
    b.edges.push(
      edge("e4", "p1", "c2", {
        on: "fail",
        await: { channel: "c1", correlate_on: "f1" },
        rescope: ["a1"],
        max_attempts: 3,
        timeout: "PT30S",
        on_exhausted: "continue",
      }),
    );
    return b;
  }

  it("elaborates clean and resolves a signal handler", () => {
    const { ir, findings } = elaborate(boardWithFailEdge());
    expect(findings).toEqual([]);
    expect(ir.fail_handlers).toHaveLength(1);
    expect(ir.fail_handlers![0]).toMatchObject({
      edge: "e4",
      signal: "reply_received",
      await: { channel: "c1", correlate_on: "f1" },
      // The rescoped artifact plus the policy that failed — re-checking the
      // narrowed records is the point, so the policy runs again too.
      rescope_order: ["a1", "p1"],
      timeout: "PT30S",
      on_exhausted: "continue",
    });
  });

  it("keeps the outbound channel out of topo_order but still reachable", () => {
    const { ir, findings } = elaborate(boardWithFailEdge());
    // Reachability traverses fail edges; ordering does not. Two traversals.
    expect(findings.map((f) => f.code)).not.toContain("unreachable_node");
    expect(ir.topo_order).not.toContain("c2");
  });

  it("does not mistake the fail edge for a cycle", () => {
    expect(codes(boardWithFailEdge())).not.toContain("data_cycle");
  });
});

describe("edge relations are declared, not inferred", () => {
  it("requires rel on an artifact->artifact edge", () => {
    const b = cleanBoard();
    b.nodes.push(node("a2", "artifact", { fields: ["f1"] }));
    b.edges.push(edge("e4", "a1", "a2"));
    b.edges.push(edge("e5", "a2", "p1"));
    const f = elaborate(b).findings.find(
      (x) => x.code === "missing_conditional_key" && "edge_id" in x.anchor,
    );
    expect(f?.evidence).toMatchObject({ key: "rel", condition: "endpoints_are_artifacts" });
  });

  it("requires a join key once rel says the records pair up", () => {
    const b = cleanBoard();
    b.nodes.push(node("a2", "artifact", { fields: ["f1"] }));
    b.edges.push(edge("e4", "a1", "a2", { rel: "pairs_with" }));
    b.edges.push(edge("e5", "a2", "p1"));
    const f = elaborate(b).findings.find(
      (x) => x.code === "missing_conditional_key" && "edge_id" in x.anchor,
    );
    expect(f?.evidence).toMatchObject({ key: "on", condition: "rel_is_pairs_with" });
  });

  it("does not require rel on a channel->artifact edge", () => {
    const { findings } = elaborate(cleanBoard());
    expect(findings).toEqual([]);
  });
});

describe("severity and rank are different axes", () => {
  it("ranks structural correction above ordinary missing-key questions", () => {
    // The substantive claim, and the one worth a test: collapse the node that
    // shouldn't exist BEFORE asking about the node that has no fields, so
    // round two isn't asking questions about nodes round one removed.
    const b = cleanBoard();
    b.nodes.push(node("a2", "artifact", {}));           // demote candidate
    b.nodes[b.nodes.length - 1].label = "F3";
    b.edges.push(edge("e4", "a1", "a2", { rel: "contains" }));
    b.edges.push(edge("e5", "a2", "p1"));
    b.nodes.push(node("a3", "artifact", {}));           // missing_required_key
    b.edges.push(edge("e6", "c1", "a3"));
    b.edges.push(edge("e7", "a3", "p1"));

    const found = elaborate(b).findings;
    const structural = found.findIndex((f) => f.code === "demote_to_field");
    const missingKey = found.findIndex((f) => f.code === "missing_conditional_key");
    expect(structural).toBeGreaterThanOrEqual(0);
    expect(missingKey).toBeGreaterThanOrEqual(0);
    expect(structural).toBeLessThan(missingKey);
  });

  it("structural correction ranks high but does not block freeze", () => {
    const b = cleanBoard();
    b.nodes.push(node("a2", "artifact", {}));
    b.nodes[b.nodes.length - 1].label = "F3";
    b.edges.push(edge("e4", "a1", "a2", { rel: "contains" }));
    b.edges.push(edge("e5", "a2", "p1"));

    const found = elaborate(b).findings;
    const demote = found.find((f) => f.code === "demote_to_field")!;
    expect(demote.rank).toBe("structural");
    expect(demote.severity).toBe("advisory");
    expect(blockingFindings(found)).not.toContain(demote);

    // A demote candidate has no fields BY DEFINITION, so it always co-fires
    // with missing_required_key. Both are real, and the ranking is what
    // resolves the tension: she is shown "collapse this into its parent"
    // before "give this thing some fields", and taking the first answer makes
    // the second finding disappear. Two valid resolutions, one preferred.
    const alsoBlocking = blockingFindings(found).map((f) => f.code);
    expect(alsoBlocking).toContain("missing_conditional_key");
    expect(found.findIndex((f) => f.code === "demote_to_field")).toBeLessThan(
      found.findIndex((f) => f.code === "missing_conditional_key"),
    );
  });

  it("a precondition blocks freeze and sorts first", () => {
    const b = cleanBoard();
    (b.nodes[2].config as Record<string, unknown>).reads = ["a1.nope"];
    const found = elaborate(b).findings;
    const mf = found.find((f) => f.code === "missing_field")!;
    expect(mf.rank).toBe("precondition");
    expect(mf.severity).toBe("blocking");
    expect(found[0].code).toBe("missing_field");
  });
});
