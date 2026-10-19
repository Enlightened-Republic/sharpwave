// brain_reset on the service: allowReset + admin scope, backup first, full wipe.
// Own file: core's data dir is process-global, so one BrainService per vitest worker.
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { startService, tool } from "./helpers.js";

describe("brain_reset on the service", () => {
  it("brain_reset with allowReset + admin takes a VACUUM INTO backup on the service's own connection and wipes continuity state", async () => {
    const h2 = await startService({ allowReset: true, sleep: { enabled: false }, backup: { enabled: false } });
    try {
      const admin = h2.mint("root-admin", ["read", "write", "admin"]);
      await tool(h2.url, admin, "brain_write", { type: "semantic", label: "to be wiped", content: "this node must disappear on reset" });
      const g = await tool(h2.url, admin, "brain_set_goal", { title: "a goal to wipe", priority: 2 });
      expect(g.isError).toBe(false);
      const r = await tool(h2.url, admin, "brain_reset", { confirm: "root-admin" });
      expect(r.isError).toBe(false);
      expect(r.text).toMatch(/Backup: .*backup-\d+\.db/);
      expect(r.text).toMatch(/1 goals/);
      const backup = r.text.match(/Backup: (.*)/)![1]!.trim();
      const b = new Database(backup, { readonly: true });
      expect(b.pragma("quick_check", { simple: true })).toBe("ok");
      expect((b.prepare("SELECT COUNT(*) n FROM goals").get() as { n: number }).n).toBe(1);
      b.close();
      const goals = await tool(h2.url, admin, "brain_list_goals", { status: "all" });
      expect(goals.text).not.toMatch(/a goal to wipe/);
      const q = await tool(h2.url, admin, "brain_query", { query: "disappear on reset" });
      expect(q.text).not.toMatch(/to be wiped/);
    } finally { await h2.stop(); }
  });
});
