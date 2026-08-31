import { getDb, getMeta, setMeta } from "./db.js";
import { writeEdge, edgeExistsEitherDirection } from "./edges.js";
import { getNeighbors } from "./nodes.js";
import type { BrainConfig } from "./types.js";

type Logger = { info: (msg: string) => void; warn: (msg: string) => void };

/**
 * Awake SWR-analog tick — runs every 30 minutes while the gateway is live
 * (in-process interval armed in index.ts gateway_start).
 *
 * Science basis:
 * - Hippocampal SWRs occur 14-22/min during quiet wakefulness (eNeuro 2025)
 * - 10-20 min rest windows produce measurable offline memory consolidation gains
 * - Hebbian co-activation: nodes that fire together wire together
 * - DMN generates associative links between disparate memories during idle periods
 * - Joo et al. (Science 2024): awake SWRs replay both retrospective traces AND
 *   PROSPECTIVE future trajectories that the animal has not yet taken
 *
 * What this does:
 * 1. Stabilizes recently-activated (high ripple_count) nodes — awake replay benefit
 * 2. Forms Hebbian "associates" edges from cross-session co-activation patterns
 * 3. Prospective replay (T4.6): samples high-weight neighbors of active goals
 *    and pre-activates them so the next session pre-stages relevant context.
 *    This is the second half of the Joo et al. 2024 cited finding that v3
 *    implemented only retrospectively.
 * 4. Builds a dream context snapshot stored in meta_kv for auto-injection at
 *    next session.
 */
export async function awakeReplayTick(
  agentId: string,
  config: BrainConfig,
  log: Logger,
): Promise<void> {
  try {
    const db = getDb(agentId);
    // All four sub-phases run synchronously up front so that test code which
    // calls `awakeReplayTick(...)` without awaiting (the historical contract)
    // still observes the effects on the next statement. The trailing
    // `await setImmediate` yields the event loop once at the end so the
    // gateway tick scheduler can interleave other agents.
    const replayed = replayHighRippleNodes(agentId, db);
    formHebbianEdgesSync(agentId, db, log);
    // T4.6 — prospective replay (Joo et al. 2024 Science): pre-stage neighbors
    // of active goals so the next reasoning step finds them already warm.
    const prospectivelyActivated = prospectiveReplay(agentId, db);
    buildDreamContext(agentId, db, replayed);
    await new Promise<void>((r) => setImmediate(r));
    if (replayed > 0) {
      log.info(`[clawbrain-v4] awake replay: ${replayed} nodes stabilized (agent=${agentId})`);
    }
    if (prospectivelyActivated > 0) {
      log.info(`[clawbrain-v4] awake replay: ${prospectivelyActivated} prospective node(s) pre-activated (agent=${agentId})`);
    }
  } catch (err) {
    log.warn(`[clawbrain-v4] awakeReplayTick error (agent=${agentId}): ${String(err)}`);
  }
}

/**
 * Record which nodes were co-active in a session's working memory.
 * Called at session_end BEFORE working memory is cleared.
 *
 * Hebbian principle: nodes that fire together wire together.
 * Each session where both nodes are active increments their association count.
 * When count >= 3, a real "associates" edge is formed during the next awake tick.
 */
export function recordCoactivations(agentId: string, sessionId: string): void {
  const db = getDb(agentId);
  const nodes = db.prepare(
    "SELECT node_id, activation FROM working_memory WHERE session_id = ? ORDER BY activation DESC LIMIT 20"
  ).all(sessionId) as { node_id: string; activation: number }[];

  if (nodes.length < 2) return;

  const now = Date.now();
  const upsert = db.prepare(`
    INSERT INTO node_associations (node_id_a, node_id_b, count, strength, last_coactivated)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(node_id_a, node_id_b) DO UPDATE SET
      count = count + 1,
      strength = MIN(1.0, strength + 0.15),
      last_coactivated = excluded.last_coactivated
  `);

  db.transaction(() => {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i].node_id;
        const b = nodes[j].node_id;
        // Canonical ordering — smaller id first — ensures deduplication
        const [idA, idB] = a < b ? [a, b] : [b, a];
        const initStrength = Math.min(0.2, (nodes[i].activation + nodes[j].activation) * 0.05);
        upsert.run(idA, idB, initStrength, now);
      }
    }
  })();
}

