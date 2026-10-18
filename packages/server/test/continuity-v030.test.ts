/**
 * Xanima 0.3.0 over the service: reflection / replay / open items /
 * commitments / plans / meta-tools on the private brain with scopes; the turn
 * context carries the commitment nudge + a relevant open question and acks
 * both with ack_note_ids; open items are captured from assistant episodes.
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { startService, tool } from "./helpers.js";

describe("0.3.0 tools on the service", () => {
  it("scopes: read tokens get the read-only meta-tools, writes need write; shared refused; per-agent", async () => {
    const h = await startService({ brain: { reflection: "sleep" } });
    try {
      const a = h.mint("a"), b = h.mint("b"), ro = h.mint("a", ["read"]);
      const g = await tool(h.url, a, "brain_set_goal", { title: "Ship the Gano bot", priority: "high" });
      const gid = /Goal set: (\S+)/.exec(g.text)![1]!;
      const d = await tool(h.url, a, "brain_record_decision", { context: "bot host", chosen: "fly.io", goal_id: gid, confidence: "high" });
      const did = /decision ([0-9a-f-]{36})/.exec(d.text)![1]!;
      await tool(h.url, a, "brain_update_decision_outcome", { decision_id: did, outcome: "dropped messages", outcome_status: "missed", lesson: "check the region" });
      const r = await tool(h.url, a, "brain_reflect", { goal_id: gid });
      expect(r.text).toMatch(/What didn't:[\s\S]*fly\.io/);
      expect((await tool(h.url, a, "brain_replay", { goal_id: gid })).text).toMatch(/MISSED/);
      const hy = await tool(h.url, a, "brain_hypothesis", { action: "create", statement: "the region causes the drops", links: [did] });
      expect(hy.isError, hy.text).toBe(false);
      const pl = await tool(h.url, a, "brain_plan", { action: "create", title: "Move the bot region", steps: ["pick region", "redeploy"], goal_id: gid });
      expect(pl.text).toMatch(/Plan created/);
      for (const [t, args] of [["brain_changes", { goal_id: gid }], ["brain_conflicts", { topic: "region" }], ["brain_briefing", { goal_id: gid }], ["brain_forget_impact", { query: "region" }], ["brain_list_open", {}], ["brain_commitments", {}]] as const) {
        const x = await tool(h.url, ro, t, args);
        expect(x.isError, `${t}: ${x.text}`).toBe(false);
      }
      expect((await tool(h.url, a, "brain_briefing", { goal_id: gid })).text).toMatch(/Plan \[active\] Move the bot region/);
      for (const [t, args] of [["brain_reflect", {}], ["brain_hypothesis", { action: "create", statement: "x y z" }], ["brain_commit", { action: "create", title: "abc" }], ["brain_plan", { action: "create", title: "abc" }]] as const) {
        const x = await tool(h.url, ro, t, args);
        expect(x.text, t).toMatch(/needs the write scope/);
      }
      expect((await tool(h.url, a, "brain_question", { action: "ask", question: "x?", visibility: "shared" })).text).toMatch(/private brain only/);
      expect((await tool(h.url, b, "brain_list_open", {})).text).toMatch(/No open/);
      const db = new Database(join(h.root, "brains", "a", "brain.db"), { readonly: true });
      expect(db.prepare("SELECT writer_agent_id w FROM nodes WHERE type = 'hypothesis'").get()).toEqual({ w: "a" });
      db.close();
    } finally { await h.stop(); }
  });

  it("turn context: commitment nudge + open question, acked together only after a real reply; open items captured from assistant episodes", async () => {
    const h = await startService();
    try {
      const a = h.mint("a");
      await tool(h.url, a, "brain_commit", { action: "create", title: "send Hailey the report", due: "2 days ago" });
      await tool(h.url, a, "brain_question", { action: "ask", question: "Which region has the lowest Telegram latency?" });
      const t1 = JSON.parse((await tool(h.url, a, "brain_turn_context", { query: "let's look at the region and latency" })).text);
      expect(t1.text).toMatch(/Commitment overdue: "send Hailey the report"/);
      expect(t1.text).toMatch(/Open question .*lowest Telegram latency/);
      expect(t1.noteIds).toHaveLength(1);
      const st = await tool(h.url, a, "brain_status", { visibility: "private" });
      expect(st.text).toMatch(/OVERDUE .*send Hailey the report/);
      expect(st.text).toMatch(/commitment nudge pending/);
      const t2 = JSON.parse((await tool(h.url, a, "brain_turn_context", { query: "hi" })).text);
      expect(t2.noteIds).toEqual(t1.noteIds); // not consumed without an ack
      expect(JSON.parse((await tool(h.url, a, "brain_turn_context", { ack_note_ids: t1.noteIds })).text)).toEqual({ acked: true, noteIds: t1.noteIds });
      expect((await tool(h.url, a, "brain_turn_context", { ack_note_ids: ["x"] })).isError).toBe(true);
      expect(JSON.parse((await tool(h.url, a, "brain_turn_context", { query: "hi" })).text).noteIds).toEqual([]);
      const ep = await tool(h.url, a, "brain_episode_append", { session_id: "s1", role: "assistant", content: "I think the drops come from the Frankfurt region because they started after the move. Open question: does fly.io pin IPs?" });
      expect(ep.text).toMatch(/Captured 2 open item drafts/);
      const ep2 = await tool(h.url, a, "brain_episode_append", { session_id: "s1", role: "user", content: "I think it's the region because I said so." });
      expect(ep2.text).not.toMatch(/Captured/);
      expect((await tool(h.url, a, "brain_list_open", { kind: "hypothesis" })).text).toMatch(/Frankfurt region .*captured draft/);
    } finally { await h.stop(); }
  });
});
