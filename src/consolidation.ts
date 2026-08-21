import { getDb, getMeta, setMeta, bumpWriteCounter } from "./db.js";
import { decayEligibilityTraces, decayRetrievability, writeNode, ftsSearchNodes } from "./nodes.js";
import { queueEmbedding, vectorSearchNodes, bufferToFloat32, cosineSimilarity } from "./embeddings.js";
import { writeEdge, edgeExists } from "./edges.js";
import { getEpisodesSince, getEpisodeCount } from "./episodes.js";
import { mergeCoreferentNodes } from "./entity-resolution.js";
import { detectSkillCandidates } from "./skill-evolution.js";
import { classifySentence, importanceForType, jaccardSim } from "./utils.js";
import { executeWithWalRetrySync } from "./wal-retry.js";
import { bumpCounter, logObservabilityEvent, setLastConsolidationAt } from "./observability.js";
import type { BrainConfig, Episode, BrainNode, NeuromodState } from "./types.js";

type Logger = { info: (msg: string) => void; warn: (msg: string) => void };

// ──────────────────────────────────────────────────────────────────────────
// Defensive schema columns
//
// The columns below are introduced by SCHEMA_CONTRACT.md versions v10, v12,
// v13. Agent A owns the migration chain in src/db.ts. Until that chain
// catches up to v13, fresh DBs opened via getDb() are at TARGET=9 and do
// not have these columns. The migrate-v3-to-v4.ts script does take live
// brain.db files to v10 (which gives us `llm_extracted`), but build-agent
// test runs use fresh DBs.
//
// To stay shippable while Agent A's schema work lands, we make every column
// we read self-healing: an idempotent ALTER TABLE that succeeds when the
// column is missing and silently noops (duplicate column) when present.
// Agent A's eventual v10/v12/v13 migration is a strict superset of this,
// so once schema_version >= 13 lands this helper becomes a no-op.
// ──────────────────────────────────────────────────────────────────────────
const schemaRepairedAgents = new Set<string>();
function ensureSchemaColumns(agentId: string): void {
  if (schemaRepairedAgents.has(agentId)) return;
  const db = getDb(agentId);
  const tryExec = (sql: string): void => {
    try { db.exec(sql); } catch { /* duplicate column or table missing — both safe */ }
  };

  // v10: dual-extraction prevention
  tryExec("ALTER TABLE episodes ADD COLUMN llm_extracted INTEGER NOT NULL DEFAULT 0");
  // v12: FSRS tracking columns (B's promotion rule reads review_count)
  tryExec("ALTER TABLE nodes ADD COLUMN review_count INTEGER NOT NULL DEFAULT 0");
  tryExec("ALTER TABLE nodes ADD COLUMN last_review INTEGER");
  tryExec("ALTER TABLE nodes ADD COLUMN difficulty REAL NOT NULL DEFAULT 5.0");
  // v13: CLS two-store split (B owns promotion)
  tryExec("ALTER TABLE nodes ADD COLUMN is_consolidated INTEGER NOT NULL DEFAULT 0");
  tryExec("ALTER TABLE nodes ADD COLUMN consolidated_at INTEGER");
  tryExec("CREATE INDEX IF NOT EXISTS nodes_consolidated ON nodes(is_consolidated, retrievability)");

  schemaRepairedAgents.add(agentId);
}

// ──────────────────────────────────────────────────────────────────────────
// Subagent runner injection (T4.5 generative REM)
//
// In production, index.ts (Agent C) passes `api.runtime.subagent.run` here at
// gateway_start. In tests we provide a mock via setSubagentRunner(...). When
// no runner is registered, generative REM falls back to the legacy keyword
// bucketing — i.e. T4.5 is gated by both config.remGenerativeEnabled AND
// runner availability.
// ──────────────────────────────────────────────────────────────────────────
export interface SubagentRunInput {
  sessionKey: string;
  message: string;
  model?: string;
  provider?: string;
  deliver?: boolean;
}
export interface SubagentRunResult {
  text: string;
}
export type SubagentRunner = (input: SubagentRunInput) => Promise<SubagentRunResult>;

let subagentRunner: SubagentRunner | null = null;
export function setSubagentRunner(fn: SubagentRunner | null): void {
  subagentRunner = fn;
}

// Direct LLM call via OpenRouter — used when no subagentRunner is injected
// (i.e., in the standalone MCP server, where no host subagent API exists).
// Falls back gracefully if the API key is missing.
async function callRemLlm(message: string, model: string, apiKey: string): Promise<string> {
  const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: message }],
      max_tokens: 600,
    }),
  });
  if (!resp.ok) throw new Error(`OpenRouter HTTP ${resp.status}`);
  const json = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
  return json.choices?.[0]?.message?.content ?? "";
}

// ──────────────────────────────────────────────────────────────────────────
// Neuromodulators
//
// Wired per audit/neuro-1.md T4.2:
//   - ACh: high during waking (low recency, i.e. close to last episode); low
//     during long idle (gap before a session resumes). Hasselmo 2013 puts ACh
//     high during active exploration / encoding-biased state, low during SWS.
//   - NE: arousal gain — proxied by recent episode importance peak.
//   - DA: prediction-error proxy — counts of recent contradictions/superseded
//     nodes plus novel-embedding rate.
//   - 5-HT: inverse of accumulated emotional valence over the last 7 days.
//
// These values are now consumed by:
//   - runSwsPhase via dopamine reinforcement of contradicted nodes
//   - runRemPhase to bound entity-merge aggressiveness
//   - encoding_context similarity bonus in retrieval (unchanged)
// ──────────────────────────────────────────────────────────────────────────
export function getNeuromodulatorState(agentId: string): NeuromodState {
  ensureSchemaColumns(agentId);
  const db = getDb(agentId);
  const now = Date.now();
  const oneDayMs = 86400000;

  // Acetylcholine — Hasselmo 2013: high during active waking, low during long
  // idle. Previously inverted (high right after a session, decaying with gap).
  // Now: high when there has been a very recent episode (active waking),
  // dropping to ~0 when the gap is large.
  const lastEp = db.prepare(
    "SELECT created_at FROM episodes ORDER BY created_at DESC LIMIT 1"
  ).get() as { created_at: number } | undefined;
  const gapHours = lastEp ? (now - lastEp.created_at) / 3600000 : 48;
  // 0 gap -> 1.0; 24h gap -> ~0.0. Replaces the inverted v3 formula.
  const acetylcholine = Math.max(0, 1 - Math.min(gapHours / 24, 1));

  // Norepinephrine — arousal: max importance over the last 24h, gated by
  // active-goal count. NE in real cortex multiplies gain on encoding when
  // novel/salient input arrives (Sara 2009 / GANE).
  const recentPeak = (db.prepare(
    "SELECT MAX(importance) as m FROM episodes WHERE created_at > ?"
  ).get(now - oneDayMs) as { m: number | null }).m ?? 0;
  const activeGoals = (db.prepare(
    "SELECT COUNT(*) as n FROM nodes WHERE type = 'goal' AND retrievability > 0.1"
  ).get() as { n: number }).n;
  const norepinephrine = Math.min(1, recentPeak * 0.7 + Math.min(activeGoals / 5, 1) * 0.3);

  // Dopamine — reward prediction error proxy: count of new `contradicts` /
  // `supersedes` edges in last 24h (surprise / model update events) plus the
  // ratio of new nodes (novelty load).
  const peCount = (db.prepare(
    "SELECT COUNT(*) as n FROM edges WHERE valid_until IS NULL AND type IN ('contradicts','supersedes') AND created_at > ?"
  ).get(now - oneDayMs) as { n: number }).n;
  const newNodes = (db.prepare(
    "SELECT COUNT(*) as n FROM nodes WHERE created_at > ?"
  ).get(now - oneDayMs) as { n: number }).n;
  const totalNodes = (db.prepare("SELECT COUNT(*) as n FROM nodes").get() as { n: number }).n;
  const novelty = Math.min(1, newNodes / Math.max(totalNodes * 0.05, 1));
  const dopamine = Math.min(1, peCount * 0.2 + novelty * 0.7);

  // Serotonin — inverse of accumulated emotional valence magnitude.
  const avgEmotion = (db.prepare(
    "SELECT AVG(ABS(emotional_weight)) as a FROM nodes WHERE accessed_at > ?"
  ).get(now - 7 * oneDayMs) as { a: number | null }).a ?? 0;
  const serotonin = Math.max(0, 1 - avgEmotion);

  let interpretation = "";
  if (dopamine > 0.6) interpretation += "active learning / prediction-error firing; ";
  if (serotonin < 0.3) interpretation += "emotionally charged; ";
  if (acetylcholine > 0.6) interpretation += "encoding-biased (active waking); ";
  else if (acetylcholine < 0.2) interpretation += "retrieval-biased (long idle / pre-SWS); ";
  if (norepinephrine > 0.6) interpretation += "high arousal / goal pressure; ";
  if (!interpretation) interpretation = "baseline state";

  return {
    dopamine,
    serotonin,
    acetylcholine,
    norepinephrine,
    interpretation: interpretation.replace(/;\s*$/, ""),
  };
}

