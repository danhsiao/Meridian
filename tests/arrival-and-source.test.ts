// Two questions the type checker could not ask, both found by an eval rather
// than by a board.
//
// The shape is the ordinary one: mail arrives, the message is drawn as a card,
// and two documents hang off it. Neither is exotic and neither is a mistake,
// and until these conditions changed a board like this froze clean while being
// incomplete in two ways at once.
//
//   1. `source_hint` was required only of artifacts sharing a CHANNEL. Draw the
//      message as its own card -- which is how people draw mail -- and the two
//      documents sit one hop further down, sharing an artifact instead. The
//      condition never fired. The run then extracted both documents from the
//      same payload with nothing distinguishing them, and they came back
//      holding identical values: a perfect 1:1 between two records that should
//      have differed, so the check comparing them could not fail.
//
//   2. `identity_key` was required only on in-degree above one -- a duplicate
//      VISIBLE in the drawing. Redelivery is not visible in the drawing: one
//      message forwarded twice draws as one arrow. Three cases in the eval
//      arrived as two messages each and every count downstream was exactly
//      double, with no question anywhere that would have caught it.
//
// Both are now asked, both are answerable, and both clear when answered -- a
// converged board still produces zero findings, which the example-board tests
// assert separately.

import { describe, expect, it } from "vitest";
import { elaborate, render } from "@engine/compiler";
import type { Board, Finding } from "@engine/compiler";

const N = (id: string, primitive: any, config: any, label: string) =>
  ({ id, primitive, label, config });

/** channel -> message -> two documents, one of which holds rows of its own. */
function board(extra: Record<string, Record<string, unknown>> = {}): Board {
  const cfg = (id: string, base: Record<string, unknown>) => ({ ...base, ...(extra[id] ?? {}) });
  return {
    nodes: [
      N("cha_1", "channel", { describes: "mail arrives", tool: "composio.gmail", match: { s: 1 } }, "Inbox"),
      N("art_1", "artifact", cfg("art_1", { describes: "the message" }), "Message"),
      N("art_2", "artifact", cfg("art_2", { describes: "one document", fields: ["ref"] }), "Document A"),
      N("art_3", "artifact", cfg("art_3", { describes: "the other document", fields: ["ref"] }), "Document B"),
      N("art_4", "artifact", cfg("art_4", { describes: "rows inside A", fields: ["code"] }), "Row"),
      N("out_1", "output", { describes: "result", rows: [{ label: "n", fn: "count", of: "art_2" }] }, "Result"),
    ],
    edges: [
      { id: "e1", from: "cha_1", to: "art_1", config: {} },
      { id: "e2", from: "art_1", to: "art_2", config: { rel: "contains", cardinality: "many", on_child_fail: "ignore" } },
      { id: "e3", from: "art_1", to: "art_3", config: { rel: "contains", cardinality: "many", on_child_fail: "ignore" } },
      { id: "e4", from: "art_2", to: "art_4", config: { rel: "contains", cardinality: "many", on_child_fail: "ignore" } },
      { id: "e5", from: "art_2", to: "out_1", config: {} },
    ],
  };
}

const asked = (b: Board, key: string): string[] =>
  elaborate(b)
    .findings.filter((f) => f.evidence.key === key && "node_id" in f.anchor)
    .map((f) => (f.anchor as { node_id: string }).node_id)
    .sort();

describe("two documents out of one message", () => {
  it("asks which is which, even though the shared source is an artifact", () => {
    expect(asked(board(), "source_hint")).toEqual(["art_2", "art_3"]);
  });

  it("stops asking once she has said", () => {
    const answered = board({
      art_2: { source_hint: "the first attachment" },
      art_3: { source_hint: "the second attachment" },
    });
    expect(asked(answered, "source_hint")).toEqual([]);
  });

  it("does not ask an only child, which nothing can be confused with", () => {
    expect(asked(board(), "source_hint")).not.toContain("art_4");
  });
});

describe("a message can be delivered twice", () => {
  it("asks for a merge rule on what comes out of it", () => {
    expect(asked(board(), "identity_key")).toEqual(["art_2", "art_3"]);
  });

  it("stops asking once she has named the value", () => {
    const answered = board({
      art_2: { identity_key: "ref" },
      art_3: { identity_key: "ref" },
    });
    expect(asked(answered, "identity_key")).toEqual([]);
  });

  it("does not ask deeper than one hop, where the parent already settles it", () => {
    // `art_4` is rows inside a document. Merge the two copies of the document
    // and its rows come with it, so a key here answers nothing.
    expect(asked(board(), "identity_key")).not.toContain("art_4");
  });

  it("does not ask the message itself, which carries no values to key on", () => {
    expect(asked(board(), "identity_key")).not.toContain("art_1");
  });
});

describe("both questions reach her as questions", () => {
  const find = (key: string, node: string): Finding => {
    const f = elaborate(board()).findings.find(
      (x) => x.evidence.key === key && "node_id" in x.anchor && x.anchor.node_id === node,
    );
    if (!f) throw new Error(`no ${key} finding on ${node}`);
    return f;
  };

  it("the merge question offers her own values to pick from", () => {
    const r = render(find("identity_key", "art_2"), board());
    expect(r.binding).toBe("control");
    expect(r.options?.map((o) => o.value)).toContain("ref");
    // Her words, never the condition name.
    expect(r.body).not.toMatch(/identity_key|extracted_from_a_message/);
    expect(r.body).toMatch(/twice/);
  });

  it("the source question asks in plain English", () => {
    const r = render(find("source_hint", "art_2"), board());
    expect(r.body).not.toMatch(/source_hint|sibling_artifacts/);
    expect(r.body).toMatch(/Document A/);
  });
});
