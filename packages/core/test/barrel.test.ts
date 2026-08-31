// packages/core/test/barrel.test.ts
import { expect, test } from "vitest";
import * as core from "../src/index.js";

test("barrel exports the engine surface consumers depend on", () => {
  for (const name of [
    "getDb", "closeAllDbs", "getMeta", "setMeta",
    "writeNode", "getNode", "touchNode", "writeEdge", "propagateDopamineSpike",
    "hybridRetrieve", "bootstrapRetrieve",
    "appendEpisode", "getEpisodesSince", "getSessionSummaries", "searchEpisodes", "scoreImportance",
    "subconsciousTick", "shouldConsolidate", "runConsolidation", "getNeuromodulatorState",
    "queueEmbedding", "drainEmbeddingQueue", "sweepMissingEmbeddings", "clearEmbeddingQueues",
    "getSelfModel", "updateSelfModelField", "formatSelfModelForContext",
    "clearWorkingMemory", "clearStaleWorkingMemory",
    "createBackup", "resetBrain", "collectMetrics",
    "DEFAULT_CONFIG",
  ]) {
    expect(core, `missing export: ${name}`).toHaveProperty(name);
  }
});
