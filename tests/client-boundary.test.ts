// The browser must never reach a Node builtin.
//
// This has now broken the build twice, from two different files, each time
// because something in the browser imported the compiler's barrel — which
// re-exports freeze(), which hashes with node:crypto. Webpack can't bundle
// that, and the failure surfaces as an opaque UnhandledSchemeError pointing at
// "node:crypto" rather than at the import that caused it.
//
// So the boundary is a test rather than a habit.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(full)) out.push(full);
  }
  return out;
}

/** Modules that legitimately run on the server and may hold Node builtins. */
const SERVER_ONLY = ["apps/web/src/store/postgres.ts", "apps/web/src/actions.ts"];

describe("the client bundle stays free of Node builtins", () => {
  const files = [...walk(join(ROOT, "apps/web/src")), ...walk(join(ROOT, "apps/web/app"))];

  it("finds files to check", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it("only the server takes the compiler barrel", () => {
    for (const file of files) {
      const rel = file.slice(ROOT.length);
      if (SERVER_ONLY.includes(rel)) continue;
      const src = readFileSync(file, "utf8");
      expect(
        /from ["']@engine\/compiler["']/.test(src),
        `${rel} imports the compiler barrel, which pulls freeze() and node:crypto ` +
          `into the browser. Use "@engine/compiler/client".`,
      ).toBe(false);
    }
  });

  it("the client subpath itself imports nothing from node:", () => {
    // Transitively: client.ts re-exports these, so any node: import in them
    // lands in the bundle just the same.
    const reachable = [
      "packages/compiler/src/client.ts",
      "packages/compiler/src/elaborate.ts",
      "packages/compiler/src/graph.ts",
      "packages/compiler/src/conditions.ts",
      "packages/compiler/src/mutations.ts",
      "packages/compiler/src/render.ts",
      "packages/compiler/src/types.ts",
    ];
    for (const rel of reachable) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      const hit = src.match(/from ["']node:[a-z]+["']/);
      expect(hit?.[0], `${rel} imports ${hit?.[0]} and is reachable from the client`).toBeUndefined();
    }
  });

  it("freeze is reachable from the barrel and not from the client", () => {
    const barrel = readFileSync(join(ROOT, "packages/compiler/src/index.ts"), "utf8");
    const client = readFileSync(join(ROOT, "packages/compiler/src/client.ts"), "utf8");
    expect(barrel).toContain("./freeze.js");
    expect(client).not.toContain("./freeze.js");
  });
});
