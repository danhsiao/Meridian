// Declining settles a proposal. It never settles a requirement.
//
// Dedupe suppresses a question when the board already has an answer that can
// settle it. A rejected comment is an answer — "no, those two aren't related" —
// and for a proposal it has to stick, or the same suggestion returns every
// round. For a required key it settles nothing: the board still cannot freeze
// without the value, so the finding stays live and the question stays gagged.
//
// What that looks like on screen is the worst state this system has: the header
// reads "1 to resolve", the queue reads 0, and there is nothing to click. The
// worker logs "1 findings (1 askable), 0 new" round after round. It is the same
// terminal failure that dedupe-on-anchor produced, arriving by a different
// door, and it happened on a real board — a channel's `match` key was declined
// in round 2 and the board was unfreezable and silent from round 3 on.

import { describe, expect, it } from "vitest";
import { elaborate, shouldAsk } from "@engine/compiler";
import type { AskedComment, Board, Finding } from "@engine/compiler";

const N = (id: string, primitive: any, config: any, label: string) =>
  ({ id, primitive, label, config });

/** A channel that feeds something, so `match` is required and unanswered. */
function board(): Board {
  return {
    nodes: [
      N("cha_1", "channel", { describes: "mail arrives", tool: "composio.gmail" }, "Inbox"),
      N("art_1", "artifact", { describes: "a record", fields: ["ref"], source_hint: "the body" }, "Record"),
      N("pol_1", "policy", {
        describes: "ref must be filled in",
        check: { relation: "present" }, reads: ["art_1.ref"], confirmed_by: "c_01",
        on_fail: "halt", on_absent: "fail",
      }, "Check"),
      N("out_1", "output", { describes: "result", rows: [{ label: "n", fn: "count", of: "art_1" }] }, "Result"),
    ],
    edges: [
      { id: "e1", from: "cha_1", to: "art_1", config: {} },
      { id: "e2", from: "art_1", to: "pol_1", config: {} },
      { id: "e3", from: "pol_1", to: "out_1", config: {} },
    ],
  };
}

const blocking = (): Finding => {
  const f = elaborate(board()).findings.find(
    (x) => x.code === "missing_conditional_key" && x.evidence.key === "match",
  );
  if (!f) throw new Error("the board no longer produces the blocking finding this test is about");
  return f;
};

/** The comment row for a finding, as dedupe sees it. */
const rowFor = (f: Finding, status: string): AskedComment => ({
  code: f.code,
  node_id: "node_id" in f.anchor ? f.anchor.node_id : null,
  edge_id: null,
  key: String(f.evidence.key),
  status,
});

describe("a declined question", () => {
  it("comes back when the key it asked for still blocks freeze", () => {
    const f = blocking();
    expect(f.severity).toBe("blocking");
    expect(shouldAsk(f, [rowFor(f, "rejected")])).toBe(true);
  });

  it("stays declined when it was only a suggestion", () => {
    const f = { ...blocking(), severity: "advisory" as const };
    expect(shouldAsk(f, [rowFor(f, "rejected")])).toBe(false);
  });
});

describe("everything else dedupe already guaranteed", () => {
  it("asks a question nothing has asked", () => {
    expect(shouldAsk(blocking(), [])).toBe(true);
  });

  it("does not ask one that is on screen right now", () => {
    const f = blocking();
    expect(shouldAsk(f, [rowFor(f, "open")])).toBe(false);
  });

  it("does not ask one that is answered and waiting to apply", () => {
    const f = blocking();
    expect(shouldAsk(f, [rowFor(f, "answered")])).toBe(false);
  });

  it("treats an open comment as live even alongside a rejected one", () => {
    const f = blocking();
    expect(shouldAsk(f, [rowFor(f, "rejected"), rowFor(f, "open")])).toBe(false);
  });

  it("never confuses two questions on one card", () => {
    const f = blocking();
    const other = { ...rowFor(f, "rejected"), key: "request" };
    expect(shouldAsk(f, [other])).toBe(true);
  });
});