export function shouldConsolidate(agentId: string, config: BrainConfig): boolean {
  const lastRaw = getMeta(agentId, "last_consolidation");
  const lastMs = lastRaw ? parseInt(lastRaw, 10) : 0;
  const gapHours = (Date.now() - lastMs) / 3600000;
  if (gapHours < config.consolidationTimeGateHours) return false;

  // Use new episodes since last consolidation (delta), not total episode count.
  // Total count always grows, making the gate permanently satisfied after the first run.
  const lastCountRaw = getMeta(agentId, "last_consolidation_episode_count");
  const lastCount = lastCountRaw ? parseInt(lastCountRaw, 10) : 0;
  const currentCount = getEpisodeCount(agentId);
  return (currentCount - lastCount) >= config.consolidationEpisodeGate;
}

export async function subconsciousTick(
  agentId: string,
  config: BrainConfig,
  log: Logger,
): Promise<void> {
  try {
    // Tick only does lightweight decay — no consolidation.
    // Full consolidation runs via the nightly cron (brain_reflect tool call),
    // keeping the tick cheap and event-loop safe.
    decayRetrievability(agentId, 25);
    await new Promise<void>((r) => setImmediate(r));
    decayEligibilityTraces(agentId);
  } catch (err) {
    log.warn(`[sharpwave] subconsciousTick error (agent=${agentId}): ${String(err)}`);
  }
}

export async function runConsolidation(
  agentId: string,
  config: BrainConfig,
  log: Logger,
): Promise<void> {
  ensureSchemaColumns(agentId);
  const db = getDb(agentId);
  const lastRaw = getMeta(agentId, "last_consolidation");
  const sinceMs = lastRaw ? parseInt(lastRaw, 10) : Date.now() - 86400000 * 7;

  log.info(`[sharpwave] consolidation start (agent=${agentId})`);

  // Phase 1: SWS — extract nodes from episodes (only those LLM hasn't seen)
  // SWS query filter `llm_extracted = 0` lives inside runSwsPhase so that
  // any call site (cron, brain_reflect tool, test fixture) benefits uniformly.
  const swsEpisodes = pickSwsEpisodes(agentId, sinceMs, 20);

  await runSwsPhase(agentId, swsEpisodes, log);
  await new Promise<void>((r) => setImmediate(r));

  // Phase 1.5: NEXUS — cluster high-ripple nodes into schema abstraction nodes.
  // Runs after SWS extraction so newly written nodes are also candidates.
  await runClusterSchemaPhase(agentId, log);
  await new Promise<void>((r) => setImmediate(r));

  // Phase 2: Reconsolidation — update recalled nodes with new associations
  await runReconsolidationPhase(agentId, sinceMs, log);
  await new Promise<void>((r) => setImmediate(r));

  // Phase 3: REM — pattern extraction (generative if subagent runner set),
  // contradiction detection, entity merge, affective decay
  await runRemPhase(agentId, config, log);
  await new Promise<void>((r) => setImmediate(r));

  // Phase 4: Deep — physically prune near-zero retrievability orphans
  runDeepPhase(agentId, config, log);

  // Reset ripple counts after consolidation
  db.transaction(() => {
    db.exec("UPDATE nodes SET ripple_count = 0 WHERE ripple_count > 0");
    db.exec("UPDATE episodes SET ripple_count = 0 WHERE ripple_count > 0");
  })();

  setMeta(agentId, "last_consolidation", String(Date.now()));
  setMeta(agentId, "last_consolidation_episode_count", String(getEpisodeCount(agentId)));
  setLastConsolidationAt(new Date().toISOString());
  logObservabilityEvent("consolidate", { agentId });
  log.info(`[sharpwave] consolidation complete (agent=${agentId})`);
}

// ── RecMem recurrence gate ──────────────────────────────────────────────────
// Before SWS extracts nodes from an episode, verify the content has recurred
// across at least RECURRENCE_MIN_SESSIONS distinct conversations. One-off
// mentions are noise; knowledge that keeps coming up across sessions is worth
// consolidating into long-term semantic nodes.
//
// High-importance episodes (>= 0.8) bypass the gate — a single vivid event
// or critical fact should still be encoded even without repetition.
//
// If the total episode count is < MIN_CORPUS for comparison, skip the gate
// entirely (not enough data to distinguish recurring from one-off).
const RECURRENCE_MIN_SESSIONS = 2;
const RECURRENCE_IMPORTANCE_BYPASS = 0.8;
const RECURRENCE_RECENCY_BYPASS_MS = 8 * 60 * 60 * 1000; // bypass for same-session content (last 8h)
const RECURRENCE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30-day lookback
const RECURRENCE_MIN_CORPUS = 10; // gate requires at least this many total episodes

const SWS_STOP_WORDS = new Set([
  "the","a","an","is","are","was","were","be","been","being","have","has",
  "had","do","does","did","will","would","could","should","may","might",
  "must","shall","can","that","this","these","those","it","its","they",
  "them","their","and","or","but","for","nor","so","yet","both","either",
  "neither","not","only","own","same","than","too","very","just","from",
  "with","about","into","through","during","before","after","above","below",
  "between","each","few","more","most","other","some","such","no","at",
  "by","in","of","on","to","up","what","when","where","which","who","how",
]);

