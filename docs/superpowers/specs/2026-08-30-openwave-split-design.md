# openwave / sharpwave-core split — design

**Status:** draft for review
**Date:** 2026-08-30
**Author:** Claude (with Hailey)
**Supersedes:** the informal "THE BIG ONE" plan in `project-sharpwave` memory

---

## 1. Problem

Marley and the ~29 OpenClaw room agents are using their SharpWave brain as a
write-only scratchpad — they record memories and never read them back unless
explicitly told to, and nothing tells them to.

**Root cause.** ClawBrain v4 was an OpenClaw *plugin* built from two layers:

1. **Engine** — graph DB, FSRS-6 retrievability, spreading activation, sleep-style
   consolidation (SWS/REM), neuromodulator state, self-model.
2. **Autonomic layer** — code wired to OpenClaw lifecycle hooks
   (`session_start`, `before_prompt_build`, `after_compaction`, `agent_turn_prepare`,
   plus in-process timers). Every agent wake, this layer retrieved the relevant
   memories and **injected them into the agent's context automatically**. That is
   what "wakes up knowing" meant.

When SharpWave was extracted as a standalone **MCP server** and the plugin was
retired, **only the engine came across.** An MCP server is call-and-response only —
it *cannot* execute code on agent wake. So the autonomic layer has no host. The
brain still stores data (Marley: 66 nodes / 159 edges, intact at
`~/.sharpwave/main/brain.db`) but nothing surfaces it.

This is not data loss, not a config regression, not caused by the v0.4.0 work.
It is the structural cost of plugin → MCP finally becoming visible.

## 2. Vision (what we are restoring)

Agents that genuinely remember. An agent wakes already knowing who it is, what it
is mid-project on, what the user said recently, and what it keeps getting wrong —
without being asked. A superbrain: biology-inspired, not biology-constrained;
always tuned to advantage. **Built for the OpenClaw agents first.** Cross-platform
MCP reach (Cursor / Claude Code / Claude Desktop) is an additional distribution
lane, never a replacement for the original purpose.

## 3. Goals / non-goals

### Goals

- Restore full autonomic wake-up behavior for OpenClaw agents. **Full port of all
  six autonomic modules — no subset, no stopgap.**
- Keep every engine improvement made since the plugin was retired (multi-agent
  mode, `brain_reset`, db-backup fix, FTS fix, validation, WAL-retry, metrics,
  observability).
- Keep the cross-platform MCP server shipping and unchanged in behavior.
- Make engine drift between consumers *structurally impossible*.
- Restore the unit test suite that was dropped in the MCP split.
- No brain database moves. No agent loses a memory. Clean rollback at every step.

### Non-goals

- Un-retiring or merging back `clawbrain-v4` as a codebase. Its engine is ~1 month
  and 8 modules behind; only its autonomic layer and its tests are harvested.
- Publishing `openwave` to ClawHub in this iteration (local load via
  `plugins.load.paths` is the v1 delivery; ClawHub is a later, separate decision).
- Adding new cognitive features. This is a structural migration; the brain's
  behavior after it should match ClawBrain v4's, on top of sharpwave's engine.
- Relocating `~/.sharpwave/<agentId>/brain.db`, removing/retyping columns, or any
  non-additive schema change. (One *additive* migration — v17: `nodes.inject_count`
  / `nodes.inject_hits` for `valor` — is in scope; see the plan's Global
  Constraints. It backfills 0 on existing brains and is invisible to the MCP
  surface.)

## 4. Target architecture

`Enlightened-Republic/sharpwave` becomes a single npm-workspaces monorepo. The
restructure happens on a branch with `git mv` so file history is preserved.

