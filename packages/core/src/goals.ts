/**
 * Xanima 0.2.0 — versioned goals, drift detection, alignment notes and
 * prospective triggers (schema v20). Heuristic only; no LLM.
 *
 * A goal is a `goal` node (the existing type, so the identity/goals header
 * keeps working) plus a `goals` row per version. Changing a goal's wording,
 * priority, criteria or keywords writes a NEW node version via supersedeNode
 * (old version kept as history — as_of still finds it) and a new goals row
 * with version+1 under the same lineage_id. Status changes (pause / resume /
 * done / archive / track) are recorded in goal_events. Nothing is deleted.
 */
import { randomUUID } from "node:crypto";
import { getDb, getMeta, setMeta, bumpWriteCounter } from "./db.js";
import { writeNode, getNode } from "./nodes.js";
import { supersedeNode } from "./beliefs.js";
import { relativeTime } from "./belief-meta.js";
import { tokenSet, resolveGoalCurrent } from "./decisions.js";
import type { BrainConfig, SourceType } from "./types.js";

type Log = { info: (m: string) => void; warn: (m: string) => void };
const DAY = 86_400_000;

export type GoalStatus = "active" | "paused" | "superseded" | "done" | "archived";
export const GOAL_STATUSES: GoalStatus[] = ["active", "paused", "superseded", "done", "archived"];

export interface GoalRow {
  node_id: string;
  lineage_id: string;
  version: number;
  title: string;
  priority: number;
  status: GoalStatus;
  success_criteria: string | null;
  keywords_json: string;
  tracked: number;
  last_checked_at: number | null;
  last_progress_at: number | null;
  alignment_summary: string | null;
  drift_kind: string | null;
  drift_reason: string | null;
  drift_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface TriggerSpec { kind: "time" | "keyword"; at?: string | number; every_days?: number; keywords?: string[]; cooldown_hours?: number }

const clean = (s: unknown, max: number): string => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");

/** "critical|high|medium|low" or 1..5 (1 = highest). */
export function parsePriority(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 5) return v;
  const s = String(v).trim().toLowerCase();
  const m: Record<string, number> = { critical: 1, p1: 1, high: 2, p2: 2, medium: 3, normal: 3, p3: 3, low: 4, p4: 4, someday: 5, p5: 5 };
  if (s in m) return m[s]!;
  if (/^[1-5]$/.test(s)) return Number(s);
  return null;
}
export const priorityLabel = (p: number) => `P${p}`;

export function deriveKeywords(...texts: Array<string | null | undefined>): string[] {
  const freq = new Map<string, number>();
  for (const t of texts) for (const w of tokenSet(t ?? "")) if (w.length >= 4 && !GENERIC.has(w)) freq.set(w, (freq.get(w) ?? 0) + 1);
  return [...freq.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).slice(0, 6).map(([w]) => w);
}
const GENERIC = new Set("make keep goal goals done more less have will should would could need want some every each into from with about their there what when which while week weeks days month months year better good".split(" "));

function goalContent(title: string, description: string | null, criteria: string | null, priority: number): string {
  let s = `Goal (${priorityLabel(priority)}): ${title}`;
  if (description) s += `. ${description}`;
  if (criteria) s += `. Success: ${criteria}`;
  return s.slice(0, 2000);
}

