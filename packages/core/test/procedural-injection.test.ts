import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { writeNode as rawWriteNode, getOperationalProcedures } from "../src/nodes.js";
import { buildProceduralContext } from "../src/context-assembly.js";
import { getDb, closeDb } from "../src/db.js";

function fresh(): string { return `test-${randomUUID().slice(0, 8)}`; }

// sharpwave-core's writeNode carries a near-duplicate gate (trigram-Jaccard
// 0.85, default on) that clawbrain-v4's writeNode did not. Several fixtures below
// deliberately reuse identical content to isolate the source/importance/valid_until
// ranking in getOperationalProcedures — opt out of the gate so they land as
// distinct rows. The assertions are unchanged from clawbrain-v4.
type WriteArgs = Parameters<typeof rawWriteNode>;
const writeNode = (
  id: string, type: WriteArgs[1], label: string, content: string, opts: WriteArgs[4] = {},
): string => rawWriteNode(id, type, label, content, { ...opts, deduplicate: false });

const LONG = "x".repeat(120);

/**
 * Regression cover for the 2026-07-31 finding: all 33 procedural nodes on the
 * live db had inject_count = 0 since 2026-07-13, because hybridRetrieve is keyed
 * on the user's message and procedural knowledge never resembles it.
 */
describe("procedural injection", () => {
  it("surfaces procedural nodes without any query — the whole point", () => {
    const id = fresh();
    writeNode(id, "procedural", "PowerShell 5.1 limits", `no && separator. ${LONG}`, { importance: 0.9, source: "brain_manager" });
    const block = buildProceduralContext(id, "sess1");
    expect(block).toContain("PowerShell 5.1 limits");
    expect(block).toContain("operational rules");
    closeDb(id);
  });

  it("prefers hand-verified brain_manager nodes over extracted ones at equal importance", () => {
    const id = fresh();
    writeNode(id, "procedural", "extracted-rule", LONG, { importance: 0.9, source: "llm_extraction" });
    writeNode(id, "procedural", "verified-rule", LONG, { importance: 0.9, source: "brain_manager" });
    const [first] = getOperationalProcedures(id, 2);
    expect(first.label).toBe("verified-rule");
    closeDb(id);
  });

  it("drops SWS title-fragment artifacts that would outrank real rules on importance", () => {
    const id = fresh();
    // Real artifact from the live db: importance 0.917, 35 chars, useless.
    writeNode(id, "procedural", "step-1-fragment", "## Step 1: Register Your Agent", { importance: 0.95, source: "sws" });
    writeNode(id, "procedural", "real-rule", LONG, { importance: 0.9, source: "brain_manager" });
    const got = getOperationalProcedures(id, 5).map((n) => n.label);
    expect(got).toContain("real-rule");
    expect(got).not.toContain("step-1-fragment");
    closeDb(id);
  });

  it("does not re-inject a node buildRecallContext already returned", () => {
    const id = fresh();
    const nodeId = writeNode(id, "procedural", "dup-rule", LONG, { importance: 0.9, source: "brain_manager" });
    expect(buildProceduralContext(id, "sess1")).toContain("dup-rule");
    expect(buildProceduralContext(id, "sess1", new Set([nodeId]))).toBe("");
    closeDb(id);
  });

  it("stays inside its char budget so it cannot bloat the prompt", () => {
    const id = fresh();
    for (let i = 0; i < 20; i++) {
      writeNode(id, "procedural", `rule-${i}`, "y".repeat(400), { importance: 0.9, source: "brain_manager" });
    }
    const block = buildProceduralContext(id, "sess1");
    // Bounded by PROCEDURAL_MAX_CHARS (2600) plus the one-line header.
    expect(block.length).toBeLessThan(2800);
    // ...and it genuinely dropped nodes rather than emitting all 20.
    expect(block.split("\n").length - 1).toBeLessThan(20);
    closeDb(id);
  });

  it("packs greedily — one oversized rule does not starve the smaller ones behind it", () => {
    const id = fresh();
    // Ranked first by importance, but too big for the budget on its own.
    writeNode(id, "procedural", "huge-rule", "z".repeat(9000), { importance: 0.99, source: "brain_manager" });
    writeNode(id, "procedural", "small-rule", LONG, { importance: 0.9, source: "brain_manager" });
    const block = buildProceduralContext(id, "sess1");
    expect(block).toContain("small-rule");
    closeDb(id);
  });

  it("returns empty string when there are no procedural nodes", () => {
    const id = fresh();
    writeNode(id, "semantic", "not-procedural", LONG, { importance: 0.9 });
    expect(buildProceduralContext(id, "sess1")).toBe("");
    closeDb(id);
  });

  it("excludes superseded nodes via valid_until", () => {
    const id = fresh();
    const stale = writeNode(id, "procedural", "stale-rule", LONG, { importance: 0.9, source: "brain_manager" });
    writeNode(id, "procedural", "current-rule", LONG, { importance: 0.9, source: "brain_manager" });
    getDb(id).prepare("UPDATE nodes SET valid_until = ? WHERE id = ?").run(Date.now() - 1000, stale);
    const got = getOperationalProcedures(id, 5).map((n) => n.label);
    expect(got).toEqual(["current-rule"]);
    closeDb(id);
  });
});
