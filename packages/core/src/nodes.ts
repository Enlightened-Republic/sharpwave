import { randomUUID } from "node:crypto";
import { getDb, bumpWriteCounter } from "./db.js";
import { executeWithWalRetrySync } from "./wal-retry.js";
import { bumpCounter, logObservabilityEvent } from "./observability.js";
import { findNearDuplicates } from "./entity-resolution.js";
import type { BrainNode, BrainConfig, NodeType, NeuromodState } from "./types.js";

const HALF_LIFE_DAYS: Record<string, number> = {
  identity:    180,
  skill:       120,
  pattern:      90,
  semantic:     60,
  goal:         30,
  episodic:     14,
  emotion:       7,
  procedural:   90,
  schema:      180,
};

// ── FSRS-6 forgetting model ────────────────────────────────────────────────────
// Difficulty / Stability / Retrievability model, default in Anki since 2024.
// Replaces SM-2's unbounded multiplicative growth (code-1 Fix #1) with a
// power-law forgetting curve and bounded stability updates that have been
// empirically tuned on 20M+ Anki reviews.
//
// Reference: https://github.com/open-spaced-repetition/fsrs.js and
// https://expertium.github.io/Algorithm.html
//
// The 17 parameters below are the published FSRS-6 default weight set. They
// were trained on Anki review-history data; we treat them as constants here
// (future tuning is out of scope per SCHEMA_CONTRACT.md). The values match
// the reference implementation's default initializer.
const FSRS6_W: readonly number[] = [
  0.40255, 1.18385, 3.173, 15.69105,    // initial stability per quality 1..4
  7.1949, 0.5345, 1.4604, 0.0046,       // difficulty initial / update
  1.54575, 0.1192, 1.01925,             // stability success update
  1.9395, 0.11, 0.29605, 2.2698,        // stability failure / general
  0.2315, 2.9898,                       // post-lapse, short-term
];
const FSRS6_REQUEST_R = 0.9;             // target retention used by stability update
const FSRS6_DECAY = -0.5;                // R(t,S) = (1 + (t/S)·F) ^ DECAY
const FSRS6_FACTOR = 19 / 81;            // F constant — derives from DECAY so that R(S, S) = 0.9
const STABILITY_CAP_DAYS = 365.0;        // matches awake_replay.ts cap

/**
 * FSRS retrievability: probability the item is still recallable t days after
 * the last review, given stability S. Power-law form replaces SM-2's
 * exp(-t/S), which overestimates short-term and underestimates long-term
 * forgetting (per Wozniak's 2023 update to the SuperMemo spec).
 *
 *     R(t, S) = (1 + (19/81) · (t / S)) ^ -0.5
 */
export function fsrsRetrievability(elapsedDays: number, stability: number): number {
  if (elapsedDays <= 0) return 1.0;
  const s = Math.max(stability, 0.1);
  return Math.pow(1 + FSRS6_FACTOR * (elapsedDays / s), FSRS6_DECAY);
}

/**
 * Public helper: retrievability of a node at time `now`. If the node has never
 * been reviewed (`last_review == null`), fall back to `accessed_at` — for
 * agents migrated from SM-2 this preserves the original encoding date as the
 * decay anchor until the first FSRS review fires.
 */
export function getRetrievability(node: BrainNode, now: number = Date.now()): number {
  const anchorMs = node.last_review ?? node.accessed_at;
  const elapsedDays = Math.max(0, (now - anchorMs) / 86400000);
  return fsrsRetrievability(elapsedDays, node.stability);
}

/**
 * FSRS-6 difficulty update. Difficulty drifts toward the response quality with
 * a regression-to-mean term so high-difficulty items recover slowly on success
 * but jump back up on failure. Clamped to [1, 10].
 *
 * Quality is FSRS rating: 1=again, 2=hard, 3=good, 4=easy.
 */
function fsrsUpdateDifficulty(oldDifficulty: number, quality: number): number {
  const w = FSRS6_W;
  // Delta per quality: 3 (good) holds steady, 4 (easy) reduces, 2 (hard) raises, 1 (again) raises hardest.
  const deltaD = -w[6] * (quality - 3);
  const newD = oldDifficulty + deltaD * (10 - oldDifficulty) / 9;
  // Regression toward initial difficulty for the easy-rating baseline (FSRS-6 §6).
  const D0 = w[4] - Math.exp(w[5] * (4 - 1)) + 1;
  const meanReversion = w[7] * (D0 - newD);
  return Math.max(1, Math.min(10, newD + meanReversion));
}

