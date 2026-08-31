/**
 * Migration stress test — 7 scenarios.
 *
 * Each scenario builds an isolated DB at the real agent path, seeds it at a
 * specific schema version, calls getDb() to trigger runMigrations, and
 * verifies every row survived intact with correct column defaults.
 *
 * Uses unique UUIDs so no two scenarios share a path and no real agent DBs
 * are touched. Cleans up after every test.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, rmSync } from "node:fs";
import { getDb, closeDb } from "../src/db.js";
import { writeNode, getNode, ftsSearchNodes } from "../src/nodes.js";
import { searchEpisodes } from "../src/episodes.js";

// sharpwave-core's db.ts keeps the migration target module-local (TARGET = 17)
// and does NOT export a SCHEMA_VERSION symbol — assert against the known value
// (mirrors packages/core/test/db.test.ts).
const SCHEMA_VERSION = 17;

// ── Path helpers ──────────────────────────────────────────────────────────────
// sharpwave's db.ts resolves the per-agent path as
// join(SHARPWAVE_DATA_DIR, agentId, "brain.db") — same shape clawbrain used
// under CLAWBRAIN_DATA_DIR/<agentId>/brain.db.

function agentDir(agentId: string): string {
  return join(process.env["SHARPWAVE_DATA_DIR"] || join(homedir(), ".sharpwave"), agentId);
}

function agentDbPath(agentId: string): string {
  return join(agentDir(agentId), "brain.db");
}

function freshDb(agentId: string): Database.Database {
  mkdirSync(agentDir(agentId), { recursive: true });
  const db = new Database(agentDbPath(agentId));
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  return db;
}

function cleanupAgent(agentId: string): void {
  try { closeDb(agentId); } catch { /* already closed */ }
  try { rmSync(agentDir(agentId), { recursive: true, force: true }); } catch { /* ok */ }
}

// ── Schema builders ───────────────────────────────────────────────────────────

function buildSchemaV0(db: Database.Database): void {
  // Oldest possible: no schema_version, no v2+ columns
  db.exec(`
    CREATE TABLE IF NOT EXISTS nodes (
      id             TEXT PRIMARY KEY,
      type           TEXT NOT NULL,
      label          TEXT NOT NULL,
      content        TEXT NOT NULL,
      importance     REAL NOT NULL DEFAULT 0.5,
      salience       REAL NOT NULL DEFAULT 0.5,
      stability      REAL NOT NULL DEFAULT 1.0,
      retrievability REAL NOT NULL DEFAULT 1.0,
      ef             REAL NOT NULL DEFAULT 2.5,
      access_count   INTEGER NOT NULL DEFAULT 0,
      episode_ids    TEXT,
      source         TEXT,
      created_at     INTEGER NOT NULL,
      accessed_at    INTEGER NOT NULL,
      updated_at     INTEGER NOT NULL
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
    CREATE TABLE IF NOT EXISTS episodes (
      id         TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      tokens     INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      meta       TEXT
    );
    CREATE TABLE IF NOT EXISTS self_model (
      id         TEXT PRIMARY KEY DEFAULT 'singleton',
      identity   TEXT NOT NULL DEFAULT '',
      goals      TEXT NOT NULL DEFAULT '[]',
      user_model TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
}

function buildSchemaV3(db: Database.Database): void {
  // Has emotional_weight, eligibility_trace, embedding, encoding_context, ripple_count on nodes.
  // Missing: extraction_confidence on nodes, ripple_count on episodes, node_associations.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version VALUES (3);
    CREATE TABLE IF NOT EXISTS nodes (
      id                TEXT PRIMARY KEY,
      type              TEXT NOT NULL,
      label             TEXT NOT NULL,
      content           TEXT NOT NULL,
      importance        REAL NOT NULL DEFAULT 0.5,
      salience          REAL NOT NULL DEFAULT 0.5,
      stability         REAL NOT NULL DEFAULT 1.0,
      retrievability    REAL NOT NULL DEFAULT 1.0,
      ef                REAL NOT NULL DEFAULT 2.5,
      access_count      INTEGER NOT NULL DEFAULT 0,
      emotional_weight  REAL NOT NULL DEFAULT 0.0,
      episode_ids       TEXT,
      source            TEXT,
      embedding         BLOB,
      encoding_context  TEXT,
      ripple_count      INTEGER NOT NULL DEFAULT 0,
      eligibility_trace REAL NOT NULL DEFAULT 0.0,
      created_at        INTEGER NOT NULL,
      accessed_at       INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
      id UNINDEXED, label, content, type UNINDEXED,
      content=nodes, content_rowid=rowid
    );
    CREATE TRIGGER IF NOT EXISTS nodes_fts_insert AFTER INSERT ON nodes BEGIN
      INSERT INTO nodes_fts(rowid, id, label, content, type)
      VALUES (new.rowid, new.id, new.label, new.content, new.type);
    END;
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
    CREATE TABLE IF NOT EXISTS episodes (
      id         TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role       TEXT NOT NULL,
      content    TEXT NOT NULL,
      importance REAL NOT NULL DEFAULT 0.5,
      tokens     INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      meta       TEXT
    );
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
  `);
}

