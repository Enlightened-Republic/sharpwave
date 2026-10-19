import type Database from "better-sqlite3";
import { getDb, bumpWriteCounter } from "./db.js";
import { executeWithWalRetrySync } from "./wal-retry.js";
import { bumpCounter, logObservabilityEvent } from "./observability.js";

export interface ResetResult {
  nodes: number;
  edges: number;
  episodes: number;
  vectors: number;
  associations: number;
  workingMemory: number;
  /**
   * Rows removed from every other learned-state table (decisions, goals, plans,
   * open items, commitments, reflections, review queue, soul provenance, room
   * items, identity history, ...), keyed by table name. Only tables that exist
   * in this brain and held at least one row are listed.
   */
  other: Record<string, number>;
  /** meta_kv entries cleared (consolidation / replay / drift / focus bookkeeping). */
  meta: number;
}

/**
 * Every learned-state table beyond the six "core" ones, in the order they are
 * wiped. None of these reference nodes(id) with a foreign key, so order only
 * matters for readability. Tables that do not exist in an older brain (a
 * migration that has not run yet, or a brain that never used a feature) are
 * skipped silently — DELETE on a missing table is not an error here.
 *
 * Keep this list in sync with the CREATE TABLE statements in db.ts and soul.ts
 * (rooms.ts' registry tables live in a separate file and are not per-brain).
 */
const LEARNED_STATE_TABLES: readonly string[] = [
  // decisions & alignment
  "decisions", "alignment_notes",
  // goals
  "goals", "goal_events", "goal_triggers",
  // plans & continuity
  "plans", "plan_steps", "dependencies", "commitments", "open_items",
  // reflection & lessons
  "reflections", "lesson_merges",
  // identity evolution (brain_identity history, pending proposals)
  "identity_changes",
  // soul packages: imports, provenance, review queue
  "soul_id_map", "soul_provenance", "soul_events", "review_items",
  // rooms: this brain's copy of room items + conflicts (the registry is a separate db)
  "room_items", "room_conflicts",
  // procedures compiled from plans + their run ledger
  "procedures", "procedure_runs",
];

/**
 * meta_kv keys that are NOT learned state and survive a reset:
 *  - the update-check throttle (nothing to do with memories)
 *  - the backup manifest, which records the snapshot brain_reset just took
 *    (wiping it would orphan that backup from `brain_reset`'s own bookkeeping)
 */
const META_KEEP: readonly string[] = ["update_check:last_run", "backup_manifest"];

function count(db: Database.Database, table: string): number {
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } catch {
    return 0;
  }
}

function tableExists(db: Database.Database, table: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

/**
 * Wipe every piece of learned state from an agent's brain and re-seed an empty
 * self-model: nodes, edges, episodes, vectors, associations, working memory,
 * AND the continuity tables (decisions, goals, plans, open items, commitments,
 * reflections, identity history, soul provenance, review queue, room items)
 * plus the derived bookkeeping in meta_kv (last consolidation, replay ledger,
 * dream context, drift / reflection timers, injection focus, retire registry).
 *
 * Structural tables (schema_version, meta_kv's structural keys) and the vec0
 * virtual table's *definition* (float[1024]) are preserved — this is DELETE
 * FROM, never DROP — so the next brain_write embeds through the exact same
 * provider path (Ollama → OpenRouter) with no dimension change.
 *
 * The caller is responsible for taking a backup first (see db-backup.createBackup).
 */
export function resetBrain(agentId: string): ResetResult {
  const db = getDb(agentId);

  const other: Record<string, number> = {};
  for (const t of LEARNED_STATE_TABLES) {
    if (!tableExists(db, t)) continue;
    const n = count(db, t);
    if (n > 0) other[t] = n;
  }
  const metaPlaceholders = META_KEEP.map(() => "?").join(", ");
  const metaToClear = (db.prepare(`SELECT COUNT(*) AS n FROM meta_kv WHERE key NOT IN (${metaPlaceholders})`).get(...META_KEEP) as { n: number }).n;

  const before: ResetResult = {
    nodes: count(db, "nodes"),
    edges: count(db, "edges"),
    episodes: count(db, "episodes"),
    vectors: count(db, "nodes_vec"),
    associations: count(db, "node_associations"),
    workingMemory: count(db, "working_memory"),
    other,
    meta: metaToClear,
  };

  const now = Date.now();

  executeWithWalRetrySync(
    db,
    (d) => {
      d.transaction(() => {
        // FK order: rows that reference nodes(id) go first.
        d.prepare("DELETE FROM working_memory").run();
        d.prepare("DELETE FROM node_associations").run();
        d.prepare("DELETE FROM edges").run();
        d.prepare("DELETE FROM nodes").run(); // fires nodes_fts_delete per row
        d.prepare("DELETE FROM episodes").run(); // fires episodes_fts_delete per row
        try {
          d.prepare("DELETE FROM nodes_vec").run();
        } catch {
          /* sqlite-vec not loaded — no vec table to clear */
        }
        for (const t of LEARNED_STATE_TABLES) {
          if (tableExists(d, t)) d.prepare(`DELETE FROM ${t}`).run();
        }
        d.prepare(`DELETE FROM meta_kv WHERE key NOT IN (${metaPlaceholders})`).run(...META_KEEP);
        d.prepare("DELETE FROM self_model WHERE id = 'singleton'").run();
        d.prepare(
          "INSERT INTO self_model (id, identity, goals, user_model, created_at, updated_at) VALUES ('singleton', '', '[]', '{}', ?, ?)",
        ).run(now, now);
      })();

      // Belt-and-suspenders: force-rebuild the FTS indexes in case a bulk
      // DELETE left either contentless-fts table out of sync.
      try { d.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')"); } catch { /* ignore */ }
      try { d.exec("INSERT INTO episodes_fts(episodes_fts) VALUES('rebuild')"); } catch { /* ignore */ }
    },
    { op: "brain.reset" },
  );

  bumpWriteCounter(db);
  bumpCounter("brain_resets");
  logObservabilityEvent("reset", { agentId, ...before });

  // Reclaim the space the wiped rows occupied.
  try { db.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* non-fatal */ }
  try { db.exec("VACUUM"); } catch { /* non-fatal */ }

  return before;
}