/**
 * FSRS-6 stability update for a successful review (quality >= 3 = good/easy).
 * Captures the "spacing effect": the harder the item was, the lower the current
 * retrievability, the larger the stability gain — modulated by FSRS weights w[8]..w[10].
 */
function fsrsSuccessStability(
  oldStability: number, difficulty: number, retrievability: number, quality: number,
): number {
  const w = FSRS6_W;
  const hardPenalty   = quality === 2 ? w[15] : 1;       // hard responses get smaller stability gain
  const easyBonus     = quality === 4 ? w[16] : 1;       // easy responses get a bonus
  const factor = Math.exp(w[8])
    * (11 - difficulty)
    * Math.pow(oldStability, -w[9])
    * (Math.exp(w[10] * (1 - retrievability)) - 1)
    * hardPenalty * easyBonus;
  return Math.min(STABILITY_CAP_DAYS, oldStability * (1 + factor));
}

/**
 * FSRS-6 stability update for a lapse (quality < 3 = again). Stability drops
 * sharply but not to zero — captures partial memory survival across forgetting.
 */
function fsrsFailureStability(
  oldStability: number, difficulty: number, retrievability: number,
): number {
  const w = FSRS6_W;
  const newS = w[11]
    * Math.pow(difficulty, -w[12])
    * (Math.pow(oldStability + 1, w[13]) - 1)
    * Math.exp(w[14] * (1 - retrievability));
  return Math.max(0.1, Math.min(STABILITY_CAP_DAYS, newS));
}

/**
 * FSRS-6 initial stability for a node's first review. Indexed by quality 1..4.
 */
function fsrsInitialStability(quality: number): number {
  const w = FSRS6_W;
  const q = Math.max(1, Math.min(4, Math.round(quality))) - 1;
  return Math.max(0.1, Math.min(STABILITY_CAP_DAYS, w[q]));
}

/**
 * Map a 0..5 SM-2 quality grade to a 1..4 FSRS quality rating. SM-2 q=0..2 are
 * lapses; FSRS treats them all as "again" (=1). SM-2 q=3,4,5 map to
 * hard/good/easy in FSRS.
 */
function toFsrsQuality(q: number): number {
  if (q <= 2) return 1;
  if (q === 3) return 2;
  if (q === 4) return 3;
  return 4;
}

// ── SIGMA per-node FSRS calibration (v16) ─────────────────────────────────────
// Each successful review records {t, g, r, s, d} in review_history. After
// SIGMA_MIN_PAIRS consecutive successful pairs, we fit a per-node multiplier by
// taking the median of (actual_s_after / fsrs_predicted_s). The median is robust
// to outliers (single anomalous review doesn't corrupt calibration).
//
// Superbrain angle: human memory has population-average forgetting curves. We have
// per-concept curves — a technical skill Marley uses daily consolidates 2× faster
// than FSRS-6 predicts; an infrequently-touched fact consolidates slower. Sigma
// captures that personal deviation and adjusts future scheduling automatically.

interface ReviewEntry {
  t: number; // elapsed days before review
  g: number; // FSRS quality (1–4)
  r: number; // retrievability before review
  s: number; // stability before review
  d: number; // difficulty before review
}

const SIGMA_MIN_PAIRS = 3;  // minimum successful (i,i+1) pairs before sigma departs from 1.0
const SIGMA_CLAMP_LOW  = 0.5;
const SIGMA_CLAMP_HIGH = 2.5;
const SIGMA_HISTORY_MAX = 50; // cap stored entries to prevent unbounded growth

function computeStabilitySigma(history: ReviewEntry[]): number {
  const ratios: number[] = [];
  for (let i = 0; i < history.length - 1; i++) {
    const cur = history[i];
    const next = history[i + 1];
    if (cur.g < 2) continue; // skip lapse pairs — failure stability uses a different formula
    const predicted = fsrsSuccessStability(cur.s, cur.d, cur.r, cur.g);
    if (predicted < 0.1) continue;
    ratios.push(next.s / predicted);
  }
  if (ratios.length < SIGMA_MIN_PAIRS) return 1.0;
  ratios.sort((a, b) => a - b);
  const median = ratios[Math.floor(ratios.length / 2)];
  return Math.max(SIGMA_CLAMP_LOW, Math.min(SIGMA_CLAMP_HIGH, median));
}

