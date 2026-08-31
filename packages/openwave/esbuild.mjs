import { build } from "esbuild";
import { sharedEsbuild } from "../../esbuild.shared.mjs";

// `sharpwave-core` is deliberately NOT in sharedEsbuild.external — esbuild
// inlines its compiled dist/*.js into this single bundle so the gateway loads
// one file from `plugins.load.paths`. Only the native modules
// (better-sqlite3 / sqlite-vec*) and node:* stay external.
await build({
  ...sharedEsbuild,
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  banner: { js: `// openwave — built ${new Date().toISOString()}\n` },
});

console.log("openwave built to dist/index.js");