function isEpisodeRecurrent(agentId: string, ep: Episode): boolean {
  if (ep.importance >= RECURRENCE_IMPORTANCE_BYPASS) return true;
  // Superbrain: bypass for content from the last 8 hours (same-session or same-day).
  // The human brain can't distinguish "brand-new vs old" during SWS — we can.
  if (ep.created_at > Date.now() - RECURRENCE_RECENCY_BYPASS_MS) return true;

  const tokens = ep.content
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 4 && !SWS_STOP_WORDS.has(w))
    .slice(0, 4);

  if (tokens.length < 2) return true; // too short to gate reliably

  const safeToken = (w: string) => `"${w.replace(/"/g, "")}"`;
  const query = tokens.map(safeToken).join(" OR ");
  const since = Date.now() - RECURRENCE_WINDOW_MS;

  try {
    const db = getDb(agentId);
    const row = db.prepare(`
      SELECT COUNT(DISTINCT e.session_id) as n
      FROM episodes_fts f
      JOIN episodes e ON e.id = f.id
      WHERE episodes_fts MATCH ?
        AND e.id       != ?
        AND e.session_id != ?
        AND e.created_at > ?
    `).get(query, ep.id, ep.session_id, since) as { n: number };
    return row.n >= RECURRENCE_MIN_SESSIONS - 1;
  } catch {
    return true; // FTS error — pass through, never block on infra failure
  }
}

/**
 * Pick episodes for the SWS heuristic extraction pass.
 *
 * T1.3 (audit/code-1.md fix #3 / SYNTHESIS.md): only episodes that have NOT
 * already been LLM-extracted are eligible — the LLM-extraction queue drained
 * at session_end already marked its consumed episodes via
 * `UPDATE episodes SET llm_extracted = 1`. Without this filter, SWS would
 * re-extract every LLM-touched episode and pollute the node store with
 * heuristic near-duplicates.
 *
 * RecMem gate: also filters out single-occurrence episodes (content that has
 * only appeared in one session). The gate is bypassed when the corpus is too
 * small to compare against, or when episode importance >= 0.8.
 */
function pickSwsEpisodes(agentId: string, sinceMs: number, limit: number): Episode[] {
  const db = getDb(agentId);

  // Superbrain sort: importance × recency blend, cross-session.
  // The human brain replays in temporal order because it can't pre-screen.
  // We can — so we prioritize episodes that are both valuable AND recent.
  // recency_score = 1 - daysSince/90, clamped [0,1]. Drops to 0 at pruneAfterDays.
  // Within each selected session, temporal order is preserved via secondary sort
  // so causal chains inside a conversation stay intact.
  const candidates = db.prepare(`
    SELECT *,
      (importance * MAX(0.0, 1.0 - ((:now - created_at) / 7776000000.0))) AS sws_priority
    FROM episodes
    WHERE created_at > :since
      AND importance >= 0.2
      AND llm_extracted = 0
    ORDER BY sws_priority DESC, session_id ASC, created_at ASC
    LIMIT :limit
  `).all({ now: Date.now(), since: sinceMs, limit }) as (Episode & { sws_priority: number })[];

  const totalEps = (db.prepare("SELECT COUNT(*) as n FROM episodes").get() as { n: number }).n;
  if (totalEps < RECURRENCE_MIN_CORPUS) return candidates;

  return candidates.filter(ep => isEpisodeRecurrent(agentId, ep));
}

/**
 * SWS phase — slow-wave-sleep analog.
 *
 * Per audit/neuro-2.md T4.3 the first thing this does is **synaptic
 * downscaling**: every non-protected node loses 5% of its stability and
 * retrievability *before* anything gets strengthened. This implements
 * Tononi & Cirelli's synaptic homeostasis hypothesis at the simplest
 * faithful level (one SQL UPDATE).
 *
 * Then the heuristic extraction pass runs.
 *
 * Finally:
 *   - T4.4 (CLS): nodes with review_count >= 5 AND retrievability >= 0.7
 *     are promoted to the cortical-analog store (is_consolidated = 1).
 *     Agent A's FSRS code reads is_consolidated to apply the 2x stability
 *     multiplier on subsequent decay calls.
 *   - T1.3: every episode this pass consumed is marked llm_extracted = 1
 *     so future passes (including the next SWS run) cannot pick it up again.
 *   - T1.5: a `before` edge is wired between the last extracted node of
 *     episode N and the first extracted node of episode N+1 within the same
 *     session_id, giving sequential structure to consolidation-derived nodes.
 */
async function runSwsPhase(agentId: string, episodes: Episode[], log: Logger): Promise<void> {
  ensureSchemaColumns(agentId);
  const db = getDb(agentId);

  // T4.3 — Global synaptic downscaling (Tononi & Cirelli 2003/2014/2020).
  // Skip identity/goal (protected self-structures) and nodes created in the last
  // 24h — freshly consolidated memories should not be immediately downscaled in
  // the same SWS pass that wrote them. Human brains can't make this distinction; we can.
  const now = Date.now();
  const downscaled = db.prepare(`
    UPDATE nodes
    SET stability      = stability * 0.95,
        retrievability = retrievability * 0.95,
        updated_at     = ?
    WHERE type NOT IN ('identity', 'goal')
      AND created_at < ?
      AND (stability > 0.01 OR retrievability > 0.01)
  `).run(now, now - 86_400_000);
  if (downscaled.changes > 0) {
    log.info(`[sharpwave] SWS downscale: -5% stability/retrievability on ${downscaled.changes} non-protected node(s)`);
  }

  const bumpRipple = db.prepare("UPDATE episodes SET ripple_count = ripple_count + 1 WHERE id = ?");
  // Per-session chain: track previous episode's last extracted node id so we
  // can wire a temporal `before` edge when the next episode in the same
  // session produces its first node.
  const lastNodePerSession = new Map<string, string>();
  const consumedEpisodeIds: string[] = [];

  // T4.2 — neuromodulators feed into encoding context (currently a passive
  // descriptor; future writes can attach this to writeNode encodingContext).
  // Captured once per phase so the values are consistent across writes.
  const neuro = getNeuromodulatorState(agentId);

  for (let i = 0; i < episodes.length; i++) {
    const ep = episodes[i];
    if (ep.content.length < 20) continue;

    const nodes = await extractNodesFromEpisode(agentId, ep, neuro);
    bumpRipple.run(ep.id);
    consumedEpisodeIds.push(ep.id);

    if (nodes.length > 0) {
      // T1.5 — temporal `before` edge between the previous episode in this
      // session and the current one. We chain at the boundary node level:
      // last node of previous episode → first node of this episode.
      const prevLastInSession = lastNodePerSession.get(ep.session_id);
      if (prevLastInSession && prevLastInSession !== nodes[0]) {
        if (!edgeExists(agentId, prevLastInSession, nodes[0], "before")) {
          writeEdge(agentId, prevLastInSession, nodes[0], "before", { weight: 0.5 });
        }
      }
      // Internal sequencing within a single episode is also chained, so the
      // graph captures the order in which sentences were classified.
      for (let k = 0; k + 1 < nodes.length; k++) {
        if (!edgeExists(agentId, nodes[k], nodes[k + 1], "before")) {
          writeEdge(agentId, nodes[k], nodes[k + 1], "before", { weight: 0.4 });
        }
      }
      lastNodePerSession.set(ep.session_id, nodes[nodes.length - 1]);

      log.info(`[sharpwave] SWS: ${nodes.length} node(s) from episode ${ep.id.slice(0, 8)}`);
    }
    // Yield after every episode — FTS search per sentence blocks event loop
    await new Promise<void>((r) => setImmediate(r));
  }

  // T1.3 — flip llm_extracted = 1 on every episode this pass consumed so
  // subsequent SWS passes (and any future drain) skip them.
  if (consumedEpisodeIds.length > 0) {
    const markExtracted = db.prepare("UPDATE episodes SET llm_extracted = 1 WHERE id = ?");
    db.transaction(() => {
      for (const id of consumedEpisodeIds) markExtracted.run(id);
    })();
    log.info(`[sharpwave] SWS: marked ${consumedEpisodeIds.length} episode(s) as llm_extracted`);
  }

  // T4.4 — CLS two-store promotion. Run after extraction so newly written
  // nodes can also become candidates on subsequent passes. Coordinated with
  // Agent A (FSRS-6): a node with is_consolidated = 1 must receive a 2x
  // stability multiplier in src/nodes.ts touchNode / decayRetrievability
  // when Agent A's v12 code lands. Until then the column simply tags
  // candidates for the future fast/slow split.
  const promotion = db.prepare(`
    UPDATE nodes
    SET is_consolidated = 1,
        consolidated_at = ?,
        updated_at      = ?
    WHERE is_consolidated = 0
      AND review_count   >= 5
      AND retrievability >= 0.7
  `).run(Date.now(), Date.now());
  if (promotion.changes > 0) {
    log.info(`[sharpwave] SWS: promoted ${promotion.changes} node(s) to consolidated (CLS cortical store)`);
  }
}

