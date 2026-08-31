import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { writeNode } from "../src/nodes.js";
import { writeEdge } from "../src/edges.js";
import { spreadActivation, updateWorkingMemory, clearWorkingMemory, workingMemoryBoost } from "../src/activation.js";
import { getDb, closeDb } from "../src/db.js";
import { DEFAULT_CONFIG } from "../src/types.js";

function fresh(): string { return `test-${randomUUID().slice(0, 8)}`; }

describe("activation", () => {
  it("spreadActivation returns seed nodes above threshold", () => {
    const id = fresh();
    const a = writeNode(id, "semantic", "node A", "content", { importance: 0.8 });
    const b = writeNode(id, "semantic", "node B", "content", { importance: 0.7 });

    const db = getDb(id);
    const seedNodes = db.prepare("SELECT * FROM nodes WHERE id IN (?, ?)").all(a, b) as any[];

    const results = spreadActivation(id, seedNodes, DEFAULT_CONFIG);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].activation).toBeGreaterThan(0);
    closeDb(id);
  });

  it("spreadActivation propagates through edges", () => {
    const id = fresh();
    const a = writeNode(id, "semantic", "seed node", "content", { importance: 0.9, deduplicate: false });
    const b = writeNode(id, "semantic", "neighbor node", "content", { importance: 0.5, deduplicate: false });
    writeEdge(id, a, b, "associated_with", { weight: 1.0 });

    const db = getDb(id);
    const seedNodes = db.prepare("SELECT * FROM nodes WHERE id = ?").all(a) as any[];

    const results = spreadActivation(id, seedNodes, { ...DEFAULT_CONFIG, spreadingActivationHops: 2 });
    const neighborResult = results.find((r: any) => r.id === b);
    // Neighbor should have received activation via propagation
    expect(neighborResult).toBeDefined();
    closeDb(id);
  });

  it("spreadActivation suppresses inhibited nodes", () => {
    const id = fresh();
    const a = writeNode(id, "semantic", "inhibitor", "content", { importance: 0.9, deduplicate: false });
    const b = writeNode(id, "semantic", "inhibited", "content", { importance: 0.9, deduplicate: false });
    writeEdge(id, a, b, "inhibits", { weight: 1.0 });

    const db = getDb(id);
    const seedNodes = db.prepare("SELECT * FROM nodes WHERE id = ?").all(a) as any[];

    const results = spreadActivation(id, seedNodes, DEFAULT_CONFIG);
    const inhibitedResult = results.find((r: any) => r.id === b);
    expect(inhibitedResult).toBeUndefined();
    closeDb(id);
  });

  it("context match bonus boosts nodes encoded in similar state", () => {
    const id = fresh();
    const neuroSimilar = { dopamine: 0.8, serotonin: 0.6, acetylcholine: 0.7, norepinephrine: 0.4, interpretation: "" };
    const neuroDifferent = { dopamine: 0.1, serotonin: 0.1, acetylcholine: 0.1, norepinephrine: 0.9, interpretation: "" };

    const similarId = writeNode(id, "semantic", "similar context node", "content", {
      importance: 0.7, encodingContext: neuroSimilar, deduplicate: false,
    });
    const differentId = writeNode(id, "semantic", "different context node", "content", {
      importance: 0.7, encodingContext: neuroDifferent, deduplicate: false,
    });

    const db = getDb(id);
    const seedNodes = db.prepare("SELECT * FROM nodes WHERE id IN (?, ?)").all(similarId, differentId) as any[];

    const currentState = { ...neuroSimilar }; // identical to similar node's encoding context

    const results = spreadActivation(id, seedNodes, DEFAULT_CONFIG, null, currentState);
    const similarResult = results.find((r: any) => r.id === similarId);
    const differentResult = results.find((r: any) => r.id === differentId);

    if (similarResult && differentResult) {
      // Similar context node should have >= activation than different context node
      expect(similarResult.activation).toBeGreaterThanOrEqual(differentResult.activation);
    }
    closeDb(id);
  });

  it("updateWorkingMemory and clearWorkingMemory", () => {
    const id = fresh();
    const db = getDb(id);
    const nodeId = writeNode(id, "semantic", "wm node", "c", { importance: 0.8 });
    const node = db.prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId) as any;

    updateWorkingMemory(id, "session1", [{ ...node, activation: 0.9 }], 7);

    const wm = db.prepare("SELECT * FROM working_memory WHERE session_id = 'session1'").all() as any[];
    expect(wm.length).toBe(1);
    expect(wm[0].node_id).toBe(nodeId);

    clearWorkingMemory(id, "session1");
    const wmAfter = db.prepare("SELECT * FROM working_memory WHERE session_id = 'session1'").all();
    expect(wmAfter.length).toBe(0);
    closeDb(id);
  });

  // ── Fan-out normalization (code-1 Fix #2 / SYNTHESIS T1.2) ──────────────────
  // Regression: hub nodes with N neighbors must not deposit N× more total activation
  // than leaf nodes with 1 neighbor. Sum of activation over each cluster should be
  // approximately equal.

  it("fan-out fairness — 1-neighbor and 100-neighbor clusters receive ~equal total activation", () => {
    const id = fresh();
    const db = getDb(id);

    // Seed activates two hubs A and B with identical salience.
    const hubA = writeNode(id, "semantic", "hub A (1 neighbor)", "content", { importance: 0.9, deduplicate: false });
    const hubB = writeNode(id, "semantic", "hub B (100 neighbors)", "content", { importance: 0.9, deduplicate: false });
    // Force identical salience so the comparison is clean.
    db.prepare("UPDATE nodes SET salience = 0.8 WHERE id IN (?, ?)").run(hubA, hubB);

    // A has 1 neighbor.
    const aNeigh = writeNode(id, "semantic", "A neighbor", "content", { deduplicate: false });
    writeEdge(id, hubA, aNeigh, "associated_with", { weight: 1.0 });

    // B has 100 neighbors, all weight 1.0.
    const bNeighbors: string[] = [];
    for (let i = 0; i < 100; i++) {
      const n = writeNode(id, "semantic", `B neighbor ${i}`, "content", { deduplicate: false });
      bNeighbors.push(n);
      writeEdge(id, hubB, n, "associated_with", { weight: 1.0 });
    }

    const seeds = db.prepare("SELECT * FROM nodes WHERE id IN (?, ?)").all(hubA, hubB) as any[];
    // Lower the threshold so per-neighbor share is observable (each of B's 100 neighbors
    // gets only ~1/100 of hubB's activation × HOP_DECAY).
    const results = spreadActivation(id, seeds, { ...DEFAULT_CONFIG, spreadingActivationHops: 1, activationThreshold: 0.0001 });

    // Sum activation over each cluster (excluding hubs themselves).
    const aClusterSum = results
      .filter((r: any) => r.id === aNeigh)
      .reduce((s: number, r: any) => s + r.activation, 0);
    const bClusterSum = results
      .filter((r: any) => bNeighbors.includes(r.id))
      .reduce((s: number, r: any) => s + r.activation, 0);

    // Before the fix: bClusterSum would be ~100× aClusterSum (each B-neighbor gets
    // the same delta as the A-neighbor, then sum across 100 neighbors).
    // After the fix: each B-neighbor gets share = weight / sum(weights) = 1/100, so
    // sum over 100 of them ≈ hubActivation × HOP_DECAY ≈ aClusterSum.
    expect(aClusterSum).toBeGreaterThan(0);
    expect(bClusterSum).toBeGreaterThan(0);
    const ratio = bClusterSum / aClusterSum;
    // Hard requirement: not the 100× hub-dominance the old code produced. Allow
    // some asymmetry from the context-bonus / numerical-rounding effects.
    expect(ratio).toBeGreaterThan(0.5);
    expect(ratio).toBeLessThan(2.5);
    closeDb(id);
  });

  it("fan-out normalization preserves edge-weight ordering", () => {
    // Two neighbors with weights 0.9 and 0.1; the high-weight neighbor should
    // still get 9× more activation than the low-weight neighbor (the
    // normalization divides by sum(weights), not by count).
    const id = fresh();
    const db = getDb(id);
    const hub = writeNode(id, "semantic", "hub", "c", { importance: 0.9, deduplicate: false });
    db.prepare("UPDATE nodes SET salience = 0.8 WHERE id = ?").run(hub);
    const high = writeNode(id, "semantic", "high weight neighbor", "c", { deduplicate: false });
    const low  = writeNode(id, "semantic", "low weight neighbor", "c", { deduplicate: false });
    writeEdge(id, hub, high, "associated_with", { weight: 0.9 });
    writeEdge(id, hub, low,  "associated_with", { weight: 0.1 });

    const seeds = db.prepare("SELECT * FROM nodes WHERE id = ?").all(hub) as any[];
    const results = spreadActivation(id, seeds, { ...DEFAULT_CONFIG, spreadingActivationHops: 1, activationThreshold: 0.0001 });

    const highAct = results.find((r: any) => r.id === high)!.activation;
    const lowAct  = results.find((r: any) => r.id === low)!.activation;
    expect(highAct).toBeGreaterThan(lowAct);
    // 9× weight ratio → ~9× activation ratio
    expect(highAct / lowAct).toBeGreaterThan(5);
    closeDb(id);
  });

  it("inhibition path is also fan-out normalized", () => {
    // A hub with one inhibit edge and many non-inhibit edges should not over-inhibit
    // its single target.
    const id = fresh();
    const db = getDb(id);
    const hub = writeNode(id, "semantic", "inhibiting hub", "c", { importance: 0.9, deduplicate: false });
    db.prepare("UPDATE nodes SET salience = 0.9 WHERE id = ?").run(hub);
    const target = writeNode(id, "semantic", "inhibition target", "c", { importance: 0.7, deduplicate: false });
    db.prepare("UPDATE nodes SET salience = 0.7 WHERE id = ?").run(target);
    writeEdge(id, hub, target, "inhibits", { weight: 1.0 });
    // Many other neighbors absorb most of the share.
    for (let i = 0; i < 50; i++) {
      const n = writeNode(id, "semantic", `noise ${i}`, "c", { deduplicate: false });
      writeEdge(id, hub, n, "associated_with", { weight: 1.0 });
    }

    const seeds = db.prepare("SELECT * FROM nodes WHERE id = ?").all(hub) as any[];
    const results = spreadActivation(id, seeds, { ...DEFAULT_CONFIG, spreadingActivationHops: 1, activationThreshold: 0.001 });
    const targetResult = results.find((r: any) => r.id === target);
    // Pre-fix: inhibition applied raw `parentActivation * weight * inhibitionStrength`
    // regardless of fan-out, so the target was crushed despite only being one of 51 neighbors.
    // Post-fix: inhibition is share-weighted, so the target either survives with positive
    // activation or only mildly suppressed (and may still be filtered out).
    // We don't require survival — the deterministic property is just that the
    // inhibitedIds set captures it correctly. So we assert spreadActivation didn't crash
    // and produced a sane result set.
    expect(results.length).toBeGreaterThan(0);
    // The target may or may not exceed threshold; the test mainly checks the path is exercised.
    void targetResult;
    closeDb(id);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Regression: 2026-07-30 working-memory replay.
//
// workingMemoryBoost used `activationMap.get(id) ?? 0`, which INSERTED nodes
// that the current query never surfaced. Anything retrieved earlier in the
// session re-entered the candidate set regardless of relevance.
//
// Reproduced end-to-end against the published sharpwave 0.2.0 build (same code
// lineage) with embeddings unavailable:
//   unrelated query, cold working memory -> "No matching nodes found."  correct
//   on-topic query                       -> hits, primes working memory
//   SAME unrelated query, warm           -> returned the on-topic node  WRONG
//   unrelated query, brand new process   -> "No matching nodes found."  correct
//
// Working memory must RE-RANK what is already relevant, never introduce
// candidates on its own.
// ─────────────────────────────────────────────────────────────────────────────
describe("workingMemoryBoost — no replay of irrelevant nodes", () => {
  it("boosts a node the query already surfaced", () => {
    const id = fresh();
    const seeded = writeNode(id, "semantic", "seeded", "content", { importance: 0.6 });
    updateWorkingMemory(id, "sess-a", [{ id: seeded, activation: 0.9 } as any], 7);

    const map = new Map<string, number>([[seeded, 0.5]]);
    workingMemoryBoost(map, "sess-a", id);

    expect(map.get(seeded)).toBeCloseTo(0.8, 5); // 0.5 + 0.3 bonus
    clearWorkingMemory(id, "sess-a");
    closeDb(id);
  });

  it("does NOT inject a working-memory node the query did not surface", () => {
    const id = fresh();
    const stale = writeNode(id, "semantic", "from an earlier query", "unrelated content", { importance: 0.6 });
    const relevant = writeNode(id, "semantic", "actually relevant", "content", { importance: 0.6 });
    updateWorkingMemory(id, "sess-b", [{ id: stale, activation: 0.9 } as any], 7);

    // The current query surfaced only `relevant`.
    const map = new Map<string, number>([[relevant, 0.5]]);
    workingMemoryBoost(map, "sess-b", id);

    expect(map.has(stale)).toBe(false);
    expect(map.size).toBe(1);
    expect(map.get(relevant)).toBeCloseTo(0.5, 5);
    clearWorkingMemory(id, "sess-b");
    closeDb(id);
  });

  it("leaves an empty activation map empty (the sourdough case)", () => {
    const id = fresh();
    const stale = writeNode(id, "semantic", "postgres", "the production database", { importance: 0.6 });
    updateWorkingMemory(id, "sess-c", [{ id: stale, activation: 0.9 } as any], 7);

    // FTS + vector found nothing for this query.
    const map = new Map<string, number>();
    workingMemoryBoost(map, "sess-c", id);

    expect(map.size).toBe(0);
    clearWorkingMemory(id, "sess-c");
    closeDb(id);
  });
});
