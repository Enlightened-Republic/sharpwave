// packages/core/src/index.ts
//
// sharpwave-core PUBLIC API BARREL — the only supported surface.
//
// Hand-curated re-export of the engine's public symbols. Every name here was
// copied verbatim from the owning module's `export` declarations. Consumers
// (`packages/mcp`, `packages/openwave`) import ONLY from `sharpwave-core`.
//
// Modules ported in later tasks (context-assembly, awake-replay,
// proactive-monitor, extraction, episode-lanes, valor, morning, compaction,
// tools) append their exports to this file in their own task.

// ---------------------------------------------------------------------------
// types — shared shapes + DEFAULT_CONFIG (re-exported by the wildcard below)
// ---------------------------------------------------------------------------
export * from "./types.js";

// ---------------------------------------------------------------------------
// db — connection pool, meta store, maintenance
// ---------------------------------------------------------------------------
export {
  getDb, closeDb, closeAllDbs, getMeta, setMeta, maintenance,
  bumpWriteCounter, getWriteCount, getFtsOptimizeEvery,
} from "./db.js";

// ---------------------------------------------------------------------------
// nodes — node CRUD, FTS, FSRS retrievability, salience, ps-hash, dopamine
// ---------------------------------------------------------------------------
export {
  writeNode, getNode, touchNode, ftsSearchNodes, getNeighbors, getTopByType,
  getOperationalProcedures,
  getActiveGoals, getReviewQueue, propagateDopamineSpike, decayEligibilityTraces,
  decayRetrievability, fsrsRetrievability, getRetrievability, computeSalience,
  computePsHash, psHashHamming, updatePsHash,
} from "./nodes.js";

// ---------------------------------------------------------------------------
// edges — bitemporal edge CRUD, inhibition
// ---------------------------------------------------------------------------
export {
  writeEdge, closeEdge, closeEdgesFromNode, closeEdgesToNode,
  getActiveEdgesFrom, getInhibitedNodeIds, edgeExists, edgeExistsEitherDirection, getEdge,
} from "./edges.js";

// ---------------------------------------------------------------------------
// embeddings — queue, fetch/cache, vector search, auto-link, RRF fusion
// ---------------------------------------------------------------------------
export {
  queueEmbedding, drainEmbeddingQueue, sweepMissingEmbeddings, clearEmbeddingQueues,
  fetchEmbedding, fetchEmbeddingCached, storeEmbedding, vectorSearchNodes,
  autoLinkNode, rrfFuse, cosineSimilarity, bufferToFloat32,
  embeddingCacheStats, clearEmbeddingCache, EXPECTED_VEC_DIM,
} from "./embeddings.js";
export type { EmbeddingCacheStats } from "./embeddings.js";

// ---------------------------------------------------------------------------
// retrieval — hybrid recall + bootstrap
// ---------------------------------------------------------------------------
export { hybridRetrieve, bootstrapRetrieve } from "./retrieval.js";

// ---------------------------------------------------------------------------
// episodes — episode log, session summaries, importance scoring
// ---------------------------------------------------------------------------
export {
  appendEpisode, getEpisodesSince, getEpisodeCount, getEpisodesByIds,
  getRecentEpisodes, searchEpisodes, incrementEpisodeRipple, scoreImportance,
  getSessionSummaries,
} from "./episodes.js";

// ---------------------------------------------------------------------------
// consolidation — subconscious tick, REM/SWS consolidation, neuromodulators
// ---------------------------------------------------------------------------
export {
  setSubagentRunner, getNeuromodulatorState, shouldConsolidate,
  subconsciousTick, runConsolidation, forgetNodeById,
} from "./consolidation.js";
export type {
  SubagentRunInput, SubagentRunResult, SubagentRunner,
} from "./consolidation.js";

// ---------------------------------------------------------------------------
// activation — spreading activation + working memory
// ---------------------------------------------------------------------------
export {
  spreadActivation, workingMemoryBoost, updateWorkingMemory,
  clearWorkingMemory, clearStaleWorkingMemory,
} from "./activation.js";

// ---------------------------------------------------------------------------
// self-model — identity / goals / user-model store
// ---------------------------------------------------------------------------
export {
  getSelfModel, updateSelfModelField, formatSelfModelForContext,
} from "./self-model.js";

// ---------------------------------------------------------------------------
// entity-resolution — near-duplicate detection, coreference merge
// ---------------------------------------------------------------------------
export {
  jaccardShingles, findNearDuplicates, deduplicateExisting, mergeCoreferentNodes,
} from "./entity-resolution.js";
export type { DuplicateCandidate } from "./entity-resolution.js";

// ---------------------------------------------------------------------------
// skill-evolution — skill candidate detection + generation
// ---------------------------------------------------------------------------
export { detectSkillCandidates, generateSkill } from "./skill-evolution.js";

// ---------------------------------------------------------------------------
// reset — full brain wipe
// ---------------------------------------------------------------------------
export { resetBrain } from "./reset.js";
export type { ResetResult } from "./reset.js";

// ---------------------------------------------------------------------------
// db-backup — snapshot / restore / prune
// ---------------------------------------------------------------------------
export {
  getBackupDir, createBackup, restoreBackup, listBackups, getBackupInfo,
  deleteBackup, getLatestBackup, getBackupStorageUsage,
} from "./db-backup.js";