async function extractNodesFromEpisode(
  agentId: string,
  episode: Episode,
  neuro: NeuromodState,
): Promise<string[]> {
  const nodeIds: string[] = [];
  const sentences = episode.content
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);

  for (const sentence of sentences) {
    const type = classifySentence(sentence);
    if (!type) continue;

    let importance = importanceForType(type);
    // T4.2 — NE arousal multiplier: when NE high, sweep more aggressively.
    importance = Math.min(1, importance * (1 + 0.25 * neuro.norepinephrine));
    // Skip low importance sentences unless user role
    if (importance < 0.5 && episode.role !== "user") continue;

    const label = sentence.slice(0, 60).replace(/\s+/g, " ");
    const existing = ftsSearchNodes(agentId, label, 3);
    const duplicate = existing.some((n) => jaccardSim(n.label, label) > 0.8);
    if (duplicate) continue;

    const id = writeNode(agentId, type, label, sentence, {
      importance,
      source: "sws",
      episode_ids: [episode.id],
      encodingContext: neuro,
      // SWS has its own Jaccard pre-check (line above). Disable the
      // trigram-gate so we don't double-skip and miss novel-but-related
      // extractions.
      deduplicate: false,
    });
    nodeIds.push(id);
    queueEmbedding(agentId, id);
    // Yield after each FTS-heavy sentence to keep event loop free
    await new Promise<void>((r) => setImmediate(r));
  }

  return nodeIds;
}

// ── NEXUS: cluster schema synthesis ───────────────────────────────────────────
// After SWS extraction, take the top-N recently-activated embedded nodes and
// cluster them by cosine similarity. Clusters of ≥3 members (connected via
// sim > NEXUS_CLUSTER_SIM) get a new `schema` node whose embedding is the
// L2-normalized centroid of the cluster. Members link to the schema node via
// `instance_of` edges.
//
// Superbrain advantage: humans form implicit schemas from exposure but can't
// retrieve "what category does this belong to?" as a first-class memory query.
// We write the schema as an explicit node — it participates in spreading
// activation, is recalled by the proactive monitor, and serves as an
// activation hub that surfaces all cluster members in a single BFS hop.
const NEXUS_CLUSTER_SIM = 0.72;   // adjacency threshold (= ARIA_SIM_LOW, top of "related but distinct")
const NEXUS_MIN_SIZE = 3;          // minimum cluster members to justify a schema node
const NEXUS_DEDUP_SIM = 0.85;     // if an existing schema node is this close, skip
const NEXUS_MAX_CANDIDATES = 50;  // O(n²) safety cap

async function runClusterSchemaPhase(agentId: string, log: Logger): Promise<void> {
  const db = getDb(agentId);
  const now = Date.now();

  // Candidates: embedded semantic/episodic nodes that the brain has recently
  // activated (ripple_count > 0 or high eligibility_trace from proactive monitor).
  const rows = db.prepare(`
    SELECT id, label, content, importance, embedding
    FROM nodes
    WHERE type IN ('semantic', 'episodic', 'pattern')
      AND embedding IS NOT NULL
      AND (ripple_count > 0 OR eligibility_trace > 0.3)
    ORDER BY ripple_count DESC, eligibility_trace DESC, salience DESC
    LIMIT ?
  `).all(NEXUS_MAX_CANDIDATES) as Array<{
    id: string; label: string; content: string;
    importance: number; embedding: Buffer;
  }>;

  if (rows.length < NEXUS_MIN_SIZE) return;

  // Convert embeddings once
  const candidates = rows.map(r => ({
    ...r,
    vec: bufferToFloat32(r.embedding),
  }));

  // Build adjacency: pairs with sim > NEXUS_CLUSTER_SIM
  const adj = new Map<string, Set<string>>();
  for (const c of candidates) adj.set(c.id, new Set());

  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const sim = cosineSimilarity(candidates[i].vec, candidates[j].vec);
      if (sim > NEXUS_CLUSTER_SIM) {
        adj.get(candidates[i].id)!.add(candidates[j].id);
        adj.get(candidates[j].id)!.add(candidates[i].id);
      }
    }
  }

  // Find connected components via BFS
  const visited = new Set<string>();
  const components: string[][] = [];
  const idToRow = new Map(candidates.map(c => [c.id, c]));

  for (const seed of candidates) {
    if (visited.has(seed.id)) continue;
    const queue = [seed.id];
    const component: string[] = [];
    while (queue.length > 0) {
      const cur = queue.shift()!;
      if (visited.has(cur)) continue;
      visited.add(cur);
      component.push(cur);
      for (const neighbor of adj.get(cur) ?? []) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }
    if (component.length >= NEXUS_MIN_SIZE) components.push(component);
  }

  if (components.length === 0) return;

  // Fetch existing schema nodes for dedup check
  const existingSchemas = db.prepare(
    "SELECT id, embedding FROM nodes WHERE type = 'schema' AND embedding IS NOT NULL"
  ).all() as Array<{ id: string; embedding: Buffer }>;
  const schemaVecs = existingSchemas.map(s => bufferToFloat32(s.embedding));

  let written = 0;

  for (const component of components) {
    const members = component.map(id => idToRow.get(id)!).filter(Boolean);
    if (members.length < NEXUS_MIN_SIZE) continue;

    // Compute centroid and L2-normalize it
    const dim = members[0].vec.length;
    const centroid = new Float32Array(dim);
    for (const m of members) {
      for (let i = 0; i < dim; i++) centroid[i] += m.vec[i];
    }
    let mag = 0;
    for (let i = 0; i < dim; i++) mag += centroid[i] * centroid[i];
    mag = Math.sqrt(mag);
    if (mag > 0) { for (let i = 0; i < dim; i++) centroid[i] /= mag; }

    // Dedup: skip if any existing schema node is very close to this centroid
    const tooClose = schemaVecs.some(sv => cosineSimilarity(centroid, sv) > NEXUS_DEDUP_SIM);
    if (tooClose) continue;

    // Synthesize label from the most common meaningful words across member labels
    const wordFreq = new Map<string, number>();
    for (const m of members) {
      for (const w of m.label.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/)) {
        if (w.length > 4) wordFreq.set(w, (wordFreq.get(w) ?? 0) + 1);
      }
    }
    const topWords = [...wordFreq.entries()]
      .filter(([, c]) => c >= 2)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 4)
      .map(([w]) => w);
    const schemaLabel = topWords.length >= 2
      ? `Schema: ${topWords.join(", ")}`
      : `Schema: ${members.sort((a, b) => b.importance - a.importance)[0].label.slice(0, 50)}`;

    const schemaContent = `Cluster schema of ${members.length} related nodes: ${
      members.slice(0, 5).map(m => m.label).join("; ")
    }`;

    const avgImportance = members.reduce((s, m) => s + m.importance, 0) / members.length;

    const schemaId = writeNode(agentId, "schema", schemaLabel, schemaContent, {
      importance: Math.min(1, avgImportance + 0.1),
      source: "nexus",
    });

    // Store centroid embedding directly (bypasses content-based re-embedding)
    const centroidBuf = Buffer.from(centroid.buffer);
    db.prepare("UPDATE nodes SET embedding = ? WHERE id = ?").run(centroidBuf, schemaId);
    try {
      db.prepare(
        "INSERT OR REPLACE INTO nodes_vec(rowid, embedding) SELECT rowid, ? FROM nodes WHERE id = ?"
      ).run(centroidBuf, schemaId);
    } catch { /* vec table may not exist in isolated tests */ }

    // Add centroid to dedup list for subsequent iterations
    schemaVecs.push(centroid);

    // Wire instance_of edges from each cluster member to the schema node
    db.transaction(() => {
      for (const m of members) {
        if (!edgeExists(agentId, m.id, schemaId, "instance_of")) {
          writeEdge(agentId, m.id, schemaId, "instance_of", { weight: 0.7 });
        }
      }
    })();

    written++;
    log.info(`[sharpwave] NEXUS: schema node "${schemaLabel}" (${members.length} members)`);
    await new Promise<void>((r) => setImmediate(r));
  }

  if (written > 0) {
    log.info(`[sharpwave] NEXUS: ${written} cluster schema node(s) written`);
  }
}

