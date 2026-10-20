// packages/core/src/task-signals.ts — task state from the owner's own words (Xanima 0.7).
//
// The failure this exists for: the owner says "hand the Gano bot off to Mia,
// let's work on the billing migration", the agent never calls a tool, the
// brain still says the Gano bot is an active goal, and a later "continue"
// (after the host compacted the conversation away) pulls the Gano bot back.
//
// detectTaskSignals() is a pure, conservative phrase parser:
//   • focus   — "let's work on X" / "switching to X" / "we're working on X"
//   • handoff — "hand X (off) to Y" / "Y will take over X" / "X was handed to Y"
// applyTaskSignals() turns them into state, but only where they land on
// something real: a handoff marks a plan or goal whose title clearly matches X;
// a focus pins the matching active plan / goal, or the phrase itself as the
// session's current task. Everything it does is reversible (resume / brain_now).
// The host applies it on the owner's turns and on compaction summaries, never
// on tool output or another agent's messages.

import { getDb } from "./db.js";
import { tokenSet } from "./decisions.js";
import { getPlan, updatePlan, type PlanRow } from "./plans.js";
import { updateGoal, type GoalRow } from "./goals.js";
import { setTaskFrame, getTaskFrame, currentTaskEnabled } from "./task-frame.js";
import type { BrainConfig } from "./types.js";

export interface TaskSignals {
  /** What the owner said we are working on now (the phrase, cleaned). */
  focus: string | null;
  /** Things handed to someone else: the phrase and the receiver. */
  handoffs: Array<{ what: string; to: string; sentence: string }>;
}

const NAME = "([A-Za-z][\\w.-]{1,40})";
/** The thing being worked on / handed off: stops at a colon, semicolon or dash so a trailing clause is not swallowed. */
const THING = "([^:;—\\n]{3,90}?)";
/** Leading filler / subordinate phrases a focus sentence may start with ("ok, so now we're working on …"). */
const LEAD = "^(?:(?:ok(?:ay)?|so|right|alright|now|since then|then|and|meanwhile|after that|at the moment|currently|right now|today|next|first|also|anyway|otherwise|well|yes|yeah)[,:]?\\s+)*";
const TAIL = "(?:\\s+(?:now|next|instead|first|today|again|for now|from here|from now on|please|right now|at the moment))*(?:\\s*[:;—].*)?$";
const PRONOUNS = new Set(["me", "you", "us", "them", "him", "her", "it", "someone", "somebody", "anyone", "anybody", "nobody", "myself", "yourself", "each", "everyone", "everybody", "the", "a", "an", "that", "this", "these", "those", "here", "there"]);
const VAGUE = new Set(["it", "that", "this", "them", "those", "these", "something", "anything", "everything", "stuff", "things", "the rest", "the same", "what we were doing", "where we left off", "where we were"]);

const FOCUS_RES: RegExp[] = [
  // let's work on X / let's focus on X / let's switch to X / let's get back to X / let's do X now
  new RegExp(`${LEAD}(?:let'?s|lets|we(?:'ll| will| should| are going to| are gonna| need to| can)?|i want (?:us|you) to|i'd like (?:us|you) to|can you|could you|please|you should|go ahead and)\\s+(?:now\\s+|just\\s+|all\\s+)?(?:work on|focus on|switch(?:ing)?(?: over)? to|move(?: on)? to|get back to|go back to|start(?:ing)?(?: on| with)?|pick(?:ing)? up|continue (?:with|on)|turn to|concentrate on|dig into|tackle|do|build|finish)\\s+(?:the\\s+|our\\s+|my\\s+|on\\s+)?${THING}${TAIL}`, "i"),
  // we're (now) working on X / we are on X now / what we're doing now is X / the current task is X
  new RegExp(`${LEAD}(?:we(?:'re| are)(?: now| currently| still)? (?:working on|doing|on|building|focused on|back on)|what we'?re (?:doing|working on)(?: now| right now)? is|(?:the )?current (?:task|project|focus) is|(?:right )?now (?:we'?re|we are) (?:working on|doing|on))\\s+(?:the\\s+|our\\s+)?${THING}${TAIL}`, "i"),
  // switching to X / back to X / on to X (bare)
  new RegExp(`${LEAD}(?:switch(?:ing)?(?: over)? to|back to|on to|next up:?|next:)\\s+(?:the\\s+)?${THING}${TAIL}`, "i"),
];

