/**
 * Xanima 0.3.0 — commitments (to the user or to self), blocking dependencies
 * and plans with steps (park / resume). Commitment and plan are node types
 * (`commitment`, `plan`) with structured rows; dependencies are "X is blocked
 * by Y" between any two nodes (or a plan step, `step:<id>`).
 *
 * Overdue / blocked commitments become a one-line nudge in the same offered →
 * acked queue as the goal alignment note (consumed only by a real reply).
 */
import { getDb, getMeta, setMeta, bumpWriteCounter } from "./db.js";
import { writeNode } from "./nodes.js";
import { writeEdge } from "./edges.js";
import { deriveKeywords } from "./goals.js";
import { clean, parseWhen, resolveRef, safeJsonArr, ago, DAY, HOUR } from "./continuity-util.js";
import { setTaskFrame, clearFramesForPlan, currentTaskEnabled } from "./task-frame.js";
import type { BrainConfig } from "./types.js";

export type CommitmentStatus = "open" | "done" | "dropped";
export interface CommitmentRow { node_id: string; title: string; owner: string; counterparty: string; status: CommitmentStatus; due_at: number | null; note: string | null; created_at: number; updated_at: number; done_at: number | null; last_nudged_at: number | null }
export interface Blocker { id: string; label: string; done: boolean }
export interface CommitmentView extends CommitmentRow { blockers: Blocker[]; overdue: boolean; blocked: boolean }

function findRow<T>(agentId: string, table: string, idOrPrefix: string): T | null {
  const db = getDb(agentId);
  const id = idOrPrefix.trim();
  if (!id) return null;
  const exact = db.prepare(`SELECT * FROM ${table} WHERE node_id = ?`).get(id) as T | undefined;
  if (exact) return exact;
  if (id.length < 8) return null;
  const rows = db.prepare(`SELECT * FROM ${table} WHERE node_id LIKE ? LIMIT 2`).all(id + "%") as T[];
  return rows.length === 1 ? rows[0]! : null;
}

/** Is a blocker finished? commitment done/dropped, plan done/abandoned, step done/skipped, decision with an outcome, open item closed/supported/refuted, goal done; other nodes: retracted/archived/superseded. */
export function blockerDone(agentId: string, blockerId: string): boolean { return blockerDoneDb(getDb(agentId), blockerId); }
type Db = ReturnType<typeof getDb>;
function blockerDoneDb(db: Db, blockerId: string): boolean {
  if (blockerId.startsWith("step:")) {
    const s = db.prepare("SELECT status FROM plan_steps WHERE id = ?").get(Number(blockerId.slice(5))) as { status: string } | undefined;
    return !s || s.status === "done" || s.status === "skipped";
  }
  const c = db.prepare("SELECT status FROM commitments WHERE node_id = ?").get(blockerId) as { status: string } | undefined;
  if (c) return c.status !== "open";
  const p = db.prepare("SELECT status FROM plans WHERE node_id = ?").get(blockerId) as { status: string } | undefined;
  if (p) return p.status === "done" || p.status === "abandoned";
  const d = db.prepare("SELECT outcome_at FROM decisions WHERE node_id = ?").get(blockerId) as { outcome_at: number | null } | undefined;
  if (d) return d.outcome_at !== null;
  const o = db.prepare("SELECT status FROM open_items WHERE node_id = ?").get(blockerId) as { status: string } | undefined;
  if (o) return o.status !== "open";
  const g = db.prepare("SELECT status FROM goals WHERE node_id = ? ORDER BY version DESC LIMIT 1").get(blockerId) as { status: string } | undefined;
  if (g) return g.status === "done" || g.status === "archived";
  const n = db.prepare("SELECT status FROM nodes WHERE id = ?").get(blockerId) as { status: string } | undefined;
  return !n || n.status !== "active";
}

