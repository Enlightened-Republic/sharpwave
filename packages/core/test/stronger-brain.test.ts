/**
 * "Stronger brain" follow-ups (October 2026):
 *   5. the dedupe merge never downgrades a belief
 * (items 1-4 have their own describe blocks below as they land)
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb, closeDb } from "../src/db.js";
import { writeNode, getNode } from "../src/nodes.js";

const opened: string[] = [];
function fresh(prefix = "strong"): string { const id = `${prefix}-${randomUUID().slice(0, 8)}`; opened.push(id); return id; }
afterEach(() => { for (const id of opened.splice(0)) closeDb(id); });

// ─── 5. never-downgrade merge ─────────────────────────────────────────────────

describe("dedupe merge never downgrades a belief", () => {
  const TEXT = "The production database for the newsletter is PostgreSQL 16 on RDS in us-east-1.";

  it("a user restating an inferred fact lifts confidence, source and sensitivity; evidence and episodes are unioned", () => {
    const a = fresh();
    const first = writeNode(a, "semantic", "prod db", TEXT, { sourceType: "inference", confidence: 0.45, evidence: ["ep-1"], episode_ids: ["ep-1"] });
    const second = writeNode(a, "semantic", "prod db (restated)", TEXT, { sourceType: "user", confidence: "certain", sensitivity: "confirm_before_acting", evidence: ["ep-2"], episode_ids: ["ep-2"], verifiedAt: 1_700_000_000_000 });
    expect(second).toBe(first); // merged, not duplicated
    const n = getNode(a, first)!;
    expect(n.confidence_score).toBeGreaterThanOrEqual(0.9);
    expect(n.confidence).toBe("certain");
    expect(n.source_type).toBe("user");
    expect(n.sensitivity).toBe("confirm_before_acting");
    expect(n.verified_at).toBe(1_700_000_000_000);
    expect(JSON.parse(n.evidence!)).toEqual(["ep-1", "ep-2"]);
    expect(JSON.parse(n.episode_ids!)).toEqual(["ep-1", "ep-2"]);
    expect((getDb(a).prepare("SELECT COUNT(*) n FROM nodes").get() as { n: number }).n).toBe(1);
  });

  it("a weaker restatement never lowers what is already known, and the writer stays the creator", () => {
    const a = fresh();
    const first = writeNode(a, "semantic", "prod db", TEXT, { sourceType: "user", confidence: 0.9, sensitivity: "sensitive", writerAgentId: "alice", verifiedAt: 5 });
    const second = writeNode(a, "semantic", "prod db again", TEXT, { sourceType: "inference", confidence: 0.3, sensitivity: "normal", writerAgentId: "sleep" });
    expect(second).toBe(first);
    const n = getNode(a, first)!;
    expect(n.confidence_score).toBeCloseTo(0.9, 5);
    expect(n.source_type).toBe("user");
    expect(n.sensitivity).toBe("sensitive");
    expect(n.verified_at).toBe(5);
    expect(n.writer_agent_id).toBe("alice");
  });
});