function buildSchemaV4(db: Database.Database): void {
  buildSchemaV3(db);
  db.prepare("DELETE FROM schema_version").run();
  db.prepare("INSERT INTO schema_version VALUES (4)").run();
  try { db.exec("ALTER TABLE nodes ADD COLUMN extraction_confidence REAL NOT NULL DEFAULT 1.0"); } catch { /* ok */ }
  try { db.exec("ALTER TABLE episodes ADD COLUMN ripple_count INTEGER NOT NULL DEFAULT 0"); } catch { /* ok */ }
}

function buildSchemaV5(db: Database.Database): void {
  buildSchemaV4(db);
  db.prepare("DELETE FROM schema_version").run();
  db.prepare("INSERT INTO schema_version VALUES (5)").run();
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
}

// ── Seed helpers ──────────────────────────────────────────────────────────────

function seedNodes(
  db: Database.Database,
  count: number,
  types = ["identity", "goal", "semantic", "pattern", "episodic"],
  extra: Record<string, unknown> = {},
): string[] {
  const now = Date.now();
  const ids: string[] = [];
  const extraCols = Object.keys(extra);
  const colSuffix = extraCols.length ? `, ${extraCols.join(", ")}` : "";
  const valSuffix = extraCols.length ? `, ${extraCols.map(() => "?").join(", ")}` : "";
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    const type = types[i % types.length];
    try {
      db.prepare(
        `INSERT INTO nodes (id, type, label, content, importance, salience, stability, retrievability, ef, access_count, created_at, accessed_at, updated_at${colSuffix})
         VALUES (?, ?, ?, ?, ?, ?, ?, 1.0, 2.5, 0, ?, ?, ?${valSuffix})`
      ).run(
        id, type,
        `${type}-label-${i + 1}`,
        `Content for ${type} node ${i + 1} used in stress migration test.`,
        0.5 + (i % 5) * 0.08,
        0.5,
        30.0 + i,
        now - i * 3600000, now - i * 1800000, now,
        ...Object.values(extra),
      );
      ids.push(id);
    } catch { /* column missing in old schema — skip extra cols */ }
  }
  return ids;
}

function seedEpisodes(db: Database.Database, count: number): string[] {
  const now = Date.now();
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = randomUUID();
    try {
      db.prepare(
        "INSERT INTO episodes (id, session_id, role, content, importance, tokens, created_at, meta) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)"
      ).run(id, "stress-session", i % 2 === 0 ? "user" : "assistant",
        `Episode ${i + 1}: message about memory and migration.`, 0.5, 20, now - i * 60000);
      ids.push(id);
    } catch { /* ok */ }
  }
  return ids;
}

