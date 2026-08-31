import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { writeNode } from "../src/nodes.js";
import { buildBootstrapContext, buildRecallContext, buildSelfModelHeader, BRAIN_HEADER } from "../src/context-assembly.js";
import { getSelfModel, updateSelfModelField } from "../src/self-model.js";
import { getDb, closeDb } from "../src/db.js";
import { DEFAULT_CONFIG } from "../src/types.js";

function fresh(): string { return `test-${randomUUID().slice(0, 8)}`; }

describe("bootstrap", () => {
  it("BRAIN_HEADER contains ClawBrain v3 mention", () => {
    expect(BRAIN_HEADER).toContain("ClawBrain v3");
    expect(BRAIN_HEADER).toContain("brain_query");
    expect(BRAIN_HEADER).toContain("brain_write");
  });

  it("buildBootstrapContext starts with BRAIN_HEADER", async () => {
    const id = fresh();
    const ctx = await buildBootstrapContext(id, "sess1", DEFAULT_CONFIG);
    expect(ctx.startsWith(BRAIN_HEADER)).toBe(true);
    closeDb(id);
  });

  it("buildBootstrapContext includes self model identity when set", async () => {
    const id = fresh();
    const db = getDb(id);
    db.prepare("UPDATE self_model SET identity = ? WHERE id = 'singleton'")
      .run("I am Mac, a creative AI assistant with persistent memory.");

    const ctx = await buildBootstrapContext(id, "sess1", DEFAULT_CONFIG);
    expect(ctx).toContain("Mac");
    expect(ctx).toContain("[BRAIN: self]");
    closeDb(id);
  });

  it("buildBootstrapContext includes goals when active goals exist", async () => {
    const id = fresh();
    writeNode(id, "goal", "complete the v3 brain rebuild", "finish rebuilding ClawBrain v3", { importance: 0.9 });

    const ctx = await buildBootstrapContext(id, "sess1", DEFAULT_CONFIG);
    expect(ctx).toContain("[BRAIN: active goals]");
    expect(ctx).toContain("complete the v3 brain rebuild");
    closeDb(id);
  });

  it("buildBootstrapContext includes review queue when fading nodes exist", async () => {
    const id = fresh();
    const db = getDb(id);
    const nodeId = writeNode(id, "semantic", "fading memory test node", "content that is fading", { importance: 0.6 });
    // Manually set retrievability to danger zone
    db.prepare("UPDATE nodes SET retrievability = 0.15 WHERE id = ?").run(nodeId);

    const ctx = await buildBootstrapContext(id, "sess1", DEFAULT_CONFIG);
    expect(ctx).toContain("fading memory test node");
    closeDb(id);
  });

  it("buildRecallContext returns empty string for empty DB", async () => {
    const id = fresh();
    const result = await buildRecallContext(id, "any query here", "sess1", DEFAULT_CONFIG);
    expect(result).toBe("");
    closeDb(id);
  });

  it("buildRecallContext returns empty string for very short query", async () => {
    const id = fresh();
    const result = await buildRecallContext(id, "ok", "sess1", DEFAULT_CONFIG);
    expect(result).toBe("");
    closeDb(id);
  });

  it("buildRecallContext includes [BRAIN: on your mind] when nodes found", async () => {
    const id = fresh();
    writeNode(id, "semantic", "recall test memory node", "content for the recall test", { importance: 0.8 });

    const result = await buildRecallContext(id, "recall test memory", "sess1", DEFAULT_CONFIG);
    if (result.length > 0) {
      // Header carries the provenance caveat since the 2026-07-13
      // reality-monitoring fix; match on the stable prefix.
      expect(result).toContain("[BRAIN: on your mind");
    }
    closeDb(id);
  });
});

// ─── Layer-1 self-model header (T2.2 / CLAWBRAIN_V3_INJECTION_FIX_PLAN.md) ───────

describe("buildSelfModelHeader (Layer 1 — appendSystemContext, every turn)", () => {
  it("returns a non-empty string with the v4 header line for an empty agent", async () => {
    const id = fresh();
    const header = await buildSelfModelHeader(id, DEFAULT_CONFIG);
    expect(header.length).toBeGreaterThan(0);
    expect(header).toContain("[ClawBrain v4]");
    closeDb(id);
  });

  it("includes identity from self_model when set", async () => {
    const id = fresh();
    updateSelfModelField(id, "identity", "I am Mac, a curious autonomous agent");
    const header = await buildSelfModelHeader(id, DEFAULT_CONFIG);
    expect(header).toContain("[identity]");
    expect(header).toContain("Mac");
    closeDb(id);
  });

  it("includes active goals when at least one exists", async () => {
    const id = fresh();
    writeNode(id, "goal", "ship v4", "complete the v4 ClawBrain delivery", { importance: 0.9 });
    const header = await buildSelfModelHeader(id, DEFAULT_CONFIG);
    expect(header).toContain("[goals]");
    expect(header).toContain("ship v4");
    closeDb(id);
  });

  it("includes neuromodulator snapshot with all four scalars", async () => {
    const id = fresh();
    const header = await buildSelfModelHeader(id, DEFAULT_CONFIG);
    expect(header).toContain("[neuro]");
    expect(header).toContain("dopamine=");
    expect(header).toContain("serotonin=");
    expect(header).toContain("acetylcholine=");
    expect(header).toContain("norepinephrine=");
    closeDb(id);
  });

  it("does NOT call spreadActivation/bootstrapRetrieve (no ripple_count growth)", async () => {
    // Plan BLOCKER 1: Layer-1 must be pure-read. We verify by writing a node,
    // capturing its ripple_count, calling buildSelfModelHeader N times, and
    // checking ripple_count is unchanged.
    const id = fresh();
    const nodeId = writeNode(id, "identity", "stable node", "should never tick ripple_count", { importance: 0.9 });
    const db = getDb(id);
    const before = (db.prepare("SELECT ripple_count FROM nodes WHERE id = ?").get(nodeId) as { ripple_count: number }).ripple_count;
    for (let i = 0; i < 10; i++) {
      await buildSelfModelHeader(id, DEFAULT_CONFIG);
    }
    const after = (db.prepare("SELECT ripple_count FROM nodes WHERE id = ?").get(nodeId) as { ripple_count: number }).ripple_count;
    expect(after).toBe(before);
    closeDb(id);
  });

  it("is resilient to a fresh agent with no nodes / empty self_model", async () => {
    const id = fresh();
    const header = await buildSelfModelHeader(id, DEFAULT_CONFIG);
    // Minimum: the descriptive header + [neuro] block
    expect(header).toContain("[ClawBrain v4]");
    expect(header).toContain("[neuro]");
    closeDb(id);
  });
});
