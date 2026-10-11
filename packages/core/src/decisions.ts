/**
 * Xanima 0.2.0 — decision ledger (schema v20).
 *
 * A decision is a `decision` node (so it takes part in recall, spreading
 * activation, as_of and the v0.1.0 belief metadata) plus a structured row in
 * the `decisions` table: context, options with predicted outcomes, the chosen
 * action, the actual outcome, and the lesson. Links:
 *   decision -advances-> goal node, decision -conflicts_with_goal-> goal node,
 *   decision -used_in-> skill node, evidence = episode / node ids (JSON).
 *
 * Everything here is heuristic and LLM-free.
 */
import { getDb, getMeta, setMeta, bumpWriteCounter } from "./db.js";
import { writeNode, getNode, ftsSearchNodes } from "./nodes.js";
import { writeEdge } from "./edges.js";
import { parseConfidence, confidenceLevel, relativeTime } from "./belief-meta.js";
import type { ActivatedNode, BrainConfig, BrainNode, ConfidenceLevel, SourceType } from "./types.js";

type Log = { info: (m: string) => void; warn: (m: string) => void };
const DAY = 86_400_000;

export interface DecisionOption { option: string; predicted_outcome?: string; confidence?: number }
export type OutcomeStatus = "matched" | "partial" | "missed";
export const OUTCOME_STATUSES: OutcomeStatus[] = ["matched", "partial", "missed"];

export interface DecisionRow {
  node_id: string;
  context: string;
  goal_id: string | null;
  options_json: string;
  chosen: string;
  rationale: string | null;
  predicted_outcome: string | null;
  predicted_confidence: number | null;
  outcome: string | null;
  outcome_status: OutcomeStatus | null;
  outcome_at: number | null;
  lesson: string | null;
  lesson_node_id: string | null;
  merged_into: string | null;
  merge_count: number;
  auto_extracted: number;
  created_at: number;
  updated_at: number;
}

export interface DecisionView extends DecisionRow {
  label: string;
  confidence: string;
  confidence_score: number;
  status: string;
  source_type: string;
  options: DecisionOption[];
  goal_title: string | null;
}

export interface RecordDecisionInput {
  context: string;
  chosen: string;
  options?: Array<string | DecisionOption>;
  rationale?: string;
  predictedOutcome?: string;
  confidence?: ConfidenceLevel | number;
  /** Goal lineage id, goal node id, or an 8+ char prefix of either. */
  goalId?: string;
  conflictsWithGoalIds?: string[];
  skillIds?: string[];
  evidence?: string[];
  sourceType?: SourceType;
  writerAgentId?: string;
  source?: string;
  autoExtracted?: boolean;
  now?: number;
}

const clean = (s: unknown, max: number): string => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** Resolve a node id or an unambiguous 8+ char prefix within `type`. */
export function resolveNodeId(agentId: string, idOrPrefix: string, type?: string): string | null {
  const id = idOrPrefix.trim();
  if (!id) return null;
  const db = getDb(agentId);
  const exact = db.prepare(`SELECT id FROM nodes WHERE id = ?${type ? " AND type = ?" : ""}`).get(...(type ? [id, type] : [id])) as { id: string } | undefined;
  if (exact) return exact.id;
  if (id.length < 8) return null;
  const rows = db.prepare(`SELECT id FROM nodes WHERE id LIKE ?${type ? " AND type = ?" : ""} LIMIT 2`).all(...(type ? [id + "%", type] : [id + "%"])) as Array<{ id: string }>;
  return rows.length === 1 ? rows[0]!.id : null;
}

/** Current goal node (latest version) for a lineage id / node id / prefix. */
export function resolveGoalCurrent(agentId: string, idOrPrefix: string): { lineage_id: string; node_id: string; title: string; priority: number; status: string } | null {
  const db = getDb(agentId);
  const id = idOrPrefix.trim();
  if (!id) return null;
  let lin = db.prepare("SELECT lineage_id FROM goals WHERE lineage_id = ? OR node_id = ? LIMIT 1").all(id, id) as Array<{ lineage_id: string }>;
  if (lin.length === 0 && id.length >= 8) {
    const rows = db.prepare("SELECT DISTINCT lineage_id FROM goals WHERE lineage_id LIKE ? OR node_id LIKE ? LIMIT 2").all(id + "%", id + "%") as Array<{ lineage_id: string }>;
    if (rows.length === 1) lin = rows;
  }
  if (lin.length === 0) return null;
  const row = db.prepare("SELECT lineage_id, node_id, title, priority, status FROM goals WHERE lineage_id = ? ORDER BY version DESC LIMIT 1").get(lin[0]!.lineage_id) as
    { lineage_id: string; node_id: string; title: string; priority: number; status: string } | undefined;
  return row ?? null;
}

