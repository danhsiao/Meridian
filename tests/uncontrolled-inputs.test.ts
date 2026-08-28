// An editable value must never be uncontrolled, and anything holding one must
// be keyed by identity rather than position.
//
// Together those two produced silent data corruption. React reads
// `defaultValue` once at mount; an index key lets it reuse the same DOM
// subtree for a different node. The input kept the previous node's text, and
// blurring committed that text against the new node's id — so a card renamed
// itself to a neighbour's name with nobody touching it.
//
// Index keys over plain strings are fine and stay fine: a line of status text
// has no state to carry across. The rule is about things that hold a draft.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const COMPONENTS = fileURLToPath(new URL("../apps/web/src/components", import.meta.url));

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const full = join(dir, n);
    return statSync(full).isDirectory() ? files(full) : /\.tsx$/.test(full) ? [full] : [];
  });
}

/** Prose explaining a rule shouldn't trip the rule. */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

describe("editable values are controlled and identified", () => {
  const sources = files(COMPONENTS).map((f) => ({
    file: f.split("/").pop()!,
    src: code(readFileSync(f, "utf8")),
  }));

  it("finds components to check", () => {
    expect(sources.length).toBeGreaterThan(4);
  });

  it("no input carries defaultValue", () => {
    for (const { file, src } of sources) {
      expect(
        src.includes("defaultValue"),
        `${file}: defaultValue is read once at mount, so the input keeps showing a ` +
          `previous node's text when React reuses the subtree. Use controlled state.`,
      ).toBe(false);
    }
  });

  it("the folded rows are keyed by node, not by position", () => {
    // Proximity is the wrong test: a sibling list of status strings can key by
    // index perfectly safely. What matters is the list that CONTAINS a draft —
    // here, the folded child rows — so assert that one directly.
    const src = readFileSync(join(COMPONENTS, "BoardCard.tsx"), "utf8");
    expect(src).toContain('key={row.node.id} className="child-block"');
    expect(src).toContain('key={row.node.id}>✓ {row.node.label}');
  });

  it("EditableLabel refuses to commit across a node change", () => {
    const src = readFileSync(join(COMPONENTS, "EditableLabel.tsx"), "utf8");
    // The guard that actually prevents the corruption, not just the symptom.
    expect(src).toContain("owner.current !== nodeId");
  });
});
