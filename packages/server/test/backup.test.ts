import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { listSnapshots, rotateSnapshots, snapshotBrain } from "../src/backup.js";
import { startService, tool, tempRoot } from "./helpers.js";

describe("backups", () => {
  it("VACUUM INTO snapshot is readable and contains the live data; rotation keeps N newest", async () => {
    const h = await startService({ backup: { enabled: false, keep: 3 } });
    try {
      const tok = h.mint("alice");
      for (let i = 0; i < 5; i++) {
        await tool(h.url, tok, "brain_write", { type: "semantic", label: `backup fact ${i}`, content: `backup payload ${i} ${Math.random()}` });
      }
      let last: ReturnType<typeof h.svc.backupNow> | undefined;
      for (let i = 0; i < 5; i++) last = h.svc.backupNow(["alice", "shared"]);
      expect(last!.failed).toEqual([]);
      const backups = join(h.root, "backups");
      const snaps = listSnapshots(backups, "alice");
      expect(snaps).toHaveLength(3);
      expect(listSnapshots(backups, "shared")).toHaveLength(3);
      expect(last!.ok.find((s) => s.brain === "alice")!.removed).toHaveLength(1);

      const newest = snaps.at(-1)!;
      const db = new Database(newest, { readonly: true });
      expect(db.pragma("quick_check", { simple: true })).toBe("ok");
      expect((db.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number }).n).toBe(5);
      expect((db.prepare("SELECT COUNT(DISTINCT writer_agent_id) AS n FROM nodes").get() as { n: number }).n).toBe(1);
      db.close();
      expect(existsSync(newest + ".tmp")).toBe(false);
    } finally {
      await h.stop();
    }
  });

  it("rotation deletes only the oldest matching snapshot files", () => {
    const root = tempRoot();
    const dir = join(root, "b", "x");
    mkdirSync(dir, { recursive: true });
    const names = ["2026-01-01T00-00-00-000Z", "2026-01-02T00-00-00-000Z", "2026-01-03T00-00-00-000Z", "2026-01-04T00-00-00-000Z"].map((s) => `x-${s}.db`);
    for (const n of names) writeFileSync(join(dir, n), "");
    writeFileSync(join(dir, "notes.txt"), "keep me");
    const removed = rotateSnapshots(join(root, "b"), "x", 2).map((p) => basename(p));
    expect(removed).toEqual(names.slice(0, 2));
    expect(listSnapshots(join(root, "b"), "x").map((p) => basename(p))).toEqual(names.slice(2));
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
  });

  it("`sharpwave-server backup now` CLI snapshots every brain under the root", async () => {
    const h = await startService();
    const tok = h.mint("bob");
    await tool(h.url, tok, "brain_write", { type: "semantic", label: "cli backup", content: "cli backup payload" });
    await h.stop(false);
    // Built CLI (the package `test` script runs esbuild first).
    const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
    const res = spawnSync(process.execPath, [cli, "backup", "now", "--root", h.root, "--keep", "2"], { encoding: "utf8" });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/ok\s+bob/);
    expect(res.stdout).toMatch(/ok\s+shared/);
    expect(listSnapshots(join(h.root, "backups"), "bob")).toHaveLength(1);
  });

  it("snapshotBrain refuses a missing brain", () => {
    expect(() => snapshotBrain(join(tempRoot(), "nope.db"), tempRoot(), "nope", 3)).toThrow(/does not exist/);
  });
});
