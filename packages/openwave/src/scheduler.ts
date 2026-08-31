// packages/openwave/src/scheduler.ts
//
// In-process sleep-system scheduler, extracted from index.ts's `gateway_start`
// hook (Task 8). Owns the recurring timers plus the post-boot consolidation
// kick, and the extraction-harvest / consolidation-gate helpers they drive.
//
// Cadences (unchanged from the inline version that lived in gateway_start):
//   - awake-replay tick       every 30 min  -> core.awakeReplayTick
//   - hourly maintenance      every 60 min  -> harvestExtraction + shouldConsolidate/runConsolidation
//   - embedding sweep         every 10 min  -> core.sweepMissingEmbeddings + core.drainEmbeddingQueue
//   - initial consolidation   once, +5 min  -> same body as hourly, trigger "initial"
//
// Every engine call goes through the `sharpwave-core` barrel. `harvestExtraction`
// is also called directly by index.ts's `session_end` hook, so it is exported.

import * as core from "sharpwave-core";

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
};

export type SchedulerHandles = {
  replay: NodeJS.Timeout | null;
  consolidation: NodeJS.Timeout | null;
  sweep: NodeJS.Timeout | null;
  /** Post-boot one-shot consolidation kick (+5 min). Cleared by disarmSchedulers. */
  initialConsolidation: NodeJS.Timeout | null;
};

const REPLAY_INTERVAL_MS = 30 * 60 * 1000;
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
const INITIAL_CONSOLIDATION_DELAY_MS = 5 * 60 * 1000;

// Re-entry guard so a long consolidation never overlaps the next tick.
const consolidatingAgents = new Set<string>();

// Structured logger helper (mirrors index.ts::logFields).
function logFields(fields: Record<string, string | number | boolean | undefined>): string {
  const filtered: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) filtered[k] = v;
  }
  return `[openwave] ${JSON.stringify(filtered)}`;
}

// ─── Extraction harvest ────────────────────────────────────────────────────────
// Drains the LLM-extraction queue and persists results: fact nodes written,
// embeddings queued, consumed episodes flipped llm_extracted (T1.3), and
// temporal before/after edges wired. Called from both the hourly sleep-system
// tick (bounds fact latency at ~60 min for long-lived channel sessions) and
// index.ts's session_end hook.
export async function harvestExtraction(
  agentId: string,
  opPrefix: string,
  config: core.BrainConfig,
  log: Logger,
): Promise<void> {
  const facts = await core.drainExtractionQueue(agentId, config, log);
  for (const fact of facts) {
    const nodeId = core.writeNode(agentId, fact.type, fact.label, fact.content, {
      importance: fact.importance,
      source: "llm_extraction",
      extractionConfidence: fact.confidence,
    });
    core.queueEmbedding(agentId, nodeId);
  }

  // T1.3 dual-extraction prevention: mark consumed episodes as llm_extracted
  // so SWS skips them in consolidation.ts.
  const episodeIds = facts.episodeIds ?? [];
  if (episodeIds.length > 0) {
    try {
      const db = core.getDb(agentId);
      const mark = db.prepare("UPDATE episodes SET llm_extracted = 1 WHERE id = ?");
      db.transaction(() => {
        for (const id of episodeIds) mark.run(id);
      })();
      log.info(logFields({ agentId, op: `${opPrefix}.mark_llm_extracted`, outcome: "ok", count: episodeIds.length }));
    } catch (err) {
      log.warn(logFields({ agentId, op: `${opPrefix}.mark_llm_extracted`, outcome: "error", error: String(err) }));
    }
  }

  // Wire temporal before/after edges from LLM extraction.
  const temporalRelations = facts.temporalRelations ?? [];
  if (temporalRelations.length > 0) {
    try {
      const db = core.getDb(agentId);
      const findByLabel = db.prepare("SELECT id FROM nodes WHERE label = ? LIMIT 1");
      let wired = 0;
      for (const tr of temporalRelations) {
        const fromRow = findByLabel.get(tr.subject) as { id: string } | undefined;
        const toRow = findByLabel.get(tr.object) as { id: string } | undefined;
        if (fromRow && toRow && (tr.relation === "before" || tr.relation === "after")) {
          core.writeEdge(agentId, fromRow.id, toRow.id, tr.relation as "before" | "after");
          wired++;
        }
      }
      if (wired > 0) {
        log.info(logFields({ agentId, op: `${opPrefix}.temporal_edges`, outcome: "ok", count: wired }));
      }
    } catch (err) {
      log.warn(logFields({ agentId, op: `${opPrefix}.temporal_edges`, outcome: "error", error: String(err) }));
    }
  }

  if (facts.length > 0) {
    log.info(logFields({ agentId, op: `${opPrefix}.facts_written`, outcome: "ok", count: facts.length }));
  }
}

