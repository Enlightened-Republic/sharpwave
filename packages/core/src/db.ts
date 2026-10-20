import { envGet, resolveDataDir } from "./env.js";
import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
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
  const raw = envGet("FTS_OPTIMIZE_EVERY");
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
  const explicit = envGet("DB_PATH");
  if (explicit) return explicit;
  const dataDir = resolveDataDir();
  return join(dataDir, agentId, "brain.db");
}

/** Default SQLite busy_timeout (ms) applied to every brain connection. */
export const DEFAULT_BUSY_TIMEOUT_MS = 5000;
/** Upper bound for a configured busy_timeout — a stuck writer should surface, not hang forever. */
const MAX_BUSY_TIMEOUT_MS = 600_000;

/**
 * Resolve the busy_timeout (ms) for a new connection.
 *
 * Precedence: explicit `override` (from `getDb(agentId, { busyTimeoutMs })`)
 * → `SHARPWAVE_BUSY_TIMEOUT_MS` env → DEFAULT_BUSY_TIMEOUT_MS (5000).
 * Non-numeric / negative values fall back to the default; values above
 * MAX_BUSY_TIMEOUT_MS are clamped. `0` is honoured (disables waiting — SQLite
 * then returns SQLITE_BUSY immediately and wal-retry.ts is the only backstop).
 */
export function resolveBusyTimeoutMs(override?: number): number {
  const pick = (v: unknown): number | undefined => {
    if (v === undefined || v === null || v === "") return undefined;
    const n = typeof v === "number" ? v : Number(v);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return Math.min(Math.floor(n), MAX_BUSY_TIMEOUT_MS);
  };
  return pick(override)
    ?? pick(envGet("BUSY_TIMEOUT_MS"))
    ?? DEFAULT_BUSY_TIMEOUT_MS;
}

export interface GetDbOptions {
  /**
   * SQLite busy_timeout in ms for this connection. Only takes effect when the
   * connection is first opened (connections are cached per agentId).
   * Defaults to `SHARPWAVE_BUSY_TIMEOUT_MS` or 5000.
   */
  busyTimeoutMs?: number;
}

