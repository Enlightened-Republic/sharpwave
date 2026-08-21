/**
 * Entity resolution — character-trigram MinHash for near-duplicate detection.
 *
 * Ported from ClawBrain v0.4.0 audit (item #4). The previous TS stub
 * returned 0 unconditionally because entity resolution was treated as a
 * host-agent concern. Now we provide a self-contained implementation that:
 *
 *   1. Builds character trigram shingle sets from normalized text.
 *   2. Computes Jaccard similarity between two shingle sets directly
 *      (no external MinHash library — datasketch is Python-only).
 *   3. Provides a fast `findNearDuplicates()` that walks embedding cosine
 *      similarity first, then falls back to character-trigram Jaccard.
 *   4. Provides `deduplicateExisting()` that groups memories by Jaccard
 *      similarity ≥ threshold using union-find.
 *
 * The pure-JS MinHash is intentional: datasketch is Python-only, and the TS
 * codebase is supposed to stay dependency-free beyond `better-sqlite3` +
 * `sqlite-vec`. Character trigrams are a faithful approximation of MinHash
 * for short memory content — for our scale (thousands of nodes, not
 * millions), direct Jaccard over trigram sets is fast enough and avoids
 * the implementation complexity of full MinHash signatures.
 *
 * Public surface:
 *   - findNearDuplicates(agentId, content, embedding?, threshold): List of (id, score)
 *   - deduplicateExisting(agentId, threshold): List of duplicate groups
 *   - mergeCoreferentNodes(agentId, log): existing entry point, now functional
 */

import { getDb } from "./db.js";
import { edgeExists, writeEdge } from "./edges.js";
import { bufferToFloat32, cosineSimilarity } from "./embeddings.js";
import { bumpCounter, logObservabilityEvent } from "./observability.js";
import type { BrainNode } from "./types.js";

type Logger = { info: (msg: string) => void; warn: (msg: string) => void };

const DEFAULT_TRIGRAM_THRESHOLD = 0.7;
const TRIGRAM_SIZE = 3;
const MAX_CANDIDATE_SCAN = 200;

// ── Character trigram shingling ───────────────────────────────────────────────

/**
 * Normalize text for shingling: lowercase, strip non-alphanumeric, collapse
 * whitespace. This makes "Hailey's dog" and "Haileys dog" produce the same
 * trigrams, which is what we want for near-duplicate detection.
 */
