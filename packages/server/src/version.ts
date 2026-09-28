// Injected by esbuild.mjs; falls back to package.json when running the TS source (vitest).
import { readFileSync } from "node:fs";

declare const __SHARPWAVE_SERVER_VERSION__: string;

function fromPackageJson(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0-dev";
  } catch {
    return "0.0.0-dev";
  }
}

export const VERSION: string =
  typeof __SHARPWAVE_SERVER_VERSION__ === "string" ? __SHARPWAVE_SERVER_VERSION__ : fromPackageJson();