export function getDb(agentId: string, opts: GetDbOptions = {}): Database.Database {
  if (dbs.has(agentId)) return dbs.get(agentId)!;

  const path = resolveDbPath(agentId);
  const dir = path.replace(/[/\\][^/\\]+$/, "");
  mkdirSync(dir, { recursive: true });

  const busyTimeoutMs = resolveBusyTimeoutMs(opts.busyTimeoutMs);
  const db = new Database(path, { timeout: busyTimeoutMs });
  // busy_timeout FIRST: journal_mode=WAL and the schema/migration DDL below
  // all need locks, and a second process opening the same brain.db at the same
  // moment would otherwise get SQLITE_BUSY straight away. better-sqlite3's
  // `timeout` option sets the same thing; the explicit PRAGMA makes the value
  // visible/auditable (`PRAGMA busy_timeout`) and independent of driver defaults.
  // This complements (does not replace) the wal-retry.ts backoff, which still
  // catches SQLITE_BUSY_SNAPSHOT (a deferred read txn upgrading to write) —
  // the one busy case SQLite will not wait out.
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
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
      writer_agent_id       TEXT,
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
      meta        TEXT,
      writer_agent_id TEXT
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
      meta          TEXT,
      writer_agent_id TEXT
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
    -- Same for nodes_writer_agent (v18 writer_agent_id provenance).
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

/** Current brain.db schema version (v19 = Xanima 0.1.0 belief metadata, v20 = 0.2.0 decisions + goals, v21 = 0.2.0 draft expiry / note acks / lesson merges). */
export const SCHEMA_VERSION = 28;

/**
 * v19 — Xanima 0.1.0 belief metadata. Additive only (ADD COLUMN with constant
 * defaults is O(1) in SQLite: existing rows read the default, nothing is
 * rewritten), so node/edge/episode counts never change. Backfill semantics:
 *   • source_type   'legacy'  (origin unknown — written before Xanima)
 *   • confidence    'medium' / confidence_score 0.6
 *   • status        'active', except nodes that were already closed
 *                   (valid_until in the past): 'superseded' when a supersedes
 *                   edge points at them, else 'archived' (e.g. noise-retired).
 *                   This is the only UPDATE and it touches closed rows only.
 *   • sensitivity   'normal'
 * Idempotent: safe to re-run (every step swallows "duplicate column").
 * Exported so `xanima-server migrate` and tests can call it directly.
 */
export function migrateV19(db: Database.Database): void {
  const add = (sql: string) => { try { db.exec(sql); } catch { /* already exists */ } };
  add("ALTER TABLE nodes ADD COLUMN confidence TEXT NOT NULL DEFAULT 'medium'");
  add("ALTER TABLE nodes ADD COLUMN confidence_score REAL NOT NULL DEFAULT 0.6");
  add("ALTER TABLE nodes ADD COLUMN source_type TEXT NOT NULL DEFAULT 'legacy'");
  add("ALTER TABLE nodes ADD COLUMN verified_at INTEGER");
  add("ALTER TABLE nodes ADD COLUMN contradicted_at INTEGER");
  add("ALTER TABLE nodes ADD COLUMN evidence TEXT");
  add("ALTER TABLE nodes ADD COLUMN status TEXT NOT NULL DEFAULT 'active'");
  add("ALTER TABLE nodes ADD COLUMN status_reason TEXT");
  add("ALTER TABLE nodes ADD COLUMN status_changed_at INTEGER");
  add("ALTER TABLE nodes ADD COLUMN sensitivity TEXT NOT NULL DEFAULT 'normal'");
  add("ALTER TABLE nodes ADD COLUMN review_flagged_at INTEGER");
  add("CREATE INDEX IF NOT EXISTS nodes_status ON nodes(status)");
  add("CREATE INDEX IF NOT EXISTS nodes_review ON nodes(review_flagged_at) WHERE review_flagged_at IS NOT NULL");
  try {
    db.prepare(`
      UPDATE nodes SET
        status = CASE WHEN EXISTS (
            SELECT 1 FROM edges e WHERE e.to_id = nodes.id AND e.type = 'supersedes'
          ) THEN 'superseded' ELSE 'archived' END,
        status_changed_at = valid_until
      WHERE status = 'active' AND valid_until IS NOT NULL AND valid_until <= ?
    `).run(Date.now());
  } catch { /* edges table missing on a degenerate DB — leave active */ }
}

/**
 * v20 — Xanima 0.2.0 decision ledger + goals/drift. New tables only
 * (CREATE TABLE IF NOT EXISTS); nodes/edges/episodes are never touched, so
 * their counts cannot change. Existing `goal` nodes that are still active get
 * a goals row (version 1, priority 3) with tracked = 0: they keep showing in
 * the header as before but are not drift-checked until the agent (or the user)
 * opts them in with brain_update_goal action "track". Idempotent.
 */
export function migrateV20(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS decisions (
      node_id              TEXT PRIMARY KEY,
      context              TEXT NOT NULL,
      goal_id              TEXT,
      options_json         TEXT NOT NULL DEFAULT '[]',
      chosen               TEXT NOT NULL,
      rationale            TEXT,
      predicted_outcome    TEXT,
      predicted_confidence REAL,
      outcome              TEXT,
      outcome_status       TEXT,
      outcome_at           INTEGER,
      lesson               TEXT,
      lesson_node_id       TEXT,
      merged_into          TEXT,
      merge_count          INTEGER NOT NULL DEFAULT 1,
      auto_extracted       INTEGER NOT NULL DEFAULT 0,
      created_at           INTEGER NOT NULL,
      updated_at           INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS decisions_goal ON decisions(goal_id);
    CREATE INDEX IF NOT EXISTS decisions_created ON decisions(created_at);
    CREATE TABLE IF NOT EXISTS goals (
      node_id           TEXT PRIMARY KEY,
      lineage_id        TEXT NOT NULL,
      version           INTEGER NOT NULL,
      title             TEXT NOT NULL,
      priority          INTEGER NOT NULL DEFAULT 3,
      status            TEXT NOT NULL DEFAULT 'active',
      success_criteria  TEXT,
      keywords_json     TEXT NOT NULL DEFAULT '[]',
      tracked           INTEGER NOT NULL DEFAULT 1,
      last_checked_at   INTEGER,
      last_progress_at  INTEGER,
      alignment_summary TEXT,
      drift_kind        TEXT,
      drift_reason      TEXT,
      drift_at          INTEGER,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS goals_lineage ON goals(lineage_id, version);
    CREATE INDEX IF NOT EXISTS goals_status ON goals(status);
    CREATE TABLE IF NOT EXISTS goal_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      lineage_id  TEXT NOT NULL,
      version     INTEGER NOT NULL,
      node_id     TEXT NOT NULL,
      at          INTEGER NOT NULL,
      action      TEXT NOT NULL,
      change_json TEXT,
      reason      TEXT
    );
    CREATE INDEX IF NOT EXISTS goal_events_lineage ON goal_events(lineage_id, at);
    CREATE TABLE IF NOT EXISTS goal_triggers (
      id            TEXT PRIMARY KEY,
      lineage_id    TEXT NOT NULL,
      kind          TEXT NOT NULL,
      spec_json     TEXT NOT NULL,
      next_at       INTEGER,
      cooldown_ms   INTEGER NOT NULL DEFAULT 21600000,
      last_fired_at INTEGER,
      fire_count    INTEGER NOT NULL DEFAULT 0,
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS goal_triggers_lineage ON goal_triggers(lineage_id);
    CREATE TABLE IF NOT EXISTS alignment_notes (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at       INTEGER NOT NULL,
      text             TEXT NOT NULL,
      lineage_ids_json TEXT NOT NULL DEFAULT '[]',
      delivered_at     INTEGER,
      superseded_at    INTEGER
    );
  `);
  try {
    const now = Date.now();
    const statusCol = (db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string }>).some((c) => c.name === "status");
    const rows = db.prepare(`SELECT id, label, created_at FROM nodes WHERE type = 'goal' AND (valid_until IS NULL OR valid_until > ?)${statusCol ? " AND status = 'active'" : ""}
                              AND id NOT IN (SELECT node_id FROM goals)`).all(now) as Array<{ id: string; label: string; created_at: number }>;
    const ins = db.prepare(`INSERT OR IGNORE INTO goals (node_id, lineage_id, version, title, priority, status, keywords_json, tracked, created_at, updated_at)
                            VALUES (?, ?, 1, ?, 3, 'active', '[]', 0, ?, ?)`);
    const ev = db.prepare(`INSERT INTO goal_events (lineage_id, version, node_id, at, action, reason) VALUES (?, 1, ?, ?, 'backfill', 'existing goal node (pre-0.2.0), not drift-checked until tracked')`);
    db.transaction(() => { for (const r of rows) { ins.run(r.id, r.id, r.label, r.created_at ?? now, now); ev.run(r.id, r.id, now); } })();
  } catch { /* nodes table missing on a degenerate DB */ }
}

/**
 * v21 (Xanima 0.2.0 hardening, additive):
 *   decisions.draft_status ('pending' | 'confirmed' | 'expired' for auto-extracted drafts, NULL otherwise), confirmed_at, expired_at
 *   alignment_notes.offered_at / offered_count (offered ≠ delivered; delivered only on a real reply)
 *   lesson_merges: history of lessons merged into an existing skill instead of a new one
 */
export function migrateV21(db: Database.Database): void {
  const add = (t: string, c: string) => { try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${c}`); } catch { /* already exists */ } };
  add("decisions", "draft_status TEXT");
  add("decisions", "confirmed_at INTEGER");
  add("decisions", "expired_at INTEGER");
  add("alignment_notes", "offered_at INTEGER");
  add("alignment_notes", "offered_count INTEGER NOT NULL DEFAULT 0");
  db.exec(`
    CREATE TABLE IF NOT EXISTS lesson_merges (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id      TEXT NOT NULL,
      decision_id   TEXT NOT NULL,
      lesson        TEXT NOT NULL,
      similarity    REAL NOT NULL,
      method        TEXT NOT NULL,
      confidence_before REAL,
      confidence_after  REAL,
      at            INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS lesson_merges_skill ON lesson_merges(skill_id);
  `);
  try { db.exec("UPDATE decisions SET draft_status = 'pending' WHERE auto_extracted = 1 AND draft_status IS NULL AND outcome_at IS NULL"); } catch { /* ok */ }
  try { db.exec("UPDATE alignment_notes SET offered_count = 1, offered_at = delivered_at WHERE delivered_at IS NOT NULL AND offered_count = 0"); } catch { /* ok */ }
}