async function runReconsolidationPhase(agentId: string, sinceMs: number, log: Logger): Promise<void> {
  const db = getDb(agentId);
  const recentlyAccessed = db.prepare(`
    SELECT n.*
    FROM nodes n
    WHERE n.accessed_at > ? AND n.access_count > 1
    ORDER BY n.eligibility_trace DESC
    LIMIT 20
  `).all(sinceMs) as BrainNode[];

  // T3.3 (audit/code-2.md F1.4 + C2.2) — single-statement append.
  //
  // The previous code did read-then-write:
  //
  //     const node = SELECT * FROM nodes WHERE id = ?;
  //     // ... build enrichment ...
  //     UPDATE nodes SET content = ? WHERE id = ?;   // <-- lost-update window
  //
  // A concurrent writer (e.g. a brain_supersede tool call) between the SELECT
  // and the UPDATE would have its content overwritten by the stale read.
  //
  // The fix uses `SET content = content || ?` so the append is atomic against
  // any concurrent UPDATE on the same row.
  //
  // We still pre-screen for `[related:` so we don't accumulate duplicate
  // enrichment markers across consolidation runs.
  const append = db.prepare(
    "UPDATE nodes SET content = content || ?, updated_at = ? WHERE id = ? AND content NOT LIKE '%[related:%'"
  );

  for (let i = 0; i < recentlyAccessed.length; i++) {
    const node = recentlyAccessed[i];
    const neighbors = db.prepare(`
      SELECT n2.label, n2.content
      FROM edges e
      JOIN nodes n2 ON n2.id = e.to_id
      WHERE e.from_id = ? AND e.valid_until IS NULL AND n2.created_at > ?
        AND e.type IN ('associates','associated_with')
      LIMIT 3
    `).all(node.id, sinceMs) as Array<{ label: string; content: string }>;

    if (neighbors.length > 0) {
      const enrichment = " " + neighbors.map((n) => `[related: ${n.label}]`).join(" ");
      append.run(enrichment, Date.now(), node.id);
    }
    if (i % 5 === 4) await new Promise<void>((r) => setImmediate(r));
  }

  log.info(`[sharpwave] reconsolidation: updated ${recentlyAccessed.length} recently-accessed nodes`);
}

async function runRemPhase(agentId: string, config: BrainConfig, log: Logger): Promise<void> {
  const db = getDb(agentId);

  // T4.5 — Generative REM via subagent. The runner is injected by index.ts
  // at gateway_start (Agent C). When unavailable OR when config disables it,
  // fall back to the v3 keyword bucketing. Default is enabled per task spec.
  const remGenerativeEnabled = (config as unknown as { remGenerativeEnabled?: boolean }).remGenerativeEnabled ?? true;
  const canRunGenerative = remGenerativeEnabled && (subagentRunner !== null || !!config.openRouterApiKey);
  let usedGenerative = false;
  if (canRunGenerative) {
    try {
      const generated = await runGenerativeRem(agentId, config, log);
      usedGenerative = generated > 0;
      if (generated > 0) {
        log.info(`[sharpwave] REM (generative): ${generated} schema/pattern node(s) from subagent recombination`);
      }
    } catch (err) {
      log.warn(`[sharpwave] REM generative failed: ${String(err)} — falling back to keyword bucketing`);
    }
  }
  if (!usedGenerative) {
    await runRemKeywordBuckets(agentId, log);
  }

  // Contradiction detection — CHANGELOG.md:88 contract: route candidates
  // through an LLM subagent rather than regex+Jaccard, which misses
  // contradictions stated without an English negation marker and false-flags
  // unrelated nodes that happen to share vocabulary. Jaccard remains as the
  // cheap prefilter to bound the N^2 candidate set sent to the LLM.
  const semanticNodes = db.prepare(
    "SELECT * FROM nodes WHERE type = 'semantic' ORDER BY created_at DESC LIMIT 50"
  ).all() as BrainNode[];

  if (subagentRunner) {
    await detectContradictionsViaSubagent(agentId, semanticNodes, config, log);
  } else {
    // Graceful degrade: keep v3 regex+Jaccard behavior when no subagent runner
    // is wired (isolated unit tests, ingestion-only deployments, etc.).
    log.warn(`[sharpwave] REM: subagentRunner unavailable, falling back to regex+Jaccard contradiction detection for agent=${agentId}`);
    await detectContradictionsViaRegex(agentId, semanticNodes, log);
  }

  // Entity merge: resolve coreferences
  const merged = mergeCoreferentNodes(agentId, log);
  if (merged > 0) {
    log.info(`[sharpwave] REM: merged ${merged} coreference(s)`);
  }

  // Skill evolution candidates
  if (config.skillEvolution) {
    const candidates = detectSkillCandidates(agentId, config);
    if (candidates.length > 0) {
      log.info(`[sharpwave] REM: ${candidates.length} skill candidate(s) ready`);
    }
  }

  // T4.8 — Affective decay (overnight-therapy hypothesis, van der Helm & Walker).
  // Multiply emotional_weight by 0.9 on nodes accessed > 7 days ago. The
  // content persists; the charge fades. Caps emotional valence accumulation
  // over months/years of accumulated semantic memory.
  //
  // NOTE: filtering on `accessed_at` rather than `updated_at` because SWS
  // downscaling refreshes `updated_at` on every consolidation pass — using
  // `updated_at` would mean the decay never fires after the first run.
  // accessed_at tracks "last user-visible touch" and is stable across
  // consolidation work.
  const affective = db.prepare(`
    UPDATE nodes
    SET emotional_weight = emotional_weight * 0.9,
        updated_at       = ?
    WHERE accessed_at < ?
      AND ABS(emotional_weight) > 0.01
  `).run(Date.now(), Date.now() - 7 * 86400000);
  if (affective.changes > 0) {
    log.info(`[sharpwave] REM: affective decay (-10%) on ${affective.changes} aged node(s)`);
  }
}

