/**
 * Xanima 0.5.1: untracked legacy goals (pre-0.2.0 backfill, often chat fragments)
 * stay out of the header / status / soul package / replay seeds; pause-legacy is
 * reversible; goal titles are normalised so soul diff/merge see no fake changes.
 * Regressions found on Tripp's live brain (2026-10-13).
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { getDb, closeDb } from "../src/db.js";
import { writeNode, getActiveGoals } from "../src/nodes.js";
import { computeBrainStatus, formatBrainStatus } from "../src/beliefs.js";
import { setGoal, listGoals, goalCounts, looksLikeChatFragment, listLegacyGoals, pauseLegacyGoals, resumeLegacyGoals, normGoalTitle } from "../src/goals.js";
import { buildSelfModelHeader } from "../src/context-assembly.js";
import { exportSoul, importSoul, diffSoul, listReviews, acceptReview, mergeSoul, type SoulPackage } from "../src/soul.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const opened: string[] = [];
function fresh(prefix = "v051"): string { const id = `${prefix}-${randomUUID().slice(0, 8)}`; opened.push(id); return id; }
afterEach(() => { for (const id of opened.splice(0)) closeDb(id); });
const cfg = { ...DEFAULT_CONFIG };

const FRAGMENTS = [
  '"), so I want to make sure I understand what landed wrong',
  "twilio i want to keep the same number",
  "- **ZeroClaw's license:** I need to check whether we can bundle it",
  "I want to take the whole what we build lane out and replace ",
];
/** Mimic the v20 backfill: a pre-0.2.0 goal node with an untracked goals row. */
function legacyGoal(a: string, title: string): string {
  const id = writeNode(a, "goal", title, title, { importance: 0.6 });
  const now = Date.now();
  getDb(a).prepare(`INSERT INTO goals (node_id, lineage_id, version, title, priority, status, keywords_json, tracked, created_at, updated_at)
                    VALUES (?, ?, 1, ?, 3, 'active', '[]', 0, ?, ?)`).run(id, id, title, now, now);
  return id;
}