function normOptions(raw: RecordDecisionInput["options"]): DecisionOption[] {
  const out: DecisionOption[] = [];
  for (const o of raw ?? []) {
    if (typeof o === "string") {
      const [opt, pred] = o.split(/\s*=>\s*/, 2);
      const t = clean(opt, 300);
      if (t) out.push({ option: t, ...(pred && clean(pred, 300) ? { predicted_outcome: clean(pred, 300) } : {}) });
      continue;
    }
    if (o && typeof o === "object" && typeof o.option === "string" && o.option.trim()) {
      const c = o.confidence !== undefined ? parseConfidence(o.confidence) : null;
      out.push({ option: clean(o.option, 300), ...(o.predicted_outcome ? { predicted_outcome: clean(o.predicted_outcome, 300) } : {}), ...(c ? { confidence: c.score } : {}) });
    }
  }
  return out.slice(0, 8);
}

export function decisionContent(d: { context: string; chosen: string; options: DecisionOption[]; rationale?: string | null; predicted_outcome?: string | null; outcome?: string | null; outcome_status?: string | null; lesson?: string | null }): string {
  const others = d.options.map((o) => o.option).filter((o) => o.toLowerCase() !== d.chosen.toLowerCase());
  let s = `${d.context} → chose: ${d.chosen}`;
  if (others.length) s += ` (over: ${others.join("; ")})`;
  if (d.rationale) s += ` because ${d.rationale}`;
  if (d.predicted_outcome) s += `. Expected: ${d.predicted_outcome}`;
  if (d.outcome) s += `. Outcome (${d.outcome_status ?? "?"}): ${d.outcome}`;
  if (d.lesson) s += `. Lesson: ${d.lesson}`;
  return s.slice(0, 2000);
}

