// Nightly sleep on an ADOPTED copy of a real legacy brain (ISSUE: does the 03:30
// cycle cover main's adopted private brain, and does brain_stats.lastConsolidation
// move?). Runs the exact callback the 03:30 scheduler fires (SleepRunner.runCycle
// without force, respectGate from config) on a copy; the snapshot itself is only
// copied, and its sha256 is checked unchanged. No memory content is asserted on.
// Skipped when $SHARPWAVE_SNAPSHOT_DIR (default /workspace/brain-snap/main) is absent.
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { startService, tempRoot, tool } from "./helpers.js";
import { msUntilNext } from "../src/schedule.js";
import { resolveConfig } from "../src/config.js";

const run = promisify(execFile);
const SERVER_CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const SRC = process.env["SHARPWAVE_SNAPSHOT_DIR"] ?? "/workspace/brain-snap/main";
const has = existsSync(join(SRC, "brain.db")) && existsSync(SERVER_CLI);
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

describe("03:30 schedule is local wall-clock time", () => {
  it("default sleep.at is 03:30 and msUntilNext follows the process time zone", () => {
    expect(resolveConfig({}).sleep).toMatchObject({ enabled: true, at: "03:30", respectGate: true });
    const tz = process.env["TZ"];
    try {
      process.env["TZ"] = "America/Phoenix"; // UTC-7 all year (no DST)
      expect(msUntilNext("03:30", new Date("2026-10-01T09:00:00Z"))).toBe(90 * 60_000); // 02:00 MST → 03:30 MST
      expect(msUntilNext("03:30", new Date("2026-10-01T10:31:00Z"))).toBe((24 * 60 - 1) * 60_000);
      process.env["TZ"] = "UTC";
      expect(msUntilNext("03:30", new Date("2026-10-01T09:00:00Z"))).toBe((18 * 60 + 30) * 60_000);
    } finally {
      if (tz === undefined) delete process.env["TZ"]; else process.env["TZ"] = tz;
    }
  });
});

describe.skipIf(!has)("nightly sleep on an adopted snapshot copy", () => {
  it("is enumerated, honours the episode gate, and updates brain_stats.lastConsolidation when it runs", async () => {
    const files = ["brain.db", "brain.db-wal"].filter((f) => existsSync(join(SRC, f)));
    const shaBefore = Object.fromEntries(files.map((f) => [f, sha(join(SRC, f))]));
    const root = tempRoot("sw-sleep-snap-");
    const legacy = join(root, "legacy", "main");
    mkdirSync(legacy, { recursive: true });
    for (const f of files) copyFileSync(join(SRC, f), join(legacy, f));
    const svcRoot = join(root, "service");
    await run(process.execPath, [SERVER_CLI, "brain", "adopt", "--agent", "main", "--from", legacy, "--root", svcRoot, "--tailnet-ip", "none", "--port", "1", "--json"]);

    const dbPath = join(svcRoot, "brains", "main", "brain.db");
    const meta = (k: string) => {
      const d = new Database(dbPath, { readonly: true });
      try { return (d.prepare("SELECT value FROM meta_kv WHERE key = ?").get(k) as { value: string } | undefined)?.value ?? null; } finally { d.close(); }
    };
    const lastMs0 = Number(meta("last_consolidation"));
    const lastCount0 = Number(meta("last_consolidation_episode_count"));
    expect(lastMs0).toBeGreaterThan(0); // carried over inside the adopted file

    const h = await startService({}, svcRoot);
    try {
      expect(h.svc.brains.listBrains()).toContain("main"); // enumerated from brains/<dir>/brain.db
      const tok = h.mint("main");
      const stats = async () => JSON.parse((await tool(h.url, tok, "brain_stats", { format: "json" })).text);
      const s0 = await stats();
      const priv0 = (s0.brains ?? [s0]).find((b: { brain: string }) => b.brain === "private") ?? s0.private ?? s0;
      expect(priv0.lastConsolidation).toBe(new Date(lastMs0).toISOString());
      const eps0 = priv0.episodes as number;

      // 1) The 03:30 callback as-is: gated iff fewer than 10 new episodes since the last run.
      const r1 = await h.svc.runSleepNow(false);
      const gated = eps0 - lastCount0 < 10;
      expect(r1.skippedGate.includes("main")).toBe(gated);
      if (gated) expect(Number(meta("last_consolidation"))).toBe(lastMs0);

      // 2) Live state on the PC (261+ episodes): top up to >= 10 new and run the same callback.
      for (let i = eps0 - lastCount0; i < 12; i++) {
        await tool(h.url, tok, "brain_episode_append", { session_id: "agent:main:main", role: "user", content: `Synthetic test turn ${i}: the gate counts new episodes since the last run.` });
      }
      const t = Date.now();
      const r2 = await h.svc.runSleepNow(false);
      expect(r2.ran).toContain("main");
      const lastMs1 = Number(meta("last_consolidation"));
      expect(lastMs1).toBeGreaterThanOrEqual(t);
      const s1 = await stats();
      const priv1 = (s1.brains ?? [s1]).find((b: { brain: string }) => b.brain === "private") ?? s1.private ?? s1;
      expect(priv1.lastConsolidation).toBe(new Date(lastMs1).toISOString());
      expect(readFileSync(h.cfg.auditFile, "utf8")).toMatch(/"system:sleep","tool":"consolidation","brain":"main"/);
      process.stdout.write(`[sleep-snapshot] lastConsolidation ${new Date(lastMs0).toISOString()} -> ${new Date(lastMs1).toISOString()}; first cycle gated=${gated} (episodes ${eps0}, at last run ${lastCount0})\n`);
    } finally {
      await h.stop();
    }
    for (const f of files) expect(sha(join(SRC, f))).toBe(shaBefore[f]);
  }, 120_000);
});
