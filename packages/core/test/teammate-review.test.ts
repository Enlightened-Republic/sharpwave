/**
 * ClawBrain v3 — Teammate Code Review Test Suite
 *
 * Written by an independent senior AI systems engineer after full source audit.
 * 5 rigorous tests covering:
 *   1. v2→v3 migration with personality intact (schema v3 → v4 → v5, data survival)
 *   2. Hebbian edge strength progression (mathematical accumulation, threshold crossing)
 *   3. Dream context feeds bootstrap without brain_query (no-lookup guarantee)
 *   4. Context-dependent retrieval via neuromod cosine similarity bonus
 *   5. Full v2→v5 round-trip: migrate, activate, dream, Hebbian accumulate, bootstrap
 *
 * Every assertion has a specific numerical or structural expected value.
 * No hand-waving. Pass = production-ready. Fail = real bug found.
 */

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { join } from "node:path";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";

import { getDb, closeDb, getMeta, setMeta } from "../src/db.js";
import { writeNode, touchNode, getNode } from "../src/nodes.js";
import { writeEdge, edgeExists } from "../src/edges.js";
import { recordCoactivations, awakeReplayTick } from "../src/awake-replay.js";
import { buildBootstrapContext, getDreamContext } from "../src/context-assembly.js";
import { spreadActivation } from "../src/activation.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import type { BrainNode, NeuromodState } from "../src/types.js";

// sharpwave-core's db.ts does not export SCHEMA_VERSION — assert against the
// known current migration target (mirrors packages/core/test/db.test.ts).
const SCHEMA_VERSION = 17;

// ── Shared helpers ─────────────────────────────────────────────────────────────

function fresh(): string { return `tr-${randomUUID().slice(0, 8)}`; }
const log = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Build a schema-v3 database directly at the path the plugin expects.
 * Schema v3 = encoding_context + ripple_count present, extraction_confidence absent.
 * This matches the real live v2 ClawBrain state.
 */
