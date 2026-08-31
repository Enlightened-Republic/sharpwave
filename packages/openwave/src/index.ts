// packages/openwave/src/index.ts
//
// openwave — the OpenClaw plugin shell.
//
// Ported from `clawbrain-v4/src/index.ts` (1197 lines) onto `sharpwave-core`.
// Everything that made ClawBrain v4's wake-up layer work is preserved: the
// 3-layer bootstrap injection, the per-surface (voice/chat) trims, the
// 2026-05-16 lifecycle split, the in-process sleep-system timers, the memory
// adapters. The only structural change is that every engine call now goes
// through the `sharpwave-core` barrel instead of sibling-relative imports.
//
// Task 8 extracts the in-process timers into `scheduler.ts`; they are inline
// and working here on purpose.

import { randomUUID } from "node:crypto";

import * as core from "sharpwave-core";
import {
  BRAIN_TOOL_DEFS,
  OPENWAVE_TOOL_NAMES,
  dispatchBrainTool,
} from "sharpwave-core";
import { decideBootstrapDelivery, bootstrapIdempotencyKey } from "./bootstrap-delivery.js";
import {
  armSchedulers,
  disarmSchedulers,
  harvestExtraction,
  type SchedulerHandles,
} from "./scheduler.js";

// ─── Config ────────────────────────────────────────────────────────────────────
//
// `sharpwave-core`'s BrainConfig has no `enabled` / `agents` — those are host
// concerns (the MCP server pins one agent per process; openwave serves many).
// They stay in openwave's own config type rather than being pushed into core.

type OpenwaveConfig = core.BrainConfig & {
  enabled: boolean;
  agents: string[];
};

const DEFAULT_OPENWAVE_CONFIG: OpenwaveConfig = {
  ...core.DEFAULT_CONFIG,
  enabled: true,
  agents: ["main"],
};

// ─── Plugin entry point ────────────────────────────────────────────────────────
// OpenClaw's loader recognizes either:
//   (a) a default-export object with { id, name, description, register, configSchema }, OR
//   (b) a default-export `register(api)` function (legacy).
// We use (a) via the `definePluginEntry` helper inlined below so we don't take
// a dependency on the openclaw package at build time. The returned object has
// the same shape openclaw/plugin-sdk/plugin-entry produces (audit/openclaw.md §1).

// Minimal inlined `definePluginEntry` (matches openclaw 2026.5.x signature).
// We intentionally avoid `import "openclaw/plugin-sdk/plugin-entry"` because the
// `openclaw` package is not a runtime dependency of this plugin — esbuild would
// have to bundle it. The returned default-export value is both:
//   1. A callable function `(api) => register(api)` — backward-compat with the
//      legacy `OpenClawPluginModule = (api) => void` form used by older test
//      harnesses and gateway versions < 2026.5.
//   2. An object with `{ id, name, description, configSchema, register }` —
//      the modern `definePluginEntry` shape used by 2026.5+ loaders.
// The gateway accepts either form (audit/openclaw.md §1).
type DefinedPluginEntry = ((api: OpenClawPluginApi) => void) & {
  id: string;
  name: string;
  description: string;
  configSchema: { validate: (v: unknown) => { ok: true; value?: unknown } | { ok: false; errors: string[] } };
  register: (api: OpenClawPluginApi) => void;
};

function definePluginEntry(opts: {
  id: string;
  name: string;
  description: string;
  register: (api: OpenClawPluginApi) => void;
}): DefinedPluginEntry {
  const callable = ((api: OpenClawPluginApi) => opts.register(api)) as DefinedPluginEntry;
  // `Function.prototype.name` is read-only by default — must use defineProperty.
  Object.defineProperty(callable, "id", { value: opts.id, writable: false, enumerable: true });
  Object.defineProperty(callable, "name", { value: opts.name, writable: false, configurable: true });
  Object.defineProperty(callable, "description", { value: opts.description, writable: false, enumerable: true });
  Object.defineProperty(callable, "configSchema", { value: { validate: () => ({ ok: true }) }, writable: false, enumerable: true });
  Object.defineProperty(callable, "register", { value: opts.register, writable: false, enumerable: true });
  return callable;
}

