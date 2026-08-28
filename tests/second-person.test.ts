// Comments are spoken TO her, not about her.
//
// A prompt that asked for wording "in her language" got third-person prose
// back — "She wrote that Code Check checks..." — which reads like a canned
// template precisely because it isn't addressed to anyone.
//
// The model's output is guarded at parse time; this guards the wording we
// write ourselves, which is the half a prompt change can never fix.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { registry } from "@engine/compiler/client";

const RENDER = readFileSync(
  fileURLToPath(new URL("../packages/compiler/src/render.ts", import.meta.url)),
  "utf8",
);

/** Quoted strings that reach her — bodies, labels, intents. */
function userFacingStrings(src: string): string[] {
  return [...src.matchAll(/`([^`]{12,})`/g)].map((m) => m[1]).filter((s) => !s.includes("${1"));
}

describe("questions address the person reading them", () => {
  it("no registry intent speaks about her in the third person", () => {
    for (const [key, ask] of Object.entries(registry.ask)) {
      if (!ask.intent) continue;
      expect(
        /\b(she|her|hers)\b/i.test(ask.intent),
        `${key}: "${ask.intent}" talks about her instead of to her`,
      ).toBe(false);
    }
  });

  it("no condition wording speaks about her in the third person", () => {
    // Only the template strings, not the comments explaining them.
    const wording = RENDER.slice(
      RENDER.indexOf("const CONDITION_WORDING"),
      RENDER.indexOf("/** Findings with no registry key"),
    );
    for (const s of userFacingStrings(wording)) {
      expect(/\b(she|her|hers)\b/i.test(s), `"${s}" talks about her instead of to her`).toBe(false);
    }
  });

  it("the Pass B schema demands second person", () => {
    const propose = readFileSync(
      fileURLToPath(new URL("../packages/review-worker/src/propose.ts", import.meta.url)),
      "utf8",
    );
    expect(propose).toContain("second person");
    expect(propose).toContain("Never third person");
  });
});
