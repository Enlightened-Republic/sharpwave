# Sharpwave Changelog

All notable changes to the Sharpwave TypeScript MCP server.

## [Unreleased]

### Fixed

- **`callOpenRouter` now strips a leading `openrouter/` from the model id.**
  `DEFAULT_CONFIG.ingestionModel` ships as
  `"openrouter/deepseek/deepseek-v4-flash"`, but the OpenRouter
  chat-completions API wants the bare `deepseek/deepseek-v4-flash`. Through
  0.4.0 the prefixed default 404'd and LLM fact extraction + generative-REM
  consolidation silently fell back to keyword heuristics. `fetchEmbedding`
  already did this strip for the embed endpoint; `callOpenRouter` now matches.
- **Retired nodes (`valid_until` in the past) no longer surface** in
  `getTopByType`, `getActiveGoals`, `getReviewQueue`, or dopamine propagation.
  Ports clawbrain-v4's F-9 audit fix, which only reached
  `getOperationalProcedures` during the MCP split.
- **`fetchEmbedding` accepts an optional `AbortSignal` again.** The
  proactive-relevance monitor races the semantic-priming embed against a 250ms
  budget; when the budget won, the underlying HTTP request kept running. It is
  now cancelled.

### Changed

- **Docs are client-neutral again.** The README leads with what Sharpwave is,
  then lists OpenClaw / Claude Code / Claude Desktop / Cursor even-handedly.
  (0.4.0 briefly framed everything around OpenClaw; the OpenClaw-specific
  wake-up/auto-injection layer is moving to a separate `openwave` plugin, so
  the MCP server stays cross-platform.)

## [0.4.0] — 2026-08-30

### Changed

- Fixed the `homepage` / `repository` / `bugs` URLs (`EnlightenedRepublic` →
  `Enlightened-Republic`) and repaired control-character corruption in the
  README's companion-tools table. `claude-desktop-config-example.json` is
  replaced by `openclaw-config-example.json` + `mcp-config-example.json`.
  Dropped `brain_health` from the documented tool list (it was never
  registered); documented `brain_reset`.

### Added

