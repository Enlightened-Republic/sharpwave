/**
 * Xanima 0.2.0 over the service: decision ledger + goals tools (private brain,
 * scopes), brain_turn_context (alignment note once, keyword trigger), decision
 * auto-extraction on assistant episodes, decision boost in brain_query.
 */
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { join } from "node:path";
import { startService, tool } from "./helpers.js";

const DAY = 86_400_000;

describe("continuity tools on the service", () => {
  it("record → outcome → query decisions; private per agent; scopes enforced; shared refused", async () => {
    const h = await startService();
    try {
      const a = h.mint("a"), b = h.mint("b"), ro = h.mint("ro", ["read"]);
      const rec = await tool(h.url, a, "brain_record_decision", { context: "Email provider for the newsletter", options: ["Resend => simple", "Mailchimp => templates"], chosen: "Resend", rationale: "API-first", confidence: "high" });
      expect(rec.isError, rec.text).toBe(false);
      const id = /decision ([0-9a-f-]{36})/.exec(rec.text)![1]!;
      const out = await tool(h.url, a, "brain_update_decision_outcome", { decision_id: id.slice(0, 8), outcome: "sent fine", outcome_status: "matched", lesson: "API-first wins" });
      expect(out.text).toMatch(/Outcome recorded \(matched\)/);
      expect((await tool(h.url, a, "brain_query_decisions", { query: "email" })).text).toMatch(/chose: Resend/);
      expect((await tool(h.url, b, "brain_query_decisions", {})).text).toBe("No matching decisions.");
      expect((await tool(h.url, ro, "brain_list_goals", {})).isError).toBe(false);
      const denied = await tool(h.url, ro, "brain_record_decision", { context: "x", chosen: "y" });
      expect(denied.isError).toBe(true);
      expect(denied.text).toMatch(/needs the write scope/);
      expect((await tool(h.url, a, "brain_set_goal", { title: "x", visibility: "shared" })).text).toMatch(/private brain only/);
      // the writer is the token's agent, never a client claim
      const db = new Database(join(h.root, "brains", "a", "brain.db"), { readonly: true });
      expect(db.prepare("SELECT writer_agent_id AS w FROM nodes WHERE id = ?").get(id)).toEqual({ w: "a" });
      db.close();
    } finally { await h.stop(); }
  });

  it("goals: set / supersede with history / list; turn context delivers the alignment note once and fires keyword triggers", async () => {
    const h = await startService({ brain: { intentDriftCheck: "daily", driftDays: 7 } });
    try {
      const a = h.mint("a");
      const g = await tool(h.url, a, "brain_set_goal", { title: "Ship the billing migration", priority: "critical", keywords: ["billing", "migration"], triggers: [{ kind: "keyword", keywords: ["invoice"] }] });
      const gid = /Goal set: (\S+)/.exec(g.text)![1]!;
      const sup = await tool(h.url, a, "brain_update_goal", { goal_id: gid, action: "supersede", title: "Ship the billing migration by Nov 1", reason: "date agreed with Hailey" });
      expect(sup.text).toMatch(/v1 → v2/);
      const hist = await tool(h.url, a, "brain_list_goals", { goal_id: gid });
      expect(hist.text).toMatch(/v2 supersede .*reason: date agreed with Hailey/);
      // ten idle days: backdate the goal
      const db = new Database(join(h.root, "brains", "a", "brain.db"));
      db.prepare("UPDATE goals SET created_at = ?, last_progress_at = ?").run(Date.now() - 10 * DAY, Date.now() - 10 * DAY);
      db.prepare("DELETE FROM meta_kv WHERE key = 'drift:last_run'").run();
      db.close();
      const t1 = JSON.parse((await tool(h.url, a, "brain_turn_context", { query: "hello" })).text);
      expect(t1.text).toMatch(/Alignment: no progress on goal "Ship the billing migration by Nov 1" \(P1\) in 10 days/);
      // offered, not delivered: a tool-only turn (no ack) leaves it pending
      const t2 = JSON.parse((await tool(h.url, a, "brain_turn_context", { query: "CALL brain_status {}" })).text);
      expect(t2.noteId).toBe(t1.noteId);
      expect((await tool(h.url, a, "brain_status", { visibility: "private" })).text).toMatch(/alignment note pending \(offered 2×/);
      expect((await tool(h.url, a, "brain_turn_context", { ack_note_id: "x" })).isError).toBe(true);
      expect((await tool(h.url, h.mint("ro3", ["read"]), "brain_turn_context", { ack_note_id: t1.noteId })).isError).toBe(true);
      expect(JSON.parse((await tool(h.url, a, "brain_turn_context", { ack_note_id: t1.noteId })).text)).toEqual({ acked: true, noteId: t1.noteId });
      expect(JSON.parse((await tool(h.url, a, "brain_turn_context", { ack_note_id: t1.noteId })).text).acked).toBe(false);
      expect(JSON.parse((await tool(h.url, a, "brain_turn_context", { query: "hello" })).text).text).toBe("");
      const t3 = JSON.parse((await tool(h.url, a, "brain_turn_context", { query: "send the invoice please" })).text);
      expect(t3.triggered[0].why).toBe('you mentioned "invoice"');
      const st = await tool(h.url, a, "brain_status", { visibility: "private" });
      expect(st.text).toMatch(/DRIFT .*billing migration/);
      expect((await tool(h.url, h.mint("ro2", ["read"]), "brain_turn_context", { query: "x" })).isError).toBe(true);
    } finally { await h.stop(); }
  });

  it("assistant episodes draft decisions (low confidence); user episodes and the shared brain never do", async () => {
    const h = await startService();
    try {
      const a = h.mint("a", ["read", "write", "shared-write"]);
      const r = await tool(h.url, a, "brain_episode_append", { session_id: "s1", role: "assistant", content: "I'll go with SQLite over Postgres because there is a single writer." });
      expect(r.text).toMatch(/Drafted 1 decision \(low confidence\)/);
      const u = await tool(h.url, a, "brain_episode_append", { session_id: "s1", role: "user", content: "I'll go with tea over coffee because it is late." });
      expect(u.text).not.toMatch(/Drafted/);
      const s = await tool(h.url, a, "brain_episode_append", { session_id: "s1", role: "assistant", content: "I'll go with Resend over SES because it is simpler.", visibility: "shared" });
      expect(s.text).not.toMatch(/Drafted/);
      const q = await tool(h.url, a, "brain_query_decisions", { format: "json" });
      const d = JSON.parse(q.text).decisions;
      expect(d).toHaveLength(1);
      expect(d[0]).toMatchObject({ chosen: "SQLite", auto_extracted: 1, confidence: "low" });
      // decision boost: the decision shows up for a matching query
      const hits = JSON.parse((await tool(h.url, a, "brain_query", { query: "SQLite single writer", format: "json", scope: "private" })).text).results;
      expect(hits[0].type).toBe("decision");
    } finally { await h.stop(); }
  });

  it("flags off: decisionLedger false refuses decision tools and drafts nothing", async () => {
    const h = await startService({ brain: { decisionLedger: false } });
    try {
      const a = h.mint("a");
      expect((await tool(h.url, a, "brain_record_decision", { context: "c", chosen: "x" })).isError).toBe(true);
      expect((await tool(h.url, a, "brain_episode_append", { session_id: "s", role: "assistant", content: "I'll go with A over B because c." })).text).not.toMatch(/Drafted/);
    } finally { await h.stop(); }
  });
});
