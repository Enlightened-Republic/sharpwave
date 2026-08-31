import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { executeWithWalRetrySync } from "./wal-retry.js";
import { bumpCounter, logObservabilityEvent } from "./observability.js";

const dbs = new Map<string, Database.Database>();

// Process-lifetime counters for FTS maintenance (item #4). The actual
// `fts_optimizes` / `fts_rebuilds` counters are exposed via observability.ts;
// the local write counter is what triggers an automatic OPTIMIZE every N writes.
let _writeCount = 0;
// Default threshold matches the Python reference (every 100 writes). Operators
// can override via SHARPWAVE_FTS_OPTIMIZE_EVERY.
const _ftsOptimizeEvery = (() => {
  const raw = process.env["SHARPWAVE_FTS_OPTIMIZE_EVERY"];
  const n = raw ? parseInt(raw, 10) : 100;
  return Number.isFinite(n) && n > 0 ? n : 100;
})();

/**
 * Run an FTS5 maintenance command against the brain's FTS virtual tables.
 *
 * Ports ClawBrain v0.4.0 audit item #4 (FTS5 maintenance). Modes:
 *   - 'optimize': incremental merge of the FTS segment files. Safe and fast;
 *     called automatically every N writes from `_bumpWriteCounter`.
 *   - 'rebuild': full rebuild from the content table. Slow; called from
 *     the public `maintenance()` entry point.
 *
 * No-op if the FTS tables are missing (sqlite-vec / fts5 unavailable on
 * the platform) — same graceful-degradation contract as the Python
 * reference.
 */
function ftsMaintenance(db: Database.Database, mode: "optimize" | "rebuild"): {
  ran: boolean;
  mode: string;
  tableExists: boolean;
  reason: string;
  durationMs: number;
} {
  const result = {
    ran: false,
    mode,
    tableExists: false,
    reason: "unknown",
    durationMs: 0,
  };
  if (mode !== "optimize" && mode !== "rebuild") {
    result.reason = `unknown mode: ${mode}`;
    return result;
  }

  const t0 = Date.now();
  try {
    // Check that the FTS virtual table exists before issuing the command —
    // sqlite returns an error if you INSERT INTO '<table>' for a table
    // that isn't present, and we want a clean "absent" reason instead.
    const exists = db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ? LIMIT 1",
    ).get("nodes_fts") as { 1: number } | undefined;
    if (!exists) {
      result.reason = "nodes_fts absent";
      result.durationMs = Date.now() - t0;
      return result;
    }

    db.exec(`INSERT INTO nodes_fts(nodes_fts) VALUES('${mode}')`);
    db.exec(`INSERT INTO episodes_fts(episodes_fts) VALUES('${mode}')`);

    result.ran = true;
    result.tableExists = true;
    result.reason = "ok";
    result.durationMs = Date.now() - t0;

    if (mode === "rebuild") {
      bumpCounter("fts_rebuilds");
      logObservabilityEvent("fts_rebuild", { durationMs: result.durationMs });
    } else {
      bumpCounter("fts_optimizes");
      logObservabilityEvent("fts_optimize", { durationMs: result.durationMs });
    }
  } catch (err) {
    // Maintenance must NEVER break the main write path.
    result.reason = `error: ${String(err)}`;
    result.durationMs = Date.now() - t0;
  }
  return result;
}

/**
 * Increment the write counter and auto-trigger FTS optimize when the
 * threshold is crossed. Called from writeNode, forgetNodeById, etc. so
 * the FTS index stays healthy over long write-heavy sessions without
 * operator intervention.
 */
export function bumpWriteCounter(db: Database.Database): void {
  _writeCount++;
  if (_ftsOptimizeEvery > 0 && _writeCount % _ftsOptimizeEvery === 0) {
    ftsMaintenance(db, "optimize");
  }
}