```
sharpwave/                        (repo root — was the MCP server repo)
  package.json                    workspaces: ["packages/*"], root scripts
  esbuild.shared.mjs              shared bundle config
  docs/
  packages/
    core/                         name: "sharpwave-core"   "private": true
      src/
        index.ts                  PUBLIC API BARREL — the only supported surface
        db.ts nodes.ts edges.ts embeddings.ts retrieval.ts
        consolidation.ts activation.ts episodes.ts self-model.ts
        entity-resolution.ts skill-evolution.ts reset.ts
        db-backup.ts metrics.ts observability.ts resilience.ts
        wal-retry.ts validation.ts update-check.ts types.ts utils.ts
        context-assembly.ts       (ported from clawbrain-v4/bootstrap.ts)
        awake-replay.ts           (ported)
        proactive-monitor.ts      (ported)
        extraction.ts             (ported)
        episode-lanes.ts          (ported)
        valor.ts                  (ported)
        morning.ts                (ported)
        compaction.ts             (ported — decision logic only)
        tools.ts                  unified brain_* tool schema + executors
      test/                       vitest — merged clawbrain-v4 + sharpwave suites
      package.json
    mcp/                          name: "sharpwave"   (npm-published, unchanged)
      src/index.ts                today's sharpwave/src/index.ts, verbatim,
                                   minus the inline tool defs (now from core)
      test/mcp-smoke.mjs          the publish gate — clean-env artifact test
      package.json                deps: "sharpwave-core": "*"
    openwave/                     name: "openwave"   (OpenClaw plugin)
      src/
        index.ts                  plugin shell — ported from clawbrain-v4/index.ts
        bootstrap-delivery.ts     OpenClaw queued-injection drop workaround
        scheduler.ts              in-process timers (replay / consolidation / sweep)
      test/                       vitest — mock-api hook harness
      package.json                deps: "sharpwave-core": "*"
```

Both `mcp` and `openwave` declare `"sharpwave-core": "*"` and
esbuild-**bundle** the compiled core into a single `dist/index.js` at build time
(the pattern both trees already use). `sharpwave-core` is therefore never
published to npm — "private, shared" is literal. A change to the engine is one
commit that both consumers compile against on their next build. There is no
version skew path.

### Hook seams (verified against `openclaw/docs/plugins/hooks.md`, 2026.7.1)

| seam | doc reference | use |
|---|---|---|
| `before_prompt_build` → returns `prependContext` / `appendContext` / `systemPrompt` / `prependSystemContext` / `appendSystemContext` | hooks.md:321-323 | self-model header + recall + bootstrap fallback, every turn |
| `agent_turn_prepare` → consumes queued injections, returns `prependContext` / `appendContext` | hooks.md:102, 318-320 | deliver the queued first-turn bootstrap |
| `heartbeat_prompt_contribution` → returns `prependContext` / `appendContext` | hooks.md:324-325 | self-model header on heartbeat turns |
| `session_start` / `session_end` (`reason` ∈ new/reset/idle/daily/compaction/deleted/shutdown/restart/unknown) | hooks.md:146 | warm bootstrap cache, queue first-turn injection, session cleanup |
| `before_compaction` / `after_compaction` | hooks.md:147 | re-inject after context compaction |
| `api.session.workflow.enqueueNextTurnInjection(...)` (`api.enqueueNextTurnInjection` is a deprecated alias) | hooks.md:483-485, 616 | guaranteed first-turn bootstrap delivery |
| `api.lifecycle.registerRuntimeLifecycle(...)` — cleanup receives `reset` / `delete` / `disable` / `restart` | hooks.md:493, sdk-overview.md:212 | release timers on runtime generation change; only close DB handles on reset/delete/disable |
| `plugins.load.paths` | manage-plugins.md:172, manifest.md:1197 | how openwave is loaded (standalone plugin file, not an installed extension) |
| `before_prompt_build` default hook timeout 90 s | hooks.md:72 | budget headroom for recall's inner async races |

## 5. Module inventory & disposition

### 5.1 Modules that stay in `core` as-is (sharpwave's current versions win)

`db`, `nodes`, `edges`, `embeddings`, `retrieval` (already exports
`hybridRetrieve` **and** `bootstrapRetrieve`), `consolidation` (already exports
`subconsciousTick`, `shouldConsolidate`, `runConsolidation`,
`getNeuromodulatorState`), `activation`, `episodes`, `self-model` (already exports
`formatSelfModelForContext`), `entity-resolution`, `skill-evolution`, `reset`,
`db-backup`, `metrics`, `observability`, `resilience`, `wal-retry`, `validation`,
`update-check`, `types`, `utils`.