// ── Internal phases ────────────────────────────────────────────────────────────

// Per-day replay ledger key in meta_kv. Opus audit #12: without dedup, the
// same high-ripple nodes were bumped ×1.05 on EVERY tick (~48/day → ~10× daily
// stability growth), decoupling stability from review evidence. Each node now
// gets at most one replay bump per calendar day. ripple_count itself is left
// intact — REM/NEXUS candidate selection depends on it until runConsolidation
// resets it.
const REPLAY_LEDGER_KEY = "awake_replayed_day";
const REPLAY_LEDGER_MAX_IDS = 1000;

function replayHighRippleNodes(
  agentId: string,
  db: ReturnType<typeof getDb>,
): number {
  const rippled = db.prepare(`
    SELECT id FROM nodes
    WHERE ripple_count > 0 AND retrievability > 0.05
    ORDER BY ripple_count DESC, salience DESC
    LIMIT 30
  `).all() as { id: string }[];

  if (rippled.length === 0) return 0;

  // Load today's replay ledger; a stale (previous-day) ledger resets.
  const today = new Date().toISOString().slice(0, 10);
  let replayedToday = new Set<string>();
  try {
    const raw = getMeta(agentId, REPLAY_LEDGER_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as { day?: string; ids?: string[] };
      if (parsed.day === today && Array.isArray(parsed.ids)) {
        replayedToday = new Set(parsed.ids);
      }
    }
  } catch { /* malformed ledger — treat as empty */ }

  const fresh = rippled.filter((r) => !replayedToday.has(r.id));
  if (fresh.length === 0) return 0;

  const now = Date.now();
  // Awake replay mildly stabilizes memories (small but real offline gain)
  const bump = db.prepare(`
    UPDATE nodes
    SET stability = MIN(stability * 1.05, 365.0),
        retrievability = MIN(retrievability * 1.02, 1.0),
        updated_at = ?
    WHERE id = ?
  `);

  db.transaction(() => {
    for (const { id } of fresh) {
      bump.run(now, id);
    }
  })();

  for (const { id } of fresh) replayedToday.add(id);
  const ids = [...replayedToday].slice(-REPLAY_LEDGER_MAX_IDS);
  setMeta(agentId, REPLAY_LEDGER_KEY, JSON.stringify({ day: today, ids }));

  return fresh.length;
}

/**
 * Form Hebbian "associates" edges from co-activation evidence.
 *
 * The function is fully synchronous so that test code which fire-and-forgets
 * `awakeReplayTick(...)` still sees its effects on the next statement. Edge
 * volume is bounded by `LIMIT 50` so this stays well under a millisecond
 * even on agents with thousands of associations.
 */
function formHebbianEdgesSync(
  agentId: string,
  db: ReturnType<typeof getDb>,
  log: Logger,
): void {
  const candidates = db.prepare(`
    SELECT na.node_id_a, na.node_id_b, na.strength
    FROM node_associations na
    JOIN nodes n1 ON n1.id = na.node_id_a
    JOIN nodes n2 ON n2.id = na.node_id_b
    WHERE na.count >= 3 AND na.strength >= 0.35
      AND n1.retrievability > 0.05 AND n2.retrievability > 0.05
    ORDER BY na.strength DESC
    LIMIT 50
  `).all() as { node_id_a: string; node_id_b: string; strength: number }[];

  let formed = 0;
  for (const { node_id_a, node_id_b, strength } of candidates) {
    // Direction-agnostic (F-8): an autoLink edge written B→A must block a
    // duplicate Hebbian A→B — associates is symmetric.
    if (!edgeExistsEitherDirection(agentId, node_id_a, node_id_b, "associates")) {
      writeEdge(agentId, node_id_a, node_id_b, "associates", { weight: strength });
      formed++;
    }
  }

  if (formed > 0) {
    log.info(`[clawbrain-v4] Hebbian: ${formed} associate edge(s) formed (agent=${agentId})`);
  }
}