const HANDOFF_RES: Array<{ re: RegExp; what: number; to: number }> = [
  // hand X (off|over) to Y / pass X to Y / give X to Y / delegate X to Y / assign X to Y / transfer X to Y
  { re: new RegExp(`\\b(?:hand(?:ed|ing|s)?(?: off| over)?|pass(?:ed|ing)?(?: off| over| on)?|giv(?:e|en|ing)|gave|delegat(?:e|ed|ing)|transfer(?:red|ring)?|assign(?:ed|ing)?|reassign(?:ed|ing)?|offload(?:ed|ing)?|hand(?:ed|ing)? the)\\s+(?:the\\s+|our\\s+|my\\s+|that\\s+|this\\s+)?${THING}\\s+(?:off\\s+|over\\s+|on\\s+)?(?:to|over to|onto)\\s+${NAME}\\b`, "i"), what: 1, to: 2 },
  // X (is|was|has been|got) (handed|passed|given|delegated|transferred|assigned) (off|over) to Y
  { re: new RegExp(`\\b${THING}\\s+(?:is|was|has been|got|will be|is being|is now)\\s+(?:handed|passed|given|delegated|transferred|assigned|reassigned)(?:\\s+(?:off|over|on))?\\s+to\\s+${NAME}\\b`, "i"), what: 1, to: 2 },
  // Y (will|is going to|can|should|'ll) (take over|take|handle|own|pick up|run with|finish|do) X (from here)
  { re: new RegExp(`\\b${NAME}\\s+(?:will|is going to|is gonna|'ll|can|should|is to|has agreed to|agreed to)\\s+(?:now\\s+)?(?:take(?: over| on| care of)?|handle|own|pick up|run with|finish|do|carry on with|continue|look after|drive|lead)\\s+(?:the\\s+|our\\s+|my\\s+|that\\s+|this\\s+)?${THING}(?:\\s+(?:from here|from now on|now|instead|going forward|for us|for me))*[.!,;]?$`, "i"), what: 2, to: 1 },
  // let Y (take over|handle|do|finish|own) X / have Y take X / Y is taking over X / Y takes over X / Y has X now / Y owns X now
  { re: new RegExp(`\\b(?:let|have|ask|get)\\s+${NAME}\\s+(?:take(?: over| on)?|handle|do|finish|own|run|drive)\\s+(?:the\\s+|our\\s+|my\\s+|that\\s+|this\\s+)?${THING}[.!,;]?$`, "i"), what: 2, to: 1 },
  { re: new RegExp(`\\b${NAME}\\s+(?:is taking(?: over)?|takes(?: over)?|is now (?:on|handling|running|doing)|now (?:has|owns|handles|runs)|has taken(?: over)?|took(?: over)?|owns|is handling|is doing)\\s+(?:the\\s+|our\\s+|my\\s+|that\\s+|this\\s+)?${THING}(?:\\s+(?:now|from here|from now on|going forward))*[.!,;]?$`, "i"), what: 2, to: 1 },
];