/**
 * T4.5 — Generative REM phase via subagent recombination.
 *
 * Picks top-N episode clusters by ripple_count (the audit's "tagging" signal)
 * and asks an LLM subagent: "what abstraction or hypothesis unifies these?"
 * The response is parsed into pattern/schema nodes and linked to the
 * constituent episodes via instance_of edges.
 *
 * Why this exists: v3's REM was keyword bucketing on a hardcoded 14-word
 * dictionary, which is not pattern extraction in any cognitive sense — see
 * audit/neuro-2.md §2.2 ("Verdict on REM: Heavily misnamed"). Real REM is
 * hypothesized to do creative recombination and gist abstraction.
 */
async function runGenerativeRem(agentId: string, config: BrainConfig, log: Logger): Promise<number> {
  if (!subagentRunner && !config.openRouterApiKey) return 0;
  const db = getDb(agentId);

  // Cluster recent episodic nodes by shared ripple_count buckets — high-ripple
  // episodes are the ones the brain "selected" via awake SWRs (Joo et al. 2024).
  const candidates = db.prepare(`
    SELECT id, type, label, content, ripple_count
    FROM nodes
    WHERE type IN ('episodic', 'semantic')
      AND ripple_count > 0
    ORDER BY ripple_count DESC, salience DESC
    LIMIT 24
  `).all() as Array<{ id: string; type: string; label: string; content: string; ripple_count: number }>;

  if (candidates.length < 3) return 0;

  // 3 clusters of 4-8 nodes each. We use simple chunks ordered by ripple
  // strength — a future improvement would be embedding-space clustering.
  const clusters: typeof candidates[] = [];
  const CLUSTER_SIZE = Math.min(6, Math.ceil(candidates.length / 3));
  for (let i = 0; i < candidates.length && clusters.length < 3; i += CLUSTER_SIZE) {
    clusters.push(candidates.slice(i, i + CLUSTER_SIZE));
  }

  // REM model override: prefer config.remModel (Tier-4 T4.5) when operator
  // configured a separate model for generative recombination (e.g. Haiku for
  // clean JSON), otherwise fall through to ingestionModel.
  const model = config.remModel ?? config.ingestionModel;
  const jobId = Date.now().toString(36);

  let writtenCount = 0;
  for (let c = 0; c < clusters.length; c++) {
    const cluster = clusters[c];
    if (cluster.length < 2) continue;

    const prompt = buildRecombinationPrompt(cluster);
    let responseText: string;
    try {
      if (subagentRunner) {
        const result = await subagentRunner({ sessionKey: `rem-${jobId}-${c}`, message: prompt, model, deliver: false });
        responseText = result.text;
      } else {
        responseText = await callRemLlm(prompt, model, config.openRouterApiKey);
      }
    } catch (err) {
      log.warn(`[sharpwave] REM generative cluster ${c} LLM error: ${String(err)}`);
      continue;
    }

    const parsedNodes = parseGenerativeRemResponse(responseText);
    for (const p of parsedNodes) {
      const patternId = writeNode(agentId, p.type, p.label, p.content, {
        importance: p.importance,
        source: "rem-generative",
      });
      queueEmbedding(agentId, patternId);

      // Link generated abstraction back to its constituent episodes.
      for (const inst of cluster) {
        if (!edgeExists(agentId, inst.id, patternId, "instance_of")) {
          writeEdge(agentId, inst.id, patternId, "instance_of", { weight: 0.6 });
        }
      }
      writtenCount++;
    }
  }

  return writtenCount;
}

function buildRecombinationPrompt(
  cluster: Array<{ type: string; label: string; content: string }>,
): string {
  const lines = cluster.map((n, i) =>
    `${i + 1}. [${n.type}] ${n.label}: ${n.content.slice(0, 200)}`
  ).join("\n");
  return `You are the REM-phase recombination module of a graph-native memory system.
The nodes below were repeatedly co-activated during recent waking. Find any abstraction, schema, or hypothesis that unifies them — patterns the agent should remember even after the individual instances fade.

Nodes:
${lines}

Return a single JSON object — no other text:
{
  "abstractions": [
    {
      "type": "pattern" | "schema",
      "label": "<≤15 words>",
      "content": "<the abstraction in 1-2 sentences>",
      "importance": 0.0-1.0
    }
  ]
}

Return {"abstractions":[]} if no useful abstraction emerges. Up to 3 abstractions per response.`;
}

function parseGenerativeRemResponse(text: string): Array<{
  type: "pattern" | "schema";
  label: string;
  content: string;
  importance: number;
}> {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    const raw = Array.isArray(obj["abstractions"]) ? obj["abstractions"] as unknown[] : [];
    return raw
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map((item) => {
        const t = item["type"] === "schema" ? "schema" : "pattern";
        return {
          type: t as "pattern" | "schema",
          label: String(item["label"] ?? "").slice(0, 100),
          content: String(item["content"] ?? ""),
          importance: Math.min(1, Math.max(0, Number(item["importance"] ?? 0.6))),
        };
      })
      .filter((p) => p.label.length > 3 && p.content.length > 5);
  } catch {
    return [];
  }
}

/**
 * Subagent-driven contradiction detection — CHANGELOG.md:88 contract.
 *
 * v3 used a regex on the word "not" plus Jaccard > 0.5. That misses
 * contradictions phrased without an English negation marker (X says "A is
 * red", Y says "A is blue") and false-flags topically-overlapping statements
 * as contradicting just because one happens to contain "not". v4 routes
 * candidate pairs through an LLM subagent.
 *
 * Strategy:
 *  1. Cheap Jaccard prefilter (sim > 0.3) over all N^2 semantic-node pairs to
 *     find topically-overlapping candidates. Bounds the LLM call set.
 *  2. Take the top-K by similarity, send to subagent for the actual
 *     contradiction judgment. K is capped to keep REM-tick cost bounded.
 *  3. Write `contradicts` edges only for pairs the subagent confirms.
 */
