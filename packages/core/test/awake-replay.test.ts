import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { writeNode } from "../src/nodes.js";
import { writeEdge, edgeExists } from "../src/edges.js";
import { getDb, getMeta, closeDb } from "../src/db.js";
import { awakeReplayTick, recordCoactivations } from "../src/awake-replay.js";
import { DEFAULT_CONFIG } from "../src/types.js";

// sharpwave-core's db.ts does not export a `SCHEMA_VERSION` symbol; assert
// against the known current value (mirrors packages/core/test/db.test.ts).
const SCHEMA_VERSION = 17;

// sharpwave-core's writeNode dedupes on near-identical content by default
// (trigram-Jaccard >= 0.85, type-scoped) — clawbrain-v4's writeNode did not.
// Fixtures below that create sibling nodes with near-identical placeholder
// content pass `{ deduplicate: false }` to keep distinct rows. Assertions are
// unchanged. (openwave/sharpwave-core split, Task 6C.)

function fresh(): string { return `test-${randomUUID().slice(0, 8)}`; }
const log = { info: () => {}, warn: () => {} };

describe("awake-replay", () => {
  it("awakeReplayTick runs without error on empty DB", () => {
    const id = fresh();
    expect(() => awakeReplayTick(id, DEFAULT_CONFIG, log)).not.toThrow();
    closeDb(id);
  });

  it("awakeReplayTick stabilizes high-ripple nodes", () => {
    const id = fresh();
    const db = getDb(id);
    const nodeId = writeNode(id, "semantic", "test concept", "some content about concepts");
    db.prepare("UPDATE nodes SET ripple_count = 5, stability = 2.0, retrievability = 0.8 WHERE id = ?").run(nodeId);

    awakeReplayTick(id, DEFAULT_CONFIG, log);

    const node = db.prepare("SELECT stability, retrievability FROM nodes WHERE id = ?").get(nodeId) as {
      stability: number; retrievability: number;
    };
    expect(node.stability).toBeGreaterThan(2.0);
    expect(node.retrievability).toBeGreaterThan(0.8);
    closeDb(id);
  });

  it("awakeReplayTick does not modify nodes with ripple_count=0", () => {
    const id = fresh();
    const db = getDb(id);
    const nodeId = writeNode(id, "semantic", "quiet node", "this node has not been activated");
    db.prepare("UPDATE nodes SET stability = 3.0, retrievability = 0.9, ripple_count = 0 WHERE id = ?").run(nodeId);

    awakeReplayTick(id, DEFAULT_CONFIG, log);

    const node = db.prepare("SELECT stability, retrievability FROM nodes WHERE id = ?").get(nodeId) as {
      stability: number; retrievability: number;
    };
    expect(node.stability).toBeCloseTo(3.0, 5);
    expect(node.retrievability).toBeCloseTo(0.9, 5);
    closeDb(id);
  });

  it("recordCoactivations records pairs from working memory", () => {
    const id = fresh();
    const db = getDb(id);
    const nodeA = writeNode(id, "semantic", "concept A", "first concept");
    const nodeB = writeNode(id, "semantic", "concept B", "second concept");
    const session = "sess-" + randomUUID();
    const now = Date.now();

    db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)").run(nodeA, 0.8, now, session);
    db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)").run(nodeB, 0.6, now, session);

    recordCoactivations(id, session);

    const [idA, idB] = nodeA < nodeB ? [nodeA, nodeB] : [nodeB, nodeA];
    const assoc = db.prepare("SELECT count, strength FROM node_associations WHERE node_id_a = ? AND node_id_b = ?").get(idA, idB) as { count: number; strength: number } | undefined;
    expect(assoc).toBeDefined();
    expect(assoc!.count).toBe(1);
    expect(assoc!.strength).toBeGreaterThan(0);
    closeDb(id);
  });

  it("recordCoactivations accumulates count across multiple sessions", () => {
    const id = fresh();
    const db = getDb(id);
    const nodeA = writeNode(id, "semantic", "recurring A", "content", { deduplicate: false });
    const nodeB = writeNode(id, "semantic", "recurring B", "content", { deduplicate: false });
    const now = Date.now();
    const [idA, idB] = nodeA < nodeB ? [nodeA, nodeB] : [nodeB, nodeA];

    for (let i = 0; i < 3; i++) {
      const session = "sess-" + randomUUID();
      db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)").run(nodeA, 0.7, now, session);
      db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)").run(nodeB, 0.7, now, session);
      recordCoactivations(id, session);
    }

    const assoc = db.prepare("SELECT count, strength FROM node_associations WHERE node_id_a = ? AND node_id_b = ?").get(idA, idB) as { count: number; strength: number };
    expect(assoc.count).toBe(3);
    expect(assoc.strength).toBeGreaterThan(0.3); // 0.1 init + 0.15 * 2 updates
    closeDb(id);
  });

  it("formHebbianEdges creates associates edge when count >= 3", () => {
    const id = fresh();
    const db = getDb(id);
    const nodeA = writeNode(id, "semantic", "linked concept A", "content A that recurs", { deduplicate: false });
    const nodeB = writeNode(id, "semantic", "linked concept B", "content B that recurs", { deduplicate: false });
    const now = Date.now();
    const [idA, idB] = nodeA < nodeB ? [nodeA, nodeB] : [nodeB, nodeA];

    // Manually seed an association above the Hebbian threshold
    db.prepare(`
      INSERT INTO node_associations (node_id_a, node_id_b, count, strength, last_coactivated)
      VALUES (?, ?, 4, 0.6, ?)
    `).run(idA, idB, now);

    awakeReplayTick(id, DEFAULT_CONFIG, log);

    expect(edgeExists(id, idA, idB, "associates")).toBe(true);
    closeDb(id);
  });

  it("formHebbianEdges does NOT create edge below threshold (count < 3)", () => {
    const id = fresh();
    const db = getDb(id);
    const nodeA = writeNode(id, "semantic", "weak link A", "content A", { deduplicate: false });
    const nodeB = writeNode(id, "semantic", "weak link B", "content B", { deduplicate: false });
    const now = Date.now();
    const [idA, idB] = nodeA < nodeB ? [nodeA, nodeB] : [nodeB, nodeA];

    // Below threshold: count=2
    db.prepare(`
      INSERT INTO node_associations (node_id_a, node_id_b, count, strength, last_coactivated)
      VALUES (?, ?, 2, 0.5, ?)
    `).run(idA, idB, now);

    awakeReplayTick(id, DEFAULT_CONFIG, log);

    expect(edgeExists(id, idA, idB, "associates")).toBe(false);
    closeDb(id);
  });

  it("buildDreamContext stores dream_context in meta_kv after active nodes exist", () => {
    const id = fresh();
    const db = getDb(id);

    // Create nodes with ripple_count > 0 so the dream context picks them up
    const nodeId = writeNode(id, "identity", "test agent identity", "I am a curious AI exploring the world");
    db.prepare("UPDATE nodes SET ripple_count = 3, salience = 0.8, access_count = 2 WHERE id = ?").run(nodeId);

    awakeReplayTick(id, DEFAULT_CONFIG, log);

    const raw = getMeta(id, "dream_context");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { ts: number; lines: string[] };
    expect(parsed.lines.length).toBeGreaterThan(0);
    expect(typeof parsed.ts).toBe("number");
    closeDb(id);
  });

  // ── T4.6 — Prospective replay (Joo et al. 2024 Science) ────────────────
  // The awake tick should pre-activate the neighbours of any active goal
  // node so the next reasoning step finds them already warm. Specifically:
  //  - importance bumps by +0.1 (capped at 1.0) on the top-K neighbours
  //  - eligibility_trace bumps by +0.05
  //  - other goal nodes are NEVER pre-activated (would pollute goal stack)
  it("awakeReplayTick prospectively pre-activates neighbours of active goals", () => {
    const id = fresh();
    const db = getDb(id);

    // Active goal node
    const goalId = writeNode(id, "goal", "ship clawbrain v4", "ship the v4 build by end of week");
    db.prepare("UPDATE nodes SET retrievability = 0.8, salience = 0.9 WHERE id = ?").run(goalId);

    // Three neighbour nodes, linked to the goal with different weights.
    const neighA = writeNode(id, "skill", "write tests", "regression tests gate every tier");
    const neighB = writeNode(id, "semantic", "FSRS-6 formula", "DSR model replaces SM-2");
    const neighC = writeNode(id, "semantic", "openclaw cron", "cron jobs replace setInterval");
    const initialA = (db.prepare("SELECT importance FROM nodes WHERE id = ?").get(neighA) as { importance: number }).importance;

    writeEdge(id, goalId, neighA, "associated_with", { weight: 0.9 });
    writeEdge(id, goalId, neighB, "associated_with", { weight: 0.8 });
    writeEdge(id, goalId, neighC, "associated_with", { weight: 0.7 });

    // A neighbour we explicitly do NOT want pre-activated: another goal.
    const decoyGoal = writeNode(id, "goal", "another goal", "should not pre-activate other goals");
    writeEdge(id, goalId, decoyGoal, "associated_with", { weight: 1.0 });
    const decoyInitial = (db.prepare("SELECT importance FROM nodes WHERE id = ?").get(decoyGoal) as { importance: number }).importance;

    awakeReplayTick(id, DEFAULT_CONFIG, log);

    const finalA = db.prepare("SELECT importance, eligibility_trace FROM nodes WHERE id = ?").get(neighA) as { importance: number; eligibility_trace: number };
    expect(finalA.importance).toBeGreaterThan(initialA);
    expect(finalA.eligibility_trace).toBeGreaterThan(0);

    const finalDecoy = db.prepare("SELECT importance FROM nodes WHERE id = ?").get(decoyGoal) as { importance: number };
    expect(finalDecoy.importance).toBeCloseTo(decoyInitial, 5);

    closeDb(id);
  });

  it("schema version is current after getDb", () => {
    const id = fresh();
    const db = getDb(id);
    const row = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number };
    expect(row.version).toBe(SCHEMA_VERSION); // 17 — see const above

    closeDb(id);
  });

  it("node_associations table exists and has correct columns", () => {
    const id = fresh();
    const db = getDb(id);
    const info = db.prepare("PRAGMA table_info(node_associations)").all() as { name: string }[];
    const cols = info.map((c) => c.name);
    expect(cols).toContain("node_id_a");
    expect(cols).toContain("node_id_b");
    expect(cols).toContain("count");
    expect(cols).toContain("strength");
    expect(cols).toContain("last_coactivated");
    closeDb(id);
  });
});
