// A typed answer must arrive in the shape its key holds.
//
// The canvas parsed free text by looking for a comma: an answer containing one
// became a list, anything else stayed a string. That is correct for "what
// values do you pull out of this?" and destroys every answer that is a
// sentence, because English has commas.
//
// The damage was silent and terminal. A description of a check went in as prose
// and landed as five list items. Every emptiness check still said the key was
// filled — an array is present — so nothing on the board looked wrong. Only the
// resolver, the one consumer that has to READ the sentence, could tell, and its
// vocabulary for saying so is "I can't tell yet what to compare". So the board
// asked the same blocking question every round, and answering it correctly
// re-broke it every time.
//
// Two rules: the key decides the shape, and a list where one value belongs is a
// mutation the compiler refuses.

import { describe, expect, it } from "vitest";
import { isListValued, parseAnswer, validate } from "@engine/compiler";
import type { Board } from "@engine/compiler";

const board: Board = {
  nodes: [
    { id: "art_1", primitive: "artifact", label: "Record", config: { describes: "a record" } } as any,
    { id: "pol_1", primitive: "policy", label: "Check", config: { describes: "a check" } } as any,
  ],
  edges: [],
};

const PROSE =
  "The check fails if any of FDA No, HTS No, ANDA No, FEI Reg. No, or NDC No is empty. " +
  "All five must be filled in.";

describe("parseAnswer keys off the key, not the punctuation", () => {
  it("keeps a sentence whole", () => {
    expect(parseAnswer("describes", PROSE)).toBe(PROSE);
  });

  it("still splits a list-valued key", () => {
    expect(parseAnswer("fields", "Invoice No, Batch No")).toEqual(["Invoice No", "Batch No"]);
  });

  it("a single value on a list key stays a single value", () => {
    expect(parseAnswer("fields", "Invoice No")).toBe("Invoice No");
  });

  it("the registry is the only place that says which keys are lists", () => {
    expect(isListValued("fields")).toBe(true);
    expect(isListValued("describes")).toBe(false);
  });
});

describe("validate refuses a list where one value belongs", () => {
  it("rejects a description that arrived split", () => {
    const errs = validate(
      { op: "set_config_key", node_id: "pol_1", key: "describes", value: PROSE.split(",") } as any,
      board,
    );
    expect(errs.join(" ")).toMatch(/describes holds one value/);
  });

  it("accepts the same description as a sentence", () => {
    const errs = validate(
      { op: "set_config_key", node_id: "pol_1", key: "describes", value: PROSE } as any,
      board,
    );
    expect(errs).toEqual([]);
  });

  it("leaves a genuine list alone", () => {
    const errs = validate(
      { op: "set_config_key", node_id: "art_1", key: "fields", value: ["a", "b"] } as any,
      board,
    );
    expect(errs).toEqual([]);
  });
});
