// Fatal startup errors also land in --log-file (the hidden Windows task has no console).
import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { tempRoot } from "./helpers.js";

const run = promisify(execFile);
const SERVER_CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

describe("sharpwave-server fatal errors", () => {
  it("are appended to --log-file as well as stderr", async () => {
    const root = tempRoot();
    const log = join(root, "logs", "service.log");
    try {
      const err = await run(process.execPath, [SERVER_CLI, "serve", "--root", root, "--config", join(root, "missing.json"), "--log-file", log])
        .then(() => null, (e: { code: number; stderr: string }) => e);
      expect(err?.code).toBe(1);
      expect(err?.stderr).toContain("missing.json");
      const text = readFileSync(log, "utf8");
      expect(text).toMatch(/\[sharpwave-server\] fatal sharpwave-server: .*missing\.json/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