function event(agentId: string, row: { lineage_id: string; version: number; node_id: string }, action: string, change: Record<string, unknown> | null, reason: string | null, now: number): void {
  getDb(agentId).prepare("INSERT INTO goal_events (lineage_id, version, node_id, at, action, change_json, reason) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(row.lineage_id, row.version, row.node_id, now, action, change ? JSON.stringify(change) : null, reason);
}

export function currentGoalRow(agentId: string, idOrPrefix: string): GoalRow | null {
  const g = resolveGoalCurrent(agentId, idOrPrefix);
  if (!g) return null;
  return getDb(agentId).prepare("SELECT * FROM goals WHERE lineage_id = ? ORDER BY version DESC LIMIT 1").get(g.lineage_id) as GoalRow;
}

export interface SetGoalInput {
  title: string; description?: string; priority?: unknown; successCriteria?: string; keywords?: string[];
  triggers?: TriggerSpec[]; writerAgentId?: string; sourceType?: SourceType; now?: number;
}

export function setGoal(agentId: string, input: SetGoalInput): { ok: boolean; error?: string; goal?: GoalRow; triggers?: string[] } {
  const title = clean(input.title, 200);
  if (!title) return { ok: false, error: "title is required" };
  const pr = input.priority === undefined ? 3 : parsePriority(input.priority);
  if (pr === null) return { ok: false, error: "priority must be 1..5 (1 = highest) or critical|high|medium|low|someday" };
  const description = clean(input.description, 1000) || null;
  const criteria = clean(input.successCriteria, 600) || null;
  const kw = (input.keywords?.length ? input.keywords.map((k) => clean(k, 40).toLowerCase()).filter(Boolean) : deriveKeywords(title, criteria, description)).slice(0, 12);
  const trig = validateTriggers(input.triggers);
  if ("error" in trig) return { ok: false, error: trig.error };
  const now = input.now ?? Date.now();
  const nodeId = writeNode(agentId, "goal", title, goalContent(title, description, criteria, pr), {
    importance: 0.85, source: "goal", writerAgentId: input.writerAgentId ?? agentId, deduplicate: false,
    ...(input.sourceType ? { sourceType: input.sourceType } : {}),
  });
  const db = getDb(agentId);
  db.prepare(`INSERT INTO goals (node_id, lineage_id, version, title, priority, status, success_criteria, keywords_json, tracked, last_checked_at, last_progress_at, created_at, updated_at)
              VALUES (?, ?, 1, ?, ?, 'active', ?, ?, 1, NULL, ?, ?, ?)`).run(nodeId, nodeId, title, pr, criteria, JSON.stringify(kw), now, now, now);
  if (input.now !== undefined) db.prepare("UPDATE nodes SET created_at = ?, valid_from = ? WHERE id = ?").run(now, now, nodeId);
  const row = currentGoalRow(agentId, nodeId)!;
  event(agentId, row, "create", { title, priority: pr, success_criteria: criteria, keywords: kw }, null, now);
  const tids = addTriggers(agentId, nodeId, trig.specs, now);
  bumpWriteCounter(db);
  return { ok: true, goal: row, triggers: tids };
}

function validateTriggers(raw: unknown): { specs: TriggerSpec[] } | { error: string } {
  if (raw === undefined || raw === null) return { specs: [] };
  if (!Array.isArray(raw)) return { error: "triggers must be an array" };
  const specs: TriggerSpec[] = [];
  for (const t of raw.slice(0, 5)) {
    if (!t || typeof t !== "object") return { error: "each trigger must be an object" };
    const o = t as Record<string, unknown>;
    if (o["kind"] === "keyword") {
      const k = Array.isArray(o["keywords"]) ? (o["keywords"] as unknown[]).map((x) => clean(x, 40).toLowerCase()).filter(Boolean) : [];
      if (!k.length) return { error: "a keyword trigger needs keywords: [...]" };
      specs.push({ kind: "keyword", keywords: k.slice(0, 10), ...(typeof o["cooldown_hours"] === "number" ? { cooldown_hours: o["cooldown_hours"] as number } : {}) });
    } else if (o["kind"] === "time") {
      const at = o["at"];
      const every = o["every_days"];
      if (at === undefined && every === undefined) return { error: "a time trigger needs at (ISO time / epoch ms) and/or every_days" };
      if (at !== undefined && !Number.isFinite(typeof at === "number" ? at : Date.parse(String(at)))) return { error: `time trigger at: cannot parse ${String(at)}` };
      if (every !== undefined && !(typeof every === "number" && every > 0 && every <= 365)) return { error: "every_days must be a number 0 < n <= 365" };
      specs.push({ kind: "time", ...(at !== undefined ? { at: at as string | number } : {}), ...(every !== undefined ? { every_days: every as number } : {}) });
    } else return { error: `trigger kind must be "time" or "keyword"` };
  }
  return { specs };
}

function addTriggers(agentId: string, lineage: string, specs: TriggerSpec[], now: number): string[] {
  const db = getDb(agentId);
  const ids: string[] = [];
  for (const s of specs) {
    const id = `trg_${randomUUID().slice(0, 12)}`;
    let next: number | null = null;
    if (s.kind === "time") next = s.at !== undefined ? (typeof s.at === "number" ? s.at : Date.parse(String(s.at))) : now + s.every_days! * DAY;
    db.prepare("INSERT INTO goal_triggers (id, lineage_id, kind, spec_json, next_at, cooldown_ms, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?)")
      .run(id, lineage, s.kind, JSON.stringify(s), next, Math.round((s.cooldown_hours ?? 6) * 3_600_000), now);
    ids.push(id);
  }
  return ids;
}

export type GoalAction = "update" | "supersede" | "pause" | "resume" | "done" | "archive" | "progress" | "track" | "untrack";
export const GOAL_ACTIONS: GoalAction[] = ["update", "supersede", "pause", "resume", "done", "archive", "progress", "track", "untrack"];

export interface UpdateGoalInput {
  action: GoalAction; title?: string; description?: string; priority?: unknown; successCriteria?: string; keywords?: string[];
  reason?: string; note?: string; triggers?: TriggerSpec[]; writerAgentId?: string; now?: number;
}

export function updateGoal(agentId: string, idOrPrefix: string, input: UpdateGoalInput): { ok: boolean; error?: string; goal?: GoalRow; previous?: GoalRow; related?: Array<{ id: string; label: string }> } {
  const cur = currentGoalRow(agentId, idOrPrefix);
  if (!cur) return { ok: false, error: `goal ${idOrPrefix} not found (brain_list_goals shows ids)` };
  if (!GOAL_ACTIONS.includes(input.action)) return { ok: false, error: `action must be one of ${GOAL_ACTIONS.join(", ")}` };
  const db = getDb(agentId);
  const now = input.now ?? Date.now();
  const reason = clean(input.reason, 600) || null;
  if (cur.status === "superseded") return { ok: false, error: "that version is superseded; update the current one" };

  if (input.action === "update" || input.action === "supersede") {
    if (input.action === "supersede" && !reason) return { ok: false, error: "supersede needs a reason (why the goal changed)" };
    const pr = input.priority === undefined ? cur.priority : parsePriority(input.priority);
    if (pr === null) return { ok: false, error: "priority must be 1..5 or critical|high|medium|low|someday" };
    const title = clean(input.title, 200) || cur.title;
    const node = getNode(agentId, cur.node_id);
    const oldDesc = node?.content.match(/^Goal \(P\d\): .*?\. (.*?)(?:\. Success: .*)?$/)?.[1] ?? null;
    const description = input.description !== undefined ? clean(input.description, 1000) || null : oldDesc && !oldDesc.startsWith("Success:") ? oldDesc : null;
    const criteria = input.successCriteria !== undefined ? clean(input.successCriteria, 600) || null : cur.success_criteria;
    const kw = input.keywords?.length ? input.keywords.map((k) => clean(k, 40).toLowerCase()).filter(Boolean).slice(0, 12)
      : title !== cur.title || criteria !== cur.success_criteria ? deriveKeywords(title, criteria, description) : JSON.parse(cur.keywords_json) as string[];
    const trig = validateTriggers(input.triggers);
    if ("error" in trig) return { ok: false, error: trig.error };
    const sup = supersedeNode(agentId, cur.node_id, goalContent(title, description, criteria, pr), {
      reason: reason ?? `goal updated (v${cur.version + 1})`, newLabel: title, writerAgentId: input.writerAgentId ?? agentId,
    });
    if (!sup.ok || !sup.newId) return { ok: false, error: sup.error ?? "supersede failed" };
    const change: Record<string, unknown> = {};
    if (title !== cur.title) change["title"] = [cur.title, title];
    if (pr !== cur.priority) change["priority"] = [cur.priority, pr];
    if (criteria !== cur.success_criteria) change["success_criteria"] = [cur.success_criteria, criteria];
    db.transaction(() => {
      db.prepare("UPDATE goals SET status = 'superseded', updated_at = ? WHERE node_id = ?").run(now, cur.node_id);
      db.prepare(`INSERT INTO goals (node_id, lineage_id, version, title, priority, status, success_criteria, keywords_json, tracked, last_checked_at, last_progress_at, alignment_summary, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        sup.newId, cur.lineage_id, cur.version + 1, title, pr, cur.status === "paused" ? "paused" : "active", criteria, JSON.stringify(kw), cur.tracked,
        cur.last_checked_at, cur.last_progress_at ?? lineageStart(agentId, cur.lineage_id) ?? cur.created_at, cur.alignment_summary, now, now);
      // goal nodes are high-importance; carry it over
      db.prepare("UPDATE nodes SET importance = MAX(importance, 0.85) WHERE id = ?").run(sup.newId);
    })();
    const row = currentGoalRow(agentId, cur.lineage_id)!;
    event(agentId, row, input.action, change, reason, now);
    addTriggers(agentId, cur.lineage_id, trig.specs, now);
    bumpWriteCounter(db);
    return { ok: true, goal: row, previous: cur, related: sup.related.map((r) => ({ id: r.id, label: r.label })) };
  }

  const set = (sql: string, ...a: unknown[]) => db.prepare(`UPDATE goals SET ${sql}, updated_at = ? WHERE node_id = ?`).run(...a, now, cur.node_id);
  switch (input.action) {
    case "pause": if (cur.status !== "active") return { ok: false, error: `goal is ${cur.status}` }; set("status = 'paused'"); break;
    case "resume": if (cur.status !== "paused") return { ok: false, error: `goal is ${cur.status}` }; set("status = 'active', last_progress_at = ?, drift_kind = NULL, drift_reason = NULL", now); break;
    case "done":
    case "archive": {
      if (cur.status === "done" || cur.status === "archived") return { ok: false, error: `goal is already ${cur.status}` };
      set(`status = '${input.action === "done" ? "done" : "archived"}', drift_kind = NULL, drift_reason = NULL`);
      db.prepare("UPDATE nodes SET status = 'archived', status_reason = ?, status_changed_at = ?, valid_until = COALESCE(valid_until, ?), updated_at = ? WHERE id = ?")
        .run(`goal ${input.action === "done" ? "done" : "archived"}${reason ? `: ${reason}` : ""}`, now, now, now, cur.node_id);
      db.prepare("UPDATE goal_triggers SET enabled = 0 WHERE lineage_id = ?").run(cur.lineage_id);
      break;
    }
    case "progress": set("last_progress_at = ?, drift_kind = NULL, drift_reason = NULL, alignment_summary = ?", now, clean(input.note, 300) || "progress recorded"); break;
    case "track": set("tracked = 1, last_progress_at = COALESCE(last_progress_at, ?)", now); break;
    case "untrack": set("tracked = 0, drift_kind = NULL, drift_reason = NULL"); break;
  }
  const trig = validateTriggers(input.triggers);
  if ("error" in trig) return { ok: false, error: trig.error };
  addTriggers(agentId, cur.lineage_id, trig.specs, now);
  const row = currentGoalRow(agentId, cur.lineage_id)!;
  event(agentId, row, input.action, input.note ? { note: clean(input.note, 300) } : null, reason, now);
  bumpWriteCounter(db);
  return { ok: true, goal: row, previous: cur };
}

export function listGoals(agentId: string, opts: { status?: GoalStatus | "all"; includeUntracked?: boolean } = {}): GoalRow[] {
  const db = getDb(agentId);
  const st = opts.status ?? "active";
  const rows = db.prepare(`SELECT g.* FROM goals g WHERE g.version = (SELECT MAX(version) FROM goals x WHERE x.lineage_id = g.lineage_id)
                           ${st === "all" ? "" : "AND g.status = ?"} ${opts.includeUntracked === false ? "AND g.tracked = 1" : ""}
                           ORDER BY CASE g.status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 ELSE 2 END, g.priority ASC, g.updated_at DESC LIMIT 50`)
    .all(...(st === "all" ? [] : [st])) as GoalRow[];
  return rows;
}

export interface GoalHistory { versions: GoalRow[]; events: Array<{ at: number; version: number; action: string; change: unknown; reason: string | null }>; triggers: Array<{ id: string; kind: string; spec: TriggerSpec; next_at: number | null; last_fired_at: number | null; fire_count: number; enabled: number }> }

export function goalHistory(agentId: string, idOrPrefix: string): GoalHistory | null {
  const cur = currentGoalRow(agentId, idOrPrefix);
  if (!cur) return null;
  const db = getDb(agentId);
  const versions = db.prepare("SELECT * FROM goals WHERE lineage_id = ? ORDER BY version ASC").all(cur.lineage_id) as GoalRow[];
  const events = (db.prepare("SELECT at, version, action, change_json, reason FROM goal_events WHERE lineage_id = ? ORDER BY at ASC, id ASC").all(cur.lineage_id) as Array<{ at: number; version: number; action: string; change_json: string | null; reason: string | null }>)
    .map((e) => ({ at: e.at, version: e.version, action: e.action, change: e.change_json ? JSON.parse(e.change_json) : null, reason: e.reason }));
  const triggers = (db.prepare("SELECT id, kind, spec_json, next_at, last_fired_at, fire_count, enabled FROM goal_triggers WHERE lineage_id = ?").all(cur.lineage_id) as Array<{ id: string; kind: string; spec_json: string; next_at: number | null; last_fired_at: number | null; fire_count: number; enabled: number }>)
    .map((t) => ({ id: t.id, kind: t.kind, spec: JSON.parse(t.spec_json) as TriggerSpec, next_at: t.next_at, last_fired_at: t.last_fired_at, fire_count: t.fire_count, enabled: t.enabled }));
  return { versions, events, triggers };
}

export function formatGoal(g: GoalRow, now = Date.now()): string {
  const kw = (JSON.parse(g.keywords_json) as string[]).join(", ");
  const L = [`${g.lineage_id} ${priorityLabel(g.priority)} [${g.status}${g.tracked ? "" : ", untracked"}] ${g.title}  (v${g.version}, node ${g.node_id.slice(0, 8)})`];
  if (g.success_criteria) L.push(`  success: ${g.success_criteria}`);
  if (kw) L.push(`  keywords: ${kw}`);
  L.push(`  last progress: ${g.last_progress_at ? relativeTime(g.last_progress_at, now) : "never"} · last checked: ${g.last_checked_at ? relativeTime(g.last_checked_at, now) : "never"}`);
  if (g.drift_reason) L.push(`  DRIFT (${g.drift_kind}): ${g.drift_reason}`);
  else if (g.alignment_summary) L.push(`  alignment: ${g.alignment_summary}`);
  return L.join("\n");
}

export function formatGoalHistory(h: GoalHistory, now = Date.now()): string {
  const L = [`history (${h.versions.length} version${h.versions.length === 1 ? "" : "s"}):`];
  for (const e of h.events) {
    const ch = e.change && typeof e.change === "object" ? Object.entries(e.change as Record<string, unknown>).map(([k, v]) => Array.isArray(v) ? `${k}: ${JSON.stringify(v[0])} → ${JSON.stringify(v[1])}` : `${k}: ${JSON.stringify(v)}`).join("; ") : "";
    L.push(`  v${e.version} ${e.action} ${relativeTime(e.at, now)}${ch ? ` — ${ch}` : ""}${e.reason ? ` (reason: ${e.reason})` : ""}`);
  }
  for (const t of h.triggers) L.push(`  trigger ${t.id} ${t.kind} ${t.kind === "keyword" ? (t.spec.keywords ?? []).join("|") : t.next_at ? `next ${new Date(t.next_at).toISOString()}` : ""}${t.spec.every_days ? ` every ${t.spec.every_days}d` : ""} fired ${t.fire_count}×${t.enabled ? "" : " (disabled)"}`);
  return L.join("\n");
}

// ─── drift pass ────────────────────────────────────────────────────────────

export interface DriftFlag { lineage_id: string; title: string; priority: number; kind: "stalled" | "conflict" | "priority"; reason: string; days: number }
export interface DriftResult { checked: number; drifting: DriftFlag[]; onTrack: number; noteId: number | null; note: string | null }

/** When the goal lineage was first set (v1 created_at). Re-wording a goal is not progress. */
function lineageStart(agentId: string, lineageId: string): number | null {
  const r = getDb(agentId).prepare("SELECT MIN(created_at) AS t FROM goals WHERE lineage_id = ?").get(lineageId) as { t: number | null } | undefined;
  return r?.t ?? null;
}

/**
 * Keywords that describe what DONE looks like, minus the goal's name: words
 * from the success criteria that are not in any title of the lineage. Talking
 * about "the Telegram bot for Gano" is not progress; "Gano answers" is.
 */
export function criteriaKeywords(criteria: string | null, titles: string[]): string[] {
  if (!criteria) return [];
  const named = new Set<string>();
  for (const t of titles) for (const w of tokenSet(t)) named.add(w);
  return deriveKeywords(criteria).filter((k) => !named.has(k));
}

/**
 * Goal plumbing / goal talk: never progress evidence. Any memory-tool call or
 * result (brain_*: set/list/update goals, status, recall that echoes the goal
 * node), goal listings / recall formats ("(goal)", "Goal (P1):", "success: …"),
 * the injected goals block and alignment notes, and questions.
 */
const GOAL_TALK = /\bbrain_[a-z_]+\b|\[BRAIN: [a-z]+\]|\bAlignment: |\bGoal (?:set|update|supersede|progress)\b|\(goal\)|\bGoal \(P\d\):|\bsuccess: /i;
export function isGoalTalk(content: string): boolean {
  const c = content.trim();
  return GOAL_TALK.test(c) || c.endsWith("?");
}

function matchesKeywords(text: string, kws: string[]): number {
  const t = text.toLowerCase();
  let n = 0;
  for (const k of kws) if (k && new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(t)) n++;
  return n;
}

/**
 * Compare recent activity against active, tracked goals.
 *   progress = evidence of advancement only: a decision linked to the goal
 *   (recorded, or a non-missed outcome), an explicit progress / done / resume
 *   update (brain_update_goal action "progress"), or assistant/tool activity
 *   matching the goal's SUCCESS CRITERIA minus its name. Setting, re-wording,
 *   listing or merely discussing a goal, and alignment-note turns, never count.
 *   drift    = no progress in `driftDays`; a recent decision with a
 *   conflicts_with_goal edge; or recent decisions advancing only lower-priority
 *   goals while a higher-priority goal stalls.
 * Writes last_checked_at / last_progress_at / alignment_summary / drift_* and,
 * when something drifts, one short alignment note (injected once).
 */
export function runDriftPass(agentId: string, config: Partial<BrainConfig>, log?: Log, now = Date.now()): DriftResult {
  const res: DriftResult = { checked: 0, drifting: [], onTrack: 0, noteId: null, note: null };
  const db = getDb(agentId);
  const driftDays = config.driftDays ?? 7;
  const goals = db.prepare(`SELECT g.* FROM goals g WHERE g.status = 'active' AND g.tracked = 1
                              AND g.version = (SELECT MAX(version) FROM goals x WHERE x.lineage_id = g.lineage_id)`).all() as GoalRow[];
  const windowStart = now - driftDays * DAY;
  const recentDecisions = db.prepare(`SELECT d.node_id, d.chosen, d.goal_id, d.created_at, d.outcome_at FROM decisions d JOIN nodes n ON n.id = d.node_id
                                       WHERE d.merged_into IS NULL AND n.status = 'active' AND (d.created_at >= ? OR d.outcome_at >= ?)`).all(windowStart, windowStart) as
    Array<{ node_id: string; chosen: string; goal_id: string | null; created_at: number; outcome_at: number | null }>;
  const recentEpisodes = db.prepare("SELECT content, created_at FROM episodes WHERE created_at >= ? AND role IN ('assistant', 'tool') ORDER BY created_at DESC LIMIT 3000").all(Math.min(windowStart, ...goals.map((g) => g.last_progress_at ?? g.created_at))) as Array<{ content: string; created_at: number }>;
  const prioOf = new Map(goals.map((g) => [g.lineage_id, g.priority]));

  for (const g of goals) {
    res.checked++;
    const titles = (db.prepare("SELECT title FROM goals WHERE lineage_id = ?").all(g.lineage_id) as Array<{ title: string }>).map((r) => r.title);
    const kws = criteriaKeywords(g.success_criteria, titles);
    const need = kws.length <= 2 ? 1 : 2;
    let last = g.last_progress_at ?? lineageStart(agentId, g.lineage_id) ?? g.created_at;
    const lineageNodes = (db.prepare("SELECT node_id FROM goals WHERE lineage_id = ?").all(g.lineage_id) as Array<{ node_id: string }>).map((r) => r.node_id);
    const adv = db.prepare(`SELECT d.created_at, d.outcome_at, d.outcome_status FROM edges e JOIN decisions d ON d.node_id = e.from_id
                             WHERE e.type = 'advances' AND e.to_id IN (${lineageNodes.map(() => "?").join(",")})`).all(...lineageNodes) as Array<{ created_at: number; outcome_at: number | null; outcome_status: string | null }>;
    for (const a of adv) {
      last = Math.max(last, a.created_at);
      if (a.outcome_at && a.outcome_status !== "missed") last = Math.max(last, a.outcome_at);
    }
    let evidence = "";
    for (const e of recentEpisodes) {
      if (e.created_at <= last) break;
      if (!kws.length) break;
      if (isGoalTalk(e.content)) continue;
      if (matchesKeywords(e.content, kws) >= need) { last = e.created_at; evidence = "activity matching its success criteria"; break; }
    }
    const days = Math.floor((now - last) / DAY);
    const flags: DriftFlag[] = [];
    const conflicts = db.prepare(`SELECT d.chosen FROM edges e JOIN decisions d ON d.node_id = e.from_id
                                   WHERE e.type = 'conflicts_with_goal' AND d.created_at >= ? AND e.to_id IN (${lineageNodes.map(() => "?").join(",")})`)
      .all(windowStart, ...lineageNodes) as Array<{ chosen: string }>;
    if (conflicts.length) flags.push({ lineage_id: g.lineage_id, title: g.title, priority: g.priority, kind: "conflict", days, reason: `decision "${conflicts[0]!.chosen.slice(0, 60)}" conflicts with goal "${g.title}"` });
    if (days >= driftDays) {
      const lower = recentDecisions.filter((d) => d.goal_id && d.goal_id !== g.lineage_id && (prioOf.get(d.goal_id) ?? 9) > g.priority);
      if (lower.length) {
        const lg = goals.find((x) => x.lineage_id === lower[0]!.goal_id);
        flags.push({ lineage_id: g.lineage_id, title: g.title, priority: g.priority, kind: "priority", days, reason: `recent decisions advanced "${lg?.title ?? "another goal"}" (${priorityLabel(lg?.priority ?? 5)}) while "${g.title}" (${priorityLabel(g.priority)}) had no progress in ${days} days` });
      } else {
        flags.push({ lineage_id: g.lineage_id, title: g.title, priority: g.priority, kind: "stalled", days, reason: `no progress on goal "${g.title}" (${priorityLabel(g.priority)}) in ${days} days` });
      }
    }
    const f = flags[0];
    const summary = f ? f.reason : `on track — last progress ${relativeTime(last, now)}${evidence ? ` (${evidence})` : ""}`;
    db.prepare(`UPDATE goals SET last_checked_at = ?, last_progress_at = ?, alignment_summary = ?, drift_kind = ?, drift_reason = ?, drift_at = CASE WHEN ? IS NULL THEN NULL ELSE COALESCE(drift_at, ?) END, updated_at = ? WHERE node_id = ?`)
      .run(now, last, summary, f?.kind ?? null, f?.reason ?? null, f?.kind ?? null, now, now, g.node_id);
    if (f) res.drifting.push(...flags.slice(0, 1)); else res.onTrack++;
  }

  if (res.drifting.length) {
    res.drifting.sort((a, b) => a.priority - b.priority);
    const max = Math.max(80, (config.alignmentNoteMaxTokens ?? 60) * 4);
    const top = res.drifting[0]!;
    let note = `Alignment: ${top.reason}.`;
    if (res.drifting.length > 1) note += ` (+${res.drifting.length - 1} more drifting goal${res.drifting.length > 2 ? "s" : ""})`;
    note += " Take a step toward it, or pause / re-prioritise it with brain_update_goal.";
    if (note.length > max) note = note.slice(0, max - 1) + "…";
    const lineages = res.drifting.map((d) => d.lineage_id).sort();
    const prev = db.prepare("SELECT text, lineage_ids_json, delivered_at, created_at FROM alignment_notes ORDER BY id DESC LIMIT 1").get() as { text: string; lineage_ids_json: string; delivered_at: number | null; created_at: number } | undefined;
    const sameRecent = prev && prev.lineage_ids_json === JSON.stringify(lineages) && now - (prev.delivered_at ?? prev.created_at) < DAY;
    if (!sameRecent) {
      db.prepare("UPDATE alignment_notes SET superseded_at = ? WHERE delivered_at IS NULL AND superseded_at IS NULL").run(now);
      res.noteId = Number(db.prepare("INSERT INTO alignment_notes (created_at, text, lineage_ids_json) VALUES (?, ?, ?)").run(now, note, JSON.stringify(lineages)).lastInsertRowid);
      res.note = note;
    }
  }
  setMeta(agentId, "drift:last_run", String(now));
  if (res.checked) log?.info(`[xanima] drift pass: ${res.checked} goal(s) checked, ${res.drifting.length} drifting${res.noteId ? ", alignment note queued" : ""} (agent=${agentId})`);
  return res;
}

export function maybeRunDailyDrift(agentId: string, config: Partial<BrainConfig>, now = Date.now(), log?: Log): DriftResult | null {
  if ((config.intentDriftCheck ?? "sleep") !== "daily") return null;
  const last = Number(getMeta(agentId, "drift:last_run") ?? 0);
  if (now - last < DAY) return null;
  return runDriftPass(agentId, config, log, now);
}

// ─── turn context: alignment note (once) + goal triggers ───────────────────

export interface GoalTurnContext { text: string; noteId: number | null; triggered: Array<{ trigger_id: string; lineage_id: string; title: string; why: string }> }

/** Safety valve: a note offered this many times without an ack is retired (e.g. a host that never acks). */
export const ALIGNMENT_NOTE_MAX_OFFERS = 6;

/**
 * Mark an alignment note delivered. Call it only after the note was injected
 * into a prompt that produced a real assistant reply (not a tool-only turn).
 */
export function ackAlignmentNote(agentId: string, noteId: number, now = Date.now()): boolean {
  const r = getDb(agentId).prepare("UPDATE alignment_notes SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL").run(now, noteId);
  return r.changes > 0;
}

/**
 * Called once per agent turn (before the prompt is built). Offers the
 * pending alignment note (it stays pending until ackAlignmentNote), fires due time triggers and matching
 * keyword triggers (with cooldown), and returns one budget-capped block.
 * Mutates delivery / firing state; read-only otherwise.
 */
export function buildGoalTurnContext(agentId: string, prompt: string, config: Partial<BrainConfig>, now = Date.now(), log?: Log): GoalTurnContext {
  const out: GoalTurnContext = { text: "", noteId: null, triggered: [] };
  if (config.intentDriftCheck === "off" && config.goalTriggers === false) return out;
  const db = getDb(agentId);
  try { maybeRunDailyDrift(agentId, config, now, log); } catch (e) { log?.warn(`[xanima] daily drift failed: ${String(e)}`); }
  const lines: string[] = [];
  if (config.intentDriftCheck !== "off") {
    const n = db.prepare("SELECT id, text FROM alignment_notes WHERE delivered_at IS NULL AND superseded_at IS NULL ORDER BY id DESC LIMIT 1").get() as { id: number; text: string } | undefined;
    if (n) {
      // Offered, not delivered: the host acks (ackAlignmentNote) once a real reply came out of this prompt.
      lines.push(n.text); out.noteId = n.id;
      const c = db.prepare("UPDATE alignment_notes SET offered_at = ?, offered_count = offered_count + 1 WHERE id = ? RETURNING offered_count").get(now, n.id) as { offered_count: number };
      if (c.offered_count >= ALIGNMENT_NOTE_MAX_OFFERS) {
        db.prepare("UPDATE alignment_notes SET delivered_at = ? WHERE id = ?").run(now, n.id);
        log?.info(`[xanima] alignment note ${n.id} retired after ${c.offered_count} offers without an ack (agent=${agentId})`);
      }
    }
  }
  if (config.goalTriggers !== false) {
    const trig = db.prepare(`SELECT t.*, g.title, g.priority, g.success_criteria FROM goal_triggers t
                               JOIN goals g ON g.lineage_id = t.lineage_id AND g.version = (SELECT MAX(version) FROM goals x WHERE x.lineage_id = t.lineage_id)
                              WHERE t.enabled = 1 AND g.status = 'active'`).all() as Array<{ id: string; lineage_id: string; kind: string; spec_json: string; next_at: number | null; cooldown_ms: number; last_fired_at: number | null; title: string; priority: number; success_criteria: string | null }>;
    const p = prompt.toLowerCase();
    for (const t of trig) {
      if (out.triggered.length >= 2) break;
      const spec = JSON.parse(t.spec_json) as TriggerSpec;
      let why = "";
      if (t.kind === "time" && t.next_at !== null && t.next_at <= now) {
        why = spec.every_days ? `scheduled every ${spec.every_days}d` : "scheduled";
        const next = spec.every_days ? Math.max(t.next_at + spec.every_days * DAY, now + 60_000) : null;
        db.prepare("UPDATE goal_triggers SET next_at = ?, enabled = ?, last_fired_at = ?, fire_count = fire_count + 1 WHERE id = ?").run(next, next === null ? 0 : 1, now, t.id);
      } else if (t.kind === "keyword" && (t.last_fired_at === null || now - t.last_fired_at >= t.cooldown_ms)) {
        const hit = (spec.keywords ?? []).find((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i").test(p));
        if (hit) {
          why = `you mentioned "${hit}"`;
          db.prepare("UPDATE goal_triggers SET last_fired_at = ?, fire_count = fire_count + 1 WHERE id = ?").run(now, t.id);
        }
      }
      if (!why) continue;
      out.triggered.push({ trigger_id: t.id, lineage_id: t.lineage_id, title: t.title, why });
      lines.push(`Goal ${priorityLabel(t.priority)} "${t.title}"${t.success_criteria ? ` — success: ${t.success_criteria}` : ""} (${why}).`);
    }
  }
  if (!lines.length) return out;
  const max = Math.max(80, (config.alignmentNoteMaxTokens ?? 60) * 4);
  let body = lines.join("\n");
  if (body.length > max) body = body.slice(0, max - 1) + "…";
  out.text = `[BRAIN: goals]\n${body}`;
  return out;
}

export function goalCounts(db: ReturnType<typeof getDb>): { active: number; tracked: number; paused: number; done: number; drifting: Array<{ id: string; title: string; reason: string }>; pendingNote: string | null; pendingNoteOffers: number } {
  try {
    const cur = `g.version = (SELECT MAX(version) FROM goals x WHERE x.lineage_id = g.lineage_id)`;
    const r = db.prepare(`SELECT SUM(status='active') AS active, SUM(status='active' AND tracked=1) AS tracked, SUM(status='paused') AS paused, SUM(status='done') AS done FROM goals g WHERE ${cur}`).get() as Record<string, number | null>;
    const drifting = (db.prepare(`SELECT lineage_id, title, drift_reason FROM goals g WHERE ${cur} AND status = 'active' AND drift_reason IS NOT NULL ORDER BY priority`).all() as Array<{ lineage_id: string; title: string; drift_reason: string }>)
      .map((d) => ({ id: d.lineage_id, title: d.title, reason: d.drift_reason }));
    const n = db.prepare("SELECT text, offered_count FROM alignment_notes WHERE delivered_at IS NULL AND superseded_at IS NULL ORDER BY id DESC LIMIT 1").get() as { text: string; offered_count: number } | undefined;
    return { active: r["active"] ?? 0, tracked: r["tracked"] ?? 0, paused: r["paused"] ?? 0, done: r["done"] ?? 0, drifting, pendingNote: n?.text ?? null, pendingNoteOffers: n?.offered_count ?? 0 };
  } catch { return { active: 0, tracked: 0, paused: 0, done: 0, drifting: [], pendingNote: null, pendingNoteOffers: 0 }; }
}