/**
 * Public maintenance entry point. Runs FTS5 rebuild + optimize. Safe to
 * call repeatedly; no-ops when FTS5 is not configured. Surfaced via the
 * `brain_health` tool in index.ts (item #5 observability).
 */
export function maintenance(agentId: string): {
  rebuild: ReturnType<typeof ftsMaintenance>;
  optimize: ReturnType<typeof ftsMaintenance>;
  writeCount: number;
  ftsOptimizeEvery: number;
} {
  const db = getDb(agentId);
  const rebuild = ftsMaintenance(db, "rebuild");
  const optimize = ftsMaintenance(db, "optimize");
  return { rebuild, optimize, writeCount: _writeCount, ftsOptimizeEvery: _ftsOptimizeEvery };
}

export function getWriteCount(): number {
  return _writeCount;
}

export function getFtsOptimizeEvery(): number {
  return _ftsOptimizeEvery;
}

function resolveDbPath(agentId: string): string {
  const explicit = process.env["SHARPWAVE_DB_PATH"];
  if (explicit) return explicit;
  const dataDir = process.env["SHARPWAVE_DATA_DIR"]
    ?? join(homedir(), ".sharpwave");
  return join(dataDir, agentId, "brain.db");
}

export function getDb(agentId: string): Database.Database {
  if (dbs.has(agentId)) return dbs.get(agentId)!;

  const path = resolveDbPath(agentId);
  const dir = path.replace(/[/\\][^/\\]+$/, "");
  mkdirSync(dir, { recursive: true });

  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  try {
    sqliteVec.load(db);
  } catch {
    // sqlite-vec unavailable — vector search degrades to FTS only
  }

  initSchema(db);
  runMigrations(db);

  dbs.set(agentId, db);
  return db;
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);

    CREATE TABLE IF NOT EXISTS nodes (
      id                    TEXT PRIMARY KEY,
      type                  TEXT NOT NULL,
      label                 TEXT NOT NULL,
      content               TEXT NOT NULL,
      importance            REAL NOT NULL DEFAULT 0.5,
      salience              REAL NOT NULL DEFAULT 0.5,
      stability             REAL NOT NULL DEFAULT 1.0,
      retrievability        REAL NOT NULL DEFAULT 1.0,
      ef                    REAL NOT NULL DEFAULT 2.5,
      access_count          INTEGER NOT NULL DEFAULT 0,
      emotional_weight      REAL NOT NULL DEFAULT 0.0,
      episode_ids           TEXT,
      source                TEXT,
      embedding             BLOB,
      encoding_context      TEXT,
      extraction_confidence REAL NOT NULL DEFAULT 1.0,
      ripple_count          INTEGER NOT NULL DEFAULT 0,
      eligibility_trace     REAL NOT NULL DEFAULT 0.0,
      difficulty            REAL NOT NULL DEFAULT 5.0,
      last_review           INTEGER,
      review_count          INTEGER NOT NULL DEFAULT 0,
      is_consolidated       INTEGER NOT NULL DEFAULT 0,
      consolidated_at       INTEGER,
      ps_hash               BLOB,
      valid_from            INTEGER,
      valid_until           INTEGER,
      review_history        TEXT,
      stability_sigma       REAL NOT NULL DEFAULT 1.0,
      inject_count          INTEGER NOT NULL DEFAULT 0,
      inject_hits           INTEGER NOT NULL DEFAULT 0,
      created_at            INTEGER NOT NULL,
      accessed_at           INTEGER NOT NULL,
      updated_at            INTEGER NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
      id UNINDEXED, label, content, type UNINDEXED,
      content=nodes, content_rowid=rowid
    );

    CREATE TABLE IF NOT EXISTS edges (
      id          TEXT PRIMARY KEY,
      from_id     TEXT NOT NULL REFERENCES nodes(id),
      to_id       TEXT NOT NULL REFERENCES nodes(id),
      type        TEXT NOT NULL,
      weight      REAL NOT NULL DEFAULT 1.0,
      valid_from  INTEGER NOT NULL,
      valid_until INTEGER,
      learned_at  INTEGER NOT NULL,
      created_at  INTEGER NOT NULL,
      meta        TEXT
    );

    CREATE INDEX IF NOT EXISTS edges_from ON edges(from_id, valid_until);
    CREATE INDEX IF NOT EXISTS edges_to   ON edges(to_id,   valid_until);
    CREATE INDEX IF NOT EXISTS edges_type ON edges(type,    valid_until);

    CREATE TABLE IF NOT EXISTS episodes (
      id            TEXT PRIMARY KEY,
      session_id    TEXT NOT NULL,
      role          TEXT NOT NULL,
      content       TEXT NOT NULL,
      importance    REAL NOT NULL DEFAULT 0.5,
      tokens        INTEGER NOT NULL DEFAULT 0,
      ripple_count  INTEGER NOT NULL DEFAULT 0,
      llm_extracted INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      meta          TEXT
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
      id UNINDEXED, content, role UNINDEXED,
      content=episodes, content_rowid=rowid
    );

    CREATE INDEX IF NOT EXISTS episodes_session ON episodes(session_id, created_at);

    CREATE TABLE IF NOT EXISTS working_memory (
      node_id    TEXT NOT NULL REFERENCES nodes(id),
      activation REAL NOT NULL DEFAULT 0.0,
      entered_at INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      PRIMARY KEY (node_id, session_id)
    );

    CREATE TABLE IF NOT EXISTS self_model (
      id         TEXT PRIMARY KEY DEFAULT 'singleton',
      identity   TEXT NOT NULL DEFAULT '',
      goals      TEXT NOT NULL DEFAULT '[]',
      user_model TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS meta_kv (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS node_associations (
      node_id_a        TEXT NOT NULL,
      node_id_b        TEXT NOT NULL,
      count            INTEGER NOT NULL DEFAULT 1,
      strength         REAL NOT NULL DEFAULT 0.1,
      last_coactivated INTEGER NOT NULL,
      PRIMARY KEY (node_id_a, node_id_b)
    );

    CREATE INDEX IF NOT EXISTS assoc_a ON node_associations(node_id_a, strength DESC);
    CREATE INDEX IF NOT EXISTS assoc_b ON node_associations(node_id_b, strength DESC);

    CREATE TRIGGER IF NOT EXISTS nodes_fts_insert AFTER INSERT ON nodes BEGIN
      INSERT INTO nodes_fts(rowid, id, label, content, type)
      VALUES (new.rowid, new.id, new.label, new.content, new.type);
    END;
    -- WHEN clause prevents every neuromodulator/salience/retrievability UPDATE from
    -- triggering an FTS5 rewrite. Per code-2 F1.3: trigger should only fire when
    -- an FTS-indexed column actually changed.
    CREATE TRIGGER IF NOT EXISTS nodes_fts_update AFTER UPDATE ON nodes
    WHEN new.label IS NOT old.label OR new.content IS NOT old.content OR new.type IS NOT old.type
    BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, id, label, content, type)
      VALUES ('delete', old.rowid, old.id, old.label, old.content, old.type);
      INSERT INTO nodes_fts(rowid, id, label, content, type)
      VALUES (new.rowid, new.id, new.label, new.content, new.type);
    END;
    CREATE TRIGGER IF NOT EXISTS nodes_fts_delete AFTER DELETE ON nodes BEGIN
      INSERT INTO nodes_fts(nodes_fts, rowid, id, label, content, type)
      VALUES ('delete', old.rowid, old.id, old.label, old.content, old.type);
    END;
    CREATE TRIGGER IF NOT EXISTS episodes_fts_insert AFTER INSERT ON episodes BEGIN
      INSERT INTO episodes_fts(rowid, id, content, role)
      VALUES (new.rowid, new.id, new.content, new.role);
    END;
    CREATE TRIGGER IF NOT EXISTS episodes_fts_update AFTER UPDATE ON episodes
    WHEN new.content IS NOT old.content OR new.role IS NOT old.role
    BEGIN
      INSERT INTO episodes_fts(episodes_fts, rowid, id, content, role)
      VALUES ('delete', old.rowid, old.id, old.content, old.role);
      INSERT INTO episodes_fts(rowid, id, content, role)
      VALUES (new.rowid, new.id, new.content, new.role);
    END;
    CREATE TRIGGER IF NOT EXISTS episodes_fts_delete AFTER DELETE ON episodes BEGIN
      INSERT INTO episodes_fts(episodes_fts, rowid, id, content, role)
      VALUES ('delete', old.rowid, old.id, old.content, old.role);
    END;

    CREATE INDEX IF NOT EXISTS nodes_type_salience  ON nodes(type, salience DESC);
    CREATE INDEX IF NOT EXISTS episodes_created     ON episodes(created_at DESC);
    -- nodes_consolidated and episodes_created_importance are created in runMigrations
    -- (v10/v13). When migrating from a pre-v10 DB the nodes/episodes table exists
    -- without those columns, so an index DDL here would fail before the migration
    -- adds the columns. Fresh DBs pick them up via the v10/v13 migration steps.
  `);

  // Migrate self_model: add created_at/updated_at if the table existed before v7
  try { db.exec("ALTER TABLE self_model ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE self_model ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }

  // Seed self_model singleton if not present
  const now = Date.now();
  db.prepare(
    "INSERT OR IGNORE INTO self_model (id, identity, goals, user_model, created_at, updated_at) VALUES ('singleton', '', '[]', '{}', ?, ?)"
  ).run(now, now);
  // Backfill any rows where migration set columns to 0
  db.prepare("UPDATE self_model SET created_at = ?, updated_at = ? WHERE created_at = 0").run(now, now);

  // nodes_vec virtual table (only if sqlite-vec loaded successfully).
  // v15 switches the primary embedding model to openrouter/baai/bge-m3 (1024-dim)
  // per openrouter-paid-models.md 2026-05-17 audit. Fresh brain.dbs get this dim
  // directly; existing v3/v4 brain.dbs migrate through v11 (768) and v15 (1024).
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_vec USING vec0(
        embedding float[1024]
      );
    `);
  } catch {
    // sqlite-vec not loaded, skip vector table
  }
}

