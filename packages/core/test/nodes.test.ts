import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  writeNode, getNode, touchNode, ftsSearchNodes, getActiveGoals,
  computeSalience, decayEligibilityTraces, getNeighbors,
  fsrsRetrievability, getRetrievability, computePsHash, psHashHamming,
} from "../src/nodes.js";
import { writeEdge } from "../src/edges.js";
import { getDb, closeDb } from "../src/db.js";

function fresh(): string { return `test-${randomUUID().slice(0, 8)}`; }

describe("nodes", () => {
  it("writeNode creates node with correct fields", () => {
    const id = fresh();
    const nodeId = writeNode(id, "semantic", "test label", "test content", { importance: 0.7 });
    const node = getNode(id, nodeId);

    expect(node).toBeDefined();
    expect(node!.type).toBe("semantic");
    expect(node!.label).toBe("test label");
    expect(node!.content).toBe("test content");
    expect(node!.importance).toBe(0.7);
    expect(node!.retrievability).toBe(1.0);
    expect(node!.ripple_count).toBe(0);
    expect(node!.eligibility_trace).toBe(0.0);
    expect(node!.extraction_confidence).toBe(1.0);
    closeDb(id);
  });

  it("writeNode stores encoding_context when provided", () => {
    const id = fresh();
    const neuroState = { dopamine: 0.7, serotonin: 0.5, acetylcholine: 0.8, norepinephrine: 0.3, interpretation: "test" };
    const nodeId = writeNode(id, "semantic", "ctx test", "content", { encodingContext: neuroState });
    const node = getNode(id, nodeId);

    expect(node!.encoding_context).not.toBeNull();
    const parsed = JSON.parse(node!.encoding_context!);
    expect(parsed.dopamine).toBe(0.7);
    expect(parsed.serotonin).toBe(0.5);
    closeDb(id);
  });

  it("writeNode stores extractionConfidence", () => {
    const id = fresh();
    const nodeId = writeNode(id, "semantic", "extracted", "content", { extractionConfidence: 0.85 });
    const node = getNode(id, nodeId);
    expect(node!.extraction_confidence).toBe(0.85);
    closeDb(id);
  });

  it("touchNode updates SM-2 fields and increments ripple_count", () => {
    const id = fresh();
    const nodeId = writeNode(id, "episodic", "touch test", "content");
    const before = getNode(id, nodeId)!;

    touchNode(id, nodeId, 4);

    const after = getNode(id, nodeId)!;
    expect(after.access_count).toBe(before.access_count + 1);
    expect(after.ripple_count).toBe(before.ripple_count + 1);
    expect(after.eligibility_trace).toBe(1.0);
    closeDb(id);
  });

  it("ftsSearchNodes returns matching nodes", () => {
    const id = fresh();
    writeNode(id, "semantic", "OpenClaw gateway config", "The gateway handles routing and sessions");
    writeNode(id, "semantic", "unrelated topic", "nothing to do with the query");

    const results = ftsSearchNodes(id, "OpenClaw gateway", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].label).toContain("OpenClaw");
    closeDb(id);
  });

  it("getActiveGoals returns goal nodes with retrievability > 0.1", () => {
    const id = fresh();
    writeNode(id, "goal", "active goal", "finish the build", { importance: 0.8 });
    const goals = getActiveGoals(id);
    expect(goals.length).toBeGreaterThan(0);
    expect(goals[0].type).toBe("goal");
    closeDb(id);
  });

  it("computeSalience weights all components correctly", () => {
    const sal = computeSalience(0.8, 0.5, 0.9, 0.5, 5);
    expect(sal).toBeGreaterThan(0.5);
    expect(sal).toBeLessThanOrEqual(1.0);
  });

  it("decayEligibilityTraces reduces trace below threshold", () => {
    const id = fresh();
    const db = getDb(id);
    const nodeId = writeNode(id, "semantic", "traced node", "content");
    db.prepare("UPDATE nodes SET eligibility_trace = 0.5 WHERE id = ?").run(nodeId);

    decayEligibilityTraces(id);

    const node = getNode(id, nodeId)!;
    expect(node.eligibility_trace).toBeCloseTo(0.5 * 0.85, 3);
    closeDb(id);
  });

  it("identity nodes get higher initial stability than episodic", () => {
    const id = fresh();
    const identId = writeNode(id, "identity", "who I am", "content", { importance: 0.8 });
    const epId = writeNode(id, "episodic", "what happened", "content", { importance: 0.8 });

    const ident = getNode(id, identId)!;
    const ep = getNode(id, epId)!;
    expect(ident.stability).toBeGreaterThan(ep.stability);
    closeDb(id);
  });

  it("getNeighbors does not return duplicate nodes when bidirectional edges exist (UNION dedup)", () => {
    const id = fresh();
    const nodeA = writeNode(id, "semantic", "node A", "content A");
    const nodeB = writeNode(id, "semantic", "node B", "content B");

    // Create a single directed edge A → B
    writeEdge(id, nodeA, nodeB, "associated_with", { weight: 0.8 });

    // From A's perspective: B appears as outgoing neighbor
    const neighborsOfA = getNeighbors(id, nodeA);
    const bFromA = neighborsOfA.filter((n) => n.node.id === nodeB);
    expect(bFromA.length).toBe(1); // Must appear exactly once

    // From B's perspective: A appears as incoming neighbor (reversed direction)
    const neighborsOfB = getNeighbors(id, nodeB);
    const aFromB = neighborsOfB.filter((n) => n.node.id === nodeA);
    expect(aFromB.length).toBe(1); // Must appear exactly once
    closeDb(id);
  });

  it("getNeighbors excludes inhibits/contradicts edges from reverse direction", () => {
    const id = fresh();
    const nodeA = writeNode(id, "semantic", "node A inhibitor", "content A");
    const nodeB = writeNode(id, "semantic", "node B inhibited", "content B");

    writeEdge(id, nodeA, nodeB, "inhibits", { weight: 0.9 });

    // B's neighbors: A should NOT appear via reverse traversal of inhibits edges
    const neighborsOfB = getNeighbors(id, nodeB);
    const aFromB = neighborsOfB.filter((n) => n.node.id === nodeA);
    expect(aFromB.length).toBe(0);
    closeDb(id);
  });
});

