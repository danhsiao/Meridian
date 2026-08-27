// The CI test that makes the central claim true.
//
// Freeze passing is EQUIVALENT to "every key anything downstream reads is bound
// or defaulted" — by construction, not by assertion. Add a template that reads
// a key nobody can ask about and this goes red.

import { describe, expect, it } from "vitest";
import { registry } from "../elaborate.js";
import { nodeConditions, edgeConditions, optionSources } from "../conditions.js";

/**
 * Two manifests, one rule. `templates` names what codegen reads; `reads_compiler`
 * names what elaborate() consumes to build `compiled`. Covering only the first
 * would leave `rel`, `on`, `cardinality`, `identity_key` and `verdict_on`
 * unverified — no template names them, so a future key of that shape could ship
 * with no `ask` entry and the build would stay green.
 */
function* everyReadKey(): Generator<[string, string, string]> {
  for (const [name, tpl] of Object.entries(registry.templates)) {
    for (const key of tpl.reads) yield [name.split(".")[0], key, `templates.${name}`];
  }
  for (const ref of registry.reads_compiler) {
    const [primitive, key] = ref.split(".");
    yield [primitive, key, `reads_compiler.${ref}`];
  }
}

describe("registry coherence", () => {
  it("every key anything downstream reads is askable or defaulted", () => {
    for (const [primitive, key, source] of everyReadKey()) {
      const k = registry.kinds[primitive];
      expect(k, `${source}: no kinds entry for "${primitive}"`).toBeDefined();

      const conditional = Object.values(k.required_if ?? {}).flat();
      const isRequired = k.required.includes(key) || conditional.includes(key);
      const isOptional = (k.optional ?? []).includes(key);

      expect(
        isRequired || isOptional,
        `${source}: "${key}" is in no list — not required, not required_if, not optional`,
      ).toBe(true);

      if (isRequired) {
        expect(
          registry.ask[`${primitive}.${key}`]?.binding,
          `${source}: "${primitive}.${key}" is required but has no ask binding`,
        ).toBeDefined();
      } else {
        expect(
          k.defaults ?? {},
          `${source}: optional "${primitive}.${key}" needs a default or it reaches codegen undefined`,
        ).toHaveProperty(key);
      }
    }
  });

  it("every named condition is implemented in code", () => {
    for (const [primitive, spec] of Object.entries(registry.kinds)) {
      for (const condName of Object.keys(spec.required_if ?? {})) {
        const impl =
          primitive === "edge" ? edgeConditions[condName] : nodeConditions[condName];
        expect(impl, `condition "${condName}" (${primitive}) is named but not implemented`).toBeTypeOf(
          "function",
        );
      }
    }
  });

  it("every named option source is implemented in code", () => {
    for (const [key, ask] of Object.entries(registry.ask)) {
      if (!ask.options_from) continue;
      expect(
        optionSources[ask.options_from],
        `ask "${key}" names option source "${ask.options_from}", which does not exist`,
      ).toBeTypeOf("function");
    }
  });

  it("every control key can produce options; prompt keys never carry an option source", () => {
    for (const [key, ask] of Object.entries(registry.ask)) {
      if (ask.binding === "control") {
        expect(ask.options_from, `control key "${key}" has no option source`).toBeDefined();
      }
      if (ask.binding === "prompt") {
        expect(ask.options_from, `prompt key "${key}" should not have an option source`).toBeUndefined();
      }
    }
  });

  it("a closed enum explains itself; an open one does not need to", () => {
    for (const [key, ask] of Object.entries(registry.ask)) {
      if (ask.extensible === false) {
        expect(
          ask.closed_because,
          `"${key}" is closed but gives no reason — render() has nothing to redirect with`,
        ).toBeTruthy();
      }
    }
  });

  it("every required_if_codes entry names a real condition", () => {
    const allConditions = new Set(
      Object.values(registry.kinds).flatMap((k) => Object.keys(k.required_if ?? {})),
    );
    for (const condName of Object.keys(registry.required_if_codes ?? {})) {
      expect(allConditions.has(condName), `required_if_codes names unknown condition "${condName}"`).toBe(
        true,
      );
    }
  });
});
