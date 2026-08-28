// A failure notice must not be posted into the mailbox the work arrives from.
//
// Caught in the compiler rather than in a prompt: Pass B proposing this edge
// cannot survive validation whatever the prompt says, and that is the stronger
// of the two guarantees.

import { describe, expect, it } from "vitest";
import { elaborate } from "@engine/compiler";

const N = (id: string, primitive: any, config: any = {}) =>
  ({ id, primitive, label: id, config: { describes: "x", ...config } });

describe("a channel cannot both feed the process and receive its failures", () => {
  const board = {
    nodes: [
      N("cha_1", "channel", { tool: "composio.gmail", match: { s: 1 } }),
      N("art_1", "artifact", { fields: ["ref"] }),
      N("pol_1", "policy", {
        check: { relation: "present" }, reads: ["art_1.ref"],
        on_fail: "flag_and_continue", on_absent: "fail", confirmed_by: "c_1",
      }),
      N("out_1", "output", { rows: [{ label: "n", fn: "count", of: "art_1" }] }),
    ],
    edges: [
      { id: "e1", from: "cha_1", to: "art_1", config: {} },
      { id: "e2", from: "art_1", to: "pol_1", config: {} },
      { id: "e3", from: "pol_1", to: "out_1", config: {} },
      // the fail edge pointing back at the inbound channel
      { id: "e4", from: "pol_1", to: "cha_1", config: { on: "fail" } },
    ],
  } as any;

  it("is a blocking finding", () => {
    const f = elaborate(board).findings.find((x) => x.code === "channel_talks_to_itself");
    expect(f).toBeDefined();
    expect(f!.severity).toBe("blocking");
  });

  it("is status, not a question — the fix is to draw a different edge", () => {
    const f = elaborate(board).findings.find((x) => x.code === "channel_talks_to_itself")!;
    expect(f.askable).toBe(false);
  });

  it("anchors to the offending edge, not the channel", () => {
    const f = elaborate(board).findings.find((x) => x.code === "channel_talks_to_itself")!;
    expect(f.anchor).toEqual({ edge_id: "e4" });
  });

  it("a fail edge into a channel that only sends is fine", () => {
    const ok = {
      ...board,
      nodes: [...board.nodes, N("cha_2", "channel", { tool: "composio.gmail", request: { to: "x" } })],
      edges: [...board.edges.filter((e: any) => e.id !== "e4"),
              { id: "e5", from: "pol_1", to: "cha_2", config: { on: "fail" } }],
    };
    expect(elaborate(ok).findings.map((f) => f.code)).not.toContain("channel_talks_to_itself");
  });
});
