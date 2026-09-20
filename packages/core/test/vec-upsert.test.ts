import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { storeEmbedding, rebuildNodesVec, vectorSearchNodes, EXPECTED_VEC_DIM } from "../src/embeddings.js";
import { writeNode } from "../src/nodes.js";
import { getDb, closeDb } from "../src/db.js";

function fresh(): string { return `test-${randomUUID().slice(0, 8)}`; }

function unit(seed: number): Float32Array {
  const v = new Float32Array(EXPECTED_VEC_DIM);
  v[seed % EXPECTED_VEC_DIM] = 1;
  return v;
}

function vecCount(id: string): number {
  const row = getDb(id).prepare("SELECT count(*) AS n FROM nodes_vec").get() as { n: number };
  return row.n;
}

function captureLog() {
  const errors: string[] = [];
  const warns: string[] = [];
  return {
    errors,
    warns,
    log: {
      info: () => {},
      debug: () => {},
      warn: (m: string) => { warns.push(m); },
      error: (m: string) => { errors.push(m); },
    },
  };
}

// Regression for the 2026-09-20 openwave log line:
//   {"op":"storeEmbedding","outcome":"dim_mismatch",
//    "error":"SqliteError: UNIQUE constraint failed on nodes_vec primary key",
//    "note":"vec0 writes disabled for this process — run nodes_vec rebuild"}
// vec0 does not honor INSERT OR REPLACE, so re-embedding an already-indexed node
// threw a UNIQUE error that storeEmbedding misclassified as a dimension mismatch,
// silencing every later vec0 write until the process restarted.
describe("vec0 upsert (UNIQUE-constraint regression)", () => {
  it("re-embedding the same node replaces its vector instead of throwing", () => {
    const id = fresh();
    const { log, errors, warns } = captureLog();
    const nodeId = writeNode(id, "semantic", "re-embed node", "content that is embedded twice");

    storeEmbedding(id, nodeId, unit(3), log);
    expect(vecCount(id)).toBe(1);

    storeEmbedding(id, nodeId, unit(7), log);
    expect(errors).toEqual([]);
    expect(warns).toEqual([]);
    expect(vecCount(id)).toBe(1);

    // The stored vector is the NEW one: querying with unit(7) finds the node at distance ~0.
    const hits = vectorSearchNodes(id, unit(7), 5);
    expect(hits.length).toBeGreaterThan(0);
    closeDb(id);
  });

  it("a UNIQUE failure no longer disables vec0 writes for later nodes", () => {
    const id = fresh();
    const { log, errors } = captureLog();
    const a = writeNode(id, "semantic", "node a", "first node content");
    const b = writeNode(id, "semantic", "node b", "second node content");

    storeEmbedding(id, a, unit(1), log);
    storeEmbedding(id, a, unit(2), log); // used to trip the flag
    storeEmbedding(id, b, unit(5), log); // used to be silently skipped

    expect(errors).toEqual([]);
    expect(vecCount(id)).toBe(2);
    closeDb(id);
  });

  it("a real wrong-dimension vector still disables writes and logs dim_mismatch", () => {
    const id = fresh();
    const { log, errors } = captureLog();
    const a = writeNode(id, "semantic", "dim node", "node used for the dimension check");
    storeEmbedding(id, a, new Float32Array(16), log);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("dim_mismatch");
    // Re-arm for the rest of the suite (module-level flag).
    rebuildNodesVec(id);
    closeDb(id);
  });
});

describe("rebuildNodesVec", () => {
  it("re-indexes nodes whose embedding blob exists but whose vec row is missing", () => {
    const id = fresh();
    const db = getDb(id);
    const ids = [1, 2, 3].map((n) => writeNode(id, "semantic", `n${n}`, `content ${n}`));
    ids.forEach((nid, i) => {
      const buf = Buffer.from(unit(i + 10).buffer);
      db.prepare("UPDATE nodes SET embedding = ? WHERE id = ?").run(buf, nid);
    });
    expect(vecCount(id)).toBe(0); // blobs present, index empty (the live-brain state)

    const res = rebuildNodesVec(id);
    expect(res).toEqual({ indexed: 3, skipped: 0 });
    expect(vecCount(id)).toBe(3);

    // Idempotent: a second run yields the same index.
    expect(rebuildNodesVec(id)).toEqual({ indexed: 3, skipped: 0 });
    expect(vecCount(id)).toBe(3);
    closeDb(id);
  });

  it("skips blobs that are not EXPECTED_VEC_DIM floats", () => {
    const id = fresh();
    const db = getDb(id);
    const good = writeNode(id, "semantic", "good", "good vector");
    const bad = writeNode(id, "semantic", "bad", "bad vector");
    db.prepare("UPDATE nodes SET embedding = ? WHERE id = ?").run(Buffer.from(unit(4).buffer), good);
    db.prepare("UPDATE nodes SET embedding = ? WHERE id = ?").run(Buffer.from(new Float32Array(16).buffer), bad);

    expect(rebuildNodesVec(id)).toEqual({ indexed: 1, skipped: 1 });
    expect(vecCount(id)).toBe(1);
    closeDb(id);
  });
});
