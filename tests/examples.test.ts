// The generality proof as a test rather than a screenshot.
//
// Two boards from unrelated industries go through the SAME compiler, the SAME
// registry and the SAME freeze, and both reach a stable hash.
//
// This lives in tests/ rather than packages/compiler/ on purpose: it is an
// integration test over real domain boards, so it necessarily names domain
// things. The compiler's own tests use synthetic ids and stay noun-free, and
// the noun lint enforces that boundary by scanning the engine and not this.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { apply, blockingFindings, elaborate, fill, freeze, render } from "@engine/compiler";
import type { Board, Finding } from "@engine/compiler";

const EXAMPLES = new URL("../examples/", import.meta.url);

function load(name: string): Board {
  const raw = JSON.parse(readFileSync(new URL(name, EXAMPLES), "utf8"));
  return { nodes: raw.nodes, edges: raw.edges };
}

const CONVERGED = ["receiving.json", "loan_file.json"];

describe.each(CONVERGED)("%s", (name) => {
  const board = load(name);

  it("elaborates with nothing blocking", () => {
    const { findings } = elaborate(board);
    const blocking = blockingFindings(findings);
    expect(
      blocking.map((f) => `${f.code} @ ${JSON.stringify(f.anchor)}`),
      "a converged example must not block freeze",
    ).toEqual([]);
  });

  it("has no advisories either — a converged board is genuinely finished", () => {
    expect(elaborate(board).findings.map((f) => f.code)).toEqual([]);
  });

  it("freezes, and the hash is stable across runs", () => {
    const a = freeze(board, { process_id: "p" });
    const b = freeze(board, { process_id: "p" });
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.spec.spec_hash).toBe(b.spec.spec_hash);
    expect(a.spec.spec_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("ignores layout, the way a compiler ignores whitespace", () => {
    const before = freeze(board, { process_id: "p" });
    const moved: Board = {
      nodes: board.nodes.map((n) => ({ ...n, x: (n.x ?? 0) + 999, y: (n.y ?? 0) - 17 })),
      edges: board.edges,
    };
    const after = freeze(moved, { process_id: "p" });
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(after.spec.spec_hash).toBe(before.spec.spec_hash);
    // and the coordinates genuinely aren't in the payload
    expect(JSON.stringify(after.spec.nodes)).not.toContain('"x"');
  });

  it("does NOT ignore a label, because a label reaches the extraction prompt", () => {
    const before = freeze(board, { process_id: "p" });
    const relabelled: Board = {
      nodes: board.nodes.map((n, i) => (i === 1 ? { ...n, label: n.label + " (renamed)" } : n)),
      edges: board.edges,
    };
    const after = freeze(relabelled, { process_id: "p" });
    expect(before.ok && after.ok).toBe(true);
    if (!before.ok || !after.ok) return;
    expect(after.spec.spec_hash).not.toBe(before.spec.spec_hash);
  });

  it("carries a compiled IR so codegen re-derives nothing", () => {
    const r = freeze(board, { process_id: "p" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const ir = r.spec.compiled;
    expect(ir.topo_order?.length).toBeGreaterThan(0);
    expect(Object.keys(ir.edge_roles ?? {})).toHaveLength(board.edges.length);
    // every policy has a verdict target, declared or derived
    for (const p of board.nodes.filter((n) => n.primitive === "policy")) {
      expect(ir.verdict_targets?.[p.id], `${p.id} has no verdict target`).toBeTruthy();
    }
  });

  it("every node in the store appears in the spec — folding is a view concern", () => {
    const r = freeze(board, { process_id: "p" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spec.nodes).toHaveLength(board.nodes.length);
  });
});

describe("one registry, two industries", () => {
  it("produces different hashes for different processes", () => {
    const a = freeze(load("receiving.json"), { process_id: "receiving" });
    const b = freeze(load("loan_file.json"), { process_id: "loan_file" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.spec.spec_hash).not.toBe(b.spec.spec_hash);
    expect(a.spec.registry_version).toBe(b.spec.registry_version);
  });

  it("an open comment blocks freeze on its own", () => {
    const r = freeze(load("receiving.json"), { process_id: "p", open_comments: ["c_99"] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.findings.map((f) => f.code)).toContain("open_comment");
  });
});

describe("the draft board — what she actually draws", () => {
  const draft = load("receiving_draft.json");

  it("does not freeze, and names the nodes at fault", () => {
    const r = freeze(draft, { process_id: "receiving" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.node_ids.length).toBeGreaterThan(0);
    // a failure a person can act on: node ids, not a stack trace
    expect(r.node_ids).toContain("rec_inv");
  });

  it("finds every mistake the demo depends on", () => {
    const codes = new Set(elaborate(draft).findings.map((f) => f.code));
    // boxes that should be fields
    expect(codes).toContain("demote_to_field");
    // one record arriving from two channels with nothing to merge it on
    expect(codes).toContain("missing_conditional_key");
    // checks described in English and never formalised
    expect(codes).toContain("unresolved_policy");
    // two records keyed the same way, never connected
    expect(codes).toContain("undeclared_join");
  });

  it("ranks the five collapses above the missing-key questions", () => {
    // The whole reason structural correction outranks everything else: fix the
    // modelling mistake in round one and round two isn't asking five separate
    // questions about five nodes that shouldn't exist.
    const findings = elaborate(draft).findings;
    const lastDemote = findings.map((f) => f.code).lastIndexOf("demote_to_field");
    const firstMissing = findings.findIndex((f) => f.code === "missing_conditional_key");
    expect(lastDemote).toBeLessThan(firstMissing);
  });

  it("emits exactly five collapses — one per box, not one per field", () => {
    const demotes = elaborate(draft).findings.filter((f) => f.code === "demote_to_field");
    expect(demotes).toHaveLength(5);
  });

  it("renders every question with no type-system vocabulary in it", () => {
    // Status findings are refused by render() — they are a marker on the card,
    // not a pin, because the compiler has no basis for the options it would
    // have to invent.
    for (const f of elaborate(draft).findings.filter((x) => x.askable)) {
      const r = render(f, draft);
      expect(r.body.length).toBeGreaterThan(0);
      for (const jargon of ["required_if", "missing_conditional_key", "verdict_on", "identity_key"]) {
        expect(r.body.toLowerCase()).not.toContain(jargon);
      }
    }
  });

  it("converges: applying the answers strictly reduces what's left", () => {
    // Not a full run to zero — that needs Pass B to propose the outbound
    // channel and the resolution loop to formalise the two checks. What this
    // asserts is the property the loop depends on: every answered comment
    // leaves the board with strictly less to ask about, so rounds terminate.
    let board = draft;
    let previous = elaborate(board).findings.length;
    expect(previous).toBeGreaterThan(0);

    for (let round = 0; round < 4; round++) {
      const findings = elaborate(board).findings;
      if (findings.length === 0) break;

      const applied = applyRound(board, findings);
      if (applied === board) break; // nothing left this round could answer alone

      board = applied;
      const now = elaborate(board).findings.length;
      expect(now, `round ${round} did not reduce the backlog`).toBeLessThan(previous);
      previous = now;
    }

    // the five phantom nodes are gone, and their checks moved to the parent
    expect(board.nodes.map((n) => n.id)).not.toContain("a_hts");
    // Derived from the draft, not hardcoded: every child that got demoted
    // should now be a field on the parent that contained it. Asserting the
    // RELATIONSHIP rather than a fixed list is both stronger and keeps the
    // expectation honest if the example board changes.
    const demoted = elaborate(draft).findings.filter((f) => f.code === "demote_to_field");
    const expectedFields = new Set(demoted.map((f) => String(f.evidence.field)));
    const parents = new Set(demoted.map((f) => String(f.evidence.parent)));
    expect(parents.size).toBe(1);
    const parentId = [...parents][0];
    const actual = new Set(board.nodes.find((n) => n.id === parentId)!.config.fields as string[]);
    for (const f of expectedFields) expect(actual).toContain(f);
    // As a set, because the order the fields land in follows the order the
    // comments were answered. Two people answering the same board in a
    // different order get the same process and a different hash — the same way
    // two people drawing it get different node ids. What has to hold is that
    // one answer sequence always produces one hash, which the next test pins.
    expect(actual.size).toBe(expectedFields.size);
  });

  it("converging twice from the same draft lands on the same hash", () => {
    // Determinism is the property that matters, not a particular field order.
    // elaborate() sorts findings, so a given board always answers in a given
    // order, so the same draft always converges to the same bytes.
    const runs = [0, 1].map(() => {
      let board = load("receiving_draft.json");
      for (let round = 0; round < 4; round++) {
        const findings = elaborate(board).findings;
        if (findings.length === 0) break;
        const applied = applyRound(board, findings);
        if (applied === board) break;
        board = applied;
      }
      return board;
    });
    expect(JSON.stringify(runs[0])).toBe(JSON.stringify(runs[1]));
  });
});

/**
 * Applies the findings a person could answer without a model: the structural
 * corrections, and the conditional keys whose option set has exactly one
 * sensible pick. Anything needing judgment is left for the review loop.
 */
function applyRound(board: Board, findings: Finding[]): Board {
  let next = board;
  let changed = false;

  for (const f of findings) {
    try {
      if (f.code === "demote_to_field" || f.code === "undeclared_join") {
        next = apply(next, f.mutation);
        changed = true;
      } else if (f.code === "missing_conditional_key" && f.evidence.key === "identity_key") {
        const options = render(f, next).options ?? [];
        if (options.length > 0) {
          next = apply(next, fill(f.mutation, options[0].value));
          changed = true;
        }
      }
    } catch {
      // A mutation that no longer applies means an earlier answer this round
      // already subsumed it — which is the dedupe story, not a failure.
    }
  }
  return changed ? next : board;
}
