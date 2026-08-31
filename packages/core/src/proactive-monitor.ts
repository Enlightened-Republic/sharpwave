import { getDb } from "./db.js";
import { fetchEmbedding, vectorSearchNodes, cosineSimilarity, bufferToFloat32 } from "./embeddings.js";
import type { BrainConfig, NeuromodState } from "./types.js";

type Logger = { info: (msg: string) => void; warn: (msg: string) => void; debug?: (msg: string) => void };

// ── Proactive relevance monitor (CogniFold pattern) ────────────────────────
// Runs at the start of every before_prompt_build pass, BEFORE recall fires.
// Scans the last 3 episodes from the current session, extracts keywords, and
// bumps `eligibility_trace` on FTS-matching nodes. When spreading activation
// then runs for recall, those pre-boosted nodes score higher salience and are
// more likely to surface in the context window — analogous to how the brain
// begins retrieving related memories as a conversation topic develops, before
// you consciously ask to remember anything.
//
// The boost is additive and capped at 1.0. It decays via the normal
// `decayEligibilityTraces` run in consolidation, so stale priming fades.

const ELIGIBILITY_BOOST = 0.3;
const SEMANTIC_BOOST_MAX = 0.20;       // max additional boost from semantic similarity to query
const SEMANTIC_SIM_THRESHOLD = 0.70;  // cosine sim to query embedding must exceed this
const CONTEXT_BOOST_MAX = 0.15;        // max additional boost for perfect context match
const CONTEXT_MATCH_THRESHOLD = 0.85; // contextMatchBonus (range 0.7–1.0) must exceed this
const MONITOR_MAX_NODES = 10;
const MONITOR_KEYWORD_COUNT = 6;
const MONITOR_EPISODE_LOOKBACK = 3;

const STOP_WORDS = new Set([
  "the","a","an","is","are","was","were","be","been","being","have","has",
  "had","do","does","did","will","would","could","should","may","might",
  "must","shall","can","that","this","these","those","it","its","they",
  "them","their","and","or","but","for","nor","so","yet","both","either",
  "neither","not","only","own","same","than","too","very","just","from",
  "with","about","into","through","during","before","after","above","below",
  "between","each","few","more","most","other","some","such","no","at",
  "by","in","of","on","to","up","what","when","where","which","who","how",
  "said","user","assistant","okay","yeah","right","like","just","think",
]);

type StructuredFields = Record<string, string | number | boolean | undefined>;
function structured(fields: StructuredFields): string {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) out[k] = v;
  }
  return `[clawbrain-v4] ${JSON.stringify(out)}`;
}

function contextMatchBonus(enc: NeuromodState, cur: NeuromodState): number {
  const a = [enc.dopamine, enc.serotonin, enc.acetylcholine, enc.norepinephrine];
  const b = [cur.dopamine, cur.serotonin, cur.acetylcholine, cur.norepinephrine];
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < 4; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  if (mag === 0) return 1.0;
  const sim = dot / mag;
  return 0.7 + 0.3 * Math.max(0, sim);
}

