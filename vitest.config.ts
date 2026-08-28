import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// fileURLToPath, never .pathname — this checkout has a space in its path, and
// .pathname percent-encodes it into a directory that does not exist.
const compiler = fileURLToPath(new URL("./packages/compiler/src/index.ts", import.meta.url));
const compilerGraph = fileURLToPath(new URL("./packages/compiler/src/graph.ts", import.meta.url));
const compilerClient = fileURLToPath(new URL("./packages/compiler/src/client.ts", import.meta.url));

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts", // the engine's own tests — synthetic ids only
      "apps/*/src/**/*.test.ts",
      "tests/**/*.test.ts",          // integration tests over real domain boards
    ],
  },
  resolve: {
    alias: [
      // most specific first — a bare "@engine/compiler" prefix match would
      // otherwise swallow the subpath.
      { find: "@engine/compiler/client", replacement: compilerClient },
      { find: "@engine/compiler/graph", replacement: compilerGraph },
      { find: "@engine/compiler", replacement: compiler },
    ],
  },
});