describe("untracked legacy goals are not active goals", () => {
  it("header, bootstrap list, status count and soul export only carry tracked goals", () => {
    const a = fresh();
    const real = setGoal(a, { title: "Launch the newsletter", priority: 1 }).goal!;
    for (const f of FRAGMENTS) legacyGoal(a, f);
    expect(getActiveGoals(a).map((g) => g.id)).toEqual([real.node_id]);
    const header = buildSelfModelHeader(a, cfg) ?? "";
    for (const f of FRAGMENTS) expect(header).not.toContain(f.trim().slice(0, 25));
    const c = goalCounts(getDb(a));
    expect(c).toMatchObject({ active: 1, tracked: 1, untracked: 4 });
    const st = formatBrainStatus(computeBrainStatus(getDb(a), cfg));
    expect(st).toMatch(/goals: 1 active \(1 drift-checked\), 0 paused, 0 done · 4 untracked legacy \(not injected/);
    const pkg = exportSoul(getDb(a), { agentId: a, profile: "full" });
    expect(pkg.content.goals.map((g) => g.title)).toEqual(["Launch the newsletter"]);
    // still listable / adoptable: brain_list_goals shows them as untracked
    expect(listGoals(a).filter((g) => !g.tracked).length).toBe(4);
  });

  it("importing a package never puts legacy fragments in the review queue", () => {
    const a = fresh(); setGoal(a, { title: "Launch the newsletter", priority: 1 }); for (const f of FRAGMENTS) legacyGoal(a, f);
    const b = fresh("ari");
    importSoul(b, exportSoul(getDb(a), { agentId: a, profile: "full" }), { mode: "new" });
    const goals = listReviews(getDb(b)).filter((r) => r.kind === "goal");
    expect(goals.length).toBe(1);
  });
});

describe("goals pause-legacy", () => {
  it("chat-fragment heuristic", () => {
    for (const f of FRAGMENTS) expect(looksLikeChatFragment(f)).not.toBeNull();
    for (const g of ["Launch the newsletter", "Finish the Telegram bot for Gano", "Keep deploys safe"]) expect(looksLikeChatFragment(g)).toBeNull();
  });

  it("pauses fragment-like untracked goals only (all with --all-untracked), reversibly; tracked goals untouched", () => {
    const a = fresh(); const db = getDb(a);
    const real = setGoal(a, { title: "Launch the newsletter", priority: 1 }).goal!;
    const ids = FRAGMENTS.map((f) => legacyGoal(a, f));
    const plain = legacyGoal(a, "Ship the portfolio site");
    expect(listLegacyGoals(db).length).toBe(5);
    const dry = pauseLegacyGoals(db, { dryRun: true });
    expect(dry.paused.length).toBe(4); expect(dry.kept.map((g) => g.node_id)).toEqual([plain]);
    expect(goalCounts(db).untracked).toBe(5);
    const r = pauseLegacyGoals(db, { batch: "goals-test-1" });
    expect(r.paused.map((g) => g.node_id).sort()).toEqual([...ids].sort());
    expect(goalCounts(db)).toMatchObject({ active: 1, untracked: 1, paused: 4 });
    expect(db.prepare("SELECT status FROM goals WHERE node_id = ?").get(real.node_id)).toEqual({ status: "active" });
    expect((db.prepare("SELECT COUNT(*) n FROM goal_events WHERE action = 'pause' AND reason LIKE 'legacy-pause goals-test-1:%'").get() as { n: number }).n).toBe(4);
    expect(pauseLegacyGoals(db, { batch: "goals-test-2" }).paused.length).toBe(0);           // idempotent
    expect(pauseLegacyGoals(db, { all: true, batch: "goals-test-3" }).paused.map((g) => g.node_id)).toEqual([plain]);
    const u = resumeLegacyGoals(db, "goals-test-1");
    expect(u.resumed.length).toBe(4);
    expect(goalCounts(db)).toMatchObject({ active: 1, untracked: 4, paused: 1 });
    expect(resumeLegacyGoals(db, "goals-test-1").resumed.length).toBe(0);
  });
});

describe("goal titles are normalised across export / import / diff", () => {
  it("a title with stray whitespace round-trips with no fake change and no spurious review", () => {
    const a = fresh("tripp");
    const g = setGoal(a, { title: "Launch the newsletter", priority: 2 }).goal!;
    getDb(a).prepare("UPDATE goals SET title = ? WHERE node_id = ?").run("Launch  the newsletter ", g.node_id);   // legacy-stored, untrimmed
    const base = exportSoul(getDb(a), { agentId: a, profile: "full", fork: true, parentId: null });
    expect(base.content.goals[0]!.title).toBe("Launch the newsletter");
    const nova = fresh("nova");
    importSoul(nova, base, { mode: "new" });
    for (const x of listReviews(getDb(nova))) acceptReview(nova, x.id);
    const theirs = exportSoul(getDb(nova), { agentId: nova, profile: "full" });
    const d = diffSoul(base, theirs);
    expect(d.changed.filter((c) => c.section === "goals")).toEqual([]);
    const m = mergeSoul(a, base, theirs, { dryRun: true });
    expect(m.review.filter((r) => r.section === "goals")).toEqual([]);
  });

  it("packages written by 0.5.0 (untrimmed title) compare equal to normalised ones", () => {
    const a = fresh(); setGoal(a, { title: "Keep deploys safe", priority: 2 });
    const p = exportSoul(getDb(a), { agentId: a, profile: "full" });
    const old: SoulPackage = JSON.parse(JSON.stringify(p)); old.content.goals[0]!.title = "Keep deploys safe ";
    expect(diffSoul(old, p).changed).toEqual([]);
    expect(normGoalTitle("  a \n b  ")).toBe("a b");
  });
});
