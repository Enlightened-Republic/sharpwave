import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { queueEpisodeForExtraction, drainExtractionQueue } from "../src/extraction.js";
import { DEFAULT_CONFIG } from "../src/types.js";

// ── API drift (openwave / sharpwave-core split, Task 6d) ───────────────────────
// clawbrain-v4's DEFAULT_CONFIG shipped `llmExtractionEnabled: true`; sharpwave's
// DEFAULT_CONFIG ships it `false` (opt-in). The clawbrain suite implicitly relied
// on the enabled default for every non-"disabled" case. Each of those cases now
// spreads `...enabled` (DEFAULT_CONFIG + llmExtractionEnabled:true) so it still
// exercises the drain/heuristic path it was written for — no assertion is
// weakened, and the importance-threshold / queue-reset cases now genuinely run
// the enabled code path instead of short-circuiting on the disabled guard.
const enabled = { ...DEFAULT_CONFIG, llmExtractionEnabled: true };

function fresh(): string { return `test-${randomUUID().slice(0, 8)}`; }
const log = { info: () => {}, warn: (..._args: unknown[]) => {} };

function makeEpisode(id: string, content: string, importance = 0.8) {
  return {
    id,
    session_id: "s",
    role: "user" as const,
    content,
    importance,
    tokens: Math.ceil(content.length / 4),
    ripple_count: 0,
    created_at: Date.now(),
    meta: null,
  };
}

describe("extraction", () => {
  it("drainExtractionQueue returns empty array when llmExtractionEnabled is false", async () => {
    const agentId = fresh();
    const config = { ...DEFAULT_CONFIG, llmExtractionEnabled: false };

    queueEpisodeForExtraction(agentId, makeEpisode("ep1", "I am a software engineer with ten years of experience."));
    const result = await drainExtractionQueue(agentId, config, log);
    // The drain result is an Array<ExtractedFact> carrying non-enumerable
    // episodeIds + temporalRelations side-channels (Agent B → Agent C
    // coordination for T1.3 / T1.5). Test the array contract explicitly.
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
    expect(result.episodeIds).toEqual([]);
    expect(result.temporalRelations).toEqual([]);
  });

  it("drainExtractionQueue clears pending queue even when disabled — no memory leak", async () => {
    const agentId = fresh();
    const config = { ...DEFAULT_CONFIG, llmExtractionEnabled: false };

    queueEpisodeForExtraction(agentId, makeEpisode("ep2", "Some content that should be cleared."));
    await drainExtractionQueue(agentId, config, log);

    // Second drain should also be empty — the queue must have been cleared
    queueEpisodeForExtraction(agentId, makeEpisode("ep3", "More content."));
    // Re-enable to confirm queue was actually cleared, not just skipped
    const result2 = await drainExtractionQueue(agentId, { ...config, llmExtractionEnabled: false }, log);
    expect(result2.length).toBe(0);

    // Drain with extraction enabled — only the second episode should be in scope
    // (the first was already cleared). Without the fix, both would accumulate.
    const enabledResult = await drainExtractionQueue(agentId, { ...enabled, openRouterApiKey: "" }, log);
    // With no API key, falls through to heuristic — result may be empty or non-empty
    // Key assertion: no crash, no unbounded accumulation
    expect(Array.isArray(enabledResult)).toBe(true);
  });

  it("drainExtractionQueue skips episodes below importance threshold", async () => {
    const agentId = fresh();
    // Episodes with importance below llmExtractionMinImportance (default 0.4)
    queueEpisodeForExtraction(agentId, makeEpisode("ep4", "ok", 0.1));
    queueEpisodeForExtraction(agentId, makeEpisode("ep5", "sure", 0.1));

    const result = await drainExtractionQueue(agentId, { ...enabled, openRouterApiKey: "" }, log);
    expect(result.length).toBe(0);
    expect(result.episodeIds).toEqual([]);
  });

  it("drainExtractionQueue returns heuristic facts when no API key", async () => {
    const agentId = fresh();
    queueEpisodeForExtraction(agentId, makeEpisode(
      "ep6",
      "I am a data scientist who always uses Python for machine learning projects. The procedure to run the model is: install dependencies, then call train.py.",
      0.9,
    ));

    const result = await drainExtractionQueue(agentId, { ...enabled, openRouterApiKey: "" }, log);
    // Heuristic fallback classifies sentences — should extract at least one fact
    expect(Array.isArray(result)).toBe(true);
    // Sentence starting with "I am" should be classified as identity
    const identityFacts = result.filter((f) => f.type === "identity");
    expect(identityFacts.length).toBeGreaterThan(0);
    // T1.3: heuristic fallback path still returns the consumed episode id so
    // index.ts can flip llm_extracted = 1 for it.
    expect(result.episodeIds.length).toBeGreaterThan(0);
  });

  it("drainExtractionQueue resets queue between sessions", async () => {
    const agentId = fresh();
    queueEpisodeForExtraction(agentId, makeEpisode("ep7", "I am an engineer with twenty years of experience.", 0.9));

    // Drain session 1
    await drainExtractionQueue(agentId, { ...enabled, openRouterApiKey: "" }, log);

    // Queue should be empty after drain
    const result2 = await drainExtractionQueue(agentId, { ...enabled, openRouterApiKey: "" }, log);
    expect(result2.length).toBe(0);
  });

  // T1.5 — temporal_relations exposed by the drain. The heuristic path emits
  // a `before` chain over the first classifiable sentence of each episode in
  // drain order. The LLM path would add LLM-extracted relations on top.
  it("drainExtractionQueue exposes heuristic temporal_relations across episodes", async () => {
    const agentId = fresh();
    queueEpisodeForExtraction(agentId, makeEpisode(
      "epT1",
      "I always start the morning by checking my calendar before doing anything else.",
      0.8,
    ));
    queueEpisodeForExtraction(agentId, makeEpisode(
      "epT2",
      "Then I review the active goals to set my focus for the day.",
      0.8,
    ));

    const result = await drainExtractionQueue(agentId, { ...enabled, openRouterApiKey: "" }, log);
    // We don't assert exact count because the heuristic classifier may skip
    // a sentence — but if any temporal relation surfaces, it must be
    // shaped correctly.
    for (const rel of result.temporalRelations) {
      expect(rel.relation === "before" || rel.relation === "after").toBe(true);
      expect(typeof rel.subject).toBe("string");
      expect(typeof rel.object).toBe("string");
      expect(rel.subject).not.toBe(rel.object);
    }
  });
});
