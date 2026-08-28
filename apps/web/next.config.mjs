import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// The env file lives at the repo root, not in apps/web — one file for the
// canvas, the review worker and the CLI, because they all read the same bus.
// Next only looks in its own directory, so load it here.
const root = fileURLToPath(new URL("../../.env.local", import.meta.url));
if (existsSync(root)) {
  for (const line of readFileSync(root, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^"(.*)"$/, "$1");
  }
}

/** @type {import('next').NextConfig} */
export default {
  transpilePackages: ["@engine/compiler"],
  // packages/compiler is written for NodeNext, so it imports "./elaborate.js"
  // meaning the .ts file. The Node worker in block 3 needs that; the bundler
  // needs to be told. Same source, two consumers, no build step between them.
  webpack: (config) => {
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
  env: {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  },
};
