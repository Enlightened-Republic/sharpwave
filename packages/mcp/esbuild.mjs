import { build } from "esbuild";
import { readFileSync, cpSync } from "node:fs";
import { sharedEsbuild } from "../../esbuild.shared.mjs";

// Single source of truth for the version. src/index.ts previously hardcoded it,
// which silently drifted from package.json — a stale constant makes the server
// misreport itself over MCP AND makes checkForUpdate compare the wrong version,
// so a fresh install would nag daily to upgrade to the release it is already on.
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

await build({
  ...sharedEsbuild,
  entryPoints: ["src/index.ts"],
  define: { __SHARPWAVE_VERSION__: JSON.stringify(version) },
  outfile: "dist/index.js",
  // `sharpwave-core` is deliberately NOT in sharedEsbuild.external — esbuild
  // inlines its compiled dist/*.js into this single bundle. Only the native
  // modules (better-sqlite3 / sqlite-vec*) and node:* stay external.
  banner: {
    js: `#!/usr/bin/env node\n// sharpwave — built ${new Date().toISOString()}\n`,
  },
});

// The published package's README/LICENSE live at the repo root; copy them in so
// `npm publish` from packages/mcp ships them (they are git-ignored here).
cpSync(new URL("../../README.md", import.meta.url), new URL("./README.md", import.meta.url));
cpSync(new URL("../../LICENSE", import.meta.url), new URL("./LICENSE", import.meta.url));

console.log(`sharpwave v${version} built to dist/index.js`);
