import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { writeNode } from "../src/nodes.js";
import { buildBootstrapContext, buildRecallContext, buildSelfModelHeader, BRAIN_HEADER } from "../src/context-assembly.js";
import { getSelfModel, updateSelfModelField } from "../src/self-model.js";
import { getDb, closeDb } from "../src/db.js";
import { DEFAULT_CONFIG } from "../src/types.js";

function fresh(): string { return `test-${randomUUID().slice(0, 8)}`; }

describe("bootstrap", () => {
  it("BRAIN_HEADER carries the SharpWave marker and the legacy compat mention", () => {
    expect(BRAIN_HEADER).toContain("[SharpWave active]");
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

  it("buildBootstrapContext omits the active-goals block when externalMemoryActive is true", async () => {
    const id = fresh();
    writeNode(id, "goal", "complete the v3 brain rebuild", "finish rebuilding ClawBrain v3", { importance: 0.9 });

    const ctx = await buildBootstrapContext(id, "sess1", DEFAULT_CONFIG, undefined, "chat", { externalMemoryActive: true });
    expect(ctx).not.toContain("[BRAIN: active goals]");
    expect(ctx).not.toContain("• complete the v3 brain rebuild");
    closeDb(id);
  });

  it("buildBootstrapContext keeps BRAIN_HEADER but omits self-model prose when externalMemoryActive is true", async () => {
    const id = fresh();
    const db = getDb(id);
    db.prepare("UPDATE self_model SET identity = ? WHERE id = 'singleton'")
      .run("I am Mac, a creative AI assistant with persistent memory.");

    const ctx = await buildBootstrapContext(id, "sess1", DEFAULT_CONFIG, undefined, "chat", { externalMemoryActive: true });
    expect(ctx.startsWith(BRAIN_HEADER)).toBe(true);
    expect(ctx).not.toContain("[BRAIN: self]");
    expect(ctx).not.toContain("I am Mac, a creative AI assistant with persistent memory.");
    closeDb(id);
  });

  it("buildBootstrapContext includes review queue when fading nodes exist", async () => {
    const id = fresh();
    const db = getDb(id);
    const nodeId = writeNode(id, "semantic", "fading memory test node", "content that is fading", { importance: 0.6 });
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
      expect(result).toContain("[BRAIN: on your mind");
    }
    closeDb(id);
  });
});

describe("buildSelfModelHeader (Layer 1 — appendSystemContext, every turn)", () => {
  it("returns a non-empty string with the SharpWave header line for an empty agent", async () => {
    const id = fresh();
    const header = await buildSelfModelHeader(id, DEFAULT_CONFIG);
    expect(header.length).toBeGreaterThan(0);
    expect(header).toContain("[SharpWave]");
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

  it("omits the [goals] line when externalMemoryActive is true (a host memory system already curates goals)", async () => {
    const id = fresh();
    writeNode(id, "goal", "ship v4", "complete the v4 ClawBrain delivery", { importance: 0.9 });
    const header = await buildSelfModelHeader(id, DEFAULT_CONFIG, undefined, "chat", { externalMemoryActive: true });
    expect(header).not.toContain("[goals]");
    expect(header).not.toContain("ship v4");
    closeDb(id);
  });

  it("omits identity and user_model but keeps banner + neuro when externalMemoryActive is true", async () => {
    const id = fresh();
    updateSelfModelField(id, "identity", "I am Mac, a curious autonomous agent");
    updateSelfModelField(id, "user_model", JSON.stringify({ favorite_color: "teal", telegram_id: "1" }));
    const header = await buildSelfModelHeader(id, DEFAULT_CONFIG, undefined, "chat", { externalMemoryActive: true });
    expect(header).toContain("[SharpWave]");
    expect(header).toContain("[neuro]");
    expect(header).not.toContain("[identity]");
    expect(header).not.toContain("Mac");
    expect(header).not.toContain("[user]");
    expect(header).not.toContain("favorite_color");
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
    expect(header).toContain("[SharpWave]");
    expect(header).toContain("[neuro]");
    closeDb(id);
  });
});