// ─── Hourly maintenance body ───────────────────────────────────────────────────
// Harvest the extraction queue, then check the consolidation gate.
// shouldConsolidate() gates on the 4h time gate + 10-new-episode delta, so quiet
// agents don't consolidate and busy agents consolidate at most every
// consolidationTimeGateHours. Every tick logs `sleep_system.tick` with the
// per-agent gate verdict — the heartbeat of the sleep system (2026-07-13).
function runSleepMaintenance(
  agentIds: string[],
  config: core.BrainConfig,
  log: Logger,
  trigger: string,
): void {
  for (const agentId of agentIds) {
    if (consolidatingAgents.has(agentId)) {
      log.info(logFields({ agentId, op: "sleep_system.tick", trigger, outcome: "skipped", reason: "already_running" }));
      continue;
    }
    consolidatingAgents.add(agentId);
    void (async () => {
      try {
        await harvestExtraction(agentId, "sleep_system", config, log);
      } catch (err) {
        log.warn(logFields({ agentId, op: "sleep_system.extraction", outcome: "error", error: String(err) }));
      }
      let gate = false;
      try {
        gate = core.shouldConsolidate(agentId, config);
        log.info(logFields({ agentId, op: "sleep_system.tick", trigger, outcome: "ok", consolidate: gate }));
        if (gate) {
          await core.runConsolidation(agentId, config, log);
        }
      } catch (err) {
        log.warn(logFields({ agentId, op: "consolidation.run", outcome: "error", error: String(err) }));
      }
    })().finally(() => {
      consolidatingAgents.delete(agentId);
    });
  }
}

// ─── Public surface ────────────────────────────────────────────────────────────

/**
 * Arm the three recurring sleep-system timers + the post-boot consolidation
 * kick. Returns the handles so the caller (index.ts gateway_stop / lifecycle
 * cleanup) can release them for the old runtime generation.
 */
export function armSchedulers(
  agentIds: string[],
  config: core.BrainConfig,
  log: Logger,
): SchedulerHandles {
  const agents = agentIds.slice();

  // Awake-replay tick: every 30 min (matches the old cron cadence).
  const replay = setInterval(() => {
    for (const agentId of agents) {
      void core.awakeReplayTick(agentId, config, log).catch((err) => {
        log.warn(logFields({ agentId, op: "awake_replay.tick", outcome: "error", error: String(err) }));
      });
    }
  }, REPLAY_INTERVAL_MS);

  // Hourly maintenance: extraction harvest + consolidation gate.
  const consolidation = setInterval(
    () => runSleepMaintenance(agents, config, log, "hourly"),
    MAINTENANCE_INTERVAL_MS,
  );

  // Initial check shortly after boot: consolidation debt accumulated while the
  // gateway was down gets processed within minutes instead of waiting an hour.
  const initialConsolidation = setTimeout(
    () => runSleepMaintenance(agents, config, log, "initial"),
    INITIAL_CONSOLIDATION_DELAY_MS,
  );

  // In-process embedding sweep (T3.5): every 10 min, requeue orphan nodes.
  const sweep = setInterval(() => {
    for (const agentId of agents) {
      try {
        const n = core.sweepMissingEmbeddings(agentId, 50);
        if (n > 0) {
          log.info(logFields({ agentId, op: "embedding.sweep", outcome: "ok", requeued: n }));
        }
        // Drain opportunistically (returns immediately if a drain is in flight).
        void core.drainEmbeddingQueue(agentId, config, log).catch(() => {
          /* logged inside drain */
        });
      } catch (err) {
        log.warn(logFields({ agentId, op: "embedding.sweep", outcome: "error", error: String(err) }));
      }
    }
  }, SWEEP_INTERVAL_MS);

  log.info(logFields({
    op: "sleep_system",
    outcome: "ok",
    note: "in-process timers armed: awake-replay 30m, consolidation gate 60m, embedding sweep 10m",
  }));

  return { replay, consolidation, sweep, initialConsolidation };
}

/**
 * Clear every timer in `handles` and reset the re-entry guard. Safe to call
 * with a null/undefined handle set (lifecycle cleanup can fire before
 * gateway_start ever armed anything).
 */
export function disarmSchedulers(handles: SchedulerHandles | null | undefined): void {
  if (handles) {
    if (handles.replay) { clearInterval(handles.replay); handles.replay = null; }
    if (handles.consolidation) { clearInterval(handles.consolidation); handles.consolidation = null; }
    if (handles.sweep) { clearInterval(handles.sweep); handles.sweep = null; }
    if (handles.initialConsolidation) { clearTimeout(handles.initialConsolidation); handles.initialConsolidation = null; }
  }
  consolidatingAgents.clear();
}