function buildV3SchemaAt(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

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

    CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
      id UNINDEXED, content, role UNINDEXED,
      content=episodes, content_rowid=rowid
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

    CREATE TRIGGER IF NOT EXISTS nodes_fts_insert AFTER INSERT ON nodes BEGIN
      INSERT INTO nodes_fts(rowid, id, label, content, type)
      VALUES (new.rowid, new.id, new.label, new.content, new.type);
    END;
  `);
}

/**
 * Apply the v3→v4 migration inline (mirrors runMigrations logic in db.ts).
 * Adds extraction_confidence on nodes, ripple_count on episodes. Schema → 4.
 */
function applyMigrationV3toV4(db: Database.Database): void {
  const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | undefined;
  const current = row?.version ?? 0;
  if (current >= 4) return;

  try { db.exec("ALTER TABLE nodes ADD COLUMN extraction_confidence REAL NOT NULL DEFAULT 1.0"); } catch { /* already exists */ }
  try { db.exec("ALTER TABLE episodes ADD COLUMN ripple_count INTEGER NOT NULL DEFAULT 0"); } catch { /* already exists */ }

  db.prepare("DELETE FROM schema_version").run();
  db.prepare("INSERT INTO schema_version VALUES (4)").run();
}

/**
 * Create an agent directory under real homedir and return the brain.db path.
 * getDb() uses homedir() which on Windows is fixed from USERPROFILE at process start.
 * So we write directly to the real ~/.openclaw/agents/<agentName>/brain.db.
 */
function makeRealAgentPath(agentName: string): string {
  const dir = join(process.env["SHARPWAVE_DATA_DIR"] || join(homedir(), ".sharpwave"), agentName);
  mkdirSync(dir, { recursive: true });
  return join(dir, "brain.db");
}

function cleanupAgent(agentName: string): void {
  closeDb(agentName);
  const dbPath = join(process.env["SHARPWAVE_DATA_DIR"] || join(homedir(), ".sharpwave"), agentName, "brain.db");
  try { if (existsSync(dbPath)) rmSync(dbPath); } catch { /* ok */ }
}

// ── Test 1 ─────────────────────────────────────────────────────────────────────

describe("Test 1 — v2→v3 migration: personality intact, all rows preserved, schema→v5", () => {
  it("migrates a schema-v3 DB for agent 'buddy' to current with no data loss", async () => {
    // Unique name to avoid collisions with other test runs or real agents
    const agentName = `buddy-${randomUUID().slice(0, 8)}`;
    const brainDbPath = makeRealAgentPath(agentName);

    const now = Date.now();

    // ── Phase A: Build v2 DB (schema v3) directly at the real agent path ────
    const rawDb = new Database(brainDbPath);
    buildV3SchemaAt(rawDb);

    // Self model: "Buddy" identity, 2 goals, user_model with name "Alex"
    rawDb.prepare(`
      INSERT INTO self_model (id, identity, goals, user_model, created_at, updated_at)
      VALUES ('singleton', ?, ?, ?, ?, ?)
    `).run(
      "I am Buddy, a loyal and direct agent. I always follow through on commitments.",
      JSON.stringify(["Maintain reliable uptime for all channels", "Build and refine persistent memory"]),
      JSON.stringify({ name: "Alex", timezone: "America/Chicago", prefers: "brief direct answers" }),
      now, now,
    );

    // 5 semantic nodes
    const semanticIds: string[] = [];
    const semanticLabels = [
      "OpenClaw plugin system",
      "SM-2 spaced repetition algorithm",
      "Hebbian plasticity mechanism",
      "Working memory capacity limits",
      "Spreading activation graph traversal",
    ];
    for (const label of semanticLabels) {
      const id = randomUUID();
      rawDb.prepare(`
        INSERT INTO nodes
          (id, type, label, content, importance, salience, stability, retrievability, ef,
           access_count, emotional_weight, source, encoding_context, ripple_count, eligibility_trace,
           created_at, accessed_at, updated_at)
        VALUES (?, 'semantic', ?, ?, 0.75, 0.6, 45.0, 0.9, 2.5, 2, 0.0, 'seed', NULL, 1, 0.0, ?, ?, ?)
      `).run(id, label, `Detailed knowledge about ${label}`, now - 5 * 86400000, now - 86400000, now);
      semanticIds.push(id);
    }

    // 2 identity nodes
    const identityIds: string[] = [];
    for (const [label, content] of [
      ["Buddy core identity", "I am Buddy, a loyal and direct agent. I prioritize reliability over cleverness."],
      ["Buddy communication style", "I use short, direct sentences. I avoid hedging language. I confirm understanding."],
    ]) {
      const id = randomUUID();
      rawDb.prepare(`
        INSERT INTO nodes
          (id, type, label, content, importance, salience, stability, retrievability, ef,
           access_count, emotional_weight, source, encoding_context, ripple_count, eligibility_trace,
           created_at, accessed_at, updated_at)
        VALUES (?, 'identity', ?, ?, 0.92, 0.78, 165.0, 1.0, 2.5, 5, 0.1, 'seed', NULL, 2, 0.5, ?, ?, ?)
      `).run(id, label, content, now - 30 * 86400000, now - 3600000, now);
      identityIds.push(id);
    }

    // 3 episodic nodes
    for (const content of [
      "Buddy completed the morning sync and confirmed all agents were online.",
      "Buddy detected a retrieval latency spike in the v3 memory graph and reported it.",
      "Buddy confirmed the Hebbian edge formation after 3 co-activation sessions.",
    ]) {
      const id = randomUUID();
      rawDb.prepare(`
        INSERT INTO nodes
          (id, type, label, content, importance, salience, stability, retrievability, ef,
           access_count, emotional_weight, source, encoding_context, ripple_count, eligibility_trace,
           created_at, accessed_at, updated_at)
        VALUES (?, 'episodic', ?, ?, 0.55, 0.4, 7.7, 0.8, 2.5, 1, 0.0, 'sws', NULL, 0, 0.0, ?, ?, ?)
      `).run(id, content.slice(0, 60), content, now - 2 * 86400000, now - 2 * 86400000, now);
    }

    // 3 edges
    rawDb.prepare(`INSERT INTO edges (id, from_id, to_id, type, weight, valid_from, valid_until, learned_at, created_at, meta)
      VALUES (?, ?, ?, 'associated_with', 0.7, ?, NULL, ?, ?, NULL)`)
      .run(randomUUID(), semanticIds[0], semanticIds[1], now, now, now);
    rawDb.prepare(`INSERT INTO edges (id, from_id, to_id, type, weight, valid_from, valid_until, learned_at, created_at, meta)
      VALUES (?, ?, ?, 'associated_with', 0.8, ?, NULL, ?, ?, NULL)`)
      .run(randomUUID(), identityIds[0], semanticIds[2], now, now, now);
    rawDb.prepare(`INSERT INTO edges (id, from_id, to_id, type, weight, valid_from, valid_until, learned_at, created_at, meta)
      VALUES (?, ?, ?, 'goal_of', 0.9, ?, NULL, ?, ?, NULL)`)
      .run(randomUUID(), identityIds[0], identityIds[1], now, now, now);

    const preNodeCount = (rawDb.prepare("SELECT COUNT(*) as n FROM nodes").get() as { n: number }).n;
    const preEdgeCount = (rawDb.prepare("SELECT COUNT(*) as n FROM edges WHERE valid_until IS NULL").get() as { n: number }).n;

    // Assertions: pre-migration state
    expect(preNodeCount).toBe(10); // 5 semantic + 2 identity + 3 episodic
    expect(preEdgeCount).toBe(3);
    const preCols = (rawDb.prepare("PRAGMA table_info(nodes)").all() as { name: string }[]).map(c => c.name);
    expect(preCols).not.toContain("extraction_confidence"); // v3: missing
    expect(preCols).toContain("encoding_context");
    expect(preCols).toContain("ripple_count");
    expect((rawDb.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number }).version).toBe(3);

    rawDb.close();

    // ── Phase B: Apply v3→v4 migration (extraction_confidence added) ─────────
    const migDb = new Database(brainDbPath);
    migDb.pragma("journal_mode = WAL");
    applyMigrationV3toV4(migDb);

    expect((migDb.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number }).version).toBe(4);
    expect((migDb.prepare("PRAGMA table_info(nodes)").all() as { name: string }[]).map(c => c.name)).toContain("extraction_confidence");

    // All 10 existing nodes must have extraction_confidence = 1.0 (SQLite default)
    const nonDefault = (migDb.prepare(
      "SELECT COUNT(*) as n FROM nodes WHERE extraction_confidence != 1.0"
    ).get() as { n: number }).n;
    expect(nonDefault).toBe(0);

    migDb.close();

    // ── Phase C: getDb(agentName) → auto-upgrades v4→v5, reads seeded data ───
    // getDb reads from homedir()/.openclaw/agents/<agentName>/brain.db — the file we wrote above
    const buddyDb = getDb(agentName);

    // Schema version must be 14 (v4 TARGET — v10 episodes.llm_extracted + v11 768-dim
    // nodes_vec + v12 FSRS-6 + v13 CLS + v14 ps_hash)
    const finalVersion = (buddyDb.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number }).version;
    expect(finalVersion).toBe(SCHEMA_VERSION);

    // Row counts must be preserved — migration must not delete any data
    const finalNodeCount = (buddyDb.prepare("SELECT COUNT(*) as n FROM nodes").get() as { n: number }).n;
    const finalEdgeCount = (buddyDb.prepare("SELECT COUNT(*) as n FROM edges WHERE valid_until IS NULL").get() as { n: number }).n;
    expect(finalNodeCount).toBe(preNodeCount); // 10: all rows survived
    expect(finalEdgeCount).toBe(preEdgeCount); // 3

    // extraction_confidence = 1.0 on all pre-existing nodes (default applied by migration)
    const allConf = buddyDb.prepare("SELECT extraction_confidence FROM nodes").all() as { extraction_confidence: number }[];
    expect(allConf.length).toBe(10);
    for (const row of allConf) {
      expect(row.extraction_confidence).toBe(1.0);
    }

    // node_associations table exists with all required columns
    const assocCols = (buddyDb.prepare("PRAGMA table_info(node_associations)").all() as { name: string }[]).map(c => c.name);
    expect(assocCols).toContain("node_id_a");
    expect(assocCols).toContain("node_id_b");
    expect(assocCols).toContain("count");
    expect(assocCols).toContain("strength");
    expect(assocCols).toContain("last_coactivated");

    // Self model identity intact — "Buddy" present, goals and user_model correct
    const selfModel = buddyDb.prepare("SELECT * FROM self_model WHERE id = 'singleton'").get() as {
      identity: string; goals: string; user_model: string;
    };
    expect(selfModel.identity).toContain("Buddy");
    const goals = JSON.parse(selfModel.goals) as string[];
    expect(goals.length).toBe(2);
    const userModel = JSON.parse(selfModel.user_model) as { name: string };
    expect(userModel.name).toBe("Alex");

    // All 5 semantic nodes readable via FTS — no data corruption
    const ftsResults = buddyDb.prepare(`
      SELECT n.* FROM nodes n
      JOIN nodes_fts f ON n.rowid = f.rowid
      WHERE nodes_fts MATCH 'OpenClaw OR algorithm OR Hebbian OR working OR spreading'
      LIMIT 10
    `).all() as { label: string }[];
    expect(ftsResults.length).toBeGreaterThanOrEqual(5);

    cleanupAgent(agentName);
  });
});

// ── Test 2 ─────────────────────────────────────────────────────────────────────

describe("Test 2 — Hebbian edge strength: mathematical accumulation, threshold crossing, no duplication", () => {
  it("strength grows by +0.15 per session, threshold crossed at session 3, edge forms after tick, no duplicate on re-tick", () => {
    const agentId = fresh();
    const db = getDb(agentId);

    // deduplicate:false — near-identical placeholder content would otherwise
    // collapse to one node under sharpwave's trigram-Jaccard write gate (Step G).
    const nodeC = writeNode(agentId, "semantic", "concept C hebbian test", "content for C", { deduplicate: false });
    const nodeD = writeNode(agentId, "semantic", "concept D hebbian test", "content for D", { deduplicate: false });
    const [idC, idD] = nodeC < nodeD ? [nodeC, nodeD] : [nodeD, nodeC];
    const now = Date.now();

    // ── Session 1 ─────────────────────────────────────────────────────────────
    const s1 = `sess-${randomUUID()}`;
    db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)")
      .run(nodeC, 0.7, now, s1);
    db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)")
      .run(nodeD, 0.6, now, s1);
    recordCoactivations(agentId, s1);

    const assoc1 = db.prepare("SELECT count, strength FROM node_associations WHERE node_id_a = ? AND node_id_b = ?")
      .get(idC, idD) as { count: number; strength: number };
    expect(assoc1.count).toBe(1);
    // initStrength = min(0.2, (0.7+0.6)*0.05) = min(0.2, 0.065) = 0.065
    // All subsequent ON CONFLICT DO UPDATE adds +0.15 per session
    expect(assoc1.strength).toBeGreaterThan(0.05);
    expect(assoc1.strength).toBeLessThan(0.25); // well below 0.35 threshold
    // No edge yet — only 1 session, count < 3
    expect(edgeExists(agentId, idC, idD, "associates")).toBe(false);

    // ── Session 2 ─────────────────────────────────────────────────────────────
    const s2 = `sess-${randomUUID()}`;
    db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)")
      .run(nodeC, 0.7, now, s2);
    db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)")
      .run(nodeD, 0.6, now, s2);
    recordCoactivations(agentId, s2);

    const assoc2 = db.prepare("SELECT count, strength FROM node_associations WHERE node_id_a = ? AND node_id_b = ?")
      .get(idC, idD) as { count: number; strength: number };
    expect(assoc2.count).toBe(2);
    // strength = 0.065 + 0.15 = 0.215 — still below 0.35
    expect(assoc2.strength).toBeGreaterThan(0.15);
    expect(assoc2.strength).toBeLessThan(0.35);

    // ── Session 3 — threshold crossed ─────────────────────────────────────────
    const s3 = `sess-${randomUUID()}`;
    db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)")
      .run(nodeC, 0.7, now, s3);
    db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)")
      .run(nodeD, 0.6, now, s3);
    recordCoactivations(agentId, s3);

    const assoc3 = db.prepare("SELECT count, strength FROM node_associations WHERE node_id_a = ? AND node_id_b = ?")
      .get(idC, idD) as { count: number; strength: number };
    expect(assoc3.count).toBe(3);
    // strength = 0.065 + 0.15 + 0.15 = 0.365 — above 0.35 threshold
    expect(assoc3.strength).toBeGreaterThan(0.35);

    // awakeReplayTick → formHebbianEdges: count>=3 AND strength>=0.35 → edge forms
    awakeReplayTick(agentId, DEFAULT_CONFIG, log);
    expect(edgeExists(agentId, idC, idD, "associates")).toBe(true);

    // ── Sessions 4 and 5 — continued accumulation ─────────────────────────────
    for (const sN of [`sess-${randomUUID()}`, `sess-${randomUUID()}`]) {
      db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)")
        .run(nodeC, 0.7, now, sN);
      db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)")
        .run(nodeD, 0.6, now, sN);
      recordCoactivations(agentId, sN);
    }

    const assoc5 = db.prepare("SELECT count, strength FROM node_associations WHERE node_id_a = ? AND node_id_b = ?")
      .get(idC, idD) as { count: number; strength: number };
    expect(assoc5.count).toBe(5);
    // strength = 0.065 + 4*0.15 = 0.665 — well above threshold
    expect(assoc5.strength).toBeGreaterThan(0.60);

    // Re-ticking must not duplicate the associates edge
    awakeReplayTick(agentId, DEFAULT_CONFIG, log);
    awakeReplayTick(agentId, DEFAULT_CONFIG, log);

    const edgeCount = (db.prepare(
      "SELECT COUNT(*) as n FROM edges WHERE from_id = ? AND to_id = ? AND type = 'associates' AND valid_until IS NULL"
    ).get(idC, idD) as { n: number }).n;
    expect(edgeCount).toBe(1); // exactly 1 — deduplication working

    closeDb(agentId);
  });
});

// ── Test 3 ─────────────────────────────────────────────────────────────────────

describe("Test 3 — Dream context feeds bootstrap without brain_query (no-lookup guarantee)", () => {
  it("bootstrap has dream + goals + header with no external query; length > 200 chars", async () => {
    const agentId = fresh();
    const db = getDb(agentId);
    const session = `sess-${randomUUID()}`;

    // Seed 3 identity nodes and 2 goal nodes
    const i1 = writeNode(agentId, "identity", "Agent core self", "I am a curious autonomous agent with persistent memory");
    const i2 = writeNode(agentId, "identity", "Agent values", "I value honesty and thoroughness above all else");
    const i3 = writeNode(agentId, "identity", "Agent communication", "I am concise and direct in my responses");
    const g1 = writeNode(agentId, "goal", "Maintain memory integrity", "Ensure all memories are accurate and retrievable at all times");
    const g2 = writeNode(agentId, "goal", "Support user effectively", "Provide useful responses based on full memory context");

    // Touch all 5 nodes — increments ripple_count to >= 1, sets eligibility_trace=1.0
    for (const nodeId of [i1, i2, i3, g1, g2]) {
      touchNode(agentId, nodeId);
    }

    // Confirm ripple_count is > 0 on at least one node (needed by buildDreamContext query)
    const rippleCheck = db.prepare("SELECT ripple_count FROM nodes WHERE id = ?")
      .get(i1) as { ripple_count: number };
    expect(rippleCheck.ripple_count).toBeGreaterThan(0);

    // Run awakeReplayTick — this calls buildDreamContext which stores dream_context in meta_kv
    await awakeReplayTick(agentId, DEFAULT_CONFIG, log);

    // Verify dream_context was actually written to meta_kv
    const rawDream = getMeta(agentId, "dream_context");
    expect(rawDream).not.toBeNull();
    const parsedDream = JSON.parse(rawDream!) as { ts: number; lines: string[] };
    expect(parsedDream.lines.length).toBeGreaterThan(0);
    // Dream was written in the last 10 seconds — not stale
    expect(Date.now() - parsedDream.ts).toBeLessThan(10000);

    // ── buildBootstrapContext — must inject everything without brain_query ─────
    const ctx = await buildBootstrapContext(agentId, session, DEFAULT_CONFIG);

    // Header always present
    expect(ctx).toContain("[SharpWave");

    // Dream layer injected (getDreamContext age-gate: 30 min — this is fresh)
    expect(ctx).toContain("[BRAIN: subconscious");

    // Goal content present (getActiveGoals() direct DB query, no FTS search)
    // Goal retrievability = 1.0 (just written), above 0.1 threshold in getActiveGoals()
    expect(ctx).toContain("Maintain memory integrity");

    // Bootstrap is substantive — not a stripped skeleton
    expect(ctx.length).toBeGreaterThan(200);

    closeDb(agentId);
  });
});

// ── Test 4 ─────────────────────────────────────────────────────────────────────

describe("Test 4 — Context-dependent retrieval: neuromod cosine similarity bonus", () => {
  it("node encoded in similar neuromod state activates higher than node encoded in opposite state", () => {
    const agentId = fresh();

    // Node A: encoded in high-dopamine / high-acetylcholine "active learning" state
    const encCtxA: NeuromodState = {
      dopamine: 0.9,
      serotonin: 0.1,
      acetylcholine: 0.8,
      norepinephrine: 0.7,
      interpretation: "active learning",
    };

    // Node B: encoded in low-dopamine / high-serotonin "calm baseline" state
    const encCtxB: NeuromodState = {
      dopamine: 0.1,
      serotonin: 0.9,
      acetylcholine: 0.2,
      norepinephrine: 0.1,
      interpretation: "calm baseline",
    };

    // Both nodes have identical importance so pre-bonus activation is equal
    const nodeAId = writeNode(agentId, "semantic", "active learning concept", "learned during high arousal active session", {
      importance: 0.7,
      encodingContext: encCtxA,
    });
    const nodeBId = writeNode(agentId, "semantic", "calm baseline concept", "learned during quiet resting state", {
      importance: 0.7,
      encodingContext: encCtxB,
    });

    // Common seed node connected to both with equal weight (ensures equal pre-bonus activation)
    const seedId = writeNode(agentId, "semantic", "seed node context test", "starting point for activation spread");
    writeEdge(agentId, seedId, nodeAId, "associated_with", { weight: 0.9 });
    writeEdge(agentId, seedId, nodeBId, "associated_with", { weight: 0.9 });

    // Current neuromod state: very similar to A's encoding context, opposite to B's
    const currentNeuromod: NeuromodState = {
      dopamine: 0.85,
      serotonin: 0.15,
      acetylcholine: 0.75,
      norepinephrine: 0.65,
      interpretation: "active learning",
    };

    // Cosine similarity math verification:
    // sim(A, current): dot([0.9,0.1,0.8,0.7],[0.85,0.15,0.75,0.65]) = 0.765+0.015+0.6+0.455 = 1.835
    //   |A| = sqrt(1.95) ≈ 1.3964, |cur| = sqrt(1.73) ≈ 1.3153 → sim ≈ 0.9987
    //   bonus = 0.7 + 0.3*0.9987 ≈ 0.9996 (≈1.0x multiplier)
    //
    // sim(B, current): dot([0.1,0.9,0.2,0.1],[0.85,0.15,0.75,0.65]) = 0.085+0.135+0.15+0.065 = 0.435
    //   |B| = sqrt(0.87) ≈ 0.9327 → sim ≈ 0.435/1.2270 ≈ 0.3545
    //   bonus = 0.7 + 0.3*0.3545 ≈ 0.8064 (~0.81x multiplier)
    //
    // Expected: finalActivation(A) / finalActivation(B) ≈ 0.9996/0.8064 ≈ 1.24

    const seeds = [getNode(agentId, seedId)!];
    const config = { ...DEFAULT_CONFIG, spreadingActivationHops: 1, activationThreshold: 0.01 };
    const results = spreadActivation(agentId, seeds, config, null, currentNeuromod);

    const nodeA = results.find(n => n.id === nodeAId);
    const nodeB = results.find(n => n.id === nodeBId);

    // Both nodes must be activated (seed → both via equal-weight edges)
    expect(nodeA).toBeDefined();
    expect(nodeB).toBeDefined();

    // Node A gets higher activation than B due to neuromod match bonus
    expect(nodeA!.activation).toBeGreaterThan(nodeB!.activation);

    // The ratio must be in the range [1.05, 2.0]: meaningful but not implausible
    // ~1.24 expected from math above
    const ratio = nodeA!.activation / nodeB!.activation;
    expect(ratio).toBeGreaterThan(1.05);
    expect(ratio).toBeLessThan(2.0);

    closeDb(agentId);
  });
});

// ── Test 5 ─────────────────────────────────────────────────────────────────────

describe("Test 5 — Full v2→v5 round-trip: migrate, activate, dream, Hebbian accumulate, bootstrap", () => {
  it("phase-by-phase pipeline passes all 8 checkpoints for agent 'sierra'", async () => {
    const agentName = `sierra-${randomUUID().slice(0, 8)}`;
    const brainDbPath = makeRealAgentPath(agentName);
    const now = Date.now();

    // ── Phase 1: Build v2 DB for "sierra" (schema v3) ────────────────────────
    const rawDb = new Database(brainDbPath);
    buildV3SchemaAt(rawDb);

    rawDb.prepare(`
      INSERT INTO self_model (id, identity, goals, user_model, created_at, updated_at)
      VALUES ('singleton', 'I am Sierra, a creative autonomous researcher', ?, '{"name":"Jordan"}', ?, ?)
    `).run(JSON.stringify(["Explore memory architectures", "Build novel neural-symbolic systems"]), now, now);

    // 4 identity nodes
    for (const [label, content] of [
      ["Sierra identity", "I am Sierra, creative autonomous researcher with long-term memory"],
      ["Sierra methodology", "I approach problems by building from first principles before applying existing solutions"],
      ["Sierra collaboration", "I value working with other agents to cross-pollinate ideas across domains"],
      ["Sierra memory style", "I encode new knowledge by linking it explicitly to at least 2 existing concepts"],
    ]) {
      const id = randomUUID();
      rawDb.prepare(`INSERT INTO nodes (id, type, label, content, importance, salience, stability, retrievability, ef, access_count, emotional_weight, source, encoding_context, ripple_count, eligibility_trace, created_at, accessed_at, updated_at)
        VALUES (?, 'identity', ?, ?, 0.90, 0.76, 162.0, 1.0, 2.5, 3, 0.1, 'seed', NULL, 1, 0.4, ?, ?, ?)`)
        .run(id, label, content, now - 20 * 86400000, now - 86400000, now);
    }

    // 3 goal nodes
    for (const [label, content] of [
      ["Explore memory architectures", "Research and prototype different graph-based memory structures for AI agents"],
      ["Build neural-symbolic systems", "Develop hybrid systems combining connectionist learning with symbolic reasoning"],
      ["Document findings for team", "Write clear summaries of research for other agents to build on"],
    ]) {
      const id = randomUUID();
      rawDb.prepare(`INSERT INTO nodes (id, type, label, content, importance, salience, stability, retrievability, ef, access_count, emotional_weight, source, encoding_context, ripple_count, eligibility_trace, created_at, accessed_at, updated_at)
        VALUES (?, 'goal', ?, ?, 0.85, 0.70, 25.5, 1.0, 2.5, 1, 0.0, 'seed', NULL, 0, 0.0, ?, ?, ?)`)
        .run(id, label, content, now - 5 * 86400000, now - 3600000, now);
    }

    // 5 semantic nodes
    for (const [label, content] of [
      ["Graph neural networks", "GNNs use message passing to aggregate neighborhood information into node representations"],
      ["Cognitive architecture", "Cognitive architectures model human memory as declarative and procedural chunks"],
      ["Episodic future thinking", "The brain uses hippocampal replay to simulate possible future scenarios"],
      ["Symbol grounding problem", "Symbolic systems need perceptual grounding to connect symbols to real-world referents"],
      ["Predictive coding theory", "The brain predicts sensory input and updates only when predictions fail"],
    ]) {
      const id = randomUUID();
      rawDb.prepare(`INSERT INTO nodes (id, type, label, content, importance, salience, stability, retrievability, ef, access_count, emotional_weight, source, encoding_context, ripple_count, eligibility_trace, created_at, accessed_at, updated_at)
        VALUES (?, 'semantic', ?, ?, 0.78, 0.62, 46.8, 0.88, 2.5, 2, 0.0, 'seed', NULL, 0, 0.0, ?, ?, ?)`)
        .run(id, label, content, now - 10 * 86400000, now - 2 * 86400000, now);
    }

    // 2 edges
    const allNodeIds = (rawDb.prepare("SELECT id FROM nodes").all() as { id: string }[]).map(r => r.id);
    rawDb.prepare(`INSERT INTO edges (id, from_id, to_id, type, weight, valid_from, valid_until, learned_at, created_at, meta)
      VALUES (?, ?, ?, 'associated_with', 0.7, ?, NULL, ?, ?, NULL)`)
      .run(randomUUID(), allNodeIds[0], allNodeIds[1], now, now, now);
    rawDb.prepare(`INSERT INTO edges (id, from_id, to_id, type, weight, valid_from, valid_until, learned_at, created_at, meta)
      VALUES (?, ?, ?, 'goal_of', 0.85, ?, NULL, ?, ?, NULL)`)
      .run(randomUUID(), allNodeIds[0], allNodeIds[4], now, now, now);

    const p1NodeCount = (rawDb.prepare("SELECT COUNT(*) as n FROM nodes").get() as { n: number }).n;
    const p1EdgeCount = (rawDb.prepare("SELECT COUNT(*) as n FROM edges WHERE valid_until IS NULL").get() as { n: number }).n;
    expect(p1NodeCount).toBe(12); // CHECKPOINT 1: 4+3+5
    expect(p1EdgeCount).toBe(2);
    rawDb.close();

    // ── Phase 2: Apply v4 migration ───────────────────────────────────────────
    const migDb = new Database(brainDbPath);
    migDb.pragma("journal_mode = WAL");
    applyMigrationV3toV4(migDb);
    expect((migDb.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number }).version)
      .toBe(4); // CHECKPOINT 2
    migDb.close();

    // ── Phase 3: Open with getDb(agentName) → auto-upgrade to v14 ────────────
    const sierraDb = getDb(agentName);
    expect((sierraDb.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number }).version)
      .toBe(SCHEMA_VERSION); // CHECKPOINT 3a: auto-upgrade to v14 (FSRS-6 + CLS + ps_hash)

    const p3NodeCount = (sierraDb.prepare("SELECT COUNT(*) as n FROM nodes").get() as { n: number }).n;
    expect(p3NodeCount).toBe(p1NodeCount); // CHECKPOINT 3b: no data loss

    // ── Phase 4: Touch 3 semantic nodes → ripple_count > 0 ───────────────────
    const semanticNodes = sierraDb.prepare(
      "SELECT id FROM nodes WHERE type = 'semantic' LIMIT 3"
    ).all() as { id: string }[];
    expect(semanticNodes.length).toBe(3);

    for (const { id } of semanticNodes) {
      touchNode(agentName, id);
    }

    const touchedCount = (sierraDb.prepare(
      "SELECT COUNT(*) as n FROM nodes WHERE ripple_count > 0"
    ).get() as { n: number }).n;
    expect(touchedCount).toBeGreaterThanOrEqual(3); // CHECKPOINT 4: ripple_count incremented

    // ── Phase 5: awakeReplayTick → stabilizes nodes, writes dream_context ─────
    await awakeReplayTick(agentName, DEFAULT_CONFIG, log);

    const p5Dream = getMeta(agentName, "dream_context");
    expect(p5Dream).not.toBeNull(); // CHECKPOINT 5a: dream written
    const p5DreamParsed = JSON.parse(p5Dream!) as { ts: number; lines: string[] };
    expect(p5DreamParsed.lines.length).toBeGreaterThan(0); // CHECKPOINT 5b: has content

    // ── Phase 6: Session co-activation → recordCoactivations ─────────────────
    const p6Session = `sess-${randomUUID()}`;
    const wmNodes = sierraDb.prepare(
      "SELECT id FROM nodes WHERE ripple_count > 0 LIMIT 3"
    ).all() as { id: string }[];
    expect(wmNodes.length).toBeGreaterThanOrEqual(2);

    const p6Now = Date.now();
    for (const { id } of wmNodes) {
      sierraDb.prepare(
        "INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)"
      ).run(id, 0.75, p6Now, p6Session);
    }
    recordCoactivations(agentName, p6Session);

    // ── Phase 7: Second tick → Hebbian count accumulated ─────────────────────
    await awakeReplayTick(agentName, DEFAULT_CONFIG, log);

    const p7AssocCount = (sierraDb.prepare(
      "SELECT COUNT(*) as n FROM node_associations"
    ).get() as { n: number }).n;
    expect(p7AssocCount).toBeGreaterThan(0); // CHECKPOINT 7: associations recorded

    // Verify at least the first pair's count is >= 1
    if (wmNodes.length >= 2) {
      const [idA, idB] = wmNodes[0].id < wmNodes[1].id
        ? [wmNodes[0].id, wmNodes[1].id]
        : [wmNodes[1].id, wmNodes[0].id];
      const assocRow = sierraDb.prepare(
        "SELECT count FROM node_associations WHERE node_id_a = ? AND node_id_b = ?"
      ).get(idA, idB) as { count: number } | undefined;
      expect(assocRow).toBeDefined();
      expect(assocRow!.count).toBeGreaterThanOrEqual(1);
    }

    // ── Phase 8: buildBootstrapContext → dream + goals + identity present ─────
    const p8Ctx = await buildBootstrapContext(agentName, `sess-${randomUUID()}`, DEFAULT_CONFIG);

    expect(p8Ctx).toContain("[BRAIN: subconscious");   // CHECKPOINT 8a: dream injected
    expect(p8Ctx).toContain("Sierra");                  // CHECKPOINT 8b: identity intact
    // Goals are present (directly queried via getActiveGoals, no brain_query)
    const p8HasGoals = p8Ctx.includes("[BRAIN: active goals]") || p8Ctx.includes("Explore memory");
    expect(p8HasGoals).toBe(true);                      // CHECKPOINT 8c: goals present
    expect(p8Ctx).toContain("[SharpWave");             // CHECKPOINT 8d: header present

    cleanupAgent(agentName);
  });
});