// Minimal API type — the gateway provides a much wider surface but we only
// pull in what openwave uses. This keeps us decoupled from openclaw types.
type OpenClawPluginApi = {
  pluginConfig?: Record<string, unknown>;
  logger?: { debug?: (msg: string) => void; info: (msg: string) => void; warn: (msg: string) => void; error?: (msg: string) => void };
  runtime?: { cron?: CronService };
  session: {
    workflow: {
      enqueueNextTurnInjection: (injection: {
        sessionKey: string;
        text: string;
        idempotencyKey?: string;
        placement?: "prepend_context" | "append_context";
        ttlMs?: number;
        metadata?: unknown;
      }) => Promise<{ enqueued: boolean; id: string; sessionKey: string }>;
    };
    state?: {
      registerSessionExtension?: (registration: unknown) => void;
    };
    controls?: {
      registerControlUiDescriptor?: (descriptor: unknown) => void;
      registerSessionAction?: (action: unknown) => void;
    };
  };
  lifecycle: {
    registerRuntimeLifecycle: (lifecycle: {
      id: string;
      description?: string;
      cleanup?: (ctx: { reason: string; sessionKey?: string; runId?: string }) => void | Promise<void>;
    }) => void;
  };
  agent?: {
    events?: {
      registerAgentEventSubscription?: (sub: unknown) => void;
      emitAgentEvent?: (params: unknown) => unknown;
    };
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  registerTool: (tool: any) => void;
  registerMemoryEmbeddingProvider?: (adapter: {
    id: string;
    defaultModel?: string;
    transport?: "local" | "remote";
    autoSelectPriority?: number;
    create: (options: unknown) => Promise<{ provider: null | unknown; runtime?: unknown }>;
  }) => void;
  registerMemoryPromptSupplement?: (builder: (params: { availableTools: Set<string>; citationsMode?: string }) => string[]) => void;
  registerMemoryCorpusSupplement?: (supplement: {
    search: (params: { query: string; maxResults?: number; agentSessionKey?: string }) => Promise<Array<{
      corpus: string; path: string; title?: string; kind?: string; score: number; snippet: string; id?: string;
    }>>;
    get: (params: { lookup: string; fromLine?: number; lineCount?: number; agentSessionKey?: string }) => Promise<unknown>;
  }) => void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on: (hookName: string, handler: (event: any, ctx: any) => unknown, opts?: { priority?: number; timeoutMs?: number }) => void;
};

// ── Module-level state ─────────────────────────────────────────────────────────

// Bounded caches for bootstrap context plumbing. Both have:
//   - LRU eviction at MAX_CACHE_ENTRIES (Tier-3 T3.4)
//   - 24h TTL (purges orphaned sessions on read)
const MAX_CACHE_ENTRIES = 256;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const bootstrapCache = new core.BoundedTtlMap<string>(MAX_CACHE_ENTRIES, CACHE_TTL_MS);
const bootstrapInjected = new core.BoundedTtlSet(MAX_CACHE_ENTRIES, CACHE_TTL_MS);
// Layer-2 dedup set: tracks sessionIds where enqueueNextTurnInjection has
// queued the bootstrap. Drained by before_prompt_build on turn 1 to prevent
// double-injection (queue delivery + cache fallback both firing).
const queuedSessions = new core.BoundedTtlSet(MAX_CACHE_ENTRIES, CACHE_TTL_MS);
// Tracks sessions this runtime generation has seen, so lifecycle cleanup can
// drop their per-session state.
const knownSessions = new Set<string>();

// Tool-routing fix (ported from clawbrain-v4/src/tools.ts::sessionAgentMap,
// 2026-05-21). brain_* tool calls arrive with a UUID-only `ctx.sessionKey` and
// no `ctx.agentId`, so `agentIdFromKey` would silently route every one of them
// to `config.agents[0]`. Hooks DO carry the agent, so they record the mapping
// here and `resolveAgentId` consults it before falling back.
//
// This lives in openwave rather than core: core's `dispatchBrainTool` takes an
// ALREADY-RESOLVED agentId — agent resolution is a transport concern.
const sessionAgentMap = new core.BoundedTtlMap<string>(MAX_CACHE_ENTRIES, CACHE_TTL_MS);

function recordSessionAgent(sessionId: string | undefined, agentId: string): void {
  if (!sessionId) return;
  sessionAgentMap.set(sessionId, agentId);
}

function clearSessionAgent(sessionId: string | undefined): void {
  if (!sessionId) return;
  sessionAgentMap.delete(sessionId);
}

// Ephemeral working-memory bucket (ported from clawbrain-v4/src/activation.ts).
//
// Session id used when a caller reaches retrieval without a host-supplied
// session key (memory-corpus supplement). Fixed literals made every such call
// share one working-memory bucket that no session_start ever cleared, so
// retrieved nodes were replayed into unrelated later calls indefinitely.
// Minted once per gateway process and prefixed so gateway_start can sweep
// buckets left behind by earlier processes.
//
// sharpwave-core has no ephemeral-session concept (its `clearStaleWorkingMemory`
// drops EVERY working_memory row, which would wipe live sessions that legitimately
// straddle a gateway restart), so the prefixed sweep stays here.
const EPHEMERAL_SESSION_PREFIX = "ephemeral:";
const EPHEMERAL_SESSION_ID = `${EPHEMERAL_SESSION_PREFIX}${randomUUID()}`;

function clearEphemeralWorkingMemory(agentId: string): number {
  const db = core.getDb(agentId);
  return db
    .prepare("DELETE FROM working_memory WHERE session_id LIKE ?")
    .run(`${EPHEMERAL_SESSION_PREFIX}%`).changes;
}

// Rich Output Protocol directive stripper (ported from clawbrain-v4/src/utils.ts).
// These are routing instructions for the channel layer, not speech. Storing them
// let SWS mint them into recallable nodes that the brain then injected back as
// live instructions — one such node had been injected 44 times.
function stripControlDirectives(text: string): string {
  return text
    // paired blocks: drop the wrapper, keep the spoken content
    .replace(/\[\[tts:text\]\]([\s\S]*?)\[\[\/tts:text\]\]/g, "$1")
    // standalone directives
    .replace(/\[\[reply_to_current\]\]/g, "")
    .replace(/\[\[reply_to:[^\]]*\]\]/g, "")
    .replace(/\[\[\/?tts:[^\]]*\]\]/g, "")
    .trim();
}

// Legacy cron job ids from the pre-2026-07-12 wiring. The sleep system now
// runs on in-process timers (see gateway_start); these ids are kept ONLY so
// startup/teardown can remove stale jobs left in the gateway cron store.
// (Fable-5 audit F-1: the old cron payloads never invoked runConsolidation /
// awakeReplayTick — they burned a nightly LLM turn for nothing.)
const CRON_JOB_IDS = {
  sws: "clawbrain-v4:sws",
  rem: "clawbrain-v4:rem",
  awakeReplay: "clawbrain-v4:awake-replay",
};

// In-process sleep-system timers (awake-replay 30m, consolidation gate 60m,
// embedding sweep 10m + a one-shot post-boot consolidation kick). Armed in
// gateway_start, released in gateway_stop and on every lifecycle cleanup reason
// (the timers belong to the old runtime generation regardless of reason).
// Module-level so gateway_stop and the lifecycle handler can both reach it.
let schedulerHandles: SchedulerHandles | null = null;

// ── Structured logger helper (Tier 3 T3.8) ─────────────────────────────────────
type StructuredFields = Record<string, string | number | boolean | undefined>;
function logFields(fields: StructuredFields): string {
  const filtered: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) filtered[k] = v;
  }
  return `[openwave] ${JSON.stringify(filtered)}`;
}

// ── Agent ID resolution ────────────────────────────────────────────────────────
// core.agentIdFromKey is the last resort. resolveAgentId wraps it with the
// standard event/hookCtx fallback chain used by every hook handler, plus the
// session→agent map that keeps UUID-only tool calls on the right brain.db.

function resolveAgentId(event: unknown, hookCtx: unknown, configAgents: string[]): string {
  const e = event as { agentId?: string; sessionKey?: string; sessionId?: string } | undefined;
  const c = hookCtx as { agentId?: string; sessionKey?: string; sessionId?: string } | undefined;
  if (c?.agentId) return c.agentId;
  if (e?.agentId) return e.agentId;
  for (const candidate of [c?.sessionId, c?.sessionKey, e?.sessionId, e?.sessionKey]) {
    if (!candidate) continue;
    const mapped = sessionAgentMap.get(candidate);
    if (mapped) return mapped;
  }
  const key = e?.sessionKey ?? c?.sessionKey ?? "";
  return core.agentIdFromKey(key, configAgents);
}

