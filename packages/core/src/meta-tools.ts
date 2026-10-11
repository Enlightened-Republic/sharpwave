/**
 * Xanima 0.3.0 — cheap meta-tools (all read-only, budget-capped, no LLM):
 *   replay          past trajectories (episode → decision → outcome → lesson) for a goal / skill / query
 *   changesSince    what changed about a goal / topic / plan in a window
 *   conflicts       contradictions, low-confidence items, refuted hypotheses, contradicted assumptions
 *   briefing        a resume briefing for a plan / goal / topic
 *   forgetImpact    what compacting / forgetting a cluster would lose (dry run)
 */
import { getDb } from "./db.js";
import { ftsSearchNodes } from "./nodes.js";
import { confidenceLevel } from "./belief-meta.js";
import { tokenSet, jaccard } from "./decisions.js";
import { formatGoal, currentGoalRow } from "./goals.js";
import { listOpenItems } from "./open-items.js";
import { getPlan, formatPlan, listCommitments, formatCommitment, blockersOf } from "./plans.js";
import { capLines, clean, resolveRef, safeJsonArr, ago, DAY } from "./continuity-util.js";
import type { BrainConfig } from "./types.js";

type Db = ReturnType<typeof getDb>;
const short = (s: string | null | undefined, n: number) => { const t = (s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const maxChars = (config: Partial<BrainConfig>) => Math.max(400, config.metaToolMaxChars ?? 2400);

/** Node ids for a topic (FTS, active only) — the topic scope used by the meta-tools. */
function topicIds(agentId: string, topic: string, limit = 60): Set<string> {
  try { return new Set(ftsSearchNodes(agentId, topic, limit).map((n) => n.id)); } catch { return new Set(); }
}

interface Scope { kind: "goal" | "plan" | "topic"; label: string; ids: Set<string>; goalLineage?: string; planId?: string; topic?: string }

function resolveScope(agentId: string, args: { goalId?: string; planId?: string; topic?: string }): Scope | { error: string } {
  const db = getDb(agentId);
  if (args.planId) {
    const p = getPlan(agentId, args.planId);
    if (!p) return { error: `plan ${args.planId} not found` };
    const ids = new Set<string>([p.node_id]);
    for (const r of db.prepare("SELECT from_id id FROM edges WHERE to_id = ? AND type IN ('about', 'advances', 'blocked_by') UNION SELECT to_id FROM edges WHERE from_id = ? AND type IN ('about', 'advances', 'blocked_by')").all(p.node_id, p.node_id) as Array<{ id: string }>) ids.add(r.id);
    const kw = safeJsonArr(p.keywords_json).slice(0, 4).join(" ");
    if (kw) for (const id of topicIds(agentId, kw, 30)) ids.add(id);
    return { kind: "plan", label: `plan "${p.title}"`, ids, planId: p.node_id, ...(p.goal_id ? { goalLineage: p.goal_id } : {}) };
  }
  if (args.goalId) {
    const g = currentGoalRow(agentId, args.goalId);
    if (!g) return { error: `goal ${args.goalId} not found` };
    const nodes = (db.prepare("SELECT node_id FROM goals WHERE lineage_id = ?").all(g.lineage_id) as Array<{ node_id: string }>).map((r) => r.node_id);
    const ids = new Set<string>(nodes);
    const ph = nodes.map(() => "?").join(",");
    for (const r of db.prepare(`SELECT from_id id FROM edges WHERE to_id IN (${ph}) AND type IN ('about', 'advances', 'conflicts_with_goal', 'reflects_on')`).all(...nodes) as Array<{ id: string }>) ids.add(r.id);
    for (const r of db.prepare("SELECT node_id FROM decisions WHERE goal_id = ?").all(g.lineage_id) as Array<{ node_id: string }>) ids.add(r.node_id);
    for (const r of db.prepare("SELECT node_id FROM plans WHERE goal_id = ?").all(g.lineage_id) as Array<{ node_id: string }>) ids.add(r.node_id);
    return { kind: "goal", label: `goal "${g.title}"`, ids, goalLineage: g.lineage_id };
  }
  const topic = clean(args.topic, 200);
  if (!topic) return { error: "give a goal_id, plan_id or topic" };
  return { kind: "topic", label: `"${topic}"`, ids: topicIds(agentId, topic), topic };
}

// ─── replay ────────────────────────────────────────────────────────────────

export function replay(agentId: string, args: { goalId?: string; skillId?: string; query?: string; k?: number }, config: Partial<BrainConfig>, now = Date.now()): { ok: boolean; error?: string; text?: string; count?: number } {
  const db = getDb(agentId);
  const k = Math.max(1, Math.min(10, args.k ?? 3));
  let ids: string[] = [];
  let label = "";
  if (args.goalId) {
    const g = currentGoalRow(agentId, args.goalId);
    if (!g) return { ok: false, error: `goal ${args.goalId} not found` };
    ids = (db.prepare("SELECT node_id FROM decisions WHERE goal_id = ? AND merged_into IS NULL ORDER BY COALESCE(outcome_at, created_at) DESC LIMIT 30").all(g.lineage_id) as Array<{ node_id: string }>).map((r) => r.node_id);
    label = `goal "${g.title}"`;
  } else if (args.skillId) {
    const s = resolveRef(agentId, args.skillId);
    if (!s) return { ok: false, error: `skill ${args.skillId} not found` };
    ids = (db.prepare(`SELECT d.node_id FROM decisions d WHERE d.merged_into IS NULL AND (d.lesson_node_id = ? OR d.node_id IN (SELECT to_id FROM edges WHERE from_id = ? AND type = 'derived_from') OR d.node_id IN (SELECT from_id FROM edges WHERE to_id = ? AND type = 'used_in'))
                         ORDER BY COALESCE(d.outcome_at, d.created_at) DESC LIMIT 30`).all(s.id, s.id, s.id) as Array<{ node_id: string }>).map((r) => r.node_id);
    label = `skill "${short(s.label, 60)}"`;
  } else if (args.query && args.query.trim()) {
    const hits = topicIds(agentId, args.query, 80);
    ids = (db.prepare(`SELECT node_id FROM decisions WHERE merged_into IS NULL ORDER BY COALESCE(outcome_at, created_at) DESC LIMIT 500`).all() as Array<{ node_id: string }>).map((r) => r.node_id).filter((id) => hits.has(id));
    label = `"${short(args.query, 60)}"`;
  } else return { ok: false, error: "give goal_id, skill_id or query" };
  // prefer resolved trajectories (they have an ending), then the most recent
  const rows = ids.map((id) => db.prepare("SELECT d.*, n.status nstatus FROM decisions d JOIN nodes n ON n.id = d.node_id WHERE d.node_id = ?").get(id) as Record<string, unknown> & { node_id: string; nstatus: string })
    .filter((r) => r && r.nstatus === "active").sort((a, b) => Number(!!b["outcome_at"]) - Number(!!a["outcome_at"])).slice(0, k);
  if (!rows.length) return { ok: true, count: 0, text: `No past trajectories for ${label} yet (record decisions and their outcomes to build them).` };
  const per = Math.floor((Math.max(400, config.replayMaxChars ?? 1600) - 80) / rows.length);
  const L = [`Replay for ${label} — ${rows.length} trajector${rows.length === 1 ? "y" : "ies"} (oldest step first):`];
  rows.forEach((r, i) => {
    const ev = safeJsonArr((db.prepare("SELECT evidence FROM nodes WHERE id = ?").get(r.node_id) as { evidence: string | null }).evidence);
    const eps = ev.length ? (db.prepare(`SELECT role, content, created_at FROM episodes WHERE id IN (${ev.map(() => "?").join(",")}) ORDER BY created_at LIMIT 2`).all(...ev) as Array<{ role: string; content: string; created_at: number }>) : [];
    const parts = [
      ...eps.map((e) => `${e.role === "user" ? "asked" : "said"}: "${short(e.content, 70)}"`),
      `context: ${short(String(r["context"]), 90)}`,
      `chose ${short(String(r["chosen"]), 50)}${r["predicted_outcome"] ? ` expecting ${short(String(r["predicted_outcome"]), 60)}` : ""}`,
      r["outcome_at"] ? `→ ${String(r["outcome_status"]).toUpperCase()}: ${short(String(r["outcome"]), 70)} (${ago(Number(r["outcome_at"]), now)})` : "→ outcome not recorded yet",
      ...(r["lesson"] ? [`lesson: ${short(String(r["lesson"]), 80)}`] : []),
    ];
    L.push(short(`${i + 1}. [${ago(Number(r["created_at"]), now)}] ${parts.join(" ⇒ ")}  (${String(r["node_id"]).slice(0, 8)})`, per));
  });
  return { ok: true, count: rows.length, text: capLines(L, Math.max(400, config.replayMaxChars ?? 1600)) };
}

// ─── changes ───────────────────────────────────────────────────────────────

export interface Change { at: number; kind: string; text: string }

export function changesSince(agentId: string, args: { goalId?: string; planId?: string; topic?: string; since: number; until?: number }, limit = 40): { scope?: Scope; changes: Change[]; error?: string } {
  const sc = resolveScope(agentId, args);
  if ("error" in sc) return { changes: [], error: sc.error };
  const db = getDb(agentId);
  const since = args.since, until = args.until ?? Date.now();
  const inWin = (t: number | null | undefined) => t !== null && t !== undefined && t >= since && t <= until;
  const out: Change[] = [];
  const ids = [...sc.ids];
  const ph = (n: number) => Array(n).fill("?").join(",");
  // decisions
  const dec = db.prepare(`SELECT * FROM decisions WHERE merged_into IS NULL AND (created_at BETWEEN ? AND ? OR outcome_at BETWEEN ? AND ?)`).all(since, until, since, until) as Array<Record<string, unknown> & { node_id: string }>;
  for (const d of dec) {
    if (!(sc.ids.has(d.node_id) || (sc.goalLineage && d["goal_id"] === sc.goalLineage))) continue;
    if (inWin(Number(d["created_at"]))) out.push({ at: Number(d["created_at"]), kind: "decision", text: `chose ${short(String(d["chosen"]), 60)} (${short(String(d["context"]), 60)})` });
    if (inWin(d["outcome_at"] as number | null)) out.push({ at: Number(d["outcome_at"]), kind: "outcome", text: `${d["outcome_status"]}: ${short(String(d["chosen"]), 40)} → ${short(String(d["outcome"]), 60)}${d["lesson"] ? `; lesson: ${short(String(d["lesson"]), 60)}` : ""}` });
  }
  // goal events
  if (sc.goalLineage) {
    for (const e of db.prepare("SELECT * FROM goal_events WHERE lineage_id = ? AND at BETWEEN ? AND ? ORDER BY at").all(sc.goalLineage, since, until) as Array<{ at: number; action: string; version: number; reason: string | null; change_json: string | null }>)
      out.push({ at: e.at, kind: "goal", text: `${e.action} (v${e.version})${e.reason ? `: ${short(e.reason, 80)}` : ""}${e.change_json && e.action === "progress" ? ` ${short(e.change_json, 80)}` : ""}` });
  }
  // nodes created / updated / retired in scope
  if (ids.length) {
    for (let i = 0; i < ids.length; i += 400) {
      const chunk = ids.slice(i, i + 400);
      const rows = db.prepare(`SELECT id, type, label, status, status_reason, created_at, updated_at, status_changed_at FROM nodes WHERE id IN (${ph(chunk.length)}) AND type NOT IN ('decision')`).all(...chunk) as Array<{ id: string; type: string; label: string; status: string; status_reason: string | null; created_at: number; updated_at: number; status_changed_at: number | null }>;
      for (const n of rows) {
        if (inWin(n.created_at)) out.push({ at: n.created_at, kind: `new ${n.type}`, text: short(n.label, 90) });
        else if (n.status !== "active" && inWin(n.status_changed_at)) out.push({ at: n.status_changed_at!, kind: n.status, text: `${short(n.label, 70)}${n.status_reason ? ` — ${short(n.status_reason, 60)}` : ""}` });
        else if (inWin(n.updated_at) && n.updated_at - n.created_at > 60_000 && !["episodic"].includes(n.type)) out.push({ at: n.updated_at, kind: `updated ${n.type}`, text: short(n.label, 90) });
      }
    }
  }
  // open items whose status moved (in scope or about the scope)
  for (const o of db.prepare("SELECT node_id, kind, text, status, updated_at, created_at FROM open_items WHERE updated_at BETWEEN ? AND ? AND updated_at > created_at + 1000").all(since, until) as Array<{ node_id: string; kind: string; text: string; status: string; updated_at: number }>) {
    if (!sc.ids.has(o.node_id)) continue;
    out.push({ at: o.updated_at, kind: o.kind, text: `${o.status}: ${short(o.text, 80)}` });
  }
  // commitments done / due in window
  for (const c of db.prepare("SELECT node_id, title, status, done_at, due_at FROM commitments WHERE (done_at BETWEEN ? AND ?) OR (status = 'open' AND due_at BETWEEN ? AND ?)").all(since, until, since, until) as Array<{ node_id: string; title: string; status: string; done_at: number | null; due_at: number | null }>) {
    if (!sc.ids.has(c.node_id)) continue;
    out.push(c.done_at ? { at: c.done_at, kind: "commitment", text: `${c.status}: ${short(c.title, 80)}` } : { at: c.due_at!, kind: "commitment", text: `came due: ${short(c.title, 80)}` });
  }
  // plan steps
  if (sc.planId) for (const s of db.prepare("SELECT idx, text, status, updated_at FROM plan_steps WHERE plan_id = ? AND updated_at BETWEEN ? AND ?").all(sc.planId, since, until) as Array<{ idx: number; text: string; status: string; updated_at: number }>)
    if (s.status !== "todo") out.push({ at: s.updated_at, kind: "step", text: `${s.idx}. ${short(s.text, 70)} → ${s.status}` });
  // dedupe identical lines, newest first
  const seen = new Set<string>();
  const res = out.sort((a, b) => b.at - a.at).filter((c) => { const k = `${c.kind}|${c.text}`; if (seen.has(k)) return false; seen.add(k); return true; });
  return { scope: sc, changes: res.slice(0, limit) };
}

export function formatChanges(scopeLabel: string, changes: Change[], since: number, config: Partial<BrainConfig>, now = Date.now()): string {
  if (!changes.length) return `Nothing changed about ${scopeLabel} since ${ago(since, now)}.`;
  return capLines([`Changes about ${scopeLabel} since ${ago(since, now)} (${changes.length}, newest first):`, ...changes.map((c) => `- ${ago(c.at, now)} · ${c.kind}: ${c.text}`)], maxChars(config));
}

// ─── conflicts ─────────────────────────────────────────────────────────────

export function conflicts(agentId: string, topic: string, config: Partial<BrainConfig>, now = Date.now()): { text: string; counts: { contradictions: number; lowConfidence: number; refuted: number; contradictedAssumptions: number; disputed: number } } {
  const db = getDb(agentId);
  const ids = topicIds(agentId, topic, 80);
  const L: string[] = [];
  const counts = { contradictions: 0, lowConfidence: 0, refuted: 0, contradictedAssumptions: 0, disputed: 0 };
  const lab = (id: string) => (db.prepare("SELECT label FROM nodes WHERE id = ?").get(id) as { label: string } | undefined)?.label ?? id;
  const idList = [...ids];
  if (idList.length) {
    const ph = idList.map(() => "?").join(",");
    const contra = db.prepare(`SELECT e.from_id, e.to_id, e.created_at FROM edges e JOIN nodes a ON a.id = e.from_id JOIN nodes b ON b.id = e.to_id
                                 WHERE e.type = 'contradicts' AND e.valid_until IS NULL AND a.status = 'active' AND b.status = 'active' AND (e.from_id IN (${ph}) OR e.to_id IN (${ph})) LIMIT 10`).all(...idList, ...idList) as Array<{ from_id: string; to_id: string; created_at: number }>;
    counts.contradictions = contra.length;
    if (contra.length) { L.push("Contradictions:"); for (const c of contra) L.push(`- [${c.from_id.slice(0, 8)}] ${short(lab(c.from_id), 60)}  ⟂  [${c.to_id.slice(0, 8)}] ${short(lab(c.to_id), 60)} (${ago(c.created_at, now)})`); }
    const thr = config.lowConfidenceThreshold ?? 0.4;
    const low = db.prepare(`SELECT id, type, label, confidence_score, contradicted_at FROM nodes WHERE id IN (${ph}) AND status = 'active' AND (confidence_score < ? OR contradicted_at IS NOT NULL) ORDER BY confidence_score LIMIT 12`).all(...idList, thr) as Array<{ id: string; type: string; label: string; confidence_score: number; contradicted_at: number | null }>;
    const lowOnly = low.filter((n) => !["hypothesis", "assumption", "question"].includes(n.type));
    counts.lowConfidence = lowOnly.filter((n) => n.confidence_score < thr).length;
    counts.disputed = lowOnly.filter((n) => n.contradicted_at).length;
    if (lowOnly.length) { L.push("Low-confidence / disputed:"); for (const n of lowOnly) L.push(`- [${n.id.slice(0, 8)}] (${n.type}, conf=${confidenceLevel(n.confidence_score)}${n.contradicted_at ? `, disputed ${ago(n.contradicted_at, now)}` : ""}) ${short(n.label, 80)}`); }
  }
  // refuted hypotheses + contradicted assumptions — topic-matched by text (they may not be FTS-ranked)
  const qt = tokenSet(topic);
  const rel = (t: string) => { const s = tokenSet(t); let i = 0; for (const x of qt) if (s.has(x)) i++; return i > 0 || ids.size === 0 ? i : i; };
  const ref = (db.prepare("SELECT node_id, kind, text, status, contradicted_at, load_bearing, updated_at FROM open_items WHERE (status = 'refuted' OR contradicted_at IS NOT NULL) AND COALESCE(draft_status, '') != 'expired' ORDER BY updated_at DESC LIMIT 100").all() as Array<{ node_id: string; kind: string; text: string; status: string; contradicted_at: number | null; load_bearing: number; updated_at: number }>)
    .filter((o) => ids.has(o.node_id) || rel(o.text) > 0).slice(0, 8);
  const hyp = ref.filter((o) => o.kind !== "assumption"), asm = ref.filter((o) => o.kind === "assumption");
  counts.refuted = hyp.length; counts.contradictedAssumptions = asm.length;
  if (hyp.length) { L.push("Refuted hypotheses:"); for (const o of hyp) L.push(`- [${o.node_id.slice(0, 8)}] ${short(o.text, 90)} (${ago(o.updated_at, now)})`); }
  if (asm.length) { L.push("Contradicted assumptions:"); for (const o of asm) L.push(`- [${o.node_id.slice(0, 8)}]${o.load_bearing ? " LOAD-BEARING" : ""} ${short(o.text, 90)} (${ago(o.contradicted_at ?? o.updated_at, now)})`); }
  if (!L.length) return { text: `No contradictions, low-confidence items or refuted hypotheses about "${short(topic, 60)}".`, counts };
  return { text: capLines([`Conflicts about "${short(topic, 60)}":`, ...L], maxChars(config)), counts };
}

// ─── briefing ──────────────────────────────────────────────────────────────

export function briefing(agentId: string, args: { planId?: string; goalId?: string; topic?: string; since?: number }, config: Partial<BrainConfig>, now = Date.now()): { ok: boolean; error?: string; text?: string } {
  const sc = resolveScope(agentId, args);
  if ("error" in sc) return { ok: false, error: sc.error };
  const db = getDb(agentId);
  const L: string[] = [];
  let since = args.since ?? now - 7 * DAY;
  if (sc.kind === "plan") {
    const p = getPlan(agentId, sc.planId!)!;
    if (args.since === undefined && p.parked_at) since = p.parked_at;
    L.push(`Briefing — ${formatPlan(p, now)}`);
    const open = p.steps.filter((s) => s.status !== "done" && s.status !== "skipped");
    L.push(open.length ? `Still open: ${open.length} of ${p.steps.length} steps; next: ${open[0]!.idx}. ${short(open[0]!.text, 90)}${blockersOf(agentId, `step:${open[0]!.id}`).some((b) => !b.done) ? " (blocked)" : ""}` : "All steps done — close it with brain_plan done.");
  } else if (sc.kind === "goal") {
    const g = currentGoalRow(agentId, sc.goalLineage!)!;
    L.push(`Briefing — ${formatGoal(g, now)}`);
    const plans = db.prepare("SELECT node_id FROM plans WHERE goal_id = ? AND status IN ('active', 'parked')").all(g.lineage_id) as Array<{ node_id: string }>;
    for (const pl of plans.slice(0, 2)) { const p = getPlan(agentId, pl.node_id)!; const open = p.steps.filter((s) => s.status !== "done" && s.status !== "skipped"); L.push(`Plan [${p.status}] ${p.title}: ${open.length}/${p.steps.length} steps open${open[0] ? `; next: ${short(open[0].text, 70)}` : ""}`); }
  } else {
    L.push(`Briefing — ${sc.label}`);
    const top = [...sc.ids].slice(0, 5).map((id) => db.prepare("SELECT type, label FROM nodes WHERE id = ?").get(id) as { type: string; label: string }).filter(Boolean);
    if (top.length) L.push(`Known: ${top.map((n) => `${short(n.label, 60)} (${n.type})`).join("; ")}`);
  }
  // recent decisions in scope
  const decs = (db.prepare("SELECT node_id, chosen, outcome_status, outcome, created_at FROM decisions WHERE merged_into IS NULL ORDER BY COALESCE(outcome_at, created_at) DESC LIMIT 300").all() as Array<{ node_id: string; chosen: string; outcome_status: string | null; outcome: string | null; created_at: number }>)
    .filter((d) => sc.ids.has(d.node_id) || (sc.goalLineage && (db.prepare("SELECT 1 FROM decisions WHERE node_id = ? AND goal_id = ?").get(d.node_id, sc.goalLineage)))).slice(0, 3);
  if (decs.length) L.push(`Recent decisions: ${decs.map((d) => `${short(d.chosen, 40)}${d.outcome_status ? ` (${d.outcome_status})` : " (no outcome yet)"}`).join("; ")}`);
  // open items about the scope (or matching the topic)
  const opens = listOpenItems(agentId, { status: "active", limit: 50 }).filter((o) => sc.ids.has(o.node_id) || o.links.some((l) => sc.ids.has(l.id)) || (sc.topic && tokenOverlap(sc.topic, o.text) >= 1)).slice(0, 3);
  if (opens.length) L.push(`Open: ${opens.map((o) => `${o.kind} "${short(o.text, 60)}"${o.contradicted_at ? " (CONTRADICTED)" : ""}`).join("; ")}`);
  // commitments in scope
  const com = listCommitments(agentId, { status: "open", now }).filter((c) => sc.ids.has(c.node_id) || (db.prepare("SELECT 1 FROM edges WHERE from_id = ? AND type = 'about' AND to_id IN (SELECT value FROM json_each(?))").get(c.node_id, JSON.stringify([...sc.ids])))).slice(0, 3);
  for (const c of com) L.push(`Commitment: ${formatCommitment(c, now).split("\n")[0]!.replace(/^\S+ /, "")}`);
  // latest reflection in scope
  const refl = db.prepare(`SELECT r.node_id, n.content, r.updated_at FROM reflections r JOIN nodes n ON n.id = r.node_id WHERE n.status = 'active' AND (r.scope_ref = ? OR r.scope_ref = ? OR r.scope_ref = ?) ORDER BY r.updated_at DESC LIMIT 1`).get(sc.goalLineage ?? "\u0000", sc.planId ?? "\u0000", sc.topic ?? "\u0000") as { content: string; updated_at: number } | undefined;
  if (refl) L.push(`Last reflection (${ago(refl.updated_at, now)}): ${short(refl.content.replace(/^Reflection[^:]*:\s*/, ""), 260)}`);
  const ch = changesSince(agentId, { ...(sc.planId ? { planId: sc.planId } : sc.goalLineage ? { goalId: sc.goalLineage } : { topic: sc.topic! }), since, until: now }, 12);
  L.push(ch.changes.length ? `Changed since ${ago(since, now)}${sc.kind === "plan" && since !== now - 7 * DAY ? " (since parked)" : ""}:` : `Nothing changed since ${ago(since, now)}.`);
  for (const c of ch.changes) L.push(`- ${ago(c.at, now)} · ${c.kind}: ${c.text}`);
  return { ok: true, text: capLines(L, maxChars(config)) };
}
const tokenOverlap = (a: string, b: string) => { const x = tokenSet(a), y = tokenSet(b); let i = 0; for (const t of x) if (y.has(t)) i++; return i; };

// ─── forget impact (dry run) ───────────────────────────────────────────────

const PROTECTED = new Set(["identity", "goal", "skill", "decision", "commitment", "plan", "assumption", "hypothesis", "question", "reflection", "schema"]);

export function forgetImpact(agentId: string, args: { cluster?: string; query?: string }, config: Partial<BrainConfig>, now = Date.now()): { ok: boolean; error?: string; text?: string; summary?: Record<string, number> } {
  const db: Db = getDb(agentId);
  let ids: string[] = [];
  let label = "";
  if (args.cluster) {
    const c = resolveRef(agentId, args.cluster);
    if (!c) return { ok: false, error: `cluster node ${args.cluster} not found` };
    const mem = db.prepare(`SELECT from_id id FROM edges WHERE to_id = ? AND type IN ('instance_of', 'summarizes', 'supports', 'derived_from', 'about') AND valid_until IS NULL
                            UNION SELECT to_id FROM edges WHERE from_id = ? AND type IN ('summarizes', 'derived_from') AND valid_until IS NULL`).all(c.id, c.id) as Array<{ id: string }>;
    ids = [c.id, ...mem.map((m) => m.id)];
    label = `cluster "${short(c.label, 60)}"`;
  } else if (args.query && args.query.trim()) {
    ids = [...topicIds(agentId, args.query, 40)];
    label = `"${short(args.query, 60)}"`;
  } else return { ok: false, error: "give cluster (a node id) or query" };
  if (!ids.length) return { ok: true, text: `Nothing matches ${label}; forgetting it would lose nothing.`, summary: { nodes: 0 } };
  const set = new Set(ids);
  const ph = ids.map(() => "?").join(",");
  const nodes = db.prepare(`SELECT id, type, label, importance, confidence_score, evidence, accessed_at, access_count, status FROM nodes WHERE id IN (${ph}) AND status = 'active'`).all(...ids) as Array<{ id: string; type: string; label: string; importance: number; confidence_score: number; evidence: string | null; accessed_at: number | null; access_count: number; status: string }>;
  const byType: Record<string, number> = {};
  for (const n of nodes) byType[n.type] = (byType[n.type] ?? 0) + 1;
  const prot = nodes.filter((n) => PROTECTED.has(n.type) || n.importance >= 0.8);
  // unique = no near-duplicate (label Jaccard ≥ 0.5) among active nodes OUTSIDE the set
  const unique: typeof nodes = [];
  for (const n of nodes.filter((x) => !PROTECTED.has(x.type))) {
    let has = false;
    try { for (const o of ftsSearchNodes(agentId, n.label, 6)) if (!set.has(o.id) && jaccard(tokenSet(o.label), tokenSet(n.label)) >= 0.5) { has = true; break; } } catch { /* ignore */ }
    if (!has) unique.push(n);
  }
  const cut = (db.prepare(`SELECT COUNT(*) n FROM edges WHERE valid_until IS NULL AND ((from_id IN (${ph}) AND to_id NOT IN (${ph})) OR (to_id IN (${ph}) AND from_id NOT IN (${ph})))`).get(...ids, ...ids, ...ids, ...ids) as { n: number }).n;
  const refs = db.prepare(`SELECT DISTINCT n.type, n.label FROM edges e JOIN nodes n ON n.id = e.from_id WHERE e.to_id IN (${ph}) AND e.from_id NOT IN (${ph}) AND e.valid_until IS NULL AND n.status = 'active'
                             AND n.type IN ('decision', 'hypothesis', 'question', 'assumption', 'commitment', 'plan', 'reflection', 'skill') LIMIT 6`).all(...ids, ...ids) as Array<{ type: string; label: string }>;
  const evIds = new Set<string>(); for (const n of nodes) for (const e of safeJsonArr(n.evidence)) evIds.add(e);
  const recoverable = evIds.size ? (db.prepare(`SELECT COUNT(*) n FROM episodes WHERE id IN (${[...evIds].map(() => "?").join(",")})`).get(...evIds) as { n: number }).n : 0;
  const lastUse = Math.max(0, ...nodes.map((n) => n.accessed_at ?? 0));
  const L = [
    `Forget impact for ${label} (dry run — nothing changed): ${nodes.length} active node${nodes.length === 1 ? "" : "s"} (${Object.entries(byType).map(([t, c]) => `${t} ${c}`).join(", ")}).`,
    `- would lose ${unique.length} unique fact${unique.length === 1 ? "" : "s"} (no near-duplicate elsewhere)${unique.length ? `: ${unique.slice(0, 4).map((n) => short(n.label, 50)).join("; ")}${unique.length > 4 ? "; …" : ""}` : ""}`,
    `- ${prot.length} protected item${prot.length === 1 ? "" : "s"} (identity / goals / skills / decisions / commitments / plans / open items / high importance) — compaction should keep these${prot.length ? `: ${prot.slice(0, 3).map((n) => `${n.type} "${short(n.label, 40)}"`).join("; ")}` : ""}`,
    `- ${cut} link${cut === 1 ? "" : "s"} to the rest of the graph would be cut${refs.length ? `; referenced by ${refs.map((r) => `${r.type} "${short(r.label, 40)}"`).join("; ")}` : ""}`,
    `- ${recoverable} source episode${recoverable === 1 ? "" : "s"} still hold the raw text (re-extractable)`,
    `- last used ${lastUse ? ago(lastUse, now) : "never"}`,
    `Verdict: ${prot.length || refs.length ? "NOT safe to forget wholesale — keep the protected / referenced items" : unique.length ? "compacting loses unique facts; summarize before forgetting" : "safe to compact (everything is duplicated elsewhere)"}.`,
  ];
  return { ok: true, text: capLines(L, maxChars(config)), summary: { nodes: nodes.length, unique: unique.length, protected: prot.length, edgesCut: cut, recoverableEpisodes: recoverable } };
}