// ── FSRS-6 forgetting model (v12) ────────────────────────────────────────────
// Verifies the post-SM-2 retrievability model behaves correctly: power-law
// decay, bounded stability, mean-reverting difficulty.

describe("FSRS-6 forgetting model", () => {
  it("fsrsRetrievability follows the power-law formula R(t,S) = (1 + 19t/(81S))^-0.5", () => {
    // At t = 0, R = 1.
    expect(fsrsRetrievability(0, 10)).toBeCloseTo(1.0, 5);
    // At t = S, FSRS calibrates so R(S, S) = (1 + 19/81)^-0.5 ≈ 0.9. The standard
    // FSRS target retention is 0.9 at stability days elapsed (Wozniak 2023 spec).
    const S = 10;
    const R = fsrsRetrievability(S, S);
    expect(R).toBeGreaterThan(0.89);
    expect(R).toBeLessThan(0.91);
  });

  it("fsrsRetrievability decays monotonically", () => {
    const S = 30;
    const r10  = fsrsRetrievability(10, S);
    const r60  = fsrsRetrievability(60, S);
    const r300 = fsrsRetrievability(300, S);
    expect(r10).toBeGreaterThan(r60);
    expect(r60).toBeGreaterThan(r300);
  });

  it("fsrsRetrievability is power-law, not exponential — long-tail forgetting", () => {
    // FSRS power-law has heavier tails than exp: R(2S,S) > exp(-2) ≈ 0.135.
    const S = 30;
    const Rpower = fsrsRetrievability(2 * S, S);
    expect(Rpower).toBeGreaterThan(Math.exp(-2));
  });

  it("touchNode caps stability at 365 days after 50 q=5 reviews (regression for code-1 Fix #1)", () => {
    // The pre-FSRS code grew stability unboundedly. After 50 perfect recalls the
    // stability could exceed 10^6 days, making the node effectively unforgettable.
    // FSRS-6 with the 365-day cap keeps it in a meaningful range.
    const id = fresh();
    const nodeId = writeNode(id, "semantic", "unforgettable test", "content", { importance: 0.5 });

    const db = getDb(id);
    // Simulate reviews over a year so growth doesn't stall on near-1.0 retrievability.
    let now = Date.now();
    const dayMs = 86400000;
    for (let i = 0; i < 50; i++) {
      now += 7 * dayMs;
      db.prepare("UPDATE nodes SET accessed_at = ?, last_review = ? WHERE id = ?").run(now - dayMs, now - dayMs, nodeId);
      touchNode(id, nodeId, 5);
    }
    const node = getNode(id, nodeId)!;
    expect(node.stability).toBeLessThanOrEqual(365.0);
    expect(node.stability).toBeGreaterThan(1.0); // grew some, just bounded

    // Retrievability 30 days after the last review must still be meaningfully below 1.
    const r30 = fsrsRetrievability(30, node.stability);
    expect(r30).toBeLessThan(1.0);
    // And q=5 must yield a much higher final stability than q=3 (lower growth rate
    // for borderline recalls).
    closeDb(id);
  });

  it("touchNode q=5 yields larger stability gain than q=3", () => {
    const id = fresh();
    // Distinct content so sharpwave-core's default writeNode dedupe (trigram
    // Jaccard >= 0.85, type-scoped) doesn't collapse these into one row.
    const a = writeNode(id, "semantic", "easy review", "easy review content body");
    const b = writeNode(id, "semantic", "borderline review", "borderline review content body");
    // Establish a baseline review for both so we exercise the success-stability
    // branch (not the initial-stability branch) on the second touch.
    touchNode(id, a, 3);
    touchNode(id, b, 3);
    // Advance time so retrievability has dropped (spacing effect → larger gain).
    const db = getDb(id);
    const past = Date.now() - 10 * 86400000;
    db.prepare("UPDATE nodes SET last_review = ?, accessed_at = ? WHERE id IN (?, ?)").run(past, past, a, b);
    touchNode(id, a, 5);
    touchNode(id, b, 3);
    const nodeA = getNode(id, a)!;
    const nodeB = getNode(id, b)!;
    expect(nodeA.stability).toBeGreaterThan(nodeB.stability);
    closeDb(id);
  });

  it("touchNode q<3 reduces stability (FSRS lapse) rather than zeroing it", () => {
    const id = fresh();
    const nodeId = writeNode(id, "semantic", "lapse test", "content");
    // Build up stability with a successful review.
    touchNode(id, nodeId, 4);
    const before = getNode(id, nodeId)!;
    expect(before.stability).toBeGreaterThan(0.1);
    // Now lapse. FSRS reduces stability but doesn't necessarily reset to 1.0
    // (SM-2 behavior). Critical assertion: stability went DOWN.
    const db = getDb(id);
    const past = Date.now() - 5 * 86400000;
    db.prepare("UPDATE nodes SET last_review = ?, accessed_at = ? WHERE id = ?").run(past, past, nodeId);
    touchNode(id, nodeId, 1);
    const after = getNode(id, nodeId)!;
    expect(after.stability).toBeLessThan(before.stability);
    expect(after.stability).toBeGreaterThan(0); // not zeroed
    closeDb(id);
  });

  it("touchNode sets last_review and increments review_count", () => {
    const id = fresh();
    const nodeId = writeNode(id, "semantic", "review counter", "content");
    const before = getNode(id, nodeId)!;
    expect(before.review_count).toBe(0);
    expect(before.last_review).toBeNull();

    touchNode(id, nodeId, 4);

    const after = getNode(id, nodeId)!;
    expect(after.review_count).toBe(1);
    expect(after.last_review).not.toBeNull();
    expect(after.last_review!).toBeGreaterThan(0);
    closeDb(id);
  });

  it("getRetrievability uses last_review as anchor, not accessed_at", () => {
    const id = fresh();
    const nodeId = writeNode(id, "semantic", "anchor test", "content");
    // Force last_review 365 days ago, accessed_at NOW, stability=20. If the
    // function uses accessed_at instead of last_review, R will be ~1 (just touched).
    // If it correctly uses last_review, R will be well below 1.
    const db = getDb(id);
    const past = Date.now() - 365 * 86400000;
    db.prepare("UPDATE nodes SET accessed_at = ?, last_review = ?, stability = 20.0 WHERE id = ?")
      .run(Date.now(), past, nodeId);

    const node = getNode(id, nodeId)!;
    const R = getRetrievability(node);
    // 365 days elapsed at S=20: t/S = 18.25 → FSRS power-law gives R well below 0.5.
    expect(R).toBeLessThan(0.5);
    expect(R).toBeGreaterThan(0); // still positive

    // Sanity: same node but anchor passed at "now" (no decay) returns R ≈ 1.
    const Rnow = getRetrievability(node, past);
    expect(Rnow).toBeCloseTo(1.0, 2);
    closeDb(id);
  });

  it("difficulty stays bounded in [1, 10] across many reviews", () => {
    const id = fresh();
    const nodeId = writeNode(id, "semantic", "difficulty bounds", "content");
    for (let i = 0; i < 30; i++) {
      // Alternating quality to stress the regression-to-mean term.
      touchNode(id, nodeId, i % 2 === 0 ? 1 : 5);
    }
    const node = getNode(id, nodeId)!;
    expect(node.difficulty).toBeGreaterThanOrEqual(1);
    expect(node.difficulty).toBeLessThanOrEqual(10);
    closeDb(id);
  });
});

