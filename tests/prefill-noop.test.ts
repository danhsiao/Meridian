// A confirmation that cannot change the board is not a question.
//
// Pass B may answer a question Pass A decided to ask, turning a picker into
// "here's what I read — is that right?". That is a good trade only when
// confirming WRITES something. It did not: the model was handed the card's own
// `describes` text as context, offered it back as the prefill for the
// `unresolved_policy` question, and confirming set the key to the value it
// already held. The finding survived untouched, and because a resolved comment
// deliberately does not gag a live finding, the identical question returned the
// next round, and the next — five rounds on one card, with only the model's
// playback sentence changing. "Yes, that's right" was the correct answer and it
// could never end the loop.
//
// Two rules keep it closed, one on each side of the prefill:
//
//   1. Only keys Pass A offers a CHOICE for are eligible. A `prompt` finding
//      exists because the board could not answer it; there is no allowed set,
//      and the model filling it is the model writing her words for her.
//   2. Never a value the key already holds, even when it is a legal choice.

import { describe, expect, it } from "vitest";
import { elaborate, render } from "@engine/compiler";
import type { Board } from "@engine/compiler";
import { toPrefill } from "../packages/review-worker/src/propose.js";

const N = (id: string, primitive: any, config: any, label: string) =>
  ({ id, primitive, label, config });

/** The shape that looped: a check she described, in words nothing could resolve. */
function board(): Board {
  return {
    nodes: [
      N("cha_1", "channel", { describes: "mail arrives", tool: "composio.gmail", match: { s: 1 } }, "Inbox"),
      N("art_1", "artifact", { describes: "the record", fields: ["ref", "code"] }, "Record"),
      N(
        "pol_1",
        "policy",
        { describes: "Fails a Record if the code is empty. All of them must be filled in." },
        "Code Check",
      ),
      N("out_1", "output", { describes: "the result", rows: [{ label: "n", fn: "count", of: "art_1" }] }, "Result"),
    ],
    edges: [
      { id: "e1", from: "cha_1", to: "art_1", config: {} },
      { id: "e2", from: "art_1", to: "pol_1", config: {} },
      { id: "e3", from: "pol_1", to: "out_1", config: {} },
    ],
  };
}

describe("a prefill cannot be a no-op", () => {
  it("drops a value the key already holds", () => {
    const b = board();
    const describes = b.nodes.find((n) => n.id === "pol_1")!.config!.describes;

    const pre = toPrefill(
      { node_id: "pol_1", key: "describes", value: describes, because: "You wrote this exact description." },
      [{ node_id: "pol_1", key: "describes", allowed: null }],
      b,
    );

    expect(pre).toBeNull();
  });

  it("keeps a value that actually changes the board", () => {
    const b = board();

    const pre = toPrefill(
      { node_id: "art_1", key: "identity_key", value: "ref", because: "You wrote that each record has one ref." },
      [{ node_id: "art_1", key: "identity_key", allowed: ["ref", "code"] }],
      b,
    );

    expect(pre).not.toBeNull();
    expect(pre!.value).toBe("ref");
  });
});

describe("a prompt question is never handed to Pass B", () => {
  it("unresolved_policy offers no option set, so it is not an eligible key", () => {
    const b = board();
    const finding = elaborate(b).findings.find((f) => f.code === "unresolved_policy");

    // The question exists — this is the one that looped.
    expect(finding).toBeDefined();
    expect(finding!.evidence.key).toBe("describes");

    // And the worker's eligibility filter is `allowed !== null && length > 0`.
    // A prompt binding renders no options, so the key never reaches the model.
    const r = render(finding!, b);
    expect(r.binding).toBe("prompt");
    expect(r.options).toBeNull();
  });
});
