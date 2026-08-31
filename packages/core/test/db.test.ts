import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb, getMeta, setMeta, closeDb } from "../src/db.js";

// sharpwave-core's db.ts keeps the migration target (16) as a module-local
// constant and does not export it. The clawbrain-v4 test imported a
// `SCHEMA_VERSION` symbol; here we assert against the known current value.
const SCHEMA_VERSION = 17;

function freshAgent(): string {
  return `test-${randomUUID().slice(0, 8)}`;
}

describe("db", () => {
  it("creates a fresh DB with all required tables", () => {
    const agentId = freshAgent();
    const db = getDb(agentId);

    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);

    expect(names).toContain("nodes");
    expect(names).toContain("edges");
    expect(names).toContain("episodes");
    expect(names).toContain("working_memory");
    expect(names).toContain("self_model");
    expect(names).toContain("meta_kv");

    closeDb(agentId);
  });

  it("seeds self_model singleton on first open", () => {
    const agentId = freshAgent();
    const db = getDb(agentId);
    const row = db.prepare("SELECT * FROM self_model WHERE id = 'singleton'").get() as {
      id: string; identity: string; goals: string;
    } | undefined;

    expect(row).toBeDefined();
    expect(row!.id).toBe("singleton");
    expect(row!.identity).toBe("");
    expect(row!.goals).toBe("[]");

    closeDb(agentId);
  });

  it("schema_version is current on new DB", () => {
    const agentId = freshAgent();
    const db = getDb(agentId);
    const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number };
    expect(row.version).toBe(SCHEMA_VERSION);
    closeDb(agentId);
  });

  it("nodes table has v12 FSRS-6 columns (difficulty/last_review/review_count)", () => {
    const agentId = freshAgent();
    const db = getDb(agentId);
    const cols = db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("difficulty");
    expect(colNames).toContain("last_review");
    expect(colNames).toContain("review_count");
    closeDb(agentId);
  });

  it("nodes table has v13 CLS columns (is_consolidated/consolidated_at)", () => {
    const agentId = freshAgent();
    const db = getDb(agentId);
    const cols = db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("is_consolidated");
    expect(colNames).toContain("consolidated_at");
    closeDb(agentId);
  });

  it("nodes table has v17 VALOR columns (inject_count/inject_hits) on a fresh DB", () => {
    const agentId = freshAgent();
    const db = getDb(agentId);
    const colNames = (db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(colNames).toContain("inject_count");
    expect(colNames).toContain("inject_hits");
    // Defaults must be 0 (VALOR treats a brand-new node as neutral utility 1.0).
    const now = Date.now();
    db.prepare(`
      INSERT INTO nodes (id, type, label, content, created_at, accessed_at, updated_at)
      VALUES ('v17probe', 'semantic', 'l', 'c', ?, ?, ?)
    `).run(now, now, now);
    const row = db.prepare("SELECT inject_count, inject_hits FROM nodes WHERE id = 'v17probe'").get() as {
      inject_count: number; inject_hits: number;
    };
    expect(row.inject_count).toBe(0);
    expect(row.inject_hits).toBe(0);
    closeDb(agentId);
  });

  it("v17 migration is additive + idempotent — upgrades a simulated pre-v17 DB and re-opens cleanly", () => {
    const agentId = freshAgent();

    // 1. Open at current version, then simulate an older on-disk DB by dropping
    //    the v17 columns and rewinding schema_version to 16.
    const db1 = getDb(agentId);
    db1.exec("ALTER TABLE nodes DROP COLUMN inject_hits");
    db1.exec("ALTER TABLE nodes DROP COLUMN inject_count");
    db1.exec("DELETE FROM schema_version");
    db1.exec("INSERT INTO schema_version VALUES (16)");
    // Seed a legacy row that predates the columns.
    const now = Date.now();
    db1.prepare(`
      INSERT INTO nodes (id, type, label, content, created_at, accessed_at, updated_at)
      VALUES ('legacy', 'semantic', 'old', 'old node', ?, ?, ?)
    `).run(now, now, now);
    closeDb(agentId);

    // 2. Re-open: runMigrations must re-add both columns, backfill the legacy row
    //    to 0, and stamp schema_version = 17.
    const db2 = getDb(agentId);
    const colNames = (db2.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(colNames).toContain("inject_count");
    expect(colNames).toContain("inject_hits");
    const legacy = db2.prepare("SELECT inject_count, inject_hits FROM nodes WHERE id = 'legacy'").get() as {
      inject_count: number; inject_hits: number;
    };
    expect(legacy.inject_count).toBe(0);
    expect(legacy.inject_hits).toBe(0);
    const ver = db2.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number };
    expect(ver.version).toBe(17);
    closeDb(agentId);

    // 3. Re-open a THIRD time — migrations already at target, must be a no-op
    //    (the ALTER TABLE ADD COLUMN steps are wrapped in try/catch).
    expect(() => {
      const db3 = getDb(agentId);
      db3.prepare("SELECT 1").get();
      closeDb(agentId);
    }).not.toThrow();
  });

  it("nodes table has v14 ps_hash column", () => {
    const agentId = freshAgent();
    const db = getDb(agentId);
    const cols = db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("ps_hash");
    closeDb(agentId);
  });

  it("episodes table has v10 llm_extracted column", () => {
    const agentId = freshAgent();
    const db = getDb(agentId);
    const cols = db.prepare("PRAGMA table_info(episodes)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("llm_extracted");
    closeDb(agentId);
  });

  it("v15 nodes_vec is 1024-dim (when sqlite-vec is loaded)", () => {
    const agentId = freshAgent();
    const db = getDb(agentId);
    // Probe by inserting a 1024-element vector; mismatch surfaces as constraint error.
    const probe = db.prepare("SELECT name FROM sqlite_master WHERE name = 'nodes_vec'").get();
    if (probe) {
      const buf = Buffer.alloc(1024 * 4); // 1024 float32 zeros
      // A 1536-element vector must throw the dim-mismatch error.
      const wrong = Buffer.alloc(1536 * 4);
      expect(() => db.prepare("INSERT INTO nodes_vec(rowid, embedding) VALUES (1, ?)").run(wrong)).toThrow();
      // A 1024-element vector must succeed.
      expect(() => db.prepare("INSERT INTO nodes_vec(rowid, embedding) VALUES (2, ?)").run(buf)).not.toThrow();
    }
    closeDb(agentId);
  });

  it("FSRS-6 columns have correct defaults on insert", () => {
    const agentId = freshAgent();
    const db = getDb(agentId);
    const now = Date.now();
    db.prepare(`
      INSERT INTO nodes (id, type, label, content, created_at, accessed_at, updated_at)
      VALUES ('test', 'semantic', 'l', 'c', ?, ?, ?)
    `).run(now, now, now);
    const node = db.prepare("SELECT difficulty, last_review, review_count, is_consolidated, consolidated_at, ps_hash FROM nodes WHERE id = 'test'").get() as {
      difficulty: number; last_review: number | null; review_count: number;
      is_consolidated: number; consolidated_at: number | null; ps_hash: Buffer | null;
    };
    expect(node.difficulty).toBe(5.0);
    expect(node.last_review).toBeNull();
    expect(node.review_count).toBe(0);
    expect(node.is_consolidated).toBe(0);
    expect(node.consolidated_at).toBeNull();
    expect(node.ps_hash).toBeNull();
    closeDb(agentId);
  });

  it("nodes table has v3 columns", () => {
    const agentId = freshAgent();
    const db = getDb(agentId);
    const cols = db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("encoding_context");
    expect(colNames).toContain("extraction_confidence");
    expect(colNames).toContain("ripple_count");
    expect(colNames).toContain("eligibility_trace");
    closeDb(agentId);
  });

  it("episodes table has ripple_count column", () => {
    const agentId = freshAgent();
    const db = getDb(agentId);
    const cols = db.prepare("PRAGMA table_info(episodes)").all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("ripple_count");
    closeDb(agentId);
  });

  it("meta_kv get/set roundtrip", () => {
    const agentId = freshAgent();
    setMeta(agentId, "test_key", "hello");
    expect(getMeta(agentId, "test_key")).toBe("hello");
    expect(getMeta(agentId, "missing_key")).toBeNull();
    closeDb(agentId);
  });

  it("returns same DB instance for same agentId", () => {
    const agentId = freshAgent();
    const db1 = getDb(agentId);
    const db2 = getDb(agentId);
    expect(db1).toBe(db2);
    closeDb(agentId);
  });
});