function normalizeForDedup(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Character n-gram shingle set. For text shorter than `n`, return the whole
 * normalized text as a single "shingle" so short facts still produce a
 * stable signature (matches the Python reference behavior).
 */
function shingleText(text: string, n = TRIGRAM_SIZE): Set<string> {
  if (!text) return new Set();
  const normalized = normalizeForDedup(text);
  if (!normalized) return new Set();
  if (normalized.length < n) return new Set([normalized]);
  const shingles = new Set<string>();
  for (let i = 0; i <= normalized.length - n; i++) {
    shingles.add(normalized.slice(i, i + n));
  }
  return shingles;
}

/**
 * Pure-JS Jaccard similarity over character trigram sets.
 * Returns 0.0 when either side is empty.
 */
export function jaccardShingles(textA: string, textB: string): number {
  const setA = shingleText(textA);
  const setB = shingleText(textB);
  if (setA.size === 0 || setB.size === 0) return 0.0;
  let intersection = 0;
  // Iterate the smaller set for speed.
  const [smaller, larger] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  for (const s of smaller) {
    if (larger.has(s)) intersection++;
  }
  const unionSize = setA.size + setB.size - intersection;
  return unionSize === 0 ? 0.0 : intersection / unionSize;
}

// ── Near-duplicate detection ─────────────────────────────────────────────────

export interface DuplicateCandidate {
  id: string;
  similarity: number;
  reason: "embedding_cosine" | "minhash_jaccard";
}

/**
 * Find near-duplicate nodes for `content` within an agent's memory store.
 *
 * Strategies, in order:
 *   1. Embedding cosine similarity (fast path when `embedding` is supplied)
 *   2. Character trigram Jaccard over the candidate text (always available)
 *
 * Returns a list of `(id, similarity)` pairs at or above `threshold`, sorted
 * by descending score. Capped at MAX_CANDIDATE_SCAN rows to bound the scan.
 */
export function findNearDuplicates(
  agentId: string,
  content: string,
  embedding: Float32Array | null = null,
  threshold: number = DEFAULT_TRIGRAM_THRESHOLD,
  typeFilter: string | null = null,
): DuplicateCandidate[] {
  if (!content) return [];

  const db = getDb(agentId);
  const now = Date.now();

  // Pull a bounded candidate set: most-recent, not expired, optionally type-scoped.
  const rows = (() => {
    if (typeFilter) {
      return db.prepare(`
        SELECT id, content, embedding FROM nodes
        WHERE type = ? AND (valid_until IS NULL OR valid_until > ?)
        ORDER BY created_at DESC LIMIT ?
      `).all(typeFilter, now, MAX_CANDIDATE_SCAN) as Array<{ id: string; content: string; embedding: Buffer | null }>;
    }
    return db.prepare(`
      SELECT id, content, embedding FROM nodes
      WHERE (valid_until IS NULL OR valid_until > ?)
      ORDER BY created_at DESC LIMIT ?
    `).all(now, MAX_CANDIDATE_SCAN) as Array<{ id: string; content: string; embedding: Buffer | null }>;
  })();

  const results: DuplicateCandidate[] = [];
  for (const row of rows) {
    let best = 0;
    let reason: DuplicateCandidate["reason"] = "minhash_jaccard";

    // Strategy 1: embedding cosine
    if (embedding && row.embedding) {
      try {
        const otherVec = bufferToFloat32(row.embedding);
        const sim = cosineSimilarity(embedding, otherVec);
        if (sim > best) {
          best = sim;
          reason = "embedding_cosine";
        }
      } catch { /* fall through to Jaccard */ }
    }

    // Strategy 2: trigram Jaccard (always runs unless cosine already won big)
    const j = jaccardShingles(content, row.content);
    if (j > best) {
      best = j;
      reason = "minhash_jaccard";
    }

    if (best >= threshold) {
      results.push({ id: row.id, similarity: best, reason });
    }
  }

  results.sort((a, b) => b.similarity - a.similarity);
  return results;
}

// ── Group-level deduplication ─────────────────────────────────────────────────

/**
 * Scan stored nodes and group near-duplicates by Jaccard similarity ≥ threshold.
 *
 * Uses union-find over pairwise comparisons. Memories without a near-duplicate
 * are not returned in any group. Intended as an offline tool (call from
 * maintenance or a one-shot script), not on the hot path.
 */
export function deduplicateExisting(
  agentId: string,
  threshold: number = 0.8,
): string[][] {
  const db = getDb(agentId);
  const now = Date.now();
  const rows = db.prepare(`
    SELECT id, content FROM nodes
    WHERE (valid_until IS NULL OR valid_until > ?)
    ORDER BY created_at DESC LIMIT ?
  `).all(now, 1000) as Array<{ id: string; content: string }>;

  if (rows.length < 2) return [];

  // Pre-compute shingle sets so the inner loop is set-vs-set, not text-vs-text.
  const shingles = new Map<string, Set<string>>();
  for (const r of rows) shingles.set(r.id, shingleText(r.content));

  const parent = new Map<string, string>();
  for (const r of rows) parent.set(r.id, r.id);

  const find = (x: string): string => {
    let cur = x;
    while (parent.get(cur) !== cur) {
      const p = parent.get(cur)!;
      parent.set(cur, parent.get(p)!); // path compression
      cur = parent.get(cur)!;
    }
    return cur;
  };

  const union = (a: string, b: string): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  // Pairwise Jaccard. O(n²) but n is bounded by the LIMIT.
  for (let i = 0; i < rows.length; i++) {
    const a = rows[i];
    const sa = shingles.get(a.id)!;
    if (sa.size === 0) continue;
    for (let j = i + 1; j < rows.length; j++) {
      const b = rows[j];
      const sb = shingles.get(b.id)!;
      if (sb.size === 0) continue;
      let intersection = 0;
      // Iterate smaller set for speed.
      const [smaller, larger] = sa.size <= sb.size ? [sa, sb] : [sb, sa];
      for (const s of smaller) if (larger.has(s)) intersection++;
      const unionSize = sa.size + sb.size - intersection;
      if (unionSize === 0) continue;
      if (intersection / unionSize >= threshold) union(a.id, b.id);
    }
  }

  const groups = new Map<string, string[]>();
  for (const r of rows) {
    const root = find(r.id);
    const g = groups.get(root) ?? [];
    g.push(r.id);
    groups.set(root, g);
  }

  return Array.from(groups.values()).filter((g) => g.length > 1);
}

// ── Coreference merge ────────────────────────────────────────────────────────

/**
 * Walk the agent's nodes, find groups of near-duplicates above threshold,
 * wire `coreference_of` edges from each duplicate to the canonical (oldest)
 * member, and bump the `memories_merged` counter.
 *
 * Returns the number of merges performed. Idempotent — already-merged
 * groups are skipped via the edge check.
 */
export function mergeCoreferentNodes(agentId: string, log: Logger): number {
  const groups = deduplicateExisting(agentId, 0.8);
  const db = getDb(agentId);
  let merged = 0;

  for (const group of groups) {
    if (group.length < 2) continue;

    // Canonical = oldest (smallest created_at). Fetched once to get timestamps.
    const rows = db.prepare(`
      SELECT id, created_at FROM nodes WHERE id IN (${group.map(() => "?").join(",")})
    `).all(...group) as Array<{ id: string; created_at: number }>;
    if (rows.length < 2) continue;

    rows.sort((a, b) => a.created_at - b.created_at);
    const canonical = rows[0].id;
    const duplicates = rows.slice(1).map((r) => r.id);

    for (const dupId of duplicates) {
      if (edgeExists(agentId, dupId, canonical, "coreference_of")) continue;
      writeEdge(agentId, dupId, canonical, "coreference_of", { weight: 0.9 });
      merged++;
      log.info(`[sharpwave] coreference merge: ${dupId.slice(0, 8)} -> canonical ${canonical.slice(0, 8)}`);
    }
  }

  if (merged > 0) {
    bumpCounter("memories_merged", merged);
    logObservabilityEvent("merge", { agentId, merged });
  }

  return merged;
}