function seedEdges(db: Database.Database, nodeIds: string[]): string[] {
  const now = Date.now();
  const ids: string[] = [];
  for (let i = 0; i < Math.min(nodeIds.length - 1, 5); i++) {
    const id = randomUUID();
    db.prepare(
      "INSERT INTO edges (id, from_id, to_id, type, weight, valid_from, valid_until, learned_at, created_at, meta) VALUES (?, ?, ?, 'associated_with', 0.7, ?, NULL, ?, ?, NULL)"
    ).run(id, nodeIds[i], nodeIds[i + 1], now, now, now);
    ids.push(id);
  }
  return ids;
}

function countRows(db: Database.Database, table: string): number {
  try { return (db.prepare(`SELECT COUNT(*) as n FROM ${table}`).get() as { n: number }).n; } catch { return 0; }
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name);
}

function getSchemaVersion(db: Database.Database): number {
  try {
    const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | undefined;
    return row?.version ?? 0;
  } catch { return 0; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 1: v0 → v6  (no schema_version, no v2 columns)
// ─────────────────────────────────────────────────────────────────────────────

describe("migration stress — scenario 1: v0 → v6 (bare DB, no schema_version)", () => {
  const agentId = `s1-${randomUUID().slice(0, 8)}`;
  const NODE_COUNT = 12;
  const EP_COUNT = 6;

  beforeEach(() => {
    const db = freshDb(agentId);
    buildSchemaV0(db);
    seedNodes(db, NODE_COUNT);
    seedEpisodes(db, EP_COUNT);
    db.close();
  });

  afterEach(() => cleanupAgent(agentId));

  it("reaches current schema_version", () => {
    expect(getSchemaVersion(getDb(agentId))).toBe(SCHEMA_VERSION);
  });

  it("all nodes survive", () => {
    expect(countRows(getDb(agentId), "nodes")).toBe(NODE_COUNT);
  });

  it("all episodes survive", () => {
    expect(countRows(getDb(agentId), "episodes")).toBe(EP_COUNT);
  });

  it("nodes gain all v3 columns with correct defaults", () => {
    const db = getDb(agentId);
    const cols = columnNames(db, "nodes");
    expect(cols).toContain("emotional_weight");
    expect(cols).toContain("eligibility_trace");
    expect(cols).toContain("embedding");
    expect(cols).toContain("encoding_context");
    expect(cols).toContain("extraction_confidence");
    expect(cols).toContain("ripple_count");

    const node = db.prepare("SELECT * FROM nodes LIMIT 1").get() as Record<string, unknown>;
    expect(node["emotional_weight"]).toBe(0.0);
    expect(node["eligibility_trace"]).toBe(0.0);
    expect(node["extraction_confidence"]).toBe(1.0);
    expect(node["ripple_count"]).toBe(0);
  });

  it("episodes gain ripple_count defaulting to 0", () => {
    const db = getDb(agentId);
    expect(columnNames(db, "episodes")).toContain("ripple_count");
    const ep = db.prepare("SELECT ripple_count FROM episodes LIMIT 1").get() as { ripple_count: number };
    expect(ep.ripple_count).toBe(0);
  });

  it("node_associations table created", () => {
    const tables = (getDb(agentId).prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name);
    expect(tables).toContain("node_associations");
  });

  it("self_model singleton seeded", () => {
    const row = getDb(agentId).prepare("SELECT * FROM self_model WHERE id = 'singleton'").get() as Record<string, unknown> | undefined;
    expect(row).toBeDefined();
    expect(row!["goals"]).toBe("[]");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 2: v3 → v6  (realistic pre-migration DB, specific field values)
// ─────────────────────────────────────────────────────────────────────────────

describe("migration stress — scenario 2: v3 → v6 (realistic pre-migration DB)", () => {
  const agentId = `s2-${randomUUID().slice(0, 8)}`;
  let pinnedNodeId: string;
  const pinnedImportance = 0.87;
  const pinnedEmotionalWeight = -0.3;
  const pinnedEligTrace = 0.4;
  const pinnedRipple = 2;
  let allNodeIds: string[];
  let allEpisodeIds: string[];

  beforeEach(() => {
    const now = Date.now();
    const db = freshDb(agentId);
    buildSchemaV3(db);

    pinnedNodeId = randomUUID();
    db.prepare(`
      INSERT INTO nodes (id, type, label, content, importance, salience, stability, retrievability, ef, access_count,
        emotional_weight, source, encoding_context, ripple_count, eligibility_trace,
        created_at, accessed_at, updated_at)
      VALUES (?, 'identity', 'Pinned identity node', 'I am a test agent with exact field values.', ?, 0.6, 90.0, 0.95, 2.7, 5,
        ?, 'seed', NULL, ?, ?, ?, ?, ?)
    `).run(pinnedNodeId, pinnedImportance, pinnedEmotionalWeight, pinnedRipple, pinnedEligTrace, now - 86400000, now - 3600000, now);

    allNodeIds = [pinnedNodeId, ...seedNodes(db, 14, ["goal", "semantic", "pattern", "episodic"])];
    seedEdges(db, allNodeIds);
    allEpisodeIds = seedEpisodes(db, 8);

    db.prepare("INSERT INTO self_model (id, identity, goals, user_model, created_at, updated_at) VALUES ('singleton', 'I am Aria.', '[\"goal one\"]', '{\"name\":\"Hailey\"}', ?, ?)")
      .run(now, now);
    db.close();
  });

  afterEach(() => cleanupAgent(agentId));

  it("reaches current schema_version", () => {
    expect(getSchemaVersion(getDb(agentId))).toBe(SCHEMA_VERSION);
  });

  it("preserves exact row counts", () => {
    const db = getDb(agentId);
    expect(countRows(db, "nodes")).toBe(allNodeIds.length);
    expect(countRows(db, "episodes")).toBe(allEpisodeIds.length);
  });

  it("extraction_confidence defaults to 1.0 on all existing nodes", () => {
    const wrong = (getDb(agentId).prepare("SELECT COUNT(*) as n FROM nodes WHERE extraction_confidence != 1.0").get() as { n: number }).n;
    expect(wrong).toBe(0);
  });

  it("pinned field values survive migration exactly", () => {
    const node = getDb(agentId).prepare("SELECT * FROM nodes WHERE id = ?").get(pinnedNodeId) as Record<string, unknown>;
    expect(node).toBeDefined();
    expect(Number(node["importance"])).toBeCloseTo(pinnedImportance, 6);
    expect(Number(node["emotional_weight"])).toBeCloseTo(pinnedEmotionalWeight, 6);
    expect(Number(node["eligibility_trace"])).toBeCloseTo(pinnedEligTrace, 6);
    expect(Number(node["ripple_count"])).toBe(pinnedRipple);
  });

  it("self_model identity and goals survive intact", () => {
    const sm = getDb(agentId).prepare("SELECT * FROM self_model WHERE id = 'singleton'").get() as Record<string, unknown>;
    expect(sm["identity"]).toBe("I am Aria.");
    expect(JSON.parse(sm["goals"] as string)).toEqual(["goal one"]);
  });

  it("episodes gain ripple_count column defaulting to 0", () => {
    const db = getDb(agentId);
    expect(columnNames(db, "episodes")).toContain("ripple_count");
    const ep = db.prepare("SELECT ripple_count FROM episodes LIMIT 1").get() as { ripple_count: number };
    expect(ep.ripple_count).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 3: v4 → v6  (node_associations and nodes_vec missing)
// ─────────────────────────────────────────────────────────────────────────────

describe("migration stress — scenario 3: v4 → v6 (Hebbian table missing)", () => {
  const agentId = `s3-${randomUUID().slice(0, 8)}`;
  const NODE_COUNT = 20;
  let edgeCount: number;

  beforeEach(() => {
    const db = freshDb(agentId);
    buildSchemaV4(db);
    const nodeIds = seedNodes(db, NODE_COUNT);
    edgeCount = seedEdges(db, nodeIds).length;
    db.prepare("INSERT INTO meta_kv (key, value) VALUES ('test_key', 'test_value')").run();
    db.close();
  });

  afterEach(() => cleanupAgent(agentId));

  it("reaches current schema_version from v4", () => {
    expect(getSchemaVersion(getDb(agentId))).toBe(SCHEMA_VERSION);
  });

  it("node_associations table created during v4→v5 step", () => {
    const tables = (getDb(agentId).prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(t => t.name);
    expect(tables).toContain("node_associations");
  });

  it("all nodes and edges survive", () => {
    const db = getDb(agentId);
    expect(countRows(db, "nodes")).toBe(NODE_COUNT);
    expect(countRows(db, "edges")).toBe(edgeCount);
  });

  it("meta_kv row survives migration", () => {
    const row = getDb(agentId).prepare("SELECT value FROM meta_kv WHERE key = 'test_key'").get() as { value: string } | undefined;
    expect(row?.value).toBe("test_value");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 4: v5 → v6  (nodes_vec rebuild only)
// ─────────────────────────────────────────────────────────────────────────────

describe("migration stress — scenario 4: v5 → v6 (nodes_vec 768→1536 rebuild)", () => {
  const agentId = `s4-${randomUUID().slice(0, 8)}`;
  const NODE_COUNT = 18;
  let firstNodeId: string;
  let secondNodeId: string;

  beforeEach(() => {
    const now = Date.now();
    const db = freshDb(agentId);
    buildSchemaV5(db);
    const ids = seedNodes(db, NODE_COUNT);
    firstNodeId = ids[0];
    secondNodeId = ids[1];
    db.prepare("INSERT INTO node_associations (node_id_a, node_id_b, count, strength, last_coactivated) VALUES (?, ?, 5, 0.45, ?)")
      .run(firstNodeId, secondNodeId, now);
    db.close();
  });

  afterEach(() => cleanupAgent(agentId));

  it("reaches current schema_version from v5", () => {
    expect(getSchemaVersion(getDb(agentId))).toBe(SCHEMA_VERSION);
  });

  it("all nodes survive v5→v6", () => {
    expect(countRows(getDb(agentId), "nodes")).toBe(NODE_COUNT);
  });

  it("seeded node_association survives v5→v6 intact", () => {
    const db = getDb(agentId);
    expect(countRows(db, "node_associations")).toBeGreaterThanOrEqual(1);
    const row = db.prepare("SELECT count, strength FROM node_associations WHERE node_id_a = ? AND node_id_b = ?").get(firstNodeId, secondNodeId) as { count: number; strength: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.count).toBe(5);
    expect(row!.strength).toBeCloseTo(0.45, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 5: v6 → v6  (idempotency — no duplicate rows, no data loss)
// ─────────────────────────────────────────────────────────────────────────────

describe("migration stress — scenario 5: v6 → v6 (idempotency)", () => {
  const agentId = `s5-${randomUUID().slice(0, 8)}`;

  afterEach(() => cleanupAgent(agentId));

  it("schema_version stays current on double open", () => {
    const db1 = getDb(agentId);
    expect(getSchemaVersion(db1)).toBe(SCHEMA_VERSION);
    const db2 = getDb(agentId);
    expect(getSchemaVersion(db2)).toBe(SCHEMA_VERSION);
    expect(db1).toBe(db2);
  });

  it("schema_version row count is exactly 1 (no duplicates)", () => {
    const db = getDb(agentId);
    expect((db.prepare("SELECT COUNT(*) as n FROM schema_version").get() as { n: number }).n).toBe(1);
  });

  it("self_model singleton is exactly 1 row after re-open", () => {
    getDb(agentId);
    closeDb(agentId);
    const db = getDb(agentId);
    expect((db.prepare("SELECT COUNT(*) as n FROM self_model").get() as { n: number }).n).toBe(1);
  });

  it("writes and reads a node correctly on v6 DB", () => {
    getDb(agentId);
    const id = writeNode(agentId, "semantic", "idempotency test", "Written on a fresh v6 DB.", { importance: 0.75 });
    const node = getNode(agentId, id);
    expect(node).not.toBeNull();
    expect(node!.label).toBe("idempotency test");
    expect(node!.importance).toBeCloseTo(0.75, 5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 6: Large volume v3 → v6  (50 nodes, 20 episodes, 5 edges)
// ─────────────────────────────────────────────────────────────────────────────

describe("migration stress — scenario 6: large-volume v3 → v6", () => {
  const agentId = `s6-${randomUUID().slice(0, 8)}`;
  const NODE_COUNT = 50;
  const EP_COUNT = 20;
  let edgeCount: number;

  beforeEach(() => {
    const db = freshDb(agentId);
    buildSchemaV3(db);
    const nodeIds = seedNodes(db, NODE_COUNT);
    edgeCount = seedEdges(db, nodeIds).length;
    seedEpisodes(db, EP_COUNT);
    db.prepare("INSERT INTO self_model (id, identity, goals, user_model, created_at, updated_at) VALUES ('singleton', 'Volume test.', '[]', '{}', ?, ?)")
      .run(Date.now(), Date.now());
    db.close();
  });

  afterEach(() => cleanupAgent(agentId));

  it("reaches current schema_version", () => {
    expect(getSchemaVersion(getDb(agentId))).toBe(SCHEMA_VERSION);
  });

  it("all 50 nodes survive", () => {
    expect(countRows(getDb(agentId), "nodes")).toBe(NODE_COUNT);
  });

  it("all 20 episodes survive", () => {
    expect(countRows(getDb(agentId), "episodes")).toBe(EP_COUNT);
  });

  it("all edges survive", () => {
    expect(countRows(getDb(agentId), "edges")).toBe(edgeCount);
  });

  it("extraction_confidence = 1.0 on all 50 nodes", () => {
    const wrong = (getDb(agentId).prepare("SELECT COUNT(*) as n FROM nodes WHERE extraction_confidence != 1.0").get() as { n: number }).n;
    expect(wrong).toBe(0);
  });

  it("FTS search works after migration", () => {
    getDb(agentId);
    const results = ftsSearchNodes(agentId, "stress migration", 10);
    expect(results.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 7: Field-level data integrity v3 → v6
// ─────────────────────────────────────────────────────────────────────────────

describe("migration stress — scenario 7: field-level data integrity v3 → v6", () => {
  const agentId = `s7-${randomUUID().slice(0, 8)}`;

  const pinned = {
    nodeId: randomUUID(),
    importance: 0.912,
    emotionalWeight: 0.654,
    eligTrace: 0.321,
    ripple: 7,
    stability: 47.3,
    retrievability: 0.789,
    ef: 3.14,
    accessCount: 23,
  };
  let pinnedEpisodeId: string;
  const pinnedContent = "Exact episode text that must survive verbatim — no truncation, no modification.";

  beforeEach(() => {
    const now = Date.now();
    const db = freshDb(agentId);
    buildSchemaV3(db);

    db.prepare(`
      INSERT INTO nodes (id, type, label, content, importance, salience, stability, retrievability, ef, access_count,
        emotional_weight, source, encoding_context, ripple_count, eligibility_trace,
        created_at, accessed_at, updated_at)
      VALUES (?, 'semantic', 'pinned-integrity-node', 'Integrity check content.', ?, ?, ?, ?, ?, ?,
        ?, 'test', NULL, ?, ?, ?, ?, ?)
    `).run(
      pinned.nodeId,
      pinned.importance, pinned.importance * 0.8,
      pinned.stability, pinned.retrievability, pinned.ef, pinned.accessCount,
      pinned.emotionalWeight, pinned.ripple, pinned.eligTrace,
      now - 3600000, now - 1800000, now,
    );

    pinnedEpisodeId = randomUUID();
    db.prepare("INSERT INTO episodes (id, session_id, role, content, importance, tokens, created_at, meta) VALUES (?, 'integrity-session', 'user', ?, 0.9, 32, ?, NULL)")
      .run(pinnedEpisodeId, pinnedContent, now);

    seedNodes(db, 10);
    db.prepare("INSERT INTO self_model (id, identity, goals, user_model, created_at, updated_at) VALUES ('singleton', 'Integrity agent.', '[\"survive\"]', '{\"user\":\"test\"}', ?, ?)")
      .run(now, now);
    db.close();
  });

  afterEach(() => cleanupAgent(agentId));

  it("all pinned node field values survive exactly", () => {
    const node = getDb(agentId).prepare("SELECT * FROM nodes WHERE id = ?").get(pinned.nodeId) as Record<string, unknown>;
    expect(node).toBeDefined();
    expect(Number(node["importance"])).toBeCloseTo(pinned.importance, 6);
    expect(Number(node["emotional_weight"])).toBeCloseTo(pinned.emotionalWeight, 6);
    expect(Number(node["eligibility_trace"])).toBeCloseTo(pinned.eligTrace, 6);
    expect(Number(node["ripple_count"])).toBe(pinned.ripple);
    expect(Number(node["stability"])).toBeCloseTo(pinned.stability, 6);
    expect(Number(node["retrievability"])).toBeCloseTo(pinned.retrievability, 6);
    expect(Number(node["ef"])).toBeCloseTo(pinned.ef, 6);
    expect(Number(node["access_count"])).toBe(pinned.accessCount);
  });

  it("extraction_confidence added as 1.0 on pre-existing node", () => {
    const node = getDb(agentId).prepare("SELECT extraction_confidence FROM nodes WHERE id = ?").get(pinned.nodeId) as { extraction_confidence: number };
    expect(node.extraction_confidence).toBe(1.0);
  });

  it("episode content survives verbatim", () => {
    const ep = getDb(agentId).prepare("SELECT content, ripple_count FROM episodes WHERE id = ?").get(pinnedEpisodeId) as { content: string; ripple_count: number };
    expect(ep).toBeDefined();
    expect(ep.content).toBe(pinnedContent);
    expect(ep.ripple_count).toBe(0);
  });

  it("self_model fields survive verbatim", () => {
    const sm = getDb(agentId).prepare("SELECT * FROM self_model WHERE id = 'singleton'").get() as Record<string, unknown>;
    expect(sm["identity"]).toBe("Integrity agent.");
    expect(JSON.parse(sm["goals"] as string)).toEqual(["survive"]);
    expect(JSON.parse(sm["user_model"] as string)).toEqual({ user: "test" });
  });

  it("schema_version is exactly current", () => {
    expect(getSchemaVersion(getDb(agentId))).toBe(SCHEMA_VERSION);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Scenario 8: nodes_fts populated after migration from v0
// FTS5 content tables don't auto-populate on creation — the rebuild must be
// called explicitly. This ensures FTS search on nodes works for pre-existing rows.
// ─────────────────────────────────────────────────────────────────────────────

describe("migration stress — scenario 8: nodes_fts and episodes_fts populated after migration", () => {
  const agentId = `s8-${randomUUID().slice(0, 8)}`;
  const UNIQUE_LABEL = "xenomorphic-synapse-deduplication-marker";
  const UNIQUE_EPISODE = "xenomorphic-episode-deduplication-marker";

  beforeEach(() => {
    const now = Date.now();
    const db = freshDb(agentId);
    buildSchemaV0(db);

    // Insert a node with a unique label BEFORE getDb (so before triggers exist)
    const nodeId = randomUUID();
    db.prepare(`
      INSERT INTO nodes (id, type, label, content, importance, salience, stability, retrievability, ef,
        access_count, created_at, accessed_at, updated_at)
      VALUES (?, 'semantic', ?, ?, 0.7, 0.7, 60.0, 1.0, 2.5, 0, ?, ?, ?)
    `).run(nodeId, UNIQUE_LABEL, `${UNIQUE_LABEL} content body`, now, now, now);

    // Insert an episode with unique content BEFORE getDb
    const epId = randomUUID();
    db.prepare(
      "INSERT INTO episodes (id, session_id, role, content, importance, tokens, created_at, meta) VALUES (?, 'fts-test', 'user', ?, 0.7, 20, ?, NULL)"
    ).run(epId, UNIQUE_EPISODE, now);

    db.close();
  });

  afterEach(() => cleanupAgent(agentId));

  it("ftsSearchNodes finds nodes that were inserted before triggers existed", () => {
    // Opening the DB triggers runMigrations → nodes_fts rebuild
    getDb(agentId);
    const results = ftsSearchNodes(agentId, UNIQUE_LABEL.split("-")[0]!, 10);
    const found = results.some((n) => n.label === UNIQUE_LABEL);
    expect(found).toBe(true);
  });

  it("searchEpisodes finds episodes that were inserted before triggers existed", () => {
    getDb(agentId);
    const results = searchEpisodes(agentId, UNIQUE_EPISODE.split("-")[0]!, 10);
    const found = results.some((e) => e.content === UNIQUE_EPISODE);
    expect(found).toBe(true);
  });

  it("new nodes written AFTER migration are also searchable via FTS", () => {
    const db = getDb(agentId);
    const AFTER_LABEL = "post-migration-fts-verify-node";
    const nodeId = writeNode(agentId, "semantic", AFTER_LABEL, `${AFTER_LABEL} body`, { importance: 0.6 });
    expect(nodeId).toBeDefined();
    const results = ftsSearchNodes(agentId, "post-migration-fts", 10);
    expect(results.some((n) => n.label === AFTER_LABEL)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// NOTE (Step G): clawbrain-v4 scenarios 9 & 10 were dropped here. They spawned
// the standalone `migrate-v3-to-v4.ts` CLI script (a clawbrain-only artifact —
// sharpwave has no such script; migrations run in-process via db.ts runMigrations)
// and every case was already it.skip "BLOCKED on Agent A". The v0..v5 -> current
// in-process migration invariants they cared about are covered by scenarios 1-8.
// ---------------------------------------------------------------------------


// ─────────────────────────────────────────────────────────────────────────────
// Scenario 11: double-open under concurrent migration — two parallel getDb()
// calls on the same agent ID must not corrupt the version bump. better-sqlite3
// is synchronous, so this exercises the cache and the in-process serialization,
// not OS-level concurrency.
// ─────────────────────────────────────────────────────────────────────────────

describe("migration stress — scenario 11: concurrent getDb double-open", () => {
  const agentId = `s11-${randomUUID().slice(0, 8)}`;

  beforeEach(() => {
    const db = freshDb(agentId);
    buildSchemaV3(db);
    seedNodes(db, 12);
    seedEpisodes(db, 6);
    db.close();
  });

  afterEach(() => cleanupAgent(agentId));

  it("two parallel getDb() calls return the same instance and bump version exactly once", async () => {
    const [db1, db2] = await Promise.all([
      Promise.resolve().then(() => getDb(agentId)),
      Promise.resolve().then(() => getDb(agentId)),
    ]);
    expect(db1).toBe(db2);

    // schema_version row count is exactly 1 — no duplicate INSERT from racing migrations
    const versionRowCount = (db1.prepare("SELECT COUNT(*) as n FROM schema_version").get() as { n: number }).n;
    expect(versionRowCount).toBe(1);
    expect(getSchemaVersion(db1)).toBeGreaterThanOrEqual(9);
  });

  it("rapid open/close/reopen cycle keeps schema_version stable and singleton", () => {
    for (let i = 0; i < 5; i++) {
      const db = getDb(agentId);
      expect(getSchemaVersion(db)).toBeGreaterThanOrEqual(9);
      closeDb(agentId);
    }
    const db = getDb(agentId);
    const versionRowCount = (db.prepare("SELECT COUNT(*) as n FROM schema_version").get() as { n: number }).n;
    expect(versionRowCount).toBe(1);
  });
});