// ── Cron job registration helper ───────────────────────────────────────────────
// Typed alias mirrors openclaw's PluginHookGatewayCronService surface.
type CronService = {
  list: (opts?: { includeDisabled?: boolean }) => Promise<Array<{ id?: string; name?: string }>>;
  add: (input: {
    name: string;
    description: string;
    enabled: boolean;
    schedule: { kind: string; expr: string; tz?: string };
    sessionTarget: string;
    wakeMode: string;
    payload:
      | { kind: "systemEvent"; text: string }
      | { kind: "agentTurn"; message: string; model?: string };
  }) => Promise<unknown>;
  update: (id: string, patch: Record<string, unknown>) => Promise<unknown>;
  remove: (id: string) => Promise<{ removed?: boolean }>;
};

// Remove the legacy SWS/REM/awake-replay cron jobs from the gateway store.
// Idempotent — jobs may be registered under their id OR name depending on the
// gateway version that created them, so we sweep both.
async function removeLegacyCronJobs(
  cron: CronService,
  log: { info: (m: string) => void; warn: (m: string) => void },
): Promise<void> {
  try {
    const existing = await cron.list({ includeDisabled: true });
    const legacyNames = new Set<string>(Object.values(CRON_JOB_IDS));
    for (const job of existing) {
      const matches = (job?.id && legacyNames.has(job.id)) || (job?.name && legacyNames.has(job.name));
      if (!matches) continue;
      try {
        await cron.remove(job.id ?? job.name!);
        log.info(logFields({ op: "cron.remove_legacy", outcome: "ok", jobName: job.name ?? job.id }));
      } catch (err) {
        log.warn(logFields({ op: "cron.remove_legacy", outcome: "error", jobName: job.name ?? job.id, error: String(err) }));
      }
    }
  } catch (err) {
    log.warn(logFields({ op: "cron.remove_legacy", outcome: "error", error: String(err) }));
  }
}

// ── Plugin entry ───────────────────────────────────────────────────────────────