- **Multi-agent mode.** Leave `SHARPWAVE_AGENT_ID` unset and one server process
  serves any number of agents: every `brain_*` tool then carries a required
  `agent` argument (the calling agent's own id), and each id maps to its own
  `<dataDir>/<agentId>/brain.db`. `SHARPWAVE_AGENTS` (comma list) is an optional
  allowlist. Setting `SHARPWAVE_AGENT_ID` keeps the original single-agent
  behavior unchanged — the `agent` arg becomes optional and, if passed, must
  match. `brain_reset`'s `confirm` must equal the resolved agent id in both
  modes. Working-memory cleanup and the embedding drain run per-agent in
  multi-agent mode; the startup update check is skipped (no single db to stamp).

- **`brain_reset` tool** — `src/reset.ts`. Transactionally wipes every node,
  edge, episode, vector, working-memory row and the self-model for an agent,
  then re-seeds an empty self-model. Takes a timestamped `.db` backup first
  (via `createBackup`). Requires `confirm` to exactly equal the agent's
  `SHARPWAVE_AGENT_ID`. Uses `DELETE FROM` (never `DROP`), so the `nodes_vec`
  dimension (`float[1024]`) and the embedding provider config
  (Ollama → OpenRouter) are untouched — writes and recall work immediately
  after a reset. FTS indexes are force-rebuilt, then `wal_checkpoint(TRUNCATE)`
  + `VACUUM` reclaim disk.

### Fixed

- **`db-backup.ts` was fully non-functional.** Database path came from
  `db.exec("PRAGMA database_list")[0]?.file` — better-sqlite3's `.exec()`
  returns the `Database` object, not rows, so this was always `undefined` and
  every backup threw *"Could not determine database path"*. Now uses `db.name`.
  Also replaced `require("node:fs")` calls that fail under the esbuild ESM
  bundle (*"Dynamic require of node:fs is not supported"*) with static imports.

## [0.3.0] — v0.3.0 audit port

Ports the audit fixes from ClawBrain v0.4.0 (Python `clawbrain.py`) into the
TypeScript codebase. All changes are additive — existing API surface is
preserved.

### Added

- **WAL retry with exponential backoff** — new `src/wal-retry.ts` wraps
  every critical write path (`writeNode`, `touchNode`, `writeEdge`,
  `closeEdge*`, `appendEpisode`, `setMeta`, `updateSelfModelField`,
  `forgetNodeById`) with retry on `SQLITE_BUSY` / `SQLITE_LOCKED`.
  Exponential backoff (100ms → 200ms → 400ms) plus 0–50ms jitter,
  max 3 attempts. Async and sync variants both provided.

- **Embedding LRU cache** — new process-lifetime `Map`-based LRU
  (default 1024 entries, `SHARPWAVE_EMBEDDING_CACHE_MAXSIZE` override)
  wrapping `fetchEmbedding` via `fetchEmbeddingCached`. Re-entrancy
  guard via `cacheBusyKey` prevents duplicate provider calls during
  in-flight fetches for the same text. New `embeddingCacheStats()`
  returns `{size, maxsize, hits, misses}`.

- **MinHash entity resolution** — `src/entity-resolution.ts` was a stub
  (`mergeCoreferentNodes` returned 0). Now ships:
  - `findNearDuplicates(agentId, content, embedding?, threshold, typeFilter?)`:
    embedding cosine fast path, character-trigram Jaccard fallback.
  - `deduplicateExisting(agentId, threshold)`: union-find grouping
    over pairwise Jaccard for offline maintenance.
  - `mergeCoreferentNodes(agentId, log)`: wires `coreference_of` edges
    from duplicates to the oldest canonical node. Idempotent.

  No external dependency — pure-JS character trigram shingling + Jaccard
  (datasketch is Python-only).

- **FTS5 maintenance** — new `maintenance()` public entry point in
  `src/db.ts` runs rebuild + optimize and returns cache stats. The
  private `bumpWriteCounter()` (exported) auto-triggers an `optimize`
  every N writes (default 100, `SHARPWAVE_FTS_OPTIMIZE_EVERY` override).
  Both ops no-op gracefully if FTS tables are missing (sqlite-vec / FTS5
  unavailable on the platform).

- **Observability module** — new `src/observability.ts`:
  - Always-on diagnostic counters: `memories_stored`, `memories_recalled`,
    `memories_forgotten`, `memories_merged`, `embeddings_computed`,
    `embeddings_cached`, `fts_optimizes`, `fts_rebuilds`, `wal_retries`,
    `wal_retry_failures`.
  - Optional JSONL event log at
    `${SHARPWAVE_DATA_DIR}/brain_events.jsonl` when
    `SHARPWAVE_OBSERVABILITY=1`. Default OFF so standard installs stay
    silent.
  - `setLastConsolidationAt()` / `getLastConsolidationAt()` surface
    consolidation freshness.

- **`brain_health` tool** — new MCP tool returning counters, embedding
  cache, FTS state, observability-enabled flag, and last-consolidation
  timestamp. Zero side effects; safe to call repeatedly.

- **Input validation** — new `src/validation.ts`:
  - `validateNonEmptyString(value, field)` — throws on empty/whitespace
  - `clampImportance`, `clampConfidence`, `clampTrait` — number [0, 1]
  - `validateMemoryKind` / `validateDurability` / `validateScope` —
    allowlist check, defaults to `fact` / `long_term` / `private` with a
    stderr warn on invalid

  Wired into all tool handlers that take user-provided IDs/strings:
  `brain_write`, `brain_supersede`, `brain_link`, `brain_review`,
  `brain_expand`, `brain_edges`, `brain_forget`. Also clamps `brain_query`'s
  `limit` to [1, 100].

- **`brain_stats` extended** — now includes an "Observability (v0.4)"
  section with all diagnostic counters inline.

- **Write-node dedupe gate** — `writeNode()` gains an optional
  `deduplicate: boolean` (default true) and `dedupeThreshold: number`
  (default 0.85). When a near-duplicate is found above threshold, the
  canonical node's importance is bumped instead of inserting a duplicate
  row. The SWS path opts out (it already has its own Jaccard pre-check).

### Changed

- **package.json version** — bumped from 0.2.1 to 0.3.0.

### Backwards compatibility

All public API surfaces are preserved. New optional parameters on
`writeNode` default to behavior compatible with v0.2.x. The new
`brain_health` tool is purely additive.

## [0.2.1] — prior release

FSRS-6 spaced-repetition model, FSRS-6 SIGMA per-node calibration,
CLS two-store split (is_consolidated), pattern-separation hash, temporal
validity windows, deterministic REM / SWS / Deep / NEXUS consolidation
phases, hybrid FTS + vector + spreading-activation retrieval.

## [0.1.0] — initial release

Baseline TypeScript port: better-sqlite3 storage, sqlite-vec vector
search, FTS5 keyword search, MCP server with the original 10 tools.