export async function runProactiveMonitor(
  agentId: string,
  sessionId: string,
  config: BrainConfig,
  log?: Logger,
  currentNeuromodState?: NeuromodState | null,
  lastUserMsg?: string,
): Promise<void> {
  const db = getDb(agentId);

  // Fetch the last N episodes from this session
  const recent = db.prepare(`
    SELECT content FROM episodes
    WHERE session_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(sessionId, MONITOR_EPISODE_LOOKBACK) as { content: string }[];

  if (recent.length === 0) return;

  // Extract unique meaningful tokens from combined recent text
  const combined = recent.map(e => e.content).join(" ");
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const w of combined.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)) {
    if (w.length > 4 && !STOP_WORDS.has(w) && !seen.has(w)) {
      seen.add(w);
      tokens.push(w);
      if (tokens.length >= MONITOR_KEYWORD_COUNT) break;
    }
  }

  if (tokens.length < 2) return;

  const query = tokens.map(t => `"${t.replace(/"/g, "")}"`).join(" OR ");
  const now = Date.now();

  try {
    const matches = db.prepare(`
      SELECT n.id
      FROM nodes n
      JOIN nodes_fts f ON n.rowid = f.rowid
      WHERE nodes_fts MATCH ?
        AND (n.valid_until IS NULL OR n.valid_until > ?)
      ORDER BY rank
      LIMIT ?
    `).all(query, now, MONITOR_MAX_NODES) as { id: string }[];

    if (matches.length === 0) return;

    const bump = db.prepare(
      "UPDATE nodes SET eligibility_trace = MIN(1.0, eligibility_trace + ?), updated_at = ? WHERE id = ?",
    );

    db.transaction(() => {
      for (const { id } of matches) bump.run(ELIGIBILITY_BOOST, now, id);
    })();

    // Contextual reinstatement: nodes encoded in a similar neuromodulator state
    // get an additional eligibility_trace boost (Godden & Baddeley 1975;
    // Cahill & McGaugh 1998). Only fires when caller passes the current state.
    let contextBoosted = 0;
    if (currentNeuromodState) {
      // Opus audit #11: this ran 200 JSON.parse + up to 200 UPDATEs on every
      // turn, and the LIMIT had no ORDER BY — an arbitrary subset of nodes got
      // context boosts. Now bounded to the 50 most recently accessed nodes
      // (deterministic, and the ones contextual reinstatement is about).
      const withContext = db.prepare(`
        SELECT id, encoding_context FROM nodes
        WHERE encoding_context IS NOT NULL
          AND (valid_until IS NULL OR valid_until > ?)
        ORDER BY accessed_at DESC
        LIMIT 50
      `).all(now) as { id: string; encoding_context: string }[];

      db.transaction(() => {
        for (const row of withContext) {
          let enc: NeuromodState;
          try { enc = JSON.parse(row.encoding_context) as NeuromodState; } catch { continue; }
          const bonus = contextMatchBonus(enc, currentNeuromodState);
          if (bonus > CONTEXT_MATCH_THRESHOLD) {
            // Scale [threshold, 1.0] → [0, CONTEXT_BOOST_MAX]
            const boost = (bonus - CONTEXT_MATCH_THRESHOLD) / (1.0 - CONTEXT_MATCH_THRESHOLD) * CONTEXT_BOOST_MAX;
            bump.run(boost, now, row.id);
            contextBoosted++;
          }
        }
      })();
    }

    // Semantic pre-priming: embed the current user message and boost nodes that
    // are semantically close even if they share no exact keywords (FTS blind spot).
    // Superbrain advantage — FTS misses "Gumroad product strategy" when the user
    // asks about "making money online." Embeddings close that gap.
    // Hard 250ms budget so the total hook stays inside OpenClaw's 500ms gate.
    let semanticBoosted = 0;
    if (lastUserMsg) {
      // fetchEmbedding REQUIRES config (Opus audit #2 — the old call omitted
      // it, so this path threw immediately and semantic pre-priming never
      // fired in production).
      // When the 250ms budget wins the race we abort the signal so the
      // underlying HTTP request is actually cancelled — not left dangling on a
      // socket (this matters ×29 agents on every turn).
      const embedController = new AbortController();
      const embedPromise = fetchEmbedding(lastUserMsg, config, log, embedController.signal);
      // We may abandon this promise when the budget elapses; swallow its late
      // AbortError so it doesn't surface as an unhandled rejection.
      embedPromise.catch(() => {});
      try {
        const timeout = new Promise<null>((resolve) =>
          setTimeout(() => { embedController.abort(); resolve(null); }, 250),
        );
        const queryVec = await Promise.race([embedPromise, timeout]);
        if (queryVec) {
          const semanticMatches = vectorSearchNodes(agentId, queryVec, 15);
          db.transaction(() => {
            for (const node of semanticMatches) {
              if (!node.embedding) continue;
              const nodeVec = bufferToFloat32(node.embedding as Buffer);
              const sim = cosineSimilarity(queryVec, nodeVec);
              if (sim > SEMANTIC_SIM_THRESHOLD) {
                const boost = (sim - SEMANTIC_SIM_THRESHOLD) / (1 - SEMANTIC_SIM_THRESHOLD) * SEMANTIC_BOOST_MAX;
                bump.run(boost, now, node.id);
                semanticBoosted++;
              }
            }
          })();
        }
      } catch {
        // non-fatal — FTS boost already applied
      }
    }

    log?.debug?.(
      structured({
        agentId,
        sessionId,
        op: "proactive_monitor",
        outcome: "ok",
        boosted: matches.length,
        contextBoosted,
        semanticBoosted,
        keywords: tokens.join(","),
      }),
    );
  } catch (err) {
    log?.warn(
      structured({
        agentId,
        sessionId,
        op: "proactive_monitor",
        outcome: "error",
        error: String(err),
      }),
    );
  }
}