export default definePluginEntry({
  id: "openwave",
  name: "openwave",
  description:
    "Autonomic wake-up memory for OpenClaw agents. Injects identity, goals and query-relevant recall into every turn, and runs the sleep system (consolidation, awake replay, extraction) in-process. Powered by sharpwave-core.",
  register(api: OpenClawPluginApi): void {
    // openclaw.json structure: { enabled, hooks, config: { agents, contextBudget, ... } }
    const rawPluginConfig = (api.pluginConfig as Record<string, unknown>) ?? {};
    const brainSettings = (rawPluginConfig.config as Partial<OpenwaveConfig>) ?? (rawPluginConfig as Partial<OpenwaveConfig>);
    const config: OpenwaveConfig = {
      ...DEFAULT_OPENWAVE_CONFIG,
      ...brainSettings,
      enabled: rawPluginConfig.enabled !== false,
    };
    const baseLog = api.logger ?? { info: () => {}, warn: () => {}, error: () => {} };
    const log: { info: (msg: string) => void; warn: (msg: string) => void; error: (msg: string) => void; debug?: (msg: string) => void } = {
      info: (m) => baseLog.info(m),
      warn: (m) => baseLog.warn(m),
      error: (m) => (baseLog.error ?? baseLog.warn)(m),
      debug: baseLog.debug?.bind(baseLog),
    };

    if (!config.enabled) {
      log.info(logFields({ op: "register", outcome: "disabled" }));
      return;
    }

    // ─── Tools (16) ─────────────────────────────────────────────────────────────
    // Definitions and executors both come from core's unified tool module, so
    // openwave and the MCP server can never drift. Agent resolution stays here
    // (it is a transport concern); `"openwave"` is the provenance stamped on
    // nodes written through brain_write / brain_supersede.
    const tools = OPENWAVE_TOOL_NAMES.map((name) => ({
      name,
      description: BRAIN_TOOL_DEFS[name]!.description,
      parameters: BRAIN_TOOL_DEFS[name]!.inputSchema,
      execute: (args: Record<string, unknown> | undefined, ctx: unknown) =>
        dispatchBrainTool(
          name,
          resolveAgentId(args, ctx, config.agents),
          args ?? {},
          config,
          "openwave",
        ).then((r) => r.text),
    }));

    for (const tool of tools) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      api.registerTool(tool as any);
    }

    // ─── Memory adapters (additive — does NOT register exclusive memory capability) ───────
    //
    // openwave coexists with lossless-claw / memory-core. We register prompt &
    // corpus supplements (additive) plus embedding providers (multi-provider
    // safe). We do NOT call registerMemoryCapability (exclusive slot).

    try {
      // Embedding adapters: primary local Ollama qwen3-embedding:0.6b (1024-dim),
      // fallback openrouter deepseek-v4-flash. The schema dim is 1024 per v15.
      api.registerMemoryEmbeddingProvider?.({
        id: "ollama-qwen3",
        defaultModel: "qwen3-embedding:0.6b",
        transport: "local",
        autoSelectPriority: 100,
        create: async () => ({ provider: null }),
      });
      api.registerMemoryEmbeddingProvider?.({
        id: "openrouter-deepseek-flash",
        defaultModel: "openrouter/deepseek/deepseek-v4-flash",
        transport: "remote",
        autoSelectPriority: 50,
        create: async () => ({ provider: null }),
      });
    } catch (err) {
      log.warn(logFields({ op: "registerMemoryEmbeddingProvider", outcome: "error", error: String(err) }));
    }

    try {
      api.registerMemoryPromptSupplement?.(() => {
        // Lightweight additive prompt — the bulk of memory comes through
        // the appendSystemContext / prependContext channels we own.
        return ["[openwave] graph memory active — call brain_query/brain_history for deep recall."];
      });
    } catch (err) {
      log.warn(logFields({ op: "registerMemoryPromptSupplement", outcome: "error", error: String(err) }));
    }

    try {
      api.registerMemoryCorpusSupplement?.({
        async search(params: { query: string; maxResults?: number; agentSessionKey?: string }) {
          // Defer to existing FTS+vector retrieval as a thin adapter.
          // agentId is declared outside the try so the catch can log it —
          // referencing a try-scoped binding from the catch was a runtime
          // ReferenceError (esbuild does not typecheck).
          let agentId = "";
          try {
            agentId = core.agentIdFromKey(params.agentSessionKey ?? "", config.agents);
            const limit = params.maxResults ?? 5;
            const results = await core.hybridRetrieve(
              agentId,
              params.query,
              params.agentSessionKey ?? EPHEMERAL_SESSION_ID,
              config,
            );
            return results.slice(0, limit).map((n) => ({
              corpus: "openwave",
              path: `node:${n.id}`,
              title: n.label,
              kind: n.type,
              score: n.activation,
              snippet: n.content.slice(0, 300),
              id: n.id,
            }));
          } catch (err) {
            log.warn(logFields({ op: "memoryCorpusSupplement.search", outcome: "error", agentId, error: String(err) }));
            return [];
          }
        },
        async get(_params: { lookup: string; fromLine?: number; lineCount?: number; agentSessionKey?: string }) {
          return null;
        },
      });
    } catch (err) {
      log.warn(logFields({ op: "registerMemoryCorpusSupplement", outcome: "error", error: String(err) }));
    }

    // ─── Lifecycle (registerRuntimeLifecycle T2.4) ─────────────────────────────
    //
    // Per openclaw docs/plugins/hooks.md "Session extensions and next-turn
    // injections":
    //   "Cleanup semantics are part of the contract. Session extension cleanup
    //    and runtime lifecycle cleanup callbacks receive `reset`, `delete`,
    //    `disable`, or `restart`. The host removes the owning plugin's
    //    persistent session extension state and pending next-turn injections
    //    for reset/delete/disable; **restart keeps durable session state while
    //    cleanup callbacks let plugins release scheduler jobs, run context,
    //    and other out-of-band resources for the old runtime generation.**"
    //
    // Per docs/automation/cron-jobs.md "Runtime cleanup":
    //   "For isolated jobs, runtime teardown now includes best-effort browser
    //    cleanup for that cron session." Translation: every isolated cron run,
    //    isolated heartbeat run, and subagent run spins up its OWN plugin
    //    runtime generation (register → run hooks → cleanup with reason
    //    `restart`). With a lead-responder agent + nightly cron + 20-30 minute
    //    heartbeats across several agents, this produces ~30 s
    //    lifecycle.cleanup(restart) cycles in the gateway log. That's
    //    GATEWAY-DRIVEN BEHAVIOR — not a plugin bug — and it's harmless so
    //    long as restart cleanup keeps DB handles open (see split below).
    //
    // 2026-05-16 incident: the first version of this handler closed DB
    // handles on every reason. Combined with the per-cron-run restart
    // cadence, that broke in-flight async work owned by the old generation
    // (drainEmbeddingQueue, subconsciousTick) with:
    //   17:43 drainEmbeddingQueue.batch error: "The database connection is not open"  (59 s)
    //   17:58–18:00  three lifecycle.cleanup{reason:"restart"} cycles in 46 s
    //
    // Fix: on `restart`, only release out-of-band resources (the sweep
    // interval and in-memory queues — the new generation gets a fresh
    // module-level Map anyway). DO NOT close DB handles; the new generation
    // will reopen them lazily via getDb() and the file is unaffected.
    //
    // On `reset`/`delete`/`disable`, the old aggressive cleanup is correct:
    // those reasons explicitly tear down durable plugin state, so closing DB
    // handles is the right thing.
    try {
      api.lifecycle.registerRuntimeLifecycle({
        id: "openwave",
        description: "openwave host-state cleanup",
        cleanup: async (ctx: { reason: string; sessionKey?: string; runId?: string }) => {
          const reason = ctx.reason;
          log.info(logFields({ op: "lifecycle.cleanup", outcome: "start", reason }));

          // Always: release the out-of-band timers. This is the primary thing
          // `restart` cleanup is for — clearing scheduler jobs owned by the old
          // runtime generation so the new one can install its own. The timers
          // belong to the old generation regardless of reason.
          disarmSchedulers(schedulerHandles);
          schedulerHandles = null;

          // Always: clear in-memory caches that belong to this module
          // instance. These are per-process Maps/Sets; the new generation
          // gets fresh ones from its own module load, so dropping ours is a
          // no-op for durable state.
          bootstrapCache.clear();
          bootstrapInjected.clear();
          queuedSessions.clear();
          knownSessions.clear();
          sessionAgentMap.clear();
          core.clearPendingInjections();
          core.clearEmbeddingQueues();

          // reset/delete/disable only: tear down durable state. `restart`
          // explicitly keeps durable session state per the docs above and
          // closing DB handles here breaks any concurrent op the old
          // generation has in flight (e.g. drainEmbeddingQueue mid-batch).
          if (reason === "reset" || reason === "delete" || reason === "disable") {
            if (reason === "delete") {
              // Remove the legacy cron jobs so a reinstall doesn't leave them.
              const cron = api.runtime?.cron as CronService | undefined;
              if (cron) {
                for (const id of Object.values(CRON_JOB_IDS)) {
                  try { await cron.remove(id); } catch { /* ignore */ }
                }
              }
              // Archive intent: the actual brain.db archival is operator-
              // managed (deploy gate). We close handles so the file isn't
              // held open while the operator archives.
            }
            core.closeAllDbs();
          }

          log.info(logFields({ op: "lifecycle.cleanup", outcome: "ok", reason }));
        },
      });
    } catch (err) {
      log.warn(logFields({ op: "registerRuntimeLifecycle", outcome: "error", error: String(err) }));
    }

    // Extraction harvest (shared: session_end + the hourly sleep-system tick)
    // now lives in scheduler.ts as `harvestExtraction(agentId, opPrefix, config,
    // log)`. session_end calls it directly; the scheduler drives the hourly run.

    // ─── Hooks ────────────────────────────────────────────────────────────────

    // gateway_start: init DBs, remove legacy cron jobs, arm the in-process
    // sleep-system timers (scheduler.ts).
    api.on("gateway_start", async (_event: unknown, ctx: { getCron?: () => CronService | undefined }) => {
      const t0 = Date.now();
      log.info(logFields({ op: "gateway_start", outcome: "start" }));

      for (const agentId of config.agents) {
        try {
          core.getDb(agentId);
          // Ephemeral working-memory buckets belong to a process that is gone.
          // Sweeping them stops sessionless retrievals from replaying nodes
          // across gateway restarts.
          const swept = clearEphemeralWorkingMemory(agentId);
          log.info(logFields({ agentId, op: "db.init", outcome: "ok", sweptEphemeralWm: swept }));
        } catch (err) {
          log.error(logFields({ agentId, op: "db.init", outcome: "error", error: String(err) }));
        }
      }

      // ─── Sleep system (Fable-5 audit F-1 / Phase 2a) ──────────────────────
      // The old wiring registered SWS/REM as nightly isolated agent turns whose
      // message was "Call brain_stats, then exit" — brain_stats is read-only, so
      // runConsolidation() was NEVER invoked in production. Awake-replay was a
      // systemEvent whose text no handler matched. Replaced with in-process
      // timers (scheduler.ts): no LLM turn needed — SWS/NEXUS/prune are pure
      // sqlite, and REM's generative half calls OpenRouter directly. Legacy
      // cron jobs are removed so they stop burning a nightly agent turn.
      try {
        const cron = ctx?.getCron?.();
        if (cron) {
          await removeLegacyCronJobs(cron, log);
        }
      } catch (err) {
        log.warn(logFields({ op: "cron.remove_legacy", outcome: "error", error: String(err) }));
      }

      // Arm the in-process sleep-system timers (awake-replay 30m, consolidation
      // gate 60m, embedding sweep 10m + a one-shot post-boot consolidation kick
      // at +5m). Held at module level so gateway_stop and lifecycle cleanup can
      // release them for the old runtime generation.
      disarmSchedulers(schedulerHandles);
      schedulerHandles = armSchedulers(config.agents, config, log);

      log.info(logFields({ op: "gateway_start", outcome: "ready", durationMs: Date.now() - t0 }));
    });

    // gateway_stop
    api.on("gateway_stop", async () => {
      const t0 = Date.now();
      disarmSchedulers(schedulerHandles);
      schedulerHandles = null;
      // Clear in-memory queues so a fast restart doesn't replay stale state
      core.clearEmbeddingQueues();
      core.clearPendingInjections();
      core.closeAllDbs();
      log.info(logFields({ op: "gateway_stop", outcome: "ok", durationMs: Date.now() - t0 }));
    });

    // cron_changed: observer that logs job state.
    api.on("cron_changed", async (event: {
      action?: string;
      jobId?: string;
      status?: string;
      error?: string;
      summary?: string;
      durationMs?: number;
      nextRunAtMs?: number;
    }) => {
      const isOurs =
        event.jobId === CRON_JOB_IDS.sws ||
        event.jobId === CRON_JOB_IDS.rem ||
        event.jobId === CRON_JOB_IDS.awakeReplay;
      if (!isOurs) return;

      log.info(
        logFields({
          op: "cron_changed",
          outcome: event.status ?? event.action ?? "unknown",
          jobName: event.jobId,
          durationMs: event.durationMs,
          nextRunAtMs: event.nextRunAtMs,
          error: event.error,
        }),
      );
    });

    // session_start: warm bootstrap cache + queue first-turn injection (T2.2 Layer 2)
    api.on("session_start", async (event: { sessionId?: string; sessionKey?: string; agentId?: string }, hookCtx: { agentId?: string; sessionKey?: string; sessionId?: string }) => {
      const t0 = Date.now();
      const agentId = resolveAgentId(event, hookCtx, config.agents);
      if (!config.agents.includes(agentId)) return;

      const sessionId = event?.sessionId ?? hookCtx?.sessionId ?? "";
      const sessionKey = event?.sessionKey ?? hookCtx?.sessionKey ?? "";

      // Tool-routing fix (2026-05-21): record sessionKey/sessionId → agentId so
      // subsequent brain_* tool calls with a UUID-only ctx.sessionKey can
      // resolve to the right agent's brain.db (see sessionAgentMap).
      recordSessionAgent(sessionId, agentId);
      recordSessionAgent(sessionKey, agentId);

      if (bootstrapCache.has(sessionId)) return;

      core.clearWorkingMemory(agentId, sessionId);
      knownSessions.add(sessionId);

      try {
        core.appendEpisode(agentId, sessionKey, "tool", `[session start: ${sessionKey}]`, 0.1);
      } catch (err) {
        log.warn(logFields({ agentId, sessionId, op: "session_start.episode", outcome: "error", error: String(err) }));
      }

      // Per-surface bootstrap: voice sessions (sessionKey starts with "voice:")
      // get a tight ~6KB bootstrap so phone latency stays under Vapi's ~22s
      // turn ceiling. Chat sessions get the full bootstrap unchanged.
      const surface: core.Surface = sessionKey.startsWith("voice:") ? "voice" : "chat";
      let ctx = "";
      try {
        ctx = await core.buildBootstrapContext(agentId, sessionId, config, log, surface);
        bootstrapCache.set(sessionId, ctx);
        log.info(logFields({ agentId, sessionId, op: "session_start.bootstrap", outcome: "ok", chars: ctx.length, surface, durationMs: Date.now() - t0 }));
      } catch (err) {
        log.warn(logFields({ agentId, sessionId, op: "session_start.bootstrap", outcome: "error", error: String(err) }));
      }

      // Layer 2: queue full bootstrap for guaranteed delivery via
      // agent_turn_prepare on turn 1.
      if (ctx && sessionKey) {
        try {
          await api.session.workflow.enqueueNextTurnInjection({
            sessionKey,
            text: ctx,
            placement: "prepend_context",
            idempotencyKey: bootstrapIdempotencyKey(sessionId),
          });
          queuedSessions.add(sessionId);
          log.info(logFields({ agentId, sessionId, op: "enqueueNextTurnInjection", outcome: "ok" }));
        } catch (err) {
          log.warn(logFields({ agentId, sessionId, op: "enqueueNextTurnInjection", outcome: "error", error: String(err), note: "will inject from cache" }));
        }
      }
    }, { priority: 0, timeoutMs: 1500 });

    // session_end
    api.on("session_end", async (event: { sessionId?: string; sessionKey?: string }, hookCtx: { agentId?: string; sessionKey?: string; sessionId?: string }) => {
      const t0 = Date.now();
      const agentId = resolveAgentId(event, hookCtx, config.agents);
      if (!config.agents.includes(agentId)) return;

      const sessionId = event?.sessionId ?? hookCtx?.sessionId ?? "";
      const sessionKey = event?.sessionKey ?? hookCtx?.sessionKey ?? "";

      try {
        core.appendEpisode(agentId, sessionKey, "tool", `[session end: ${sessionKey}]`, 0.1);
      } catch (err) {
        log.warn(logFields({ agentId, sessionId, op: "session_end.episode", outcome: "error", error: String(err) }));
      }

      try {
        await harvestExtraction(agentId, "session_end", config, log);
      } catch (err) {
        log.warn(logFields({ agentId, sessionId, op: "session_end.extraction", outcome: "error", error: String(err) }));
      }

      try {
        core.recordCoactivations(agentId, sessionId);
      } catch (err) {
        log.warn(logFields({ agentId, sessionId, op: "session_end.coactivations", outcome: "error", error: String(err) }));
      }

      knownSessions.delete(sessionId);
      core.clearWorkingMemory(agentId, sessionId);
      bootstrapCache.delete(sessionId);
      bootstrapInjected.delete(sessionId);
      queuedSessions.delete(sessionId);
      clearSessionAgent(sessionId);
      clearSessionAgent(sessionKey);

      log.info(logFields({ agentId, sessionId, op: "session_end", outcome: "ok", durationMs: Date.now() - t0 }));
    });

    // agent_turn_prepare: runs BEFORE before_prompt_build, drains queued
    // injections. Layer 2 of the 3-layer plan is delivered here automatically
    // by the gateway. We use this hook only to log delivery and to flip
    // bootstrapInjected so before_prompt_build doesn't re-inject from cache.
    api.on("agent_turn_prepare", async (event: { queuedInjections?: Array<{ idempotencyKey?: string }> }, hookCtx: { agentId?: string; sessionKey?: string; sessionId?: string }) => {
      const agentId = resolveAgentId(undefined, hookCtx, config.agents);
      if (!config.agents.includes(agentId)) return;

      const sessionId = hookCtx?.sessionId ?? "";
      recordSessionAgent(sessionId, agentId);
      recordSessionAgent(hookCtx?.sessionKey, agentId);
      const queued = event?.queuedInjections ?? [];
      const decision = decideBootstrapDelivery({
        sessionId,
        wasQueued: queuedSessions.has(sessionId),
        deliveredKeys: queued.map((inj) => inj.idempotencyKey),
      });

      if (decision === "delivered") {
        queuedSessions.delete(sessionId);
        bootstrapInjected.add(sessionId);
        bootstrapCache.delete(sessionId);
        log.info(logFields({ agentId, sessionId, op: "agent_turn_prepare.bootstrap_delivered", outcome: "ok" }));
      } else if (decision === "release_guard") {
        // The host accepted our enqueue but did not drain it back to us this
        // turn (measured 2026-07-30: enqueue ok, then queuedCount=0 two minutes
        // later in the same process). Release the guard so before_prompt_build
        // injects the cached bootstrap instead of skipping on the assumption
        // that the queue already delivered it. See bootstrap-delivery.ts.
        queuedSessions.delete(sessionId);
        log.warn(logFields({
          agentId,
          sessionId,
          sessionKey: hookCtx?.sessionKey ?? "",
          op: "agent_turn_prepare.bootstrap_not_delivered",
          outcome: "ok",
          queuedCount: queued.length,
          note: "queue did not deliver; falling back to cached bootstrap",
        }));
      }
    }, { priority: 0, timeoutMs: 200 });

    // before_prompt_build: every turn — self-model header on appendSystemContext;
    // recall on prependContext; cached/rebuilt bootstrap on prependContext if
    // queue did not deliver. (T2.2 Layer 1 + Layer 3 of the injection plan.)
    api.on("before_prompt_build", async (event: { prompt?: string; messages?: Array<{ role?: string; content?: unknown }>; kind?: string }, hookCtx: { agentId?: string; sessionKey?: string; sessionId?: string }) => {
      const t0 = Date.now();
      const agentId = resolveAgentId(undefined, hookCtx, config.agents);
      if (!config.agents.includes(agentId)) return;
      // Skip heartbeat slots — heartbeat turns get their own hook below.
      if (event?.kind === "heartbeat") return;
      const sessionKey = hookCtx?.sessionKey ?? "";
      if (sessionKey.endsWith(":heartbeat")) return;

      const sessionId = hookCtx?.sessionId ?? "";
      recordSessionAgent(sessionId, agentId);
      recordSessionAgent(sessionKey, agentId);
      const parts: string[] = [];

      // Per-surface trim: voice gets a tight bootstrap + recall + skips
      // neuro/morning/review noise. Chat surface unchanged.
      const surface: core.Surface = sessionKey.startsWith("voice:") ? "voice" : "chat";

      // Layer 1: self-model header (every turn, never compacted).
      let selfModelHeader = "";
      try {
        selfModelHeader = await core.buildSelfModelHeader(agentId, config, log, surface);
      } catch (err) {
        log.warn(logFields({ agentId, sessionId, op: "selfModelHeader", outcome: "error", error: String(err) }));
        selfModelHeader = core.BRAIN_HEADER;
      }

      // Layer 2 fallback: if queue did not deliver, inject from cache.
      const wasQueued = queuedSessions.has(sessionId);
      if (wasQueued) {
        // Queue path is in flight; agent_turn_prepare clears queuedSessions+bootstrapCache.
        // We avoid pushing into prependContext here so we don't double-inject.
      } else if (!bootstrapInjected.has(sessionId)) {
        const cached = bootstrapCache.get(sessionId);
        if (cached) {
          parts.push(cached);
          bootstrapCache.delete(sessionId);
          bootstrapInjected.add(sessionId);
        } else {
          try {
            const bootstrapCtx = await core.buildBootstrapContext(agentId, sessionId, config, log, surface);
            parts.push(bootstrapCtx);
            bootstrapInjected.add(sessionId);
          } catch (err) {
            log.warn(logFields({ agentId, sessionId, op: "before_prompt_build.bootstrap_rebuild", outcome: "error", error: String(err) }));
            bootstrapInjected.add(sessionId);
          }
        }
      }

      // Layer 3: recall on every turn (existing logic unchanged).
      let lastUserMsg = typeof event?.prompt === "string" ? event.prompt : "";
      if (!lastUserMsg) {
        const messages = (event?.messages ?? []) as Array<{ role?: string; content?: unknown }>;
        for (let i = messages.length - 1; i >= 0; i--) {
          const m = messages[i]!;
          if (m.role === "user" && typeof m.content === "string") {
            lastUserMsg = m.content;
            break;
          }
        }
      }
      // Proactive monitor: boost eligibility_trace on nodes matching the current
      // session's recent keywords. Runs before recall so spreading activation
      // picks up pre-primed nodes as higher-salience seeds.
      try {
        const neuromod = core.getNeuromodulatorState(agentId);
        await core.runProactiveMonitor(agentId, sessionId, config, log, neuromod, lastUserMsg ?? undefined);
      } catch {
        // non-fatal — recall continues without pre-priming
      }

      const recalledIds = new Set<string>();
      try {
        const recallBlock = await core.buildRecallContext(agentId, lastUserMsg, hookCtx?.sessionKey ?? sessionId, config, surface, recalledIds);
        if (recallBlock) parts.push(recallBlock);
      } catch (err) {
        log.warn(logFields({ agentId, sessionId, op: "before_prompt_build.recall", outcome: "error", error: String(err) }));
      }

      // Always-on operational rules. NOT query-gated: procedural memory is needed
      // when the agent is about to ACT, and what it is about to do has no lexical
      // relationship to what the user just said — so it can never win the
      // similarity ranking that buildRecallContext runs. Measured 2026-07-31:
      // every one of the 33 procedural nodes had inject_count = 0 since
      // 2026-07-13, including an importance-0.9 node describing the exact
      // PowerShell errors the agent was making in ~30% of its shell calls.
      // Voice keeps its tight budget and is excluded.
      if (surface !== "voice") {
        try {
          const procBlock = core.buildProceduralContext(agentId, hookCtx?.sessionKey ?? sessionId, recalledIds);
          if (procBlock) parts.push(procBlock);
        } catch (err) {
          log.warn(logFields({ agentId, sessionId, op: "before_prompt_build.procedural", outcome: "error", error: String(err) }));
        }
      }

      // Recent cross-session episodes — pure SQLite, sub-millisecond.
      // VOICE-SURFACE EXCLUSION (2026-05-20): the 24h activity dump pulls
      // episodes from EVERY session (Telegram, Discord, cron) — surface-
      // agnostic — and on the voice path that floods the prompt with random
      // chatter, meta-reflection, and prior-bug-reflection text. The result
      // has been the agent reciting Telegram-thread content / inner-dialogue
      // on live phone calls + 50K-token bootstraps that exceed Vapi's ~22s
      // window. This is a per-surface tighten: the voice path still has the
      // self_model header + buildRecallContext (which IS query-relevance-
      // filtered via hybridRetrieve) and still gets bootstrap on first turn.
      // Just no unfiltered 24h dump on voice.
      // LANE SCOPING — KNOWN LIMITATION (2026-08-31): this 24h dump is NOT
      // lane-filtered. core.getSessionSummaries does no foreground/background
      // classification — it groups every session over the importance floor.
      // Heartbeat and cron runs write to the same episode log and can massively
      // out-produce the conversation (34 heartbeat vs 14 main-chat episodes in
      // one measured 24h window), so their summaries can still surface here.
      // isForegroundLane / classifyEpisodeLane exist in core but are not yet
      // wired into this path.
      if (!sessionKey.startsWith("voice:")) {
        try {
          const sinceMs = Date.now() - 24 * 60 * 60 * 1000;
          const sessionSummaries = core.getSessionSummaries(agentId, sinceMs, 0.3, sessionKey, 5);
          if (sessionSummaries.length > 0) {
            const recStr = sessionSummaries.map((s) =>
              `[${s.ago}, ${s.channel}] ${s.summary}`
            ).join("\n");
            parts.push(`[BRAIN: last 24h activity]\n${recStr}`);
          }
        } catch (err) {
          log.debug?.(logFields({ agentId, sessionId, op: "before_prompt_build.recent_24h", outcome: "error", error: String(err) }));
        }
      }

      const result: { appendSystemContext?: string; prependContext?: string } = {};
      if (selfModelHeader) result.appendSystemContext = selfModelHeader;
      if (parts.length > 0) result.prependContext = parts.join("\n\n");

      log.debug?.(logFields({
        agentId, sessionId, op: "before_prompt_build",
        outcome: "ok",
        durationMs: Date.now() - t0,
        sysCtxChars: selfModelHeader.length,
        prependChars: parts.reduce((s, p) => s + p.length, 0),
      }));

      if (!result.appendSystemContext && !result.prependContext) return;
      return result;
      // Budget must exceed the inner async work: hybridRetrieve races the query
      // embedding at 2000ms and the proactive monitor at 250ms (Fable-5 audit
      // F-5 — the old 500ms budget silently dropped the whole recall block on a
      // slow Ollama; per docs/plugins/hooks.md:96 hook timeout fails OPEN).
      // Operators can still override via hooks.timeouts.before_prompt_build
      // (docs/plugins/hooks.md:84).
    }, { priority: 0, timeoutMs: 3500 });

    // heartbeat_prompt_contribution: lightweight delta only — system-prompt
    // self-model header keeps the brain present on heartbeat turns too.
    api.on("heartbeat_prompt_contribution", async (_event: unknown, hookCtx: { agentId?: string; sessionKey?: string }) => {
      const agentId = resolveAgentId(undefined, hookCtx, config.agents);
      if (!config.agents.includes(agentId)) return;
      try {
        const header = await core.buildSelfModelHeader(agentId, config, log);
        if (header) return { appendContext: header };
      } catch (err) {
        log.warn(logFields({ agentId, op: "heartbeat_prompt_contribution", outcome: "error", error: String(err) }));
      }
      return;
    }, { priority: 0, timeoutMs: 300 });

    // message_received
    api.on("message_received", async (event: { content?: string; text?: string; sessionKey?: string; agentId?: string }, hookCtx: { agentId?: string; sessionKey?: string; sessionId?: string }) => {
      const agentId = resolveAgentId(event, hookCtx, config.agents);
      if (!config.agents.includes(agentId)) return;

      const content = event?.content ?? event?.text ?? "";
      if (!content) return;

      const sessionKey = event?.sessionKey ?? hookCtx?.sessionKey ?? "";
      const sessionId = hookCtx?.sessionId ?? sessionKey;
      recordSessionAgent(sessionId, agentId);
      recordSessionAgent(sessionKey, agentId);
      // Cron sessions are operational overhead — record the episode for SWS
      // history but clamp importance below extraction threshold so cron
      // artifacts never become extracted brain nodes. Live key format (verified
      // openclaw-2026-07-12.log): `agent:<id>:cron:<uuid>:run:<ts>`. The bare
      // "cron:" prefix is kept as belt-and-braces for older gateways.
      const isCronSession = /^agent:[^:]+:cron:/.test(sessionKey) || sessionKey.startsWith("cron:");
      const importance = isCronSession ? 0.1 : core.scoreImportance("user", content);
      let episodeId = "";
      try {
        episodeId = core.appendEpisode(agentId, sessionKey, "user", content, importance);
      } catch (err) {
        log.warn(logFields({ agentId, sessionId, op: "message_received.episode", outcome: "error", error: String(err) }));
        return;
      }
      log.info(logFields({ agentId, sessionId, op: "message_received", outcome: "ok", importance, isCronSession }));

      if (config.llmExtractionEnabled && importance >= config.llmExtractionMinImportance) {
        core.queueEpisodeForExtraction(agentId, {
          id: episodeId,
          session_id: sessionId,
          role: "user",
          content,
          importance,
          tokens: Math.ceil(content.length / 4),
          ripple_count: 0,
          created_at: Date.now(),
          meta: null,
        });
      }

      if (importance >= 0.8) {
        try { core.propagateDopamineSpike(agentId, importance); } catch { /* logged below */ }
      }
    });

    // llm_output
    api.on("llm_output", async (event: { assistantTexts?: string[]; content?: string }, hookCtx: { agentId?: string; sessionKey?: string; sessionId?: string }) => {
      const agentId = resolveAgentId(undefined, hookCtx, config.agents);
      if (!config.agents.includes(agentId)) return;

      const texts = event?.assistantTexts ?? (event?.content ? [event.content] : []);
      // Strip Rich Output Protocol directives before this becomes an episode —
      // they are routing instructions for the channel layer, not speech, and
      // storing them lets SWS mint them into recallable nodes that the brain
      // then injects back as live instructions. See stripControlDirectives.
      const content = stripControlDirectives(texts.join("\n").trim());
      if (!content) return;

      const sessionKey = hookCtx?.sessionKey ?? hookCtx?.sessionId ?? "";
      const sessionId = hookCtx?.sessionId ?? sessionKey;
      // Cron sessions are operational overhead — clamp importance below the
      // extraction threshold so responses like "Awakened via cron — Morning
      // Routine" never become extracted brain nodes. Episode still written for
      // SWS history. Live key format: `agent:<id>:cron:<uuid>:run:<ts>`.
      const isCronSession = /^agent:[^:]+:cron:/.test(sessionKey) || sessionKey.startsWith("cron:");
      const importance = isCronSession ? 0.1 : core.scoreImportance("assistant", content);

      // VALOR: score this reply against the nodes injected for this session's
      // last turn. buildRecallContext keyed the pending record by the same
      // sessionKey-or-sessionId it received, so try both.
      try {
        const valor = core.scoreReplyAgainstInjections(agentId, sessionKey, content)
          ?? core.scoreReplyAgainstInjections(agentId, sessionId, content);
        if (valor) {
          log.info(logFields({ agentId, sessionId, op: "valor.score", outcome: "ok", scored: valor.scored, hits: valor.hits, reviewed: valor.reviewed }));
        }
      } catch (err) {
        log.debug?.(logFields({ agentId, sessionId, op: "valor.score", outcome: "error", error: String(err) }));
      }

      let episodeId = "";
      try {
        episodeId = core.appendEpisode(agentId, sessionKey, "assistant", content, importance);
      } catch (err) {
        log.warn(logFields({ agentId, sessionId, op: "llm_output.episode", outcome: "error", error: String(err) }));
        return;
      }
      log.info(logFields({ agentId, sessionId, op: "llm_output", outcome: "ok", importance, isCronSession }));

      if (config.llmExtractionEnabled && importance >= config.llmExtractionMinImportance) {
        core.queueEpisodeForExtraction(agentId, {
          id: episodeId,
          session_id: sessionId,
          role: "assistant",
          content,
          importance,
          tokens: Math.ceil(content.length / 4),
          ripple_count: 0,
          created_at: Date.now(),
          meta: null,
        });
      }

      if (importance >= 0.8) {
        try { core.propagateDopamineSpike(agentId, importance * 0.8); } catch { /* ok */ }
      }
    });

    // agent_end (requires `allowConversationAccess: true` in operator config)
    api.on("agent_end", async (_event: unknown, hookCtx: { agentId?: string; sessionKey?: string; sessionId?: string }) => {
      const agentId = resolveAgentId(undefined, hookCtx, config.agents);
      if (!config.agents.includes(agentId)) return;
      try {
        await core.subconsciousTick(agentId, config, log);
      } catch (err) {
        log.warn(logFields({ agentId, op: "agent_end.subconscious", outcome: "error", error: String(err) }));
      }
    }, { priority: 0, timeoutMs: 2000 });

    // after_compaction
    api.on("after_compaction", async (event: { compactedCount?: number; messageCount?: number; summary?: string; messages?: Array<{ role: string; content?: unknown }>; sourceEpisodeIds?: string[] }, hookCtx: { agentId?: string; sessionKey?: string; sessionId?: string }) => {
      const agentId = resolveAgentId(undefined, hookCtx, config.agents);
      if (!config.agents.includes(agentId)) return;

      const sessionKey = hookCtx?.sessionKey ?? hookCtx?.sessionId ?? "";
      try {
        core.appendEpisode(
          agentId,
          sessionKey,
          "tool",
          `[compaction: ${event?.compactedCount ?? 0} of ${event?.messageCount ?? 0} messages compacted]`,
          0.1,
        );
      } catch (err) {
        log.debug?.(logFields({ agentId, op: "after_compaction.episode", outcome: "error", error: String(err) }));
      }
      try {
        core.handleCompaction(agentId, event ?? {}, config, log);
      } catch (err) {
        log.warn(logFields({ agentId, op: "after_compaction.handle", outcome: "error", error: String(err) }));
      }
    });

    log.info(logFields({
      op: "register",
      outcome: "ok",
      agents: config.agents.length,
      tools: tools.length,
      engine: "sharpwave-core",
      // LLM-route diagnostics (booleans/model-id only, never key material):
      // added 2026-07-13 when REM fell back to keyword mode despite the nvidia
      // ingestionModel being configured — makes key/config delivery visible.
      ingestionModel: config.ingestionModel,
      nvidiaKeyPresent: !!process.env["NVIDIA_API_KEY"],
      openRouterKeyPresent: !!(config.openRouterApiKey || process.env["OPENROUTER_API_KEY"]),
    }));
  },
});