// ── Pattern separation hash (v14) ──────────────────────────────────────────────
// Top-K sparse projection of the embedding — packed into a 4-byte uint32 blob.
// Inspired by DG-style sparse coding (Bakker et al. 2008): similar embeddings
// share more of the same top-K dimensions, dissimilar embeddings share fewer.
// Hamming distance over the packed bits is then a fast pre-filter before
// falling through to full cosine similarity in entity-resolution.

const PS_HASH_K = 32; // top-K dimensions selected; matches uint32 bit width

/**
 * Compute a 32-bit pattern-separation hash from an embedding. The K largest
 * |components| set their corresponding bit (using `index mod 32`) to 1; the
 * rest stay 0. Returned as a 4-byte little-endian buffer suitable for SQLite BLOB.
 *
 * Hamming distance is then `popcount(a XOR b)` ∈ [0..32]. Below a threshold,
 * we consider two embeddings "in the same neighborhood" and worth comparing.
 */
export function computePsHash(embedding: Float32Array): Buffer {
  if (embedding.length === 0) return Buffer.alloc(4);
  const k = Math.min(PS_HASH_K, embedding.length);

  // Build an index list of the top-K |components| using a partial selection.
  // For typical 768-dim embeddings this is O(n·k) which is fine.
  const indices: number[] = Array.from({ length: embedding.length }, (_, i) => i);
  indices.sort((a, b) => Math.abs(embedding[b]) - Math.abs(embedding[a]));

  let bits = 0 >>> 0; // unsigned 32-bit
  for (let i = 0; i < k; i++) {
    const idx = indices[i] >>> 0;
    const bit = idx % 32;
    bits |= (1 << bit) >>> 0;
  }

  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(bits >>> 0, 0);
  return buf;
}

/**
 * Hamming distance between two 32-bit pattern-separation hashes. Returns
 * a value in [0, 32]; 0 means identical sparse pattern, 32 means complete
 * disagreement on which dimensions are top-K.
 */
export function psHashHamming(a: Buffer | null, b: Buffer | null): number {
  if (!a || !b || a.length < 4 || b.length < 4) return 32; // missing data = max distance
  const av = a.readUInt32LE(0) >>> 0;
  const bv = b.readUInt32LE(0) >>> 0;
  let x = (av ^ bv) >>> 0;
  // SWAR popcount on uint32
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >>> 24;
}

/**
 * Recompute and persist a node's ps_hash from its embedding. Idempotent; safe
 * to call after every embedding write. Called by embeddings.ts after each
 * `storeEmbedding`.
 */
export function updatePsHash(agentId: string, nodeId: string, embedding: Float32Array): void {
  const db = getDb(agentId);
  const hash = computePsHash(embedding);
  db.prepare("UPDATE nodes SET ps_hash = ? WHERE id = ?").run(hash, nodeId);
}

export function computeSalience(
  importance: number,
  emotional_weight: number,
  retrievability: number,
  eligibility_trace: number,
  ripple_count: number,
): number {
  return (
    0.4 * importance +
    0.2 * Math.abs(emotional_weight) +
    0.2 * retrievability +
    0.1 * Math.min(eligibility_trace, 1.0) +
    0.1 * Math.min(ripple_count / 10, 1.0)
  );
}