async function detectContradictionsViaSubagent(
  agentId: string,
  semanticNodes: BrainNode[],
  config: BrainConfig,
  log: Logger,
): Promise<void> {
  if (!subagentRunner && !config.openRouterApiKey) return;
  if (semanticNodes.length < 2) return;

  // Step 1: Jaccard prefilter — collect candidate pairs above topical overlap.
  type Candidate = { a: BrainNode; b: BrainNode; sim: number };
  const candidates: Candidate[] = [];
  let pairCount = 0;
  for (let i = 0; i < semanticNodes.length; i++) {
    for (let j = i + 1; j < semanticNodes.length; j++) {
      if (++pairCount % 25 === 0) await new Promise<void>((r) => setImmediate(r));
      const a = semanticNodes[i];
      const b = semanticNodes[j];
      const sim = jaccardSim(a.content, b.content);
      if (sim > 0.3) candidates.push({ a, b, sim });
    }
  }

  if (candidates.length === 0) return;

  // Step 2: Take top-K by similarity. K=8 keeps a REM tick cheap; the highest-
  // similarity pairs are the ones most likely to actually contradict.
  const K = 8;
  candidates.sort((x, y) => y.sim - x.sim);
  const topPairs = candidates.slice(0, K);

  const prompt = buildContradictionPrompt(topPairs);
  const model = config.remModel ?? config.ingestionModel;
  const jobId = Date.now().toString(36);

  let responseText: string;
  try {
    if (subagentRunner) {
      const result = await subagentRunner({ sessionKey: `rem-contradict-${jobId}`, message: prompt, model, deliver: false });
      responseText = result.text;
    } else {
      responseText = await callRemLlm(prompt, model, config.openRouterApiKey);
    }
  } catch (err) {
    log.warn(`[sharpwave] REM: contradiction LLM error: ${String(err)} — skipping this tick`);
    return;
  }

  const confirmed = parseContradictionResponse(responseText);
  if (confirmed.length === 0) return;

  // Step 3: Write `contradicts` edges for confirmed pairs only.
  for (const c of confirmed) {
    const pair = topPairs.find((p) => p.a.id === c.aId && p.b.id === c.bId)
      ?? topPairs.find((p) => p.a.id === c.bId && p.b.id === c.aId);
    if (!pair) continue;
    if (!edgeExists(agentId, pair.a.id, pair.b.id, "contradicts")) {
      writeEdge(agentId, pair.a.id, pair.b.id, "contradicts", { weight: 0.8 });
      log.info(`[sharpwave] REM: contradiction (subagent-confirmed): "${pair.a.label}" vs "${pair.b.label}" — ${c.reason.slice(0, 120)}`);
    }
  }
}

function buildContradictionPrompt(pairs: Array<{ a: BrainNode; b: BrainNode; sim: number }>): string {
  const lines = pairs.map((p, i) =>
    `${i + 1}. A[id=${p.a.id}, label="${p.a.label}"]: ${p.a.content.slice(0, 240)}\n   B[id=${p.b.id}, label="${p.b.label}"]: ${p.b.content.slice(0, 240)}`
  ).join("\n\n");
  return `You are the REM-phase contradiction detector for a graph-native memory system.
For each pair below, decide if statement A and statement B actually CONTRADICT one another — i.e. they cannot both be true about the same subject. Topical overlap is not enough; one must actually assert the negation of, or be incompatible with, the other.

Pairs:
${lines}

Return a single JSON object — no other text:
{
  "contradictions": [
    {
      "a_id": "<id from above>",
      "b_id": "<id from above>",
      "reason": "<one short sentence explaining the incompatibility>"
    }
  ]
}

Return {"contradictions":[]} if none of the pairs actually contradict.`;
}

function parseContradictionResponse(text: string): Array<{ aId: string; bId: string; reason: string }> {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return [];
    const obj = JSON.parse(match[0]) as Record<string, unknown>;
    const raw = Array.isArray(obj["contradictions"]) ? obj["contradictions"] as unknown[] : [];
    return raw
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map((item) => ({
        aId: String(item["a_id"] ?? ""),
        bId: String(item["b_id"] ?? ""),
        reason: String(item["reason"] ?? ""),
      }))
      .filter((c) => c.aId.length > 0 && c.bId.length > 0 && c.aId !== c.bId);
  } catch {
    return [];
  }
}

/**
 * Legacy regex+Jaccard contradiction detection. Retained as graceful-degrade
 * fallback when subagentRunner is unavailable (isolated tests, ingestion-only
 * deployments). Audit-acknowledged as weak: misses contradictions phrased
 * without an English negation marker, false-flags topically-overlapping
 * statements as contradicting just because one contains "not".
 */
async function detectContradictionsViaRegex(
  agentId: string,
  semanticNodes: BrainNode[],
  log: Logger,
): Promise<void> {
  const NEGATION = /\b(not|never|don't|doesn't|can't|won't|isn't|aren't|wasn't|weren't|no |false|incorrect|wrong|impossible)\b/i;
  let pairCount = 0;
  for (let i = 0; i < semanticNodes.length; i++) {
    for (let j = i + 1; j < semanticNodes.length; j++) {
      if (++pairCount % 10 === 0) await new Promise<void>((r) => setImmediate(r));
      const a = semanticNodes[i];
      const b = semanticNodes[j];
      const sim = jaccardSim(a.content, b.content);
      const aNeg = NEGATION.test(a.content);
      const bNeg = NEGATION.test(b.content);
      if (sim > 0.5 && aNeg !== bNeg) {
        if (!edgeExists(agentId, a.id, b.id, "contradicts")) {
          writeEdge(agentId, a.id, b.id, "contradicts", { weight: 0.7 });
          log.info(`[sharpwave] REM: contradiction (regex-fallback): "${a.label}" vs "${b.label}"`);
        }
      }
    }
  }
}

/** Legacy keyword-bucketed REM pattern extraction. Retained as a fallback
 *  when the subagent runner is unavailable (e.g. during isolated unit tests
 *  or before Agent C wires the runner). Audit-acknowledged as biologically
 *  weak but not actively harmful. */
async function runRemKeywordBuckets(agentId: string, log: Logger): Promise<void> {
  // CHANGELOG.md:97 contract: emit a deprecation warning on every fallback run.
  // Keyword-bucket REM is the v3 14-word whitelist; v4 prefers generative
  // recombination via subagent (runGenerativeRem). v5 removes the fallback.
  log.warn(`[sharpwave] REM keyword-bucket fallback running for agent=${agentId} — DEPRECATED, will be removed in v5; configure remGenerativeEnabled + subagentRunner to use the generative path`);
  const db = getDb(agentId);
  const episodicNodes = db.prepare(
    "SELECT * FROM nodes WHERE type = 'episodic' ORDER BY salience DESC LIMIT 100"
  ).all() as BrainNode[];

  const keywordGroups = new Map<string, BrainNode[]>();
  const KEYWORDS = [
    "config", "debug", "error", "build", "deploy", "memory", "goal",
    "morning", "plan", "work", "code", "test", "session", "agent",
  ];

  for (const node of episodicNodes) {
    const lower = node.content.toLowerCase();
    for (const kw of KEYWORDS) {
      if (lower.includes(kw)) {
        const group = keywordGroups.get(kw) ?? [];
        group.push(node);
        keywordGroups.set(kw, group);
      }
    }
  }

  for (const [keyword, group] of keywordGroups) {
    if (group.length < 3) continue;

    const patternLabel = `Pattern: recurring ${keyword} episodes`;
    const existing = ftsSearchNodes(agentId, patternLabel, 1);
    if (existing.length > 0 && jaccardSim(existing[0].label, patternLabel) > 0.7) continue;

    const patternId = writeNode(
      agentId,
      "pattern",
      patternLabel,
      `Observed ${group.length} episodes involving "${keyword}"`,
      { importance: 0.65, source: "rem" },
    );
    queueEmbedding(agentId, patternId);

    for (const instanceNode of group.slice(0, 10)) {
      if (!edgeExists(agentId, instanceNode.id, patternId, "instance_of")) {
        writeEdge(agentId, instanceNode.id, patternId, "instance_of", { weight: 0.8 });
      }
    }

    log.info(`[sharpwave] REM: pattern "${patternLabel}" (${group.length} instances)`);
  }
}

