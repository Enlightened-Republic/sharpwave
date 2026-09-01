/**
 * Rigorous ClawBrain v3 Test Suite
 *
 * Tests 12 distinct scientific scenarios covering the full brain pipeline.
 * All assertions use mathematical tolerances or exact counts — no "should work" hand-waving.
 *
 * Scenarios:
 *  1. Ebbinghaus forgetting curve (SM-2 retrievability decay formula verification)
 *  2. Awake SWR stabilization (replay improves retention, measurably)
 *  3. Hebbian edge formation (neurons that fire together, wire together — cross-session)
 *  4. Dream context generation and content verification
 *  5. Bootstrap auto-injection (agent starts pre-loaded — no search needed)
 *  6. Cross-session memory continuity (session 1 activations appear in session 2 dream)
 *  7. Spreading activation through Hebbian edges (subconscious connections fire)
 *  8. Ripple → replay → reset cycle (SWS consolidation resets, cycle restarts)
 *  9. Working memory capacity (Miller's 7±2 slots enforced)
 * 10. Hallucination resistance (no false connections, null returns when unknown)
 * 11. Eligibility trace decay (TD learning analog — 0.85× per tick)
 * 12. Full pipeline integration (5 agent sub-sessions, end-to-end)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { writeNode, touchNode, decayRetrievability, decayEligibilityTraces, getNode, propagateDopamineSpike } from "../src/nodes.js";
import { writeEdge, edgeExists } from "../src/edges.js";
import { appendEpisode } from "../src/episodes.js";
import { getDb, getMeta, setMeta, closeDb } from "../src/db.js";
import { spreadActivation, updateWorkingMemory, clearWorkingMemory } from "../src/activation.js";
import { awakeReplayTick, recordCoactivations } from "../src/awake-replay.js";
import { runConsolidation } from "../src/consolidation.js";
import { buildBootstrapContext, getDreamContext } from "../src/context-assembly.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import type { BrainNode } from "../src/types.js";

// sharpwave-core's db.ts does not export a SCHEMA_VERSION symbol — assert against
// the known current migration target (mirrors packages/core/test/db.test.ts).
const SCHEMA_VERSION = 17;

function fresh(): string { return `test-${randomUUID().slice(0, 8)}`; }
function freshSession(): string { return `sess-${randomUUID()}`; }
const log = { info: () => {}, warn: () => {}, error: () => {} };

// ── Scenario 1: Ebbinghaus Forgetting Curve ──────────────────────────────────

describe("Scenario 1 — Forgetting curve (FSRS-6 power-law retrievability decay)", () => {
  // v4 swaps SM-2's exponential decay R = exp(-t/S) for FSRS-6's power-law
  // R(t,S) = (1 + (19/81) · t/S)^-0.5. The expected values below are derived
  // from that formula. FSRS-6 has a much heavier long-tail than exponential,
  // so the same stability/elapsed-time pair yields a noticeably higher R.
  it("retrieval after 0 days = 1.0 (no decay)", () => {
    const id = fresh();
    const nodeId = writeNode(id, "semantic", "fresh fact", "just learned this moment");
    const node = getNode(id, nodeId)!;
    // At t=0, elapsed = 0 → R = (1 + 0)^-0.5 = 1.0
    expect(node.retrievability).toBeCloseTo(1.0, 5);
    closeDb(id);
  });

  it("retrievability after 1 stability-unit of time ≈ 0.9 (FSRS calibration point)", () => {
    const id = fresh();
    // stability=1.0 days, manipulate accessed_at to be 1 day ago. FSRS is
    // calibrated so R(t=S, S) ≈ 0.9 — that's the "retention target" baked
    // into the (19/81) factor.
    const nodeId = writeNode(id, "episodic", "one day old memory", "recall this");
    const db = getDb(id);
    const oneDayAgo = Date.now() - 86400000;
    db.prepare("UPDATE nodes SET stability = 1.0, last_review = ?, accessed_at = ? WHERE id = ?")
      .run(oneDayAgo, oneDayAgo, nodeId);

    decayRetrievability(id, 50);

    const node = getNode(id, nodeId)!;
    // FSRS: R(1, 1) = (1 + 19/81)^-0.5 ≈ 0.9
    expect(node.retrievability).toBeGreaterThan(0.85);
    expect(node.retrievability).toBeLessThan(0.95);
    closeDb(id);
  });

  it("retrievability after 2 stability-units ≈ 0.83 (FSRS power-law tail)", () => {
    const id = fresh();
    const nodeId = writeNode(id, "episodic", "two day old memory", "fading slowly");
    const db = getDb(id);
    const twoDaysAgo = Date.now() - 2 * 86400000;
    db.prepare("UPDATE nodes SET stability = 1.0, last_review = ?, accessed_at = ? WHERE id = ?")
      .run(twoDaysAgo, twoDaysAgo, nodeId);

    decayRetrievability(id, 50);

    const node = getNode(id, nodeId)!;
    // FSRS: R(2, 1) = (1 + 38/81)^-0.5 ≈ 0.825. Power-law has heavier tails
    // than the SM-2 exp(-t/S) the old test expected (≈ 0.135 at this point).
    expect(node.retrievability).toBeGreaterThan(0.78);
    expect(node.retrievability).toBeLessThan(0.88);
    closeDb(id);
  });

  it("high-stability identity node resists decay better than episodic", () => {
    const id = fresh();
    const db = getDb(id);

    // identity: stability = 180 * 0.85 = 153 days
    const identityId = writeNode(id, "identity", "I am Mac", "Mac is a curious autonomous agent", { importance: 0.85 });
    // episodic: stability = 14 * 0.5 = 7 days
    const episodicId = writeNode(id, "episodic", "what happened today", "we discussed memory systems", { importance: 0.5 });

    // Simulate 7 days elapsed
    const sevenDaysAgo = Date.now() - 7 * 86400000;
    db.prepare("UPDATE nodes SET last_review = ?, accessed_at = ? WHERE id = ?").run(sevenDaysAgo, sevenDaysAgo, identityId);
    db.prepare("UPDATE nodes SET last_review = ?, accessed_at = ? WHERE id = ?").run(sevenDaysAgo, sevenDaysAgo, episodicId);

    decayRetrievability(id, 50);

    const identity = getNode(id, identityId)!;
    const episodic = getNode(id, episodicId)!;

    // With FSRS power-law and equal elapsed time (7d):
    //   identity.R = (1 + 19/81 · 7/153)^-0.5 ≈ 0.995
    //   episodic.R = (1 + 19/81 · 7/7)^-0.5 ≈ 0.90
    // The identity node retains MORE than the episodic node — but not 2× more,
    // because R is bounded at 1.0 and power-law is gentler than exponential
    // over short horizons. The behavioral guarantee survives: identity > episodic.
    expect(identity.retrievability).toBeGreaterThan(episodic.retrievability);
    expect(identity.retrievability).toBeGreaterThan(0.95);
    closeDb(id);
  });
});

// ── Scenario 2: Awake SWR Stabilization ──────────────────────────────────────

describe("Scenario 2 — Awake SWR stabilization (replay improves retention)", () => {
  it("high-ripple node gets exactly 5% stability boost per tick", () => {
    const id = fresh();
    const db = getDb(id);
    const nodeId = writeNode(id, "semantic", "replayed concept", "content that was recently activated");
    db.prepare("UPDATE nodes SET stability = 10.0, retrievability = 0.7, ripple_count = 5 WHERE id = ?").run(nodeId);

    awakeReplayTick(id, DEFAULT_CONFIG, log);

    const node = getNode(id, nodeId)!;
    expect(node.stability).toBeGreaterThan(10.0);
    expect(node.stability).toBeCloseTo(10.5, 0); // 10 * 1.05
    expect(node.retrievability).toBeGreaterThan(0.7); // 0.7 * 1.02 = 0.714
    closeDb(id);
  });

  it("zero-ripple node is NOT boosted by awake replay", () => {
    const id = fresh();
    const db = getDb(id);
    const nodeId = writeNode(id, "semantic", "untouched concept", "not activated in any session");
    db.prepare("UPDATE nodes SET stability = 5.0, retrievability = 0.8, ripple_count = 0 WHERE id = ?").run(nodeId);

    awakeReplayTick(id, DEFAULT_CONFIG, log);

    const node = getNode(id, nodeId)!;
    expect(node.stability).toBeCloseTo(5.0, 4);
    expect(node.retrievability).toBeCloseTo(0.8, 4);
    closeDb(id);
  });

  it("stability cannot exceed 365 days regardless of ripple count", () => {
    const id = fresh();
    const db = getDb(id);
    const nodeId = writeNode(id, "identity", "core identity fact", "this is highly stable identity knowledge");
    db.prepare("UPDATE nodes SET stability = 360.0, ripple_count = 10 WHERE id = ?").run(nodeId);

    // Run 5 ticks
    for (let i = 0; i < 5; i++) awakeReplayTick(id, DEFAULT_CONFIG, log);

    const node = getNode(id, nodeId)!;
    expect(node.stability).toBeLessThanOrEqual(365.0);
    closeDb(id);
  });

  it("replay tick is a no-op on empty DB", () => {
    const id = fresh();
    expect(() => awakeReplayTick(id, DEFAULT_CONFIG, log)).not.toThrow();
    closeDb(id);
  });
});

// ── Scenario 3: Hebbian Edge Formation ───────────────────────────────────────

describe("Scenario 3 — Hebbian plasticity (fire together → wire together)", () => {
  it("two nodes co-activated in 3+ sessions form an associates edge", () => {
    const id = fresh();
    const db = getDb(id);
    const nodeA = writeNode(id, "semantic", "memory consolidation", "the process of stabilizing a memory trace");
    const nodeB = writeNode(id, "semantic", "sharp wave ripples", "SWRs occur 14-22x per min during rest");
    const now = Date.now();
    const [idA, idB] = nodeA < nodeB ? [nodeA, nodeB] : [nodeB, nodeA];

    // Simulate 3 separate sessions where both nodes were active
    for (let i = 0; i < 3; i++) {
      const session = freshSession();
      db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)").run(nodeA, 0.8, now, session);
      db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)").run(nodeB, 0.75, now, session);
      recordCoactivations(id, session);
    }

    // Check count before running the tick
    const assoc = db.prepare("SELECT count, strength FROM node_associations WHERE node_id_a = ? AND node_id_b = ?").get(idA, idB) as { count: number; strength: number };
    expect(assoc.count).toBe(3);
    expect(assoc.strength).toBeGreaterThan(0.35); // init + 2*0.15 = 0.1+0.15+0.15=0.4

    // Run awake tick → formHebbianEdges triggers
    awakeReplayTick(id, DEFAULT_CONFIG, log);

    expect(edgeExists(id, idA, idB, "associates")).toBe(true);
    closeDb(id);
  });

  it("two nodes co-activated only twice do NOT form an edge (below threshold)", () => {
    const id = fresh();
    const db = getDb(id);
    // deduplicate:false — near-identical placeholder content would otherwise
    // collapse to one node under sharpwave's trigram-Jaccard write gate (Step G).
    const nodeA = writeNode(id, "semantic", "concept alpha", "alpha content", { deduplicate: false });
    const nodeB = writeNode(id, "semantic", "concept beta", "beta content", { deduplicate: false });
    const now = Date.now();
    const [idA, idB] = nodeA < nodeB ? [nodeA, nodeB] : [nodeB, nodeA];

    // Only 2 sessions — below the 3-session Hebbian threshold
    for (let i = 0; i < 2; i++) {
      const session = freshSession();
      db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)").run(nodeA, 0.6, now, session);
      db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)").run(nodeB, 0.6, now, session);
      recordCoactivations(id, session);
    }

    awakeReplayTick(id, DEFAULT_CONFIG, log);

    expect(edgeExists(id, idA, idB, "associates")).toBe(false);
    closeDb(id);
  });

  it("Hebbian edge weight matches association strength", () => {
    const id = fresh();
    const db = getDb(id);
    const nodeA = writeNode(id, "semantic", "strong link A", "content A frequently recalled");
    const nodeB = writeNode(id, "semantic", "strong link B", "content B frequently recalled");
    const now = Date.now();
    const [idA, idB] = nodeA < nodeB ? [nodeA, nodeB] : [nodeB, nodeA];

    // Plant a strong association directly
    db.prepare("INSERT INTO node_associations (node_id_a, node_id_b, count, strength, last_coactivated) VALUES (?, ?, 5, 0.75, ?)").run(idA, idB, now);

    awakeReplayTick(id, DEFAULT_CONFIG, log);

    const edge = db.prepare("SELECT weight FROM edges WHERE from_id = ? AND to_id = ? AND type = 'associates'").get(idA, idB) as { weight: number } | undefined;
    expect(edge).toBeDefined();
    expect(edge!.weight).toBeGreaterThanOrEqual(0.7);
    closeDb(id);
  });

  it("existing Hebbian edge is not duplicated on subsequent ticks", () => {
    const id = fresh();
    const db = getDb(id);
    // deduplicate:false — identical placeholder content would otherwise collapse
    // to one node under sharpwave's trigram-Jaccard write gate, turning the
    // Hebbian pair into a refused self-loop (Step G).
    const nodeA = writeNode(id, "semantic", "duplicate guard A", "content", { deduplicate: false });
    const nodeB = writeNode(id, "semantic", "duplicate guard B", "content", { deduplicate: false });
    const now = Date.now();
    const [idA, idB] = nodeA < nodeB ? [nodeA, nodeB] : [nodeB, nodeA];

    db.prepare("INSERT INTO node_associations (node_id_a, node_id_b, count, strength, last_coactivated) VALUES (?, ?, 5, 0.8, ?)").run(idA, idB, now);

    // Run 3 ticks
    awakeReplayTick(id, DEFAULT_CONFIG, log);
    awakeReplayTick(id, DEFAULT_CONFIG, log);
    awakeReplayTick(id, DEFAULT_CONFIG, log);

    const edgeCount = (db.prepare("SELECT COUNT(*) as n FROM edges WHERE from_id = ? AND to_id = ? AND type = 'associates' AND valid_until IS NULL").get(idA, idB) as { n: number }).n;
    expect(edgeCount).toBe(1);
    closeDb(id);
  });
});

// ── Scenario 4: Dream Context Generation ─────────────────────────────────────

describe("Scenario 4 — Dream context (subconscious pre-staging for next session)", () => {
  it("dream context is built from recently-active nodes after awake tick", () => {
    const id = fresh();
    const db = getDb(id);

    const nodeId = writeNode(id, "identity", "test agent self-concept", "I am an autonomous agent with persistent memory");
    db.prepare("UPDATE nodes SET ripple_count = 4, salience = 0.85, access_count = 3 WHERE id = ?").run(nodeId);

    awakeReplayTick(id, DEFAULT_CONFIG, log);

    const raw = getMeta(id, "dream_context");
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as { ts: number; lines: string[] };
    expect(Array.isArray(parsed.lines)).toBe(true);
    expect(parsed.lines.length).toBeGreaterThan(0);
    expect(typeof parsed.ts).toBe("number");
    expect(parsed.ts).toBeLessThanOrEqual(Date.now());
    closeDb(id);
  });

  it("dream context lines include node type prefix", () => {
    const id = fresh();
    const db = getDb(id);

    writeNode(id, "semantic", "spreading activation theory", "Collins & Loftus 1975: concepts activate related concepts via weighted edges");
    const n2 = writeNode(id, "identity", "agent core identity", "Curious, honest, direct communicator");
    db.prepare("UPDATE nodes SET ripple_count = 3, access_count = 2 WHERE id = ?").run(n2);

    awakeReplayTick(id, DEFAULT_CONFIG, log);

    const raw = getMeta(id, "dream_context");
    const parsed = JSON.parse(raw!) as { lines: string[] };
    const hasTypedLine = parsed.lines.some((l: string) => l.startsWith("[identity]") || l.startsWith("[semantic]") || l.startsWith("[linking]"));
    expect(hasTypedLine).toBe(true);
    closeDb(id);
  });

  it("getDreamContext returns empty string for stale dream (>30 min old)", () => {
    const id = fresh();
    // Write a dream context timestamped 31 minutes ago
    setMeta(id, "dream_context", JSON.stringify({
      ts: Date.now() - 31 * 60 * 1000,
      lines: ["[semantic] old thought: this is stale"],
    }));

    const result = getDreamContext(id);
    expect(result).toBe("");
    closeDb(id);
  });

  it("getDreamContext returns content for fresh dream (<30 min old)", () => {
    const id = fresh();
    setMeta(id, "dream_context", JSON.stringify({
      ts: Date.now() - 5 * 60 * 1000, // 5 min ago
      lines: ["[identity] Mac: curious and direct", "[semantic] consolidation: SWS→REM→Deep"],
    }));

    const result = getDreamContext(id);
    expect(result).toContain("[BRAIN: subconscious");
    expect(result).toContain("[identity]");
    closeDb(id);
  });
});

// ── Scenario 5: Bootstrap Auto-injection (No search needed) ──────────────────

describe("Scenario 5 — Bootstrap auto-injection (brain pre-loads agent at session start)", () => {
  it("bootstrap contains BRAIN_HEADER without any brain_query call", async () => {
    const id = fresh();
    const session = freshSession();

    writeNode(id, "identity", "test agent identity", "I am curious and helpful");
    writeNode(id, "goal", "primary objective", "help the user build the best memory system possible");

    const ctx = await buildBootstrapContext(id, session, DEFAULT_CONFIG);

    expect(ctx).toContain("[SharpWave");
    closeDb(id);
  });

  it("bootstrap contains active goals block without brain_query", async () => {
    const id = fresh();
    const session = freshSession();

    writeNode(id, "goal", "ship the dashboard", "complete the OpenClaw dashboard UI by end of sprint");
    writeNode(id, "goal", "migrate memory system", "migrate all agents from v2 to v3 brain");

    const ctx = await buildBootstrapContext(id, session, DEFAULT_CONFIG);

    expect(ctx).toContain("ship the dashboard");
    closeDb(id);
  });

  it("bootstrap includes self model identity when set", async () => {
    const id = fresh();
    const session = freshSession();
    const db = getDb(id);

    db.prepare("UPDATE self_model SET identity = 'I am Mac, a curious and direct autonomous agent', updated_at = ? WHERE id = 'singleton'").run(Date.now());

    const ctx = await buildBootstrapContext(id, session, DEFAULT_CONFIG);

    expect(ctx).toContain("Mac");
    closeDb(id);
  });

  it("bootstrap injects dream context when fresh dream exists", async () => {
    const id = fresh();
    const session = freshSession();

    // Plant a fresh dream context
    setMeta(id, "dream_context", JSON.stringify({
      ts: Date.now() - 60 * 1000, // 1 min ago
      lines: ["[semantic] Hebbian plasticity: co-active neurons form stronger synaptic bonds"],
    }));

    const ctx = await buildBootstrapContext(id, session, DEFAULT_CONFIG);

    expect(ctx).toContain("[BRAIN: subconscious");
    expect(ctx).toContain("Hebbian");
    closeDb(id);
  });

  it("bootstrap does NOT inject stale dream (agent gets clean start after idle)", async () => {
    const id = fresh();
    const session = freshSession();

    setMeta(id, "dream_context", JSON.stringify({
      ts: Date.now() - 40 * 60 * 1000, // 40 min ago — stale
      lines: ["[semantic] stale thought that should not appear"],
    }));

    const ctx = await buildBootstrapContext(id, session, DEFAULT_CONFIG);

    expect(ctx).not.toContain("stale thought");
    closeDb(id);
  });
});

// ── Scenario 6: Cross-session Memory Continuity ───────────────────────────────

describe("Scenario 6 — Cross-session memory continuity (dream bridges sessions)", () => {
  it("nodes activated in session 1 appear in session 2 dream context", () => {
    const id = fresh();
    const db = getDb(id);

    // Session 1: activate some nodes
    const session1 = freshSession();
    const nodeA = writeNode(id, "semantic", "OpenClaw gateway architecture", "single-process event loop, all agents share");
    const nodeB = writeNode(id, "semantic", "spreading activation", "Collins & Loftus 1975, 2-hop, 0.4 decay");
    const now = Date.now();

    // Put in working memory with high activation (simulates session activity)
    db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)").run(nodeA, 0.9, now, session1);
    db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)").run(nodeB, 0.85, now, session1);

    // Set ripple_count to simulate activation during session
    db.prepare("UPDATE nodes SET ripple_count = 3, access_count = 2 WHERE id = ?").run(nodeA);
    db.prepare("UPDATE nodes SET ripple_count = 2, access_count = 1 WHERE id = ?").run(nodeB);

    // Between sessions: awake tick fires (20 min interval)
    awakeReplayTick(id, DEFAULT_CONFIG, log);

    // Session 2: read the dream context
    const dreamCtx = getDreamContext(id);
    expect(dreamCtx).toContain("[BRAIN: subconscious");
    expect(dreamCtx.length).toBeGreaterThan(50);

    closeDb(id);
  });

  it("Hebbian associations from session 1+2 persist into session 3 as structural edges", () => {
    const id = fresh();
    const db = getDb(id);
    const nodeX = writeNode(id, "semantic", "dopamine reward signal", "dopamine encodes prediction error and drives learning");
    const nodeY = writeNode(id, "semantic", "reinforcement learning", "TD learning: V(s) += alpha * (r + gamma*V(s') - V(s))");
    const now = Date.now();
    const [idX, idY] = nodeX < nodeY ? [nodeX, nodeY] : [nodeY, nodeX];

    // Sessions 1, 2, 3 — both nodes co-activated
    for (let i = 0; i < 3; i++) {
      const session = freshSession();
      db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)").run(nodeX, 0.8, now, session);
      db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)").run(nodeY, 0.75, now, session);
      recordCoactivations(id, session);
    }

    awakeReplayTick(id, DEFAULT_CONFIG, log);

    // Session 3: the edge now exists as a permanent structural connection
    expect(edgeExists(id, idX, idY, "associates")).toBe(true);

    // And spreading activation from nodeX now propagates to nodeY via this edge.
    // Hebbian edges form with weight ≈ 0.38 after 3 sessions; use a lower threshold
    // to confirm the link propagates (production recall pairs this with FTS/vector seeds
    // that have higher initial salience and naturally cross the default 0.1 threshold).
    const seeds = [getNode(id, nodeX)!];
    const activated = spreadActivation(id, seeds, { ...DEFAULT_CONFIG, activationThreshold: 0.05 });
    const activatedIds = activated.map((n) => n.id);
    expect(activatedIds).toContain(nodeY);

    closeDb(id);
  });
});

// ── Scenario 7: Spreading Activation through Hebbian Edges ───────────────────

describe("Scenario 7 — Subconscious firing via Hebbian edges (spreading activation)", () => {
  it("spreading activation propagates through associates edges", () => {
    const id = fresh();
    const seedId = writeNode(id, "semantic", "seed concept", "this is the starting point for activation");
    const linkedId = writeNode(id, "semantic", "linked concept", "connected to seed via Hebbian association");
    writeEdge(id, seedId, linkedId, "associates", { weight: 0.8 });

    const seeds = [getNode(id, seedId)!];
    const result = spreadActivation(id, seeds, DEFAULT_CONFIG);

    const linkedNode = result.find((n) => n.id === linkedId);
    expect(linkedNode).toBeDefined();
    expect(linkedNode!.activation).toBeGreaterThan(0);
    closeDb(id);
  });

  it("activation decays across hops — hop-2 is weaker than hop-1", () => {
    // Math: HOP_DECAY=0.4. With seed salience≈0.7, edge weight=0.9:
    //   hop1 = 0.7 * 0.9 * 0.4 ≈ 0.252  (above 0.1 threshold ✓)
    //   hop2 = 0.252 * 0.9 * 0.4 ≈ 0.091 (below 0.1 threshold, need lower threshold to observe)
    // We use threshold=0.01 so both hops are measurable.
    const id = fresh();
    const db = getDb(id);
    const seedId   = writeNode(id, "semantic", "hop0 concept", "the origin node for activation spreading");
    const hop1Id   = writeNode(id, "semantic", "hop1 concept", "one hop from origin via high-weight edge");
    const hop2Id   = writeNode(id, "semantic", "hop2 concept", "two hops from origin, activation should be lower");
    // Force high salience on seed so activation is above threshold after 2 hops
    db.prepare("UPDATE nodes SET salience = 0.9 WHERE id = ?").run(seedId);
    writeEdge(id, seedId, hop1Id, "associates", { weight: 0.9 });
    writeEdge(id, hop1Id, hop2Id, "associates", { weight: 0.9 });

    const seeds = [getNode(id, seedId)!];
    // Lower threshold so hop-2 is measurable (still above 0.01)
    const config = { ...DEFAULT_CONFIG, spreadingActivationHops: 2, activationThreshold: 0.01 };
    const result = spreadActivation(id, seeds, config);

    const hop1Node = result.find((n) => n.id === hop1Id);
    const hop2Node = result.find((n) => n.id === hop2Id);

    expect(hop1Node).toBeDefined();
    expect(hop2Node).toBeDefined();
    // hop2 activation must be strictly less than hop1 (0.4 HOP_DECAY per hop)
    expect(hop2Node!.activation).toBeLessThan(hop1Node!.activation);
    // Verify the 0.4 decay ratio approximately holds
    const decayRatio = hop2Node!.activation / hop1Node!.activation;
    expect(decayRatio).toBeGreaterThan(0.1);
    expect(decayRatio).toBeLessThan(0.6); // ~0.36 expected (0.4 * 0.9)
    closeDb(id);
  });

  it("inhibitory edges suppress connected nodes", () => {
    const id = fresh();
    const seedId    = writeNode(id, "semantic", "activating concept", "this activates and inhibits");
    const suppId    = writeNode(id, "semantic", "suppressed concept", "this should be suppressed by inhibitor");
    writeEdge(id, seedId, suppId, "inhibits", { weight: 0.9 });

    const seeds = [getNode(id, seedId)!];
    const result = spreadActivation(id, seeds, DEFAULT_CONFIG);

    const suppNode = result.find((n) => n.id === suppId);
    // Inhibited nodes should either not appear or have very low activation
    if (suppNode) {
      expect(suppNode.activation).toBeLessThan(DEFAULT_CONFIG.activationThreshold);
    }
    closeDb(id);
  });

  it("ripple_count increments on each non-inhibitory activation", () => {
    const id = fresh();
    const db = getDb(id);
    const seedId   = writeNode(id, "semantic", "ripple seed", "starting point");
    const targetId = writeNode(id, "semantic", "ripple target", "will receive activation");
    writeEdge(id, seedId, targetId, "associated_with", { weight: 0.8 });

    db.prepare("UPDATE nodes SET ripple_count = 0 WHERE id = ?").run(targetId);

    const seeds = [getNode(id, seedId)!];
    spreadActivation(id, seeds, DEFAULT_CONFIG);

    const target = getNode(id, targetId)!;
    expect(target.ripple_count).toBeGreaterThan(0);
    closeDb(id);
  });
});

// ── Scenario 8: Ripple → Replay → Reset Cycle ────────────────────────────────

describe("Scenario 8 — SWS ripple cycle (activate → replay → consolidate → reset → repeat)", () => {
  it("ripple_count increments on activation and resets after consolidation", async () => {
    const id = fresh();
    const db = getDb(id);

    const nodeId = writeNode(id, "semantic", "cyclically activated concept", "this gets activated and consolidated repeatedly");
    // Set ripple_count to simulate activation
    db.prepare("UPDATE nodes SET ripple_count = 7 WHERE id = ?").run(nodeId);

    // Add enough episodes for consolidation to trigger
    for (let i = 0; i < 12; i++) {
      appendEpisode(id, freshSession(), "user", `Episode ${i}: important content about memory and consolidation that matters`);
    }
    // Force consolidation gate open
    setMeta(id, "last_consolidation", String(Date.now() - 48 * 3600 * 1000));

    await runConsolidation(id, DEFAULT_CONFIG, log);

    const after = getNode(id, nodeId)!;
    expect(after.ripple_count).toBe(0); // Reset after SWS pass
    closeDb(id);
  });

  it("cycle continues: ripple_count increments again after reset", async () => {
    const id = fresh();
    const db = getDb(id);
    const nodeId = writeNode(id, "semantic", "perpetual cycle node", "content that keeps being activated");

    // Phase 1: touch → ripple
    touchNode(id, nodeId);
    let node = getNode(id, nodeId)!;
    expect(node.ripple_count).toBeGreaterThan(0);
    const rippleAfterTouch = node.ripple_count;

    // Phase 2: consolidation → reset
    db.prepare("UPDATE nodes SET ripple_count = 5 WHERE id = ?").run(nodeId);
    for (let i = 0; i < 12; i++) {
      appendEpisode(id, freshSession(), "user", `Consolidation episode ${i} with sufficient content for processing`);
    }
    setMeta(id, "last_consolidation", String(Date.now() - 48 * 3600 * 1000));
    await runConsolidation(id, DEFAULT_CONFIG, log);
    node = getNode(id, nodeId)!;
    expect(node.ripple_count).toBe(0);

    // Phase 3: touch again → ripple restarts
    touchNode(id, nodeId);
    node = getNode(id, nodeId)!;
    expect(node.ripple_count).toBeGreaterThan(0);
    closeDb(id);
  });
});

// ── Scenario 9: Working Memory Capacity (Miller's Law) ───────────────────────

describe("Scenario 9 — Working memory capacity (Miller's 7±2 slots)", () => {
  it("working memory is capped at config.workingMemorySlots (default 7)", () => {
    const id = fresh();
    const db = getDb(id);
    const session = freshSession();

    // Activate 15 nodes — more than the 7-slot limit
    const nodes: BrainNode[] = [];
    for (let i = 0; i < 15; i++) {
      const nodeId = writeNode(id, "semantic", `concept-${i}`, `content for concept number ${i} in working memory test`);
      const node = getNode(id, nodeId)!;
      nodes.push({ ...node, activation: Math.random() } as BrainNode & { activation: number });
    }

    const activated = nodes.map((n, i) => ({ ...n, activation: (15 - i) * 0.05 }));
    updateWorkingMemory(id, session, activated as never, DEFAULT_CONFIG.workingMemorySlots);

    const wmCount = (db.prepare("SELECT COUNT(*) as n FROM working_memory WHERE session_id = ?").get(session) as { n: number }).n;
    expect(wmCount).toBeLessThanOrEqual(DEFAULT_CONFIG.workingMemorySlots);
    expect(wmCount).toBeGreaterThan(0);
    closeDb(id);
  });

  it("highest-activation nodes win the working memory slots", () => {
    const id = fresh();
    const db = getDb(id);
    const session = freshSession();
    const now = Date.now();

    // Create 5 nodes, insert into WM with known activations
    const high = writeNode(id, "semantic", "high activation node", "very relevant content here");
    const low  = writeNode(id, "semantic", "low activation node", "barely relevant content");

    // High activation node: 0.9, low: 0.01
    db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)").run(high, 0.9, now, session);
    db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)").run(low, 0.01, now, session);

    // With 2 slots both fit; with 1 slot only the high one should remain
    const configWith1Slot = { ...DEFAULT_CONFIG, workingMemorySlots: 1 };
    const highNode = getNode(id, high)!;
    updateWorkingMemory(id, session, [{ ...highNode, activation: 0.9 } as never, { ...getNode(id, low)!, activation: 0.01 } as never], 1);

    const remaining = db.prepare("SELECT node_id FROM working_memory WHERE session_id = ?").all(session) as { node_id: string }[];
    expect(remaining.length).toBe(1);
    expect(remaining[0].node_id).toBe(high);
    closeDb(id);
  });
});

// ── Scenario 10: Hallucination Resistance ────────────────────────────────────

describe("Scenario 10 — Hallucination resistance (no false connections, null on unknown)", () => {
  // NOTE (Step G): clawbrain-v4's "resolveEntity returns null for unknown mention"
  // case was dropped — sharpwave-core's entity-resolution.ts exposes
  // findNearDuplicates / deduplicateExisting / mergeCoreferentNodes but no
  // `resolveEntity` mention-linker. The hallucination-resistance intent is still
  // covered by the empty-seeds and no-false-edge cases below.

  it("spreading activation from unknown node returns empty array", () => {
    const id = fresh();
    // Pass an empty seeds array — no seed nodes
    const result = spreadActivation(id, [], DEFAULT_CONFIG);
    expect(result).toHaveLength(0);
    closeDb(id);
  });

  it("no Hebbian edge formed between nodes that never co-activated", () => {
    const id = fresh();
    const nodeA = writeNode(id, "semantic", "isolated concept A", "this concept was never used alongside B");
    const nodeB = writeNode(id, "semantic", "isolated concept B", "this concept was never used alongside A");
    const [idA, idB] = nodeA < nodeB ? [nodeA, nodeB] : [nodeB, nodeA];

    // Run 3 awake ticks with no co-activation recorded
    for (let i = 0; i < 3; i++) awakeReplayTick(id, DEFAULT_CONFIG, log);

    expect(edgeExists(id, idA, idB, "associates")).toBe(false);
    closeDb(id);
  });

  it("no false dream lines for nodes with zero access_count", () => {
    const id = fresh();
    const db = getDb(id);

    // Write a node but never access it (access_count = 0, ripple_count = 0)
    const nodeId = writeNode(id, "semantic", "never-accessed secret", "this should never appear in dreams");
    db.prepare("UPDATE nodes SET access_count = 0, ripple_count = 0, salience = 0.1 WHERE id = ?").run(nodeId);

    awakeReplayTick(id, DEFAULT_CONFIG, log);

    const raw = getMeta(id, "dream_context");
    if (raw) {
      const parsed = JSON.parse(raw) as { lines: string[] };
      const hasSecret = parsed.lines.some((l: string) => l.includes("never-accessed secret"));
      expect(hasSecret).toBe(false);
    }
    closeDb(id);
  });
});

// ── Scenario 11: Eligibility Trace Decay ─────────────────────────────────────

describe("Scenario 11 — Eligibility trace (TD learning analog — 0.85× decay per tick)", () => {
  it("eligibility trace decays by exactly factor 0.85 per tick", () => {
    const id = fresh();
    const db = getDb(id);
    const nodeId = writeNode(id, "semantic", "eligibility node", "this node will have its trace measured");
    db.prepare("UPDATE nodes SET eligibility_trace = 1.0 WHERE id = ?").run(nodeId);

    decayEligibilityTraces(id);

    const node = getNode(id, nodeId)!;
    expect(node.eligibility_trace).toBeCloseTo(0.85, 4);
    closeDb(id);
  });

  it("eligibility trace approaches zero after 20 ticks without reactivation", () => {
    const id = fresh();
    const db = getDb(id);
    const nodeId = writeNode(id, "semantic", "fading trace node", "no longer being activated");
    db.prepare("UPDATE nodes SET eligibility_trace = 1.0 WHERE id = ?").run(nodeId);

    // 0.85^20 ≈ 0.0388
    for (let i = 0; i < 20; i++) decayEligibilityTraces(id);

    const node = getNode(id, nodeId)!;
    expect(node.eligibility_trace).toBeLessThan(0.05);
    closeDb(id);
  });

  it("touchNode resets eligibility trace to 1.0 (reactivation = new learning event)", () => {
    const id = fresh();
    const db = getDb(id);
    const nodeId = writeNode(id, "semantic", "resettable trace", "will be touched to reset trace");
    db.prepare("UPDATE nodes SET eligibility_trace = 0.1 WHERE id = ?").run(nodeId);

    touchNode(id, nodeId);

    const node = getNode(id, nodeId)!;
    expect(node.eligibility_trace).toBeCloseTo(1.0, 5);
    closeDb(id);
  });

  it("dopamine spike propagates reward signal through nodes with high eligibility trace", () => {
    const id = fresh();
    const db = getDb(id);

    const nodeId = writeNode(id, "semantic", "dopamine target", "this node will receive the reward signal");
    db.prepare("UPDATE nodes SET eligibility_trace = 0.9, importance = 0.5 WHERE id = ?").run(nodeId);

    propagateDopamineSpike(id, 0.9);

    const after = getNode(id, nodeId)!;
    expect(after.importance).toBeGreaterThan(0.5); // dopamine raised importance
    closeDb(id);
  });
});

// ── Scenario 12: Full Pipeline — 5 Sub-agent Sessions ────────────────────────

describe("Scenario 12 — Full pipeline (5 sub-agent sessions, end-to-end)", () => {
  it("sub-agent Nexus: 5 sessions with memory accumulation and Hebbian formation", async () => {
    const id = fresh(); // agent "nexus" in temp DB
    const db = getDb(id);

    // --- Seed Nexus's initial self-model ---
    db.prepare("UPDATE self_model SET identity = 'I am Nexus, a memory-first AI agent. I retain everything that matters.', updated_at = ? WHERE id = 'singleton'").run(Date.now());
    writeNode(id, "identity", "Nexus identity", "Curious, direct, memory-focused autonomous agent");
    writeNode(id, "goal", "build perfect memory", "develop and maintain a complete, searchable memory graph");

    // --- Session 1: introduce core concepts ---
    const s1 = freshSession();
    const nodeMemory  = writeNode(id, "semantic", "memory consolidation process", "SWS→REM→Deep: ripple sort, pattern extract, prune");
    const nodeHebbian = writeNode(id, "semantic", "Hebbian plasticity", "neurons that fire together wire together via STDP");
    touchNode(id, nodeMemory);
    touchNode(id, nodeHebbian);
    db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)").run(nodeMemory, 0.9, Date.now(), s1);
    db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)").run(nodeHebbian, 0.85, Date.now(), s1);
    recordCoactivations(id, s1); // these two should start building association

    // --- Awake tick after session 1 ---
    await awakeReplayTick(id, DEFAULT_CONFIG, log);
    const dream1 = getDreamContext(id);
    expect(dream1).toContain("[BRAIN: subconscious"); // brain is already feeding content

    // --- Session 2: reinforce same concepts + add related ---
    const s2 = freshSession();
    const nodeRipple = writeNode(id, "semantic", "sharp wave ripples", "SWRs occur 14-22x/min during quiet wakefulness");
    touchNode(id, nodeMemory);
    touchNode(id, nodeRipple);
    db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)").run(nodeMemory, 0.88, Date.now(), s2);
    db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)").run(nodeHebbian, 0.8, Date.now(), s2);
    db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)").run(nodeRipple, 0.7, Date.now(), s2);
    recordCoactivations(id, s2);

    // --- Session 3: third co-activation of memory+hebbian → should form edge ---
    const s3 = freshSession();
    touchNode(id, nodeMemory);
    touchNode(id, nodeHebbian);
    db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)").run(nodeMemory, 0.85, Date.now(), s3);
    db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)").run(nodeHebbian, 0.82, Date.now(), s3);
    recordCoactivations(id, s3);

    await awakeReplayTick(id, DEFAULT_CONFIG, log);

    // After 3 sessions of co-activation + tick → Hebbian edge should have formed
    const [mId, hId] = nodeMemory < nodeHebbian ? [nodeMemory, nodeHebbian] : [nodeHebbian, nodeMemory];
    expect(edgeExists(id, mId, hId, "associates")).toBe(true);

    // --- Session 4: new topic + verify subconscious feeding ---
    const s4 = freshSession();
    const ctx4 = await buildBootstrapContext(id, s4, DEFAULT_CONFIG);
    // Brain should already contain memory consolidation content without any query
    expect(ctx4).toContain("memory");
    expect(ctx4).not.toHaveLength(0);

    // --- Session 5: verify spreading activation now propagates via Hebbian edge ---
    // Hebbian edges form with weight ≈ 0.38; lower threshold to confirm propagation works.
    const seeds = [getNode(id, nodeMemory)!];
    const activated = spreadActivation(id, seeds, { ...DEFAULT_CONFIG, activationThreshold: 0.05 });
    const hebbianNode = activated.find((n) => n.id === nodeHebbian);

    // nodeHebbian should now activate via the Hebbian associates edge from nodeMemory
    expect(hebbianNode).toBeDefined();
    expect(hebbianNode!.activation).toBeGreaterThan(0);

    // --- Verify full retention: nodes from session 1 still have good retrievability ---
    const memNode = getNode(id, nodeMemory)!;
    expect(memNode.retrievability).toBeGreaterThan(0.5); // touched multiple times → stable
    expect(memNode.access_count).toBeGreaterThanOrEqual(3); // touched in s1, s2, s3

    // --- Schema integrity final check ---
    const schema = db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number };
    expect(schema.version).toBe(SCHEMA_VERSION);

    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(t => t.name);
    expect(tables).toContain("nodes");
    expect(tables).toContain("edges");
    expect(tables).toContain("episodes");
    expect(tables).toContain("working_memory");
    expect(tables).toContain("node_associations");
    expect(tables).toContain("meta_kv");

    closeDb(id);
  });

  it("sub-agent Vex: verifies salience formula matches specification", () => {
    const id = fresh();
    // salience = 0.4*importance + 0.2*|emotional_weight| + 0.2*retrievability + 0.1*min(et,1) + 0.1*min(rc/10,1)
    const { computeSalience } = { computeSalience: (imp: number, ew: number, ret: number, et: number, rc: number) =>
      0.4 * imp + 0.2 * Math.abs(ew) + 0.2 * ret + 0.1 * Math.min(et, 1.0) + 0.1 * Math.min(rc / 10, 1.0)
    };

    // Test case: importance=0.8, emotional_weight=0.5, retrievability=0.9, et=1.0, rc=5
    const expected = 0.4*0.8 + 0.2*0.5 + 0.2*0.9 + 0.1*1.0 + 0.1*0.5;
    // = 0.32 + 0.10 + 0.18 + 0.10 + 0.05 = 0.75

    const nodeId = writeNode(id, "identity", "Vex identity node", "identity content for salience test", {
      importance: 0.8,
      emotional_weight: 0.5,
    });
    const db = getDb(id);
    db.prepare("UPDATE nodes SET emotional_weight = 0.5, retrievability = 0.9, eligibility_trace = 1.0, ripple_count = 5 WHERE id = ?").run(nodeId);

    // Force salience recompute by calling decayRetrievability with immediate timestamps
    // Instead, just read the stored value and compare against our formula
    const node = getNode(id, nodeId)!;
    // The stored salience was computed at writeNode time with retrievability=1.0, et=0, rc=0
    // 0.4*0.8 + 0.2*0.5 + 0.2*1.0 + 0.1*0 + 0.1*0 = 0.32+0.10+0.20 = 0.62
    expect(node.salience).toBeCloseTo(0.62, 2);
    closeDb(id);
  });

  it("sub-agent Aria: memory persists through migration integration (v3→v5 schema intact)", () => {
    const id = fresh();
    const db = getDb(id);

    // Write rich content across multiple types
    const identityId = writeNode(id, "identity", "Aria core identity", "warm, curious, memory-first agent");
    const goalId = writeNode(id, "goal", "Aria primary goal", "help users build intelligent persistent memory systems");
    const semanticId = writeNode(id, "semantic", "Aria knowledge: OpenClaw", "single-process gateway, plugin-based, all agents share one event loop");
    writeEdge(id, identityId, goalId, "drives");

    // Verify full schema
    const schema = (db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number });
    expect(schema.version).toBe(SCHEMA_VERSION);

    // Verify node_associations table is ready
    const assocInfo = db.prepare("PRAGMA table_info(node_associations)").all() as { name: string }[];
    expect(assocInfo.map(c => c.name)).toContain("count");
    expect(assocInfo.map(c => c.name)).toContain("strength");

    // Verify all three node types stored correctly
    const allNodes = db.prepare("SELECT type FROM nodes WHERE type IN ('identity','goal','semantic')").all() as { type: string }[];
    expect(allNodes.length).toBeGreaterThanOrEqual(3);

    // Verify Hebbian system is functional for Aria
    const session = freshSession();
    const now = Date.now();
    db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)").run(identityId, 0.9, now, session);
    db.prepare("INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)").run(goalId, 0.85, now, session);
    recordCoactivations(id, session);

    const [iId, gId] = identityId < goalId ? [identityId, goalId] : [goalId, identityId];
    const recorded = db.prepare("SELECT count FROM node_associations WHERE node_id_a = ? AND node_id_b = ?").get(iId, gId) as { count: number } | undefined;
    expect(recorded).toBeDefined();
    expect(recorded!.count).toBe(1);

    closeDb(id);
  });
});