export function writeNode(
  agentId: string,
  type: NodeType,
  label: string,
  content: string,
  opts: {
    importance?: number;
    emotional_weight?: number;
    source?: string;
    episode_ids?: string[];
    encodingContext?: NeuromodState;
    extractionConfidence?: number;
    /** When true, run the trigram-Jaccard near-duplicate check before
     *  inserting. If a duplicate is found above threshold, return the
     *  canonical node's id instead of creating a new row. Defaults to true. */
    deduplicate?: boolean;
    /** Jaccard threshold for `deduplicate`. Default 0.85 (matches the Python
     *  reference's near-duplicate gate). */
    dedupeThreshold?: number;
  } = {},
): string {
  const db = getDb(agentId);
  const id = randomUUID();
  const now = Date.now();
  const importance = opts.importance ?? 0.5;
  const halfLife = HALF_LIFE_DAYS[type] ?? 30;
  const emotionalWeight = opts.emotional_weight ?? 0;
  // Cahill & McGaugh 1998: emotional arousal prolongs memory stability.
  // |emotional_weight| on [0,1] → up to 1.5× initial stability.
  const stability = halfLife * importance * (1 + Math.abs(emotionalWeight) * 0.5);
  const salience = computeSalience(importance, emotionalWeight, 1.0, 0, 0);

  // Pre-write near-duplicate gate (item #4 / feature parity with Python
  // `_find_near_duplicates`). Skipped when caller passes `deduplicate: false`
  // so the embedding pipeline (which deliberately wants fresh rows even if
  // their text matches a stored node) can opt out.
  const dedupe = opts.deduplicate ?? true;
  if (dedupe && content) {
    const threshold = opts.dedupeThreshold ?? 0.85;
    try {
      const dups = findNearDuplicates(agentId, content, null, threshold, type);
      if (dups.length > 0) {
        const canonical = dups[0].id;
        // Bump importance on the canonical row instead of inserting a duplicate.
        executeWithWalRetrySync(
          db,
          (d) => {
            d.prepare(`
              UPDATE nodes
              SET importance = MAX(importance, ?),
                  access_count = access_count + 1,
                  updated_at = ?
              WHERE id = ?
            `).run(importance, Date.now(), canonical);
          },
          { op: `nodes.dedupeMerge:${canonical.slice(0, 8)}` },
        );
        bumpWriteCounter(db);
        bumpCounter("memories_merged");
        logObservabilityEvent("merge", {
          agentId,
          canonical,
          mergedId: id,
          similarity: Math.round(dups[0].similarity * 1000) / 1000,
          reason: dups[0].reason,
        });
        return canonical;
      }
    } catch {
      // Never block a write on the dedupe path — fall through to insert.
    }
  }

  executeWithWalRetrySync(
    db,
    (d) => {
      d.prepare(`
        INSERT INTO nodes
          (id, type, label, content, importance, salience, stability, retrievability, ef,
           access_count, emotional_weight, episode_ids, source, embedding,
           encoding_context, extraction_confidence, ripple_count, eligibility_trace,
           created_at, accessed_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1.0, 2.5,
                0, ?, ?, ?, NULL,
                ?, ?, 0, 0.0,
                ?, ?, ?)
      `).run(
        id, type, label, content, importance, salience, stability,
        emotionalWeight,
        opts.episode_ids ? JSON.stringify(opts.episode_ids) : null,
        opts.source ?? null,
        opts.encodingContext ? JSON.stringify(opts.encodingContext) : null,
        opts.extractionConfidence ?? 1.0,
        now, now, now,
      );
    },
    { op: `nodes.write:${type}` },
  );
  bumpWriteCounter(db);
  bumpCounter("memories_stored");
  logObservabilityEvent("remember", {
    nodeId: id,
    type,
    importance: Math.round(importance * 1000) / 1000,
  });

  return id;
}

/**
 * Update a node's FSRS-6 state after a review. Quality is on the SM-2 0..5 scale
 * for backcompat with existing call sites; internally remapped to FSRS 1..4.
 *
 * Replaces the original SM-2 implementation (code-1 Fix #1 / SYNTHESIS T1.1).
 * The old code grew `stability` multiplicatively without an upper bound, which
 * made high-EF nodes effectively unforgettable. FSRS-6 caps stability at 365 days
 * via STABILITY_CAP_DAYS and uses a difficulty term that regresses to mean so no
 * single dimension can run away.
 *
 * Side effects:
 *   - bumps access_count, ripple_count, review_count, eligibility_trace
 *   - writes new difficulty, stability, retrievability
 *   - sets last_review to `now`
 *   - recomputes salience using the new retrievability
 *   - leaves `ef` untouched (SM-2 backcompat read path; new code reads `difficulty`)
 */