// ---------------------------------------------------------------------------
// metrics — snapshot + Prometheus / text formatters
// ---------------------------------------------------------------------------
export {
  collectMetrics, formatPrometheusMetrics, formatMetricsAsText,
} from "./metrics.js";
export type { MetricsSnapshot } from "./metrics.js";

// ---------------------------------------------------------------------------
// observability — counters, event log
// ---------------------------------------------------------------------------
export {
  bumpCounter, getCounters, setLastConsolidationAt, getLastConsolidationAt,
  isObservabilityEnabled, logObservabilityEvent,
} from "./observability.js";

// ---------------------------------------------------------------------------
// resilience — retry / timeout / fallback / circuit-breaker / health
// ---------------------------------------------------------------------------
export {
  retryWithBackoff, withTimeout, withFallback, executeAll,
  safeErrorToString, assertExists, healthCheck,
  TimeoutError, CircuitBreaker, CircuitBreakerOpenError, Result, RateLimiter,
} from "./resilience.js";
export type { RetryOptions } from "./resilience.js";

// ---------------------------------------------------------------------------
// wal-retry — SQLITE_BUSY retry wrappers
// ---------------------------------------------------------------------------
export { executeWithWalRetry, executeWithWalRetrySync } from "./wal-retry.js";
export type { WalRetryOptions } from "./wal-retry.js";

// ---------------------------------------------------------------------------
// validation — brain_* tool argument validators
// ---------------------------------------------------------------------------
export {
  validateBrainQuery, validateBrainWrite, validateBrainLink, validateBrainSupersede,
  validateBrainHistory, validateBrainExpand, validateBrainReview, validateBrainForget,
  validateBrainEdges, formatValidationErrors,
} from "./validation.js";
export type {
  ValidationError, ValidationResult,
  BrainQueryArgs, BrainWriteArgs, BrainLinkArgs, BrainSupersedArgs,
  BrainHistoryArgs, BrainExpandArgs, BrainReviewArgs, BrainForgetArgs, BrainEdgesArgs,
} from "./validation.js";

// ---------------------------------------------------------------------------
// update-check — npm version check
// ---------------------------------------------------------------------------
export { updateCheckDisabled, isNewer, checkForUpdate } from "./update-check.js";

// ---------------------------------------------------------------------------
// utils — agent-id resolution, sentence classification, bounded collections
// ---------------------------------------------------------------------------
export {
  agentIdFromKey, classifySentence, importanceForType, jaccardSim,
  BoundedTtlMap, BoundedTtlSet,
} from "./utils.js";

// ---------------------------------------------------------------------------
// episode-lanes — foreground/background episode-lane classification
// ---------------------------------------------------------------------------
export { classifyEpisodeLane, isForegroundLane } from "./episode-lanes.js";
export type { EpisodeLane } from "./episode-lanes.js";

// ---------------------------------------------------------------------------
// morning — wake-up brief (fires when the gap since last session > 4h)
// ---------------------------------------------------------------------------
export { getMorningBrief, formatMorningBlock } from "./morning.js";
export type { MorningBrief } from "./morning.js";

// ---------------------------------------------------------------------------
// valor — Value-Of-Recall utility gating. Module-level pending-injection map
// is driven by openwave hooks (recordInjection on prompt build,
// scoreReplyAgainstInjections on llm_output). Reads/writes nodes.inject_count
// and nodes.inject_hits (schema v17).
// ---------------------------------------------------------------------------
export {
  isNodeUsed, valorFactor, recordInjection, scoreReplyAgainstInjections,
  clearPendingInjections,
} from "./valor.js";

// ---------------------------------------------------------------------------
// context-assembly — the "wake up knowing" text-block builders openwave injects
// on every agent turn (self-model header, bootstrap, query-gated recall,
// always-on procedural rules). Ported from clawbrain-v4/src/bootstrap.ts.
// ---------------------------------------------------------------------------
export {
  getDreamContext, buildSelfModelHeader, buildBootstrapContext,
  buildRecallContext, buildProceduralContext, BRAIN_HEADER,
} from "./context-assembly.js";
export type { Surface } from "./context-assembly.js";

// ---------------------------------------------------------------------------
// proactive-monitor — CogniFold pre-recall priming. Runs at the top of every
// before_prompt_build pass and bumps eligibility_trace on nodes matching the
// last few episodes (FTS), the current neuromodulator state, and the semantic
// neighbourhood of the last user message. Ported from clawbrain-v4.
// ---------------------------------------------------------------------------
export { runProactiveMonitor } from "./proactive-monitor.js";

// ---------------------------------------------------------------------------
// awake-replay — awake SWR-analog tick (30-min cadence): stabilises high-ripple
// nodes, forms Hebbian associate edges from co-activation, prospective replay of
// goal neighbours, and a dream-context snapshot. Ported from clawbrain-v4.
// ---------------------------------------------------------------------------
export { awakeReplayTick, recordCoactivations } from "./awake-replay.js";

// ---------------------------------------------------------------------------
// tools — the unified brain_* tool surface shared by mcp + openwave
// ---------------------------------------------------------------------------
export {
  BRAIN_TOOL_DEFS, dispatchBrainTool, MCP_TOOL_NAMES, OPENWAVE_TOOL_NAMES,
} from "./tools.js";
export type {
  BrainToolDef, BrainToolInputSchema, BrainToolResult,
} from "./tools.js";
