// 0.5.1: untracked legacy goals stay out of the remote turn header / status / soul export,
// and `xanima-server goals list-legacy | pause-legacy | resume-legacy` through the real CLI.
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startService, tool } from "./helpers.js";

const run = promisify(execFile);
const SERVER_CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const FRAGS = ['"), so I want to make sure I understand what landed wrong', "twilio i want to keep the same number", "I want to take the whole lane out and replace "];

function plantLegacy(dbPath: string) {
  const d = new Database(dbPath); d.pragma("journal_mode = WAL");
  const now = Date.now();
  for (const [i, t] of FRAGS.entries()) {
    const id = `00000000-0000-4000-8000-00000000000${i}`;
    d.prepare(`INSERT INTO nodes (id, type, label, content, importance, salience, stability, retrievability, created_at, accessed_at, updated_at, source_type, status)
               VALUES (?, 'goal', ?, ?, 0.6, 0.9, 1, 1, ?, ?, ?, 'legacy', 'active')`).run(id, t, t, now, now, now);
    d.prepare(`INSERT INTO goals (node_id, lineage_id, version, title, priority, status, keywords_json, tracked, created_at, updated_at) VALUES (?, ?, 1, ?, 3, 'active', '[]', 0, ?, ?)`).run(id, id, t, now, now);
  }
  d.close();
}

describe("legacy untracked goals over the service + CLI", () => {
  it("header/status/export carry tracked goals only; pause-legacy is backed up, audited and reversible", async () => {
    const h = await startService();
    const port = String(h.url.split(":").pop());
    const cli = (args: string[]) => run(process.execPath, [SERVER_CLI, ...args, "--root", h.root, "--tailnet-ip", "none", "--port", port]);
    try {
      const a = h.mint("a");
      expect((await tool(h.url, a, "brain_set_goal", { title: "Launch the newsletter", priority: "high" })).isError).toBe(false);
      const dbPath = join(h.root, "brains", "a", "brain.db");
      plantLegacy(dbPath);
      const tc = JSON.parse((await tool(h.url, a, "brain_turn_context", { query: "hi" })).text);
      expect(tc.activeGoals).toEqual(["Launch the newsletter"]);
      const st = (await tool(h.url, a, "brain_status", { visibility: "private" })).text;
      expect(st).toMatch(/goals: 1 active \(1 drift-checked\).*3 untracked legacy/);
      const pkg = JSON.parse((await tool(h.url, a, "brain_export_soul", { format: "json" })).text);
      expect(pkg.content.goals.map((g: { title: string }) => g.title)).toEqual(["Launch the newsletter"]);

      const list = JSON.parse((await cli(["goals", "list-legacy", "--agent", "a", "--json"])).stdout);
      expect(list.length).toBe(3); expect(list.every((g: { fragment: string | null }) => g.fragment)).toBe(true);
      await expect(cli(["goals", "pause-legacy", "--agent", "a"])).rejects.toThrow(/stop it first/);
      const dry = JSON.parse((await cli(["goals", "pause-legacy", "--agent", "a", "--dry-run", "--json"])).stdout);
      expect(dry.paused.length).toBe(3); expect(dry.backup).toBeNull();
      await h.svc.stop();
      const r = JSON.parse((await cli(["goals", "pause-legacy", "--agent", "a", "--json"])).stdout);
      expect(r.paused.length).toBe(3); expect(existsSync(r.backup)).toBe(true);
      expect(readdirSync(join(h.root, "backups", "a", "goals-pause")).length).toBe(1);
      const q = (sql: string) => { const d = new Database(dbPath, { readonly: true }); try { return d.prepare(sql).all(); } finally { d.close(); } };
      expect(q("SELECT status, COUNT(*) n FROM goals GROUP BY status ORDER BY status")).toEqual([{ status: "active", n: 1 }, { status: "paused", n: 3 }]);
      expect(readFileSync(h.cfg.auditFile, "utf8")).toMatch(/goals\.pause-legacy/);
      const u = JSON.parse((await cli(["goals", "resume-legacy", "--agent", "a", "--batch", r.batch, "--json"])).stdout);
      expect(u.resumed.length).toBe(3);
      expect(q("SELECT status, COUNT(*) n FROM goals GROUP BY status")).toEqual([{ status: "active", n: 4 }]);
    } finally { await h.stop(); }
  });
});
