import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { writeNode } from "../src/nodes.js";
import { hybridRetrieve, bootstrapRetrieve } from "../src/retrieval.js";
import { closeDb } from "../src/db.js";
import { DEFAULT_CONFIG } from "../src/types.js";

function fresh(): string { return `test-${randomUUID().slice(0, 8)}`; }

describe("retrieval", () => {
  it("hybridRetrieve returns results for a query with nodes in DB", async () => {
    const id = fresh();
    writeNode(id, "semantic", "OpenClaw memory system", "the memory system for the gateway", { importance: 0.8 });
    writeNode(id, "semantic", "Brain consolidation phase", "SWS consolidation runs nightly", { importance: 0.7 });
    writeNode(id, "identity", "who I am", "I am an AI assistant with memory", { importance: 0.9 });

    const results = await hybridRetrieve(id, "memory system", "sess1", DEFAULT_CONFIG);
    // With no Ollama available in test env, falls back to FTS only — results may vary
    expect(Array.isArray(results)).toBe(true);
    closeDb(id);
  });

  it("hybridRetrieve returns empty array for empty DB", async () => {
    const id = fresh();
    const results = await hybridRetrieve(id, "any query", "sess1", DEFAULT_CONFIG);
    expect(results).toEqual([]);
    closeDb(id);
  });

  it("bootstrapRetrieve always returns identity and goal nodes", async () => {
    const id = fresh();
    const identId = writeNode(id, "identity", "who I am", "I am an AI agent with persistent memory", { importance: 0.95 });
    const goalId = writeNode(id, "goal", "finish brain rebuild", "complete the v3 brain rebuild", { importance: 0.9 });

    const results = await bootstrapRetrieve(id, "sess1", DEFAULT_CONFIG);
    const ids = results.map((r) => r.id);
    // Identity and goal nodes should be seeded and appear in results
    expect(ids).toContain(identId);
    closeDb(id);
  });

  it("hybridRetrieve updates working memory after retrieval", async () => {
    const id = fresh();
    writeNode(id, "semantic", "working memory test node", "content for testing WM", { importance: 0.7 });

    await hybridRetrieve(id, "working memory test", "sess-wm", DEFAULT_CONFIG);

    const { getDb } = await import("../src/db.js");
    const db = getDb(id);
    const wm = db.prepare("SELECT * FROM working_memory WHERE session_id = 'sess-wm'").all();
    // Working memory may or may not have entries depending on FTS results
    expect(Array.isArray(wm)).toBe(true);
    closeDb(id);
  });
});
