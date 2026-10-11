import { build } from "esbuild";
import { readFileSync, chmodSync } from "node:fs";
import { sharedEsbuild } from "../../esbuild.shared.mjs";

// Version comes from package.json at build time (same pattern as packages/mcp).
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

await build({
  ...sharedEsbuild,
  entryPoints: ["src/cli.ts"],
  define: { __SHARPWAVE_SERVER_VERSION__: JSON.stringify(version) },
  outfile: "dist/cli.js",
  // xanima-core and @modelcontextprotocol/sdk are inlined; only the native
  // sqlite modules and node:* stay external (see esbuild.shared.mjs).
  banner: {
    js: `#!/usr/bin/env node\n// xanima-server — built ${new Date().toISOString()}\n`,
  },
});
try { chmodSync(new URL("./dist/cli.js", import.meta.url), 0o755); } catch { /* windows */ }

console.log(`xanima-server v${version} built to dist/cli.js`);
