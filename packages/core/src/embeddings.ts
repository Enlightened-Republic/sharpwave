import { getDb } from "./db.js";
import { edgeExists, writeEdge } from "./edges.js";
import { updatePsHash } from "./nodes.js";
import { bumpCounter, logObservabilityEvent } from "./observability.js";
import type { BrainNode, BrainConfig } from "./types.js";

type Logger = { debug?: (msg: string) => void; info: (msg: string) => void; warn: (msg: string) => void; error?: (msg: string) => void };

// Per-agent embedding queue: agentId → pending node IDs
const embeddingQueue = new Map<string, string[]>();
// Guards concurrent drains per agent — JavaScript is single-threaded but async yields allow re-entry
const drainingAgents = new Set<string>();
const MAX_EMBED_QUEUE = 200;

// ── Embedding LRU cache (item #5) ────────────────────────────────────────────────────────
// Process-lifetime LRU cache keyed by raw text. Wraps `fetchEmbedding` so
// repeated strings (same query, identical content across writes, etc.) don't
// re-hit the embedding provider. Matches the Python reference's
// `_get_embedding_with_cache` semantics:
//
//   - default max size 1024 (overridable via SHARPWAVE_EMBEDDING_CACHE_MAXSIZE)
//   - hits bump `embeddings_cached` + emit `embedding_cache_hit` event
//   - misses bump `embeddings_computed` + emit `embedding_cache_miss` event
//   - thread-safety: JS is single-threaded but `fetchEmbedding` is async, so
//     a re-entrant caller could double-fetch. A `cacheBusy` flag prevents the
//     race by short-circuiting to a direct compute while a populate is in
//     flight for a given key.
const EMBEDDING_CACHE_DEFAULT_MAX = 1024;
const embeddingCache: Map<string, Float32Array> = new Map();
const embeddingCacheMax: number = (() => {
  const raw = process.env["SHARPWAVE_EMBEDDING_CACHE_MAXSIZE"];
  const n = raw ? parseInt(raw, 10) : EMBEDDING_CACHE_DEFAULT_MAX;
  return Number.isFinite(n) && n > 0 ? n : EMBEDDING_CACHE_DEFAULT_MAX;
})();
let embeddingCacheHits = 0;
let embeddingCacheMisses = 0;
// Tracks the in-flight text being populated; concurrent fetches for the same
// text skip the cache read and compute fresh (cheap safety net against
// duplicate provider calls during a cache miss burst).
let cacheBusyKey: string | null = null;

export interface EmbeddingCacheStats {
  size: number;
  maxsize: number;
  hits: number;
  misses: number;
}

export function embeddingCacheStats(): EmbeddingCacheStats {
  return {
    size: embeddingCache.size,
    maxsize: embeddingCacheMax,
    hits: embeddingCacheHits,
    misses: embeddingCacheMisses,
  };
}

export function clearEmbeddingCache(): void {
  embeddingCache.clear();
  embeddingCacheHits = 0;
  embeddingCacheMisses = 0;
  cacheBusyKey = null;
}

export function queueEmbedding(agentId: string, nodeId: string): void {
  const q = embeddingQueue.get(agentId) ?? [];
  if (q.length >= MAX_EMBED_QUEUE) return;
  q.push(nodeId);
  embeddingQueue.set(agentId, q);
}

/**
 * Sweep the agent's node table for orphans missing an embedding and requeue them.
 *
 * Recovery path (Code-2 C2.3 / Tier 3 T3.5): batch failures during
 * drainEmbeddingQueue silently dropped pending items. This periodic sweep finds
 * any semantic / episodic nodes whose embedding column is still NULL and pushes
 * them back into the queue (subject to MAX_EMBED_QUEUE).
 */
