// A condition that fires with no wording falls through to render()'s last
// resort — "what should on absent be?" — which puts a key name in front of
// her. That fallback is meant to be unreachable, so this asserts it is.

import { describe, expect, it } from "vitest";
import { registry, nodeConditions, edgeConditions } from "@engine/compiler/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RENDER = readFileSync(
  fileURLToPath(new URL("../packages/compiler/src/render.ts", import.meta.url)),
  "utf8",
);

/** Conditions named by any kind's required_if. */
function namedConditions(): { kind: string; condition: string }[] {
  return Object.entries(registry.kinds).flatMap(([kind, spec]) =>
    Object.keys(spec.required_if ?? {}).map((condition) => ({ kind, condition })),
  );
}

describe("every condition can explain itself", () => {
  it("is implemented in code", () => {
    for (const { kind, condition } of namedConditions()) {
      const impl = kind === "edge" ? edgeConditions[condition] : nodeConditions[condition];
      expect(impl, `${kind}.required_if names "${condition}", which nothing implements`).toBeTypeOf(
        "function",
      );
    }
  });

  it("has wording, or the key it requires has an intent", () => {
    for (const { kind, condition } of namedConditions()) {
      const hasWording = new RegExp(`^\\\\s*${condition}:`, "m").test(RENDER);
      const keys = registry.kinds[kind].required_if?.[condition] ?? [];
      const everyKeyWritten = keys.every((k) => {
        const ask = registry.ask[`${kind}.${k}`];
        // A derived key is played back, never asked, so it needs no wording.
        return !ask || ask.binding === "derived" || Boolean(ask.intent);
      });
      expect(
        hasWording || everyKeyWritten,
        `condition "${condition}" (${kind}) has no CONDITION_WORDING entry, and ` +
          `${keys.join(", ")} have no intent — she would be shown a key name.`,
      ).toBe(true);
    }
  });
});
