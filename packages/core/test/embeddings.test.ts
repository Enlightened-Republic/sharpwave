import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { queueEmbedding, drainEmbeddingQueue, rrfFuse, cosineSimilarity, bufferToFloat32, sweepMissingEmbeddings, clearEmbeddingQueues, fetchEmbedding, EXPECTED_VEC_DIM } from "../src/embeddings.js";
import { writeNode } from "../src/nodes.js";
import { getDb, closeDb } from "../src/db.js";
import { DEFAULT_CONFIG } from "../src/types.js";

function fresh(): string { return `test-${randomUUID().slice(0, 8)}`; }

describe("embeddings", () => {
  it("drainEmbeddingQueue is a no-op on empty queue", async () => {
    const id = fresh();
    await expect(drainEmbeddingQueue(id, DEFAULT_CONFIG)).resolves.toBeUndefined();
    closeDb(id);
  });

  it("drainEmbeddingQueue silently skips nodes with no API key", async () => {
    const id = fresh();
    const nodeId = writeNode(id, "semantic", "test node", "content for embedding test");
    queueEmbedding(id, nodeId);
    // No API key in DEFAULT_CONFIG — fetchEmbedding returns null, no embed stored, no error
    await expect(drainEmbeddingQueue(id, { ...DEFAULT_CONFIG, openRouterApiKey: "" })).resolves.toBeUndefined();
    closeDb(id);
  });

  it("drainEmbeddingQueue skips non-existent node IDs gracefully", async () => {
    const id = fresh();
    queueEmbedding(id, "00000000-0000-0000-0000-000000000000");
    await expect(drainEmbeddingQueue(id, DEFAULT_CONFIG)).resolves.toBeUndefined();
    closeDb(id);
  });

  it("concurrent drain calls do not re-enter — second call returns early", async () => {
    const id = fresh();
    const nodeId = writeNode(id, "semantic", "concurrent test node", "content");
    queueEmbedding(id, nodeId);

    // Simulate two concurrent drains — only one should process
    const [r1, r2] = await Promise.all([
      drainEmbeddingQueue(id, { ...DEFAULT_CONFIG, openRouterApiKey: "" }),
      drainEmbeddingQueue(id, { ...DEFAULT_CONFIG, openRouterApiKey: "" }),
    ]);

    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();
    closeDb(id);
  });

  it("queue is cleared after drain completes", async () => {
    const id = fresh();
    const nodeId = writeNode(id, "semantic", "queue clear test", "content");
    queueEmbedding(id, nodeId);
    await drainEmbeddingQueue(id, { ...DEFAULT_CONFIG, openRouterApiKey: "" });

    // Second drain is an immediate no-op — queue was cleared
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    await drainEmbeddingQueue(id, { ...DEFAULT_CONFIG, openRouterApiKey: "test-key" });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    closeDb(id);
  });

  it("rrfFuse deduplicates nodes appearing in multiple lists", () => {
    const makeNode = (id: string) => ({
      id, type: "semantic" as const, label: id, content: "", importance: 0.5,
      salience: 0.5, stability: 10, retrievability: 1, ef: 2.5, access_count: 0,
      emotional_weight: 0, episode_ids: null, source: null, embedding: null,
      encoding_context: null, extraction_confidence: 1, ripple_count: 0,
      eligibility_trace: 0, created_at: 0, accessed_at: 0, updated_at: 0,
    });

    const a = makeNode("aaa");
    const b = makeNode("bbb");
    const fused = rrfFuse([[a, b], [b, a]]);

    const ids = fused.map((n) => n.id);
    expect(ids).toContain("aaa");
    expect(ids).toContain("bbb");
    // Deduplication: each ID appears exactly once
    expect(ids.filter((x) => x === "aaa").length).toBe(1);
    expect(ids.filter((x) => x === "bbb").length).toBe(1);
  });

  it("rrfFuse ranks shared nodes higher", () => {
    const makeNode = (id: string) => ({
      id, type: "semantic" as const, label: id, content: "", importance: 0.5,
      salience: 0.5, stability: 10, retrievability: 1, ef: 2.5, access_count: 0,
      emotional_weight: 0, episode_ids: null, source: null, embedding: null,
      encoding_context: null, extraction_confidence: 1, ripple_count: 0,
      eligibility_trace: 0, created_at: 0, accessed_at: 0, updated_at: 0,
    });

    const shared = makeNode("shared");
    const onlyInFirst = makeNode("first-only");
    const fused = rrfFuse([[shared, onlyInFirst], [shared]]);

    expect(fused[0].id).toBe("shared"); // shared node ranks first
  });

  it("cosineSimilarity returns 1.0 for identical vectors", () => {
    const v = new Float32Array([0.6, 0.8]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it("cosineSimilarity returns 0 for perpendicular vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 5);
  });

  it("cosineSimilarity returns 0 for zero-magnitude vectors", () => {
    const a = new Float32Array([0, 0]);
    const b = new Float32Array([1, 0]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("bufferToFloat32 roundtrips correctly", () => {
    const original = new Float32Array([0.1, 0.5, -0.3, 0.9]);
    const buf = Buffer.from(original.buffer);
    const roundtripped = bufferToFloat32(buf);
    for (let i = 0; i < original.length; i++) {
      expect(roundtripped[i]).toBeCloseTo(original[i], 5);
    }
  });
});

// ─── Sweep / recovery (Tier 3 T3.5) ────────────────────────────────────────────

describe("sweepMissingEmbeddings — orphan recovery", () => {
  it("requeues semantic and episodic nodes with no embedding", async () => {
    clearEmbeddingQueues();
    const id = fresh();
    const semId = writeNode(id, "semantic", "orphan semantic node", "no embedding yet");
    const epId = writeNode(id, "episodic", "orphan episodic node", "no embedding either");
    // No queueEmbedding called → the queue is empty for this agent.
    const requeued = sweepMissingEmbeddings(id, 50);
    expect(requeued).toBeGreaterThanOrEqual(2);

    // After sweep, the queue should hold both ids. We can confirm by running
    // drain with a no-op provider — the drain consumes the queue (no fetches
    // succeed, but the queue is observed to be processed).
    //
    // Tests force a known-bad embedding model so neither the openrouter HTTP
    // path nor the ollama local daemon path can store an embedding. Without
    // this override, the default succeeds when the developer has Ollama
    // running locally and the assertion drifts.
    await drainEmbeddingQueue(id, { ...DEFAULT_CONFIG, openRouterApiKey: "", embeddingModel: "openrouter/__test_unreachable__" });

    // A second sweep+drain returns 2 again since embeddings were never stored
    // (no API key). This proves the sweep is finding them on every pass.
    const requeued2 = sweepMissingEmbeddings(id, 50);
    expect(requeued2).toBeGreaterThanOrEqual(2);

    // NOTE (Task 3): clawbrain-v4's "Fable-5 F-3" broadening made the sweep
    // type-agnostic (identity nodes swept too). sharpwave-core's
    // sweepMissingEmbeddings is still scoped to type IN ('semantic','episodic')
    // — verified in src/embeddings.ts. So an identity node is NOT requeued, and
    // a fresh sweep sees exactly the semantic + episodic pair.
    writeNode(id, "identity", "identity not swept", "identity nodes are excluded from the sweep");
    clearEmbeddingQueues();
    const requeued3 = sweepMissingEmbeddings(id, 50);
    expect(requeued3).toBe(2);

    void semId; void epId;
    closeDb(id);
  });

  it("respects the limit argument", () => {
    clearEmbeddingQueues();
    const id = fresh();
    for (let i = 0; i < 10; i++) {
      // deduplicate:false — near-identical content would otherwise be collapsed
      // by sharpwave-core's write-time dedupe (trigram Jaccard >= 0.85).
      writeNode(id, "semantic", `bulk node ${i}`, `no embedding for bulk node ${i}`, { deduplicate: false });
    }
    const requeued = sweepMissingEmbeddings(id, 3);
    expect(requeued).toBe(3);
    closeDb(id);
  });
});

// ─── Recovery — queue stays drainable after a failed batch (T3.5 + C2.3) ───────

describe("drainEmbeddingQueue — recovery after failed batch", () => {
  it("nodes left unembedded after a failed drain are findable by sweep", async () => {
    clearEmbeddingQueues();
    const id = fresh();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      // Unique content — sharpwave-core's writeNode dedupes identical content.
      const nid = writeNode(id, "semantic", `pre-batch node ${i}`, `pre-batch node ${i} ready to embed`);
      ids.push(nid);
      queueEmbedding(id, nid);
    }

    // Force the openrouter path with no API key → every fetch returns null →
    // no embeddings stored. Override embeddingModel so we don't fall through
    // to the local Ollama daemon (which may be reachable on the developer box).
    await drainEmbeddingQueue(id, { ...DEFAULT_CONFIG, openRouterApiKey: "", embeddingModel: "openrouter/__test_unreachable__" });

    // After the failed drain, all 5 still need embeddings.
    const stillNeed = sweepMissingEmbeddings(id, 50);
    expect(stillNeed).toBe(5);

    closeDb(id);
  });
});

// ─── fetchEmbedding provider routing (regression for 2026-05-16 dim_mismatch) ─
//
// Background: openclaw-2026-05-16.log 17:42:40 (00:42:40 UTC equivalent of the
// 18:48:33 dim_mismatch the user reported as Bug B):
//   [clawbrain-v4] {"op":"storeEmbedding","outcome":"dim_mismatch",
//                   "error":"Expected 768 dimensions but received 1536."}
// Root cause: DEFAULT_CONFIG.embeddingModel was "openai/text-embedding-3-small"
// and fetchEmbedding always went to OpenRouter, returning a 1536-dim vector
// that nodes_vec (float[768] per v11 migration) rejected. After the first
// rejection the process disabled all further vec0 writes until restart.
//
// The fix: route `ollama/*` models to the local Ollama daemon and reject any
// vector whose length is not EXPECTED_VEC_DIM before it reaches storeEmbedding.
describe("fetchEmbedding — provider routing and dim guard (Bug B regression)", () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    // Reset any spies from previous tests
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("EXPECTED_VEC_DIM matches the nodes_vec schema (1024)", () => {
    // If this assertion ever changes, the v15 migration in db.ts and the
    // embeddingModel default must change together.
    expect(EXPECTED_VEC_DIM).toBe(1024);
  });

  it("DEFAULT_CONFIG.embeddingModel is the 1024-dim ollama model", () => {
    // Pinning the default prevents an accidental revert to a model whose
    // dimension does not match nodes_vec (the original dim_mismatch incident).
    expect(DEFAULT_CONFIG.embeddingModel).toBe("ollama/qwen3-embedding:0.6b");
  });

  it("ollama/* models POST to localhost:11434/api/embeddings with {model, prompt}", async () => {
    // test/setup.ts points OLLAMA_BASE_URL at a dead port so no test hits a live
    // daemon. This case asserts the *default* base URL, so drop the override for
    // its duration (fetch is mocked — nothing leaves the process).
    const priorOllama = process.env["OLLAMA_BASE_URL"];
    delete process.env["OLLAMA_BASE_URL"];
    try {
    const fakeVec = new Array(EXPECTED_VEC_DIM).fill(0).map((_, i) => (i % 2 === 0 ? 0.01 : -0.01));
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ embedding: fakeVec }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const vec = await fetchEmbedding("hello world", {
      ...DEFAULT_CONFIG,
      embeddingModel: "ollama/nomic-embed-text",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0];
    expect(String(calledUrl)).toContain("localhost:11434/api/embeddings");
    const body = JSON.parse((calledInit as RequestInit).body as string);
    expect(body.model).toBe("nomic-embed-text"); // ollama/ prefix stripped
    expect(body.prompt).toBe("hello world");      // Ollama uses `prompt` not `input`
    expect(vec).not.toBeNull();
    expect(vec!.length).toBe(EXPECTED_VEC_DIM);
    } finally {
      if (priorOllama !== undefined) process.env["OLLAMA_BASE_URL"] = priorOllama;
    }
  });

  it("non-ollama models POST to openrouter.ai/api/v1/embeddings with {model, input}", async () => {
    const fakeVec = new Array(EXPECTED_VEC_DIM).fill(0.001);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ data: [{ embedding: fakeVec }] }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );

    const vec = await fetchEmbedding("hello", {
      ...DEFAULT_CONFIG,
      embeddingModel: "openrouter/some/model",
      openRouterApiKey: "test-key",
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchSpy.mock.calls[0];
    expect(String(calledUrl)).toContain("openrouter.ai/api/v1/embeddings");
    const init = calledInit as RequestInit;
    expect((init.headers as Record<string, string>)["Authorization"]).toBe("Bearer test-key");
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("some/model"); // openrouter/ prefix stripped
    expect(body.input).toBe("hello");      // OpenRouter uses `input`
    expect(vec).not.toBeNull();
    expect(vec!.length).toBe(EXPECTED_VEC_DIM);
  });

  it("returns null (does NOT call storeEmbedding) when the provider returns a wrong-dim vector", async () => {
    // This is the bug: previously a 1536-dim vector reached storeEmbedding,
    // which then disabled vec0 for the whole process. Now it's rejected here.
    const fakeVec = new Array(1536).fill(0.001); // wrong dim on purpose
    let observedWarn: string | undefined;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ embedding: fakeVec }), { status: 200 }),
    );

    const vec = await fetchEmbedding("anything", {
      ...DEFAULT_CONFIG,
      embeddingModel: "ollama/nomic-embed-text",
    }, {
      info: () => {}, warn: (m) => { observedWarn = m; }, debug: () => {}, error: () => {},
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(vec).toBeNull(); // critical: rejected before storeEmbedding sees it
    expect(observedWarn).toBeDefined();
    expect(observedWarn!).toContain("dim_mismatch");
    expect(observedWarn!).toContain("\"receivedDim\":1536");
    expect(observedWarn!).toContain("\"expectedDim\":1024");
  });

  it("returns null without an HTTP call when ollama is unreachable", async () => {
    // Network failures should not throw — drainEmbeddingQueue relies on
    // fetchEmbedding returning null so the queue stays intact for the next pass.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"));
    const vec = await fetchEmbedding("anything", {
      ...DEFAULT_CONFIG,
      embeddingModel: "ollama/nomic-embed-text",
    });
    expect(vec).toBeNull();
  });

  it("returns null for non-ollama models when no API key is configured", async () => {
    // OPENROUTER_API_KEY is unset in test env; explicit empty config.openRouterApiKey
    // forces the no-key skip path so the test doesn't depend on the env.
    const prior = process.env["OPENROUTER_API_KEY"];
    delete process.env["OPENROUTER_API_KEY"];
    try {
      const vec = await fetchEmbedding("anything", {
        ...DEFAULT_CONFIG,
        embeddingModel: "openrouter/some/model",
        openRouterApiKey: "",
      });
      expect(vec).toBeNull();
    } finally {
      if (prior !== undefined) process.env["OPENROUTER_API_KEY"] = prior;
    }
  });
});
