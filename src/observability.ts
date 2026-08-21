/**
 * Observability — diagnostic counters + JSONL event log.
 *
 * Ported from ClawBrain v0.4.0 audit (item #8). The TS codebase never had
 * a structured observability layer; this adds the minimum needed for
 * operators to see what the brain is doing without pulling in a heavy
 * metrics stack.
 *
 * Two surfaces:
 *   1. In-process diagnostic counters (`bumpCounter`, `getCounters`) — plain
 *      ints, cheap to maintain, surfaced via `brain_stats` and a future
 *      `brain_health` tool. ALWAYS ON (zero overhead beyond an int
 *      increment + a `Map.get`).
 *   2. Structured JSONL event log (`logObservabilityEvent`) — appends one
 *      line to `memory/brain_events.jsonl` per event when
 *      `SHARPWAVE_OBSERVABILITY=1`. DEFAULT OFF so the standard install
 *      stays silent. Bypassed entirely on a single boolean check when
 *      disabled.
 *
 * Counter names follow the Python reference: `memories_stored`,
 * `memories_recalled`, `memories_forgotten`, `memories_merged`,
 * `embeddings_computed`, `embeddings_cached`, `fts_optimizes`,
 * `fts_rebuilds`, `wal_retries`, `wal_retry_failures`. Unknown counter
 * names are created on demand (matches the Python `_bump_counter` behavior).
 *
 * Event types: `remember`, `recall`, `forget`, `merge`, `consolidate`,
 * `embedding_cache_hit`, `embedding_cache_miss`, `fts_optimize`,
 * `fts_rebuild`, `wal_retry`. Custom event types are also accepted.
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

type CounterName =
  | "memories_stored"
  | "memories_recalled"
  | "memories_forgotten"
  | "memories_merged"
  | "embeddings_computed"
  | "embeddings_cached"
  | "fts_optimizes"
  | "fts_rebuilds"
  | "wal_retries"
  | "wal_retry_failures";

// Process-lifetime counters. The TypeScript codebase is a single MCP server
// process, so this lives in module scope and is shared across all agent
// contexts (each agent's stats are aggregated into the same counters).
const counters = new Map<CounterName | string, number>([
  ["memories_stored", 0],
  ["memories_recalled", 0],
  ["memories_forgotten", 0],
  ["memories_merged", 0],
  ["embeddings_computed", 0],
  ["embeddings_cached", 0],
  ["fts_optimizes", 0],
  ["fts_rebuilds", 0],
  ["wal_retries", 0],
  ["wal_retry_failures", 0],
]);

// ISO 8601 UTC timestamp of the last consolidation run. Null until the
// first run. Surfaced via brain_stats so operators can see how fresh the
// brain is without parsing the database.
let lastConsolidationAt: string | null = null;

/**
 * True when structured event logging is enabled. Resolved once at module
 * load — the env var is read at startup, not per-event. Operators who flip
 * the env var mid-run need to restart the server (matches Python behavior).
 */
const observabilityEnabled: boolean = (() => {
  const raw = process.env["SHARPWAVE_OBSERVABILITY"] ?? "";
  return raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "yes";
})();

// Where the JSONL event log is written. Resolved once at startup so we
// don't pay a path lookup per event. Default: `<SHARPWAVE_DATA_DIR>/brain_events.jsonl`
// (falls back to `~/.sharpwave/brain_events.jsonl`), matching the Python
// reference's `memory/brain_events.jsonl` next to the SQLite DB.
const eventLogPath: string | null = (() => {
  if (!observabilityEnabled) return null;
  try {
    const dataDir = process.env["SHARPWAVE_DATA_DIR"] ?? join(process.env["USERPROFILE"] ?? process.env["HOME"] ?? ".", ".sharpwave");
    const path = join(dataDir, "brain_events.jsonl");
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return path;
  } catch {
    return null;
  }
})();

/**
 * Increment a diagnostic counter. Cheap (Map lookup + int add); safe to
 * call from any hot path.
 */
export function bumpCounter(name: CounterName | string, amount = 1): void {
  try {
    counters.set(name, (counters.get(name) ?? 0) + amount);
  } catch {
    // Counter bookkeeping is best-effort; never raise.
  }
}

/**
 * Read-only snapshot of all counters. Returned shape matches the Python
 * reference's `diagnostic_counters` field in `health_check`.
 */
export function getCounters(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of counters) out[k] = v;
  return out;
}

/**
 * Set the last consolidation timestamp. Called by the consolidation pass
 * after a successful run. Format matches the Python reference: ISO 8601
 * UTC with `Z` suffix.
 */
export function setLastConsolidationAt(iso: string): void {
  lastConsolidationAt = iso;
}

export function getLastConsolidationAt(): string | null {
  return lastConsolidationAt;
}

export function isObservabilityEnabled(): boolean {
  return observabilityEnabled;
}

/**
 * Append a single JSONL event line. No-op when observability is disabled
 * (single boolean check). Best-effort — never throws. Used by the WAL
 * retry helper, embedding cache, FTS maintenance, and the main write
 * paths.
 */
export function logObservabilityEvent(
  eventType: string,
  details?: Record<string, unknown>,
): void {
  if (!observabilityEnabled || eventLogPath === null) return;
  try {
    const payload: Record<string, unknown> = {
      ts: new Date().toISOString(),
      event: eventType,
    };
    if (details) Object.assign(payload, details);
    // Append in text mode; JSON.stringify is safe for ASCII. Non-ASCII chars
    // (em-dash, smart quotes) are escaped by JSON.stringify, so we don't
    // hit the better-sqlite3-em-dash PowerShell gotcha here.
    appendFileSync(eventLogPath, JSON.stringify(payload) + "\n", "utf8");
  } catch {
    // Observability is best-effort; never break the write path.
  }
}
