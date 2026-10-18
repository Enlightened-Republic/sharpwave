// packages/core/src/beliefs.ts
//
// Xanima 0.1.0 belief foundation: retract, supersede-with-reason (surfacing
// downstream nodes), as-of recall, the brain_status self-summary, and the
// sleep-time belief review pass.
//
// Mutations take a brain name (`agentId`, routed through core's getDb cache,
// exactly like writeNode). The read-only summaries take a raw
// better-sqlite3 handle so the brain service can run them on its read-only
// WAL connections.

import type Database from "better-sqlite3";
import { getDb, getMeta, setMeta, bumpWriteCounter, SCHEMA_VERSION } from "./db.js";
import { executeWithWalRetrySync } from "./wal-retry.js";
import { writeNode, getNode, ftsSearchNodes } from "./nodes.js";
import { writeEdge, closeEdgesFromNode, closeEdgesToNode } from "./edges.js";
import { relativeTime, confidenceLevel } from "./belief-meta.js";
import { isSilentReplyText, isInternalWakeText } from "./system-noise.js";
import type { BrainConfig, BrainNode, NodeType, SourceType, ConfidenceLevel, Sensitivity } from "./types.js";

type Log = { info: (m: string) => void; warn: (m: string) => void };

/** Edge types that make a neighbour "downstream" of a belief (it depended on it). */
export const DOWNSTREAM_EDGE_TYPES = [
  "supports", "used_in", "instance_of", "caused_by", "led_to", "derived_from",
  "summarizes", "goal_of", "drives", "attaches_to", "associates", "associated_with", "before", "after",
] as const;

export interface RelatedNode {
  id: string;
  type: string;
  label: string;
  edgeType: string;
  direction: "out" | "in";
  status: string;
  createdAt: number;
}

/**
 * Nodes 1 hop away from `nodeId` through live dependency-ish edges — the
 * things that may need re-checking when `nodeId` is retracted or replaced.
 * Ordered by edge strength (supports/used_in/derived_from first), then salience.
 */
export function relatedDownstream(db: Database.Database, nodeId: string, limit = 10): RelatedNode[] {
  const types = DOWNSTREAM_EDGE_TYPES.map((t) => `'${t}'`).join(",");
  const rows = db.prepare(`
    SELECT n.id, n.type, n.label, e.type AS edge_type, 'out' AS direction, n.status, n.created_at, n.salience, e.weight
      FROM edges e JOIN nodes n ON n.id = e.to_id
     WHERE e.from_id = ? AND e.valid_until IS NULL AND e.type IN (${types})
    UNION ALL
    SELECT n.id, n.type, n.label, e.type AS edge_type, 'in' AS direction, n.status, n.created_at, n.salience, e.weight
      FROM edges e JOIN nodes n ON n.id = e.from_id
     WHERE e.to_id = ? AND e.valid_until IS NULL AND e.type IN (${types})
  `).all(nodeId, nodeId) as Array<{ id: string; type: string; label: string; edge_type: string; direction: "out" | "in"; status: string; created_at: number; salience: number; weight: number }>;
  const rank = (t: string) => (["supports", "used_in", "derived_from", "led_to", "caused_by", "instance_of"].includes(t) ? 0 : 1);
  const seen = new Set<string>();
  return rows
    .filter((r) => r.id !== nodeId)
    .sort((a, b) => rank(a.edge_type) - rank(b.edge_type) || b.weight * b.salience - a.weight * a.salience)
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .slice(0, limit)
    .map((r) => ({ id: r.id, type: r.type, label: r.label, edgeType: r.edge_type, direction: r.direction, status: r.status ?? "active", createdAt: r.created_at }));
}

export function formatRelated(rel: RelatedNode[], idLen = 8): string {
  if (rel.length === 0) return "No downstream nodes were linked to it.";
  return [
    `Check these ${rel.length} related node(s) — they were linked to it and may depend on it:`,
    ...rel.map((r) => `  [${r.id.slice(0, idLen)}] (${r.type}) ${r.label} — ${r.direction === "out" ? "it" : "this"} --${r.edgeType}--> ${r.direction === "out" ? "this" : "it"}`),
  ].join("\n");
}

// ─── retract ───────────────────────────────────────────────────────────────

export interface RetractResult {
  ok: boolean;
  error?: string;
  node?: BrainNode;
  related: RelatedNode[];
}

