import { build } from "esbuild";
import { readFileSync } from "node:fs";

// Single source of truth for the version. src/index.ts previously hardcoded it,
// which silently drifted from package.json — a stale constant makes the server
// misreport itself over MCP AND makes checkForUpdate compare the wrong version,
// so a fresh install would nag daily to upgrade to the release it is already on.
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));

await build({
  entryPoints: ["src/index.ts"],
  define: { __SHARPWAVE_VERSION__: JSON.stringify(version) },
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  outfile: "dist/index.js",
  external: [
    // Native modules — must stay external so npm installs the correct
    // prebuilt binary for the user's platform at install time.
    "better-sqlite3",
    "sqlite-vec",
    "sqlite-vec-darwin-arm64",
    "sqlite-vec-darwin-x64",
    "sqlite-vec-linux-x64",
    "sqlite-vec-windows-x64",
    "node:*",
  ],
  banner: {
    js: `#!/usr/bin/env node\n// sharpwave — built ${new Date().toISOString()}\n`,
  },
});

console.log(`sharpwave v${version} built to dist/index.js`);
