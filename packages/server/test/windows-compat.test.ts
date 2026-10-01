import { describe, expect, it } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfigFile } from "../src/config.js";
import { tempRoot } from "./helpers.js";

describe("Windows compatibility", () => {
  it("config.json written with a UTF-8 BOM (PowerShell 5.1 Set-Content -Encoding UTF8) still loads", () => {
    const dir = tempRoot();
    try {
      const f = join(dir, "config.json");
      writeFileSync(f, "\uFEFF" + JSON.stringify({ port: 18790, tailnetHosts: [] }), "utf8");
      expect(loadConfigFile(f)).toEqual({ port: 18790, tailnetHosts: [] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
