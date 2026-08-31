import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { handleCompaction } from "../src/compaction.js";
import { getDb, closeDb } from "../src/db.js";
import { DEFAULT_CONFIG } from "../src/types.js";

function fresh(): string { return `compaction-${randomUUID().slice(0, 8)}`; }
const log = { info: () => {}, warn: () => {} };

// Three sentences that classifySentence resolves to distinct types:
//  - "... is defined as ..."           -> semantic  (importance 0.60)
//  - "Yesterday the user asked ..."     -> episodic  (importance 0.45)
//  - "I want to ..."                    -> goal      (importance 0.80)
const SUMMARY = [
  "The compaction pipeline is defined as the process that mines a summary for durable memory nodes.",
  "Yesterday the user asked to port three cognition modules into the shared core package.",
  "I want to verify idempotency when the same compaction event is replayed.",
].join(" ");

describe("compaction", () => {
  it("mines the summary into classified nodes and wires sequential before-edges", () => {
    const id = fresh();
    const db = getDb(id);

    handleCompaction(id, { summary: SUMMARY, sourceEpisodeIds: ["ep-1", "ep-2"] }, DEFAULT_CONFIG, log);

    const nodes = db.prepare(
      "SELECT type, label, importance, episode_ids FROM nodes WHERE source = 'compaction' ORDER BY created_at",
    ).all() as { type: string; label: string; importance: number; episode_ids: string }[];

    expect(nodes.length).toBe(3);
    // Every mined node carries a sane importance in (0, 1].
    for (const n of nodes) {
      expect(n.importance).toBeGreaterThan(0);
      expect(n.importance).toBeLessThanOrEqual(1);
    }
    // Type-driven importance came through importanceForType.
    const byType = Object.fromEntries(nodes.map((n) => [n.type, n.importance]));
    expect(byType["goal"]).toBeCloseTo(0.80, 5);
    expect(byType["semantic"]).toBeCloseTo(0.60, 5);
    expect(byType["episodic"]).toBeCloseTo(0.45, 5);
    // sourceEpisodeIds propagated onto the nodes.
    expect(JSON.parse(nodes[0].episode_ids)).toEqual(["ep-1", "ep-2"]);

    // Sequential nodes are chained with `before` edges (n-1 of them).
    const beforeEdges = db.prepare(
      "SELECT COUNT(*) AS n FROM edges WHERE type = 'before' AND valid_until IS NULL",
    ).get() as { n: number };
    expect(beforeEdges.n).toBe(2);

    closeDb(id);
  });

  it("is idempotent — replaying the same event adds no new nodes", () => {
    const id = fresh();
    const db = getDb(id);

    handleCompaction(id, { summary: SUMMARY }, DEFAULT_CONFIG, log);
    const after1 = (db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE source = 'compaction'").get() as { n: number }).n;

    handleCompaction(id, { summary: SUMMARY }, DEFAULT_CONFIG, log);
    const after2 = (db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE source = 'compaction'").get() as { n: number }).n;

    expect(after1).toBe(3);
    expect(after2).toBe(3);

    closeDb(id);
  });

  it("no-ops without crashing on an empty or too-short event", () => {
    const id = fresh();
    const db = getDb(id);

    expect(() => handleCompaction(id, {}, DEFAULT_CONFIG, log)).not.toThrow();
    expect(() => handleCompaction(id, { summary: "too short" }, DEFAULT_CONFIG, log)).not.toThrow();
    expect(() => handleCompaction(id, { messages: [{ role: "user", content: "hi" }] }, DEFAULT_CONFIG, log)).not.toThrow();

    const n = (db.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number }).n;
    expect(n).toBe(0);

    closeDb(id);
  });
});
