// Dormant memories over the service: brain_query include_dormant searches and revives them.
// Own file: core's data dir is process-global, so one BrainService per vitest worker.
import { describe, expect, it } from "vitest";
import { getDb, setMeta, runConsolidation } from "xanima-core";
import { startService, tool, nodeIdFrom } from "./helpers.js";

const log = { info: () => {}, warn: () => {}, error: () => {} };

describe("dormant memories on the service", () => {
  it("a faded private memory goes dormant on sleep, stays out of recall, and include_dormant revives it", async () => {
    const h = await startService({ sleep: { enabled: false }, backup: { enabled: false } });
    try {
      const tok = h.mint("alice");
      const w = await tool(h.url, tok, "brain_write", { type: "semantic", label: "sourdough starter", content: "a sourdough starter needs feeding every twelve hours in warm weather" });
      const id = nodeIdFrom(w.text);
      const brain = h.svc.brains.privateBrain("alice");
      await h.svc.brains.write(brain, () => {
        getDb(brain).prepare("UPDATE nodes SET retrievability = 0.001 WHERE id = ?").run(id);
        setMeta(brain, "last_consolidation", String(Date.now() - 8 * 86_400_000));
      });
      await h.svc.brains.write(brain, () => runConsolidation(brain, h.cfg.brain ?? {}, log));
      expect((getDb(brain).prepare("SELECT status FROM nodes WHERE id = ?").get(id) as { status: string }).status).toBe("dormant");

      const miss = await tool(h.url, tok, "brain_query", { query: "sourdough starter" });
      expect(miss.text).not.toMatch(/sourdough/);
      const st = await tool(h.url, tok, "brain_status", {});
      expect(st.text).toMatch(/dormant 1/);

      const hit = await tool(h.url, tok, "brain_query", { query: "sourdough starter", include_dormant: true });
      expect(hit.isError).toBe(false);
      expect(hit.text).toMatch(/sourdough starter \(revived from dormant\)/);
      const again = await tool(h.url, tok, "brain_query", { query: "sourdough starter" });
      expect(again.text).toMatch(/sourdough/);
      const j = JSON.parse((await tool(h.url, tok, "brain_query", { query: "sourdough starter", include_dormant: true, format: "json" })).text) as { results: Array<{ id: string; revived_from_dormant?: boolean }> };
      expect(j.results.some((r) => r.id === id)).toBe(true);
      expect(j.results.find((r) => r.id === id)!.revived_from_dormant).toBeUndefined(); // already active on the second call
    } finally { await h.stop(); }
  });
});
