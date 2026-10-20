// packages/core/src/now-context.ts — the "[BRAIN: now]" block (Xanima 0.7).
//
// Injected every turn, above recall: what this session is working on (the task
// frame), the plan it belongs to and the step it is on, and anything handed
// off to another agent recently — "theirs now, not yours". On a content-free
// prompt ("continue") it also says, in one line, that the prompt means THIS
// task. Pure reads. Returns "" when there is nothing to say, so a brain with no
// frame and no handoffs adds no overhead.

import { getDb } from "./db.js";
import { getTaskFrame, latestTaskFrame, isLowInformationPrompt, currentTaskEnabled, type TaskFrame } from "./task-frame.js";
import { getPlan } from "./plans.js";
import { currentGoalRow } from "./goals.js";
import { ago, DAY } from "./continuity-util.js";
import type { BrainConfig } from "./types.js";

export interface Handoff { kind: "plan" | "goal"; id: string; title: string; to: string; note: string | null; at: number }

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

/** Plans and goals handed off since `sinceMs`, newest first. */
export function recentHandoffs(agentId: string, sinceMs: number, limit = 5): Handoff[] {
  const db = getDb(agentId);
  const out: Handoff[] = [];
  try {
    for (const r of db.prepare("SELECT node_id, title, handoff_to, handoff_note, handoff_at FROM plans WHERE status = 'handed_off' AND handoff_at >= ? ORDER BY handoff_at DESC LIMIT ?").all(sinceMs, limit) as Array<{ node_id: string; title: string; handoff_to: string | null; handoff_note: string | null; handoff_at: number | null }>)
      out.push({ kind: "plan", id: r.node_id, title: r.title, to: r.handoff_to ?? "?", note: r.handoff_note, at: r.handoff_at ?? 0 });
    for (const r of db.prepare(`SELECT lineage_id, title, handoff_to, handoff_note, handoff_at FROM goals g WHERE status = 'handed_off' AND handoff_at >= ?
                                AND version = (SELECT MAX(version) FROM goals x WHERE x.lineage_id = g.lineage_id) ORDER BY handoff_at DESC LIMIT ?`).all(sinceMs, limit) as Array<{ lineage_id: string; title: string; handoff_to: string | null; handoff_note: string | null; handoff_at: number | null }>)
      out.push({ kind: "goal", id: r.lineage_id, title: r.title, to: r.handoff_to ?? "?", note: r.handoff_note, at: r.handoff_at ?? 0 });
  } catch { /* pre-v28 */ }
  return out.sort((a, b) => b.at - a.at).slice(0, limit);
}

export interface NowContextOptions {
  /** The user's message this turn; a content-free one gets the "this means the current task" line. */
  prompt?: string;
  now?: number;
  /**
   * "session" (default): only this session's frame. "agent": fall back to the most recently
   * touched frame of any session — for heartbeat / cron runs, which have their own keys.
   */
  scope?: "session" | "agent";
  /** Days of handoffs to mention (default 7). */
  handoffDays?: number;
}

export function buildNowContext(agentId: string, sessionKey: string, config: Partial<BrainConfig>, opts: NowContextOptions = {}): string {
  if (!currentTaskEnabled(config)) return "";
  const now = opts.now ?? Date.now();
  let frame: TaskFrame | null = null;
  try {
    frame = sessionKey ? getTaskFrame(agentId, sessionKey, config, now) : null;
    if (!frame && opts.scope === "agent") frame = latestTaskFrame(agentId, config, now);
  } catch { frame = null; }
  const handoffs = recentHandoffs(agentId, now - (opts.handoffDays ?? 7) * DAY, 3);
  const prompt = (opts.prompt ?? "").trim();
  const lowInfo = !!prompt && isLowInformationPrompt(prompt);
  if (!frame && !handoffs.length) return "";

  const L: string[] = [];
  if (frame) {
    const by = frame.set_by === "owner" ? "your owner said so" : frame.set_by === "plan" ? "from the plan" : frame.set_by === "compaction" ? "restored after compaction" : "you set it";
    L.push(`Working on: ${oneLine(frame.title)} (${by}, ${ago(frame.updated_at, now)})${frame.note ? ` — ${oneLine(frame.note)}` : ""}`);
    if (frame.plan_id) {
      const p = getPlan(agentId, frame.plan_id);
      if (p && p.status === "active") {
        const open = p.steps.filter((s) => s.status !== "done" && s.status !== "skipped");
        const cur = p.steps.find((s) => s.status === "doing") ?? open[0];
        L.push(`Plan ${p.node_id.slice(0, 8)} "${oneLine(p.title)}": ${p.steps.length - open.length}/${p.steps.length} steps done${cur ? `; now: ${cur.idx}. ${oneLine(cur.text).slice(0, 120)}` : "; all steps done — brain_plan done closes it"}`);
      }
    } else if (frame.goal_id) {
      const g = currentGoalRow(agentId, frame.goal_id);
      if (g && g.status === "active") L.push(`Goal: ${oneLine(g.title)}`);
    }
  }
  for (const h of handoffs) L.push(`Handed off ${ago(h.at, now)}: ${h.kind} "${oneLine(h.title).slice(0, 90)}" → ${h.to}${h.note ? ` (${oneLine(h.note).slice(0, 100)})` : ""} — theirs now, not yours.`);
  if (lowInfo) {
    L.push(frame
      ? `"${prompt.slice(0, 40)}" means the task above — not an older plan, goal or handed-off project.`
      : "This turn carries no topic of its own: carry on with what this conversation was doing, not an older plan or goal.");
  }
  return `[BRAIN: now]\n${L.join("\n")}`;
}

/**
 * The last few turns of THIS session (episodes keyed by this session), oldest
 * first — what "continue" refers to. Compaction markers and other tool turns
 * are left out. Returns "" when the session has no turns yet.
 */
export function buildSessionRecentContext(agentId: string, sessionKey: string, limit = 4, now = Date.now()): string {
  if (!sessionKey) return "";
  const db = getDb(agentId);
  const rows = db.prepare("SELECT role, content, created_at FROM episodes WHERE session_id = ? AND role IN ('user', 'assistant') ORDER BY created_at DESC LIMIT ?")
    .all(sessionKey, Math.max(1, Math.min(10, limit))) as Array<{ role: string; content: string; created_at: number }>;
  if (!rows.length) return "";
  const lines = rows.reverse().map((e) => `${e.role === "user" ? "them" : "you"} (${ago(e.created_at, now)}): ${oneLine(e.content).slice(0, 220)}`);
  return `[BRAIN: this session, last turns]\n${lines.join("\n")}`;
}