export function recordDecision(agentId: string, input: RecordDecisionInput): { ok: boolean; error?: string; id?: string; goal?: { lineage_id: string; title: string }; conflicts?: string[] } {
  const context = clean(input.context, 600);
  const chosen = clean(input.chosen, 300);
  if (!context) return { ok: false, error: "context is required (what was being decided, and why it mattered)" };
  if (!chosen) return { ok: false, error: "chosen is required (the option you picked)" };
  const options = normOptions(input.options);
  if (!options.some((o) => o.option.toLowerCase() === chosen.toLowerCase())) options.unshift({ option: chosen });
  const conf = input.confidence !== undefined ? parseConfidence(input.confidence) : null;
  if (input.confidence !== undefined && !conf) return { ok: false, error: "confidence must be low|medium|high|certain or a number 0..1" };
  const goal = input.goalId ? resolveGoalCurrent(agentId, input.goalId) : null;
  if (input.goalId && !goal) return { ok: false, error: `goal ${input.goalId} not found (brain_list_goals shows ids)` };
  const conflictGoals = [];
  for (const g of input.conflictsWithGoalIds ?? []) {
    const r = resolveGoalCurrent(agentId, g);
    if (!r) return { ok: false, error: `goal ${g} not found` };
    conflictGoals.push(r);
  }
  const rationale = clean(input.rationale, 600) || null;
  const predicted = clean(input.predictedOutcome, 400) || null;
  const now = input.now ?? Date.now();
  const content = decisionContent({ context, chosen, options, rationale, predicted_outcome: predicted });
  const auto = input.autoExtracted === true;
  const id = writeNode(agentId, "decision", `Decision: ${chosen.slice(0, 80)}`, content, {
    importance: auto ? 0.45 : 0.7,
    source: input.source ?? (auto ? "decision:auto" : "decision"),
    writerAgentId: input.writerAgentId ?? agentId,
    deduplicate: false,
    ...(input.sourceType ? { sourceType: input.sourceType } : {}),
    ...(conf ? { confidence: conf.score } : auto ? { confidence: "low" as const } : {}),
    ...(input.evidence?.length ? { evidence: input.evidence.slice(0, 20) } : {}),
  });
  const db = getDb(agentId);
  db.prepare(`INSERT INTO decisions (node_id, context, goal_id, options_json, chosen, rationale, predicted_outcome, predicted_confidence, auto_extracted, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    id, context, goal?.lineage_id ?? null, JSON.stringify(options), chosen, rationale, predicted, conf?.score ?? null, auto ? 1 : 0, now, now);
  if (now !== Date.now() && input.now !== undefined) db.prepare("UPDATE nodes SET created_at = ?, valid_from = ? WHERE id = ?").run(now, now, id);
  const w = { writerAgentId: input.writerAgentId ?? agentId };
  if (goal) writeEdge(agentId, id, goal.node_id, "advances", w);
  for (const g of conflictGoals) writeEdge(agentId, id, g.node_id, "conflicts_with_goal", w);
  for (const s of input.skillIds ?? []) {
    const sid = resolveNodeId(agentId, s);
    if (sid) writeEdge(agentId, id, sid, "used_in", w);
  }
  bumpWriteCounter(db);
  return { ok: true, id, ...(goal ? { goal: { lineage_id: goal.lineage_id, title: goal.title } } : {}), conflicts: conflictGoals.map((g) => g.title) };
}

export function getDecision(agentId: string, idOrPrefix: string): DecisionView | null {
  const id = resolveNodeId(agentId, idOrPrefix, "decision");
  if (!id) return null;
  return viewRows(agentId, getDb(agentId).prepare("SELECT * FROM decisions WHERE node_id = ?").all(id) as DecisionRow[])[0] ?? null;
}

function viewRows(agentId: string, rows: DecisionRow[]): DecisionView[] {
  const db = getDb(agentId);
  return rows.map((r) => {
    const n = db.prepare("SELECT label, confidence, confidence_score, status, source_type FROM nodes WHERE id = ?").get(r.node_id) as
      { label: string; confidence: string; confidence_score: number; status: string; source_type: string } | undefined;
    const g = r.goal_id ? (db.prepare("SELECT title FROM goals WHERE lineage_id = ? ORDER BY version DESC LIMIT 1").get(r.goal_id) as { title: string } | undefined) : undefined;
    let options: DecisionOption[] = [];
    try { options = JSON.parse(r.options_json) as DecisionOption[]; } catch { /* keep [] */ }
    return { ...r, label: n?.label ?? `Decision: ${r.chosen}`, confidence: n?.confidence ?? "medium", confidence_score: n?.confidence_score ?? 0.6, status: n?.status ?? "active", source_type: n?.source_type ?? "self_observation", options, goal_title: g?.title ?? null };
  });
}

export function updateDecisionOutcome(agentId: string, idOrPrefix: string, input: { outcome: string; status: OutcomeStatus; lesson?: string; now?: number }): { ok: boolean; error?: string; decision?: DecisionView; goalProgress?: string } {
  const d = getDecision(agentId, idOrPrefix);
  if (!d) return { ok: false, error: `decision ${idOrPrefix} not found (brain_query_decisions shows ids)` };
  if (d.merged_into) return updateDecisionOutcome(agentId, d.merged_into, input);
  const outcome = clean(input.outcome, 600);
  if (!outcome) return { ok: false, error: "outcome is required (what actually happened)" };
  if (!OUTCOME_STATUSES.includes(input.status)) return { ok: false, error: `outcome_status must be one of ${OUTCOME_STATUSES.join(", ")}` };
  const lesson = clean(input.lesson, 600) || null;
  const now = input.now ?? Date.now();
  const db = getDb(agentId);
  db.transaction(() => {
    db.prepare("UPDATE decisions SET outcome = ?, outcome_status = ?, outcome_at = ?, lesson = COALESCE(?, lesson), updated_at = ? WHERE node_id = ?")
      .run(outcome, input.status, now, lesson, now, d.node_id);
    const content = decisionContent({ ...d, outcome, outcome_status: input.status, lesson: lesson ?? d.lesson });
    db.prepare(`UPDATE nodes SET content = ?, updated_at = ?${input.status === "matched" ? ", verified_at = ?" : ""} WHERE id = ?`)
      .run(...(input.status === "matched" ? [content, now, now, d.node_id] : [content, now, d.node_id]));
  })();
  let goalProgress: string | undefined;
  if (d.goal_id && input.status !== "missed") {
    db.prepare("UPDATE goals SET last_progress_at = MAX(COALESCE(last_progress_at, 0), ?), drift_kind = NULL, drift_reason = NULL, updated_at = ? WHERE lineage_id = ? AND status = 'active'").run(now, now, d.goal_id);
    goalProgress = d.goal_title ?? d.goal_id;
  }
  bumpWriteCounter(db);
  return { ok: true, decision: getDecision(agentId, d.node_id)!, ...(goalProgress ? { goalProgress } : {}) };
}

export interface QueryDecisionsInput { query?: string; goalId?: string; status?: "pending" | "resolved" | "all"; limit?: number; includeMerged?: boolean }

export function queryDecisions(agentId: string, input: QueryDecisionsInput = {}): DecisionView[] {
  const db = getDb(agentId);
  const limit = Math.max(1, Math.min(50, input.limit ?? 10));
  const where: string[] = [];
  const args: unknown[] = [];
  if (!input.includeMerged) where.push("d.merged_into IS NULL");
  where.push("n.status = 'active'");
  if (input.status === "pending") where.push("d.outcome_at IS NULL");
  else if (input.status === "resolved") where.push("d.outcome_at IS NOT NULL");
  if (input.goalId) {
    const g = resolveGoalCurrent(agentId, input.goalId);
    if (!g) return [];
    where.push("d.goal_id = ?"); args.push(g.lineage_id);
  }
  const q = (input.query ?? "").trim();
  if (q) {
    const ids = ftsSearchNodes(agentId, q, 100).filter((n) => n.type === "decision").map((n) => n.id);
    if (ids.length === 0) return [];
    const rank = new Map(ids.map((id, i) => [id, i]));
    const rows = db.prepare(`SELECT d.* FROM decisions d JOIN nodes n ON n.id = d.node_id WHERE ${where.join(" AND ")} AND d.node_id IN (${ids.map(() => "?").join(",")})`)
      .all(...args, ...ids) as DecisionRow[];
    rows.sort((a, b) => rank.get(a.node_id)! - rank.get(b.node_id)!);
    return viewRows(agentId, rows.slice(0, limit));
  }
  const rows = db.prepare(`SELECT d.* FROM decisions d JOIN nodes n ON n.id = d.node_id WHERE ${where.join(" AND ")} ORDER BY d.created_at DESC LIMIT ?`).all(...args, limit) as DecisionRow[];
  return viewRows(agentId, rows);
}

export function formatDecision(d: DecisionView, now = Date.now()): string {
  const L = [`${d.node_id} ${d.label} (${relativeTime(d.created_at, now)} · conf=${confidenceLevel(d.confidence_score)} src=${d.source_type}${d.auto_extracted ? " · auto-extracted draft" : ""}${d.merge_count > 1 ? ` · seen ${d.merge_count}×` : ""})`];
  L.push(`  context: ${d.context}`);
  const others = d.options.filter((o) => o.option.toLowerCase() !== d.chosen.toLowerCase());
  L.push(`  chose: ${d.chosen}${others.length ? `  (over: ${others.map((o) => o.option + (o.predicted_outcome ? ` → ${o.predicted_outcome}` : "")).join("; ")})` : ""}`);
  if (d.rationale) L.push(`  because: ${d.rationale}`);
  if (d.predicted_outcome) L.push(`  expected: ${d.predicted_outcome}${d.predicted_confidence !== null ? ` (${confidenceLevel(d.predicted_confidence)})` : ""}`);
  if (d.goal_title) L.push(`  goal: ${d.goal_title}`);
  L.push(d.outcome_at ? `  outcome (${d.outcome_status}, ${relativeTime(d.outcome_at, now)}): ${d.outcome}` : "  outcome: pending — record it with brain_update_decision_outcome");
  if (d.lesson) L.push(`  lesson: ${d.lesson}${d.lesson_node_id ? " (promoted to a skill)" : ""}`);
  return L.join("\n");
}

// ─── heuristic auto-extraction ─────────────────────────────────────────────

const LEAD = String.raw`(?:I(?:'ll| will| am going to|'m going to)\s+(?:go with|choose|pick|use|take|opt for)|I(?:'ve| have)?\s*(?:decided|chosen|chose|opted)(?:\s+(?:to\s+(?:go with|use|take|pick)|for|on))?|I'm\s+(?:going with|choosing|picking|opting for)|(?:we'll|we will|let's)\s+(?:go with|use|pick|choose)|going with)`;
const OVER = new RegExp(String.raw`\b${LEAD}\s+(.{2,120}?)\s+(?:over|instead of|rather than)\s+(.{2,120}?)(?:\s*[,;—-]?\s*(?:because|since|as)\s+(.{3,240}?))?(?=[.!?\n]|$)`, "i");
const BECAUSE = new RegExp(String.raw`\b${LEAD}\s+(.{2,120}?)\s*[,;—-]?\s*(?:because|since)\s+(.{3,240}?)(?=[.!?\n]|$)`, "i");

export interface DecisionCandidate { chosen: string; over: string[]; rationale: string | null; sentence: string }

/**
 * Find first-person choices in an assistant message ("I'll go with X over Y
 * because …", "I decided to use X because …"). Ignores fenced code, quotes and
 * questions. At most 2 per message. No LLM.
 */
export function extractDecisionCandidates(text: string): DecisionCandidate[] {
  if (!text) return [];
  const stripped = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, (m) => m.slice(1, -1));
  const sentences = stripped.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s && !s.startsWith(">") && !s.endsWith("?"));
  const out: DecisionCandidate[] = [];
  for (const s of sentences) {
    if (out.length >= 2) break;
    const m = OVER.exec(s);
    if (m) { out.push({ chosen: tidy(m[1]!), over: tidy(m[2]!).split(/\s*(?:,|\bor\b|\band\b)\s*/i).filter(Boolean).slice(0, 4), rationale: m[3] ? tidyR(m[3]) : null, sentence: s.slice(0, 400) }); continue; }
    const b = BECAUSE.exec(s);
    if (b) out.push({ chosen: tidy(b[1]!), over: [], rationale: tidyR(b[2]!), sentence: s.slice(0, 400) });
  }
  return out.filter((c) => c.chosen.length >= 2 && c.chosen.split(/\s+/).length <= 14);
}
const tidyR = (s: string) => s.replace(/[\s,;:—-]+$/, "").trim();
const tidy = (s: string) => s.replace(/^(the|a|an)\s+/i, "").replace(/[\s,;:—-]+$/, "").trim();

export function autoExtractDecisions(agentId: string, text: string, config: Partial<BrainConfig>, opts: { writerAgentId?: string; evidence?: string[]; now?: number } = {}): string[] {
  if (config.decisionLedger === false || config.decisionAutoExtract === false) return [];
  const cands = extractDecisionCandidates(text);
  if (!cands.length) return [];
  const db = getDb(agentId);
  const now = opts.now ?? Date.now();
  const ids: string[] = [];
  for (const c of cands) {
    const dup = db.prepare("SELECT node_id FROM decisions WHERE lower(chosen) = lower(?) AND created_at > ? LIMIT 1").get(c.chosen, now - DAY) as { node_id: string } | undefined;
    if (dup) continue;
    const r = recordDecision(agentId, {
      context: c.sentence, chosen: c.chosen, options: c.over, ...(c.rationale ? { rationale: c.rationale } : {}),
      autoExtracted: true, sourceType: "self_observation", ...(opts.writerAgentId ? { writerAgentId: opts.writerAgentId } : {}),
      ...(opts.evidence ? { evidence: opts.evidence } : {}), now,
    });
    if (r.ok && r.id) ids.push(r.id);
  }
  return ids;
}

// ─── recall boost ──────────────────────────────────────────────────────────

/** Multiply the activation of (active) decision nodes already in a recall result set; re-sort. */
export function applyDecisionBoost<T extends ActivatedNode>(nodes: T[], config: Partial<BrainConfig>): T[] {
  const f = config.decisionBoost ?? 1.2;
  if (config.decisionLedger === false || !(f > 1) || !nodes.some((n) => n.type === "decision")) return nodes;
  for (const n of nodes) if (n.type === "decision" && (n.status ?? "active") === "active") n.activation *= f;
  return nodes.sort((a, b) => b.activation - a.activation);
}

// ─── sleep: merge, calibrate, promote ──────────────────────────────────────

const STOP = new Set("a an the to of for and or in on with over instead rather than because since as is it this that we i i'll use go going choose chose".split(" "));
export function tokenSet(s: string): Set<string> {
  return new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP.has(w)));
}
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let i = 0;
  for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i);
}

export interface DecisionPassResult { merged: number; calibrated: number; promoted: number; promotedIds: string[] }

export function runDecisionPass(agentId: string, config: Partial<BrainConfig>, log?: Log, now = Date.now()): DecisionPassResult {
  const res: DecisionPassResult = { merged: 0, calibrated: 0, promoted: 0, promotedIds: [] };
  if (config.decisionLedger === false) return res;
  const db = getDb(agentId);
  // 1. merge near-duplicates (same choice, similar context)
  const rows = db.prepare(`SELECT d.* FROM decisions d JOIN nodes n ON n.id = d.node_id WHERE d.merged_into IS NULL AND n.status = 'active' ORDER BY d.created_at ASC`).all() as DecisionRow[];
  const keep: Array<{ r: DecisionRow; c: Set<string>; x: Set<string> }> = [];
  for (const r of rows) {
    const c = tokenSet(r.chosen), x = tokenSet(r.context);
    const canon = keep.find((k) => (k.r.goal_id ?? "") === (r.goal_id ?? "") && jaccard(k.c, c) >= 0.8 && jaccard(k.x, x) >= 0.5);
    if (!canon) { keep.push({ r, c, x }); continue; }
    const k = canon.r;
    db.transaction(() => {
      db.prepare(`UPDATE decisions SET merge_count = merge_count + ?, updated_at = ?,
                    outcome = COALESCE(outcome, ?), outcome_status = COALESCE(outcome_status, ?), outcome_at = COALESCE(outcome_at, ?), lesson = COALESCE(lesson, ?)
                  WHERE node_id = ?`).run(r.merge_count, now, r.outcome, r.outcome_status, r.outcome_at, r.lesson, k.node_id);
      db.prepare("UPDATE decisions SET merged_into = ?, updated_at = ? WHERE node_id = ?").run(k.node_id, now, r.node_id);
      const kn = getNode(agentId, k.node_id)!;
      const ev = new Set<string>([...(safeJson(kn.evidence) ?? []), r.node_id]);
      db.prepare("UPDATE nodes SET evidence = ?, confidence_score = MIN(0.95, confidence_score + 0.05), updated_at = ? WHERE id = ?").run(JSON.stringify([...ev].slice(0, 50)), now, k.node_id);
      db.prepare(`UPDATE nodes SET status = 'superseded', status_reason = ?, status_changed_at = ?, valid_until = COALESCE(valid_until, ?), updated_at = ? WHERE id = ?`)
        .run(`merged into ${k.node_id} (near-duplicate decision)`, now, now, now, r.node_id);
    })();
    writeEdge(agentId, k.node_id, r.node_id, "supersedes", { writerAgentId: "system:sleep", meta: { reason: "near-duplicate decision merged during sleep" } });
    k.merge_count += r.merge_count;
    if (!k.outcome && r.outcome) { k.outcome = r.outcome; k.outcome_status = r.outcome_status; k.outcome_at = r.outcome_at; }
    if (!k.lesson && r.lesson) k.lesson = r.lesson;
    res.merged++;
  }
  // 2. calibrate confidence from outcomes (once per outcome)
  const done = new Set<string>(safeJson(getMeta(agentId, "decisions:calibrated")) ?? []);
  const resolved = db.prepare(`SELECT d.node_id, d.outcome_status, d.outcome_at FROM decisions d JOIN nodes n ON n.id = d.node_id WHERE d.merged_into IS NULL AND d.outcome_at IS NOT NULL AND n.status = 'active'`).all() as Array<{ node_id: string; outcome_status: OutcomeStatus; outcome_at: number }>;
  for (const r of resolved) {
    const key = `${r.node_id}@${r.outcome_at}`;
    if (done.has(key)) continue;
    const delta = r.outcome_status === "matched" ? 0.15 : r.outcome_status === "missed" ? -0.2 : 0;
    db.prepare(`UPDATE nodes SET confidence_score = MAX(0.1, MIN(0.95, confidence_score + ?)), updated_at = ? WHERE id = ?`).run(delta, now, r.node_id);
    const sc = (db.prepare("SELECT confidence_score FROM nodes WHERE id = ?").get(r.node_id) as { confidence_score: number }).confidence_score;
    db.prepare("UPDATE nodes SET confidence = ? WHERE id = ?").run(confidenceLevel(sc), r.node_id);
    done.add(key);
    res.calibrated++;
  }
  if (res.calibrated) setMeta(agentId, "decisions:calibrated", JSON.stringify([...done].slice(-5000)));
  // 3. promote recurring / high-value lessons to skill nodes (flag)
  if (config.decisionLessonPromotion === true) {
    const withLesson = db.prepare(`SELECT d.* FROM decisions d JOIN nodes n ON n.id = d.node_id WHERE d.merged_into IS NULL AND d.lesson IS NOT NULL AND d.lesson_node_id IS NULL AND d.outcome_at IS NOT NULL AND n.status = 'active'`).all() as DecisionRow[];
    const all = db.prepare(`SELECT node_id, lesson FROM decisions WHERE lesson IS NOT NULL AND merged_into IS NULL`).all() as Array<{ node_id: string; lesson: string }>;
    for (const d of withLesson) {
      const lt = tokenSet(d.lesson!);
      const similar = all.filter((o) => o.node_id !== d.node_id && jaccard(lt, tokenSet(o.lesson)) >= 0.5);
      const highValue = similar.length >= 1 || d.merge_count >= 2 || (d.outcome_status === "missed" && (d.predicted_confidence ?? 0) >= 0.7);
      if (!highValue) continue;
      const sources = [d.node_id, ...similar.map((s) => s.node_id)];
      const skillId = writeNode(agentId, "skill", `Lesson: ${d.lesson!.slice(0, 80)}`, `${d.lesson} (learned from ${sources.length} decision${sources.length === 1 ? "" : "s"}; outcome ${d.outcome_status})`, {
        importance: 0.75, source: "sws:decision-lesson", writerAgentId: "system:sleep", sourceType: "inference",
        confidence: Math.min(0.9, 0.5 + 0.1 * sources.length + (d.merge_count > 1 ? 0.1 : 0)), evidence: sources, deduplicate: true,
      });
      for (const s of sources) {
        writeEdge(agentId, skillId, s, "derived_from", { writerAgentId: "system:sleep" });
        db.prepare("UPDATE decisions SET lesson_node_id = ?, updated_at = ? WHERE node_id = ?").run(skillId, now, s);
      }
      res.promoted++;
      res.promotedIds.push(skillId);
    }
  }
  if (res.merged || res.calibrated || res.promoted) {
    bumpWriteCounter(db);
    log?.info(`[xanima] decision pass: merged ${res.merged}, calibrated ${res.calibrated}, promoted ${res.promoted} lesson(s) (agent=${agentId})`);
  }
  return res;
}

function safeJson(s: string | null | undefined): string[] | null {
  if (!s) return null;
  try { const v = JSON.parse(s); return Array.isArray(v) ? v.map(String) : null; } catch { return null; }
}

export function decisionCounts(db: ReturnType<typeof getDb>): { total: number; pending: number; resolved: number; auto: number; lessonsPromoted: number } {
  try {
    const r = db.prepare(`SELECT COUNT(*) AS total, SUM(outcome_at IS NULL) AS pending, SUM(outcome_at IS NOT NULL) AS resolved, SUM(auto_extracted) AS auto,
                                 COUNT(DISTINCT lesson_node_id) AS promoted
                            FROM decisions d JOIN nodes n ON n.id = d.node_id WHERE d.merged_into IS NULL AND n.status = 'active'`).get() as Record<string, number | null>;
    return { total: r["total"] ?? 0, pending: r["pending"] ?? 0, resolved: r["resolved"] ?? 0, auto: r["auto"] ?? 0, lessonsPromoted: r["promoted"] ?? 0 };
  } catch { return { total: 0, pending: 0, resolved: 0, auto: 0, lessonsPromoted: 0 }; }
}

export type { BrainNode };