/**
 * T4.6 — Prospective replay (Joo et al. 2024 Science).
 *
 * Awake SWRs replay not just past trajectories but possible future ones.
 * The cognitive analog: from each active goal, sample its top-K neighbors
 * (by edge weight) and pre-activate them so they're more retrievable when
 * the next reasoning step touches the goal.
 *
 * Implementation:
 *   - Find active goal nodes (type='goal' AND retrievability > 0.1).
 *   - For each, getNeighbors() and rank by weight.
 *   - For the top 3 per goal, give a +0.1 importance bump (capped at 1.0)
 *     plus a +0.05 eligibility_trace bump. These are mild — we are NOT
 *     consolidating, just pre-staging.
 *
 * Why not strengthen stability/retrievability directly? Because that would
 * conflate prospective bias with rehearsed reinforcement — the SWR
 * literature is specific that prospective replay biases *which* memories
 * surface, not how strongly they are encoded.
 */
function prospectiveReplay(
  agentId: string,
  db: ReturnType<typeof getDb>,
): number {
  const goals = db.prepare(
    "SELECT id FROM nodes WHERE type = 'goal' AND retrievability > 0.1 ORDER BY salience DESC LIMIT 5"
  ).all() as { id: string }[];

  if (goals.length === 0) return 0;

  const TOP_K = 3;
  const now = Date.now();
  const seen = new Set<string>();
  // Track the candidates to bump in one transaction.
  const bumps: string[] = [];

  for (const g of goals) {
    const neighbors = getNeighbors(agentId, g.id);
    // Inhibitory neighbors are not pre-activated.
    const filtered = neighbors.filter((n) =>
      n.edgeType !== "inhibits" &&
      n.edgeType !== "contradicts" &&
      n.edgeType !== "supersedes" &&
      n.node.type !== "goal" &&  // don't pre-activate other goals — that pollutes the goal stack
      !seen.has(n.node.id),
    );
    filtered.sort((a, b) => b.weight - a.weight);

    for (const cand of filtered.slice(0, TOP_K)) {
      seen.add(cand.node.id);
      bumps.push(cand.node.id);
    }
  }

  if (bumps.length === 0) return 0;

  const bump = db.prepare(`
    UPDATE nodes
    SET importance        = MIN(importance + 0.1, 1.0),
        eligibility_trace = MIN(eligibility_trace + 0.05, 1.0),
        updated_at        = ?
    WHERE id = ?
  `);

  db.transaction(() => {
    for (const id of bumps) bump.run(now, id);
  })();

  return bumps.length;
}

function buildDreamContext(
  agentId: string,
  db: ReturnType<typeof getDb>,
  replayedCount: number,
): void {
  // Always build from what's been active, even if replay was empty this tick
  const activeNodes = db.prepare(`
    SELECT type, label, content
    FROM nodes
    WHERE retrievability > 0.1 AND access_count > 0
    ORDER BY (COALESCE(ripple_count, 0) * 0.4 + salience * 0.4 + eligibility_trace * 0.2) DESC
    LIMIT 10
  `).all() as { type: string; label: string; content: string }[];

  // Recently strengthened Hebbian pairs — "ideas linking in the background"
  const freshAssociates = db.prepare(`
    SELECT n1.label as label_a, n2.label as label_b
    FROM node_associations na
    JOIN nodes n1 ON n1.id = na.node_id_a
    JOIN nodes n2 ON n2.id = na.node_id_b
    WHERE na.last_coactivated > ? AND na.count >= 2
    ORDER BY na.strength DESC
    LIMIT 5
  `).all(Date.now() - 25 * 60 * 1000) as { label_a: string; label_b: string }[];

  if (activeNodes.length === 0 && freshAssociates.length === 0) return;

  const lines: string[] = [];
  for (const n of activeNodes) {
    lines.push(`[${n.type}] ${n.label}: ${n.content.slice(0, 110)}`);
  }
  for (const a of freshAssociates) {
    lines.push(`[linking] "${a.label_a}" ↔ "${a.label_b}"`);
  }

  setMeta(agentId, "dream_context", JSON.stringify({ ts: Date.now(), lines }));
}
