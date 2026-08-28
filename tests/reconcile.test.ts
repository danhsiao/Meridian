// A comment is closed because it was settled, or because the board outgrew it
// — never because nobody was looking for it.
//
// Reconciliation closes any open comment whose finding no longer holds, which
// is right for Pass A and catastrophic for Pass B. A proposal exists precisely
// because the compiler CANNOT see what it proposes: "you wrote about emailing
// the forwarder and no card sends anything" is not a graph property, which is
// the whole reason Pass A didn't ask it. So no Pass B comment ever appears in
// the live set, and matching on it closed every one of them on the next answer
// she gave — unanswered, mutation never applied, marked `resolved_directly` as
// though she had fixed it herself.
//
// The confirmation that resolves a policy is a Pass B comment. Losing it meant
// the policy stayed unresolved while the worker's dedupe, which remembers the
// question was asked, refused to ask again: a blocking finding with no question
// attached and no way to reach one.

import { describe, expect, it } from "vitest";
import { askKey, elaborate, findingKey } from "@engine/compiler";
import type { Board, Mutation } from "@engine/compiler";
import { retired } from "../apps/web/src/store/postgres";

const N = (id: string, primitive: any, config: any = {}, label?: string) =>
  ({ id, primitive, label: label ?? id, config: { describes: "x", ...config } });

function board(): Board {
  return {
    nodes: [
      N("cha_1", "channel", { tool: "composio.gmail", match: { s: 1 } }),
      N("art_1", "artifact", { fields: ["ref"], identity_key: "ref" }, "Form"),
      N("pol_1", "policy", {}, "Check"),
      N("out_1", "output", {}),
    ],
    edges: [
      { id: "e1", from: "cha_1", to: "art_1", config: {} },
      { id: "e2", from: "art_1", to: "pol_1", config: {} },
      { id: "e3", from: "pol_1", to: "out_1", config: {} },
    ],
  } as any;
}

const live = (b: Board) =>
  new Set(elaborate(b).findings.filter((f) => f.askable).map(findingKey));

/** A comment row, shaped as reconcile reads it out of postgres. */
const row = (
  over: Partial<{ code: string; node_id: string | null; edge_id: string | null;
                  pass: string | null; mutation: Mutation | unknown; key: string | null }>,
) => ({
  code: "missing_required_key", node_id: null, edge_id: null, pass: "A",
  mutation: null, key: null, ...over,
});

describe("Pass B comments survive until she settles them", () => {
  it("the confirmation that resolves a policy is not closed behind her back", () => {
    const b = board();
    // Exactly what the worker writes: a code the compiler never emits, because
    // the compiler is not the thing that read her sentence.
    const c = row({
      code: "policy_resolution", node_id: "pol_1", pass: "B",
      mutation: { op: "record_elicited", node_id: "pol_1", proposal: { check: { relation: "present" } } },
    });
    expect(elaborate(b).findings.map((f) => f.code)).not.toContain("policy_resolution");
    expect(retired(c, live(b), b)).toBe(false);
  });

  it("nor is a proposal for structure the compiler cannot see", () => {
    const b = board();
    for (const mutation of [
      { op: "add_edge", edge: { id: "e_b1", from: "pol_1", to: "cha_1", config: {} } },
      { op: "set_config_key", node_id: "art_1", key: "fields", value: ["ref", "total"] },
    ] as Mutation[]) {
      expect(retired(row({ node_id: "art_1", pass: "B", mutation, key: null }), live(b), b)).toBe(false);
    }
  });

  it("but a proposal whose card she deleted is retired", () => {
    const b = board();
    b.nodes = b.nodes.filter((n) => n.id !== "art_1");
    const c = row({
      node_id: "art_1", pass: "B",
      mutation: { op: "set_config_key", node_id: "art_1", key: "fields", value: ["ref"] },
    });
    expect(retired(c, live(b), b)).toBe(true);
  });
});

describe("Pass A comments still close when their finding stops holding", () => {
  it("an open question the compiler is still asking stays open", () => {
    const b = board();
    const f = elaborate(b).findings.find(
      (x) => x.askable && "node_id" in x.anchor && x.anchor.node_id === "pol_1",
    )!;
    const c = row({
      code: f.code, node_id: "pol_1",
      mutation: f.mutation, key: (f.mutation as { key?: string }).key ?? null,
    });
    expect(retired(c, live(b), b)).toBe(false);
  });

  it("one it has stopped asking is closed", () => {
    const b = board();
    const c = row({ code: "no_terminal_path", node_id: "art_1", key: null });
    expect(retired(c, live(b), b)).toBe(true);
  });

  it("and the key is part of the match, so one key does not vouch for another", () => {
    const b = board();
    const onPol = elaborate(b).findings.filter(
      (x) => x.askable && "node_id" in x.anchor && x.anchor.node_id === "pol_1"
        && x.code === "missing_required_key",
    );
    const keys = onPol.map((f) => (f.mutation as { key?: string }).key);
    expect(new Set(keys).size).toBeGreaterThan(1);

    // A question about a key the compiler is NOT asking about, under a code it
    // is. The three-part key would have kept this alive.
    const c = row({ code: "missing_required_key", node_id: "pol_1", key: "not_a_real_key" });
    expect(retired(c, live(b), b)).toBe(true);
    expect(live(b)).toContain(askKey("missing_required_key", "pol_1", null, keys[0]));
  });
});
