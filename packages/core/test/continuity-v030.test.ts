/**
 * Xanima 0.3.0 (schema v22): reflection, experience replay, hypotheses /
 * questions / assumptions, commitments + plans, meta-tools.
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { getDb, closeDb, SCHEMA_VERSION } from "../src/db.js";
import { writeNode } from "../src/nodes.js";
import { writeEdge } from "../src/edges.js";
import { appendEpisode } from "../src/episodes.js";
import { runConsolidation } from "../src/consolidation.js";
import { dispatchBrainTool, BRAIN_TOOL_DEFS } from "../src/tools.js";
import { computeBrainStatus, formatBrainStatus, getSleepSummary } from "../src/beliefs.js";
import { recordDecision, updateDecisionOutcome } from "../src/decisions.js";
import { setGoal, buildGoalTurnContext, ackAlignmentNote } from "../src/goals.js";
import { reflect, runReflectionPass, draftReflection } from "../src/reflection.js";
import { createOpenItem, updateOpenItem, extractOpenItemCandidates, autoExtractOpenItems, expireOpenItemDrafts, listOpenItems, surfaceOpenItem } from "../src/open-items.js";
import { createCommitment, updateCommitment, runCommitmentCheck, createPlan, updatePlan, getPlan, listCommitments } from "../src/plans.js";
import { replay, changesSince, conflicts, briefing, forgetImpact } from "../src/meta-tools.js";
import { CONTINUITY_TOOL_NAMES, CONTINUITY_READ_ONLY_TOOLS } from "../src/continuity-tools.js";
import { parseWhen } from "../src/continuity-util.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const log = { info: () => {}, warn: () => {}, error: () => {} };
const DAY = 86_400_000;
const opened: string[] = [];
function fresh(prefix = "v030"): string { const id = `${prefix}-${randomUUID().slice(0, 8)}`; opened.push(id); return id; }
afterEach(() => { for (const id of opened.splice(0)) closeDb(id); });
const cfg = { ...DEFAULT_CONFIG };
const reflOn = { ...cfg, reflection: "sleep" as const };

function decided(a: string, now: number) {
  const g = setGoal(a, { title: "Ship the Gano Telegram bot", priority: 1, successCriteria: "Gano answers messages", now: now - 9 * DAY }).goal!;
  const mk = (context: string, chosen: string, status: "matched" | "missed" | "partial", outcome: string, lesson?: string, conf = 0.6, ago = 3) => {
    const r = recordDecision(a, { context, chosen, options: [chosen, "something else"], confidence: conf, goalId: g.lineage_id, now: now - (ago + 1) * DAY });
    updateDecisionOutcome(a, r.id!, { outcome, status, ...(lesson ? { lesson } : {}), now: now - ago * DAY });
    return r.id!;
  };
  const good = mk("Webhook vs polling for the Telegram bot", "webhooks", "matched", "messages arrive instantly", "webhooks beat polling for chat bots");
  const bad1 = mk("Hosting for the Telegram bot", "free tier dyno", "missed", "dyno sleeps and drops messages", "free tiers sleep; use an always-on host", 0.85, 2);
  const bad2 = mk("Hosting for the Telegram bot again", "free tier dyno", "missed", "dropped messages overnight", undefined, 0.7, 1);
  return { g, good, bad1, bad2 };
}

describe("schema v22 (additive)", () => {
  it("creates the 0.3.0 tables and keeps the note queue compatible", () => {
    const a = fresh();
    const db = getDb(a);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(22);
    for (const t of ["reflections", "open_items", "commitments", "plans", "plan_steps", "dependencies"]) expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t), t).toBeTruthy();
    const cols = (db.prepare("PRAGMA table_info(alignment_notes)").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["kind", "ref_id", "offered_count"]));
  });
  it("parseWhen handles future and past phrases", () => {
    const now = 1_800_000_000_000;
    expect(parseWhen("in 3 days", now)).toBe(now + 3 * DAY);
    expect(parseWhen("2 days ago", now)).toBe(now - 2 * DAY);
    expect(parseWhen("tomorrow", now)).toBe(now + DAY);
    expect(parseWhen(now - 5, now)).toBe(now - 5);
    expect(parseWhen("nonsense", now)).toBeNull();
  });
});

describe("1. reflection", () => {
  it("is off by default in sleep; on with reflection: sleep it writes worked / didn't / try next linked to sources", async () => {
    const a = fresh();
    const now = Date.now();
    const { good, bad1 } = decided(a, now);
    expect((await runReflectionPass(a, cfg, log, now)).written).toBe(0);
    const r = await runReflectionPass(a, reflOn, log, now);
    expect(r.written).toBeGreaterThanOrEqual(1);
    const db = getDb(a);
    const row = db.prepare("SELECT * FROM reflections WHERE scope_kind = 'window'").get() as Record<string, string>;
    const worked = JSON.parse(row["worked_json"]!) as string[], didnt = JSON.parse(row["didnt_json"]!) as string[], next = JSON.parse(row["next_json"]!) as string[];
    expect(worked.join(" ")).toMatch(/webhooks/);
    expect(didnt.join(" ")).toMatch(/repeated failure \(2×\).*free tier dyno/);
    expect(didnt.join(" ")).toMatch(/expected it with high confidence/);
    expect(next.join(" ")).toMatch(/change approach|always-on host/);
    const edges = (db.prepare("SELECT to_id FROM edges WHERE from_id = ? AND type = 'reflects_on'").all(row["node_id"]) as Array<{ to_id: string }>).map((e) => e.to_id);
    expect(edges).toEqual(expect.arrayContaining([good, bad1]));
    // goal-scoped reflection too, linked to the goal
    expect(db.prepare("SELECT COUNT(*) n FROM reflections WHERE scope_kind = 'goal'").get()).toEqual({ n: 1 });
  });

  it("a sleep run writes the summary; a near-duplicate reflection merges instead of piling up", async () => {
    const a = fresh();
    const now = Date.now();
    decided(a, now);
    await runConsolidation(a, reflOn as never, log as never);
    expect(getSleepSummary(a)?.reflectionsWritten).toBeGreaterThanOrEqual(1);
    const r1 = reflect(a, { since: now - 8 * DAY, now }, cfg);
    expect(r1.ok && r1.merged).toBe(true);
    const n = getDb(a).prepare("SELECT merge_count, history_json FROM reflections WHERE node_id = ?").get(r1.id) as { merge_count: number; history_json: string };
    expect(n.merge_count).toBe(2);
    expect(JSON.parse(n.history_json)[0]).toMatchObject({ method: "lexical" });
    expect(getDb(a).prepare("SELECT COUNT(*) n FROM reflections WHERE scope_kind = 'window'").get()).toEqual({ n: 1 });
  });

  it("brain_reflect on demand (topic / goal / window), stored and injectable; nothing to reflect stores nothing", async () => {
    const a = fresh();
    const now = Date.now();
    const { g } = decided(a, now);
    const t = await dispatchBrainTool("brain_reflect", a, { goal_id: g.lineage_id.slice(0, 8) }, cfg);
    expect(t.isError).toBeFalsy();
    expect(t.text).toMatch(/What worked:[\s\S]*webhooks[\s\S]*What didn't:[\s\S]*Try next:/);
    const topic = await dispatchBrainTool("brain_reflect", a, { topic: "hosting dyno" }, cfg);
    expect(topic.text).toMatch(/free tier dyno/);
    expect(topic.text).not.toMatch(/webhooks/);
    const empty = fresh();
    const e = await dispatchBrainTool("brain_reflect", empty, { since: "3 days ago" }, cfg);
    expect(e.text).toMatch(/Nothing to reflect on/);
    expect(getDb(empty).prepare("SELECT COUNT(*) n FROM reflections").get()).toEqual({ n: 0 });
    // injectable later: it is a node recall can find, and the goal briefing carries it
    const b = briefing(a, { goalId: g.lineage_id }, cfg, now);
    expect(b.text).toMatch(/Last reflection/);
    expect(getDb(a).prepare("SELECT COUNT(*) n FROM nodes WHERE type = 'reflection' AND status = 'active'").get()).toEqual({ n: 2 });
  });

  it("reflection drafts include refuted hypotheses, contradicted load-bearing assumptions and slipped commitments", () => {
    const a = fresh();
    const now = Date.now();
    const h = createOpenItem(a, { kind: "assumption", text: "the Telegram API rate limit is generous", loadBearing: true, now: now - 2 * DAY }).id!;
    updateOpenItem(a, h, { action: "refute", evidence: "429s after 30 msgs/sec", now: now - DAY });
    createCommitment(a, { title: "send Hailey the bot demo", due: now - DAY, now: now - 3 * DAY });
    const d = draftReflection(a, { now }, cfg);
    if ("error" in d) throw new Error(d.error);
    expect(d.didnt.join(" ")).toMatch(/assumption contradicted: the Telegram API rate limit/);
    expect(d.didnt.join(" ")).toMatch(/commitment slipped: send Hailey/);
    expect(d.next.join(" ")).toMatch(/re-check what rests on/);
  });
});

describe("2. experience replay", () => {
  it("returns compressed episode → decision → outcome → lesson chains for a goal, capped", () => {
    const a = fresh();
    const now = Date.now();
    const { g, bad1 } = decided(a, now);
    const ep = appendEpisode(a, "s", "user", "The bot keeps missing messages at night, can you look?", 0.5);
    getDb(a).prepare("UPDATE nodes SET evidence = ? WHERE id = ?").run(JSON.stringify([ep]), bad1);
    const r = replay(a, { goalId: g.lineage_id, k: 2 }, cfg, now);
    expect(r.count).toBe(2);
    expect(r.text).toMatch(/Replay for goal "Ship the Gano Telegram bot" — 2 trajectories/);
    expect(r.text).toMatch(/⇒ .*→ (MATCHED|MISSED)/);
    const withEp = replay(a, { query: "hosting dyno", k: 5 }, cfg, now);
    expect(withEp.text).toMatch(/asked: "The bot keeps missing messages/);
    expect(withEp.text).toMatch(/lesson: free tiers sleep/);
    const tiny = replay(a, { goalId: g.lineage_id, k: 10 }, { ...cfg, replayMaxChars: 400 }, now);
    expect(tiny.text!.length).toBeLessThanOrEqual(400);
    expect(replay(a, {}, cfg).ok).toBe(false);
  });
});

describe("3. hypotheses, questions, assumptions", () => {
  it("capture a hypothesis, then refute it with evidence; conflicts lists it", async () => {
    const a = fresh();
    const r = await dispatchBrainTool("brain_hypothesis", a, { action: "create", statement: "message drops come from the dyno sleeping", evidence: "drops only happen overnight", confidence: "medium" }, cfg);
    expect(r.isError).toBeFalsy();
    const id = /hypothesis ([0-9a-f-]{36})/.exec(r.text)![1]!;
    const ref = await dispatchBrainTool("brain_hypothesis", a, { action: "refute", id: id.slice(0, 8), evidence: "drops continued on the always-on host" }, cfg);
    expect(ref.text).toMatch(/refuted/);
    const db = getDb(a);
    expect(db.prepare("SELECT status FROM open_items WHERE node_id = ?").get(id)).toEqual({ status: "refuted" });
    expect((db.prepare("SELECT confidence_score FROM nodes WHERE id = ?").get(id) as { confidence_score: number }).confidence_score).toBeLessThan(0.2);
    expect(conflicts(a, "message drops dyno", cfg).text).toMatch(/Refuted hypotheses:[\s\S]*dyno sleeping/);
    expect((await dispatchBrainTool("brain_hypothesis", a, { action: "refute", id }, cfg)).isError).toBe(true); // refute needs evidence
  });

  it("a load-bearing assumption that gets contradicted shows in brain_status", async () => {
    const a = fresh();
    const c = await dispatchBrainTool("brain_hypothesis", a, { action: "create", kind: "assumption", statement: "Hailey's PC stays online overnight", load_bearing: true }, cfg);
    const id = /assumption ([0-9a-f-]{36})/.exec(c.text)![1]!;
    await dispatchBrainTool("brain_hypothesis", a, { action: "evidence", id, evidence_against: ["PC slept at 2am", "gateway offline 01:00-07:00"] }, cfg);
    const s = computeBrainStatus(getDb(a), cfg);
    expect(s.open.contradictedAssumptions[0]?.text).toMatch(/stays online overnight/);
    expect(s.attention.join(" ")).toMatch(/load-bearing assumption CONTRADICTED/);
    expect(formatBrainStatus(s)).toMatch(/CONTRADICTED load-bearing assumption/);
  });

  it("an open question surfaces when the turn is about it (cooldown), answers close it", async () => {
    const a = fresh();
    const now = Date.now();
    const q = await dispatchBrainTool("brain_question", a, { action: "ask", question: "Which Telegram rate limit applies to group chats?" }, cfg);
    const id = /question ([0-9a-f-]{36})/.exec(q.text)![1]!;
    expect(buildGoalTurnContext(a, "what's for lunch", cfg, now).text).toBe("");
    expect(buildGoalTurnContext(a, "what do you remember about Telegram?", cfg, now).text).toBe(""); // one shared word is not "about" it
    const t = buildGoalTurnContext(a, "Let's add the bot to the group chats today", cfg, now + 1);
    expect(t.text).toMatch(/Open question \(asked .*\): Which Telegram rate limit applies to group chats/);
    expect(t.openItemId).toBe(id);
    expect(buildGoalTurnContext(a, "group chats again", cfg, now + 2).text).toBe(""); // 6 h cooldown
    expect(surfaceOpenItem(a, "group chats rate limit", { ...cfg, openItemSurfacing: false }, now + 7 * 3600_000)).toBeNull();
    expect(computeBrainStatus(getDb(a), cfg).open.hotQuestions[0]?.id).toBe(id);
    await dispatchBrainTool("brain_question", a, { action: "answer", id, answer: "20 messages per minute per group" }, cfg);
    expect(listOpenItems(a, { kind: "question" })).toHaveLength(0);
    expect(listOpenItems(a, { kind: "question", status: "closed" })[0]?.answer).toMatch(/20 messages/);
  });

  it("heuristic capture: positives and the decision-draft false-positive guards", () => {
    expect(extractOpenItemCandidates("I think the drops come from the dyno sleeping because they only happen at night.")).toEqual([
      expect.objectContaining({ kind: "hypothesis", text: "the drops come from the dyno sleeping", because: "they only happen at night" })]);
    expect(extractOpenItemCandidates("Open question: does Telegram retry webhooks after a 500?")[0]).toMatchObject({ kind: "question", text: "does Telegram retry webhooks after a 500?" });
    expect(extractOpenItemCandidates("I'm assuming the token in the vault is current.")[0]).toMatchObject({ kind: "assumption", text: "the token in the vault is current" });
    expect(extractOpenItemCandidates("Assuming the gateway restarts cleanly, the bot will be live.")[0]).toMatchObject({ kind: "assumption", text: "the gateway restarts cleanly" });
    for (const neg of [
      "I think it works.", // no because
      "If it fails, I think it's the dyno because of the timing.", // conditional
      "Hailey said \"I think the dyno is fine because it restarted\".", // quoted
      "She told me she thinks it's the dyno because of logs, and I think so too because she said so.", // reported
      "Do you think it's the dyno because of the timing?", // question
      "I don't think it's the dyno because it's always on.", // negation
      "Hypothetically, assuming we had money, we'd buy a server.",
      "```\n// I think this is fine because tests pass\n```",
    ]) expect(extractOpenItemCandidates(neg), neg).toEqual([]);
  });

  it("captured drafts expire (soft) after openItemDraftTtlDays unless touched or linked", () => {
    const a = fresh();
    const now = Date.now();
    const [stale] = autoExtractOpenItems(a, "I think the cache is cold because restarts wipe it.", cfg, { now: now - 20 * DAY });
    const [kept] = autoExtractOpenItems(a, "Open question: should the bot answer in threads?", cfg, { now: now - 20 * DAY });
    updateOpenItem(a, kept!, { action: "confirm", now: now - 19 * DAY });
    const [fresh1] = autoExtractOpenItems(a, "I'm assuming the bot token is valid.", cfg, { now: now - DAY });
    expect(autoExtractOpenItems(a, "I'm assuming the bot token is valid.", cfg, { now: now - DAY + 1 })).toEqual([]); // same draft within 7 d → deduped
    const gone = expireOpenItemDrafts(a, cfg, now);
    expect(gone).toContain(stale);
    expect(gone).not.toContain(kept);
    expect(gone).not.toContain(fresh1);
    const db = getDb(a);
    expect(db.prepare("SELECT draft_status, status FROM open_items WHERE node_id = ?").get(stale)).toEqual({ draft_status: "expired", status: "closed" });
    expect(db.prepare("SELECT status FROM nodes WHERE id = ?").get(stale)).toEqual({ status: "archived" });
    expect(computeBrainStatus(db, cfg).open.draftsExpired).toBe(1);
    expect(autoExtractOpenItems(a, "I think X is Y because Z is W.", { ...cfg, openItemCapture: false })).toEqual([]);
  });
});

describe("4. commitments and plans", () => {
  it("an overdue commitment gets a nudge offered each turn and consumed only by an ack; status shows it", () => {
    const a = fresh();
    const now = Date.now();
    const c = createCommitment(a, { title: "send Hailey the sandbox report", to: "user", due: "in 2 days", now: now - 3 * DAY }).commitment!;
    expect(c.overdue).toBe(true);
    const t1 = buildGoalTurnContext(a, "CALL brain_status {}", cfg, now);
    expect(t1.text).toMatch(/Commitment overdue: "send Hailey the sandbox report" \(to user, due yesterday\)/);
    expect(t1.noteIds).toHaveLength(1);
    // tool-only turn: no ack → still pending
    expect(computeBrainStatus(getDb(a), cfg, now).commitments.pendingNudge).toMatch(/overdue/);
    const t2 = buildGoalTurnContext(a, "good morning", cfg, now + 1);
    expect(t2.noteIds).toEqual(t1.noteIds);
    expect(ackAlignmentNote(a, t2.noteIds[0]!, now + 2)).toBe(true);
    expect(buildGoalTurnContext(a, "and now?", cfg, now + 3).text).toBe("");
    // no second nudge within 24 h; status still lists it as overdue
    expect(runCommitmentCheck(a, cfg, now + 3600_000).nudged).toBeNull();
    const s = computeBrainStatus(getDb(a), cfg, now);
    expect(s.commitments.overdue[0]?.title).toMatch(/sandbox report/);
    expect(formatBrainStatus(s)).toMatch(/OVERDUE .*sandbox report/);
    // done → archived, no more nudges
    updateCommitment(a, c.node_id, { action: "done", now: now + 10 });
    expect(listCommitments(a)).toHaveLength(0);
    expect(runCommitmentCheck(a, cfg, now + 2 * DAY).overdue).toBe(0);
    expect(buildGoalTurnContext(a, "x", { ...cfg, commitmentNudges: false }, now).text).toBe("");
  });

  it("blocking dependencies: blocked until the blocker resolves; cycles rejected", () => {
    const a = fresh();
    const now = Date.now();
    const dec = recordDecision(a, { context: "pick the bot host", chosen: "fly.io", now }).id!;
    const c = createCommitment(a, { title: "deploy the bot", to: "self", blockedBy: [dec.slice(0, 8)], now }).commitment!;
    expect(c.blocked).toBe(true);
    expect(runCommitmentCheck(a, cfg, now).nudged).toBe(c.node_id);
    expect(computeBrainStatus(getDb(a), cfg, now).commitments.blocked[0]?.waiting).toMatch(/fly\.io|bot host/);
    const c2 = createCommitment(a, { title: "announce the bot", blockedBy: [c.node_id], now }).commitment!;
    expect(updateCommitment(a, c.node_id, { action: "block", blockedBy: [c2.node_id] }).error).toMatch(/cycle/);
    updateDecisionOutcome(a, dec, { outcome: "deployed fine", status: "matched", now: now + 1 });
    expect(listCommitments(a, { status: "blocked" }).map((x) => x.node_id)).toEqual([c2.node_id]);
  });

  it("park a plan, days pass, resume → briefing with what's open and what changed (golden shape)", async () => {
    const a = fresh();
    const now = Date.now();
    const g = setGoal(a, { title: "Ship the Gano Telegram bot", priority: 1, now: now - 10 * DAY }).goal!;
    const p = createPlan(a, { title: "Gano Telegram bot rollout", goalId: g.lineage_id, steps: ["get the bot token", "wire the webhook", "test in a group chat"], now: now - 6 * DAY }).plan!;
    updatePlan(a, p.node_id, { action: "step", step: 1, status: "done", now: now - 6 * DAY });
    updatePlan(a, p.node_id, { action: "park", note: "waiting on Hailey for the group invite", now: now - 5 * DAY });
    // while parked
    const d = recordDecision(a, { context: "Webhook host for the Gano Telegram bot", chosen: "fly.io", goalId: g.lineage_id, now: now - 3 * DAY }).id!;
    updateDecisionOutcome(a, d, { outcome: "webhook live", status: "matched", now: now - 2 * DAY });
    createOpenItem(a, { kind: "question", text: "Does the group chat allow bots?", links: [p.node_id], now: now - DAY });
    const r = await dispatchBrainTool("brain_plan", a, { action: "resume", plan_id: p.node_id.slice(0, 8) }, { ...cfg });
    expect(r.isError).toBeFalsy();
    const lines = r.text.split("\n").map((l) => l.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<id>").replace(/\d+ (days|min|h) ago|yesterday|just now/g, "<t>"));
    expect(lines[0]).toBe("Plan resumed (parked <t>).");
    expect(lines[1]).toBe('Briefing — <id> Plan [active] Gano Telegram bot rollout  (goal: Ship the Gano Telegram bot)  (created <t>)');
    expect(lines).toContain("  [x] 1. get the bot token");
    expect(lines).toContain("  [ ] 2. wire the webhook");
    expect(lines).toContain("Still open: 2 of 3 steps; next: 2. wire the webhook");
    expect(r.text).toMatch(/Recent decisions: fly\.io \(matched\)/);
    expect(r.text).toMatch(/Open: question "Does the group chat allow bots\?"/);
    expect(r.text).toMatch(/Changed since .* \(since parked\):[\s\S]*outcome: matched: fly\.io → webhook live[\s\S]*decision: chose fly\.io/);
    expect(getPlan(a, p.node_id)!.status).toBe("active");
    expect((await dispatchBrainTool("brain_plan", a, { action: "resume", plan_id: p.node_id }, cfg)).isError).toBe(true);
    expect(computeBrainStatus(getDb(a), cfg).commitments.plansActive).toBe(1);
  });
});

describe("5. meta-tools", () => {
  it("brain_changes / brain_conflicts / brain_briefing are fast and capped", async () => {
    const a = fresh();
    const now = Date.now();
    const { g } = decided(a, now);
    for (let i = 0; i < 60; i++) writeNode(a, "semantic", `Telegram bot fact ${i}`, `The Telegram bot detail number ${i} about webhooks and hosting`, { deduplicate: false });
    const x = writeNode(a, "semantic", "Telegram bot uses long polling", "Telegram bot uses long polling", { deduplicate: false, confidence: 0.2 });
    const y = writeNode(a, "semantic", "Telegram bot uses webhooks", "Telegram bot uses webhooks", { deduplicate: false });
    writeEdge(a, x, y, "contradicts");
    const t0 = performance.now();
    const ch = await dispatchBrainTool("brain_changes", a, { goal_id: g.lineage_id, days: 7 }, cfg);
    expect(ch.text).toMatch(/Changes about goal "Ship the Gano Telegram bot".*newest first/);
    expect(ch.text).toMatch(/outcome: missed: free tier dyno/);
    const topic = await dispatchBrainTool("brain_changes", a, { topic: "Telegram bot", days: 1 }, { ...cfg, metaToolMaxChars: 600 });
    expect(topic.text.length).toBeLessThanOrEqual(600);
    expect(topic.text).toMatch(/more lines?; narrow the query/);
    const cf = await dispatchBrainTool("brain_conflicts", a, { topic: "Telegram bot polling webhooks" }, cfg);
    expect(cf.text).toMatch(/Contradictions:[\s\S]*long polling[\s\S]*Low-confidence/);
    const br = await dispatchBrainTool("brain_briefing", a, { topic: "Telegram bot" }, cfg);
    expect(br.text).toMatch(/^Briefing — "Telegram bot"/);
    expect(performance.now() - t0).toBeLessThan(1500);
    expect((await dispatchBrainTool("brain_changes", a, {}, cfg)).isError).toBe(true);
    expect(changesSince(a, { topic: "nothing-matches-zzz", since: now - DAY }).changes).toEqual([]);
  });

  it("brain_forget_impact is a read-only dry run", async () => {
    const a = fresh();
    const now = Date.now();
    decided(a, now);
    const cluster = writeNode(a, "schema", "Bot hosting cluster", "Bot hosting knowledge", { deduplicate: false });
    for (let i = 0; i < 5; i++) { const n = writeNode(a, "semantic", `hosting fact ${i} zebra${i}`, `hosting fact ${i} zebra${i}`, { deduplicate: false }); writeEdge(a, n, cluster, "instance_of"); }
    const db = getDb(a);
    const snap = () => createHash("sha256").update(JSON.stringify([db.prepare("SELECT * FROM nodes ORDER BY id").all(), db.prepare("SELECT * FROM edges ORDER BY id").all(), db.prepare("SELECT * FROM meta_kv ORDER BY key").all()])).digest("hex");
    const before = snap();
    const changes0 = (db.prepare("SELECT total_changes() n").get() as { n: number }).n;
    const r = await dispatchBrainTool("brain_forget_impact", a, { cluster: cluster.slice(0, 8) }, cfg);
    expect(r.text).toMatch(/dry run — nothing changed\): 6 active nodes \(schema 1, semantic 5\)/);
    expect(r.text).toMatch(/would lose 5 unique facts/);
    expect(r.text).toMatch(/NOT safe to forget wholesale/);
    const q = forgetImpact(a, { query: "free tier dyno" }, cfg, now);
    expect(q.summary!["protected"]).toBeGreaterThan(0);
    expect(snap()).toBe(before);
    expect((db.prepare("SELECT total_changes() n").get() as { n: number }).n).toBe(changes0);
  });
});

describe("6. tool surface", () => {
  it("all 0.3.0 tools are registered with schemas; read-only ones are marked", () => {
    const tools = ["brain_reflect", "brain_replay", "brain_hypothesis", "brain_question", "brain_list_open", "brain_commit", "brain_commitments", "brain_plan", "brain_changes", "brain_conflicts", "brain_briefing", "brain_forget_impact"];
    for (const t of tools) { expect(CONTINUITY_TOOL_NAMES, t).toContain(t); expect((BRAIN_TOOL_DEFS as Record<string, unknown>)[t], t).toBeTruthy(); }
    for (const t of ["brain_replay", "brain_list_open", "brain_commitments", "brain_changes", "brain_conflicts", "brain_briefing", "brain_forget_impact"]) expect(CONTINUITY_READ_ONLY_TOOLS).toContain(t);
    for (const t of ["brain_reflect", "brain_hypothesis", "brain_commit", "brain_plan"]) expect(CONTINUITY_READ_ONLY_TOOLS).not.toContain(t);
  });

  it("brain_reflect with no arguments keeps the self-model view", async () => {
    const a = fresh();
    getDb(a).prepare("INSERT OR REPLACE INTO self_model (id, identity, goals, user_model, created_at, updated_at) VALUES ('singleton', 'I am a test agent', '[]', '{}', ?, ?)").run(Date.now(), Date.now());
    const r = await dispatchBrainTool("brain_reflect", a, {}, cfg);
    expect(r.text).toMatch(/^Identity: I am a test agent/);
    expect(r.text).toMatch(/Nothing to reflect on/);
  });
});

describe("v0.3.0 sandbox findings", () => {
  it("brain_query can filter by the structured types (reflection, hypothesis, plan…)", async () => {
    const { validateBrainQuery } = await import("../src/validation.js");
    for (const t of ["reflection", "hypothesis", "question", "assumption", "commitment", "plan", "decision"]) expect(validateBrainQuery({ query: "x", type: t }).ok).toBe(true);
    expect(JSON.stringify(validateBrainQuery({ query: "x", type: "bogus" }))).toMatch(/type must be one of/);
  });

  it("plan resume keeps the decision made while parked even when topic-matched node churn is newer", () => {
    const a = fresh(); const now = Date.now();
    const g = setGoal(a, { title: "Launch the newsletter", priority: 1, now: now - 10 * DAY }).goal!;
    const p = createPlan(a, { title: "Newsletter issue 2", goalId: g.lineage_id, steps: ["draft", "send"], now: now - 5 * DAY }).plan!;
    recordDecision(a, { context: "Send slot for newsletter issue 2", chosen: "Tuesday 9am", goalId: g.lineage_id, now: now - 2 * DAY });
    for (let i = 0; i < 20; i++) writeNode(a, "semantic", `Newsletter issue note ${i}`, `newsletter issue detail number ${i}`, { deduplicate: false });
    const ch = changesSince(a, { planId: p.node_id, since: now - 4 * DAY, until: now + 1000 }, 12);
    expect(ch.changes.length).toBeLessThanOrEqual(12);
    expect(ch.changes.some((c) => c.kind === "decision" && /Tuesday 9am/.test(c.text))).toBe(true);
    expect(ch.changes.some((c) => c.kind.startsWith("updated "))).toBe(false);
  });

  it("a captured question that has surfaced counts as hot in brain_status", () => {
    const a = fresh(); const now = Date.now();
    autoExtractOpenItems(a, "Open question: does Gmail clip newsletters over 102KB?", cfg, { now });
    expect(formatBrainStatus(computeBrainStatus(getDb(a), cfg))).not.toMatch(/HOT QUESTION/);
    expect(surfaceOpenItem(a, "will Gmail clip the newsletter at 120KB?", cfg, now + 1000)?.line).toMatch(/Open question/);
    expect(formatBrainStatus(computeBrainStatus(getDb(a), cfg))).toMatch(/HOT QUESTION [0-9a-f]{8}: does Gmail clip newsletters/);
  });

  it("a repeated failure still counts after sleep merged the near-duplicate decisions", () => {
    const a = fresh(); const now = Date.now();
    const { bad1, bad2 } = decided(a, now);
    getDb(a).prepare("UPDATE decisions SET merged_into = ? WHERE node_id = ?").run(bad1, bad2);
    const d = draftReflection(a, { now }, cfg);
    expect("error" in d).toBe(false);
    expect(JSON.stringify(d)).toMatch(/repeated failure \(2×\): free tier dyno/);
  });
});