/**
 * Retract a belief: it stays in the brain (history preserved — `as_of` before
 * the retraction still finds it) but is no longer current, so it is never
 * recalled or injected again. Edges are left in place for the audit trail; the
 * node's `valid_until` closes it for every recall path.
 */
export function retractNode(agentId: string, nodeId: string, reason: string, opts: { by?: string } = {}): RetractResult {
  const db = getDb(agentId);
  const node = getNode(agentId, nodeId);
  if (!node) return { ok: false, error: `node ${nodeId} not found`, related: [] };
  if (node.status === "retracted") return { ok: false, error: `node ${nodeId} is already retracted (${node.status_reason ?? "no reason recorded"})`, node, related: [] };
  const why = reason.trim().slice(0, 1000);
  if (!why) return { ok: false, error: "a reason is required to retract a belief", related: [] };
  const related = relatedDownstream(db, nodeId);
  const now = Date.now();
  executeWithWalRetrySync(db, (d) => {
    d.prepare(`
      UPDATE nodes SET status = 'retracted', status_reason = ?, status_changed_at = ?,
             valid_until = COALESCE(MIN(valid_until, ?), ?), contradicted_at = COALESCE(contradicted_at, ?),
             review_flagged_at = NULL, updated_at = ?
       WHERE id = ?
    `).run(opts.by ? `${why} (by ${opts.by})` : why, now, now, now, now, now, nodeId);
    d.prepare("DELETE FROM working_memory WHERE node_id = ?").run(nodeId);
  }, { op: `beliefs.retract:${nodeId.slice(0, 8)}` });
  bumpWriteCounter(db);
  return { ok: true, node: getNode(agentId, nodeId)!, related };
}

// ─── supersede ─────────────────────────────────────────────────────────────

export interface SupersedeOptions {
  newLabel?: string;
  reason?: string;
  source?: string;
  writerAgentId?: string;
  sourceType?: SourceType;
  confidence?: ConfidenceLevel | number;
  sensitivity?: Sensitivity;
}

export interface SupersedeResult {
  ok: boolean;
  error?: string;
  oldId?: string;
  newId?: string;
  related: RelatedNode[];
}

/**
 * Replace a belief with a corrected version. The old node is kept (status
 * superseded, valid_until = now, reason recorded) and linked from the new one
 * with a `supersedes` edge carrying the reason; its other live edges are
 * closed as before. Returns the downstream nodes that were linked to the old
 * belief so the caller can re-check them.
 */
export function supersedeNode(agentId: string, oldNodeId: string, newContent: string, opts: SupersedeOptions = {}): SupersedeResult {
  const db = getDb(agentId);
  const old = getNode(agentId, oldNodeId);
  if (!old) return { ok: false, error: `node ${oldNodeId} not found`, related: [] };
  const related = relatedDownstream(db, old.id);
  const reason = (opts.reason ?? "").trim().slice(0, 1000) || null;
  const newId = writeNode(agentId, old.type as NodeType, opts.newLabel ?? old.label, newContent, {
    importance: old.importance,
    emotional_weight: old.emotional_weight,
    source: opts.source,
    writerAgentId: opts.writerAgentId ?? agentId,
    deduplicate: false,
    ...(opts.sourceType ? { sourceType: opts.sourceType } : {}),
    ...(opts.confidence !== undefined ? { confidence: opts.confidence } : {}),
    sensitivity: opts.sensitivity ?? (old.sensitivity as Sensitivity | undefined) ?? "normal",
    evidence: [old.id],
  });
  closeEdgesFromNode(agentId, old.id);
  closeEdgesToNode(agentId, old.id);
  writeEdge(agentId, newId, old.id, "supersedes", { writerAgentId: opts.writerAgentId ?? agentId, ...(reason ? { meta: { reason } } : {}) });
  const now = Date.now();
  executeWithWalRetrySync(db, (d) => {
    d.prepare(`
      UPDATE nodes SET status = 'superseded', status_reason = ?, status_changed_at = ?,
             valid_until = COALESCE(MIN(valid_until, ?), ?), review_flagged_at = NULL, updated_at = ?
       WHERE id = ?
    `).run(reason ? `${reason} (superseded by ${newId})` : `superseded by ${newId}`, now, now, now, now, old.id);
    d.prepare("DELETE FROM working_memory WHERE node_id = ?").run(old.id);
  }, { op: `beliefs.supersede:${old.id.slice(0, 8)}` });
  bumpWriteCounter(db);
  return { ok: true, oldId: old.id, newId, related };
}

