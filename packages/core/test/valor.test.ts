import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { writeNode, getNode } from "../src/nodes.js";
import { recordInjection, scoreReplyAgainstInjections, clearPendingInjections } from "../src/valor.js";
import { closeDb } from "../src/db.js";

function fresh(): string { return `test-${randomUUID().slice(0, 8)}`; }

// NOTE: sharpwave-core's BrainNode type (types.ts) does not declare the v17
// VALOR columns, and this task may not edit types.ts. The columns DO exist on
// the row (SELECT * returns them); read them through a narrow cast.
function injectCounts(agentId: string, nodeId: string): { inject_count: number; inject_hits: number } {
  const n = getNode(agentId, nodeId)! as unknown as { inject_count: number; inject_hits: number };
  return { inject_count: n.inject_count, inject_hits: n.inject_hits };
}

/**
 * VALOR -> FSRS wiring (2026-07-31).
 *
 * Before this, touchNode was reachable only from the brain_review tool, so the
 * live brain had 1 reviewed node out of 1,670 and memory never strengthened
 * with use. These tests pin the two halves of the contract: hits review,
 * misses do not.
 */
describe("VALOR -> FSRS", () => {
  beforeEach(() => clearPendingInjections());

  it("a used node gets a real FSRS review", () => {
    const id = fresh();
    const nodeId = writeNode(id, "semantic", "kingman weather", "Hailey lives in Kingman AZ and checks the weather", { importance: 0.6 });
    const before = getNode(id, nodeId)!;
    expect(before.review_count).toBe(0);

    recordInjection(id, "sess1", [{ id: nodeId, label: "kingman weather", content: "Hailey lives in Kingman AZ and checks the weather" }]);
    const res = scoreReplyAgainstInjections(id, "sess1", "yeah the weather in Kingman looks clear today");

    expect(res?.hits).toBe(1);
    expect(res?.reviewed).toBe(1);

    const after = getNode(id, nodeId)!;
    expect(after.review_count).toBe(1);
    expect(after.last_review).toBeTruthy();
    expect(after.stability).toBeGreaterThan(before.stability);
    closeDb(id);
  });

  it("an unused node is counted but NOT reviewed — a miss is 'irrelevant', not 'forgotten'", () => {
    const id = fresh();
    const nodeId = writeNode(id, "semantic", "unrelated fact", "the tow truck company uses a dispatch board", { importance: 0.6 });
    const before = getNode(id, nodeId)!;
    const beforeCounts = injectCounts(id, nodeId);

    recordInjection(id, "sess1", [{ id: nodeId, label: "unrelated fact", content: "the tow truck company uses a dispatch board" }]);
    const res = scoreReplyAgainstInjections(id, "sess1", "here is a poem about bats and rain");

    expect(res?.hits).toBe(0);
    expect(res?.reviewed).toBe(0);

    const after = getNode(id, nodeId)!;
    expect(after.review_count).toBe(0);
    expect(injectCounts(id, nodeId).inject_count).toBe(beforeCounts.inject_count + 1);
    // Crucially: stability must NOT be shredded for being off-topic.
    expect(after.stability).toBe(before.stability);
    closeDb(id);
  });

  it("repeated same-turn use does not ratchet stability to the cap (the old q=4 runaway)", () => {
    const id = fresh();
    const nodeId = writeNode(id, "semantic", "kingman", "Hailey lives in Kingman Arizona", { importance: 0.6 });

    for (let i = 0; i < 15; i++) {
      recordInjection(id, `s${i}`, [{ id: nodeId, label: "kingman", content: "Hailey lives in Kingman Arizona" }]);
      scoreReplyAgainstInjections(id, `s${i}`, "Kingman Arizona is where Hailey lives");
    }

    const after = getNode(id, nodeId)!;
    expect(after.review_count).toBe(15);
    // FSRS gates growth on pre-review retrievability, so back-to-back reviews
    // gain almost nothing. Must stay far off the 365-day cap.
    expect(after.stability).toBeLessThan(120);
    closeDb(id);
  });

  it("feeds ripple_count, which is the REM-generative candidate gate", () => {
    const id = fresh();
    const nodeId = writeNode(id, "episodic", "ripple check", "Marley wrote a self portrait about becoming", { importance: 0.6 });
    expect(getNode(id, nodeId)!.ripple_count).toBe(0);

    recordInjection(id, "sess1", [{ id: nodeId, label: "ripple check", content: "Marley wrote a self portrait about becoming" }]);
    scoreReplyAgainstInjections(id, "sess1", "the self portrait about becoming was the good one");

    expect(getNode(id, nodeId)!.ripple_count).toBeGreaterThan(0);
    closeDb(id);
  });

  it("reviews only the hits when a batch has both", () => {
    const id = fresh();
    const hit = writeNode(id, "semantic", "dispatcher", "Hailey works as a tow truck dispatcher", { importance: 0.6 });
    const miss = writeNode(id, "semantic", "godot", "the alt aliens game is built in Godot", { importance: 0.6 });

    recordInjection(id, "sess1", [
      { id: hit, label: "dispatcher", content: "Hailey works as a tow truck dispatcher" },
      { id: miss, label: "godot", content: "the alt aliens game is built in Godot" },
    ]);
    const res = scoreReplyAgainstInjections(id, "sess1", "long night on the dispatcher board huh");

    expect(res?.scored).toBe(2);
    expect(res?.reviewed).toBe(1);
    expect(getNode(id, hit)!.review_count).toBe(1);
    expect(getNode(id, miss)!.review_count).toBe(0);
    closeDb(id);
  });
});