const TRAIL_RE = /\s*(?:[.!?,;:]+|\b(?:now|please|instead|for now|from here|from now on|today|again|first|next)\b)+\s*$/i;
const LEAD_RE = /^(?:the|our|my|that|this|a|an|on|with)\s+/i;
/** "the user said the Gano bot" → "the Gano bot": keep what follows the last reporting / relative clause. */
const CLAUSE_RE = /\b(?:said|says|mentioned|told (?:me|us|you)|explained|noted|decided|agreed|confirmed|that|because|since|so that|where|when)\b/gi;
function cleanThing(s: string): string {
  let t = s.replace(/[“”"'`]/g, "").replace(/\s+/g, " ").trim();
  const parts = t.split(CLAUSE_RE).map((x) => x.trim()).filter(Boolean);
  if (parts.length > 1 && parts[parts.length - 1]!.length >= 3) t = parts[parts.length - 1]!;
  for (let i = 0; i < 3; i++) t = t.replace(TRAIL_RE, "").replace(LEAD_RE, "").trim();
  return t.slice(0, 90);
}
function cleanName(s: string): string | null {
  const n = s.replace(/[“”"'`.,;:!?]/g, "").trim();
  if (!n || PRONOUNS.has(n.toLowerCase())) return null;
  return n.slice(0, 40);
}
function vague(t: string): boolean {
  const l = t.toLowerCase();
  return !t || VAGUE.has(l) || tokenSet(t).size === 0 || l.length < 3;
}

function sentencesOf(text: string): string[] {
  return text.replace(/```[\s\S]*?```/g, " ").replace(/`([^`]*)`/g, "$1")
    .split(/(?<=[.!?])\s+|\n+|;\s+|\s+(?:and then|then|,\s*and)\s+(?=let'?s|we|now|switch|back)|,\s+(?=let'?s\b|lets\b|now\b|switching\b|back to\b|we(?:'re| are)\b|next\b)/i)
    .map((s) => s.replace(/^[\s\-•*>]+/, "").trim()).filter((s) => s.length >= 4 && s.length <= 400);
}

/** Pure: what the text says about the current task and about handoffs. Conservative by design. */
export function detectTaskSignals(text: string): TaskSignals {
  const out: TaskSignals = { focus: null, handoffs: [] };
  if (!text || text.length > 6000) return out;
  for (const sentence of sentencesOf(text)) {
    const s = sentence.replace(/\s+/g, " ");
    for (const h of HANDOFF_RES) {
      const m = h.re.exec(s);
      if (!m) continue;
      const what = cleanThing(m[h.what] ?? "");
      const to = cleanName(m[h.to] ?? "");
      if (!to || vague(what)) continue;
      if (what.toLowerCase().includes(to.toLowerCase()) && tokenSet(what).size <= 1) continue;
      if (!out.handoffs.some((x) => x.what.toLowerCase() === what.toLowerCase() && x.to.toLowerCase() === to.toLowerCase())) out.handoffs.push({ what, to, sentence: s.slice(0, 160) });
      break;
    }
    if (out.focus) continue;
    const cand = s.replace(/[.!?]+$/, "").trim();
    for (const re of FOCUS_RES) {
      const m = re.exec(cand);
      if (!m) continue;
      const f = cleanThing(m[1] ?? "");
      if (vague(f) || /^(?:hand|pass|give|delegate)\b/i.test(f)) continue;
      // "let's work on it after you hand X to Y" — the focus phrase must not be the handed-off thing
      if (out.handoffs.some((h) => h.what.toLowerCase() === f.toLowerCase())) continue;
      out.focus = f;
      break;
    }
  }
  return out;
}

// ─── applying signals to state ──────────────────────────────────────────────

/**
 * 0..1: shared content words over the shorter side (phrase vs title), so neither a wordy phrase
 * nor a wordy title hides a clear match; 0 when nothing meaningful overlaps.
 */
function coverage(phrase: string, title: string, keywordsJson?: string | null): { score: number; hits: number } {
  const a = tokenSet(phrase);
  if (!a.size) return { score: 0, hits: 0 };
  const b = tokenSet(title);
  const titleSize = Math.max(1, b.size);
  try { for (const k of JSON.parse(keywordsJson ?? "[]") as string[]) b.add(String(k).toLowerCase()); } catch { /* ignore */ }
  const stem = (w: string) => w.replace(/(?:ies)$/, "y").replace(/(?:ing|ed|es|s)$/, "");
  const bs = new Set([...b].map(stem));
  let hits = 0;
  for (const w of a) if (b.has(w) || bs.has(stem(w))) hits++;
  return { score: hits / Math.min(a.size, titleSize), hits };
}
const MATCH = (c: { score: number; hits: number }, phraseTokens: number) => c.hits >= 2 ? c.score >= 0.5 : phraseTokens === 1 && c.hits === 1;

function matchPlans(agentId: string, phrase: string, statuses: string[]): PlanRow[] {
  const db = getDb(agentId);
  const n = tokenSet(phrase).size;
  const rows = db.prepare(`SELECT * FROM plans WHERE status IN (${statuses.map(() => "?").join(",")}) ORDER BY updated_at DESC LIMIT 200`).all(...statuses) as PlanRow[];
  return rows.map((r) => ({ r, c: coverage(phrase, r.title, r.keywords_json) })).filter((x) => MATCH(x.c, n)).sort((a, b) => b.c.score - a.c.score || b.c.hits - a.c.hits).map((x) => x.r);
}
function matchGoals(agentId: string, phrase: string, statuses: string[]): GoalRow[] {
  const db = getDb(agentId);
  const n = tokenSet(phrase).size;
  const rows = db.prepare(`SELECT g.* FROM goals g WHERE g.status IN (${statuses.map(() => "?").join(",")}) AND g.version = (SELECT MAX(version) FROM goals x WHERE x.lineage_id = g.lineage_id) ORDER BY g.updated_at DESC LIMIT 200`).all(...statuses) as GoalRow[];
  return rows.map((r) => ({ r, c: coverage(phrase, r.title, r.keywords_json) })).filter((x) => MATCH(x.c, n)).sort((a, b) => b.c.score - a.c.score || b.c.hits - a.c.hits).map((x) => x.r);
}

export interface AppliedTaskSignals {
  focus: { title: string; planId: string | null; goalId: string | null } | null;
  handoffs: Array<{ kind: "plan" | "goal"; id: string; title: string; to: string }>;
  /** Handoff phrases that matched nothing — recorded nowhere, reported for the log. */
  unmatched: Array<{ what: string; to: string }>;
}

export interface ApplyTaskSignalsOptions {
  config?: Partial<BrainConfig>;
  /** "owner": the owner's own turn. "compaction": a host summary — a focus is set only when the session has none. */
  origin?: "owner" | "compaction";
  now?: number;
  writerAgentId?: string;
}

/**
 * Detect and apply. Handoffs mark every clearly matching active / parked plan and active / paused
 * goal as handed off (note: the owner's sentence). A focus pins the best matching active plan,
 * else the best matching active goal, else the phrase itself, as this session's current task.
 */
export function applyTaskSignals(agentId: string, sessionKey: string, text: string, opts: ApplyTaskSignalsOptions = {}): AppliedTaskSignals {
  const res: AppliedTaskSignals = { focus: null, handoffs: [], unmatched: [] };
  const cfg = opts.config;
  if (cfg?.handoffDetection === false) return res;
  const now = opts.now ?? Date.now();
  const sig = detectTaskSignals(text);
  if (!sig.focus && !sig.handoffs.length) return res;

  for (const h of sig.handoffs) {
    const note = `${opts.origin === "compaction" ? "from a compaction summary" : "owner said"}: "${h.sentence.slice(0, 120)}"`;
    let any = false;
    for (const p of matchPlans(agentId, h.what, ["active", "parked"])) {
      const r = updatePlan(agentId, p.node_id, { action: "handoff", to: h.to, note, now, config: cfg });
      if (r.ok) { res.handoffs.push({ kind: "plan", id: p.node_id, title: p.title, to: h.to }); any = true; }
    }
    for (const g of matchGoals(agentId, h.what, ["active", "paused"])) {
      const r = updateGoal(agentId, g.lineage_id, { action: "handoff", to: h.to, note, reason: note, now, writerAgentId: opts.writerAgentId });
      if (r.ok) { res.handoffs.push({ kind: "goal", id: g.lineage_id, title: g.title, to: h.to }); any = true; }
    }
    if (!any) res.unmatched.push({ what: h.what, to: h.to });
  }

  if (sig.focus && currentTaskEnabled(cfg)) {
    const existing = getTaskFrame(agentId, sessionKey, cfg, now);
    if (!(opts.origin === "compaction" && existing)) {
      const plan = matchPlans(agentId, sig.focus, ["active"])[0] ?? null;
      const goal = plan ? null : matchGoals(agentId, sig.focus, ["active"])[0] ?? null;
      const setBy = opts.origin === "compaction" ? "compaction" : "owner";
      if (plan) {
        const p = getPlan(agentId, plan.node_id);
        const next = p?.steps.find((s) => s.status === "doing") ?? p?.steps.find((s) => s.status === "todo" || s.status === "blocked");
        setTaskFrame(agentId, sessionKey, { title: plan.title, planId: plan.node_id, goalId: plan.goal_id, note: next ? `next: ${next.idx}. ${next.text}` : null, setBy }, now);
        res.focus = { title: plan.title, planId: plan.node_id, goalId: plan.goal_id };
      } else if (goal) {
        setTaskFrame(agentId, sessionKey, { title: goal.title, goalId: goal.lineage_id, setBy }, now);
        res.focus = { title: goal.title, planId: null, goalId: goal.lineage_id };
      } else {
        setTaskFrame(agentId, sessionKey, { title: sig.focus, setBy }, now);
        res.focus = { title: sig.focus, planId: null, goalId: null };
      }
    }
  }
  return res;
}