function blockerLabel(db: Db, id: string): string {
  if (id.startsWith("step:")) {
    const s = db.prepare("SELECT s.text, p.title FROM plan_steps s JOIN plans p ON p.node_id = s.plan_id WHERE s.id = ?").get(Number(id.slice(5))) as { text: string; title: string } | undefined;
    return s ? `step "${s.text}" of plan "${s.title}"` : id;
  }
  return (db.prepare("SELECT label FROM nodes WHERE id = ?").get(id) as { label: string } | undefined)?.label ?? id;
}

export function blockersOf(agentId: string, blockedId: string): Blocker[] { return blockersOfDb(getDb(agentId), blockedId); }
function blockersOfDb(db: Db, blockedId: string): Blocker[] {
  const rows = db.prepare("SELECT blocker_id FROM dependencies WHERE blocked_id = ? AND resolved_at IS NULL").all(blockedId) as Array<{ blocker_id: string }>;
  return rows.map((r) => ({ id: r.blocker_id, label: blockerLabel(db, r.blocker_id), done: blockerDoneDb(db, r.blocker_id) }));
}

/** Resolve a blocker reference: node id / prefix / goal id, or "step:<id>". */
function resolveBlocker(agentId: string, ref: string): string | null {
  if (/^step:\d+$/.test(ref)) return (getDb(agentId).prepare("SELECT id FROM plan_steps WHERE id = ?").get(Number(ref.slice(5))) ? ref : null);
  return resolveRef(agentId, ref)?.id ?? null;
}

export function addBlockers(agentId: string, blockedId: string, refs: string[], now = Date.now()): string | null {
  const db = getDb(agentId);
  for (const ref of refs) {
    const b = resolveBlocker(agentId, ref);
    if (!b) return `blocker ${ref} not found`;
    if (b === blockedId) return "a task can't block itself";
    if (wouldCycle(agentId, blockedId, b)) return `blocking on ${ref} would create a cycle`;
    db.prepare("INSERT INTO dependencies (blocked_id, blocker_id, created_at) VALUES (?, ?, ?) ON CONFLICT(blocked_id, blocker_id) DO UPDATE SET resolved_at = NULL").run(blockedId, b, now);
    if (!blockedId.startsWith("step:") && !b.startsWith("step:")) writeEdge(agentId, blockedId, b, "blocked_by", { writerAgentId: agentId });
  }
  return null;
}
function wouldCycle(agentId: string, blocked: string, blocker: string): boolean {
  const db = getDb(agentId);
  const seen = new Set<string>();
  const stack = [blocker];
  while (stack.length) {
    const x = stack.pop()!;
    if (x === blocked) return true;
    if (seen.has(x) || seen.size > 500) continue;
    seen.add(x);
    for (const r of db.prepare("SELECT blocker_id FROM dependencies WHERE blocked_id = ? AND resolved_at IS NULL").all(x) as Array<{ blocker_id: string }>) stack.push(r.blocker_id);
  }
  return false;
}
export function removeBlockers(agentId: string, blockedId: string, refs: string[] | "all", now = Date.now()): void {
  const db = getDb(agentId);
  if (refs === "all") { db.prepare("UPDATE dependencies SET resolved_at = ? WHERE blocked_id = ? AND resolved_at IS NULL").run(now, blockedId); return; }
  for (const ref of refs) { const b = resolveBlocker(agentId, ref); if (b) db.prepare("UPDATE dependencies SET resolved_at = ? WHERE blocked_id = ? AND blocker_id = ?").run(now, blockedId, b); }
}

// ─── commitments ───────────────────────────────────────────────────────────

export interface CommitInput { title: string; to?: string; due?: unknown; note?: string; links?: string[]; blockedBy?: string[]; writerAgentId?: string; now?: number }

