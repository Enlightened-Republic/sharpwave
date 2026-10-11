/**
 * Xanima 0.2.0 (schema v20): decision ledger, versioned goals, drift pass,
 * alignment note, goal triggers, decision recall boost, sleep decision pass.
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { getDb, closeDb, SCHEMA_VERSION } from "../src/db.js";
import { writeNode, getNode, getActiveGoals, ftsSearchNodes } from "../src/nodes.js";
import { appendEpisode } from "../src/episodes.js";
import { hybridRetrieve } from "../src/retrieval.js";
import { runConsolidation } from "../src/consolidation.js";
import { dispatchBrainTool, MCP_TOOL_NAMES } from "../src/tools.js";
import { computeBrainStatus, formatBrainStatus, getSleepSummary, queryAsOf } from "../src/beliefs.js";
import {
  recordDecision, updateDecisionOutcome, queryDecisions, extractDecisionCandidates, autoExtractDecisions, applyDecisionBoost, runDecisionPass,
} from "../src/decisions.js";
import { setGoal, updateGoal, listGoals, goalHistory, runDriftPass, buildGoalTurnContext, parsePriority } from "../src/goals.js";
import { DEFAULT_CONFIG } from "../src/types.js";
import type { ActivatedNode } from "../src/types.js";

const log = { info: () => {}, warn: () => {}, error: () => {} };
const DAY = 86_400_000;
const opened: string[] = [];
function fresh(prefix = "cont"): string {
  const id = `${prefix}-${randomUUID().slice(0, 8)}`;
  opened.push(id);
  return id;
}
afterEach(() => { for (const id of opened.splice(0)) closeDb(id); });
const sha256 = (p: string) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "absent");
const census = (d: Database.Database) => ["nodes", "edges", "episodes"].map((t) => (d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
const cfg = { ...DEFAULT_CONFIG };

describe("schema v20", () => {
  it("fresh brain has the continuity tables", () => {
    const db = getDb(fresh());
    expect(SCHEMA_VERSION).toBe(20);
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((t) => t.name);
    for (const t of ["decisions", "goals", "goal_events", "goal_triggers", "alignment_notes"]) expect(tables).toContain(t);
  });

  it("v19 → v20 is additive: counts unchanged, existing goals backfilled untracked, idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "xa-v20-"));
    const file = join(dir, "brain.db");
    try {
      const a = fresh("v19");
      process.env["XANIMA_DB_PATH"] = file;
      try { getDb(a); } finally { delete process.env["XANIMA_DB_PATH"]; }
      const g = writeNode(a, "goal", "Ship the newsletter", "Ship the Nova newsletter", { deduplicate: false });
      writeNode(a, "semantic", "fact", "some fact", { deduplicate: false });
      closeDb(a);
      const raw = new Database(file);
      raw.exec("DROP TABLE decisions; DROP TABLE goals; DROP TABLE goal_events; DROP TABLE goal_triggers; DROP TABLE alignment_notes; DELETE FROM schema_version; INSERT INTO schema_version VALUES (19);");
      const before = census(raw);
      raw.close();
      const b = fresh("v19b");
      process.env["XANIMA_DB_PATH"] = file;
      let db: Database.Database;
      try { db = getDb(b); } finally { delete process.env["XANIMA_DB_PATH"]; }
      expect(census(db)).toEqual(before);
      expect((db.prepare("SELECT version FROM schema_version").get() as { version: number }).version).toBe(20);
      expect(db.prepare("SELECT node_id, version, tracked, status, priority FROM goals").all()).toEqual([{ node_id: g, version: 1, tracked: 0, status: "active", priority: 3 }]);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      expect(getActiveGoals(b).map((n) => n.id)).toEqual([g]);
      closeDb(b);
      const c = fresh("v19c");
      process.env["XANIMA_DB_PATH"] = file;
      try { const d2 = getDb(c); expect(census(d2)).toEqual(before); expect((d2.prepare("SELECT COUNT(*) AS n FROM goals").get() as { n: number }).n).toBe(1); } finally { delete process.env["XANIMA_DB_PATH"]; }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

const SNAPSHOT = process.env["XANIMA_TEST_SNAPSHOT_DB"] ?? "/workspace/brain-snap/main/brain.db";
describe.skipIf(!existsSync(SNAPSHOT))("v20 migration on a COPY of a real brain snapshot", () => {
  it("counts unchanged, goals backfilled untracked, snapshot untouched", () => {
    const src = ["", "-wal", "-shm"].map((s) => sha256(SNAPSHOT + s));
    const dir = mkdtempSync(join(tmpdir(), "xa-snap-v20-"));
    const copy = join(dir, "brain.db");
    try {
      for (const s of ["", "-wal", "-shm"]) if (existsSync(SNAPSHOT + s)) copyFileSync(SNAPSHOT + s, copy + s);
      const pre = new Database(copy);
      const before = census(pre);
      const goalNodes = (pre.prepare("SELECT COUNT(*) AS n FROM nodes WHERE type = 'goal' AND (valid_until IS NULL OR valid_until > ?)").get(Date.now()) as { n: number }).n;
      pre.close();
      const a = fresh("snapv20");
      process.env["XANIMA_DB_PATH"] = copy;
      let db: Database.Database;
      try { db = getDb(a); } finally { delete process.env["XANIMA_DB_PATH"]; }
      expect(census(db)).toEqual(before);
      const g = db.prepare("SELECT COUNT(*) AS n, SUM(tracked) AS t FROM goals").get() as { n: number; t: number | null };
      expect(g.n).toBeLessThanOrEqual(goalNodes);
      expect(g.t ?? 0).toBe(0);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      // a sleep-free drift pass on untracked legacy goals flags nothing
      expect(runDriftPass(a, cfg).checked).toBe(0);
      // eslint-disable-next-line no-console
      console.log(`[v20-snapshot] counts=${before.join("/")} goalNodes=${goalNodes} goalsBackfilled=${g.n}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
    expect(["", "-wal", "-shm"].map((s) => sha256(SNAPSHOT + s))).toEqual(src);
  });
});

describe("decision ledger", () => {
  it("records, resolves and queries decisions with belief metadata and links", async () => {
    const a = fresh();
    const goal = setGoal(a, { title: "Launch the Nova newsletter", priority: "high", successCriteria: "first issue sent" }).goal!;
    const skill = writeNode(a, "skill", "Email deliverability", "Warm up the sending domain", { deduplicate: false });
    const r = recordDecision(a, {
      context: "Which email provider for the Nova newsletter", options: ["Resend => simple API", "Mailchimp => more templates"], chosen: "Resend",
      rationale: "API-first and cheaper", predictedOutcome: "first issue goes out without bounce problems", confidence: "high", goalId: goal.lineage_id.slice(0, 8), skillIds: [skill], evidence: ["ep-1"],
    });
    expect(r.ok, r.error).toBe(true);
    const node = getNode(a, r.id!)!;
    expect(node).toMatchObject({ type: "decision", source_type: "self_observation", confidence: "high", evidence: JSON.stringify(["ep-1"]) });
    expect(node.content).toContain("chose: Resend (over: Mailchimp)");
    const edges = getDb(a).prepare("SELECT type, to_id FROM edges WHERE from_id = ?").all(r.id) as Array<{ type: string; to_id: string }>;
    expect(edges).toEqual(expect.arrayContaining([{ type: "advances", to_id: goal.node_id }, { type: "used_in", to_id: skill }]));
    expect(queryDecisions(a, { status: "pending" }).map((d) => d.node_id)).toEqual([r.id]);
    const u = updateDecisionOutcome(a, r.id!.slice(0, 8), { outcome: "issue 1 sent, 0.2% bounces", status: "matched", lesson: "API-first providers are faster to integrate" });
    expect(u.ok).toBe(true);
    expect(u.goalProgress).toBe("Launch the Nova newsletter");
    expect(getNode(a, r.id!)!.verified_at).not.toBeNull();
    expect(queryDecisions(a, { status: "pending" })).toEqual([]);
    expect(queryDecisions(a, { query: "email provider" })[0]!.outcome_status).toBe("matched");
    expect(queryDecisions(a, { goalId: goal.lineage_id })).toHaveLength(1);
    // errors
    expect(recordDecision(a, { context: "", chosen: "x" }).ok).toBe(false);
    expect(recordDecision(a, { context: "c", chosen: "x", goalId: "nope" }).ok).toBe(false);
    expect(updateDecisionOutcome(a, r.id!, { outcome: "x", status: "great" as never }).ok).toBe(false);
  });

  it("tools: record / update outcome / query (text + json) and are in the MCP surface", async () => {
    const a = fresh();
    for (const n of ["brain_record_decision", "brain_update_decision_outcome", "brain_query_decisions", "brain_set_goal", "brain_update_goal", "brain_list_goals"]) expect(MCP_TOOL_NAMES).toContain(n);
    const rec = await dispatchBrainTool("brain_record_decision", a, { context: "Database for the sandbox", options: ["Postgres", "SQLite"], chosen: "SQLite", rationale: "single writer", confidence: 0.55 }, cfg);
    expect(rec.isError).toBeFalsy();
    const id = /decision ([0-9a-f-]{36})/.exec(rec.text)![1]!;
    const up = await dispatchBrainTool("brain_update_decision_outcome", a, { decision_id: id.slice(0, 8), outcome: "fine so far", outcome_status: "partial", lesson: "watch write contention" }, cfg);
    expect(up.text).toMatch(/Outcome recorded \(partial\)/);
    const q = await dispatchBrainTool("brain_query_decisions", a, { query: "database" }, cfg);
    expect(q.text).toMatch(/chose: SQLite/);
    expect(q.text).toMatch(/lesson: watch write contention/);
    const j = JSON.parse((await dispatchBrainTool("brain_query_decisions", a, { format: "json" }, cfg)).text);
    expect(j.decisions[0].chosen).toBe("SQLite");
    expect((await dispatchBrainTool("brain_record_decision", a, { context: "x" }, cfg)).isError).toBe(true);
    expect((await dispatchBrainTool("brain_query_decisions", a, { status: "maybe" }, cfg)).isError).toBe(true);
    const off = await dispatchBrainTool("brain_record_decision", a, { context: "c", chosen: "x" }, { ...cfg, decisionLedger: false });
    expect(off.isError).toBe(true);
  });

  it("heuristic auto-extraction: first-person choices only, with low confidence, deduped", () => {
    expect(extractDecisionCandidates("I'll go with Resend over Mailchimp because the API is simpler.")).toEqual([
      { chosen: "Resend", over: ["Mailchimp"], rationale: "the API is simpler", sentence: "I'll go with Resend over Mailchimp because the API is simpler." },
    ]);
    expect(extractDecisionCandidates("I decided to use SQLite because we only have one writer.")[0]).toMatchObject({ chosen: "SQLite", over: [], rationale: "we only have one writer" });
    expect(extractDecisionCandidates("Going with the blue theme instead of the red one.")[0]).toMatchObject({ chosen: "blue theme", over: ["red one"] });
    for (const no of [
      "Should I go with Resend over Mailchimp?", "I'll check the logs.", "> I'll go with X over Y because quoted", "```\nI'll go with X over Y because code\n```",
      "Hailey went with Resend over Mailchimp because it is cheap.", "The team uses Resend.",
    ]) expect(extractDecisionCandidates(no), no).toEqual([]);
    const a = fresh();
    const ids = autoExtractDecisions(a, "Plan: I'll go with Resend over Mailchimp because the API is simpler. Then I'll write the draft.", cfg, { evidence: ["ep-9"] });
    expect(ids).toHaveLength(1);
    expect(getNode(a, ids[0]!)).toMatchObject({ confidence: "low", source_type: "self_observation", source: "decision:auto" });
    expect(autoExtractDecisions(a, "I'll go with Resend over Mailchimp because it's simpler.", cfg)).toEqual([]);
    expect(autoExtractDecisions(fresh(), "I'll go with A over B because c.", { ...cfg, decisionAutoExtract: false })).toEqual([]);
  });

  it("recall boost lifts matching decisions (×decisionBoost) and can be turned off", async () => {
    const mk = (id: string, type: string, activation: number) => ({ id, type, activation, status: "active" }) as unknown as ActivatedNode;
    const boosted = applyDecisionBoost([mk("f", "semantic", 1.0), mk("d", "decision", 0.9)], cfg);
    expect(boosted.map((n) => n.id)).toEqual(["d", "f"]);
    expect(applyDecisionBoost([mk("f", "semantic", 1.0), mk("d", "decision", 0.9)], { ...cfg, decisionBoost: 1 }).map((n) => n.id)).toEqual(["f", "d"]);
    const a = fresh();
    recordDecision(a, { context: "Kestrel router firmware upgrade path", chosen: "staged rollout", rationale: "kestrel firmware bricked once" });
    writeNode(a, "semantic", "Kestrel router", "Kestrel router firmware is version 3", { deduplicate: false });
    const hits = await hybridRetrieve(a, "kestrel router firmware", "s1", cfg);
    expect(hits.some((n) => n.type === "decision")).toBe(true);
  });

  it("sleep decision pass: merges near-duplicates, calibrates confidence once, promotes lessons only behind the flag", async () => {
    const a = fresh();
    const d1 = recordDecision(a, { context: "Which email provider for the newsletter", chosen: "Resend", confidence: "medium" }).id!;
    const d2 = recordDecision(a, { context: "Choosing an email provider for the newsletter", chosen: "Resend", confidence: "medium" }).id!;
    const d3 = recordDecision(a, { context: "Deploy window for the site", chosen: "Thursday mornings" }).id!;
    updateDecisionOutcome(a, d1, { outcome: "worked", status: "matched", lesson: "pick API-first email providers" });
    updateDecisionOutcome(a, d3, { outcome: "deploy broke", status: "missed", lesson: "pick API-first email providers for transactional mail too" });
    const before = getNode(a, d1)!.confidence_score;
    const off = runDecisionPass(a, cfg, log);
    expect(off).toMatchObject({ merged: 1, calibrated: 2, promoted: 0 });
    expect(getNode(a, d2)).toMatchObject({ status: "superseded" });
    expect(getNode(a, d2)!.status_reason).toMatch(/merged into/);
    expect(getNode(a, d1)!.confidence_score).toBeGreaterThan(before);
    expect(getNode(a, d3)!.confidence_score).toBeLessThan(0.6);
    expect(queryDecisions(a, {}).find((d) => d.node_id === d1)!.merge_count).toBe(2);
    expect(runDecisionPass(a, cfg, log).calibrated).toBe(0);
    const on = runDecisionPass(a, { ...cfg, decisionLessonPromotion: true }, log);
    expect(on.promoted).toBeGreaterThanOrEqual(1);
    const skill = getNode(a, on.promotedIds[0]!)!;
    expect(skill).toMatchObject({ type: "skill", source_type: "inference" });
    expect(skill.label).toMatch(/^Lesson: /);
    expect((await dispatchBrainTool("brain_query_decisions", a, { query: "email provider" }, cfg)).text).toMatch(/promoted to a skill/);
    // full sleep records it in the summary
    await runConsolidation(a, { ...cfg, decisionLessonPromotion: true }, log);
    expect(getSleepSummary(a)).toMatchObject({ decisionsMerged: 0 });
  });
});

describe("goals", () => {
  it("set → update/supersede keeps versions + history; as_of sees the old wording; pause/done leave the header", async () => {
    const a = fresh();
    const s = setGoal(a, { title: "Publish the Xanima docs", priority: 2, successCriteria: "README covers every tool", triggers: [{ kind: "keyword", keywords: ["docs"] }] });
    expect(s.ok).toBe(true);
    const lin = s.goal!.lineage_id;
    expect(s.goal).toMatchObject({ version: 1, status: "active", tracked: 1, priority: 2 });
    expect(JSON.parse(s.goal!.keywords_json)).toEqual(expect.arrayContaining(["publish", "xanima", "docs"]));
    const t0 = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    const u = updateGoal(a, lin.slice(0, 8), { action: "supersede", title: "Publish the Xanima docs site", priority: "critical", reason: "Hailey wants a site, not a README" });
    expect(u.ok, u.error).toBe(true);
    expect(u.goal).toMatchObject({ version: 2, priority: 1, title: "Publish the Xanima docs site", lineage_id: lin });
    expect(getNode(a, s.goal!.node_id)).toMatchObject({ status: "superseded" });
    expect(updateGoal(a, lin, { action: "supersede", title: "x" }).ok).toBe(false); // reason required
    const h = goalHistory(a, lin)!;
    expect(h.versions.map((v) => [v.version, v.status])).toEqual([[1, "superseded"], [2, "active"]]);
    expect(h.events.map((e) => e.action)).toEqual(["create", "supersede"]);
    expect(h.events[1]!.reason).toMatch(/site/);
    expect(h.triggers).toHaveLength(1);
    expect(queryAsOf(a, "Xanima docs", t0).map((n) => n.id)).toContain(s.goal!.node_id);
    expect(getActiveGoals(a).map((n) => n.id)).toEqual([u.goal!.node_id]);
    expect(updateGoal(a, lin, { action: "pause" }).goal!.status).toBe("paused");
    expect(getActiveGoals(a)).toEqual([]);
    expect(updateGoal(a, lin, { action: "resume" }).goal!.status).toBe("active");
    expect(updateGoal(a, lin, { action: "done", reason: "site live" }).goal!.status).toBe("done");
    expect(getActiveGoals(a)).toEqual([]);
    expect(listGoals(a, { status: "all" })).toHaveLength(1);
    expect(updateGoal(a, lin, { action: "done" }).ok).toBe(false);
    expect(goalHistory(a, lin)!.events.map((e) => e.action)).toEqual(["create", "supersede", "pause", "resume", "done"]);
  });

  it("tools: set / update / list (+history, json) and validation", async () => {
    const a = fresh();
    const s = await dispatchBrainTool("brain_set_goal", a, { title: "Cut cloud spend", priority: "high", success_criteria: "bill under $200", triggers: [{ kind: "time", every_days: 7 }] }, cfg);
    expect(s.text).toMatch(/Goal set: \S+ P2 \[active\] Cut cloud spend/);
    const id = /Goal set: (\S+)/.exec(s.text)![1]!;
    expect((await dispatchBrainTool("brain_update_goal", a, { goal_id: id, action: "update", success_criteria: "bill under $150" }, cfg)).text).toMatch(/v1 → v2; v1 kept as history/);
    const l = await dispatchBrainTool("brain_list_goals", a, { goal_id: id.slice(0, 8) }, cfg);
    expect(l.text).toMatch(/success_criteria: "bill under \$200" → "bill under \$150"/);
    expect(JSON.parse((await dispatchBrainTool("brain_list_goals", a, { format: "json" }, cfg)).text).goals).toHaveLength(1);
    for (const bad of [{ title: "" }, { title: "x", priority: 9 }, { title: "x", triggers: [{ kind: "cron" }] }, { title: "x", triggers: [{ kind: "keyword" }] }]) {
      expect((await dispatchBrainTool("brain_set_goal", a, bad, cfg)).isError, JSON.stringify(bad)).toBe(true);
    }
    expect((await dispatchBrainTool("brain_update_goal", a, { goal_id: id, action: "explode" }, cfg)).isError).toBe(true);
    expect(parsePriority("someday")).toBe(5);
  });
});

describe("drift pass + alignment note", () => {
  function brainWithGoals() {
    const a = fresh();
    const now = Date.now();
    const start = now - 12 * DAY;
    const hi = setGoal(a, { title: "Ship the billing migration", priority: 1, keywords: ["billing", "migration"], now: start }).goal!;
    const lo = setGoal(a, { title: "Redesign the blog theme", priority: 4, keywords: ["blog", "theme"], now: start }).goal!;
    // ten days of unrelated activity
    for (let d = 10; d >= 1; d--) {
      appendEpisode(a, "s", "user", `day ${d}: let's tweak the blog theme colours again`, 0.5);
      appendEpisode(a, "s", "assistant", `day ${d}: updated the blog theme header`, 0.5);
    }
    getDb(a).prepare("UPDATE episodes SET created_at = ? - (CAST(substr(content, 5, 2) AS INTEGER) * ?)").run(now, DAY);
    return { a, now, hi, lo };
  }

  it("flags 'no progress in N days' and priority conflict; keeps on-track goals clean; note is injected once and capped", () => {
    const { a, now, hi, lo } = brainWithGoals();
    recordDecision(a, { context: "Blog header", chosen: "serif headings", goalId: lo.lineage_id, now: now - 2 * DAY });
    const r = runDriftPass(a, cfg, log, now);
    expect(r.checked).toBe(2);
    expect(r.drifting).toHaveLength(1);
    expect(r.drifting[0]).toMatchObject({ lineage_id: hi.lineage_id, kind: "priority" });
    expect(r.drifting[0]!.reason).toMatch(/advanced "Redesign the blog theme" \(P4\) while "Ship the billing migration" \(P1\) had no progress in 12 days/);
    expect(r.onTrack).toBe(1);
    const st = computeBrainStatus(getDb(a), cfg);
    expect(st.goals.drifting).toHaveLength(1);
    expect(st.attention.join(" ")).toMatch(/1 goal drifting/);
    expect(formatBrainStatus(st)).toMatch(/DRIFT .*billing migration/);
    expect(formatBrainStatus(st)).toMatch(/alignment note queued/);
    const t1 = buildGoalTurnContext(a, "hello", cfg, now + 1000);
    expect(t1.text).toMatch(/^\[BRAIN: goals\]\nAlignment: recent decisions advanced/);
    expect(t1.text.length).toBeLessThanOrEqual("[BRAIN: goals]\n".length + 60 * 4);
    expect(buildGoalTurnContext(a, "hello again", cfg, now + 2000).text).toBe("");
    // the same drift the next day does not re-nag within 24 h
    expect(runDriftPass(a, cfg, log, now + 3600_000).noteId).toBeNull();
    // a tiny budget truncates
    const { a: b, now: n2 } = brainWithGoals();
    runDriftPass(b, { ...cfg, alignmentNoteMaxTokens: 10 }, log, n2);
    expect(buildGoalTurnContext(b, "x", { ...cfg, alignmentNoteMaxTokens: 10 }, n2).text.length).toBeLessThanOrEqual("[BRAIN: goals]\n".length + 80);
  });

  it("stalled vs progress: keyword episodes and resolved decisions count as progress; explicit conflicts are flagged", () => {
    const { a, now, hi } = brainWithGoals();
    expect(runDriftPass(a, cfg, log, now).drifting[0]).toMatchObject({ kind: "stalled" });
    appendEpisode(a, "s", "assistant", "Ran the billing migration dry run on staging", 0.6);
    const r2 = runDriftPass(a, cfg, log, Date.now() + 1000);
    expect(r2.drifting).toEqual([]);
    expect(listGoals(a)[0]!.alignment_summary).toMatch(/on track — last progress/);
    recordDecision(a, { context: "Friday plans", chosen: "skip billing work for the offsite", conflictsWithGoalIds: [hi.lineage_id] });
    const r3 = runDriftPass(a, cfg, log, Date.now() + 2000);
    expect(r3.drifting[0]).toMatchObject({ kind: "conflict" });
    expect(updateGoal(a, hi.lineage_id, { action: "progress", note: "agreed new date" }).goal!.drift_reason).toBeNull();
  });

  it("modes: sleep runs it in consolidation; daily runs at turn time at most once a day; off never", async () => {
    const { a, now } = brainWithGoals();
    await runConsolidation(a, cfg, log);
    expect(getSleepSummary(a)).toMatchObject({ goalsChecked: 2, goalsDrifting: 1, alignmentNoteQueued: true });
    const { a: b, now: n } = brainWithGoals();
    const daily = { ...cfg, intentDriftCheck: "daily" as const };
    await runConsolidation(b, daily, log);
    expect(getSleepSummary(b)!.goalsChecked ?? 0).toBe(0);
    expect(buildGoalTurnContext(b, "hi", daily, n).text).toMatch(/Alignment: no progress on goal "Ship the billing migration"/);
    expect(buildGoalTurnContext(b, "hi", daily, n + 3600_000).text).toBe("");
    const { a: c, now: n3 } = brainWithGoals();
    const off = { ...cfg, intentDriftCheck: "off" as const };
    await runConsolidation(c, off, log);
    expect(buildGoalTurnContext(c, "hi", off, n3).text).toBe("");
    void now;
  });

  it("untracked (legacy) goals are never drift-checked", () => {
    const a = fresh();
    const g = setGoal(a, { title: "Old goal", now: Date.now() - 30 * DAY }).goal!;
    updateGoal(a, g.lineage_id, { action: "untrack" });
    expect(runDriftPass(a, cfg, log).checked).toBe(0);
  });
});

describe("goal triggers", () => {
  it("keyword triggers fire on mention with cooldown; time triggers fire when due and reschedule; flag off disables", () => {
    const a = fresh();
    const now = Date.now();
    setGoal(a, { title: "Keep deploys safe", priority: 2, successCriteria: "zero failed deploys", triggers: [{ kind: "keyword", keywords: ["deploy", "release"] }] });
    setGoal(a, { title: "Weekly review", priority: 3, triggers: [{ kind: "time", every_days: 7 }], now: now - 8 * DAY });
    getDb(a).prepare("UPDATE goal_triggers SET next_at = ? WHERE kind = 'time'").run(now - DAY);
    const t = buildGoalTurnContext(a, "Can you deploy the site now?", cfg, now);
    expect(t.triggered.map((x) => x.title).sort()).toEqual(["Keep deploys safe", "Weekly review"]);
    expect(t.text).toMatch(/Goal P2 "Keep deploys safe" — success: zero failed deploys \(you mentioned "deploy"\)/);
    expect(t.text).toMatch(/Weekly review" \(scheduled every 7d\)/);
    expect(buildGoalTurnContext(a, "deploy again", cfg, now + 60_000).triggered).toEqual([]);
    expect(buildGoalTurnContext(a, "deploy later", cfg, now + 7 * 3600_000).triggered.map((x) => x.title)).toEqual(["Keep deploys safe"]);
    expect(buildGoalTurnContext(a, "redeployment talk", cfg, now + 20 * 3600_000).triggered).toEqual([]); // word boundary
    expect(buildGoalTurnContext(a, "deploy", { ...cfg, goalTriggers: false }, now + 30 * 3600_000).text).toBe("");
    const due = getDb(a).prepare("SELECT next_at FROM goal_triggers WHERE kind = 'time'").get() as { next_at: number };
    expect(due.next_at).toBeGreaterThan(now);
  });
});

describe("FTS still sees decisions", () => {
  it("decision nodes are searchable like any belief", () => {
    const a = fresh();
    const r = recordDecision(a, { context: "Telegram bot hosting", chosen: "run it on the gateway" });
    expect(ftsSearchNodes(a, "telegram hosting").map((n) => n.id)).toContain(r.id);
  });
});
