/**
 * "Stronger brain" follow-ups (October 2026):
 *   5. the dedupe merge never downgrades a belief
 * (items 1-4 have their own describe blocks below as they land)
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb, closeDb, setMeta } from "../src/db.js";
import { writeNode, getNode, ftsSearchNodes, reviveNode, searchDormantNodes } from "../src/nodes.js";
import { writeEdge } from "../src/edges.js";
import { hybridRetrieve } from "../src/retrieval.js";
import { runConsolidation } from "../src/consolidation.js";
import { computeBrainStatus, formatBrainStatus } from "../src/beliefs.js";
import { dispatchBrainTool } from "../src/tools.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const opened: string[] = [];
function fresh(prefix = "strong"): string { const id = `${prefix}-${randomUUID().slice(0, 8)}`; opened.push(id); return id; }
afterEach(() => { for (const id of opened.splice(0)) closeDb(id); });
const cfg = { ...DEFAULT_CONFIG };
const log = { info: () => {}, warn: () => {}, error: () => {} };
const DAY = 86_400_000;

// ─── 1. never delete, make dormant ────────────────────────────────────────────

describe("forgetting is dormancy, not deletion", () => {
  async function fadeOut(a: string) {
    const faded = writeNode(a, "semantic", "sourdough starter", "a sourdough starter needs feeding every twelve hours in warm weather", { deduplicate: false });
    const kept = writeNode(a, "semantic", "pelican migration", "the pelican migration passes the lake in March", { deduplicate: false });
    writeNode(a, "semantic", "pelican anchor", "a note that links to the pelican fact", { deduplicate: false });
    getDb(a).prepare("UPDATE nodes SET retrievability = 0.001 WHERE id IN (?, ?)").run(faded, kept);
    // kept has a live edge, so it is never a candidate
    const anchor = (getDb(a).prepare("SELECT id FROM nodes WHERE label = 'pelican anchor'").get() as { id: string }).id;
    writeEdge(a, anchor, kept, "supports", { weight: 0.9 });
    setMeta(a, "last_consolidation", String(Date.now() - 8 * DAY));
    await runConsolidation(a, cfg, log);
    return { faded, kept };
  }

  it("the Deep phase keeps the row, marks it dormant, and recall no longer surfaces it", async () => {
    const a = fresh();
    const { faded, kept } = await fadeOut(a);
    const n = getNode(a, faded)!;
    expect(n.status).toBe("dormant");
    expect(n.status_reason).toMatch(/dormant/);
    expect(n.valid_until).not.toBeNull();
    expect(getNode(a, kept)!.status).toBe("active");
    expect(ftsSearchNodes(a, "sourdough starter", 5).map((x) => x.id)).not.toContain(faded);
    const hits = await hybridRetrieve(a, "sourdough starter feeding", "s1", cfg);
    expect(hits.map((x) => x.id)).not.toContain(faded);
    // and it is not a candidate again on the next sleep (pruned count stays 0)
    setMeta(a, "last_consolidation", String(Date.now() - 8 * DAY));
    await runConsolidation(a, cfg, log);
    expect(getNode(a, faded)!.status).toBe("dormant");
  });

  it("brain_status counts dormant memories; brain_expand explains the status", async () => {
    const a = fresh();
    const { faded } = await fadeOut(a);
    const st = computeBrainStatus(getDb(a), cfg);
    expect(st.nodes.dormant).toBe(1);
    expect(formatBrainStatus(st)).toMatch(/dormant 1/);
    const ex = await dispatchBrainTool("brain_expand", a, { node_id: faded }, cfg);
    expect(ex.text).toMatch(/Status: dormant/);
  });

  it("an explicit cue revives it: brain_query include_dormant finds and reactivates the memory", async () => {
    const a = fresh();
    const { faded } = await fadeOut(a);
    expect(searchDormantNodes(a, "sourdough starter").map((x) => x.id)).toContain(faded);
    const miss = await dispatchBrainTool("brain_query", a, { query: "sourdough starter" }, cfg);
    expect(miss.text).not.toMatch(/sourdough/);
    const hit = await dispatchBrainTool("brain_query", a, { query: "sourdough starter", include_dormant: true }, cfg);
    expect(hit.text).toMatch(/sourdough starter.*\(revived from dormant\)/);
    const n = getNode(a, faded)!;
    expect(n.status).toBe("active");
    expect(n.valid_until).toBeNull();
    expect(n.retrievability).toBeGreaterThanOrEqual(0.3);
    // back in ordinary recall
    const again = await dispatchBrainTool("brain_query", a, { query: "sourdough starter" }, cfg);
    expect(again.text).toMatch(/sourdough/);
    expect(reviveNode(a, faded)).toBe(false); // already active: nothing to do
  });

  it("forgetting: \"delete\" keeps the old physical prune", async () => {
    const a = fresh();
    const faded = writeNode(a, "semantic", "faded trivia", "some long-forgotten trivia about tidal friction", { deduplicate: false });
    getDb(a).prepare("UPDATE nodes SET retrievability = 0.001 WHERE id = ?").run(faded);
    setMeta(a, "last_consolidation", String(Date.now() - 8 * DAY));
    await runConsolidation(a, { ...cfg, forgetting: "delete" }, log);
    expect(getNode(a, faded)).toBeFalsy();
  });
});

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
