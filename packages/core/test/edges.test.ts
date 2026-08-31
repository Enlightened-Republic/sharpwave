import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { writeNode } from "../src/nodes.js";
import { writeEdge, closeEdge, edgeExists, getInhibitedNodeIds, getActiveEdgesFrom } from "../src/edges.js";
import { getDb, closeDb } from "../src/db.js";

function fresh(): string { return `test-${randomUUID().slice(0, 8)}`; }

// sharpwave-core's writeNode dedupes on near-identical content by default
// (trigram-Jaccard >= 0.85, type-scoped) — a behaviour clawbrain-v4's writeNode
// did not have. Several tests below intentionally create multiple nodes with the
// same placeholder content ("c"), so they pass `{ deduplicate: false }` to get
// distinct rows. (openwave/sharpwave-core split, Task 3.)

describe("edges", () => {
  it("writeEdge creates a valid edge", () => {
    const id = fresh();
    const a = writeNode(id, "semantic", "node A", "content A");
    const b = writeNode(id, "semantic", "node B", "content B");

    const edgeId = writeEdge(id, a, b, "associated_with", { weight: 0.8 });
    const db = getDb(id);
    const edge = db.prepare("SELECT * FROM edges WHERE id = ?").get(edgeId) as { type: string; weight: number; valid_until: null } | undefined;

    expect(edge).toBeDefined();
    expect(edge!.type).toBe("associated_with");
    expect(edge!.weight).toBe(0.8);
    expect(edge!.valid_until).toBeNull();
    closeDb(id);
  });

  it("edgeExists returns true for active edge, false for missing", () => {
    const id = fresh();
    const a = writeNode(id, "semantic", "node A", "c", { deduplicate: false });
    const b = writeNode(id, "semantic", "node B", "c", { deduplicate: false });

    expect(edgeExists(id, a, b, "caused_by")).toBe(false);
    writeEdge(id, a, b, "caused_by");
    expect(edgeExists(id, a, b, "caused_by")).toBe(true);
    closeDb(id);
  });

  it("closeEdge sets valid_until on the edge", () => {
    const id = fresh();
    const a = writeNode(id, "semantic", "A", "c", { deduplicate: false });
    const b = writeNode(id, "semantic", "B", "c", { deduplicate: false });
    const edgeId = writeEdge(id, a, b, "supports");

    closeEdge(id, edgeId);

    const db = getDb(id);
    const edge = db.prepare("SELECT valid_until FROM edges WHERE id = ?").get(edgeId) as { valid_until: number | null };
    expect(edge.valid_until).not.toBeNull();
    closeDb(id);
  });

  it("getInhibitedNodeIds returns nodes targeted by inhibits edges", () => {
    const id = fresh();
    const a = writeNode(id, "semantic", "A", "c", { deduplicate: false });
    const b = writeNode(id, "semantic", "B", "c", { deduplicate: false });
    writeEdge(id, a, b, "inhibits");

    const inhibited = getInhibitedNodeIds(id, a);
    expect(inhibited).toContain(b);
    closeDb(id);
  });

  it("getActiveEdgesFrom excludes closed edges", () => {
    const id = fresh();
    const a = writeNode(id, "semantic", "A", "c", { deduplicate: false });
    const b = writeNode(id, "semantic", "B", "c", { deduplicate: false });
    const c = writeNode(id, "semantic", "C", "c", { deduplicate: false });

    const edgeId1 = writeEdge(id, a, b, "before");
    writeEdge(id, a, c, "after");
    closeEdge(id, edgeId1);

    const active = getActiveEdgesFrom(id, a);
    expect(active.length).toBe(1);
    expect(active[0].to_id).toBe(c);
    closeDb(id);
  });

  // ── Self-loop guard (code-1 bonus fix / SYNTHESIS T1.6) ─────────────────────
  it("writeEdge refuses self-loops (from_id === to_id) and returns empty id", () => {
    const id = fresh();
    const a = writeNode(id, "semantic", "self-loop guard", "c");
    // Capture stderr by replacing console.warn with a counter — verifies the
    // structured warning is emitted alongside the refusal.
    const original = console.warn;
    let warnCount = 0;
    console.warn = () => { warnCount++; };
    try {
      const edgeId = writeEdge(id, a, a, "associated_with", { weight: 1.0 });
      expect(edgeId).toBe("");
      expect(warnCount).toBeGreaterThan(0);

      // No row was inserted.
      const db = getDb(id);
      const count = (db.prepare("SELECT COUNT(*) as n FROM edges WHERE from_id = ? AND to_id = ?").get(a, a) as { n: number }).n;
      expect(count).toBe(0);
    } finally {
      console.warn = original;
    }
    closeDb(id);
  });

  it("writeEdge self-loop guard applies to every edge type, including inhibits", () => {
    const id = fresh();
    const a = writeNode(id, "semantic", "self-inhibit", "c");
    const original = console.warn;
    console.warn = () => {};
    try {
      const inhibitId = writeEdge(id, a, a, "inhibits", { weight: 1.0 });
      expect(inhibitId).toBe("");
      const beforeId = writeEdge(id, a, a, "before");
      expect(beforeId).toBe("");
      const corefId = writeEdge(id, a, a, "coreference_of");
      expect(corefId).toBe("");
    } finally {
      console.warn = original;
    }
    closeDb(id);
  });
});