/**
 * v22 (Xanima 0.3.0, additive, new tables + one column set):
 *   reflections, open_items (hypothesis | question | assumption), commitments,
 *   plans + plan_steps, dependencies (blocked-by between any two nodes),
 *   alignment_notes.kind / ref_id (the note queue also carries commitment nudges).
 */
export function migrateV22(db: Database.Database): void {
  const add = (t: string, c: string) => { try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${c}`); } catch { /* already exists */ } };
  db.exec(`
    CREATE TABLE IF NOT EXISTS reflections (
      node_id       TEXT PRIMARY KEY,
      scope_kind    TEXT NOT NULL,
      scope_ref     TEXT,
      since         INTEGER NOT NULL,
      until         INTEGER NOT NULL,
      worked_json   TEXT NOT NULL DEFAULT '[]',
      didnt_json    TEXT NOT NULL DEFAULT '[]',
      next_json     TEXT NOT NULL DEFAULT '[]',
      sources_json  TEXT NOT NULL DEFAULT '[]',
      origin        TEXT NOT NULL,
      method        TEXT NOT NULL,
      merge_count   INTEGER NOT NULL DEFAULT 1,
      history_json  TEXT NOT NULL DEFAULT '[]',
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS reflections_scope ON reflections(scope_kind, scope_ref);
    CREATE TABLE IF NOT EXISTS open_items (
      node_id         TEXT PRIMARY KEY,
      kind            TEXT NOT NULL,
      text            TEXT NOT NULL,
      status          TEXT NOT NULL DEFAULT 'open',
      load_bearing    INTEGER NOT NULL DEFAULT 0,
      evidence_for    TEXT NOT NULL DEFAULT '[]',
      evidence_against TEXT NOT NULL DEFAULT '[]',
      answer          TEXT,
      close_reason    TEXT,
      auto_extracted  INTEGER NOT NULL DEFAULT 0,
      draft_status    TEXT,
      keywords_json   TEXT NOT NULL DEFAULT '[]',
      contradicted_at INTEGER,
      last_surfaced_at INTEGER,
      surfaced_count  INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      closed_at       INTEGER
    );
    CREATE INDEX IF NOT EXISTS open_items_status ON open_items(kind, status);
    CREATE TABLE IF NOT EXISTS commitments (
      node_id       TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      owner         TEXT NOT NULL,
      counterparty  TEXT NOT NULL DEFAULT 'user',
      status        TEXT NOT NULL DEFAULT 'open',
      due_at        INTEGER,
      note          TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      done_at       INTEGER,
      last_nudged_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS commitments_status ON commitments(status, due_at);
    CREATE TABLE IF NOT EXISTS plans (
      node_id       TEXT PRIMARY KEY,
      title         TEXT NOT NULL,
      goal_id       TEXT,
      status        TEXT NOT NULL DEFAULT 'active',
      keywords_json TEXT NOT NULL DEFAULT '[]',
      parked_at     INTEGER,
      park_note     TEXT,
      resumed_at    INTEGER,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plan_steps (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      plan_id    TEXT NOT NULL,
      idx        INTEGER NOT NULL,
      text       TEXT NOT NULL,
      status     TEXT NOT NULL DEFAULT 'todo',
      note       TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS plan_steps_plan ON plan_steps(plan_id, idx);
    CREATE TABLE IF NOT EXISTS dependencies (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      blocked_id  TEXT NOT NULL,
      blocker_id  TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      resolved_at INTEGER,
      UNIQUE(blocked_id, blocker_id)
    );
    CREATE INDEX IF NOT EXISTS dependencies_blocked ON dependencies(blocked_id);
  `);
  add("alignment_notes", "kind TEXT NOT NULL DEFAULT 'alignment'");
  add("alignment_notes", "ref_id TEXT");
}

/**
 * v23 (Xanima 0.4.0 Soul Package, additive, new tables only):
 *   review_items    pending-review queue (identity / goal / value changes from imports,
 *                   three-way merge conflicts, removals) — nothing is applied until accepted
 *   soul_id_map     origin id (in a package) ↔ local id (in this brain), per package
 *   soul_provenance original provenance of imported nodes (writer, source_type, confidence, times)
 *   soul_events     export / import / merge / review audit trail inside the brain
 */
export function migrateV23(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS review_items (
      id            TEXT PRIMARY KEY,
      kind          TEXT NOT NULL,
      section       TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'pending',
      package_id    TEXT,
      origin_id     TEXT,
      local_id      TEXT,
      label         TEXT NOT NULL,
      base_json     TEXT,
      ours_json     TEXT,
      theirs_json   TEXT,
      markers       TEXT,
      reason        TEXT,
      flags_json    TEXT NOT NULL DEFAULT '[]',
      created_at    INTEGER NOT NULL,
      resolved_at   INTEGER,
      resolved_by   TEXT,
      resolution_note TEXT
    );
    CREATE INDEX IF NOT EXISTS review_items_status ON review_items(status, created_at);
    CREATE TABLE IF NOT EXISTS soul_id_map (
      origin_id   TEXT NOT NULL,
      local_id    TEXT NOT NULL,
      package_id  TEXT NOT NULL,
      section     TEXT NOT NULL,
      at          INTEGER NOT NULL,
      PRIMARY KEY (origin_id, local_id)
    );
    CREATE INDEX IF NOT EXISTS soul_id_map_local ON soul_id_map(local_id);
    CREATE TABLE IF NOT EXISTS soul_provenance (
      local_id     TEXT PRIMARY KEY,
      origin_id    TEXT NOT NULL,
      package_id   TEXT NOT NULL,
      source_agent TEXT,
      writer       TEXT,
      source_type  TEXT,
      confidence   REAL,
      created_at   INTEGER,
      updated_at   INTEGER
    );
    CREATE TABLE IF NOT EXISTS soul_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      at          INTEGER NOT NULL,
      action      TEXT NOT NULL,
      package_id  TEXT,
      parent_id   TEXT,
      by          TEXT,
      detail_json TEXT
    );
  `);
}

/**
 * v24 (Xanima 0.5.0 rooms, additive, new tables only). Used by room brains
 * (`_room.<name>`); present but empty in private brains so every brain shares one schema.
 *   room_items      one row per published copy: who published which source node, when, status
 *   room_conflicts  conflicting assertions by different writers in the room (never overwritten)
 *   nodes.scope_tags  optional JSON list of project / category tags (focus suppression)
 */
export function migrateV24(db: Database.Database): void {
  // project / category tags used by brain_focus {suppress: ["project:x"]}
  try { db.exec("ALTER TABLE nodes ADD COLUMN scope_tags TEXT"); } catch { /* already exists */ }
  db.exec(`
    CREATE TABLE IF NOT EXISTS room_items (
      room_node_id    TEXT PRIMARY KEY,
      origin_agent    TEXT NOT NULL,
      origin_node_id  TEXT NOT NULL,
      origin_created_at INTEGER,
      published_at    INTEGER NOT NULL,
      status          TEXT NOT NULL DEFAULT 'active',
      withdrawn_at    INTEGER,
      withdrawn_reason TEXT
    );
    CREATE INDEX IF NOT EXISTS room_items_origin ON room_items(origin_agent, origin_node_id);
    CREATE TABLE IF NOT EXISTS room_conflicts (
      id          TEXT PRIMARY KEY,
      a_node_id   TEXT NOT NULL,
      b_node_id   TEXT NOT NULL,
      a_writer    TEXT,
      b_writer    TEXT,
      label       TEXT NOT NULL,
      reason      TEXT,
      status      TEXT NOT NULL DEFAULT 'open',
      created_at  INTEGER NOT NULL,
      resolved_at INTEGER,
      resolved_by TEXT
    );
  `);
}

/**
 * v25 (Xanima 0.5.0 follow-up: agent-evolved identity, additive, one new table).
 *   identity_changes  every identity / value change: applied ones carry a version (old + new value,
 *                     reason, provenance, writer, identity text after); held / rejected attempts too.
 */
export function migrateV25(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS identity_changes (
      id          TEXT PRIMARY KEY,
      version     INTEGER,
      status      TEXT NOT NULL,
      target      TEXT NOT NULL,
      action      TEXT NOT NULL,
      key         TEXT,
      old_value   TEXT,
      new_value   TEXT,
      old_node_id TEXT,
      new_node_id TEXT,
      reason      TEXT,
      provenance  TEXT,
      writer      TEXT,
      review_id   TEXT,
      reverts_version     INTEGER,
      reverted_by_version INTEGER,
      identity_after TEXT,
      detail      TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS identity_changes_version ON identity_changes(version) WHERE version IS NOT NULL;
    CREATE INDEX IF NOT EXISTS identity_changes_status ON identity_changes(status, created_at);
  `);
}

/**
 * v26 — indexes for the two full-table scans getNeuromodulatorState runs on
 * every turn (`COUNT(*) ... WHERE created_at > ?`, `AVG(...) WHERE accessed_at > ?`)
 * and the proactive monitor's `ORDER BY accessed_at DESC LIMIT 50`. On a
 * 60k-node brain those were ~0.3 s per call, three calls per turn.
 */
export function migrateV26(db: Database.Database): void {
  try { db.exec("CREATE INDEX IF NOT EXISTS nodes_created_at ON nodes(created_at)"); } catch { /* ok */ }
  try { db.exec("CREATE INDEX IF NOT EXISTS nodes_accessed_at ON nodes(accessed_at)"); } catch { /* ok */ }
}

/**
 * v27 — procedures: learning that became a step-by-step skill (procedures.ts).
 *   procedures      one row per compiled `procedural` node: the ordered steps, the
 *                   success / failure ledger, and when it was verified.
 *   procedure_runs  one row per plan that was counted (success / failure / skipped /
 *                   unmatched), so a plan never counts twice.
 * Additive; node / edge / episode counts never change.
 */
export function migrateV27(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS procedures (
      node_id         TEXT PRIMARY KEY,
      title           TEXT NOT NULL,
      steps_json      TEXT NOT NULL DEFAULT '[]',
      successes       INTEGER NOT NULL DEFAULT 0,
      failures        INTEGER NOT NULL DEFAULT 0,
      last_success_at INTEGER,
      last_failure_at INTEGER,
      verified_at     INTEGER,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS procedure_runs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      procedure_id TEXT,
      plan_id      TEXT NOT NULL UNIQUE,
      outcome      TEXT NOT NULL,
      at           INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS procedure_runs_proc ON procedure_runs(procedure_id, at);
  `);
}

/**
 * v28 — Xanima 0.7 current task + handoffs. Additive only.
 *   • task_frames: one row per session — what that session is working on
 *     right now (brain_now / set by brain_plan), injected every turn and
 *     preserved across host compaction.
 *   • plans / goals gain handoff_to / handoff_note / handoff_at: a plan or goal
 *     handed to another agent is status 'handed_off' — out of the goals header,
 *     drift checks, briefings and heartbeats until it is resumed (taken back).
 */
export function migrateV28(db: Database.Database): void {
  const add = (t: string, c: string) => { try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${c}`); } catch { /* already exists */ } };
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_frames (
      session_key TEXT PRIMARY KEY,
      title       TEXT NOT NULL,
      plan_id     TEXT,
      goal_id     TEXT,
      note        TEXT,
      set_by      TEXT NOT NULL DEFAULT 'agent',
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS task_frames_updated ON task_frames(updated_at);
  `);
  for (const t of ["plans", "goals"]) {
    add(t, "handoff_to TEXT");
    add(t, "handoff_note TEXT");
    add(t, "handoff_at INTEGER");
  }
}

function runMigrations(db: Database.Database): void {
  const TARGET = SCHEMA_VERSION;
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
    // stability growth. Sigma drifts away from 1.0 as the agent's per-concept recall
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

  if (current < 18) {
    // v18 — writer_agent_id provenance (shared-brain groundwork). Records WHICH
    // agent (or system process) created a node / episode / edge, so that once
    // several agents write into one brain (shared-brain service) every row can
    // be attributed. Nullable and additive only:
    //   • existing rows stay NULL = "written before provenance existed". We do
    //     NOT backfill from the brain's agent id: with SHARPWAVE_DB_PATH (or a
    //     copied/renamed brain dir) the opening agent id is not guaranteed to be
    //     the historical writer, and a wrong stamp is worse than an honest NULL.
    //     It also keeps the migration O(1) (no full-table rewrite).
    //   • new writes are stamped by nodes.ts / episodes.ts / edges.ts —
    //     default = the brain's own agentId; consolidation = "system:sleep".
    // Index on nodes only — "what did agent X write" is a node-level query;
    // episodes/edges are cheap to scan by session/node instead.
    try { db.exec("ALTER TABLE nodes ADD COLUMN writer_agent_id TEXT"); } catch { /* already exists */ }
    try { db.exec("ALTER TABLE episodes ADD COLUMN writer_agent_id TEXT"); } catch { /* already exists */ }
    try { db.exec("ALTER TABLE edges ADD COLUMN writer_agent_id TEXT"); } catch { /* already exists */ }
    try { db.exec("CREATE INDEX IF NOT EXISTS nodes_writer_agent ON nodes(writer_agent_id)"); } catch { /* ok */ }
  }

  if (current < 19) {
    migrateV19(db);
  }

  if (current < 20) {
    migrateV20(db);
  }

  if (current < 21) {
    migrateV21(db);
  }

  if (current < 22) {
    migrateV22(db);
  }

  if (current < 23) {
    migrateV23(db);
  }
  if (current < 24) {
    migrateV24(db);
  }
  if (current < 25) {
    migrateV25(db);
  }
  if (current < 26) {
    migrateV26(db);
  }
  if (current < 27) {
    migrateV27(db);
  }
  if (current < 28) {
    migrateV28(db);
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