// ─── as_of ─────────────────────────────────────────────────────────────────

/** What the brain believed about `query` at `asOf` (epoch ms). Pure read; no reinforcement. */
export function queryAsOf(agentId: string, query: string, asOf: number, limit = 10): BrainNode[] {
  return ftsSearchNodes(agentId, query, limit, asOf);
}

/** Status of a node AT time `asOf` (it may have been retracted/superseded later). */
export function statusAt(n: BrainNode, asOf: number): { statusThen: string; laterChange: string | null } {
  const changed = n.status_changed_at ?? null;
  if (n.status && n.status !== "active" && changed && changed > asOf) {
    return { statusThen: "active", laterChange: `${n.status} ${relativeTime(changed)}${n.status_reason ? ` — ${n.status_reason}` : ""}` };
  }
  return { statusThen: n.status ?? "active", laterChange: null };
}

// ─── verify / mark ─────────────────────────────────────────────────────────

/** Mark a belief verified now, optionally raising its confidence. */
export function verifyNode(agentId: string, nodeId: string, confidence?: number): boolean {
  const db = getDb(agentId);
  const now = Date.now();
  const r = db.prepare(`
    UPDATE nodes SET verified_at = ?,
           confidence_score = COALESCE(?, MAX(confidence_score, 0.7)),
           confidence = ?, review_flagged_at = NULL, updated_at = ?
     WHERE id = ? AND status = 'active'
  `).run(now, confidence ?? null, confidenceLevel(confidence ?? 0.7), now, nodeId);
  return r.changes > 0;
}

// ─── self-status ───────────────────────────────────────────────────────────

export interface SleepSummary {
  at: number;
  durationMs: number;
  nodesBefore: number;
  nodesAfter: number;
  edgesBefore: number;
  edgesAfter: number;
  pruned: number;
  newContradictions: number;
  flaggedForReview: number;
  lowConfidence: number;
  contradicted: number;
  /** Of flaggedForReview: legacy rows that look like heartbeat / NO_REPLY noise. */
  legacyNoiseFlagged?: number;
}

export interface BrainStatus {
  schemaVersion: number;
  nodes: { total: number; active: number; retracted: number; superseded: number; archived: number };
  episodes: number;
  beliefs: {
    lowConfidence: number;
    contradicted: number;
    flaggedForReview: number;
    bySource: Record<string, number>;
    byConfidence: Record<string, number>;
  };
  hotConflicts: Array<{ a: { id: string; label: string }; b: { id: string; label: string }; since: number }>;
  lastSleep: { at: number | null; ago: string; summary: SleepSummary | null };
  injection: {
    budgetChars: number;
    headerChars: number;
    recallCapChars: number;
    estimatedTokens: number;
  };
  attention: string[];
}

const SLEEP_SUMMARY_KEY = "xanima:last_sleep_summary";
const DAY = 86_400_000;

/**
 * The brain's short operational self-summary (brain_status). Read-only and
 * cheap (a handful of COUNTs), so it is safe on every turn.
 */
