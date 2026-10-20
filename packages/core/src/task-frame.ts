// packages/core/src/task-frame.ts — the current-task anchor (Xanima 0.7).
//
// A task frame is the one thing a session is working on right now: a title,
// optionally the plan / goal it belongs to, and a note. It is set explicitly
// (brain_now), automatically when a plan is created, stepped to `doing` or
// resumed, from the owner's own words ("let's work on X" — task-signals.ts),
// or from a compaction summary. It lives in the brain (table task_frames,
// schema v28), one row per session key, so it survives host compaction and is
// injected every turn as "[BRAIN: now]" (now-context.ts).
//
// Why: stored state (goals, drift nudges, parked plans) is re-injected every
// turn and outranks a conversation the model can no longer see. Without an
// anchor, a content-free prompt such as "continue" becomes a search for things
// to continue — and an older, unfinished project wins. The frame is the
// counterweight: it says what "continue" means.
//
// This module has no dependency on plans.ts / goals.ts (they call into it), so
// it stays import-cycle free. Anything that needs plan or goal details lives in
// now-context.ts.

import type Database from "better-sqlite3";
import { getDb, bumpWriteCounter } from "./db.js";
import type { BrainConfig } from "./types.js";

export type TaskFrameSetBy = "owner" | "agent" | "plan" | "compaction";

export interface TaskFrame {
  session_key: string;
  title: string;
  plan_id: string | null;
  goal_id: string | null;
  note: string | null;
  set_by: TaskFrameSetBy;
  created_at: number;
  updated_at: number;
}

export interface TaskFrameInput {
  title: string;
  planId?: string | null;
  goalId?: string | null;
  note?: string | null;
  setBy?: TaskFrameSetBy;
}

const HOUR = 3_600_000;
const TITLE_MAX = 200;
const NOTE_MAX = 400;
const clean = (s: unknown, max: number): string => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");

export function taskFramesEnabled(db: Database.Database): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'task_frames'").get();
}

/** Hours a frame stays current without being touched. */
export function taskFrameTtlMs(config: Partial<BrainConfig> | undefined): number {
  const h = config?.taskFrameTtlHours;
  return Math.max(1, typeof h === "number" && Number.isFinite(h) ? h : 48) * HOUR;
}

export function currentTaskEnabled(config: Partial<BrainConfig> | undefined): boolean {
  return config?.currentTask !== false;
}

/** The session key every frame falls back to when the caller has none (one-process MCP servers). */
export const DEFAULT_SESSION_KEY = "default";

export function setTaskFrame(agentId: string, sessionKey: string, input: TaskFrameInput, now = Date.now()): TaskFrame | null {
  const db = getDb(agentId);
  if (!taskFramesEnabled(db)) return null;
  const key = sessionKey.trim() || DEFAULT_SESSION_KEY;
  const title = clean(input.title, TITLE_MAX);
  if (title.length < 2) return null;
  const prev = db.prepare("SELECT created_at FROM task_frames WHERE session_key = ?").get(key) as { created_at: number } | undefined;
  db.prepare(`INSERT INTO task_frames (session_key, title, plan_id, goal_id, note, set_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(session_key) DO UPDATE SET title = excluded.title, plan_id = excluded.plan_id, goal_id = excluded.goal_id, note = excluded.note, set_by = excluded.set_by, updated_at = excluded.updated_at`)
    .run(key, title, input.planId ?? null, input.goalId ?? null, clean(input.note, NOTE_MAX) || null, input.setBy ?? "agent", prev?.created_at ?? now, now);
  bumpWriteCounter(db);
  return getTaskFrameRaw(db, key);
}

/** Refresh updated_at (the frame is still current) without changing it. */
export function touchTaskFrame(agentId: string, sessionKey: string, now = Date.now()): void {
  const db = getDb(agentId);
  if (!taskFramesEnabled(db)) return;
  db.prepare("UPDATE task_frames SET updated_at = ? WHERE session_key = ?").run(now, sessionKey.trim() || DEFAULT_SESSION_KEY);
}

export function clearTaskFrame(agentId: string, sessionKey: string): boolean {
  const db = getDb(agentId);
  if (!taskFramesEnabled(db)) return false;
  const r = db.prepare("DELETE FROM task_frames WHERE session_key = ?").run(sessionKey.trim() || DEFAULT_SESSION_KEY);
  if (r.changes) bumpWriteCounter(db);
  return r.changes > 0;
}

/** Drop every frame that points at a plan (it finished, was parked, abandoned or handed off). */
export function clearFramesForPlan(agentId: string, planId: string): number {
  const db = getDb(agentId);
  if (!taskFramesEnabled(db)) return 0;
  return db.prepare("DELETE FROM task_frames WHERE plan_id = ?").run(planId).changes;
}

/** Drop every frame that points at a goal lineage (done, archived or handed off). */
export function clearFramesForGoal(agentId: string, goalLineage: string): number {
  const db = getDb(agentId);
  if (!taskFramesEnabled(db)) return 0;
  return db.prepare("DELETE FROM task_frames WHERE goal_id = ?").run(goalLineage).changes;
}