clawbrain-v4's copies of these are **reference only** — they show what the
autonomic layer expects; the ported modules are rewired to sharpwave's API.

### 5.2 Modules ported from `clawbrain-v4` into `core`

| source (clawbrain-v4) | lines | new home | notes |
|---|---|---|---|
| `bootstrap.ts` | 343 | `core/src/context-assembly.ts` | `buildBootstrapContext`, `buildRecallContext`, `buildSelfModelHeader`, `buildProceduralContext`, `BRAIN_HEADER`. Rewire onto sharpwave `retrieval` + `self-model` + `episodes`. Per-surface trims (voice vs chat) preserved. |
| `awake_replay.ts` | 309 | `core/src/awake-replay.ts` | `awakeReplayTick`, `recordCoactivations`. |
| `proactive-monitor.ts` | 217 | `core/src/proactive-monitor.ts` | `runProactiveMonitor` — eligibility-trace pre-priming before recall. |
| `extraction.ts` | 414 | `core/src/extraction.ts` | `queueEpisodeForExtraction`, `drainExtractionQueue`. LLM fact extraction; used by both the plugin's session_end/hourly harvest and (future) an MCP background drain. |
| `episode-lanes.ts` | 54 | `core/src/episode-lanes.ts` | `isForegroundLane` — foreground vs heartbeat/cron episode classification. |
| `valor.ts` | 209 | `core/src/valor.ts` | `scoreReplyAgainstInjections` — scores an agent reply against the nodes injected for its last turn. Pure scoring; the injection-tracking record it reads is written by openwave. |
| `morning.ts` | 67 | `core/src/morning.ts` | daily first-wake digest builder. |
| `compaction.ts` | 72 | `core/src/compaction.ts` | `handleCompaction` decision logic (which nodes to re-inject after a compaction). The *hook* that calls it is openwave. |
| `tools.ts` | 608 | `core/src/tools.ts` | The `brain_*` tool schemas + executors. Currently the MCP server has its own inline copies in `index.ts`; unifying here kills tool-surface drift too. Executors take an explicit `agentId` + `config`; no host coupling. **The two consumers expose different subsets** and that stays true: `core/tools.ts` holds the **union** — clawbrain-v4's 15 (`brain_query`, `brain_write`, `brain_link`, `brain_supersede`, `brain_update_self_model`, `brain_reflect`, `brain_stats`, `brain_history`, `brain_expand`, `brain_generate_skill`, `brain_edges`, `brain_workspace`, `brain_docs`, `brain_review`, `brain_forget`) plus `brain_reset` (MCP-only today) = 16 defs. Each consumer picks its list: `mcp` publishes its current 11 (adds `brain_reset`, omits the 5 plugin-only ones); `openwave` registers the full 15 + `brain_reset`. Any drift in a *shared* tool's schema or behavior is now impossible; which tools each surface *offers* is an explicit per-consumer array. |

### 5.3 Modules ported from `clawbrain-v4` into `openwave`

| source (clawbrain-v4) | lines | new home | notes |
|---|---|---|---|
| `index.ts` | 1197 | `openwave/src/index.ts` | The plugin shell. `definePluginEntry` + minimal inlined `OpenClawPluginApi` type (no build-time dep on `openclaw`). All hooks: `gateway_start/stop`, `cron_changed`, `session_start/end`, `agent_turn_prepare`, `before_prompt_build`, `heartbeat_prompt_contribution`, `message_received`, `llm_output`, `agent_end`, `after_compaction`. Every engine call rewired to `sharpwave-core`. The three-layer injection plan (cache → queued injection → before_prompt_build fallback) preserved. The 2026-05-16 lifecycle-cleanup incident fix preserved (restart: release timers only; reset/delete/disable: close DB handles). |
| `bootstrap-delivery.ts` | 53 | `openwave/src/bootstrap-delivery.ts` | `decideBootstrapDelivery` — the workaround for OpenClaw accepting an `enqueueNextTurnInjection` and then not draining it back the same turn. This is the hard-won part; ported intact. |
| (extracted from `index.ts`) | — | `openwave/src/scheduler.ts` | The in-process timers: 30-min `awakeReplayTick`, hourly consolidation gate + extraction harvest, 10-min embedding sweep, plus `removeLegacyCronJobs`. Split into its own module for testability. |

