/**
 * Xanima 0.7 (schema v28): the current-task anchor and handoffs.
 *
 * The failure these guard against: an owner hands a project to another agent in
 * conversation, keeps working on something else, says "continue" — and the agent
 * jumps back to the old project because the brain still lists it as an active
 * goal, drift nudges push it, and recall on "continue" surfaces its leftovers.
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb, closeDb, SCHEMA_VERSION, migrateV28 } from "../src/db.js";
import { writeNode, getNode, getActiveGoals } from "../src/nodes.js";
import { appendEpisode } from "../src/episodes.js";
import { dispatchBrainTool, BRAIN_TOOL_DEFS, MCP_TOOL_NAMES } from "../src/tools.js";
import { computeBrainStatus, formatBrainStatus } from "../src/beliefs.js";
import { setGoal, updateGoal, listGoals, formatGoal, runDriftPass, buildGoalTurnContext, currentGoalRow } from "../src/goals.js";
import { createPlan, updatePlan, getPlan, listPlans, formatPlan, commitmentCounts, createCommitment } from "../src/plans.js";
import { writeEdge } from "../src/edges.js";
import { briefing } from "../src/meta-tools.js";
import { resetBrain } from "../src/reset.js";
import { handleCompaction } from "../src/compaction.js";
import { buildRecallContext } from "../src/context-assembly.js";
import {
  setTaskFrame, getTaskFrame, clearTaskFrame, latestTaskFrame, listTaskFrames, expireTaskFrames, isLowInformationPrompt, touchTaskFrame,
} from "../src/task-frame.js";
import { buildNowContext, buildSessionRecentContext, recentHandoffs } from "../src/now-context.js";
import { detectTaskSignals, applyTaskSignals } from "../src/task-signals.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const log = { info: () => {}, warn: () => {}, error: () => {} };
const DAY = 86_400_000;
const HOUR = 3_600_000;
const opened: string[] = [];
function fresh(prefix = "tf"): string { const id = `${prefix}-${randomUUID().slice(0, 8)}`; opened.push(id); return id; }
afterEach(() => { for (const id of opened.splice(0)) closeDb(id); });
const cfg = { ...DEFAULT_CONFIG };
const S = "agent:rid:main";

describe("schema v28", () => {
  it("is current, additive and idempotent: task_frames + handoff columns on plans and goals", () => {
    const a = fresh();
    const db = getDb(a);
    expect(SCHEMA_VERSION).toBe(28);
    expect((db.prepare("SELECT version FROM schema_version").get() as { version: number }).version).toBe(28);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'task_frames'").get()).toBeTruthy();
    for (const t of ["plans", "goals"]) for (const c of ["handoff_to", "handoff_note", "handoff_at"]) {
      expect((db.prepare(`SELECT COUNT(*) n FROM pragma_table_info('${t}') WHERE name = ?`).get(c) as { n: number }).n, `${t}.${c}`).toBe(1);
    }
    migrateV28(db); // re-run: no throw, nothing duplicated
    expect(DEFAULT_CONFIG.currentTask).toBe(true);
    expect(DEFAULT_CONFIG.handoffDetection).toBe(true);
    expect(DEFAULT_CONFIG.taskFrameTtlHours).toBe(48);
    expect(BRAIN_TOOL_DEFS["brain_now"]).toBeTruthy();
    expect(MCP_TOOL_NAMES).toContain("brain_now");
  });
});

describe("low-information prompts", () => {
  it("recognises bare acknowledgements / carry-on instructions and nothing that names a topic", () => {
    for (const p of ["continue", "Continue.", "go on", "keep going please", "ok continue", "okay, continue", "yes", "next", "ok", "do it", "please continue", "let's keep going", "carry on!", "", "   ", "thanks", "and then?".replace("?", ""), "proceed", "resume"]) {
      expect(isLowInformationPrompt(p), JSON.stringify(p)).toBe(true);
    }
    for (const p of ["continue the migration", "continue with the Gano bot", "what's for lunch?", "deploy v2", "hello", "hi", "x", "tell me about the billing migration", "go on, what did the test say", "next: wire the webhook", "ok let's fix the login bug", "run the tests", "continue where we left off with billing"]) {
      expect(isLowInformationPrompt(p), JSON.stringify(p)).toBe(false);
    }
  });
});

describe("task frames", () => {
  it("set / get / touch / clear, per session, with a TTL; latest across sessions; expiry sweep", () => {
    const a = fresh();
    const now = Date.now();
    expect(getTaskFrame(a, S, cfg, now)).toBeNull();
    const f = setTaskFrame(a, S, { title: "Billing migration", note: "next: cut over invoices", setBy: "owner" }, now)!;
    expect(f).toMatchObject({ session_key: S, title: "Billing migration", set_by: "owner", plan_id: null, goal_id: null });
    expect(getTaskFrame(a, S, cfg, now + HOUR)!.title).toBe("Billing migration");
    expect(getTaskFrame(a, "agent:rid:other", cfg, now)).toBeNull(); // per session
    expect(getTaskFrame(a, S, cfg, now + 49 * HOUR)).toBeNull(); // stale after taskFrameTtlHours
    expect(getTaskFrame(a, S, { ...cfg, taskFrameTtlHours: 72 }, now + 49 * HOUR)!.title).toBe("Billing migration");
    touchTaskFrame(a, S, now + 40 * HOUR);
    expect(getTaskFrame(a, S, cfg, now + 49 * HOUR)!.title).toBe("Billing migration");
    setTaskFrame(a, "agent:rid:telegram", { title: "Answer the group chat" }, now + 41 * HOUR);
    expect(latestTaskFrame(a, cfg, now + 42 * HOUR)!.title).toBe("Answer the group chat");
    expect(listTaskFrames(a, cfg, now + 42 * HOUR).map((x) => x.title)).toEqual(["Answer the group chat", "Billing migration"]);
    expect(expireTaskFrames(a, cfg, now + 100 * HOUR)).toBe(2);
    expect(latestTaskFrame(a, cfg, now + 100 * HOUR)).toBeNull();
    setTaskFrame(a, S, { title: "x" }, now); // too short
    expect(getTaskFrame(a, S, cfg, now)).toBeNull();
    expect(clearTaskFrame(a, S)).toBe(false);
    setTaskFrame(a, S, { title: "Real task" }, now);
    expect(clearTaskFrame(a, S)).toBe(true);
    expect(getTaskFrame(a, S, cfg, now)).toBeNull();
  });

  it("brain_plan create / step / resume pin the plan as the session's task; done / park / abandon / handoff un-pin it", async () => {
    const a = fresh();
    const now = Date.now();
    const r = await dispatchBrainTool("brain_plan", a, { action: "create", title: "Billing migration", steps: ["export invoices", "cut over", "verify totals"] }, cfg, "mcp", { sessionKey: S });
    expect(r.text).toMatch(/^Plan created and pinned as this session's current task/);
    const planId = /^([0-9a-f-]{36}) Plan/m.exec(r.text)![1]!;
    let f = getTaskFrame(a, S, cfg, now)!;
    expect(f).toMatchObject({ title: "Billing migration", plan_id: planId, set_by: "plan", note: "next: 1. export invoices" });
    await dispatchBrainTool("brain_plan", a, { action: "step", plan_id: planId, step: 1, status: "done" }, cfg, "mcp", { sessionKey: S });
    await dispatchBrainTool("brain_plan", a, { action: "step", plan_id: planId, step: 2, status: "doing" }, cfg, "mcp", { sessionKey: S });
    f = getTaskFrame(a, S, cfg, now)!;
    expect(f.note).toBe("next: 2. cut over");
    // another session stepping the same plan gets its own frame
    await dispatchBrainTool("brain_plan", a, { action: "step", plan_id: planId, step: 2, note: "running" }, cfg, "mcp", { sessionKey: "agent:rid:cron:1" });
    expect(listTaskFrames(a, cfg, now)).toHaveLength(2);
    await dispatchBrainTool("brain_plan", a, { action: "park", plan_id: planId, note: "waiting on finance" }, cfg, "mcp", { sessionKey: S });
    expect(listTaskFrames(a, cfg, now)).toHaveLength(0); // un-pinned everywhere
    const res = await dispatchBrainTool("brain_plan", a, { action: "resume", plan_id: planId }, cfg, "mcp", { sessionKey: S });
    expect(res.text).toMatch(/^Plan resumed \(parked .*\) — it is this session's current task again\./);
    expect(getTaskFrame(a, S, cfg, now)!.plan_id).toBe(planId);
    await dispatchBrainTool("brain_plan", a, { action: "done", plan_id: planId }, cfg, "mcp", { sessionKey: S });
    expect(getTaskFrame(a, S, cfg, now)).toBeNull();
    // currentTask: false → plans never pin
    const p2 = createPlan(a, { title: "Quiet plan", steps: ["a", "b"], sessionKey: S, config: { ...cfg, currentTask: false } }).plan!;
    expect(getTaskFrame(a, S, cfg, now)).toBeNull();
    expect(p2.status).toBe("active");
  });

  it("brain_now set / get / clear is per conversation; set from a plan_id; refuses a handed-off plan", async () => {
    const a = fresh();
    const call = (args: Record<string, unknown>, sk = S) => dispatchBrainTool("brain_now", a, args, cfg, "mcp", { sessionKey: sk });
    expect((await call({ action: "get" })).text).toMatch(/^No current task set for this conversation/);
    expect((await call({ action: "set" })).isError).toBe(true);
    const r = await call({ action: "set", title: "Billing migration", note: "cutting over invoices" });
    expect(r.text).toMatch(/^Current task set: Billing migration\. A bare "continue" now means this\./);
    expect((await call({ action: "get" })).text).toMatch(/^Working on: Billing migration \(you set it, just now\) — cutting over invoices/);
    expect((await call({ action: "get" }, "agent:rid:other")).text).toMatch(/^No current task set for this conversation/);
    const p = createPlan(a, { title: "Gano Telegram bot rollout", steps: ["token", "webhook"] }).plan!;
    const r2 = await call({ action: "set", plan_id: p.node_id.slice(0, 8), note: "resuming" });
    expect(r2.text).toMatch(/^Current task set: Gano Telegram bot rollout \(plan [0-9a-f]{8}\)/);
    expect(getTaskFrame(a, S, cfg)!.plan_id).toBe(p.node_id);
    updatePlan(a, p.node_id, { action: "handoff", to: "mia", note: "she has the bot token" });
    expect((await call({ action: "set", plan_id: p.node_id })).text).toMatch(/is handed off to mia; brain_plan resume takes it back first/);
    expect((await call({ action: "get" })).text).toMatch(/^No current task set/); // the handoff un-pinned it
    expect((await call({ action: "get" })).text).toMatch(/Handed off just now: plan "Gano Telegram bot rollout" → mia \(she has the bot token\) — theirs now, not yours\./);
    const j = JSON.parse((await call({ action: "get", format: "json" })).text) as { frame: unknown; handoffs: unknown[] };
    expect(j.frame).toBeNull();
    expect(j.handoffs).toHaveLength(1);
    await call({ action: "set", title: "Something else" });
    expect((await call({ action: "clear" })).text).toBe("Current task cleared (was: Something else).");
    expect((await call({ action: "clear" })).text).toMatch(/^No current task was set/);
  });
});

describe("handoff as first-class state", () => {
  it("goals: handoff leaves the header, drift and listing-as-active; recall says whose it is; resume takes it back; editing while handed off is refused", () => {
    const a = fresh();
    const now = Date.now();
    const g = setGoal(a, { title: "Ship the Gano Telegram bot", priority: 1, successCriteria: "Gano answers messages", now: now - 10 * DAY }).goal!;
    const other = setGoal(a, { title: "Billing migration", priority: 2, now: now - 2 * DAY }).goal!;
    expect(getActiveGoals(a).map((n) => n.label)).toContain("Ship the Gano Telegram bot");
    expect(updateGoal(a, g.lineage_id, { action: "handoff", now }).error).toMatch(/handoff needs to:/);
    const r = updateGoal(a, g.lineage_id, { action: "handoff", to: "mia", note: "mia runs the bot now", now });
    expect(r.ok).toBe(true);
    expect(r.goal).toMatchObject({ status: "handed_off", handoff_to: "mia", handoff_note: "mia runs the bot now", handoff_at: now });
    expect(getActiveGoals(a).map((n) => n.label)).toEqual(["Billing migration"]);
    expect(listGoals(a).map((x) => x.title)).toEqual(["Billing migration"]); // default: active only
    expect(listGoals(a, { status: "handed_off" }).map((x) => x.title)).toEqual(["Ship the Gano Telegram bot"]);
    expect(listGoals(a, { status: "all" }).map((x) => x.status)).toEqual(["active", "handed_off"]);
    expect(formatGoal(currentGoalRow(a, g.lineage_id)!, now)).toMatch(/\[handed_off → mia\] Ship the Gano Telegram bot[\s\S]*handed to mia just now: mia runs the bot now — theirs now; brain_update_goal resume takes it back/);
    expect(getNode(a, g.node_id)!.content).toMatch(/\[Handed off to mia — mia runs the bot now: theirs now, not yours; brain_update_goal resume takes it back\]$/);
    // drift ignores it (10 days old, P1 — would have stalled)
    const d = runDriftPass(a, cfg, log, now);
    expect(d.checked).toBe(1);
    expect(d.drifting).toEqual([]);
    expect(updateGoal(a, g.lineage_id, { action: "update", title: "Ship the bot", now }).error).toMatch(/handed off to mia; brain_update_goal resume takes it back first/);
    expect(updateGoal(a, g.lineage_id, { action: "pause", now }).error).toMatch(/goal is handed_off/);
    const b = briefing(a, { goalId: g.lineage_id }, cfg, now);
    expect(b.text).toMatch(/This goal is handed off to mia \(mia runs the bot now\) — theirs now/);
    // status + brain_status
    const st = computeBrainStatus(getDb(a), cfg, now);
    expect(st.goals.handedOff).toBe(1);
    expect(st.handoffs).toEqual([{ kind: "goal", title: "Ship the Gano Telegram bot", to: "mia", ago: "just now" }]);
    expect(formatBrainStatus(st)).toMatch(/goals: 1 active \(1 drift-checked\), 0 paused, 0 done, 1 handed off/);
    expect(formatBrainStatus(st)).toMatch(/handed off just now: goal "Ship the Gano Telegram bot" → mia/);
    // take it back
    const back = updateGoal(a, g.lineage_id, { action: "resume", reason: "mia is on leave", now: now + HOUR });
    expect(back.goal).toMatchObject({ status: "active", handoff_to: null, handoff_at: null });
    expect(getNode(a, g.node_id)!.content).not.toMatch(/Handed off/);
    expect(getActiveGoals(a).map((n) => n.label).sort()).toEqual(["Billing migration", "Ship the Gano Telegram bot"]);
    expect(other.status).toBe("active");
  });

  it("plans: handoff / resume (take back), listing, briefing of the goal, counts", async () => {
    const a = fresh();
    const now = Date.now();
    const g = setGoal(a, { title: "Ship the Gano Telegram bot", priority: 1, now: now - 10 * DAY }).goal!;
    const p = createPlan(a, { title: "Gano Telegram bot rollout", goalId: g.lineage_id, steps: ["get the bot token", "wire the webhook"], now: now - 6 * DAY, sessionKey: S, config: cfg }).plan!;
    expect(getTaskFrame(a, S, cfg, now - 6 * DAY)!.plan_id).toBe(p.node_id); // pinned at creation time (stale by now, 6 days later)
    expect((await dispatchBrainTool("brain_plan", a, { action: "handoff", plan_id: p.node_id }, cfg)).text).toMatch(/handoff needs to:/);
    const r = await dispatchBrainTool("brain_plan", a, { action: "handoff", plan_id: p.node_id.slice(0, 8), to: "mia", note: "she has the token" }, cfg, "mcp", { sessionKey: S });
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/^Plan handed off to mia\. It is theirs now: out of your current task and briefings until brain_plan resume takes it back\./);
    expect(r.text).toMatch(/Plan \[handed_off → mia\] Gano Telegram bot rollout[\s\S]*handed to mia: she has the token — theirs now; brain_plan resume takes it back/);
    expect(getTaskFrame(a, S, cfg, now)).toBeNull();
    expect(getPlan(a, p.node_id)).toMatchObject({ status: "handed_off", handoff_to: "mia", handoff_note: "she has the token" });
    expect(getNode(a, p.node_id)!.content).toMatch(/HANDED OFF to mia \(she has the token\) — not yours to carry out/);
    expect(listPlans(a).map((x) => x.title)).toEqual([]);
    expect(listPlans(a, "handed_off").map((x) => x.title)).toEqual(["Gano Telegram bot rollout"]);
    expect((await dispatchBrainTool("brain_plan", a, { action: "list", status: "bogus" }, cfg)).text).toMatch(/status must be one of active, parked, done, abandoned, handed_off, all/);
    expect((await dispatchBrainTool("brain_plan", a, { action: "list", status: "handed_off" }, cfg)).text).toMatch(/Plan \[handed_off → mia\]/);
    expect(briefing(a, { goalId: g.lineage_id }, cfg, now).text).toMatch(/Plan \[handed off → mia\] Gano Telegram bot rollout: theirs now/);
    expect(commitmentCounts(getDb(a), now).plansHandedOff).toBe(1);
    expect(formatBrainStatus(computeBrainStatus(getDb(a), cfg, now))).toMatch(/plans: 0 active, 0 parked, 1 handed off/);
    expect(recentHandoffs(a, now - DAY)).toMatchObject([{ kind: "plan", title: "Gano Telegram bot rollout", to: "mia" }]);
    // a handed-off plan cannot be parked, done-stepped into our frame, or handed off again
    expect((await dispatchBrainTool("brain_plan", a, { action: "park", plan_id: p.node_id }, cfg)).text).toMatch(/plan is handed_off/);
    expect((await dispatchBrainTool("brain_plan", a, { action: "handoff", plan_id: p.node_id, to: "bob" }, cfg)).text).toMatch(/plan is handed_off/);
    // take it back: resume works from handed_off and pins it again
    const back = await dispatchBrainTool("brain_plan", a, { action: "resume", plan_id: p.node_id }, cfg, "mcp", { sessionKey: S });
    expect(back.text).toMatch(/^Plan resumed \(taken back \(handed off just now\)\) — it is this session's current task again\./);
    expect(getPlan(a, p.node_id)).toMatchObject({ status: "active", handoff_to: null, handoff_at: null });
    expect(getTaskFrame(a, S, cfg, now)!.plan_id).toBe(p.node_id);
    expect(formatPlan(getPlan(a, p.node_id)!, now)).toMatch(/^[0-9a-f-]{36} Plan \[active\] Gano Telegram bot rollout/);
  });
});

describe("task signals from the owner's words", () => {
  it("detects focus and handoff phrasing, conservatively", () => {
    const d = (s: string) => detectTaskSignals(s);
    expect(d("Hand the Gano Telegram bot off to Mia. Let's work on the billing migration now.")).toEqual({
      focus: "billing migration", handoffs: [{ what: "Gano Telegram bot", to: "Mia", sentence: "Hand the Gano Telegram bot off to Mia." }],
    });
    expect(d("ok, switching to the invoice exporter").focus).toBe("invoice exporter");
    expect(d("we're working on the login bug today").focus).toBe("login bug");
    expect(d("Mia will take over the Telegram bot from here").handoffs).toMatchObject([{ what: "Telegram bot", to: "Mia" }]);
    expect(d("the webhook work was handed to bob").handoffs).toMatchObject([{ what: "webhook work", to: "bob" }]);
    expect(d("let mia handle the bot rollout").handoffs).toMatchObject([{ what: "bot rollout", to: "mia" }]);
    expect(d("I passed the Gano project over to agent-2 yesterday, let's get back to billing")).toMatchObject({ focus: "billing", handoffs: [{ what: "Gano project", to: "agent-2" }] });
    // not handoffs / not focus
    expect(d("hand it to me when you're done").handoffs).toEqual([]); // pronouns
    expect(d("give it to them").handoffs).toEqual([]);
    expect(d("continue")).toEqual({ focus: null, handoffs: [] });
    expect(d("let's work on it").focus).toBeNull();
    expect(d("what's for lunch?")).toEqual({ focus: null, handoffs: [] });
    expect(d("I handed in my notice to the landlord").handoffs).toEqual([]); // "handed in" is not "handed … to"
    expect(d("```\nhand the token to mia\n```").handoffs).toEqual([]); // code is not speech
    expect(d("let's do the deploy checklist first")).toMatchObject({ focus: "deploy checklist" });
  });

  it("applies them: matching plan / goal handed off with the sentence as the note; focus pins the matching active plan, else the phrase", () => {
    const a = fresh();
    const now = Date.now();
    const gano = setGoal(a, { title: "Ship the Gano Telegram bot", priority: 1, now: now - 10 * DAY }).goal!;
    const ganoPlan = createPlan(a, { title: "Gano Telegram bot rollout", goalId: gano.lineage_id, steps: ["token", "webhook"], now: now - 6 * DAY }).plan!;
    const billing = createPlan(a, { title: "Billing migration", steps: ["export invoices", "cut over"], now: now - DAY }).plan!;
    updatePlan(a, billing.node_id, { action: "step", step: 1, status: "done", now: now - HOUR });
    const r = applyTaskSignals(a, S, "Hand the Gano Telegram bot off to Mia. Let's work on the billing migration now.", { config: cfg, origin: "owner", now });
    expect(r.handoffs.map((h) => `${h.kind}:${h.title}→${h.to}`).sort()).toEqual(["goal:Ship the Gano Telegram bot→Mia", "plan:Gano Telegram bot rollout→Mia"]);
    expect(r.unmatched).toEqual([]);
    expect(getPlan(a, ganoPlan.node_id)).toMatchObject({ status: "handed_off", handoff_to: "Mia", handoff_note: 'owner said: "Hand the Gano Telegram bot off to Mia."' });
    expect(currentGoalRow(a, gano.lineage_id)).toMatchObject({ status: "handed_off", handoff_to: "Mia" });
    expect(r.focus).toEqual({ title: "Billing migration", planId: billing.node_id, goalId: null });
    expect(getTaskFrame(a, S, cfg, now)).toMatchObject({ title: "Billing migration", plan_id: billing.node_id, set_by: "owner", note: "next: 2. cut over" });
    // a phrase that matches nothing still pins (as words) and reports the handoff as unmatched
    const r2 = applyTaskSignals(a, S, "Give the newsletter draft to Zed. Now let's focus on the onboarding emails.", { config: cfg, origin: "owner", now: now + 1 });
    expect(r2.unmatched).toEqual([{ what: "newsletter draft", to: "Zed" }]);
    expect(r2.focus).toEqual({ title: "onboarding emails", planId: null, goalId: null });
    expect(getTaskFrame(a, S, cfg, now + 1)!.set_by).toBe("owner");
    // a compaction summary never overrides a live frame, and nothing happens with handoffDetection off
    const r3 = applyTaskSignals(a, S, "The user is working on the billing migration.", { config: cfg, origin: "compaction", now: now + 2 });
    expect(r3.focus).toBeNull();
    expect(getTaskFrame(a, S, cfg, now + 2)!.title).toBe("onboarding emails");
    clearTaskFrame(a, S);
    const r4 = applyTaskSignals(a, S, "We are now working on the billing migration.", { config: cfg, origin: "compaction", now: now + 3 });
    expect(r4.focus?.planId).toBe(billing.node_id);
    expect(getTaskFrame(a, S, cfg, now + 3)!.set_by).toBe("compaction");
    expect(applyTaskSignals(a, S, "Hand the billing migration to Bob.", { config: { ...cfg, handoffDetection: false }, now: now + 4 })).toEqual({ focus: null, handoffs: [], unmatched: [] });
    expect(getPlan(a, billing.node_id)!.status).toBe("active");
    // a vague "it" is never matched to anything
    expect(applyTaskSignals(a, S, "Hand it to Bob.", { config: cfg, now: now + 5 }).handoffs).toEqual([]);
  });
});

describe("the [BRAIN: now] block and session turns", () => {
  it("shows the frame, the plan step, recent handoffs and the meaning of a bare 'continue'; empty when there is nothing", () => {
    const a = fresh();
    const now = Date.now();
    expect(buildNowContext(a, S, cfg, { now })).toBe("");
    const p = createPlan(a, { title: "Billing migration", steps: ["export invoices", "cut over", "verify"], now: now - HOUR, sessionKey: S, config: cfg }).plan!;
    updatePlan(a, p.node_id, { action: "step", step: 1, status: "done", now: now - HOUR, sessionKey: S, config: cfg });
    updatePlan(a, p.node_id, { action: "step", step: 2, status: "doing", now: now - HOUR, sessionKey: S, config: cfg });
    const gano = createPlan(a, { title: "Gano Telegram bot rollout", steps: ["token"], now: now - 3 * DAY }).plan!;
    updatePlan(a, gano.node_id, { action: "handoff", to: "mia", note: "mia has the token", now: now - 2 * HOUR });
    const block = buildNowContext(a, S, cfg, { now, prompt: "continue" });
    expect(block.split("\n")).toEqual([
      "[BRAIN: now]",
      "Working on: Billing migration (from the plan, 1 h ago) — next: 2. cut over",
      `Plan ${p.node_id.slice(0, 8)} "Billing migration": 1/3 steps done; now: 2. cut over`,
      'Handed off 2 h ago: plan "Gano Telegram bot rollout" → mia (mia has the token) — theirs now, not yours.',
      '"continue" means the task above — not an older plan, goal or handed-off project.',
    ]);
    expect(buildNowContext(a, S, cfg, { now, prompt: "what about the invoices?" })).not.toMatch(/means the task above/);
    // no frame: a bare prompt still gets the "no topic" line when there is a handoff to mention
    expect(buildNowContext(a, "agent:rid:other", cfg, { now, prompt: "go on" })).toMatch(/Handed off 2 h ago[\s\S]*This turn carries no topic of its own: carry on with what this conversation was doing/);
    // heartbeat scope: another session's frame is used when this one has none
    expect(buildNowContext(a, "agent:rid:heartbeat", cfg, { now, scope: "agent" })).toMatch(/^\[BRAIN: now\]\nWorking on: Billing migration/);
    expect(buildNowContext(a, "agent:rid:heartbeat", cfg, { now })).not.toMatch(/Working on/);
    // off switch
    expect(buildNowContext(a, S, { ...cfg, currentTask: false }, { now })).toBe("");
    // handoffs age out of the block (7 days) but not of brain_now get (30 days)
    expect(buildNowContext(a, "agent:rid:other", cfg, { now: now + 8 * DAY })).toBe("");
  });

  it("this-session recent turns come from this session only, oldest first, no tool markers", () => {
    const a = fresh();
    appendEpisode(a, S, "user", "let's cut over the invoices", 0.5);
    appendEpisode(a, S, "assistant", "Cutting over now — exporting the last batch first.", 0.5);
    appendEpisode(a, S, "tool", "[compaction: 40 of 60 messages compacted]", 0.1);
    appendEpisode(a, "agent:rid:other", "user", "unrelated chat elsewhere", 0.5);
    const b = buildSessionRecentContext(a, S, 4);
    expect(b).toMatch(/^\[BRAIN: this session, last turns\]\nthem \(just now\): let's cut over the invoices\nyou \(just now\): Cutting over now/);
    expect(b).not.toMatch(/compaction|unrelated/);
    expect(buildSessionRecentContext(a, "agent:rid:empty")).toBe("");
    expect(buildSessionRecentContext(a, "")).toBe("");
  });

  it("recall skips topic search on a low-information prompt (and not when currentTask is off)", async () => {
    const a = fresh();
    writeNode(a, "semantic", "Continue the Gano bot rollout", "Continue the Gano Telegram bot rollout once the token arrives", { importance: 0.8 });
    expect(await buildRecallContext(a, "continue", "s1", cfg)).toBe("");
    expect(await buildRecallContext(a, "ok go on", "s1", cfg)).toBe("");
    expect(await buildRecallContext(a, "continue the rollout", "s1", cfg)).toMatch(/Gano/);
    expect(await buildRecallContext(a, "continue", "s1", { ...cfg, currentTask: false })).toMatch(/Gano/);
  });
});

describe("nudge discipline", () => {
  function drifting() {
    const a = fresh();
    const now = Date.now();
    const old = setGoal(a, { title: "Ship the Gano Telegram bot", priority: 1, successCriteria: "Gano answers messages", now: now - 12 * DAY }).goal!;
    const r = runDriftPass(a, cfg, log, now);
    expect(r.noteId).not.toBeNull();
    return { a, now, old };
  }

  it("a pending alignment note is held on a content-free prompt, held while the session is on another task, offered when the frame is that goal or there is no frame", () => {
    const { a, now, old } = drifting();
    const offers = () => (getDb(a).prepare("SELECT offered_count FROM alignment_notes ORDER BY id DESC LIMIT 1").get() as { offered_count: number }).offered_count;
    // low-information prompt: nothing offered, no offer counted
    let t = buildGoalTurnContext(a, "continue", cfg, now + 1000, undefined, { sessionKey: S });
    expect(t.text).toBe("");
    expect(t.noteIds).toEqual([]);
    expect(t.held).toBe(1);
    expect(offers()).toBe(0);
    // the session is on something else: held
    setTaskFrame(a, S, { title: "Billing migration", setBy: "owner" }, now);
    t = buildGoalTurnContext(a, "let's cut over the invoices", cfg, now + 2000, undefined, { sessionKey: S });
    expect(t.text).toBe("");
    expect(t.held).toBe(1);
    expect(offers()).toBe(0);
    // the session is on that very goal: offered
    setTaskFrame(a, S, { title: "Gano bot", goalId: old.lineage_id, setBy: "owner" }, now);
    t = buildGoalTurnContext(a, "where were we with the bot", cfg, now + 3000, undefined, { sessionKey: S });
    expect(t.text).toMatch(/^\[BRAIN: goals\]\nAlignment: no progress on goal "Ship the Gano Telegram bot" \(P1\) in 12 days\. A reminder, not a change of task/);
    expect(t.noteIds).toHaveLength(1);
    expect(offers()).toBe(1);
    // no frame, no session key (older hosts): offered, as before
    clearTaskFrame(a, S);
    t = buildGoalTurnContext(a, "hello", cfg, now + 4000);
    expect(t.text).toMatch(/Alignment: no progress/);
    expect(offers()).toBe(2);
    // the switch off restores the old behaviour entirely
    expect(buildGoalTurnContext(a, "continue", { ...cfg, currentTask: false }, now + 5000, undefined, { sessionKey: S }).noteIds).toHaveLength(1);
  });

  it("a commitment nudge is held unless the commitment is about the session's plan or goal; a handed-off goal's note is superseded", () => {
    const a = fresh();
    const now = Date.now();
    const p = createPlan(a, { title: "Billing migration", steps: ["cut over"], now: now - DAY }).plan!;
    const c = createCommitment(a, { title: "send the invoice report", to: "user", due: now - HOUR, now: now - 2 * DAY }).commitment!;
    createCommitment(a, { title: "tell mia about the bot", to: "mia", due: now - HOUR, now: now - 3 * DAY });
    writeEdge(a, c.node_id, p.node_id, "about");
    setTaskFrame(a, S, { title: "Billing migration", planId: p.node_id, setBy: "plan" }, now);
    const t = buildGoalTurnContext(a, "cutting over now", cfg, now, undefined, { sessionKey: S });
    // the oldest-due commitment ("tell mia") gets the nudge; it is not about this plan → held
    expect(t.text).toBe("");
    expect(t.held).toBe(1);
    const t2 = buildGoalTurnContext(a, "cutting over now", cfg, now + 1000);
    expect(t2.text).toMatch(/Commitment overdue: "tell mia about the bot"/);
    // handing a goal off supersedes its pending alignment note
    const { a: b, now: n, old } = (() => { const x = fresh(); const nn = Date.now(); const o = setGoal(x, { title: "Ship the Gano Telegram bot", priority: 1, now: nn - 12 * DAY }).goal!; runDriftPass(x, cfg, log, nn); return { a: x, now: nn, old: o }; })();
    updateGoal(b, old.lineage_id, { action: "handoff", to: "mia", now: n + 1 });
    expect(buildGoalTurnContext(b, "hello", cfg, n + 2000).text).toBe("");
  });
});

describe("compaction keeps the task", () => {
  it("reads handoffs and the current task from the summary, pins when the session has no frame, and leaves a state episode in the session", () => {
    const a = fresh();
    const now = Date.now();
    const gano = setGoal(a, { title: "Ship the Gano Telegram bot", priority: 1, now: now - 10 * DAY }).goal!;
    createPlan(a, { title: "Billing migration", steps: ["export invoices", "cut over"], now: now - DAY });
    const summary = "Earlier in the conversation the user said the Gano Telegram bot was handed to Mia, who now runs it. Since then we are working on the billing migration: invoices are exported and the cut-over is being prepared. The user prefers short replies.";
    handleCompaction(a, { summary, compactedCount: 40, messageCount: 60 }, cfg, log, { sessionKey: S, now });
    expect(currentGoalRow(a, gano.lineage_id)).toMatchObject({ status: "handed_off", handoff_to: "Mia" });
    const f = getTaskFrame(a, S, cfg, now)!;
    expect(f).toMatchObject({ title: "Billing migration", set_by: "compaction" });
    expect(f.plan_id).toBeTruthy();
    const ep = getDb(a).prepare("SELECT role, content FROM episodes WHERE session_id = ? ORDER BY created_at DESC LIMIT 1").get(S) as { role: string; content: string };
    expect(ep.role).toBe("tool");
    // the plan's steps were never marked, so the frame says step 1 — the summary's prose is not step state
    expect(ep.content).toBe('[session state after compaction] working on: Billing migration (next: 1. export invoices); goal "Ship the Gano Telegram bot" handed off to Mia');
    // next turn's now block carries it — the compacted turns are gone, the state is not
    expect(buildNowContext(a, S, cfg, { now: now + 1, prompt: "continue" })).toMatch(/Working on: Billing migration \(restored after compaction[\s\S]*Handed off just now: goal "Ship the Gano Telegram bot" → Mia[\s\S]*"continue" means the task above/);
    // an owner-set frame survives a later compaction summary that says something else
    setTaskFrame(a, S, { title: "Onboarding emails", setBy: "owner" }, now + 2);
    handleCompaction(a, { summary: "The assistant and user are working on the billing migration and discussed invoice totals at length for a while." }, cfg, log, { sessionKey: S, now: now + 3 });
    expect(getTaskFrame(a, S, cfg, now + 3)!.title).toBe("Onboarding emails");
    // without a session key (older hosts) compaction only mines nodes, as before
    const b = fresh();
    handleCompaction(b, { summary }, cfg, log);
    expect(listTaskFrames(b, cfg, now)).toEqual([]);
  });

  it("brain_reset wipes task frames too", () => {
    const a = fresh();
    setTaskFrame(a, S, { title: "Billing migration" });
    expect(resetBrain(a).other["task_frames"]).toBe(1);
    expect(getTaskFrame(a, S, cfg)).toBeNull();
  });
});