/**
 * Deep prune phase — T1.4 (audit/code-1.md fix #4, P0-3).
 *
 * Replaces the v3 "soft delete" (UPDATE salience=0) with a real physical
 * delete pipeline. Without this:
 *   - brain.db grows monotonically — every consolidation just zeros salience
 *   - nodes_fts and nodes_vec still index dead rows (vector search returns ghosts)
 *   - WAL never shrinks
 *
 * Cascade order matters because the schema declares
 *   edges.from_id REFERENCES nodes(id) (no ON DELETE)
 * so any node with active edges would fail FK on DELETE FROM nodes.
 *
 * Pipeline per candidate:
 *   1. DELETE FROM nodes_vec WHERE rowid = ?   (P0-3: clear vec rowid first
 *      so deleted ids don't surface from vector search even between the
 *      cascade trigger fire and final commit)
 *   2. DELETE FROM working_memory WHERE node_id = ?
 *   3. DELETE FROM node_associations WHERE ...
 *   4. DELETE FROM edges WHERE from_id = ? OR to_id = ?
 *   5. DELETE FROM nodes WHERE id = ?  (cascades to nodes_fts via existing
 *      AFTER DELETE trigger)
 *
 * Identity and goal nodes are protected — same exclusion as v3. Nodes
 * referenced by any active edge (valid_until IS NULL) are also skipped so
 * we never orphan a live graph.
 *
 * Periodic PRAGMA wal_checkpoint(TRUNCATE) after a batch prune is what
 * actually shrinks the on-disk file.
 */
function runDeepPhase(agentId: string, config: BrainConfig, log: Logger): void {
  const db = getDb(agentId);
  const cutoff = Date.now() - config.pruneAfterDays * 86400000;

  // Gather candidates in one query. UNION the two prune predicates that
  // existed in v3:
  //   (a) retrievability < 0.01 and not pinned and no live edges
  //   (b) old episodic with retrievability < 0.05 past cutoff
  const candidates = db.prepare(`
    SELECT n.id, n.rowid FROM nodes n
    WHERE n.retrievability < 0.01
      AND n.type NOT IN ('identity', 'goal')
      AND NOT EXISTS (
        SELECT 1 FROM edges e
        WHERE (e.from_id = n.id OR e.to_id = n.id) AND e.valid_until IS NULL
      )
    UNION
    SELECT n.id, n.rowid FROM nodes n
    WHERE n.type = 'episodic'
      AND n.created_at < ?
      AND n.retrievability < 0.05
      AND n.type NOT IN ('identity', 'goal')
      AND NOT EXISTS (
        SELECT 1 FROM edges e
        WHERE (e.from_id = n.id OR e.to_id = n.id) AND e.valid_until IS NULL
      )
  `).all(cutoff) as { id: string; rowid: number }[];

  if (candidates.length === 0) return;

  const delVec = db.prepare("DELETE FROM nodes_vec WHERE rowid = ?");
  const delWm = db.prepare("DELETE FROM working_memory WHERE node_id = ?");
  const delAssoc = db.prepare("DELETE FROM node_associations WHERE node_id_a = ? OR node_id_b = ?");
  const delEdges = db.prepare("DELETE FROM edges WHERE from_id = ? OR to_id = ?");
  const delNode = db.prepare("DELETE FROM nodes WHERE id = ?");

  let deleted = 0;
  db.transaction(() => {
    for (const c of candidates) {
      // 1. Clear vec rowid first (P0-3 — close the window where a deleted
      //    node's old embedding could surface via vector search).
      try { delVec.run(c.rowid); } catch { /* nodes_vec may not be loaded */ }
      // 2-4. Cascade local references.
      delWm.run(c.id);
      delAssoc.run(c.id, c.id);
      delEdges.run(c.id, c.id);
      // 5. Finally the row itself — FTS delete trigger fires from this.
      delNode.run(c.id);
      deleted++;
    }
  })();

  if (deleted > 0) {
    log.info(`[sharpwave] Deep: physically pruned ${deleted} node(s)`);
  }

  // Reclaim disk space. WAL checkpoint(TRUNCATE) merges WAL back into the
  // main file and zeroes the WAL. Without this the file grows even after
  // DELETE because WAL retains the pages.
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch (err) {
    log.warn(`[sharpwave] Deep: wal_checkpoint failed: ${String(err)}`);
  }
}

/**
 * Physically delete a single node by id. Same cascade order as runDeepPhase
 * to preserve FK integrity and close the nodes_vec stale-rowid window (P0-3).
 *
 * Refuses to delete `identity` and `goal` nodes; refuses if the node is
 * referenced by any active edge (valid_until IS NULL) unless `force=true`.
 *
 * Returns:
 *   { ok: true, deleted: 1 } on success
 *   { ok: false, reason }    on refusal (with reason text)
 *   { ok: false, reason: "not_found" } if no such node
 */
export function forgetNodeById(
  agentId: string,
  nodeId: string,
  log: Logger,
  opts: { force?: boolean } = {},
): { ok: boolean; deleted: number; reason?: string } {
  const db = getDb(agentId);

  const row = db
    .prepare("SELECT id, rowid, type FROM nodes WHERE id = ?")
    .get(nodeId) as { id: string; rowid: number; type: string } | undefined;
  if (!row) return { ok: false, deleted: 0, reason: "not_found" };

  if (row.type === "identity" || row.type === "goal") {
    return { ok: false, deleted: 0, reason: `protected_type:${row.type}` };
  }

  if (!opts.force) {
    const liveEdges = db
      .prepare(
        `SELECT COUNT(*) as n FROM edges
         WHERE (from_id = ? OR to_id = ?) AND valid_until IS NULL`,
      )
      .get(nodeId, nodeId) as { n: number };
    if (liveEdges.n > 0) {
      return {
        ok: false,
        deleted: 0,
        reason: `has_live_edges:${liveEdges.n}`,
      };
    }
  }

  const delVec = db.prepare("DELETE FROM nodes_vec WHERE rowid = ?");
  const delWm = db.prepare("DELETE FROM working_memory WHERE node_id = ?");
  const delAssoc = db.prepare(
    "DELETE FROM node_associations WHERE node_id_a = ? OR node_id_b = ?",
  );
  const delEdges = db.prepare(
    "DELETE FROM edges WHERE from_id = ? OR to_id = ?",
  );
  const delNode = db.prepare("DELETE FROM nodes WHERE id = ?");

  executeWithWalRetrySync(
    db,
    (d) => {
      d.transaction(() => {
        try { delVec.run(row.rowid); } catch { /* nodes_vec may not be loaded */ }
        delWm.run(nodeId);
        delAssoc.run(nodeId, nodeId);
        delEdges.run(nodeId, nodeId);
        delNode.run(nodeId);
      })();
    },
    { op: `nodes.forget:${nodeId.slice(0, 8)}` },
  );
  bumpWriteCounter(db);
  bumpCounter("memories_forgotten");
  logObservabilityEvent("forget", { nodeId, type: row.type });

  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch (err) {
    log.warn(`[sharpwave] forgetNodeById: wal_checkpoint failed: ${String(err)}`);
  }

  log.info(
    JSON.stringify({
      op: "brain_forget",
      agentId,
      nodeId,
      type: row.type,
      outcome: "ok",
    }),
  );

  return { ok: true, deleted: 1 };
}