### 5.4 Dropped

`clawbrain-v4/src/mcp-server.ts` — superseded by `packages/mcp`.
`clawbrain-v4/migrate-v3-to-v4.ts` — historical, not carried.

## 6. Package details

### 6.1 `packages/core` (`sharpwave-core`)

- `"private": true`, no `publishConfig`. CI/npm publish must refuse it.
- `src/index.ts` is a **hand-curated barrel**. Consumers import from
  `sharpwave-core` only — deep imports (`sharpwave-core/dist/nodes.js`) are
  unsupported and the barrel is the API contract. Everything a consumer needs:
  - DB: `getDb`, `closeAllDbs`, `getMeta`, `setMeta`, `maintenance`
  - Nodes/edges: `writeNode`, `getNode`, `touchNode`, `writeEdge`, `propagateDopamineSpike`, …
  - Retrieval: `hybridRetrieve`, `bootstrapRetrieve`
  - Episodes: `appendEpisode`, `getEpisodesSince`, `getSessionSummaries`, `searchEpisodes`, `scoreImportance`
  - Consolidation: `subconsciousTick`, `shouldConsolidate`, `runConsolidation`, `getNeuromodulatorState`
  - Embeddings: `queueEmbedding`, `drainEmbeddingQueue`, `sweepMissingEmbeddings`, `clearEmbeddingQueues`
  - Self-model: `getSelfModel`, `updateSelfModelField`, `formatSelfModelForContext`
  - Context assembly: `buildBootstrapContext`, `buildRecallContext`, `buildSelfModelHeader`, `buildProceduralContext`
  - Autonomic: `awakeReplayTick`, `recordCoactivations`, `runProactiveMonitor`, `handleCompaction`, `buildMorningDigest`
  - Extraction: `queueEpisodeForExtraction`, `drainExtractionQueue`
  - Lanes/valor: `isForegroundLane`, `scoreReplyAgainstInjections`
  - Tools: `BRAIN_TOOL_DEFS` (the 16-def union map), `dispatchBrainTool(name, agentId, args, config)`; each consumer builds its own listing from a name array
  - Working memory: `clearWorkingMemory`, `clearStaleWorkingMemory`
  - Config: `DEFAULT_CONFIG`, types
- Build: `tsc` to `dist/` with `.d.ts` (so both consumers get types) **and** an
  esbuild pass is unnecessary here — core is consumed as source-compiled TS by
  the bundlers downstream. Decision: emit `dist/*.js` + `dist/*.d.ts` via `tsc`;
  downstream esbuild treats `sharpwave-core` as a normal resolvable dep and
  inlines it.
- `better-sqlite3` pinned `~12.11.1` (v13 ships no prebuilts — do not bump
  without re-checking prebuild assets). This is a `core` dependency; both
  consumers inherit it transitively.

### 6.2 `packages/mcp` (`sharpwave`)

- `src/index.ts` = today's `sharpwave/src/index.ts` with the inline `TOOLS`
  array and `handle*` functions replaced by `import { BRAIN_TOOLS, dispatchBrainTool } from "sharpwave-core"`.
  Everything else — `resolveAgent`, `toolsForMode` (multi-agent `agent` arg
  injection), stdio transport, `SESSION_ID` minting, the 30 s background embed
  drain, `checkForUpdate` — unchanged.
- `esbuild.mjs` unchanged except it now resolves `sharpwave-core` from the
  workspace. Output still a single `dist/index.js` with a shebang.
- `package.json`: `bin`, `files`, `version` (independent — this package keeps its
  own semver line and npm release cadence), `prepublishOnly: npm run build`.
- **`test:mcp` (`test/mcp-smoke.mjs`) stays the publish gate.** It spawns the
  built `dist/index.js`, speaks MCP over stdio, and exercises every tool in a
  directory with no local ollama. Must pass before any `npm publish`. npm publish
  stays gated on Hailey's explicit go.