// ── Pattern separation hash (v14) ────────────────────────────────────────────

describe("pattern separation hash (v14)", () => {
  it("computePsHash returns a 4-byte buffer", () => {
    const vec = new Float32Array(768);
    for (let i = 0; i < 768; i++) vec[i] = Math.sin(i);
    const hash = computePsHash(vec);
    expect(hash.length).toBe(4);
  });

  it("identical embeddings produce identical hashes (Hamming = 0)", () => {
    const vec = new Float32Array(768);
    for (let i = 0; i < 768; i++) vec[i] = Math.cos(i * 0.7);
    const h1 = computePsHash(vec);
    const h2 = computePsHash(vec);
    expect(psHashHamming(h1, h2)).toBe(0);
  });

  it("near-identical embeddings (small perturbation) have low Hamming distance", () => {
    const vec1 = new Float32Array(768);
    for (let i = 0; i < 768; i++) vec1[i] = Math.cos(i * 0.5) + Math.sin(i * 0.1);
    const vec2 = new Float32Array(768);
    for (let i = 0; i < 768; i++) vec2[i] = vec1[i] + (Math.random() - 0.5) * 0.01;
    const h1 = computePsHash(vec1);
    const h2 = computePsHash(vec2);
    // Tiny perturbation should preserve most top-K indices.
    expect(psHashHamming(h1, h2)).toBeLessThan(20);
  });

  it("orthogonal random embeddings have higher Hamming distance than near-duplicates", () => {
    // FLAKY UNTIL 2026-07-31, and it was hidden for weeks behind 13 standing
    // schema-version failures. Two separate defects, both in the test:
    //   1. It called sin(i*0.31 + seed*17) "independent random embeddings".
    //      Those are phase-shifted sine waves — strongly correlated — so
    //      hammingFar came out small and the margin was razor thin.
    //   2. The near-duplicate perturbation used UNSEEDED Math.random(), so on
    //      unlucky draws hammingNear exceeded that thin hammingFar and the run
    //      went red for reasons having nothing to do with the code.
    // Both sides are now deterministic, and the vectors are actually independent.
    const mulberry32 = (seed: number) => () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const randomVec = (seed: number) => {
      const rnd = mulberry32(seed);
      const vec = new Float32Array(768);
      for (let i = 0; i < 768; i++) vec[i] = rnd() * 2 - 1;
      return vec;
    };

    const a = randomVec(12345);
    const b = randomVec(67890);
    const hammingFar = psHashHamming(computePsHash(a), computePsHash(b));

    // Near-duplicate: same vector, deterministic sub-noise-floor perturbation.
    const jitter = mulberry32(99);
    const c = new Float32Array(a);
    for (let i = 0; i < c.length; i++) c[i] += (jitter() - 0.5) * 0.005;
    const hammingNear = psHashHamming(computePsHash(a), computePsHash(c));

    expect(hammingFar).toBeGreaterThan(hammingNear);
  });

  it("psHashHamming returns 32 (max) when either input is null", () => {
    const vec = new Float32Array(10);
    const h = computePsHash(vec);
    expect(psHashHamming(null, h)).toBe(32);
    expect(psHashHamming(h, null)).toBe(32);
    expect(psHashHamming(null, null)).toBe(32);
  });

  it("psHashHamming popcount is correct on hand-crafted hashes", () => {
    const a = Buffer.from([0xff, 0xff, 0xff, 0xff]); // all 1s → 32 bits
    const b = Buffer.from([0x00, 0x00, 0x00, 0x00]); // all 0s
    expect(psHashHamming(a, b)).toBe(32);
    const c = Buffer.from([0xff, 0xff, 0xff, 0xff]);
    expect(psHashHamming(a, c)).toBe(0);
    const d = Buffer.from([0x0f, 0x0f, 0x0f, 0x0f]); // half bits set vs a
    expect(psHashHamming(a, d)).toBe(16);
  });
});