function runMigrations(db: Database.Database): void {
  const TARGET = 17;
  const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | undefined;
  const current = row?.version ?? 0;

  if (current >= TARGET) return;

  // Apply incremental column additions (all idempotent via try/catch)
  if (current < 2) {
    try { db.exec("ALTER TABLE nodes ADD COLUMN emotional_weight REAL NOT NULL DEFAULT 0.0"); } catch { /* already exists */ }
    try { db.exec("ALTER TABLE nodes ADD COLUMN eligibility_trace REAL NOT NULL DEFAULT 0.0"); } catch { /* already exists */ }
  }
  if (current < 3) {
    try { db.exec("ALTER TABLE nodes ADD COLUMN embedding BLOB"); } catch { /* already exists */ }
  }
  if (current < 4) {
    try { db.exec("ALTER TABLE nodes ADD COLUMN encoding_context TEXT"); } catch { /* already exists */ }
    try { db.exec("ALTER TABLE nodes ADD COLUMN extraction_confidence REAL NOT NULL DEFAULT 1.0"); } catch { /* already exists */ }
    try { db.exec("ALTER TABLE nodes ADD COLUMN ripple_count INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
    try { db.exec("ALTER TABLE episodes ADD COLUMN ripple_count INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
    // FTS5 content tables don't auto-populate on creation — rebuild index from existing rows
    try { db.exec("INSERT INTO episodes_fts(episodes_fts) VALUES('rebuild')"); } catch { /* ok */ }
  }
  if (current < 5) {
    // Hebbian co-activation tracking table (idempotent — CREATE TABLE IF NOT EXISTS)
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS node_associations (
          node_id_a        TEXT NOT NULL,
          node_id_b        TEXT NOT NULL,
          count            INTEGER NOT NULL DEFAULT 1,
          strength         REAL NOT NULL DEFAULT 0.1,
          last_coactivated INTEGER NOT NULL,
          PRIMARY KEY (node_id_a, node_id_b)
        );
        CREATE INDEX IF NOT EXISTS assoc_a ON node_associations(node_id_a, strength DESC);
        CREATE INDEX IF NOT EXISTS assoc_b ON node_associations(node_id_b, strength DESC);
      `);
    } catch { /* already exists */ }
  }

  if (current < 6) {
    // Rebuild nodes_vec with 1536-dim for OpenAI text-embedding-3-small (was 768)
    // All prior embeddings were null (stub), so no data is lost
    try {
      db.exec("DROP TABLE IF EXISTS nodes_vec");
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS nodes_vec USING vec0(
          embedding float[1536]
        );
      `);
    } catch { /* sqlite-vec not loaded — vector search remains FTS-only */ }
  }

  if (current < 7) {
    // Add created_at/updated_at to self_model (already done in initSchema for safety, repeat here for cleanliness)
    try { db.exec("ALTER TABLE self_model ADD COLUMN created_at INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
    try { db.exec("ALTER TABLE self_model ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
    const ts = Date.now();
    db.prepare("UPDATE self_model SET created_at = ?, updated_at = ? WHERE created_at = 0").run(ts, ts);
  }

  if (current < 8) {
    // ef (ease factor for spaced repetition) was in initSchema but never in a migration — add to all existing DBs
    try { db.exec("ALTER TABLE nodes ADD COLUMN ef REAL NOT NULL DEFAULT 2.5"); } catch { /* already exists */ }
  }

  if (current < 9) {
    // Migrate brain_meta → meta_kv (the old extension used brain_meta; new code uses meta_kv).
    // Copy any entries not already in meta_kv so last_consolidation timestamps survive.
    try {
      const hasBrainMeta = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='brain_meta'"
      ).get();
      if (hasBrainMeta) {
        const rows = db.prepare("SELECT key, value FROM brain_meta").all() as { key: string; value: string }[];
        const upsert = db.prepare("INSERT OR IGNORE INTO meta_kv (key, value) VALUES (?, ?)");
        for (const r of rows) upsert.run(r.key, r.value);
      }
    } catch { /* brain_meta missing — nothing to migrate */ }

    // Migrate consolidation_state → meta_kv if keys not already set.
    // Old v2 DB used a consolidation_state table; new code uses meta_kv keys.
    try {
      const hasConsolidationState = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='consolidation_state'"
      ).get();
      if (hasConsolidationState) {
        const row = db.prepare("SELECT last_run_at, last_episode_count FROM consolidation_state LIMIT 1").get() as
          { last_run_at: number; last_episode_count: number } | undefined;
        if (row) {
          const upsert = db.prepare("INSERT OR IGNORE INTO meta_kv (key, value) VALUES (?, ?)");
          upsert.run("last_consolidation", String(row.last_run_at));
          upsert.run("last_consolidation_episode_count", String(row.last_episode_count));
        }
      }
    } catch { /* consolidation_state missing — nothing to migrate */ }

    // The old episodes_fts virtual table only had (content) — no id or role columns.
    // The new initSchema adds a episodes_fts_update trigger that references id and role,
    // causing SqliteError on every UPDATE episodes call (e.g. ripple_count bump during consolidation).
    // Fix: drop and recreate episodes_fts with the new schema, then reset all 3 triggers.
    try {
      db.exec("DROP TABLE IF EXISTS episodes_fts");
      db.exec(`
        CREATE VIRTUAL TABLE episodes_fts USING fts5(
          id UNINDEXED, content, role UNINDEXED,
          content=episodes, content_rowid=rowid
        )
      `);
      db.exec("DROP TRIGGER IF EXISTS episodes_fts_insert");
      db.exec("DROP TRIGGER IF EXISTS episodes_fts_update");
      db.exec("DROP TRIGGER IF EXISTS episodes_fts_delete");
      db.exec(`
        CREATE TRIGGER episodes_fts_insert AFTER INSERT ON episodes BEGIN
          INSERT INTO episodes_fts(rowid, id, content, role)
          VALUES (new.rowid, new.id, new.content, new.role);
        END
      `);
      db.exec(`
        CREATE TRIGGER episodes_fts_update AFTER UPDATE ON episodes BEGIN
          INSERT INTO episodes_fts(episodes_fts, rowid, id, content, role)
          VALUES ('delete', old.rowid, old.id, old.content, old.role);
          INSERT INTO episodes_fts(rowid, id, content, role)
          VALUES (new.rowid, new.id, new.content, new.role);
        END
      `);
      db.exec(`
        CREATE TRIGGER episodes_fts_delete AFTER DELETE ON episodes BEGIN
          INSERT INTO episodes_fts(episodes_fts, rowid, id, content, role)
          VALUES ('delete', old.rowid, old.id, old.content, old.role);
        END
      `);
      db.exec("INSERT INTO episodes_fts(episodes_fts) VALUES('rebuild')");
    } catch { /* ok — already on new schema */ }

    // Same for nodes_fts: old schema had (label, content); new schema adds id and type.
    // Not crashing yet but would fail if update triggers referenced new columns.
    // Proactively drop and rebuild for consistency.
    try {
      db.exec("DROP TABLE IF EXISTS nodes_fts");
      db.exec(`
        CREATE VIRTUAL TABLE nodes_fts USING fts5(
          id UNINDEXED, label, content, type UNINDEXED,
          content=nodes, content_rowid=rowid
        )
      `);
      db.exec("DROP TRIGGER IF EXISTS nodes_fts_insert");
      db.exec("DROP TRIGGER IF EXISTS nodes_fts_update");
      db.exec("DROP TRIGGER IF EXISTS nodes_fts_delete");
      db.exec(`
        CREATE TRIGGER nodes_fts_insert AFTER INSERT ON nodes BEGIN
          INSERT INTO nodes_fts(rowid, id, label, content, type)
          VALUES (new.rowid, new.id, new.label, new.content, new.type);
        END
      `);
      db.exec(`
        CREATE TRIGGER nodes_fts_update AFTER UPDATE ON nodes BEGIN
          INSERT INTO nodes_fts(nodes_fts, rowid, id, label, content, type)
          VALUES ('delete', old.rowid, old.id, old.label, old.content, old.type);
          INSERT INTO nodes_fts(rowid, id, label, content, type)
          VALUES (new.rowid, new.id, new.label, new.content, new.type);
        END
      `);
      db.exec(`
        CREATE TRIGGER nodes_fts_delete AFTER DELETE ON nodes BEGIN
          INSERT INTO nodes_fts(nodes_fts, rowid, id, label, content, type)
          VALUES ('delete', old.rowid, old.id, old.label, old.content, old.type);
        END
      `);
      db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
    } catch { /* ok — already on new schema */ }
  }

  if (current < 10) {
    // v10 — parent agent's Phase 1 migration baseline. Mirror in runMigrations so
    // fresh DBs created via initSchema get a consistent column set. Both pieces of
    // DDL are idempotent (column exists → swallow; index uses IF NOT EXISTS).
    try { db.exec("ALTER TABLE episodes ADD COLUMN llm_extracted INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
    try { db.exec("CREATE INDEX IF NOT EXISTS episodes_created_importance ON episodes(created_at DESC, importance)"); } catch { /* ok */ }
  }

  if (current < 11) {
    // v11→v15 — primary embedding model switched to openrouter/baai/bge-m3
    // (1024-dim) per openrouter-paid-models.md 2026-05-17. Existing 1536-dim or
    // 768-dim embeddings are dimension-incompatible. embeddings.ts lazy-requeues
    // nodes on next access; vector search degrades to FTS-only during rebuild.
    try {
      db.exec("DROP TABLE IF EXISTS nodes_vec");
      db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS nodes_vec USING vec0(embedding float[1024])");
    } catch { /* sqlite-vec not loaded — vector search degrades to FTS-only */ }
  }

  if (current < 12) {
    // v12 — FSRS-6 columns. SM-2's `ef` is kept for backcompat read path; new
    // code stops writing to it. `stability` semantics change to FSRS interpretation
    // but the column itself is reused (existing values converge after a few reviews).
    try { db.exec("ALTER TABLE nodes ADD COLUMN difficulty REAL NOT NULL DEFAULT 5.0"); } catch { /* already exists */ }
    try { db.exec("ALTER TABLE nodes ADD COLUMN last_review INTEGER"); } catch { /* already exists */ }
    try { db.exec("ALTER TABLE nodes ADD COLUMN review_count INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
  }

  if (current < 13) {
    // v13 — CLS two-store split. Hippocampal-analog (is_consolidated=0) is
    // fast/sparse/high-decay; cortical-analog (is_consolidated=1) is slow/dense/low-decay.
    // Promotion happens in consolidation.ts (Build Agent B) on review_count >= 5
    // AND retrievability >= 0.7.
    try { db.exec("ALTER TABLE nodes ADD COLUMN is_consolidated INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
    try { db.exec("ALTER TABLE nodes ADD COLUMN consolidated_at INTEGER"); } catch { /* already exists */ }
    try { db.exec("CREATE INDEX IF NOT EXISTS nodes_consolidated ON nodes(is_consolidated, retrievability)"); } catch { /* ok */ }
  }

  if (current < 14) {
    // v14 — pattern separation hash (Bakker et al. CA3/DG analog).
    // ps_hash is a top-K sparse projection of the embedding (K=32 bits packed in 4 bytes).
    // entity-resolution uses Hamming distance as a fast pre-filter before cosine.
    try { db.exec("ALTER TABLE nodes ADD COLUMN ps_hash BLOB"); } catch { /* already exists */ }
  }

  if (current < 15) {
    // v15 — temporal validity windows on semantic fact nodes (Zep/Graphiti pattern).
    // valid_from: epoch-ms when the underlying fact became true (NULL = unknown/always).
    // valid_until: epoch-ms when the fact was superseded or expired (NULL = still current).
    // checkReconsolidation sets valid_until=now when it writes a `supersedes` edge.
    // Retrieval queries filter (valid_until IS NULL OR valid_until > now) to exclude stale facts.
    try { db.exec("ALTER TABLE nodes ADD COLUMN valid_from INTEGER"); } catch { /* already exists */ }
    try { db.exec("ALTER TABLE nodes ADD COLUMN valid_until INTEGER"); } catch { /* already exists */ }
    try { db.exec("CREATE INDEX IF NOT EXISTS nodes_valid_until ON nodes(valid_until) WHERE valid_until IS NOT NULL"); } catch { /* ok */ }
  }

  if (current < 16) {
    // v16 — SIGMA per-node FSRS calibration. Each node accumulates a JSON review
    // history and a stability_sigma multiplier fit from observed vs. FSRS-predicted
    // stability growth. Sigma drifts away from 1.0 as Marley's per-concept recall
    // pattern diverges from the population-average FSRS-6 weights.
    try { db.exec("ALTER TABLE nodes ADD COLUMN review_history TEXT"); } catch { /* already exists */ }
    try { db.exec("ALTER TABLE nodes ADD COLUMN stability_sigma REAL NOT NULL DEFAULT 1.0"); } catch { /* already exists */ }
  }

  if (current < 17) {
    // v17 — VALOR utility gating (Anderson & Schooler 1991 rational analysis /
    // ACT-R utility learning; Lisman-Grace VTA reward gating). inject_count is
    // incremented when a node was injected into a prompt AND the assistant
    // reply was observed (both sides required — a dropped llm_output hook must
    // not poison utility). inject_hits increments when the reply referenced
    // the node. Recall ranking demotes chronically-ignored nodes.
    // (Ported from clawbrain-v4/src/db.ts:494-495, which numbers it v18 in that
    // tree; sharpwave's schema was at v16, so it lands here as v17. Additive
    // only — backfills to 0 on every existing brain.db.)
    try { db.exec("ALTER TABLE nodes ADD COLUMN inject_count INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
    try { db.exec("ALTER TABLE nodes ADD COLUMN inject_hits INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }
  }

  // Refresh FTS5 update triggers to include the WHEN clauses (code-2 F1.3). Old triggers
  // installed by v9 fire on every UPDATE — including salience/retrievability/etc. — which
  // produces massive FTS write amplification. The new triggers only fire when an
  // FTS-indexed column actually changed. Safe to drop/recreate (idempotent triggers).
  if (current < 14) {
    try {
      db.exec("DROP TRIGGER IF EXISTS nodes_fts_update");
      db.exec(`
        CREATE TRIGGER nodes_fts_update AFTER UPDATE ON nodes
        WHEN new.label IS NOT old.label OR new.content IS NOT old.content OR new.type IS NOT old.type
        BEGIN
          INSERT INTO nodes_fts(nodes_fts, rowid, id, label, content, type)
          VALUES ('delete', old.rowid, old.id, old.label, old.content, old.type);
          INSERT INTO nodes_fts(rowid, id, label, content, type)
          VALUES (new.rowid, new.id, new.label, new.content, new.type);
        END
      `);
      db.exec("DROP TRIGGER IF EXISTS episodes_fts_update");
      db.exec(`
        CREATE TRIGGER episodes_fts_update AFTER UPDATE ON episodes
        WHEN new.content IS NOT old.content OR new.role IS NOT old.role
        BEGIN
          INSERT INTO episodes_fts(episodes_fts, rowid, id, content, role)
          VALUES ('delete', old.rowid, old.id, old.content, old.role);
          INSERT INTO episodes_fts(rowid, id, content, role)
          VALUES (new.rowid, new.id, new.content, new.role);
        END
      `);
    } catch { /* FTS tables may be missing on degenerate DBs — fresh init created them above */ }
  }

  // Rebuild both FTS indexes to cover rows that existed before triggers were wired.
  // Safe to run multiple times — FTS5 rebuild is idempotent.
  try { db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')"); } catch { /* ok */ }
  try { db.exec("INSERT INTO episodes_fts(episodes_fts) VALUES('rebuild')"); } catch { /* ok */ }

  // Write final version atomically — transaction prevents crash-between-delete-and-insert corruption
  db.transaction(() => {
    db.prepare("DELETE FROM schema_version").run();
    db.prepare("INSERT INTO schema_version VALUES (?)").run(TARGET);
  })();
}

export function closeDb(agentId: string): void {
  const db = dbs.get(agentId);
  if (db) { db.close(); dbs.delete(agentId); }
}

export function closeAllDbs(): void {
  for (const [agentId, db] of dbs) {
    db.close();
    dbs.delete(agentId);
  }
}

export function getMeta(agentId: string, key: string): string | null {
  const db = getDb(agentId);
  const row = db.prepare("SELECT value FROM meta_kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(agentId: string, key: string, value: string): void {
  const db = getDb(agentId);
  executeWithWalRetrySync(
    db,
    (d) => { d.prepare("INSERT OR REPLACE INTO meta_kv (key, value) VALUES (?, ?)").run(key, value); },
    { op: `meta.set:${key}` },
  );
  bumpWriteCounter(db);
}
