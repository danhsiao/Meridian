// The finished report goes somewhere.
//
// The only outbound paths used to be `policy -> channel`, which fires per
// failing record mid-run, and `artifact -> channel`. Neither expresses "email
// the finished checklist once, at the end" — so drawing that edge produced a
// blocking `edge_not_expressible`, and the canvas, which drew nothing for a
// role it did not recognise, swallowed the line entirely. The edge was in the
// store blocking freeze, invisible on the board, and redrawing it was refused
// as a duplicate.
//
// Two things under test: the role exists, and no edge she draws is ever
// invisible again.

import { describe, expect, it } from "vitest";
import { elaborate, validate } from "@engine/compiler";
import type { Board } from "@engine/compiler";
import { fold } from "../apps/web/src/fold";

const N = (id: string, primitive: any, config: any = {}, label?: string) =>
  ({ id, primitive, label: label ?? id, config: { describes: "x", ...config } });

/** Inbox -> record -> check -> report, and the report mailed out. */
function board(): Board {
  return {
    nodes: [
      N("cha_in", "channel", { tool: "composio.gmail", match: { s: 1 } }, "Inbox"),
      N("art_1", "artifact", { fields: ["ref"] }, "Form"),
      N("pol_1", "policy", {
        check: { relation: "present" }, reads: ["art_1.ref"],
        on_fail: "flag_and_continue", on_absent: "fail", confirmed_by: "c_1",
      }, "Check"),
      N("out_1", "output", { rows: [{ label: "n", fn: "count", of: "art_1" }] }, "Checklist"),
      N("cha_out", "channel",
        { tool: "composio.gmail", request: { to: "qa@example.com", subject: "Checklist" } },
        "Report out"),
    ],
    edges: [
      { id: "e1", from: "cha_in", to: "art_1", config: {} },
      { id: "e2", from: "art_1", to: "pol_1", config: {} },
      { id: "e3", from: "pol_1", to: "out_1", config: {} },
      { id: "e4", from: "out_1", to: "cha_out", config: {} },
    ],
  } as any;
}

describe("an output can be sent to a channel", () => {
  it("resolves to a `report` role rather than blocking", () => {
    const { ir, findings } = elaborate(board());
    expect(findings.map((f) => f.code)).not.toContain("edge_not_expressible");
    expect(ir.edge_roles!.e4).toBe("report");
  });

  it("is a data edge, so the send is the last step of the run", () => {
    // Unlike a fail edge, which is control flow and gets stripped: a report
    // fires once, after the output is computed, and has a place in the order.
    const { ir } = elaborate(board());
    const order = ir.topo_order!;
    expect(order).toContain("cha_out");
    expect(order.indexOf("cha_out")).toBeGreaterThan(order.indexOf("out_1"));
  });

  it("the board freezes with one on it", () => {
    expect(elaborate(board()).findings.filter((f) => f.severity === "blocking")).toEqual([]);
  });

  it("but not back into the channel the work arrives from", () => {
    // Same reasoning as a fail edge: the run would post its own report into the
    // mailbox it polls, and one channel would carry both `match` and `request`.
    const b = board();
    b.edges = [...b.edges.filter((e) => e.id !== "e4"),
               { id: "e5", from: "out_1", to: "cha_in", config: {} }];
    const f = elaborate(b).findings.find((x) => x.code === "channel_talks_to_itself");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("blocking");
    expect(f!.anchor).toEqual({ edge_id: "e5" });
  });
});

describe("no edge she draws is invisible", () => {
  it("a report edge is drawn", () => {
    const drawn = fold(board()).edges.find((d) => d.edge.id === "e4");
    expect(drawn?.kind).toBe("report");
  });

  it("and so is one the compiler cannot express", () => {
    // The canvas used to drop these, which is the worst outcome available: the
    // row exists and blocks freeze, nothing on screen shows it, and drawing it
    // again is refused as a duplicate. Better a line she can see and delete.
    const b = board();
    b.edges = [...b.edges, { id: "e9", from: "out_1", to: "art_1", config: {} }];

    expect(elaborate(b).findings.map((f) => f.code)).toContain("edge_not_expressible");
    const drawn = fold(b).edges.find((d) => d.edge.id === "e9");
    expect(drawn?.kind).toBe("invalid");
    expect(drawn?.label).toBeTruthy();
  });

  it("every edge in the store is drawn, or folded into a card on purpose", () => {
    const b = board();
    b.nodes.push(
      N("art_2", "artifact", { fields: ["code"] }, "Line"),
      N("pol_2", "policy", {}, "Other check"),
    );
    b.edges.push(
      // Folded: the indentation IS this edge.
      { id: "e6", from: "art_1", to: "art_2", config: { rel: "contains" } },
      // Drawn as invalid: two checks in a row is not something the compiler
      // can express, and she has to be able to see it to remove it.
      { id: "e7", from: "pol_1", to: "pol_2", config: {} },
      // Drawn as undecided: two records, relationship not declared yet.
      { id: "e8", from: "art_2", to: "art_1", config: {} },
    );

    const f = fold(b);
    const drawn = new Set(f.edges.map((d) => d.edge.id));

    // The invariant, rather than a hand-listed set of exceptions: an edge may
    // go undrawn ONLY when both its endpoints land on the same card, because
    // then the card structure itself is the edge — the indentation, or the row.
    // Anything else is an edge in the store with nothing on screen, which
    // blocks freeze, cannot be selected, and is refused as a duplicate on
    // redraw. Stated this way it also covers folds a future rule invents.
    for (const e of b.edges) {
      const representedByACard = f.cardOf[e.from] === f.cardOf[e.to];
      expect(
        drawn.has(e.id) || representedByACard,
        `${e.id} (${e.from} -> ${e.to}) is neither drawn nor folded into a card`,
      ).toBe(true);
    }
  });

  it("the one edge that is never drawn is one that cannot be created", () => {
    // `fold` skips an edge whose endpoints land on the same card, which is only
    // reachable via a self-loop — and `validate` refuses those at creation, so
    // the guard cannot hide an edge she actually drew.
    const b = board();
    const errs = validate(
      { op: "add_edge", edge: { id: "e_self", from: "pol_1", to: "pol_1", config: {} } },
      b,
    );
    expect(errs.join(" ")).toMatch(/self-loop/);
  });
});