- Behavioral contract: a user upgrading `sharpwave` on npm across this change
  sees **no difference**. The MCP smoke test is the proof.

### 6.3 `packages/openwave` (`openwave`)

- Single-file plugin artifact `dist/index.js` (esbuild, `sharpwave-core` +
  `better-sqlite3` externalized or bundled per what the gateway runtime needs —
  clawbrain-v4 bundled everything except native `.node`; match that).
- Default export: `definePluginEntry({ id: "openwave", name, description, register })`.
- Config shape (openclaw.json `plugins.entries.openwave.config`): `{ agents: string[],
  contextBudget, llmExtractionEnabled, llmExtractionMinImportance, ingestionModel,
  openRouterApiKey?, ... }` — same schema clawbrain-v4 used (`BrainConfig`
  subset). Documented in `packages/openwave/README.md`.
- Loaded via `openclaw.json`:
  ```jsonc
  "plugins": {
    "load": { "paths": ["C:/Users/wubbu/Desktop/Projects/sharpwave/packages/openwave/dist/index.js"] },
    "entries": { "openwave": { "enabled": true, "config": { "agents": ["main"] } } }
  }
  ```
- Deploy = `npm run build -w openwave` + `openclaw gateway restart` (full restart,
  not soft reload — bundle changes need a fresh Node ESM cache; documented in
  `reference_clawbrain_v4_agentid_runtime_lookup` memory).

## 7. openwave plugin behavior

Identical to ClawBrain v4's autonomic behavior. Summarized:

1. **`gateway_start`** — open each configured agent's DB, sweep ephemeral working
   memory, remove any legacy cron jobs, arm the three in-process timers
   (`scheduler.ts`), run an initial consolidation-gate check 5 min after boot.
2. **`session_start`** — record session→agent mapping; clear working memory /
   aliases for the session; append a low-importance boundary episode; build the
   bootstrap context (per-surface: tight for `voice:` keys, full for chat); cache
   it; `enqueueNextTurnInjection` it with an idempotency key.
3. **`agent_turn_prepare`** — inspect delivered injections; `decideBootstrapDelivery`
   decides delivered / release-guard / pending; on release-guard, clear the guard
   so `before_prompt_build` injects from cache instead.
