// Shared esbuild options for the two bundled consumers (mcp, openwave).
// core is NOT bundled here — it is compiled by tsc and resolved as a dep.
export const sharedEsbuild = {
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  external: [
    "better-sqlite3",
    "sqlite-vec",
    "sqlite-vec-darwin-arm64",
    "sqlite-vec-darwin-x64",
    "sqlite-vec-linux-x64",
    "sqlite-vec-windows-x64",
    "node:*",
  ],
};