export function computeBrainStatus(db: Database.Database, config: Pick<BrainConfig, "contextBudget" | "recallTopK"> & Partial<BrainConfig>, now: number = Date.now()): BrainStatus {
  const low = config.lowConfidenceThreshold ?? 0.4;
  const one = (sql: string, ...p: unknown[]) => ((db.prepare(sql).get(...p) as { n: number } | undefined)?.n ?? 0);
  const hasCol = (() => {
    try { return (db.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('nodes') WHERE name = 'status'").get() as { n: number }).n > 0; } catch { return false; }
  })();
  const total = one("SELECT COUNT(*) AS n FROM nodes");
  const live = "(valid_until IS NULL OR valid_until > ?)";
  const byStatus: Record<string, number> = { active: 0, retracted: 0, superseded: 0, archived: 0 };
  let lowConfidence = 0, contradicted = 0, flagged = 0;
  const bySource: Record<string, number> = {};
  const byConfidence: Record<string, number> = {};
  if (hasCol) {
    for (const r of db.prepare(`SELECT CASE WHEN status = 'active' AND NOT ${live} THEN 'archived' ELSE status END AS s, COUNT(*) AS n FROM nodes GROUP BY s`).all(now) as Array<{ s: string; n: number }>) byStatus[r.s] = (byStatus[r.s] ?? 0) + r.n;
    lowConfidence = one(`SELECT COUNT(*) AS n FROM nodes WHERE status = 'active' AND ${live} AND confidence_score < ?`, now, low);
    contradicted = one(`SELECT COUNT(*) AS n FROM nodes WHERE status = 'active' AND ${live} AND contradicted_at IS NOT NULL`, now);
    flagged = one(`SELECT COUNT(*) AS n FROM nodes WHERE status = 'active' AND ${live} AND review_flagged_at IS NOT NULL`, now);
    for (const r of db.prepare(`SELECT source_type AS k, COUNT(*) AS n FROM nodes WHERE status = 'active' AND ${live} GROUP BY k`).all(now) as Array<{ k: string; n: number }>) bySource[r.k] = r.n;
    for (const r of db.prepare(`SELECT confidence AS k, COUNT(*) AS n FROM nodes WHERE status = 'active' AND ${live} GROUP BY k`).all(now) as Array<{ k: string; n: number }>) byConfidence[r.k] = r.n;
  } else {
    byStatus["active"] = one(`SELECT COUNT(*) AS n FROM nodes WHERE ${live}`, now);
    byStatus["archived"] = total - byStatus["active"]!;
  }
  const episodes = one("SELECT COUNT(*) AS n FROM episodes");

  // Hot conflicts: live contradicts edges between two still-current nodes, newest first.
  const conflicts = db.prepare(`
    SELECT a.id AS aid, a.label AS al, b.id AS bid, b.label AS bl, e.created_at AS at
      FROM edges e JOIN nodes a ON a.id = e.from_id JOIN nodes b ON b.id = e.to_id
     WHERE e.type = 'contradicts' AND e.valid_until IS NULL
       AND (a.valid_until IS NULL OR a.valid_until > ?) AND (b.valid_until IS NULL OR b.valid_until > ?)
     ORDER BY e.created_at DESC LIMIT 5
  `).all(now, now) as Array<{ aid: string; al: string; bid: string; bl: string; at: number }>;

  let lastAt: number | null = null;
  try {
    const r = db.prepare("SELECT value FROM meta_kv WHERE key = 'last_consolidation'").get() as { value: string } | undefined;
    if (r?.value) lastAt = Number(r.value) || null;
  } catch { /* */ }
  let summary: SleepSummary | null = null;
  try {
    const r = db.prepare("SELECT value FROM meta_kv WHERE key = ?").get(SLEEP_SUMMARY_KEY) as { value: string } | undefined;
    if (r?.value) summary = JSON.parse(r.value) as SleepSummary;
  } catch { /* */ }

  // Injection budget estimate: identity + user model + top goals (the header)
  // plus the recall block cap. Mirrors context-assembly's caps without running
  // retrieval (which would mutate the brain).
  let headerChars = 0;
  try {
    const sm = db.prepare("SELECT identity, user_model FROM self_model WHERE id = 'singleton'").get() as { identity: string; user_model: string } | undefined;
    headerChars += Math.min(400, sm?.identity?.length ?? 0) + Math.min(300, sm?.user_model && sm.user_model !== "{}" ? sm.user_model.length : 0);
    const goals = db.prepare(`SELECT label FROM nodes WHERE type = 'goal' AND ${live} ORDER BY salience DESC LIMIT 3`).all(now) as Array<{ label: string }>;
    headerChars += goals.reduce((s, g) => s + g.label.length + 3, 0);
  } catch { /* */ }
  headerChars += 220; // banner + neuromodulator line
  const recallCapChars = (config.recallTopK ?? 10) * 260;
  const budgetChars = (config.contextBudget ?? 2000) * 4;

  const attention: string[] = [];
  if (contradicted > 0) attention.push(`${contradicted} disputed belief${contradicted === 1 ? "" : "s"} (contradiction found) — review with brain_status / brain_retract / brain_supersede`);
  if (flagged > 0 && flagged !== contradicted) attention.push(`${flagged} item${flagged === 1 ? "" : "s"} flagged for review by sleep`);
  if (lowConfidence >= 10) attention.push(`${lowConfidence} low-confidence items`);
  if (lastAt && now - lastAt > 3 * DAY && episodes > 0) attention.push(`sleep has not run for ${Math.floor((now - lastAt) / DAY)} days`);
  if (headerChars + recallCapChars > budgetChars) attention.push(`injection may exceed budget (${headerChars + recallCapChars} > ${budgetChars} chars)`);

  return {
    schemaVersion: (() => { try { return (db.prepare("SELECT version FROM schema_version LIMIT 1").get() as { version: number } | undefined)?.version ?? SCHEMA_VERSION; } catch { return SCHEMA_VERSION; } })(),
    nodes: { total, active: byStatus["active"] ?? 0, retracted: byStatus["retracted"] ?? 0, superseded: byStatus["superseded"] ?? 0, archived: byStatus["archived"] ?? 0 },
    episodes,
    beliefs: { lowConfidence, contradicted, flaggedForReview: flagged, bySource, byConfidence },
    hotConflicts: conflicts.map((c) => ({ a: { id: c.aid, label: c.al }, b: { id: c.bid, label: c.bl }, since: c.at })),
    lastSleep: { at: lastAt, ago: lastAt ? relativeTime(lastAt, now) : "never", summary },
    injection: { budgetChars, headerChars, recallCapChars, estimatedTokens: Math.ceil((headerChars + recallCapChars) / 4) },
    attention,
  };
}

export function formatBrainStatus(s: BrainStatus, label = ""): string {
  const L: string[] = [];
  L.push(`${label ? `[${label}] ` : ""}Brain status (schema v${s.schemaVersion})`);
  L.push(`  nodes: ${s.nodes.active} active / ${s.nodes.total} total (retracted ${s.nodes.retracted}, superseded ${s.nodes.superseded}, archived ${s.nodes.archived}); episodes ${s.episodes}`);
  L.push(`  beliefs: ${s.beliefs.lowConfidence} low-confidence, ${s.beliefs.contradicted} disputed, ${s.beliefs.flaggedForReview} flagged for review`);
  const src = Object.entries(s.beliefs.bySource).map(([k, n]) => `${k}=${n}`).join(" ");
  if (src) L.push(`  sources: ${src}`);
  L.push(`  injection: ~${s.injection.estimatedTokens} tokens (header ${s.injection.headerChars} + recall cap ${s.injection.recallCapChars} chars; budget ${s.injection.budgetChars})`);
  const ss = s.lastSleep.summary;
  L.push(`  last sleep: ${s.lastSleep.ago}${ss ? ` — nodes ${ss.nodesBefore}→${ss.nodesAfter}, edges ${ss.edgesBefore}→${ss.edgesAfter}, pruned ${ss.pruned}, new contradictions ${ss.newContradictions}, flagged ${ss.flaggedForReview}${ss.legacyNoiseFlagged ? ` (${ss.legacyNoiseFlagged} look like legacy heartbeat/NO_REPLY noise — review, then retire with xanima-server noise)` : ""}` : ""}`);
  if (s.hotConflicts.length) {
    L.push(`  hot conflicts:`);
    for (const c of s.hotConflicts) L.push(`    [${c.a.id.slice(0, 8)}] ${c.a.label}  ⟂  [${c.b.id.slice(0, 8)}] ${c.b.label}  (${relativeTime(c.since)})`);
  }
  L.push(s.attention.length ? `  needs attention: ${s.attention.join("; ")}` : "  needs attention: nothing");
  return L.join("\n");
}

/** One line for the injection footer, or "" when nothing needs attention. */
export function statusFooter(s: BrainStatus): string {
  if (s.attention.length === 0) return "";
  return `[BRAIN: status] ${s.attention.slice(0, 2).join("; ")} — call brain_status for details.`;
}

// ─── sleep: belief review pass ─────────────────────────────────────────────

/**
 * Sleep-time belief review (heuristic, no LLM):
 *   1. Stamp contradicted_at on both ends of every live `contradicts` edge.
 *   2. Flag active low-confidence / contradicted nodes for review
 *      (review_flagged_at) — flagged nodes are exempt from the Deep prune, so
 *      a disputed belief surfaces in brain_status instead of silently decaying away.
 *   3. Unflag anything no longer active.
 */
/**
 * Legacy rows (pre-v19, backfilled source_type='legacy') that are really
 * system-turn noise: the agent's own NO_REPLY / HEARTBEAT_OK triage or an
 * OpenClaw internal wake body that older extractors stored as a "fact".
 * Cheap text check; only flags for review (never retires or deletes).
 */
export function looksLikeLegacyNoise(label: string, content: string): boolean {
  for (const t of [content, label]) {
    const x = (t ?? "").trim();
    if (!x) continue;
    if (/^(NO_REPLY|HEARTBEAT_OK)\b/.test(x)) return true;
    if (isSilentReplyText(x) || isInternalWakeText(x)) return true;
  }
  return false;
}

export function runBeliefReviewPass(agentId: string, config: Partial<BrainConfig>, log?: Log): { newContradictions: number; flagged: number; lowConfidence: number; contradicted: number; legacyNoiseFlagged: number } {
  const db = getDb(agentId);
  const now = Date.now();
  const low = config.lowConfidenceThreshold ?? 0.4;
  let newContradictions = 0, flagged = 0, legacyNoiseFlagged = 0;
  executeWithWalRetrySync(db, (d) => {
    // First-sleep signal for migrated brains: legacy heartbeat / NO_REPLY noise.
    const cand = d.prepare(`SELECT id, label, content FROM nodes WHERE source_type = 'legacy' AND status = 'active'
                              AND review_flagged_at IS NULL AND type != 'episodic' AND (valid_until IS NULL OR valid_until > ?)`).all(now) as Array<{ id: string; label: string; content: string }>;
    const mark = d.prepare(`UPDATE nodes SET review_flagged_at = ?, status_reason = COALESCE(status_reason, 'review: looks like legacy heartbeat/NO_REPLY system noise') WHERE id = ?`);
    for (const c of cand) if (looksLikeLegacyNoise(c.label, c.content)) { mark.run(now, c.id); legacyNoiseFlagged++; }
    newContradictions = d.prepare(`
      UPDATE nodes SET contradicted_at = ?
       WHERE contradicted_at IS NULL AND id IN (
         SELECT from_id FROM edges WHERE type = 'contradicts' AND valid_until IS NULL
         UNION SELECT to_id FROM edges WHERE type = 'contradicts' AND valid_until IS NULL)
    `).run(now).changes;
    flagged = d.prepare(`
      UPDATE nodes SET review_flagged_at = ?
       WHERE review_flagged_at IS NULL AND status = 'active' AND (valid_until IS NULL OR valid_until > ?)
         AND type NOT IN ('episodic')
         AND (contradicted_at IS NOT NULL OR confidence_score < ?)
    `).run(now, now, low).changes;
    d.prepare(`UPDATE nodes SET review_flagged_at = NULL WHERE review_flagged_at IS NOT NULL AND (status != 'active' OR (valid_until IS NOT NULL AND valid_until <= ?))`).run(now);
  }, { op: "beliefs.reviewPass" });
  const lowConfidence = (db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE status = 'active' AND (valid_until IS NULL OR valid_until > ?) AND confidence_score < ?").get(now, low) as { n: number }).n;
  const contradicted = (db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE status = 'active' AND (valid_until IS NULL OR valid_until > ?) AND contradicted_at IS NOT NULL").get(now) as { n: number }).n;
  flagged += legacyNoiseFlagged;
  if (newContradictions || flagged) log?.info(`[xanima] belief review: ${newContradictions} newly disputed, ${flagged} flagged for review (${legacyNoiseFlagged} legacy noise) (agent=${agentId})`);
  return { newContradictions, flagged, lowConfidence, contradicted, legacyNoiseFlagged };
}

export function getSleepSummary(agentId: string): SleepSummary | null {
  const raw = getMeta(agentId, SLEEP_SUMMARY_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as SleepSummary; } catch { return null; }
}

export function saveSleepSummary(agentId: string, s: SleepSummary): void {
  setMeta(agentId, SLEEP_SUMMARY_KEY, JSON.stringify(s));
}

export function countNodesEdges(agentId: string): { nodes: number; edges: number } {
  const db = getDb(agentId);
  return {
    nodes: (db.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number }).n,
    edges: (db.prepare("SELECT COUNT(*) AS n FROM edges WHERE valid_until IS NULL").get() as { n: number }).n,
  };
}