4. **`before_prompt_build`** (every turn, skips heartbeat slots) —
   `appendSystemContext` = self-model header (never compacted);
   `prependContext` = [cached bootstrap if queue didn't deliver] + proactive-monitor
   pre-prime + recall block (`buildRecallContext`) + always-on procedural block +
   last-24h foreground activity digest.
5. **`heartbeat_prompt_contribution`** — self-model header only.
6. **`message_received` / `llm_output`** — append episodes with scored importance
   (cron/heartbeat sessions clamped to 0.1); queue for extraction above threshold;
   dopamine spike on importance ≥ 0.8; `llm_output` also runs VALOR scoring.
7. **`agent_end`** — `subconsciousTick`.
8. **`after_compaction`** — boundary episode + `handleCompaction` re-inject.
9. **`session_end`** — extraction harvest, `recordCoactivations`, full session
   cleanup.
10. **Timers** — replay tick (30 min), consolidation gate + extraction harvest
    (hourly, `shouldConsolidate` gates the actual run), embedding sweep (10 min).
11. **`registerRuntimeLifecycle` cleanup** — `restart`: clear timers + in-memory
    caches only. `reset`/`delete`/`disable`: also `closeAllDbs()`; `delete` also
    removes cron jobs.

## 8. Build system

- Root `package.json`: `"workspaces": ["packages/*"]`, `"private": true`.
- Root scripts:
  - `build` → `npm run build -ws --if-present` (core first via workspace ordering,
    then mcp + openwave)
  - `test` → `npm run test -ws --if-present` (core vitest + openwave vitest)
  - `test:mcp` → `npm run test:mcp -w sharpwave`
  - `test:all` → `test` + `test:mcp`
- Node version: match current (`.nvmrc` / `engines` carried from the MCP repo).
- `better-sqlite3` rebuild: `core` owns the dependency; a `postinstall` or the
  documented manual step stays as-is.

## 9. Testing strategy

### 9.1 `core` — restore + merge the unit suite

clawbrain-v4 has ~29 vitest files that sharpwave dropped. Bring them in and
reconcile against sharpwave's API:

- Carry over: `activation`, `awake_replay`, `bootstrap`, `bootstrap-delivery`
  (moves with openwave), `consolidation`, `db`, `edges`, `embeddings`,
  `entity-resolution`, `episode-lanes`, `episodes`, `extraction`, `fsrs6-reference`,
  `nodes`, `procedural-injection`, `retrieval`, `self-model`, `skill-evolution`,
  `utils`, `valor-fsrs`, `rigorous-brain`, `teammate-review`, `concurrency`,
  `brain-review`, `migration-crash-recovery`, `migration-stress`.
- Each ported module lands with its test file, updated to the sharpwave API.
- Target: green `npm run test -w sharpwave-core`, coverage no worse than
  clawbrain-v4's suite reported.

### 9.2 `mcp` — unchanged gate

`test/mcp-smoke.mjs` runs against the freshly built `packages/mcp/dist/index.js`
in a temp dir with no ollama. Every one of the 11 published tools exercised.
This is the regression guarantee for existing npm users.

### 9.3 `openwave` — new hook harness

`packages/openwave/test/` — vitest. A `makeMockApi()` helper returns an `api`
object recording `on(...)` registrations, `registerTool`, `enqueueNextTurnInjection`
calls, and `registerRuntimeLifecycle`. Tests:

- `session_start` builds a bootstrap and calls `enqueueNextTurnInjection` with the
  right idempotency key.
- `agent_turn_prepare` + `before_prompt_build` deliver the bootstrap exactly once
  (no double-injection) across: queue-delivers, queue-drops (release guard),
  cache-miss-rebuild.
- `before_prompt_build` returns a self-model header on `appendSystemContext` every
  turn and skips heartbeat slots.
- `after_compaction` re-injects.
- `message_received` / `llm_output` append episodes with correct importance
  clamping for cron/heartbeat session keys.
- lifecycle `restart` keeps DB handles open; `reset` closes them.
- Timers fire `awakeReplayTick` / consolidation gate / sweep (fake timers).

### 9.4 Live smoke (deploy-gated, not CI)

After build, before rolling to real agents: load openwave for a throwaway agent
id pointed at a scratch brain db, restart the gateway, send one message, confirm
in `openclaw-YYYY-MM-DD.log`:
- `[openwave] {"op":"register","outcome":"ok",...}`
- `session_start.bootstrap outcome:ok chars:<n>`
- `before_prompt_build outcome:ok` with non-zero prepend chars
- `brain_stats` for that agent shows retrieval/inject activity.

## 10. Migration / cutover

**Gated.** The spec documents it; execution is a separate step under the
CLAUDE.md deploy-gate and config-gate, one change at a time, each verified in the
gateway log before the next.

1. **Land the monorepo** on a branch. All three packages build; `test:all` green;
   `test:mcp` green (proves no MCP regression). Merge to `main`. **No live
   change yet** — `openwave` exists but nothing loads it.
2. **Scratch-agent smoke** (§9.4) with a throwaway agent id + scratch db.
3. **Marley first.** Add `openwave` to `plugins.load.paths`, `entries.openwave.config.agents = ["main"]`,
   enabled. The `sharpwave` MCP server entry **stays** in `openclaw.json`. Restart
   gateway. Verify Marley wakes with injected context (log lines + `brain_stats`
   read count climbing over a few sessions).
4. **Widen** to `mila`, `ausil`, then the room agents in batches, updating
   `agents` and watching the log after each batch. The AGENTS.md "## Your
   SharpWave brain" blocks that instruct agents to pass `agent:` are updated to
   describe the plugin (agents no longer call the MCP for routine memory).
5. **Retire the MCP for OpenClaw.** Once every OpenClaw agent is on openwave and
   stable for an agreed bake period, remove the `mcp.servers.sharpwave` entry
   from `openclaw.json`. The `sharpwave` npm package is untouched and continues
   serving external Cursor / Claude Code / Claude Desktop users.
6. **Delete the divergent copy.** `C:\Users\wubbu\sharpwave-airheart\` was a
   hand-maintained MCP deployment for mila/ausil. Once they are openwave agents it
   is dead weight and the drift source we are eliminating — remove it.

Throughout: brain db files at `~/.sharpwave/<agentId>/brain.db` are never moved,
renamed, or schema-migrated. Both the MCP server and openwave read/write the same
files with the same engine code, so an agent can be flipped between them freely.

## 11. Rollback

At any migration step: remove `openwave` from `plugins.load.paths` (or set
`entries.openwave.enabled = false`), ensure the `mcp.servers.sharpwave` entry is
present, restart the gateway. The agent is back on the MCP server against the
same brain db, no data reconciliation needed. Pre-change `openclaw.json` is
backed up to the scratchpad before each edit (standing practice).

## 12. Risks & constraints

- **Engine API drift is real work.** The ported autonomic modules were written
  against clawbrain-v4's engine; sharpwave's differs (e.g. clawbrain
  `clearEphemeralWorkingMemory`/`EPHEMERAL_SESSION_ID` vs sharpwave
  `clearStaleWorkingMemory`; episode/self-model signatures). Every ported module
  is a rewire-and-test, not a copy. Budget for it.
- **`better-sqlite3` native binding** must load inside the gateway's Node
  runtime. clawbrain-v4 did this successfully; match its esbuild externals config
  exactly (`.node` files not bundled).
- **Full gateway restart required** on every openwave bundle change — soft plugin
  reload does not bust the Node ESM cache. Documented; not a blocker.
- **`enqueueNextTurnInjection` non-delivery** is a known OpenClaw quirk;
  `bootstrap-delivery.ts` already handles it. Keep its test.
- **Hook timeout fails open** (`before_prompt_build` 90 s default; plugin sets a
  tighter internal budget). Recall's inner async races must stay under the
  plugin's own budget, matching clawbrain-v4's tuning (2000 ms embed race,
  3500 ms hook budget).
- **Two consumers, one `better-sqlite3`** — fine (separate processes; the MCP
  server and the gateway never open the same db handle simultaneously in
  practice, and SQLite WAL + `wal-retry.ts` covers the edge).

## 13. Open questions

None blocking. Deferred, revisit after v1 ships:

- Whether `openwave` gets published to ClawHub (distribution play for the
  OpenClaw audience) or stays local-load.
- Whether `packages/mcp` grows a `brain_bootstrap` tool that returns assembled
  context, giving Claude Code / Cursor a manual "prime me" call (now cheap
  because context-assembly is in `core`).
- Whether `sharpwave-core` is ever published (would only make sense if a third
  first-party consumer appears).

## 14. Work breakdown (feeds writing-plans)

1. Branch; `git mv src → packages/core/src`; scaffold workspace `package.json`s.
2. `packages/core/src/index.ts` barrel; split current `src/index.ts` into
   `packages/mcp/src/index.ts`.
3. Wire `mcp` to `sharpwave-core`; `test:mcp` green (gate: no regression).
4. Port `tools.ts` into `core`; both consumers use it; `test:mcp` still green.
5. Port cognition modules into `core` one at a time, each with its test file
   rewired: `context-assembly`, `episode-lanes`, `extraction`, `valor`,
   `awake-replay`, `proactive-monitor`, `morning`, `compaction`.
6. Restore/merge the full vitest suite; `npm run test -w sharpwave-core` green.
7. Scaffold `packages/openwave`; port `index.ts` shell rewired to `core`; extract
   `scheduler.ts`; port `bootstrap-delivery.ts`.
8. Build the mock-api hook harness; `npm run test -w openwave` green.
9. `test:all` green; build all three; produce `packages/openwave/dist/index.js`.
10. Scratch-agent live smoke.
11. Merge to `main`. (Migration steps 3–6 of §10 are a separate gated session.)