export function sweepMissingEmbeddings(agentId: string, limit = 50): number {
  try {
    const db = getDb(agentId);
    const rows = db.prepare(`
      SELECT id FROM nodes
      WHERE embedding IS NULL AND type IN ('semantic', 'episodic')
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as { id: string }[];
    let requeued = 0;
    for (const row of rows) {
      queueEmbedding(agentId, row.id);
      requeued++;
    }
    return requeued;
  } catch {
    return 0;
  }
}

/**
 * Clear the queues and draining set. Used by registerRuntimeLifecycle on
 * reset/delete/disable/restart so plugin reloads don't carry stale state.
 */
export function clearEmbeddingQueues(): void {
  embeddingQueue.clear();
  drainingAgents.clear();
}

// True if the better-sqlite3 error indicates a closed handle. This happens
// when runtime lifecycle cleanup (reset/delete/disable) ran while a drain was
// in flight. Treated as a benign abort: keep the remaining items on the queue
// so the next generation can pick them up.
function isClosedDbError(err: unknown): boolean {
  const msg = String(err);
  return msg.includes("database connection is not open");
}

export async function drainEmbeddingQueue(
  agentId: string,
  config: BrainConfig,
  log?: Logger,
): Promise<void> {
  if (drainingAgents.has(agentId)) return; // already in progress for this agent
  const q = embeddingQueue.get(agentId);
  if (!q || q.length === 0) return;

  drainingAgents.add(agentId);
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb(agentId);
  } catch (err) {
    // Failed to even open the DB (rare — gateway shutting down, fs issue).
    // Leave the queue intact for the next call.
    drainingAgents.delete(agentId);
    log?.debug?.(
      structured({
        agentId,
        op: "drainEmbeddingQueue.open",
        outcome: "error",
        error: String(err),
      }),
    );
    return;
  }
  const BATCH = 20;
  const startMs = Date.now();
  let processed = 0;
  let failures = 0;

  try {
    while (q.length > 0) {
      // Defensive: if the DB handle was closed mid-drain (lifecycle
      // cleanup on reset/delete/disable), stop gracefully and leave the
      // queue intact for the next generation.
      if (!db.open) {
        log?.debug?.(
          structured({
            agentId,
            op: "drainEmbeddingQueue",
            outcome: "aborted",
            reason: "db_closed",
            durationMs: Date.now() - startMs,
            processed,
            failures,
            remaining: q.length,
          }),
        );
        return;
      }

      const batch = q.splice(0, BATCH);
      let i = 0;
      try {
        for (; i < batch.length; i++) {
          const nodeId = batch[i];
          const node = db.prepare("SELECT id, label, content FROM nodes WHERE id = ?").get(nodeId) as
            | { id: string; label: string; content: string }
            | null;
          if (!node) continue;

          const text = `${node.label}: ${node.content}`.slice(0, 1000);
          const vec = await fetchEmbeddingCached(text, config, log);
          if (!vec) {
            failures++;
            continue;
          }

          storeEmbedding(agentId, nodeId, vec, log);
          updatePsHash(agentId, nodeId, vec);
          const isDuplicate = checkNoveltyGate(agentId, nodeId, vec, log);
          if (!isDuplicate) {
            void autoLinkNode(agentId, nodeId, vec);
            checkReconsolidation(agentId, nodeId, vec, log);
          }
          processed++;
        }
      } catch (err) {
        // Requeue the rest of the batch so we don't lose pending items.
        for (let j = i; j < batch.length; j++) {
          if (q.length < MAX_EMBED_QUEUE) q.push(batch[j]);
        }
        // Closed-DB is benign (the OLD runtime generation got torn down
        // mid-drain by reset/delete/disable). Log debug, not warn, and
        // return — the new generation will reopen and continue. The loud
        // long-stall warning previously observed on this path
        // was fixed by the lifecycle handler.
        if (isClosedDbError(err)) {
          log?.debug?.(
            structured({
              agentId,
              op: "drainEmbeddingQueue.batch",
              outcome: "aborted",
              reason: "db_closed",
              durationMs: Date.now() - startMs,
              remaining: q.length,
            }),
          );
          return;
        }
        // T3.5 / C2.3: real failures (fetch/storage) keep the warn + rethrow
        // so caller (the sweep interval) can attribute the error.
        log?.warn(
          structured({
            agentId,
            op: "drainEmbeddingQueue.batch",
            outcome: "error",
            durationMs: Date.now() - startMs,
            error: String(err),
          }),
        );
        throw err;
      }
    }
  } finally {
    drainingAgents.delete(agentId);
    // Only remove the queue key if we drained everything — items pushed during the drain remain
    if (q.length === 0) embeddingQueue.delete(agentId);
    log?.debug?.(
      structured({
        agentId,
        op: "drainEmbeddingQueue",
        outcome: "ok",
        durationMs: Date.now() - startMs,
        processed,
        failures,
      }),
    );
  }
}

const OPENROUTER_EMBED_URL = "https://openrouter.ai/api/v1/embeddings";
const OLLAMA_BASE_URL_DEFAULT = "http://localhost:11434";
// The nodes_vec virtual table is `float[EXPECTED_VEC_DIM]` (db.ts v11 migration).
// fetchEmbedding rejects vectors of any other dimension so the operator gets a
// clean signal instead of a downstream "Dimension mismatch" SqliteError when
// storeEmbedding tries to INSERT into nodes_vec.
export const EXPECTED_VEC_DIM = 1024;

/**
 * Resolve an embedding for `text` using the model in `config.embeddingModel`.
 *
 * Provider routing (matches OLLAMA_LOCAL_INTEGRATION_PLAN / CONFIG.md §Embeddings):
 *  - Models prefixed `ollama/` → POST to the local Ollama daemon at
 *    `${OLLAMA_BASE_URL}/api/embeddings`. Free, ~5 ms, 1024-dim for qwen3-embedding:0.6b.
 *  - Everything else → POST to OpenRouter `/v1/embeddings`. Uses
 *    `config.openRouterApiKey` (or `OPENROUTER_API_KEY`).
 *
 * Returns `null` (never throws) on any failure so the caller can keep the queue
 * intact for the next pass. Returns `null` and logs a `dim_mismatch` warning if
 * the provider returns a vector whose length is not `EXPECTED_VEC_DIM` — that
 * way storeEmbedding never sees a dimension mismatch and never gets disabled
 * for the rest of the process (which was the 2026-05-16 bug).
 */
export async function fetchEmbedding(
  text: string,
  config: BrainConfig,
  log?: Logger,
  signal?: AbortSignal,
): Promise<Float32Array | null> {
  const model = config.embeddingModel ?? "";
  const isOllama = model.startsWith("ollama/");
  const startMs = Date.now();

  // Caller already gave up (e.g. proactive-monitor's 250ms budget elapsed
  // before this even started) — don't open a socket we'll immediately drop.
  if (signal?.aborted) {
    log?.debug?.(structured({ op: "fetchEmbedding", outcome: "skipped", reason: "aborted" }));
    return null;
  }

  if (isOllama) {
    return await fetchOllamaEmbedding(text, model.slice("ollama/".length), startMs, log, signal);
  }

  const apiKey = config.openRouterApiKey || process.env["OPENROUTER_API_KEY"] || "";
  if (!apiKey) {
    log?.debug?.(structured({ op: "fetchEmbedding", outcome: "skipped", reason: "no_api_key" }));
    return null;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    // Fold the caller's signal into our own controller so a caller-side abort
    // (budget elapsed) cancels the in-flight request, not just the 15s timeout.
    signal?.addEventListener("abort", () => controller.abort(), { once: true });

    // OpenRouter uses the provider-namespaced model id as the `openai/...` form.
    // We strip a leading `openrouter/` so config can use either `openrouter/openai/...` or `openai/...`.
    const openRouterModel = model.startsWith("openrouter/") ? model.slice("openrouter/".length) : model;

    const res = await fetch(OPENROUTER_EMBED_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": "https://enlightenedrepublic.tech",
        "X-Title": "Sharpwave",
      },
      body: JSON.stringify({
        model: openRouterModel,
        input: text.slice(0, 8000),
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      log?.warn(
        structured({
          op: "fetchEmbedding",
          outcome: "error",
          durationMs: Date.now() - startMs,
          status: res.status,
          model: openRouterModel,
        }),
      );
      return null;
    }

    const data = await res.json() as { data?: Array<{ embedding?: number[] }> };
    const embedding = data.data?.[0]?.embedding;
    if (!embedding) {
      log?.warn(
        structured({
          op: "fetchEmbedding",
          outcome: "error",
          durationMs: Date.now() - startMs,
          reason: "empty_response",
        }),
      );
      return null;
    }

    return finalizeEmbedding(embedding, openRouterModel, "openrouter", startMs, log);
  } catch (err) {
    log?.warn(
      structured({
        op: "fetchEmbedding",
        outcome: "error",
        durationMs: Date.now() - startMs,
        error: String(err),
      }),
    );
    return null;
  }
}

/**
 * Cached wrapper around `fetchEmbedding`. Returns the cached vector when the
 * text was seen recently; otherwise computes, stores, and bumps the miss
 * counters. Thread-safety: JS is single-threaded but the underlying fetch is
 * async, so a re-entrant caller could in principle race the populate. The
 * `cacheBusyKey` flag short-circuits the in-flight text to a direct compute
 * (rare path; only matters when two drains try to embed the same string at
 * the same moment).
 */
export async function fetchEmbeddingCached(
  text: string,
  config: BrainConfig,
  log?: Logger,
): Promise<Float32Array | null> {
  if (!text) return null;

  // Fast hit path. Move-to-end gives true LRU semantics.
  const cached = embeddingCache.get(text);
  if (cached !== undefined) {
    embeddingCache.delete(text);
    embeddingCache.set(text, cached); // move-to-end
    embeddingCacheHits++;
    bumpCounter("embeddings_cached");
    logObservabilityEvent("embedding_cache_hit", { text_preview: text.slice(0, 60) });
    return cached;
  }

  // Re-entrancy guard: if the same text is already being computed, skip
  // the cache and call the provider directly. The concurrent populate will
  // store its result, but the racing caller doesn't wait.
  const inFlight = cacheBusyKey === text;

  embeddingCacheMisses++;
  bumpCounter("embeddings_computed");
  logObservabilityEvent("embedding_cache_miss", { text_preview: text.slice(0, 60) });

  cacheBusyKey = text;
  try {
    const vec = await fetchEmbedding(text, config, log);
    if (vec !== null && !inFlight) {
      // Store under LRU eviction. delete + set gives move-to-end.
      embeddingCache.delete(text);
      embeddingCache.set(text, vec);
      while (embeddingCache.size > embeddingCacheMax) {
        const firstKey = embeddingCache.keys().next().value;
        if (firstKey === undefined) break;
        embeddingCache.delete(firstKey);
      }
    }
    return vec;
  } finally {
    if (cacheBusyKey === text) cacheBusyKey = null;
  }
}

/**
 * Local Ollama embeddings adapter. Hits the `/api/embeddings` endpoint per
 * https://github.com/ollama/ollama/blob/main/docs/api.md#generate-embeddings.
 * Response shape: `{ embedding: number[] }` (singular, NOT the OpenAI-style
 * `{ data: [{ embedding }] }`).
 */
async function fetchOllamaEmbedding(
  text: string,
  modelId: string,
  startMs: number,
  log?: Logger,
  signal?: AbortSignal,
): Promise<Float32Array | null> {
  const baseUrl = (process.env["OLLAMA_BASE_URL"] || OLLAMA_BASE_URL_DEFAULT).replace(/\/$/, "");
  const url = `${baseUrl}/api/embeddings`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    signal?.addEventListener("abort", () => controller.abort(), { once: true });
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId, prompt: text.slice(0, 8000) }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      log?.warn(
        structured({
          op: "fetchEmbedding",
          outcome: "error",
          provider: "ollama",
          durationMs: Date.now() - startMs,
          status: res.status,
          model: modelId,
        }),
      );
      return null;
    }

    const data = await res.json() as { embedding?: number[] };
    const embedding = data.embedding;
    if (!embedding || embedding.length === 0) {
      log?.warn(
        structured({
          op: "fetchEmbedding",
          outcome: "error",
          provider: "ollama",
          durationMs: Date.now() - startMs,
          reason: "empty_response",
        }),
      );
      return null;
    }

    return finalizeEmbedding(embedding, modelId, "ollama", startMs, log);
  } catch (err) {
    log?.warn(
      structured({
        op: "fetchEmbedding",
        outcome: "error",
        provider: "ollama",
        durationMs: Date.now() - startMs,
        error: String(err),
      }),
    );
    return null;
  }
}

function finalizeEmbedding(
  embedding: number[],
  model: string,
  provider: "ollama" | "openrouter",
  startMs: number,
  log?: Logger,
): Float32Array | null {
  if (embedding.length !== EXPECTED_VEC_DIM) {
    log?.warn(
      structured({
        op: "fetchEmbedding",
        outcome: "dim_mismatch",
        provider,
        model,
        receivedDim: embedding.length,
        expectedDim: EXPECTED_VEC_DIM,
        durationMs: Date.now() - startMs,
        note: "nodes_vec is float[1024]; this vector was discarded to keep vec0 healthy",
      }),
    );
    return null;
  }
  const vec = new Float32Array(embedding);
  l2Normalize(vec);
  log?.debug?.(
    structured({
      op: "fetchEmbedding",
      outcome: "ok",
      provider,
      model,
      durationMs: Date.now() - startMs,
      dim: vec.length,
    }),
  );
  return vec;
}

// Process-level flag: once a dimension mismatch is observed, stop attempting
// vec0 writes until the operator rebuilds the table. Prevents an inifinite
// stream of error logs for every node insertion after a config swap.
let vec0Disabled = false;

export function storeEmbedding(
  agentId: string,
  nodeId: string,
  vec: Float32Array,
  log?: Logger,
): void {
  const db = getDb(agentId);
  const buf = Buffer.from(vec.buffer);

  db.prepare("UPDATE nodes SET embedding = ? WHERE id = ?").run(buf, nodeId);

  if (vec0Disabled) return;

  try {
    db.prepare(
      "INSERT OR REPLACE INTO nodes_vec(rowid, embedding) SELECT rowid, ? FROM nodes WHERE id = ?"
    ).run(buf, nodeId);
  } catch (err) {
    const msg = String(err);
    // Two failure modes:
    //   1. nodes_vec missing (sqlite-vec not loaded) — silent OK, expected on
    //      sqlite-vec-windows-x64 absent
    //   2. Dimension mismatch — operator changed embedding model without DB
    //      rebuild. Log loud and disable vec0 writes for this process.
    if (msg.includes("no such table") || msg.includes("no such module")) {
      // table missing — silent expected path
      return;
    }
    if (msg.includes("dimension") || msg.includes("constraint") || msg.includes("MATCH")) {
      vec0Disabled = true;
      log?.error?.(
        structured({
          agentId,
          op: "storeEmbedding",
          outcome: "dim_mismatch",
          error: msg,
          note: "vec0 writes disabled for this process — run nodes_vec rebuild",
        }),
      );
      return;
    }
    log?.warn?.(
      structured({ agentId, op: "storeEmbedding", outcome: "error", error: msg }),
    );
  }
}

export function vectorSearchNodes(
  agentId: string,
  queryVec: Float32Array,
  limit = 10,
): BrainNode[] {
  const db = getDb(agentId);
  try {
    const buf = Buffer.from(queryVec.buffer);
    const rows = db.prepare(`
      SELECT n.*
      FROM nodes_vec v
      JOIN nodes n ON n.rowid = v.rowid
      WHERE v.embedding MATCH ? AND k = ?
        AND (n.valid_until IS NULL OR n.valid_until > ?)
      ORDER BY distance
    `).all(buf, limit, Date.now()) as BrainNode[];
    return rows;
  } catch {
    return [];
  }
}

// Fraction of emotional weight that bleeds across a new associates edge.
// 0.3 keeps propagation damped so a single high-ew node doesn't flood the graph.
const EW_PROPAGATION_RATE = 0.3;
const EW_PROPAGATION_THRESHOLD = 0.5; // |ew| must exceed this to trigger propagation

// ── PRISM: transitive associate inference ──────────────────────────────────────
// When A→B direct edge is written (sim > 0.75), check B's existing associates.
// For each neighbor X of B where sim(A, X) ∈ (PRISM_SIM_LOW, 0.75):
//   - too weak to have triggered autoLink directly, but meaningfully related
//   - write a low-weight provisional associates edge A→X with weight = sim * factor
//
// Superbrain advantage: humans do transitive inference implicitly and can't
// track confidence. We CAN — PRISM edges carry a lower weight (0.18–0.30)
// vs direct edges (0.75–1.0), encoding explicit inference confidence.
// Spreading activation naturally de-weights these versus direct associations.
const PRISM_SIM_LOW = 0.45;            // below this is noise — no inferred edge
const PRISM_INFERRED_WEIGHT_FACTOR = 0.4; // inferred weight = sim × factor
const PRISM_MAX_INFERRED = 5;          // cap inferred edges per autoLinkNode call

export async function autoLinkNode(
  agentId: string,
  nodeId: string,
  vec: Float32Array,
): Promise<void> {
  const db = getDb(agentId);
  const similar = vectorSearchNodes(agentId, vec, 6);

  // Fetch source node's emotional_weight once for propagation check
  const srcRow = db.prepare("SELECT emotional_weight FROM nodes WHERE id = ?").get(nodeId) as { emotional_weight: number } | undefined;
  const srcEw = srcRow?.emotional_weight ?? 0;

  let prismCount = 0;

  for (const other of similar) {
    if (other.id === nodeId) continue;
    if (!other.embedding) continue;

    const otherVec = bufferToFloat32(other.embedding);
    const sim = cosineSimilarity(vec, otherVec);

    // cosine sim > 0.75 (L2-normalized vectors, this means very close semantically)
    // Edge type "associates" matches awake_replay.ts:159-160 (Hebbian co-activation).
    // Originally hand-patched in deployed dist on 2026-05-18 to align the two write
    // sites on a single edge type. Ported into source 2026-05-19 to survive rebuilds.
    if (sim > 0.75 && !edgeExists(agentId, nodeId, other.id, "associates")) {
      writeEdge(agentId, nodeId, other.id, "associates", { weight: sim });

      // Emotional weight propagation: when a high-affect node gains a new associate,
      // bleed a fraction of that affect onto the neighbor. Mirrors how the amygdala
      // modulates hippocampal encoding of contextually related memories.
      // Propagation is one-hop only and damped by EW_PROPAGATION_RATE.
      const tgtEw = other.emotional_weight ?? 0;
      const srcAbs = Math.abs(srcEw);
      const tgtAbs = Math.abs(tgtEw);
      const now = Date.now();

      if (srcAbs > EW_PROPAGATION_THRESHOLD && srcAbs > tgtAbs) {
        // Source has stronger affect — nudge target toward it
        const newTgtEw = Math.max(-1, Math.min(1, tgtEw + EW_PROPAGATION_RATE * (srcEw - tgtEw)));
        db.prepare("UPDATE nodes SET emotional_weight = ?, updated_at = ? WHERE id = ?")
          .run(newTgtEw, now, other.id);
      } else if (tgtAbs > EW_PROPAGATION_THRESHOLD && tgtAbs > srcAbs) {
        // Target has stronger affect — nudge source toward it
        const newSrcEw = Math.max(-1, Math.min(1, srcEw + EW_PROPAGATION_RATE * (tgtEw - srcEw)));
        db.prepare("UPDATE nodes SET emotional_weight = ?, updated_at = ? WHERE id = ?")
          .run(newSrcEw, now, nodeId);
      }

      // PRISM: transitive associate inference via bridge node `other`.
      // Bridge other→nodeId is just now established (sim > 0.75). Walk other's
      // existing neighbors to find second-degree connections to nodeId that are
      // below the autoLink threshold but above noise — provisional weak edges.
      if (prismCount < PRISM_MAX_INFERRED) {
        const bridgeNeighbors = db.prepare(`
          SELECT n.id, n.embedding FROM nodes n
          JOIN edges e ON n.id = e.to_id
          WHERE e.from_id = ? AND e.valid_until IS NULL
            AND e.type = 'associates' AND n.id != ?
          LIMIT 10
        `).all(other.id, nodeId) as { id: string; embedding: Buffer | null }[];

        for (const neighbor of bridgeNeighbors) {
          if (prismCount >= PRISM_MAX_INFERRED) break;
          if (!neighbor.embedding) continue;
          if (edgeExists(agentId, nodeId, neighbor.id, "associates")) continue;

          const neighborVec = bufferToFloat32(neighbor.embedding as Buffer);
          const simInferred = cosineSimilarity(vec, neighborVec);

          if (simInferred > PRISM_SIM_LOW && simInferred < 0.75) {
            writeEdge(agentId, nodeId, neighbor.id, "associates", {
              weight: simInferred * PRISM_INFERRED_WEIGHT_FACTOR,
            });
            prismCount++;
          }
        }
      }
    }
  }

  // NEXUS instance_of wiring: after all direct + PRISM edges are written,
  // check existing schema nodes. A new node sim > 0.70 to a schema node
  // gets an instance_of edge — it's a member of that schema's cluster.
  // This ensures nodes written between NEXUS runs still join the right category.
  const schemaRows = db.prepare(
    "SELECT id, embedding FROM nodes WHERE type = 'schema' AND embedding IS NOT NULL LIMIT 20"
  ).all() as { id: string; embedding: Buffer }[];

  for (const sn of schemaRows) {
    const snVec = bufferToFloat32(sn.embedding as Buffer);
    const sim = cosineSimilarity(vec, snVec);
    if (sim > 0.70 && !edgeExists(agentId, nodeId, sn.id, "instance_of")) {
      writeEdge(agentId, nodeId, sn.id, "instance_of", { weight: sim });
    }
  }
}

// ── Reconsolidation trigger ────────────────────────────────────────────────────
// ZenBrain-inspired prediction-error gating: when a new semantic/episodic/pattern
// node is highly similar (>0.85 cosine) to an existing *stable* node, it signals
// that the old memory may be outdated. The old trace is destabilized:
//  - `supersedes` edge marks the new trace as the current version
//  - retrievability decayed by 0.85× (partial forgetting, not erasure)
//  - is_consolidated reset to 0 (kicked back to hippocampal fast-store)
// Threshold 0.85 is above the `associates` threshold (0.75) to avoid false
// reconsolidations on merely-related content.
function checkReconsolidation(
  agentId: string,
  nodeId: string,
  vec: Float32Array,
  log?: Logger,
): void {
  const db = getDb(agentId);
  const newNode = db.prepare(
    "SELECT type FROM nodes WHERE id = ?",
  ).get(nodeId) as { type: string } | null;
  if (!newNode || !["semantic", "episodic", "pattern"].includes(newNode.type)) return;

  const similar = vectorSearchNodes(agentId, vec, 8);
  let reconsolidated = 0;

  for (const other of similar) {
    if (other.id === nodeId) continue;
    if (!other.embedding) continue;
    if (!["semantic", "episodic", "pattern"].includes(other.type)) continue;

    const otherVec = bufferToFloat32(other.embedding);
    const sim = cosineSimilarity(vec, otherVec);
    if (sim <= 0.85) continue;

    // Only reconsolidate memories that have had time to stabilize — avoids
    // false alarms between two newly-written nodes covering the same event.
    if (other.stability <= 7 && other.is_consolidated === 0) continue;

    if (edgeExists(agentId, nodeId, other.id, "supersedes")) continue;

    writeEdge(agentId, nodeId, other.id, "supersedes", { weight: sim });

    const decayedRetrievability = Math.max(0.05, other.retrievability * 0.85);
    const now = Date.now();
    db.prepare(
      "UPDATE nodes SET retrievability = ?, is_consolidated = 0, valid_until = ?, updated_at = ? WHERE id = ?",
    ).run(decayedRetrievability, now, now, other.id);

    reconsolidated++;
    log?.info(
      structured({
        agentId,
        op: "reconsolidation",
        newNodeId: nodeId,
        oldNodeId: other.id,
        similarity: Math.round(sim * 1000) / 1000,
        oldStability: Math.round(other.stability * 10) / 10,
        decayedRetrievability: Math.round(decayedRetrievability * 1000) / 1000,
      }),
    );
  }
}

// ── Write-time novelty gate ────────────────────────────────────────────────────
// SAGE-inspired: after computing a node's embedding, check if a near-identical
// node already exists (cosine sim > 0.92). At that range the two nodes cover
// identical factual content — differing only in phrasing. The EXISTING node is
// canonical (it already has edges and review history); the new one is retired.
//
// Threshold ladder:
//   > 0.90 → near-duplicate: old wins (novelty gate, returns true)
//   0.85–0.90 → update signal: new supersedes old (reconsolidation)
//   0.75–0.85 → related: bidirectional `associates` edge (autoLinkNode)
//
// Applied to semantic/pattern only — episodic nodes are time-stamped experiences
// that are intentionally unique; identity/skill/goal/schema accumulate by design.
function checkNoveltyGate(
  agentId: string,
  nodeId: string,
  vec: Float32Array,
  log?: Logger,
): boolean {
  const db = getDb(agentId);
  const newNode = db.prepare(
    "SELECT type, importance FROM nodes WHERE id = ?",
  ).get(nodeId) as { type: string; importance: number } | null;
  if (!newNode || !["semantic", "pattern"].includes(newNode.type)) return false;

  const similar = vectorSearchNodes(agentId, vec, 6);

  for (const other of similar) {
    if (other.id === nodeId) continue;
    if (!other.embedding) continue;
    if (!["semantic", "pattern"].includes(other.type)) continue;

    const otherVec = bufferToFloat32(other.embedding);
    const sim = cosineSimilarity(vec, otherVec);
    if (sim <= 0.90) continue;

    // Near-duplicate: merge importance into canonical node, retire the new one
    const mergedImportance = Math.max(newNode.importance, other.importance);
    const now = Date.now();

    db.prepare(
      "UPDATE nodes SET importance = ?, access_count = access_count + 1, updated_at = ? WHERE id = ?",
    ).run(mergedImportance, now, other.id);

    db.prepare(
      "UPDATE nodes SET valid_until = ?, updated_at = ? WHERE id = ?",
    ).run(now, now, nodeId);

    if (!edgeExists(agentId, nodeId, other.id, "coreference_of")) {
      writeEdge(agentId, nodeId, other.id, "coreference_of", { weight: sim });
    }

    log?.info(
      structured({
        agentId,
        op: "novelty_gate",
        newNodeId: nodeId,
        canonicalId: other.id,
        similarity: Math.round(sim * 1000) / 1000,
        mergedImportance: Math.round(mergedImportance * 1000) / 1000,
      }),
    );

    return true;
  }

  return false;
}

export function rrfFuse(
  lists: BrainNode[][],
  k = 60,
): BrainNode[] {
  const scores = new Map<string, number>();
  const nodeMap = new Map<string, BrainNode>();

  for (const list of lists) {
    list.forEach((node, rank) => {
      scores.set(node.id, (scores.get(node.id) ?? 0) + 1 / (k + rank + 1));
      nodeMap.set(node.id, node);
    });
  }

  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => nodeMap.get(id)!);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  return mag > 0 ? dot / mag : 0;
}

export function bufferToFloat32(buf: Buffer): Float32Array {
  // Copy via Uint8Array to handle non-4-byte aligned buffers safely (Code-2 P2-2).
  const copy = new Uint8Array(buf.byteLength);
  copy.set(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  return new Float32Array(copy.buffer);
}

function l2Normalize(vec: Float32Array): void {
  let sum = 0;
  for (let i = 0; i < vec.length; i++) sum += vec[i] * vec[i];
  const mag = Math.sqrt(sum);
  if (mag > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] /= mag;
  }
}

// ── Structured logging helper ───────────────────────────────────────────────────
//
// All plugin operation log lines use these consistent fields so observability
// is uniform across the codebase (Tier 3 T3.8).
type StructuredFields = Record<string, string | number | boolean | undefined>;
function structured(fields: StructuredFields): string {
  const filtered: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) filtered[k] = v;
  }
  return `[sharpwave] ${JSON.stringify(filtered)}`;
}
