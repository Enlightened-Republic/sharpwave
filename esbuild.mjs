import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
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

console.log("sharpwave built to dist/index.js");
