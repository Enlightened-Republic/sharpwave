// 0.7 current task + handoffs over the service: brain_turn_context carries the session's
// [BRAIN: now] block (keyed by session_key), brain_now / brain_plan / brain_update_goal take
// session_key, a handed-off goal leaves the activeGoals header, and a bare "continue" holds
// the alignment nudge. Own file: core's data dir is process-global, one service per worker.
import { describe, expect, it } from "vitest";
import { getDb, setGoal, runDriftPass } from "xanima-core";
import { startService, tool } from "./helpers.js";

const log = { info: () => {}, warn: () => {}, error: () => {} };
const DAY = 86_400_000;
const S = "agent:alice:main";

describe("current task on the service", () => {
  it("brain_now is per session_key; brain_plan pins; turn context returns `now` and holds nudges on a bare continue; handoff clears the header", async () => {
    const h = await startService({ sleep: { enabled: false }, backup: { enabled: false } });
    try {
      const tok = h.mint("alice");
      const brain = h.svc.brains.privateBrain("alice");
      const now = Date.now();
      // a stale P1 goal that drift will nag about
      const old = await h.svc.brains.write(brain, () => setGoal(brain, { title: "Ship the Gano Telegram bot", priority: 1, successCriteria: "Gano answers", now: now - 12 * DAY }).goal!);
      await h.svc.brains.write(brain, () => runDriftPass(brain, h.cfg.brain ?? {}, log, now));

      // no frame yet: turn context has no `now`; the nudge is offered on a real prompt …
      const t0 = JSON.parse((await tool(h.url, tok, "brain_turn_context", { query: "what's for lunch?", session_key: S })).text) as { text: string; now?: string; noteIds: number[]; activeGoals?: string[] };
      expect(t0.now).toBeUndefined();
      expect(t0.text).toMatch(/Alignment: no progress on goal "Ship the Gano Telegram bot"/);
      expect(t0.activeGoals).toEqual(["Ship the Gano Telegram bot"]);
      // … and held on a bare "continue" (stays pending, not acked, not counted)
      const t1 = JSON.parse((await tool(h.url, tok, "brain_turn_context", { query: "continue", session_key: S })).text) as { text: string; noteIds: number[]; held?: number };
      expect(t1.text).toBe("");
      expect(t1.noteIds).toEqual([]);
      expect(t1.held).toBe(1);

      // a plan created from this session pins the task
      const p = await tool(h.url, tok, "brain_plan", { action: "create", title: "Billing migration", steps: ["export invoices", "cut over"], session_key: S });
      expect(p.text).toMatch(/^Plan created and pinned as this session's current task/);
      const planId = /^([0-9a-f-]{36}) Plan/m.exec(p.text)![1]!;
      const g1 = await tool(h.url, tok, "brain_now", { action: "get", session_key: S });
      expect(g1.text).toMatch(/^Working on: Billing migration \(from the plan, just now\) — next: 1\. export invoices/);
      expect((await tool(h.url, tok, "brain_now", { action: "get", session_key: "agent:alice:telegram" })).text).toMatch(/^No current task set for this conversation/);
      // the turn context now carries the block, and the nudge about the OTHER goal stays held
      const t2 = JSON.parse((await tool(h.url, tok, "brain_turn_context", { query: "ok, cutting over the invoices", session_key: S })).text) as { text: string; now?: string; noteIds: number[]; held?: number };
      expect(t2.now).toMatch(/^\[BRAIN: now\]\nWorking on: Billing migration[\s\S]*Plan [0-9a-f]{8} "Billing migration": 0\/2 steps done; now: 1\. export invoices/);
      expect(t2.noteIds).toEqual([]);
      expect(t2.held).toBe(1);
      expect(JSON.parse((await tool(h.url, tok, "brain_turn_context", { query: "continue", session_key: S })).text).now).toMatch(/"continue" means the task above/);

      // hand the old goal off: out of activeGoals, note superseded, visible in the now block
      const ho = await tool(h.url, tok, "brain_update_goal", { goal_id: old.lineage_id, action: "handoff", to: "mia", note: "mia runs the bot" });
      expect(ho.isError).toBe(false);
      expect(ho.text).toMatch(/\[handed_off → mia\] Ship the Gano Telegram bot/);
      const t3 = JSON.parse((await tool(h.url, tok, "brain_turn_context", { query: "hello", session_key: S })).text) as { text: string; now?: string; activeGoals?: string[] };
      expect(t3.activeGoals).toBeUndefined();
      expect(t3.text).toBe("");
      expect(t3.now).toMatch(/Handed off just now: goal "Ship the Gano Telegram bot" → mia \(mia runs the bot\) — theirs now, not yours\./);
      expect((await tool(h.url, tok, "brain_list_goals", { status: "handed_off" })).text).toMatch(/handed to mia just now: mia runs the bot/);
      expect((await tool(h.url, tok, "brain_status", {})).text).toMatch(/now: Billing migration \(session agent:alice:main[\s\S]*handed off just now: goal "Ship the Gano Telegram bot" → mia/);

      // brain_now set / clear with the session key; the frame lives in the brain
      expect((await tool(h.url, tok, "brain_now", { action: "set", title: "Onboarding emails", session_key: S })).text).toMatch(/^Current task set: Onboarding emails/);
      expect((getDb(brain).prepare("SELECT title FROM task_frames WHERE session_key = ?").get(S) as { title: string }).title).toBe("Onboarding emails");
      expect((await tool(h.url, tok, "brain_now", { action: "clear", session_key: S })).text).toBe("Current task cleared (was: Onboarding emails).");
      // step the plan from a cron session: that session gets its own frame; the main one has none
      await tool(h.url, tok, "brain_plan", { action: "step", plan_id: planId, step: 1, status: "done", session_key: "agent:alice:cron:1" });
      expect((await tool(h.url, tok, "brain_now", { action: "get", session_key: S })).text).toMatch(/^No current task set for this conversation[\s\S]*Other conversations: agent:alice:cron:1 → Billing migration/);
      // older hosts that send no session_key share one default frame
      expect((await tool(h.url, tok, "brain_now", { action: "set", title: "Default-keyed task" })).isError).toBe(false);
      expect((await tool(h.url, tok, "brain_now", { action: "get" })).text).toMatch(/^Working on: Default-keyed task/);
    } finally { await h.stop(); }
  });
});
