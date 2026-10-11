/**
 * Xanima 0.2.0 hardening (schema v21): the four sandbox risks.
 *   1. talking about a goal is not progress
 *   2. near-duplicate lessons merge into the existing skill
 *   3. auto-extracted decision drafts expire (soft), tighter extraction
 *   4. the alignment note is consumed only by a real reply (ack)
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb, closeDb } from "../src/db.js";
import { writeNode, getNode } from "../src/nodes.js";
import { appendEpisode } from "../src/episodes.js";
import { runConsolidation } from "../src/consolidation.js";
import { dispatchBrainTool } from "../src/tools.js";
import { computeBrainStatus, formatBrainStatus, getSleepSummary } from "../src/beliefs.js";
import {
  recordDecision, updateDecisionOutcome, queryDecisions, extractDecisionCandidates, autoExtractDecisions, runDecisionPass,
  confirmDecision, expireDecisionDrafts, lessonSimilarity,
} from "../src/decisions.js";
import { setGoal, updateGoal, runDriftPass, buildGoalTurnContext, ackAlignmentNote, criteriaKeywords, isGoalTalk, ALIGNMENT_NOTE_MAX_OFFERS } from "../src/goals.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const log = { info: () => {}, warn: () => {}, error: () => {} };
const DAY = 86_400_000;
const opened: string[] = [];
function fresh(prefix = "hard"): string { const id = `${prefix}-${randomUUID().slice(0, 8)}`; opened.push(id); return id; }
afterEach(() => { for (const id of opened.splice(0)) closeDb(id); });
const cfg = { ...DEFAULT_CONFIG };
const promo = { ...cfg, decisionLessonPromotion: true };
const backdate = (a: string, days: number, since: number) =>
  getDb(a).prepare("UPDATE episodes SET created_at = created_at - ? WHERE created_at >= ?").run(days * DAY, since);

describe("1. talking about a goal is not progress", () => {
  function talker() {
    const a = fresh();
    const now = Date.now();
    const g = setGoal(a, { title: "Finish the Telegram bot for Gano", priority: 1, keywords: ["telegram", "gano"], successCriteria: "Gano answers messages on Telegram", now: now - 10 * DAY }).goal!;
    return { a, now, g };
  }

  it("criteria keywords exclude the goal's name; goal plumbing is goal talk", () => {
    expect(criteriaKeywords("Gano answers messages on Telegram", ["Finish the Telegram bot for Gano"]).sort()).toEqual(["answers", "messages"]);
    expect(criteriaKeywords(null, ["x"])).toEqual([]);
    for (const t of ["TOOL brain_set_goal RESULT: Goal set: …", "CALL brain_list_goals {}", "[BRAIN: goals]\nAlignment: no progress", "Is Gano answering messages yet?",
      "TOOL brain_query RESULT: [private] 4e4d (goal) Finish the Telegram bot. Success: Gano answers messages on Telegram", "Goal (P1): Finish the bot. Success: Gano answers messages",
      "[BRAIN: recall]\n- Gano answers messages on Telegram (3 days ago)"]) expect(isGoalTalk(t), t).toBe(true);
    expect(isGoalTalk("Gano answers messages on Telegram now.")).toBe(false);
  });

  it("10 days of setting / listing / re-wording / discussing the goal still flags drift", async () => {
    const { a, now, g } = talker();
    const t0 = Date.now() - 1;
    for (let d = 10; d >= 1; d--) {
      appendEpisode(a, "s", "user", `day ${d}: how is the Telegram bot for Gano going?`, 0.5);
      appendEpisode(a, "s", "assistant", `day ${d}: The Telegram bot for Gano is still on my list, I'll get to the Gano Telegram bot soon.`, 0.5);
      appendEpisode(a, "s", "assistant", `TOOL brain_query RESULT:\n[private] ${g.node_id} (goal) Finish the Telegram bot for Gano. Success: Gano answers messages on Telegram`, 0.5);
      appendEpisode(a, "s", "assistant", `TOOL brain_list_goals RESULT:\n${g.lineage_id} P1 [active] Finish the Telegram bot for Gano\n  success: Gano answers messages on Telegram`, 0.5);
    }
    // goal tools during the period: list, re-word (supersede), set a sibling goal
    await dispatchBrainTool("brain_list_goals", a, {}, cfg);
    const sup = updateGoal(a, g.lineage_id, { action: "supersede", title: "Finish the Telegram bot for Gano and Nova", reason: "Nova too" });
    expect(sup.ok).toBe(true);
    appendEpisode(a, "s", "assistant", "[BRAIN: goals]\nAlignment: no progress on goal \"Finish the Telegram bot\" — Gano answers messages soon", 0.5);
    backdate(a, 1, t0); // all of that happened before today
    const r = runDriftPass(a, cfg, log, now);
    expect(r.drifting).toHaveLength(1);
    expect(r.drifting[0]).toMatchObject({ lineage_id: g.lineage_id, kind: "stalled" });
    expect(r.drifting[0]!.days).toBeGreaterThanOrEqual(10); // re-wording did not reset the clock
  });

  it("real evidence clears it: a linked decision, an outcome, an explicit progress note, criteria-matching activity", async () => {
    // linked decision
    { const { a, now, g } = talker();
      expect(runDriftPass(a, cfg, log, now).drifting).toHaveLength(1);
      recordDecision(a, { context: "Bot framework", chosen: "grammY", goalId: g.lineage_id });
      expect(runDriftPass(a, cfg, log, Date.now() + 1000).drifting).toEqual([]); }
    // outcome on an older linked decision
    { const { a, now, g } = talker();
      const d = recordDecision(a, { context: "Bot host", chosen: "the box", goalId: g.lineage_id, now: now - 9 * DAY }).id!;
      expect(runDriftPass(a, cfg, log, now).drifting).toHaveLength(1);
      updateDecisionOutcome(a, d, { outcome: "bot deployed", status: "matched" });
      expect(runDriftPass(a, cfg, log, Date.now() + 1000).drifting).toEqual([]); }
    // explicit progress shortcut
    { const { a, now, g } = talker();
      expect(runDriftPass(a, cfg, log, now).drifting).toHaveLength(1);
      expect((await dispatchBrainTool("brain_update_goal", a, { goal_id: g.lineage_id, progress: "webhook registered with BotFather" }, cfg)).text).toMatch(/Goal progress/);
      expect((await dispatchBrainTool("brain_update_goal", a, { goal_id: g.lineage_id, action: "progress" }, cfg)).isError).toBe(true); // a note is required
      expect(runDriftPass(a, cfg, log, Date.now() + 1000).drifting).toEqual([]); }
    // activity matching the success criteria (not the name)
    { const { a, now } = talker();
      appendEpisode(a, "s", "assistant", "Gano answers messages on Telegram now — tested with three chats.", 0.6);
      const r = runDriftPass(a, cfg, log, now + 1000);
      expect(r.drifting).toEqual([]); }
  });
});

describe("2. near-duplicate lessons merge into the existing skill", () => {
  it("API-first providers: one skill, later lessons merge (lexical fallback), evidence/confidence/history kept", async () => {
    const a = fresh();
    expect(lessonSimilarity("prefer API-first providers for transactional email", "API-first providers for transactional email are faster to integrate").sim).toBeGreaterThanOrEqual(0.5);
    const d1 = recordDecision(a, { context: "Email provider for the Nova newsletter", chosen: "Resend", confidence: "high" }).id!;
    const d2 = recordDecision(a, { context: "Email provider for password-reset mails", chosen: "Postmark" }).id!;
    updateDecisionOutcome(a, d1, { outcome: "0.2% bounces", status: "matched", lesson: "prefer API-first providers for transactional email" });
    updateDecisionOutcome(a, d2, { outcome: "set up in an hour", status: "matched", lesson: "API-first providers for transactional email are faster to integrate" });
    const p1 = runDecisionPass(a, promo, log);
    expect(p1.promoted).toBe(1); // was 2 in the sandbox (both lessons became skills)
    const skillId = p1.promotedIds[0]!;
    const skillsBefore = (getDb(a).prepare("SELECT COUNT(*) n FROM nodes WHERE type='skill'").get() as { n: number }).n;
    const conf0 = getNode(a, skillId)!.confidence_score!;
    // a third, later decision with the same lesson in other words
    const d3 = recordDecision(a, { context: "Provider for receipts", chosen: "Resend" }).id!;
    updateDecisionOutcome(a, d3, { outcome: "fine", status: "matched", lesson: "API-first email providers win for transactional mail" });
    const p2 = runDecisionPass(a, promo, log);
    expect(p2).toMatchObject({ promoted: 0, lessonsMerged: 1, mergedInto: [skillId] });
    expect((getDb(a).prepare("SELECT COUNT(*) n FROM nodes WHERE type='skill'").get() as { n: number }).n).toBe(skillsBefore);
    const sk = getNode(a, skillId)!;
    expect(sk.confidence_score!).toBeGreaterThan(conf0);
    expect(JSON.parse(sk.evidence!)).toEqual(expect.arrayContaining([d1, d2, d3]));
    expect(sk).toMatchObject({ source: "sws:decision-lesson", source_type: "inference", writer_agent_id: "system:sleep" }); // provenance kept
    expect(sk.content).toMatch(/learned from 3 decisions/);
    const hist = getDb(a).prepare("SELECT * FROM lesson_merges WHERE skill_id = ?").all(skillId) as Array<{ decision_id: string; method: string; similarity: number }>;
    expect(hist).toEqual([expect.objectContaining({ decision_id: d3, method: "lexical" })]);
    expect(queryDecisions(a, {}).find((d) => d.node_id === d3)!.lesson_node_id).toBe(skillId);
    const st = computeBrainStatus(getDb(a), cfg);
    expect(st.decisions.lessonsMerged).toBe(1);
    expect(formatBrainStatus(st)).toMatch(/1 merged into existing skills/);
  });

  it("merges into an existing hand-written skill too; embeddings win over lexical when present", () => {
    const a = fresh();
    const skill = writeNode(a, "skill", "Transactional email", "Prefer API-first providers for transactional email (Resend, Postmark).", { deduplicate: false, sourceType: "user" });
    const d = recordDecision(a, { context: "receipts", chosen: "Resend" }).id!;
    updateDecisionOutcome(a, d, { outcome: "ok", status: "matched", lesson: "API-first providers are best for transactional email" });
    // embedding says "not the same" → no merge even though the words overlap; and not promoted (no recurrence)
    const far = new Map([[`d:${d}`, new Float32Array([1, 0, 0])], [`s:${skill}`, new Float32Array([0, 1, 0])]]);
    expect(runDecisionPass(a, promo, log, Date.now(), { vectors: far })).toMatchObject({ lessonsMerged: 0, promoted: 0 });
    // embedding says "same" → merge, method embedding, user provenance kept
    const near = new Map([[`d:${d}`, new Float32Array([1, 0.1, 0])], [`s:${skill}`, new Float32Array([1, 0.12, 0])]]);
    expect(runDecisionPass(a, promo, log, Date.now(), { vectors: near })).toMatchObject({ lessonsMerged: 1, mergedInto: [skill] });
    expect(getNode(a, skill)).toMatchObject({ source_type: "user", label: "Transactional email" });
    expect((getDb(a).prepare("SELECT method FROM lesson_merges").get() as { method: string }).method).toBe("embedding");
  });
});

describe("3. decision drafts expire (soft) + tighter extraction", () => {
  it("unconfirmed, outcome-less, unlinked drafts expire after decisionDraftTtlDays; others survive; nothing deleted", async () => {
    const a = fresh();
    const old = Date.now() - 20 * DAY;
    const [stale] = autoExtractDecisions(a, "I'll go with Caddy over nginx because the config is shorter.", cfg, { now: old });
    const [conf] = autoExtractDecisions(a, "I'll go with Vercel over Netlify because previews are faster.", cfg, { now: old });
    const [outc] = autoExtractDecisions(a, "I'll go with grammY over Telegraf because the types are better.", cfg, { now: old });
    const [linked] = autoExtractDecisions(a, "I decided to use Postgres because we have three writers.", cfg, { now: old });
    const [young] = autoExtractDecisions(a, "I'll go with pnpm over npm because installs are faster.", cfg);
    const g = setGoal(a, { title: "Ship the docs site", priority: 2 }).goal!;
    expect((await dispatchBrainTool("brain_update_decision_outcome", a, { decision_id: conf!, confirm: true }, cfg)).text).toMatch(/Decision confirmed/);
    updateDecisionOutcome(a, outc!, { outcome: "worked", status: "matched" });
    expect(confirmDecision(a, linked!, { goalId: g.lineage_id }).linkedGoal).toBe("Ship the docs site");
    getDb(a).prepare("UPDATE decisions SET confirmed_at = NULL, draft_status = 'pending' WHERE node_id = ?").run(linked); // only the goal link keeps it
    expect(formatBrainStatus(computeBrainStatus(getDb(a), cfg))).toMatch(/decision drafts: 3 pending/);
    const r = runDecisionPass(a, cfg, log);
    expect(r.draftsExpired).toBe(1);
    expect(getNode(a, stale!)).toMatchObject({ status: "archived" });
    expect(getNode(a, stale!)!.status_reason).toMatch(/^expired: unconfirmed auto-extracted decision draft/);
    expect(getDb(a).prepare("SELECT draft_status FROM decisions WHERE node_id = ?").get(stale)).toEqual({ draft_status: "expired" });
    for (const id of [conf, outc, linked, young]) expect(getNode(a, id!)!.status, id).toBe("active");
    expect(queryDecisions(a, {}).map((d) => d.node_id)).not.toContain(stale);
    const st = formatBrainStatus(computeBrainStatus(getDb(a), cfg));
    expect(st).toMatch(/decision drafts: 2 pending \(auto-extracted, unconfirmed\), 1 expired/);
    expect(expireDecisionDrafts(a, cfg)).toEqual([]); // idempotent
    expect(expireDecisionDrafts(a, { ...cfg, decisionDraftTtlDays: 0 })).toEqual([]);
    // confirming an expired draft is refused; the row is still there (soft)
    expect(confirmDecision(a, stale!).ok).toBe(false);
    // sleep sweeps + records it
    const b = fresh();
    autoExtractDecisions(b, "I'll go with Caddy over nginx because it's shorter.", cfg, { now: old });
    await runConsolidation(b, cfg, log);
    expect(getSleepSummary(b)).toMatchObject({ draftsExpired: 1 });
  });

  it("negative extraction cases: conditionals, hypotheticals, quoted / reported speech, hedges", () => {
    for (const no of [
      "I'd go with Postgres if we had more writers.",
      "I'll go with Resend over Mailchimp if the pricing holds.",
      "If the build passes, I'll go with the blue theme over the red one because it reads better.",
      'She said "I\'ll go with Resend over Mailchimp because it is cheaper."',
      "“I'll go with Caddy over nginx because it's simpler,” he wrote.",
      "Hailey suggested we'll go with Vercel over Netlify because of previews.",
      "Hypothetically, I'll go with SQLite because it's one file.",
      "Suppose I decided to use Kafka because of scale.",
      "Maybe we'll go with Bun over Node because it's faster.",
      "We could go with Redis over Memcached because it persists.",
      "I'm not going to go with MongoDB because we need joins.",
      "Unless something breaks, I'll go with the old router over the new one because it's stable.",
      "Should we go with Fly over Render because of regions?",
    ]) expect(extractDecisionCandidates(no), no).toEqual([]);
    // positives still work
    expect(extractDecisionCandidates("I'll go with Caddy over nginx because the config is a third of the size.")[0]).toMatchObject({ chosen: "Caddy", over: ["nginx"] });
    expect(extractDecisionCandidates("Going with the blue theme instead of the red one.")[0]).toMatchObject({ chosen: "blue theme" });
    expect(extractDecisionCandidates("Done. I decided to use SQLite because we only have one writer.")[0]).toMatchObject({ chosen: "SQLite" });
    expect(extractDecisionCandidates("Honestly going with X is fine.")).toEqual([]); // bare "going with" only at sentence start
  });
});

describe("4. the alignment note is consumed only by a real reply", () => {
  function drifting() {
    const a = fresh();
    const now = Date.now();
    setGoal(a, { title: "Ship the billing migration", priority: 1, successCriteria: "invoices generated by the new system", now: now - 12 * DAY });
    runDriftPass(a, cfg, log, now);
    return { a, now };
  }

  it("offer → still pending (tool-only turn) → ack (real reply) → gone; status shows pending", () => {
    const { a, now } = drifting();
    expect(formatBrainStatus(computeBrainStatus(getDb(a), cfg))).toMatch(/alignment note pending \(not yet delivered/);
    const t1 = buildGoalTurnContext(a, "CALL brain_status {}", cfg, now + 1);
    expect(t1.noteId).not.toBeNull();
    // tool-only turn: no ack → still pending, offered 1×
    expect(formatBrainStatus(computeBrainStatus(getDb(a), cfg))).toMatch(/alignment note pending \(offered 1×, not yet delivered/);
    const t2 = buildGoalTurnContext(a, "Good morning", cfg, now + 2);
    expect(t2.noteId).toBe(t1.noteId);
    expect(t2.text).toMatch(/Alignment: no progress/);
    expect(ackAlignmentNote(a, t2.noteId!, now + 3)).toBe(true);
    expect(ackAlignmentNote(a, t2.noteId!, now + 4)).toBe(false); // once
    expect(buildGoalTurnContext(a, "and then?", cfg, now + 5).text).toBe("");
    expect(formatBrainStatus(computeBrainStatus(getDb(a), cfg))).not.toMatch(/alignment note pending/);
  });

  it(`a host that never acks stops seeing it after ${ALIGNMENT_NOTE_MAX_OFFERS} offers`, () => {
    const { a, now } = drifting();
    for (let i = 0; i < ALIGNMENT_NOTE_MAX_OFFERS; i++) expect(buildGoalTurnContext(a, "x", cfg, now + i).noteId).not.toBeNull();
    expect(buildGoalTurnContext(a, "x", cfg, now + 100).text).toBe("");
  });
});