export function touchNode(agentId: string, nodeId: string, quality = 4): void {
  const db = getDb(agentId);
  const now = Date.now();

  const node = db.prepare("SELECT * FROM nodes WHERE id = ?").get(nodeId) as BrainNode | null;
  if (!node) return;

  const fsrsQ = toFsrsQuality(quality);
  const anchorMs = node.last_review ?? node.accessed_at;
  const elapsedDays = Math.max(0, (now - anchorMs) / 86400000);

  // Retrievability at moment of review using PRE-review stability — this is what
  // FSRS uses as the spacing-effect input to the stability update.
  const rPre = fsrsRetrievability(elapsedDays, node.stability);

  const newDifficulty = fsrsUpdateDifficulty(node.difficulty, fsrsQ);

  // FSRS-6 stability update. We do NOT branch on review_count: the write-time
  // type-based half-life heuristic (HALF_LIFE_DAYS * importance) is already a
  // reasonable initial-stability estimate, and the FSRS success/failure formulas
  // operate from there. This preserves the "identity facts are sticky" prior
  // encoded by HALF_LIFE_DAYS while still applying FSRS spacing-effect math on
  // subsequent reviews. The only first-review safeguard: if the write-time
  // stability is below FSRS's per-quality initial baseline, lift it to that floor
  // on the first successful review so the FSRS curve starts in its calibrated regime.
  // SIGMA: load per-node calibration state
  const historyJson = (node as BrainNode & { review_history?: string | null }).review_history;
  const history: ReviewEntry[] = historyJson ? (JSON.parse(historyJson) as ReviewEntry[]) : [];
  const currentSigma = (node as BrainNode & { stability_sigma?: number }).stability_sigma ?? 1.0;

  const fsrsInit = fsrsInitialStability(fsrsQ);
  let newStability: number;
  if (fsrsQ === 1) {
    // Lapse: stability drops sharply but not to zero (vs. SM-2 which reset to 1.0).
    // Sigma is NOT applied to lapses — the lapse formula has its own calibration regime.
    newStability = fsrsFailureStability(node.stability, newDifficulty, rPre);
  } else {
    // Success: bounded multiplicative growth via FSRS-6's success formula. On
    // the first review, lift below-floor stability to the FSRS init baseline.
    // SIGMA: multiply by per-node calibration factor so faster-consolidating
    // concepts get longer intervals and slower ones get tighter spacing.
    const base = node.review_count === 0 && node.stability < fsrsInit
      ? fsrsInit
      : node.stability;
    newStability = fsrsSuccessStability(base, newDifficulty, rPre, fsrsQ) * currentSigma;
  }
  newStability = Math.max(0.1, Math.min(STABILITY_CAP_DAYS, newStability));

  // Append this review to history (before the new stability is applied) and refit sigma.
  history.push({ t: elapsedDays, g: fsrsQ, r: rPre, s: node.stability, d: node.difficulty });
  if (history.length > SIGMA_HISTORY_MAX) history.splice(0, history.length - SIGMA_HISTORY_MAX);
  const newSigma = computeStabilitySigma(history);

  // Post-review retrievability: elapsed is now ~0 since we just reviewed,
  // so this is effectively 1.0. Stored for backcompat with code that reads
  // the column directly (decayRetrievability re-derives it from elapsed time).
  const newRetrievability = 1.0;

  const newSalience = computeSalience(
    node.importance,
    node.emotional_weight,
    newRetrievability,
    node.eligibility_trace,
    node.ripple_count + 1,
  );

  executeWithWalRetrySync(
    db,
    (d) => {
      d.prepare(`
        UPDATE nodes
        SET difficulty       = ?,
            stability        = ?,
            retrievability   = ?,
            access_count     = access_count + 1,
            review_count     = review_count + 1,
            last_review      = ?,
            eligibility_trace = 1.0,
            ripple_count     = ripple_count + 1,
            salience         = ?,
            review_history   = ?,
            stability_sigma  = ?,
            accessed_at      = ?,
            updated_at       = ?
        WHERE id = ?
      `).run(newDifficulty, newStability, newRetrievability, now, newSalience,
             JSON.stringify(history), newSigma, now, now, nodeId);
    },
    { op: `nodes.touch:${nodeId.slice(0, 8)}` },
  );
}

export function getNode(agentId: string, id: string): BrainNode | null {
  const db = getDb(agentId);
  return db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as BrainNode | null;
}

// Very common words carry no retrieval signal but would otherwise match almost
// every node once the query is broken into individual OR-ed terms.
const FTS_STOPWORDS = new Set([
  "the", "and", "for", "was", "were", "are", "you", "your", "our", "its",
  "what", "who", "why", "how", "when", "where", "which", "that", "this",
  "with", "from", "about", "into", "any", "all", "can", "did", "does",
  "has", "have", "had", "not", "but", "then", "than", "there", "their",
  "tell", "know", "anything", "something", "everything",
]);

