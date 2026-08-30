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
}

function count(db: Database.Database, table: string): number {
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } catch {
    return 0;
  }
}

/**
 * Wipe every piece of learned state from an agent's brain and re-seed an empty
 * self-model. Structural tables (schema_version, meta_kv) and the vec0 virtual
 * table's *definition* (float[1024]) are preserved — this is DELETE FROM, never
 * DROP — so the next brain_write embeds through the exact same provider path
 * (Ollama → OpenRouter) with no dimension change.
 *
 * The caller is responsible for taking a backup first (see db-backup.createBackup).
 */
export function resetBrain(agentId: string): ResetResult {
  const db = getDb(agentId);

  const before: ResetResult = {
    nodes: count(db, "nodes"),
    edges: count(db, "edges"),
    episodes: count(db, "episodes"),
    vectors: count(db, "nodes_vec"),
    associations: count(db, "node_associations"),
    workingMemory: count(db, "working_memory"),
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
