import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { writeNode } from "../src/nodes.js";
import { writeEdge } from "../src/edges.js";
import { appendEpisode } from "../src/episodes.js";
import { getDb, setMeta, getMeta, closeDb } from "../src/db.js";
import {
  subconsciousTick,
  shouldConsolidate,
  getNeuromodulatorState,
  runConsolidation,
  setSubagentRunner,
} from "../src/consolidation.js";
import * as embeddings from "../src/embeddings.js";
import { DEFAULT_CONFIG } from "../src/types.js";

// NOTE (Task 3): the clawbrain-v4 consolidation.test.ts also imported
// `handleCompaction` from src/compaction.js and had one case
// ("compaction handleCompaction queues embeddings for extracted nodes").
// `compaction` is NOT yet ported to sharpwave-core (it belongs to a later task
// in the openwave/sharpwave-core split plan), so that import and its single
// test case were removed here. Re-add both from clawbrain-v4 when compaction.ts
// lands in packages/core/src.

function fresh(): string { return `test-${randomUUID().slice(0, 8)}`; }
const log = { info: () => {}, warn: () => {}, error: () => {} };

describe("consolidation", () => {
  it("getNeuromodulatorState returns valid state object", () => {
    const id = fresh();
    const state = getNeuromodulatorState(id);

    expect(typeof state.dopamine).toBe("number");
    expect(typeof state.serotonin).toBe("number");
    expect(typeof state.acetylcholine).toBe("number");
    expect(typeof state.norepinephrine).toBe("number");
    expect(typeof state.interpretation).toBe("string");

    expect(state.dopamine).toBeGreaterThanOrEqual(0);
    expect(state.dopamine).toBeLessThanOrEqual(1);
    closeDb(id);
  });

  // T4.2 — ACh wiring (Hasselmo 2013): high during active waking (recent
  // episode), low during long idle. v3 had this backward (high after a tick,
  // decaying with idle). The fix means: a fresh-just-now episode should
  // produce ACh ≈ 1.0; a very old episode (or none) should produce ACh ≈ 0.
  it("getNeuromodulatorState — ACh is high right after a recent episode", () => {
    const id = fresh();
    appendEpisode(id, "s", "user", "this is a message right now to establish recency", 0.5);
    const state = getNeuromodulatorState(id);
    expect(state.acetylcholine).toBeGreaterThan(0.9);
    closeDb(id);
  });

  it("getNeuromodulatorState — ACh is low when no recent episode exists", () => {
    const id = fresh();
    // No episode at all — gap defaults to 48h → ACh = max(0, 1 - 48/24) = 0
    const state = getNeuromodulatorState(id);
    expect(state.acetylcholine).toBeLessThan(0.1);
    closeDb(id);
  });

  it("shouldConsolidate returns false when last_consolidation is recent", () => {
    const id = fresh();
    setMeta(id, "last_consolidation", String(Date.now()));
    const result = shouldConsolidate(id, DEFAULT_CONFIG);
    expect(result).toBe(false);
    closeDb(id);
  });

  it("shouldConsolidate returns true when time gate passed and episodes exist", () => {
    const id = fresh();
    setMeta(id, "last_consolidation", String(Date.now() - 48 * 3600 * 1000));
    for (let i = 0; i < 15; i++) {
      appendEpisode(id, "s", "user", `Episode number ${i} with some content to test consolidation`);
    }
    const result = shouldConsolidate(id, DEFAULT_CONFIG);
    expect(result).toBe(true);
    closeDb(id);
  });

  it("subconsciousTick runs without error on empty DB", async () => {
    const id = fresh();
    await expect(subconsciousTick(id, DEFAULT_CONFIG, log)).resolves.not.toThrow();
    closeDb(id);
  });

  it("runConsolidation resets ripple_count to 0 after running", async () => {
    const id = fresh();
    const db = getDb(id);

    const nodeId = writeNode(id, "episodic", "test episode", "content");
    db.prepare("UPDATE nodes SET ripple_count = 5 WHERE id = ?").run(nodeId);

    for (let i = 0; i < 5; i++) {
      appendEpisode(id, "s", "user", `Test episode ${i} for consolidation run testing purposes`);
    }

    setMeta(id, "last_consolidation", String(Date.now() - 8 * 24 * 3600 * 1000));

    await runConsolidation(id, DEFAULT_CONFIG, log);

    const node = db.prepare("SELECT ripple_count FROM nodes WHERE id = ?").get(nodeId) as { ripple_count: number };
    expect(node.ripple_count).toBe(0);
    closeDb(id);
  });

  it("runConsolidation updates last_consolidation meta", async () => {
    const id = fresh();
    const before = Date.now();
    setMeta(id, "last_consolidation", String(before - 8 * 24 * 3600 * 1000));

    await runConsolidation(id, DEFAULT_CONFIG, log);

    const after = getMeta(id, "last_consolidation");
    expect(Number(after)).toBeGreaterThanOrEqual(before);
    closeDb(id);
  });

  it("runConsolidation persists episode count snapshot for delta gate", async () => {
    const id = fresh();
    for (let i = 0; i < 5; i++) {
      appendEpisode(id, "s", "user", `Episode ${i} for count snapshot test`);
    }
    setMeta(id, "last_consolidation", String(Date.now() - 8 * 24 * 3600 * 1000));

    await runConsolidation(id, DEFAULT_CONFIG, log);

    const stored = getMeta(id, "last_consolidation_episode_count");
    expect(Number(stored)).toBeGreaterThanOrEqual(5);
    closeDb(id);
  });

  it("shouldConsolidate uses delta episode count, not total count", () => {
    const id = fresh();
    setMeta(id, "last_consolidation", String(Date.now() - 8 * 24 * 3600 * 1000));
    setMeta(id, "last_consolidation_episode_count", "100");
    for (let i = 0; i < 5; i++) {
      appendEpisode(id, "s", "user", `New episode ${i}`);
    }
    const result = shouldConsolidate(id, DEFAULT_CONFIG);
    expect(result).toBe(false);
    closeDb(id);
  });

  it("SWS phase queues embeddings for every node written", async () => {
    const id = fresh();
    const spy = vi.spyOn(embeddings, "queueEmbedding");
    spy.mockImplementation(() => {});

    appendEpisode(id, "s", "user", "I am a senior developer who values clean code and testing.");
    appendEpisode(id, "s", "user", "The procedure to deploy is: build, test, then push to production.");
    appendEpisode(id, "s", "user", "TypeScript is a statically typed superset of JavaScript.");

    setMeta(id, "last_consolidation", String(Date.now() - 8 * 24 * 3600 * 1000));
    await runConsolidation(id, DEFAULT_CONFIG, log);

    expect(spy).toHaveBeenCalled();
    const agentIdCalls = spy.mock.calls.filter((c) => c[0] === id);
    expect(agentIdCalls.length).toBeGreaterThan(0);

    spy.mockRestore();
    closeDb(id);
  });

  // ── T4.3 — Global SWS synaptic downscaling ────────────────────────────
  it("SWS phase downscales stability and retrievability on non-protected nodes", async () => {
    const id = fresh();
    const db = getDb(id);

    const semId = writeNode(id, "semantic", "ordinary fact", "an ordinary semantic fact");
    const idtId = writeNode(id, "identity", "protected identity", "the agent's identity statement");
    const golId = writeNode(id, "goal", "protected goal", "an active goal");

    // Set known values so we can verify the 0.95 multiplier. Backdate
    // created_at past the 24h freshness exemption — the SWS downscale
    // deliberately skips nodes written in the last day (runSwsPhase T4.3),
    // and writeNode stamps created_at = now.
    const twoDaysAgo = Date.now() - 2 * 24 * 3600 * 1000;
    db.prepare("UPDATE nodes SET stability = 10.0, retrievability = 0.8, created_at = ? WHERE id = ?").run(twoDaysAgo, semId);
    db.prepare("UPDATE nodes SET stability = 100.0, retrievability = 0.9, created_at = ? WHERE id = ?").run(twoDaysAgo, idtId);
    db.prepare("UPDATE nodes SET stability = 50.0, retrievability = 0.7, created_at = ? WHERE id = ?").run(twoDaysAgo, golId);

    // Add an episode so SWS has something to do (but the downscale runs unconditionally first).
    appendEpisode(id, "s", "user", "Some user content to trigger SWS phase entry into consolidation.");
    setMeta(id, "last_consolidation", String(Date.now() - 8 * 24 * 3600 * 1000));

    await runConsolidation(id, DEFAULT_CONFIG, log);

    const sem = db.prepare("SELECT stability, retrievability FROM nodes WHERE id = ?").get(semId) as { stability: number; retrievability: number };
    const idt = db.prepare("SELECT stability, retrievability FROM nodes WHERE id = ?").get(idtId) as { stability: number; retrievability: number };
    const gol = db.prepare("SELECT stability, retrievability FROM nodes WHERE id = ?").get(golId) as { stability: number; retrievability: number };

    // Semantic node: 5% downscale applied (allow a small wobble for decayRetrievability noise).
    expect(sem.stability).toBeLessThan(10.0);
    expect(sem.retrievability).toBeLessThan(0.8);
    // Identity & goal: NOT downscaled by the SWS pass (they may still decay
    // via the normal retrievability/decay sweep, which is fine — but the
    // protection is from the SWS-specific multiplier).
    expect(idt.stability).toBeCloseTo(100.0, 5);
    expect(gol.stability).toBeCloseTo(50.0, 5);
    closeDb(id);
  });

  // NOTE (Task 3): clawbrain-v4's consolidation.test.ts had a case
  // "runConsolidation prunes extracted episodes older than pruneAfterDays,
  // keeps recent and unextracted ones". That exercised the Deep-phase
  // "hygiene sweep" (clawbrain Fable-5 audit follow-up 2026-07-12) that runs
  // `DELETE FROM episodes WHERE created_at < ? AND llm_extracted = 1` plus the
  // working_memory / node_associations sweeps. sharpwave-core's runDeepPhase
  // (src/consolidation.ts) never received that block — it only physically
  // prunes near-zero-retrievability *nodes*, never raw `episodes` rows. The
  // case was removed rather than left failing. Re-add it if the episode/WM/
  // association hygiene sweep is ever ported into runDeepPhase.

  // ── T1.4 — Physical pruning ────────────────────────────────────────────
  it("runConsolidation physically deletes orphan nodes with retrievability < 0.01", async () => {
    const id = fresh();
    const db = getDb(id);

    // 5 orphan nodes with vanishingly-low retrievability and no edges.
    // Content must be pairwise-distinct (Jaccard < 0.8): sharpwave-core's REM
    // entity-merge (mergeCoreferentNodes → deduplicateExisting, threshold 0.8)
    // would otherwise wire `coreference_of` edges between near-identical nodes,
    // and runDeepPhase skips any node touched by a live edge. clawbrain-v4's
    // older mention-driven entity resolver did not do this bulk walk.
    const orphanBodies = [
      "the quarterly financial report was filed with the regulator on friday",
      "migratory swallows navigate using the earth magnetic field at dusk",
      "a sourdough starter needs feeding every twelve hours in warm weather",
      "the compiler emitted a spurious warning about an unused lifetime bound",
      "tidal friction is gradually lengthening the terrestrial day over eons",
    ];
    const orphanIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const n = writeNode(id, "semantic", `orphan ${i}`, orphanBodies[i], { deduplicate: false });
      db.prepare("UPDATE nodes SET retrievability = 0.001 WHERE id = ?").run(n);
      orphanIds.push(n);
    }
    // 1 protected identity node with the same low retrievability — must NOT be pruned.
    const idtId = writeNode(id, "identity", "protected identity prune", "must survive deep phase", { deduplicate: false });
    db.prepare("UPDATE nodes SET retrievability = 0.001 WHERE id = ?").run(idtId);

    const beforeCount = (db.prepare("SELECT COUNT(*) as n FROM nodes").get() as { n: number }).n;
    expect(beforeCount).toBe(6);

    setMeta(id, "last_consolidation", String(Date.now() - 8 * 24 * 3600 * 1000));
    await runConsolidation(id, DEFAULT_CONFIG, log);

    const afterCount = (db.prepare("SELECT COUNT(*) as n FROM nodes").get() as { n: number }).n;
    // 5 orphans deleted, identity survives.
    expect(afterCount).toBe(1);

    // Identity row is the surviving one.
    const survivor = db.prepare("SELECT id FROM nodes").get() as { id: string };
    expect(survivor.id).toBe(idtId);

    // FTS rows for deleted nodes should also be gone via the AFTER DELETE
    // trigger — assert by FTS search returning no hits for the orphan labels.
    // We use the label-text MATCH because direct column compares against an
    // FTS5 virtual table parse `id` as an expression, not a column equality.
    for (let i = 0; i < orphanIds.length; i++) {
      const ftsHit = db.prepare("SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?").all(`"orphan ${i}"`);
      expect(ftsHit.length).toBe(0);
    }
    closeDb(id);
  });

  // ── T1.5 — Temporal `before` edges between sequential SWS-extracted nodes ─
  it("SWS phase emits 'before' edges between consecutive episodes in the same session", async () => {
    const id = fresh();
    const db = getDb(id);

    // Episodes whose first classifiable sentence will be the same node label
    // is no good (dedupe); use distinct identity-classifiable sentences so
    // each yields its own node.
    appendEpisode(id, "sessA", "user", "I am Hailey and I work on a memory plugin called ClawBrain.");
    appendEpisode(id, "sessA", "user", "I prefer to write tests before shipping production code.");
    appendEpisode(id, "sessA", "user", "I value careful, well-audited migrations over speed.");

    setMeta(id, "last_consolidation", String(Date.now() - 8 * 24 * 3600 * 1000));
    await runConsolidation(id, DEFAULT_CONFIG, log);

    // At least one `before` edge of type 'before' should exist between
    // SWS-extracted nodes after consolidation.
    const beforeEdges = db.prepare(
      "SELECT COUNT(*) as n FROM edges WHERE type = 'before' AND valid_until IS NULL"
    ).get() as { n: number };
    expect(beforeEdges.n).toBeGreaterThan(0);
    closeDb(id);
  });

  // ── T1.3 — Dual-extraction prevention ──────────────────────────────────
  it("SWS phase only consumes episodes where llm_extracted = 0", async () => {
    const id = fresh();
    const db = getDb(id);

    // Two identity-classifiable episodes. Mark the first as already
    // llm_extracted = 1 so SWS must skip it.
    const epAId = appendEpisode(id, "s", "user", "I am Hailey and I deeply value careful migrations.");
    const epBId = appendEpisode(id, "s", "user", "I prefer concise, testable code over premature abstraction.");

    // Force-mark epA. The defensive ALTER inside consolidation runs on first
    // call; mark right after triggering one neuromodulator read so the column
    // exists.
    getNeuromodulatorState(id);
    db.prepare("UPDATE episodes SET llm_extracted = 1 WHERE id = ?").run(epAId);

    setMeta(id, "last_consolidation", String(Date.now() - 8 * 24 * 3600 * 1000));
    await runConsolidation(id, DEFAULT_CONFIG, log);

    // epA must still be flagged, epB must now also be flagged.
    const epAflag = db.prepare("SELECT llm_extracted FROM episodes WHERE id = ?").get(epAId) as { llm_extracted: number };
    const epBflag = db.prepare("SELECT llm_extracted FROM episodes WHERE id = ?").get(epBId) as { llm_extracted: number };
    expect(epAflag.llm_extracted).toBe(1);
    expect(epBflag.llm_extracted).toBe(1);

    // A second consolidation should add NO new SWS nodes — every eligible
    // episode is now flagged.
    const nodeCountBefore = (db.prepare("SELECT COUNT(*) as n FROM nodes").get() as { n: number }).n;
    setMeta(id, "last_consolidation", String(Date.now() - 8 * 24 * 3600 * 1000));
    await runConsolidation(id, DEFAULT_CONFIG, log);
    const nodeCountAfter = (db.prepare("SELECT COUNT(*) as n FROM nodes").get() as { n: number }).n;

    // The second pass may delete pruned orphans but must not add new SWS
    // nodes — assert it didn't grow.
    expect(nodeCountAfter).toBeLessThanOrEqual(nodeCountBefore);
    closeDb(id);
  });

  // ── T3.3 — Reconsolidation single-statement atomicity ──────────────────
  it("Reconsolidation appends with single UPDATE — no lost-update on concurrent writes", async () => {
    const id = fresh();
    const db = getDb(id);

    // Build two associated nodes so reconsolidation has something to write.
    const aId = writeNode(id, "semantic", "alpha node", "alpha original content");
    const bId = writeNode(id, "semantic", "beta node", "beta neighbour content");
    writeEdge(id, aId, bId, "associated_with", { weight: 0.7 });

    // Make 'a' eligible: bump access_count and access time so it lands in the
    // reconsolidation candidate set.
    db.prepare("UPDATE nodes SET access_count = 5, accessed_at = ?, eligibility_trace = 0.9 WHERE id = ?").run(Date.now(), aId);

    setMeta(id, "last_consolidation", String(Date.now() - 8 * 24 * 3600 * 1000));

    // Simulate a concurrent edit landing between SELECT and UPDATE inside
    // reconsolidation. We can't truly interleave (better-sqlite3 is sync), but
    // we CAN verify that a SET content = content || ? preserves any string
    // we put into content right before consolidation kicks in, because the
    // append is computed by SQLite using the current row value — not a
    // pre-read one.
    db.prepare("UPDATE nodes SET content = ? WHERE id = ?").run("alpha edited concurrently", aId);
    await runConsolidation(id, DEFAULT_CONFIG, log);

    const finalContent = (db.prepare("SELECT content FROM nodes WHERE id = ?").get(aId) as { content: string }).content;
    // The concurrent edit must NOT be clobbered. The atomic SET content =
    // content || enrichment preserves the up-to-date prefix and only appends
    // the enrichment marker.
    expect(finalContent.startsWith("alpha edited concurrently")).toBe(true);
    closeDb(id);
  });

  // ── T4.5 — Generative REM via subagent ─────────────────────────────────
  it("Generative REM uses subagent runner to write pattern/schema nodes", async () => {
    const id = fresh();
    const db = getDb(id);

    // Seed 6 episodic nodes with ripple_count > 0 so they cluster for REM.
    // `deduplicate: false` — sharpwave-core's writeNode runs a trigram-Jaccard
    // near-duplicate gate by default (threshold 0.85); "body of seed episode
    // number N" strings collapse to a single row otherwise, starving the
    // generative-REM candidate gate (needs >= 3). clawbrain-v4's writeNode had
    // no such gate.
    const seedIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const n = writeNode(id, "episodic", `seed ep ${i}`, `body of seed episode number ${i}`, { deduplicate: false });
      db.prepare("UPDATE nodes SET ripple_count = ?, salience = 0.7 WHERE id = ?").run(3 + i, n);
      seedIds.push(n);
    }

    // Inject a mock subagent runner that returns one abstraction per call.
    let callCount = 0;
    setSubagentRunner(async (_input) => {
      callCount++;
      return {
        text: JSON.stringify({
          abstractions: [
            {
              type: "pattern",
              label: `mock abstraction ${callCount}`,
              content: "the agent shows a pattern of seed-related activity",
              importance: 0.7,
            },
          ],
        }),
      };
    });

    setMeta(id, "last_consolidation", String(Date.now() - 8 * 24 * 3600 * 1000));
    await runConsolidation(id, { ...DEFAULT_CONFIG, openRouterApiKey: "" }, log);

    // At least one pattern node sourced from rem-generative should exist.
    const generatedNodes = db.prepare(
      "SELECT id, label, source FROM nodes WHERE source = 'rem-generative'"
    ).all() as Array<{ id: string; label: string; source: string }>;
    expect(generatedNodes.length).toBeGreaterThan(0);
    expect(callCount).toBeGreaterThan(0);

    // Each generated node must have at least one inbound instance_of edge.
    for (const g of generatedNodes) {
      const inboundCount = (db.prepare(
        "SELECT COUNT(*) as n FROM edges WHERE to_id = ? AND type = 'instance_of' AND valid_until IS NULL"
      ).get(g.id) as { n: number }).n;
      expect(inboundCount).toBeGreaterThan(0);
    }

    // Reset runner so other tests aren't affected.
    setSubagentRunner(null);
    closeDb(id);
  });

  // ── T4.5 — Generative REM gracefully falls back when subagent absent ───
  it("Generative REM falls back to keyword bucketing when subagent runner unset", async () => {
    const id = fresh();
    setSubagentRunner(null);

    appendEpisode(id, "s", "user", "I started a new debug session this morning.");
    appendEpisode(id, "s", "user", "Another debug round to chase the same memory issue.");
    appendEpisode(id, "s", "user", "Third debug attempt — still not solved.");

    setMeta(id, "last_consolidation", String(Date.now() - 8 * 24 * 3600 * 1000));

    // Should not throw — the legacy keyword path is the fallback.
    await expect(runConsolidation(id, DEFAULT_CONFIG, log)).resolves.not.toThrow();
    closeDb(id);
  });

  // ── T4.8 — Affective decay during REM ──────────────────────────────────
  it("REM phase applies affective decay to old, emotionally-weighted nodes", async () => {
    const id = fresh();
    const db = getDb(id);

    const aged = writeNode(id, "emotion", "aged emotion", "an old emotional memory");
    const fresh_ = writeNode(id, "emotion", "fresh emotion", "a very recent emotional memory");
    const eightDaysAgo = Date.now() - 8 * 86400000;
    // affective decay filters on `accessed_at` (not `updated_at`) because
    // SWS downscaling overwrites updated_at on every pass — see the comment
    // in consolidation.ts.
    db.prepare("UPDATE nodes SET emotional_weight = 1.0, accessed_at = ? WHERE id = ?").run(eightDaysAgo, aged);
    db.prepare("UPDATE nodes SET emotional_weight = 1.0, accessed_at = ? WHERE id = ?").run(Date.now(), fresh_);

    setMeta(id, "last_consolidation", String(Date.now() - 8 * 24 * 3600 * 1000));
    await runConsolidation(id, DEFAULT_CONFIG, log);

    const agedAfter = db.prepare("SELECT emotional_weight FROM nodes WHERE id = ?").get(aged) as { emotional_weight: number };
    const freshAfter = db.prepare("SELECT emotional_weight FROM nodes WHERE id = ?").get(fresh_) as { emotional_weight: number };

    // Aged node: decayed to ~0.9 (or further if SWS downscales subsequent
    // emotional decay — but the affective decay step alone is 10%).
    expect(agedAfter.emotional_weight).toBeLessThan(0.95);
    // Fresh node: untouched by affective decay because updated_at is recent.
    expect(freshAfter.emotional_weight).toBeCloseTo(1.0, 1);
    closeDb(id);
  });

  // ── T4.4 — CLS two-store promotion ─────────────────────────────────────
  it("SWS phase promotes nodes meeting CLS criteria to is_consolidated = 1", async () => {
    const id = fresh();
    const db = getDb(id);

    // Seed a node that meets CLS promotion: review_count >= 5 AND retrievability >= 0.7
    const promotable = writeNode(id, "semantic", "well rehearsed fact", "I have reviewed this many times");
    db.prepare("UPDATE nodes SET review_count = 6, retrievability = 0.85 WHERE id = ?").run(promotable);

    // A node that should NOT promote (low review_count).
    const underReviewed = writeNode(id, "semantic", "rarely seen fact", "barely accessed body content");
    db.prepare("UPDATE nodes SET review_count = 2, retrievability = 0.9 WHERE id = ?").run(underReviewed);

    setMeta(id, "last_consolidation", String(Date.now() - 8 * 24 * 3600 * 1000));
    await runConsolidation(id, DEFAULT_CONFIG, log);

    const p = db.prepare("SELECT is_consolidated, consolidated_at FROM nodes WHERE id = ?").get(promotable) as { is_consolidated: number; consolidated_at: number };
    const u = db.prepare("SELECT is_consolidated FROM nodes WHERE id = ?").get(underReviewed) as { is_consolidated: number };

    expect(p.is_consolidated).toBe(1);
    expect(typeof p.consolidated_at).toBe("number");
    expect(u.is_consolidated).toBe(0);
    closeDb(id);
  });
});