function getTaskFrameRaw(db: Database.Database, key: string): TaskFrame | null {
  return (db.prepare("SELECT * FROM task_frames WHERE session_key = ?").get(key) as TaskFrame | undefined) ?? null;
}

/** This session's frame, or null when there is none or it has gone stale (taskFrameTtlHours). */
export function getTaskFrame(agentId: string, sessionKey: string, config?: Partial<BrainConfig>, now = Date.now()): TaskFrame | null {
  const db = getDb(agentId);
  if (!taskFramesEnabled(db)) return null;
  const f = getTaskFrameRaw(db, sessionKey.trim() || DEFAULT_SESSION_KEY);
  if (!f) return null;
  return now - f.updated_at > taskFrameTtlMs(config) ? null : f;
}

/**
 * The most recently touched live frame across sessions — what the agent is
 * working on "overall". Heartbeat and cron runs (which have their own session
 * keys) use it so they do not go looking for unfinished work elsewhere.
 */
export function latestTaskFrame(agentId: string, config?: Partial<BrainConfig>, now = Date.now()): TaskFrame | null {
  const db = getDb(agentId);
  if (!taskFramesEnabled(db)) return null;
  const f = db.prepare("SELECT * FROM task_frames ORDER BY updated_at DESC LIMIT 1").get() as TaskFrame | undefined;
  if (!f) return null;
  return now - f.updated_at > taskFrameTtlMs(config) ? null : f;
}

export function listTaskFrames(agentId: string, config?: Partial<BrainConfig>, now = Date.now()): TaskFrame[] {
  const db = getDb(agentId);
  if (!taskFramesEnabled(db)) return [];
  const ttl = taskFrameTtlMs(config);
  return (db.prepare("SELECT * FROM task_frames ORDER BY updated_at DESC LIMIT 50").all() as TaskFrame[]).filter((f) => now - f.updated_at <= ttl);
}

/** Sweep frames older than the TTL (called from sleep; harmless to skip). */
export function expireTaskFrames(agentId: string, config?: Partial<BrainConfig>, now = Date.now()): number {
  const db = getDb(agentId);
  if (!taskFramesEnabled(db)) return 0;
  return db.prepare("DELETE FROM task_frames WHERE updated_at < ?").run(now - taskFrameTtlMs(config)).changes;
}

// ─── low-information prompts ────────────────────────────────────────────────
//
// "continue", "go on", "next", "ok do it": the turn is about whatever was
// already going on, not about the words themselves. Topic recall on such a
// prompt is a search for memories that mention continuing — which is exactly
// what an abandoned project leaves behind. Callers skip recall and inject the
// task frame plus this session's last turns instead (context-assembly.ts).

const LOW_INFO_PHRASES = new Set([
  "continue", "go on", "keep going", "carry on", "proceed", "next", "go ahead", "do it", "ok", "okay", "k", "kk",
  "yes", "yep", "yeah", "yup", "sure", "fine", "right", "alright", "please", "please continue", "continue please",
  "keep at it", "keep working", "resume", "pick up where you left off", "where were we", "and then", "and", "more",
  "go", "run it", "try again", "again", "same", "ditto", "thanks", "thank you", "ty", "got it", "sounds good", "cool",
  "nice", "great", "perfect", "good", "ok go", "ok continue", "okay continue", "ok next", "next step", "next one",
  "finish it", "finish", "wrap it up", "keep going please", "continue with that", "continue that", "do that",
  "let's continue", "lets continue", "let's go", "lets go", "let's keep going", "lets keep going", "onwards", "onward",
]);
const LOW_INFO_FILLER = new Set(["please", "pls", "plz", "now", "then", "just", "ok", "okay", "so", "yeah", "yes", "well", "alright", "right", "and", "also", "go", "ahead", "on", "with", "it", "that", "this", "the", "a", "to", "up", "let's", "lets", "us", "me", "you", "can", "could", "would", "do", "keep", "going"]);

/**
 * True for a prompt that carries no topic of its own: a short acknowledgement
 * or a bare instruction to carry on. Never true for anything that names a
 * thing (more than two non-filler words, a number, a path, a URL, a question).
 */
export function isLowInformationPrompt(text: string): boolean {
  const t = (text ?? "").toLowerCase().replace(/[‘’]/g, "'").replace(/[^a-z0-9'\s]/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return true;
  if (t.length > 60) return false;
  if (/\?/.test(text) || /[/\\.:@#]\S/.test(text) || /\d/.test(text)) return false;
  if (LOW_INFO_PHRASES.has(t)) return true;
  const words = t.split(" ");
  if (words.length > 6) return false;
  const content = words.filter((w) => !LOW_INFO_FILLER.has(w) && !LOW_INFO_PHRASES.has(w));
  if (content.length === 0) return true;
  // "continue the migration" names a topic; "continue please" does not.
  return content.length === 1 && /^(continue|continuing|proceed|resume|next|finish|go|again|onwards?)$/.test(content[0]!);
}