export function ftsSearchNodes(agentId: string, query: string, limit = 10): BrainNode[] {
  const db = getDb(agentId);

  const run = (matchExpr: string): BrainNode[] => {
    try {
      return db.prepare(`
        SELECT n.* FROM nodes n
        JOIN nodes_fts f ON n.rowid = f.rowid
        WHERE nodes_fts MATCH ?
          AND (n.valid_until IS NULL OR n.valid_until > ?)
        ORDER BY rank
        LIMIT ?
      `).all(matchExpr, Date.now(), limit) as BrainNode[];
    } catch {
      return [];
    }
  };

  // Wrap in double-quotes for phrase search — prevents FTS5 from interpreting
  // AND/OR/NOT/^ or parentheses as operators when they appear in user queries.
  const safe = query.replace(/"/g, "").trim();
  if (!safe) return [];

  // Pass 1: exact phrase. Highest precision, so it wins when it matches.
  const phraseHits = run(`"${safe}"`);
  if (phraseHits.length > 0) return phraseHits;

  // Pass 2: OR the individual terms, prefix-matched.
  //
  // Without this, phrase search is the ONLY keyword path, so a natural-language
  // question ("what is sharpwave") finds nothing unless that literal phrase was
  // stored verbatim. On an install with no embedding provider configured there
  // is no vector search to cover the gap, so recall returns empty for almost
  // every real question and the server looks broken. See hybridRetrieve, which
  // falls back to FTS-only whenever fetchEmbedding yields nothing.
  const terms = safe
    .toLowerCase()
    .split(/[^a-z0-9_]+/i)
    .filter((t) => t.length > 2 && !FTS_STOPWORDS.has(t));
  if (terms.length === 0) return [];

  return run(terms.map((t) => `"${t}"*`).join(" OR "));
}

export function getNeighbors(
  agentId: string,
  nodeId: string,
): Array<{ node: BrainNode; edgeType: string; weight: number }> {
  const db = getDb(agentId);
  const rows = db.prepare(`
    SELECT e.type as edge_type, e.weight, n.*
    FROM edges e
    JOIN nodes n ON n.id = e.to_id
    WHERE e.from_id = ? AND e.valid_until IS NULL
    UNION
    SELECT e.type as edge_type, e.weight, n.*
    FROM edges e
    JOIN nodes n ON n.id = e.from_id
    WHERE e.to_id = ? AND e.valid_until IS NULL
      AND e.type NOT IN ('inhibits', 'contradicts', 'supersedes', 'coreference_of')
  `).all(nodeId, nodeId) as Array<{ edge_type: string; weight: number } & BrainNode>;

  return rows.map((r) => ({
    edgeType: r.edge_type,
    weight: r.weight,
    node: r as unknown as BrainNode,
  }));
}

// valid_until filters (clawbrain-v4 Fable-5 audit F-9): retired/superseded nodes
// must not surface in bootstrap blocks, the goals line, the review queue, or
// dopamine propagation. getOperationalProcedures already carried this filter;
// these four did not until the F-9 port.
export function getTopByType(agentId: string, type: NodeType, limit = 5): BrainNode[] {
  const db = getDb(agentId);
  return db.prepare(
    "SELECT * FROM nodes WHERE type = ? AND (valid_until IS NULL OR valid_until > ?) ORDER BY salience DESC LIMIT ?"
  ).all(type, Date.now(), limit) as BrainNode[];
}

/**
 * Operational procedures for the always-on procedural block.
 *
 * WHY THIS BYPASSES RETRIEVAL ENTIRELY: `hybridRetrieve` is keyed on the user's
 * message, and procedural knowledge is never lexically or semantically similar
 * to what the user says. "did you look into that?" has zero overlap with a node
 * about `&&` not being a PowerShell statement separator, so it can never match.
 * Spreading activation does not rescue it either — activation seeds from
 * identity/goal and never leaves that basin (measured 2026-07-31: identity 230
 * injections, goal 73, procedural **0**; all 33 procedural nodes had
 * inject_count = 0 since 2026-07-13, including a hand-written importance-0.9
 * node describing the exact shell errors the agent was making ~30% of the time).
 *
 * Procedural memory is needed when the agent is about to ACT, which does not
 * correlate with what was just said. So it gets a guaranteed slot instead of
 * competing in a similarity ranking it cannot win.
 *
 * Ordering prefers `source='brain_manager'` (hand-written and verified for this
 * machine) over extracted/SWS nodes, then importance. `minContentChars` drops
 * SWS title-fragment artifacts like "## Step 1: Register Your Agent" (35 chars)
 * that would otherwise outrank real rules on importance alone.
 */
export function getOperationalProcedures(
  agentId: string,
  limit = 6,
  minContentChars = 80,
): BrainNode[] {
  const db = getDb(agentId);
  return db.prepare(`
    SELECT * FROM nodes
    WHERE type = 'procedural'
      AND (valid_until IS NULL OR valid_until > ?)
      AND length(content) >= ?
    ORDER BY (CASE WHEN source = 'brain_manager' THEN 1 ELSE 0 END) DESC,
             importance DESC,
             salience DESC
    LIMIT ?
  `).all(Date.now(), minContentChars, limit) as BrainNode[];
}

export function getActiveGoals(agentId: string): BrainNode[] {
  const db = getDb(agentId);
  return db.prepare(
    "SELECT * FROM nodes WHERE type = 'goal' AND retrievability > 0.1 AND (valid_until IS NULL OR valid_until > ?) ORDER BY salience DESC LIMIT 10"
  ).all(Date.now()) as BrainNode[];
}

export function getReviewQueue(agentId: string, limit = 5): BrainNode[] {
  const db = getDb(agentId);
  // Danger zone: R between 0.08 and 0.28 — fading but not yet lost
  return db.prepare(
    "SELECT * FROM nodes WHERE retrievability >= 0.08 AND retrievability <= 0.28 AND (valid_until IS NULL OR valid_until > ?) ORDER BY retrievability ASC LIMIT ?"
  ).all(Date.now(), limit) as BrainNode[];
}

export function propagateDopamineSpike(
  agentId: string,
  dopamineStrength: number,
): void {
  const db = getDb(agentId);
  const traced = db.prepare(
    "SELECT id, eligibility_trace FROM nodes WHERE eligibility_trace > 0.1 AND (valid_until IS NULL OR valid_until > ?) ORDER BY eligibility_trace DESC LIMIT 15"
  ).all(Date.now()) as Array<{ id: string; eligibility_trace: number }>;

  if (traced.length === 0) return;
  // Salience cap prevents runaway dopamine boosts (code-1 P1-6 / SYNTHESIS).
  // Multiplied salience is bounded to 1.0 inside the SQL so identity-traced nodes
  // can't become permanent attractors via repeated importance spikes.
  const update = db.prepare(`
    UPDATE nodes
    SET importance  = MIN(importance + ?, 1.0),
        salience    = MIN(salience * ?, 1.0),
        updated_at  = ?
    WHERE id = ?
  `);
  const now = Date.now();
  db.transaction(() => {
    for (const n of traced) {
      const boost = dopamineStrength * n.eligibility_trace;
      update.run(boost * 0.1, 1.0 + boost * 0.2, now, n.id);
    }
  })();
}

export function decayEligibilityTraces(agentId: string): void {
  const db = getDb(agentId);
  db.prepare(
    "UPDATE nodes SET eligibility_trace = eligibility_trace * 0.85 WHERE eligibility_trace > 0.01"
  ).run();
}

export function decayRetrievability(agentId: string, sampleSize = 25): void {
  const db = getDb(agentId);
  const now = Date.now();

  // Use FSRS anchor `last_review` (falling back to `accessed_at` for nodes that
  // haven't been reviewed since the v12 migration). Power-law decay per FSRS-6.
  const nodes = db.prepare(`
    SELECT id, stability, last_review, accessed_at, importance, emotional_weight, eligibility_trace, ripple_count
    FROM nodes
    WHERE retrievability > 0.01
    ORDER BY RANDOM()
    LIMIT ?
  `).all(sampleSize) as Array<{
    id: string;
    stability: number;
    last_review: number | null;
    accessed_at: number;
    importance: number;
    emotional_weight: number;
    eligibility_trace: number;
    ripple_count: number;
  }>;

  const update = db.prepare(
    "UPDATE nodes SET retrievability = ?, salience = ?, updated_at = ? WHERE id = ?"
  );

  db.transaction(() => {
    for (const n of nodes) {
      const anchor = n.last_review ?? n.accessed_at;
      const elapsedDays = Math.max(0, (now - anchor) / 86400000);
      const R = Math.max(0.01, fsrsRetrievability(elapsedDays, n.stability));
      const salience = computeSalience(n.importance, n.emotional_weight, R, n.eligibility_trace, n.ripple_count);
      update.run(R, salience, now, n.id);
    }
  })();
}
