// No question puts the type system's own vocabulary in front of her.
//
// The registry's key names, the relation names and the finding codes are the
// compiler's words. `on_child_fail` is a config key; `exists_matching` is a
// verb; `unmatched_reference` is a diagnostic. None of them is a phrase anyone
// says out loud, and a question containing one has stopped being a question and
// become a schema dump.
//
// This is the sweep that catches it. It runs over every rendered question the
// system can produce — machine-generated bodies, option labels, and registry
// intents — rather than over a list someone maintains by hand, so a new key
// added without wording fails here rather than in front of a customer.

import { describe, expect, it } from "vitest";
import { registry, elaborate, render } from "@engine/compiler";
import { EmptyOptionSet, NothingToConfirm } from "@engine/compiler";
import type { Board, Node, Edge, Primitive } from "@engine/compiler";

/** Every config key the registry names, across every kind. */
function everyRegistryKey(): string[] {
  const keys = new Set<string>();
  for (const spec of Object.values(registry.kinds)) {
    for (const k of spec.required) keys.add(k);
    for (const list of Object.values(spec.required_if ?? {})) for (const k of list) keys.add(k);
    for (const k of spec.optional ?? []) keys.add(k);
  }
  return [...keys];
}

function everyRelationName(): string[] {
  const rel = registry.kinds.policy?.enums?.relation;
  return Array.isArray(rel) ? (rel as string[]) : [];
}

/** Finding codes, harvested from the registry rather than retyped. */
function everyFindingCode(): string[] {
  return Object.values(registry.required_if_codes ?? {});
}

/**
 * Words that are jargon *as identifiers*. Matched with word boundaries and only
 * in their snake_case form, so ordinary English survives: the check is about
 * `on_child_fail` reaching her, not about the word "fail".
 */
function jargonTerms(): string[] {
  return [
    ...everyRegistryKey(),
    ...everyRelationName(),
    ...everyFindingCode(),
    // enum values are the type system's names for things too
    ...Object.values(registry.kinds).flatMap((k) =>
      Object.values(k.enums ?? {}).flatMap((v) => (Array.isArray(v) ? v.map(String) : [])),
    ),
  ].filter((t) => t.includes("_") || t.length > 3);
}

function offending(text: string): string[] {
  return jargonTerms().filter((term) => {
    // Only the identifier form. "pairs_with" is jargon; "pairs with" is English.
    if (!term.includes("_")) {
      // Single words: only flag the ones that are unambiguously type-system
      // vocabulary rather than ordinary usage.
      return false;
    }
    return new RegExp(`\\b${term}\\b`).test(text);
  });
}

/**
 * A board built to make as many findings fire at once as possible, so the sweep
 * covers real rendered output rather than a hand-listed subset.
 */
function messyBoard(): Board {
  const node = (id: string, primitive: Primitive, config: Record<string, unknown> = {}): Node => ({
    id, primitive, label: `card ${id}`, config,
  });
  const edge = (id: string, from: string, to: string, config: Record<string, unknown> = {}): Edge =>
    ({ id, from, to, config });

  return {
    nodes: [
      node("c1", "channel", { describes: "where things arrive", tool: "composio.gmail" }),
      node("a1", "artifact", { describes: "the first thing", fields: ["f1"] }),
      node("a2", "artifact", { describes: "the second thing", fields: ["f1"] }),
      node("a3", "artifact", { describes: "a nested thing", fields: ["f2"] }),
      node("p1", "policy", {
        describes: "every a1 has an a2 with the same f1",
        check: { relation: "exists_matching" },
        reads: ["a1.f1", "a2.f1"],
        verdict_on: "a1",
      }),
      node("o1", "output", {
        describes: "the tally",
        rows: [{ label: "how many we processed", fn: "count" }],
      }),
    ],
    edges: [
      edge("e1", "c1", "a1", { cardinality: "many" }),
      edge("e2", "c1", "a2", { cardinality: "many" }),
      edge("e3", "a1", "a3", { rel: "contains", cardinality: "many" }),
      edge("e4", "a1", "p1"),
      edge("e5", "a2", "p1"),
      edge("e6", "p1", "o1"),
    ],
  };
}

/** Every question the board can produce, rendered. */
function renderedQuestions(board: Board) {
  const out: { code: string; body: string; labels: string[] }[] = [];
  for (const f of elaborate(board).findings) {
    if (!f.askable) continue;
    try {
      const r = render(f, board);
      out.push({ code: r.code, body: r.body, labels: (r.options ?? []).map((o) => o.label) });
    } catch (e) {
      // A question with no options to offer is refused rather than shown blank.
      if (e instanceof EmptyOptionSet || e instanceof NothingToConfirm) continue;
      throw e;
    }
  }
  return out;
}

describe("no question speaks the type system's vocabulary", () => {
  const questions = renderedQuestions(messyBoard());

  it("produces questions to check", () => {
    expect(questions.length).toBeGreaterThan(0);
  });

  it("no rendered body contains a registry key, relation name or finding code", () => {
    for (const q of questions) {
      expect(offending(q.body), `${q.code}: "${q.body}"`).toEqual([]);
    }
  });

  it("no option label contains one either", () => {
    for (const q of questions) {
      for (const label of q.labels) {
        expect(offending(label), `${q.code}: option "${label}"`).toEqual([]);
      }
    }
  });

  it("no registry intent contains one", () => {
    for (const [key, ask] of Object.entries(registry.ask)) {
      if (!ask.intent) continue;
      expect(offending(ask.intent), `${key}: "${ask.intent}"`).toEqual([]);
    }
  });

  it("no option label the registry writes contains one", () => {
    for (const [key, ask] of Object.entries(registry.ask)) {
      for (const [value, label] of Object.entries(ask.option_labels ?? {})) {
        expect(offending(label), `${key}.${value}: "${label}"`).toEqual([]);
      }
    }
  });

  it("the new containment question names both ends rather than a key", () => {
    const q = questions.find((x) => x.body.includes("contains"));
    expect(q, "the on_child_fail question should render").toBeDefined();
    // Both endpoints, by the label she typed — not "{from}", not "on_child_fail".
    expect(q!.body).toContain("card a1");
    expect(q!.body).toContain("card a3");
    expect(q!.body).not.toContain("{from}");
    expect(q!.body).not.toContain("{to}");
  });
});
