// brain_expand source_turns over the service: the original conversation behind a memory.
// Own file: core's data dir is process-global, so one BrainService per vitest worker.
import { describe, expect, it } from "vitest";
import { appendEpisode, getDb } from "xanima-core";
import { startService, tool, nodeIdFrom } from "./helpers.js";

describe("brain_expand source_turns on the service", () => {
  it("returns the source turn with context, in text and json; 0 keeps the old output", async () => {
    const h = await startService({ sleep: { enabled: false }, backup: { enabled: false } });
    try {
      const tok = h.mint("alice");
      const brain = h.svc.brains.privateBrain("alice");
      const ids = await h.svc.brains.write(brain, () => [
        appendEpisode(brain, "chat-1", "user", "How do we deploy the newsletter service again?"),
        appendEpisode(brain, "chat-1", "user", "Remember: the production database is PostgreSQL 16 on RDS."),
        appendEpisode(brain, "chat-1", "assistant", "Noted, PostgreSQL 16 on RDS for production."),
      ]);
      const w = await tool(h.url, tok, "brain_write", { type: "semantic", label: "prod db", content: "The production database is PostgreSQL 16 on RDS." });
      const id = nodeIdFrom(w.text);
      // link the memory to the turn it came from (the plugin's extraction path does this on write)
      await h.svc.brains.write(brain, () => { getDb(brain).prepare("UPDATE nodes SET episode_ids = ? WHERE id = ?").run(JSON.stringify([ids[1]]), id); });

      const plain = await tool(h.url, tok, "brain_expand", { node_id: id });
      expect(plain.text).not.toMatch(/Source turn/);
      const r = await tool(h.url, tok, "brain_expand", { node_id: id, source_turns: 1 });
      expect(r.isError).toBe(false);
      expect(r.text).toMatch(/Source turn [0-9a-f]{8} in session chat-1/);
      expect(r.text).toMatch(/» \[.*user: Remember: the production database/);
      expect(r.text).toMatch(/assistant: Noted, PostgreSQL 16/);
      const j = JSON.parse((await tool(h.url, tok, "brain_expand", { node_id: id, source_turns: 1, format: "json" })).text) as { source_turns?: string };
      expect(j.source_turns).toMatch(/» \[.*user: Remember/);
      const bad = await tool(h.url, tok, "brain_expand", { node_id: id, source_turns: 99 });
      expect(bad.isError).toBe(true);
    } finally { await h.stop(); }
  });
});