export function createCommitment(agentId: string, input: CommitInput): { ok: boolean; error?: string; commitment?: CommitmentView } {
  const title = clean(input.title, 300);
  if (title.length < 3) return { ok: false, error: "title is required (what you committed to)" };
  const now = input.now ?? Date.now();
  const due = input.due !== undefined && input.due !== null && input.due !== "" ? parseWhen(input.due, now) : null;
  if (input.due !== undefined && input.due !== null && input.due !== "" && due === null) return { ok: false, error: 'due must be an ISO date, epoch ms, "tomorrow" or "in 3 days"' };
  const to = clean(input.to, 60).toLowerCase() || "user";
  for (const l of input.links ?? []) if (!resolveRef(agentId, l)) return { ok: false, error: `link target ${l} not found` };
  for (const b of input.blockedBy ?? []) if (!resolveBlocker(agentId, b)) return { ok: false, error: `blocker ${b} not found` };
  const id = writeNode(agentId, "commitment", `Commitment: ${title.slice(0, 90)}`, `Commitment (to ${to}${due ? `, due ${new Date(due).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}): ${title}${input.note ? `. ${clean(input.note, 400)}` : ""}`, {
    importance: 0.7, source: "commitment", deduplicate: false, writerAgentId: input.writerAgentId ?? agentId, sourceType: "self_observation", confidence: "high",
  });
  getDb(agentId).prepare("INSERT INTO commitments (node_id, title, owner, counterparty, status, due_at, note, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)")
    .run(id, title, agentId, to, due, clean(input.note, 400) || null, now, now);
  for (const l of input.links ?? []) writeEdge(agentId, id, resolveRef(agentId, l)!.id, "about", { writerAgentId: input.writerAgentId ?? agentId });
  const e = addBlockers(agentId, id, input.blockedBy ?? [], now);
  if (e) return { ok: false, error: e };
  bumpWriteCounter(getDb(agentId));
  return { ok: true, commitment: getCommitment(agentId, id)! };
}

export function getCommitment(agentId: string, idOrPrefix: string, now = Date.now()): CommitmentView | null {
  const r = findRow<CommitmentRow>(agentId, "commitments", idOrPrefix);
  if (!r) return null;
  const blockers = blockersOf(agentId, r.node_id);
  return { ...r, blockers, overdue: r.status === "open" && r.due_at !== null && r.due_at < now, blocked: r.status === "open" && blockers.some((b) => !b.done) };
}

export type CommitAction = "update" | "done" | "drop" | "reopen" | "block" | "unblock";
export function updateCommitment(agentId: string, idOrPrefix: string, input: { action: CommitAction; title?: string; due?: unknown; note?: string; blockedBy?: string[]; reason?: string; now?: number }): { ok: boolean; error?: string; commitment?: CommitmentView } {
  const cur = getCommitment(agentId, idOrPrefix);
  if (!cur) return { ok: false, error: `commitment ${idOrPrefix} not found (brain_commitments shows ids)` };
  const db = getDb(agentId);
  const now = input.now ?? Date.now();
  const set = (sql: string, ...a: unknown[]) => db.prepare(`UPDATE commitments SET ${sql}, updated_at = ? WHERE node_id = ?`).run(...a, now, cur.node_id);
  switch (input.action) {
    case "update": {
      if (input.title) set("title = ?", clean(input.title, 300));
      if (input.due !== undefined) { const d = input.due === null || input.due === "" ? null : parseWhen(input.due, now); if (input.due && d === null) return { ok: false, error: "unparseable due" }; set("due_at = ?, last_nudged_at = NULL", d); }
      if (input.note !== undefined) set("note = ?", clean(input.note, 400) || null);
      break;
    }
    case "done": set("status = 'done', done_at = ?", now); break;
    case "drop": set("status = 'dropped', done_at = ?, note = COALESCE(?, note)", now, clean(input.reason, 300) || null); break;
    case "reopen": set("status = 'open', done_at = NULL"); break;
    case "block": { if (!input.blockedBy?.length) return { ok: false, error: "block needs blocked_by" }; const e = addBlockers(agentId, cur.node_id, input.blockedBy, now); if (e) return { ok: false, error: e }; set("last_nudged_at = NULL"); break; }
    case "unblock": removeBlockers(agentId, cur.node_id, input.blockedBy?.length ? input.blockedBy : "all", now); break;
    default: return { ok: false, error: "action must be update | done | drop | reopen | block | unblock" };
  }
  if (input.action === "done" || input.action === "drop") {
    db.prepare("UPDATE alignment_notes SET superseded_at = ? WHERE kind = 'commitment' AND ref_id = ? AND delivered_at IS NULL AND superseded_at IS NULL").run(now, cur.node_id);
    db.prepare("UPDATE nodes SET status = 'archived', status_reason = ?, status_changed_at = ?, updated_at = ? WHERE id = ?").run(`commitment ${input.action === "done" ? "done" : "dropped"}`, now, now, cur.node_id);
  } else if (input.action === "reopen") {
    db.prepare("UPDATE nodes SET status = 'active', status_reason = NULL, status_changed_at = ?, valid_until = NULL, updated_at = ? WHERE id = ?").run(now, now, cur.node_id);
  }
  const v = getCommitment(agentId, cur.node_id, now)!;
  db.prepare("UPDATE nodes SET content = ?, updated_at = ? WHERE id = ?").run(`Commitment (to ${v.counterparty}${v.due_at ? `, due ${new Date(v.due_at).toISOString().slice(0, 16).replace("T", " ")} UTC` : ""}) [${v.status}]: ${v.title}${v.note ? `. ${v.note}` : ""}`, now, cur.node_id);
  bumpWriteCounter(db);
  return { ok: true, commitment: v };
}

export function listCommitments(agentId: string, opts: { status?: "open" | "overdue" | "blocked" | "done" | "all"; now?: number } = {}): CommitmentView[] {
  const now = opts.now ?? Date.now();
  const st = opts.status ?? "open";
  const db = getDb(agentId);
  const rows = db.prepare(`SELECT node_id FROM commitments ${st === "all" ? "" : st === "done" ? "WHERE status != 'open'" : "WHERE status = 'open'"} ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at, created_at LIMIT 200`).all() as Array<{ node_id: string }>;
  let out = rows.map((r) => getCommitment(agentId, r.node_id, now)!);
  if (st === "overdue") out = out.filter((c) => c.overdue);
  if (st === "blocked") out = out.filter((c) => c.blocked);
  return out;
}

export function formatCommitment(c: CommitmentView, now = Date.now()): string {
  const flags = [c.overdue ? `OVERDUE (due ${ago(c.due_at, now)})` : c.due_at ? `due ${ago(c.due_at, now)}` : "", c.blocked ? "BLOCKED" : ""].filter(Boolean).join(" · ");
  const L = [`${c.node_id} [${c.status}] ${c.title}  (to ${c.counterparty}${flags ? ` · ${flags}` : ""} · made ${ago(c.created_at, now)})`];
  for (const b of c.blockers) L.push(`  blocked by: ${b.label}${b.done ? " (done)" : ""}`);
  if (c.note) L.push(`  note: ${c.note}`);
  return L.join("\n");
}

/** Queue at most one nudge for an overdue / blocked commitment (24 h per commitment). Called from sleep and (throttled) at turn time. */
export function runCommitmentCheck(agentId: string, config: Partial<BrainConfig>, now = Date.now()): { overdue: number; blocked: number; nudged: string | null } {
  const res = { overdue: 0, blocked: 0, nudged: null as string | null };
  const all = listCommitments(agentId, { status: "open", now });
  const due = all.filter((c) => c.overdue || c.blocked);
  res.overdue = due.filter((c) => c.overdue).length;
  res.blocked = due.filter((c) => c.blocked).length;
  setMeta(agentId, "commitments:last_check", String(now));
  if (config.commitmentNudges === false || !due.length) return res;
  const db = getDb(agentId);
  if (db.prepare("SELECT 1 FROM alignment_notes WHERE kind = 'commitment' AND delivered_at IS NULL AND superseded_at IS NULL").get()) return res; // one pending at a time
  const pick = due.filter((c) => !c.last_nudged_at || now - c.last_nudged_at >= DAY).sort((a, b) => (a.due_at ?? Infinity) - (b.due_at ?? Infinity))[0];
  if (!pick) return res;
  const waiting = pick.blockers.find((b) => !b.done);
  const text = pick.overdue
    ? `Commitment overdue: "${pick.title.slice(0, 90)}" (to ${pick.counterparty}, due ${ago(pick.due_at, now)})${waiting ? ` — blocked by ${waiting.label.slice(0, 60)}` : ""}. Do it, re-date it, or drop it with brain_commit.`
    : `Commitment blocked: "${pick.title.slice(0, 90)}" — waiting on ${waiting!.label.slice(0, 80)}.`;
  db.prepare("INSERT INTO alignment_notes (created_at, text, lineage_ids_json, kind, ref_id) VALUES (?, ?, '[]', 'commitment', ?)").run(now, text, pick.node_id);
  db.prepare("UPDATE commitments SET last_nudged_at = ? WHERE node_id = ?").run(now, pick.node_id);
  res.nudged = pick.node_id;
  return res;
}

export function maybeRunCommitmentCheck(agentId: string, config: Partial<BrainConfig>, now = Date.now()): void {
  const last = Number(getMeta(agentId, "commitments:last_check") ?? 0);
  if (now - last < HOUR) return;
  runCommitmentCheck(agentId, config, now);
}

export function commitmentCounts(db: Db, now = Date.now()): { open: number; overdue: Array<{ id: string; title: string; due_at: number }>; blocked: Array<{ id: string; title: string; waiting: string }>; pendingNudge: string | null; plansActive: number; plansParked: number; plansHandedOff: number } {
  const zero = { open: 0, overdue: [], blocked: [], pendingNudge: null, plansActive: 0, plansParked: 0, plansHandedOff: 0 };
  try {
    const open = (db.prepare("SELECT * FROM commitments WHERE status = 'open'").all() as CommitmentRow[]).map((r) => {
      const blockers = blockersOfDb(db, r.node_id);
      return { ...r, blockers, overdue: r.due_at !== null && r.due_at < now, blocked: blockers.some((b) => !b.done) };
    });
    const n = db.prepare("SELECT text FROM alignment_notes WHERE kind = 'commitment' AND delivered_at IS NULL AND superseded_at IS NULL ORDER BY id DESC LIMIT 1").get() as { text: string } | undefined;
    const p = db.prepare("SELECT SUM(status='active') a, SUM(status='parked') p, SUM(status='handed_off') h FROM plans").get() as Record<string, number | null>;
    return {
      open: open.length,
      overdue: open.filter((c) => c.overdue).map((c) => ({ id: c.node_id, title: c.title, due_at: c.due_at! })),
      blocked: open.filter((c) => c.blocked).map((c) => ({ id: c.node_id, title: c.title, waiting: c.blockers.find((b) => !b.done)!.label })),
      pendingNudge: n?.text ?? null, plansActive: p["a"] ?? 0, plansParked: p["p"] ?? 0, plansHandedOff: p["h"] ?? 0,
    };
  } catch { return zero; }
}

// ─── plans ─────────────────────────────────────────────────────────────────

/** 0.7: `handed_off` — another agent owns it now; resume takes it back. */
export type PlanStatus = "active" | "parked" | "done" | "abandoned" | "handed_off";
export const PLAN_STATUSES: PlanStatus[] = ["active", "parked", "done", "abandoned", "handed_off"];
export interface PlanRow {
  node_id: string; title: string; goal_id: string | null; status: PlanStatus; keywords_json: string; parked_at: number | null; park_note: string | null; resumed_at: number | null; created_at: number; updated_at: number;
  /** 0.7 (schema v28): who took the plan over, why, and when. */
  handoff_to?: string | null; handoff_note?: string | null; handoff_at?: number | null;
}
export interface StepRow { id: number; plan_id: string; idx: number; text: string; status: string; note: string | null; updated_at: number }
export interface PlanView extends PlanRow { steps: Array<StepRow & { blockers: Blocker[] }>; goal_title: string | null }
export const STEP_STATUSES = ["todo", "doing", "done", "blocked", "skipped"];

export function getPlan(agentId: string, idOrPrefix: string): PlanView | null {
  const r = findRow<PlanRow>(agentId, "plans", idOrPrefix);
  if (!r) return null;
  const db = getDb(agentId);
  const steps = (db.prepare("SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY idx").all(r.node_id) as StepRow[]).map((s) => ({ ...s, blockers: blockersOf(agentId, `step:${s.id}`) }));
  const g = r.goal_id ? (db.prepare("SELECT title FROM goals WHERE lineage_id = ? ORDER BY version DESC LIMIT 1").get(r.goal_id) as { title: string } | undefined) : undefined;
  return { ...r, steps, goal_title: g?.title ?? null };
}

function planContent(p: PlanView): string {
  const handed = p.status === "handed_off" && p.handoff_to ? ` HANDED OFF to ${p.handoff_to}${p.handoff_note ? ` (${p.handoff_note})` : ""} — not yours to carry out unless you take it back (brain_plan resume).` : "";
  return `Plan [${p.status}]: ${p.title}${p.goal_title ? ` (goal: ${p.goal_title})` : ""}.${handed} Steps: ${p.steps.map((s) => `${s.idx}. ${s.text} [${s.status}]`).join("; ")}`.slice(0, 2000);
}

/** 0.7: creating / stepping / resuming a plan makes it the session's current task (task-frame.ts). */
function pinPlan(agentId: string, sessionKey: string | undefined, p: PlanView, config: Partial<BrainConfig> | undefined, now: number): void {
  if (!currentTaskEnabled(config)) return;
  const next = p.steps.find((s) => s.status === "doing") ?? p.steps.find((s) => s.status === "todo" || s.status === "blocked");
  try { setTaskFrame(agentId, sessionKey ?? "", { title: p.title, planId: p.node_id, goalId: p.goal_id, note: next ? `next: ${next.idx}. ${next.text}` : null, setBy: "plan" }, now); } catch { /* pre-v28 */ }
}

export function createPlan(agentId: string, input: { title: string; goalId?: string; steps?: string[]; links?: string[]; writerAgentId?: string; now?: number; sessionKey?: string; config?: Partial<BrainConfig> }): { ok: boolean; error?: string; plan?: PlanView } {
  const title = clean(input.title, 300);
  if (title.length < 3) return { ok: false, error: "title is required" };
  const now = input.now ?? Date.now();
  const db = getDb(agentId);
  let goalLineage: string | null = null, goalNode: string | null = null;
  if (input.goalId) {
    const g = db.prepare("SELECT lineage_id, node_id FROM goals WHERE lineage_id = ? OR node_id = ? OR lineage_id LIKE ? ORDER BY version DESC LIMIT 1").get(input.goalId, input.goalId, input.goalId.length >= 8 ? input.goalId + "%" : "\u0000") as { lineage_id: string; node_id: string } | undefined;
    if (!g) return { ok: false, error: `goal ${input.goalId} not found` };
    goalLineage = g.lineage_id;
    goalNode = (db.prepare("SELECT node_id FROM goals WHERE lineage_id = ? ORDER BY version DESC LIMIT 1").get(g.lineage_id) as { node_id: string }).node_id;
  }
  for (const l of input.links ?? []) if (!resolveRef(agentId, l)) return { ok: false, error: `link target ${l} not found` };
  const steps = (input.steps ?? []).map((s) => clean(s, 300)).filter(Boolean).slice(0, 40);
  const id = writeNode(agentId, "plan", `Plan: ${title.slice(0, 90)}`, `Plan: ${title}`, { importance: 0.7, source: "plan", deduplicate: false, writerAgentId: input.writerAgentId ?? agentId, sourceType: "self_observation", confidence: "high" });
  db.prepare("INSERT INTO plans (node_id, title, goal_id, status, keywords_json, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?)").run(id, title, goalLineage, JSON.stringify(deriveKeywords(title, steps.join(" "))), now, now);
  const ins = db.prepare("INSERT INTO plan_steps (plan_id, idx, text, status, updated_at) VALUES (?, ?, ?, 'todo', ?)");
  steps.forEach((s, i) => ins.run(id, i + 1, s, now));
  if (goalNode) writeEdge(agentId, id, goalNode, "advances", { writerAgentId: input.writerAgentId ?? agentId });
  for (const l of input.links ?? []) writeEdge(agentId, id, resolveRef(agentId, l)!.id, "about", { writerAgentId: input.writerAgentId ?? agentId });
  const p = getPlan(agentId, id)!;
  db.prepare("UPDATE nodes SET content = ? WHERE id = ?").run(planContent(p), id);
  bumpWriteCounter(db);
  pinPlan(agentId, input.sessionKey, p, input.config, now);
  return { ok: true, plan: p };
}

export type PlanAction = "update" | "step" | "add_steps" | "park" | "resume" | "done" | "abandon" | "handoff";
export const PLAN_ACTIONS: PlanAction[] = ["update", "step", "add_steps", "park", "resume", "done", "abandon", "handoff"];

export function updatePlan(agentId: string, idOrPrefix: string, input: { action: PlanAction; title?: string; steps?: string[]; step?: number; status?: string; note?: string; blockedBy?: string[]; to?: string; now?: number; sessionKey?: string; config?: Partial<BrainConfig> }): { ok: boolean; error?: string; plan?: PlanView; previousParkedAt?: number | null; previousStatus?: PlanStatus; previousHandoffAt?: number | null } {
  const cur = getPlan(agentId, idOrPrefix);
  if (!cur) return { ok: false, error: `plan ${idOrPrefix} not found (brain_plan {"action":"list"} shows ids)` };
  const db = getDb(agentId);
  const now = input.now ?? Date.now();
  const set = (sql: string, ...a: unknown[]) => db.prepare(`UPDATE plans SET ${sql}, updated_at = ? WHERE node_id = ?`).run(...a, now, cur.node_id);
  const prevParked = cur.parked_at;
  const prevStatus = cur.status;
  switch (input.action) {
    case "update": if (input.title) set("title = ?", clean(input.title, 300)); break;
    case "add_steps": {
      const ins = db.prepare("INSERT INTO plan_steps (plan_id, idx, text, status, updated_at) VALUES (?, ?, ?, 'todo', ?)");
      let i = cur.steps.length;
      for (const s of (input.steps ?? []).map((x) => clean(x, 300)).filter(Boolean)) ins.run(cur.node_id, ++i, s, now);
      set("keywords_json = ?", JSON.stringify(deriveKeywords(cur.title, [...cur.steps.map((s) => s.text), ...(input.steps ?? [])].join(" "))));
      break;
    }
    case "step": {
      const st = cur.steps.find((s) => s.idx === input.step);
      if (!st) return { ok: false, error: `step ${input.step} not found (steps are numbered from 1)` };
      if (input.status && !STEP_STATUSES.includes(input.status)) return { ok: false, error: `status must be one of ${STEP_STATUSES.join(", ")}` };
      if (input.blockedBy?.length) { const e = addBlockers(agentId, `step:${st.id}`, input.blockedBy, now); if (e) return { ok: false, error: e }; }
      db.prepare("UPDATE plan_steps SET status = COALESCE(?, status), note = COALESCE(?, note), updated_at = ? WHERE id = ?").run(input.status ?? (input.blockedBy?.length ? "blocked" : null), clean(input.note, 300) || null, now, st.id);
      set("status = status");
      break;
    }
    case "park": if (cur.status !== "active") return { ok: false, error: `plan is ${cur.status}` }; set("status = 'parked', parked_at = ?, park_note = ?", now, clean(input.note, 400) || null); break;
    case "resume": {
      // parked → active (the old behaviour) or handed_off → active (take it back)
      if (cur.status !== "parked" && cur.status !== "handed_off") return { ok: false, error: `plan is ${cur.status}, not parked or handed off` };
      set("status = 'active', resumed_at = ?, handoff_to = NULL, handoff_note = NULL, handoff_at = NULL", now);
      break;
    }
    case "done": set("status = 'done'"); break;
    case "abandon": set("status = 'abandoned', park_note = COALESCE(?, park_note)", clean(input.note, 400) || null); break;
    case "handoff": {
      // 0.7: another agent owns this plan now. It leaves briefings / the current task and is
      // never resumed by "continue"; `resume` takes it back explicitly.
      const to = clean(input.to, 80);
      if (!to) return { ok: false, error: "handoff needs to: who takes the plan over (an agent name)" };
      if (cur.status !== "active" && cur.status !== "parked") return { ok: false, error: `plan is ${cur.status}` };
      set("status = 'handed_off', handoff_to = ?, handoff_note = ?, handoff_at = ?", to, clean(input.note, 400) || null, now);
      break;
    }
    default: return { ok: false, error: `action must be one of ${PLAN_ACTIONS.join(", ")}` };
  }
  const p = getPlan(agentId, cur.node_id)!;
  db.prepare("UPDATE nodes SET content = ?, label = ?, updated_at = ? WHERE id = ?").run(planContent(p), `Plan: ${p.title.slice(0, 90)}`, now, cur.node_id);
  bumpWriteCounter(db);
  // 0.7 current task: stepping / resuming pins the plan; finishing, parking, abandoning or handing it off un-pins it everywhere.
  if (input.action === "step" || input.action === "resume" || input.action === "add_steps") pinPlan(agentId, input.sessionKey, p, input.config, now);
  else if (input.action === "done" || input.action === "abandon" || input.action === "park" || input.action === "handoff") { try { clearFramesForPlan(agentId, cur.node_id); } catch { /* pre-v28 */ } }
  return { ok: true, plan: p, previousParkedAt: prevParked, previousStatus: prevStatus, previousHandoffAt: cur.handoff_at ?? null };
}

export function listPlans(agentId: string, status: PlanStatus | "all" = "active"): PlanView[] {
  const rows = getDb(agentId).prepare(`SELECT node_id FROM plans ${status === "all" ? "" : "WHERE status = ?"} ORDER BY updated_at DESC LIMIT 50`).all(...(status === "all" ? [] : [status])) as Array<{ node_id: string }>;
  return rows.map((r) => getPlan(agentId, r.node_id)!);
}

const MARK: Record<string, string> = { todo: "[ ]", doing: "[~]", done: "[x]", blocked: "[!]", skipped: "[-]" };
export function formatPlan(p: PlanView, now = Date.now()): string {
  const st = p.status === "handed_off" ? `handed_off → ${p.handoff_to ?? "?"}` : p.status;
  const L = [`${p.node_id} Plan [${st}] ${p.title}${p.goal_title ? `  (goal: ${p.goal_title})` : ""}  (created ${ago(p.created_at, now)}${p.parked_at && p.status === "parked" ? ` · parked ${ago(p.parked_at, now)}` : ""}${p.status === "handed_off" && p.handoff_at ? ` · handed off ${ago(p.handoff_at, now)}` : ""})`];
  if (p.status === "parked" && p.park_note) L.push(`  parked because: ${p.park_note}`);
  if (p.status === "handed_off") L.push(`  handed to ${p.handoff_to ?? "?"}${p.handoff_note ? `: ${p.handoff_note}` : ""} — theirs now; brain_plan resume takes it back`);
  for (const s of p.steps) {
    const bl = s.blockers.filter((b) => !b.done);
    L.push(`  ${MARK[s.status] ?? "[ ]"} ${s.idx}. ${s.text}${s.note ? ` — ${s.note}` : ""}${bl.length ? ` (blocked by ${bl.map((b) => b.label).join(", ")})` : ""}`);
  }
  return L.join("\n");
}

export { safeJsonArr };
