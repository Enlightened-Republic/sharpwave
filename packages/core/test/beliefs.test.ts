/**
 * Xanima 0.1.0 belief foundation (schema v19):
 *   metadata defaults + inference, legacy backfill (synthetic + real snapshot
 *   copy), retract / supersede (+ reason, downstream), as_of, relative-time and
 *   confidence labels on injection, brain_status + footer, sleep belief review
 *   and prune protection, flags off.
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { getDb, closeDb, SCHEMA_VERSION } from "../src/db.js";
import { writeNode, getNode, ftsSearchNodes, getNeighbors } from "../src/nodes.js";
import { writeEdge } from "../src/edges.js";
import { hybridRetrieve } from "../src/retrieval.js";
import { buildRecallContext, buildStatusFooter } from "../src/context-assembly.js";
import { runConsolidation } from "../src/consolidation.js";
import { dispatchBrainTool } from "../src/tools.js";
import {
  retractNode, supersedeNode, queryAsOf, computeBrainStatus, statusFooter, runBeliefReviewPass, relatedDownstream, getSleepSummary,
} from "../src/beliefs.js";
import { relativeTime, parseAsOf, confidenceLevel, parseConfidence, inferSourceType, beliefTag } from "../src/belief-meta.js";
import { DEFAULT_CONFIG } from "../src/types.js";

const log = { info: () => {}, warn: () => {}, error: () => {} };
const opened: string[] = [];
function fresh(prefix = "bel"): string {
  const id = `${prefix}-${randomUUID().slice(0, 8)}`;
  opened.push(id);
  return id;
}
afterEach(() => { for (const id of opened.splice(0)) closeDb(id); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha256 = (p: string) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "absent");

describe("belief-meta helpers", () => {
  it("maps scores to levels and parses levels/numbers", () => {
    expect([0.1, 0.39, 0.4, 0.69, 0.7, 0.89, 0.9, 1].map(confidenceLevel)).toEqual(["low", "low", "medium", "medium", "high", "high", "certain", "certain"]);
    expect(parseConfidence("high")).toEqual({ level: "high", score: 0.8 });
    expect(parseConfidence(0.25)).toEqual({ level: "low", score: 0.25 });
    expect(parseConfidence("0.95")).toEqual({ level: "certain", score: 0.95 });
    expect(parseConfidence(2)).toBeNull();
    expect(parseConfidence("sure")).toBeNull();
  });

  it("infers source_type from source / writer", () => {
    expect(inferSourceType({ source: "sws", brainAgentId: "a" })).toBe("inference");
    expect(inferSourceType({ writerAgentId: "system:sleep", brainAgentId: "a" })).toBe("inference");
    expect(inferSourceType({ source: "seed:notes.md#ab", brainAgentId: "a" })).toBe("seed");
    expect(inferSourceType({ source: "llm_extraction", brainAgentId: "a" })).toBe("user");
    expect(inferSourceType({ source: "mcp", writerAgentId: "a", brainAgentId: "a" })).toBe("self_observation");
    expect(inferSourceType({ source: "xanima-server", writerAgentId: "cos", brainAgentId: "shared" })).toBe("agent");
  });

  it("relative time labels", () => {
    const now = Date.UTC(2026, 9, 11, 12);
    expect(relativeTime(now - 10_000, now)).toBe("just now");
    expect(relativeTime(now - 5 * 60_000, now)).toBe("5 min ago");
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe("3 h ago");
    expect(relativeTime(now - 30 * 3_600_000, now)).toBe("yesterday");
    expect(relativeTime(now - 3 * 86_400_000, now)).toBe("3 days ago");
    expect(relativeTime(now - 21 * 86_400_000, now)).toBe("3 weeks ago");
    expect(relativeTime(now - 120 * 86_400_000, now)).toBe("4 months ago");
    expect(relativeTime(now - 800 * 86_400_000, now)).toBe("2 years ago");
    expect(relativeTime(null, now)).toBe("unknown time");
  });

  it("parses as_of values", () => {
    const now = Date.UTC(2026, 9, 11, 12);
    expect(parseAsOf("3 days ago", now)).toBe(now - 3 * 86_400_000);
    expect(parseAsOf("2 hours ago", now)).toBe(now - 2 * 3_600_000);
    expect(parseAsOf("yesterday", now)).toBe(now - 86_400_000);
    expect(parseAsOf("2026-10-01T00:00:00Z", now)).toBe(Date.UTC(2026, 9, 1));
    expect(parseAsOf(String(now - 5), now)).toBe(now - 5);
    expect(parseAsOf(now - 7, now)).toBe(now - 7);
    expect(parseAsOf("whenever", now)).toBeNull();
    expect(parseAsOf("", now)).toBeNull();
  });

  it("belief tags: low gets (?), disputed and confirm-before-acting are shown, medium adds nothing", () => {
    const now = Date.now();
    expect(beliefTag({ created_at: now - 3 * 86_400_000, confidence: "medium", confidence_score: 0.6 }, { now })).toBe("3 days ago");
    expect(beliefTag({ created_at: now, confidence_score: 0.2 }, { now })).toBe("just now · low confidence (?)");
    expect(beliefTag({ created_at: now, confidence_score: 0.9, contradicted_at: now, sensitivity: "confirm_before_acting" }, { now, relativeTime: false })).toBe("disputed · confirm before acting");
  });
});

describe("schema v19 — fresh brain + writes", () => {
  it("has the belief columns with defaults, and writes stamp source_type + confidence", () => {
    const a = fresh();
    const db = getDb(a);
    expect((db.prepare("SELECT version FROM schema_version").get() as { version: number }).version).toBe(SCHEMA_VERSION);
    const cols = (db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string }>).map((c) => c.name);
    for (const c of ["confidence", "confidence_score", "source_type", "verified_at", "contradicted_at", "evidence", "status", "status_reason", "sensitivity", "review_flagged_at"]) {
      expect(cols).toContain(c);
    }
    const own = getNode(a, writeNode(a, "semantic", "own", "an observation by the agent itself", { source: "mcp" }))!;
    expect(own).toMatchObject({ source_type: "self_observation", confidence: "high", confidence_score: 0.7, status: "active", sensitivity: "normal" });
    const sws = getNode(a, writeNode(a, "semantic", "gist", "derived during sleep", { source: "sws" }))!;
    expect(sws).toMatchObject({ source_type: "inference", confidence: "medium", confidence_score: 0.45 });
    const user = getNode(a, writeNode(a, "semantic", "u", "the user said so", { sourceType: "user", confidence: "certain", evidence: ["ep1"], sensitivity: "confirm_before_acting" }))!;
    expect(user).toMatchObject({ source_type: "user", confidence: "certain", confidence_score: 0.95, evidence: JSON.stringify(["ep1"]), sensitivity: "confirm_before_acting" });
  });

  it("brain_write tool accepts confidence/source_type/sensitivity and refuses reserved or bad values", async () => {
    const a = fresh();
    const ok = await dispatchBrainTool("brain_write", a, { type: "semantic", label: "t", content: "tool output said disk is 80% full", source_type: "tool", confidence: 0.3 }, DEFAULT_CONFIG);
    expect(ok.isError).toBeFalsy();
    const id = /node (\S+)/.exec(ok.text)![1]!;
    expect(getNode(a, id)).toMatchObject({ source_type: "tool", confidence: "low", confidence_score: 0.3 });
    for (const bad of [{ source_type: "seed" }, { source_type: "legacy" }, { confidence: "kinda" }, { sensitivity: "secret" }, { evidence: "x" }]) {
      const r = await dispatchBrainTool("brain_write", a, { type: "semantic", label: "x", content: "y", ...bad }, DEFAULT_CONFIG);
      expect(r.isError, JSON.stringify(bad)).toBe(true);
    }
  });
});

describe("v18 → v19 migration (synthetic legacy brain)", () => {
  it("is additive: counts unchanged, legacy backfill, closed rows get superseded/archived, idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "xa-v19-"));
    const file = join(dir, "brain.db");
    try {
      // Build a v18 brain with the current code, then strip v19 columns by recreating as v18.
      const a = fresh("legacy");
      process.env["XANIMA_DB_PATH"] = file;
      try { getDb(a); } finally { delete process.env["XANIMA_DB_PATH"]; }
      const db = getDb(a);
      const n1 = writeNode(a, "semantic", "old fact", "the server is on port 8080", { deduplicate: false });
      const n2 = writeNode(a, "semantic", "new fact", "the server is on port 9090", { deduplicate: false });
      const n3 = writeNode(a, "semantic", "noise", "heartbeat triage", { deduplicate: false });
      writeEdge(a, n2, n1, "supersedes");
      const past = Date.now() - 1000;
      db.prepare("UPDATE nodes SET valid_until = ? WHERE id IN (?, ?)").run(past, n1, n3);
      closeDb(a);
      // Downgrade to a faithful v18 shape: drop the v19 columns.
      const raw = new Database(file);
      for (const c of ["confidence", "confidence_score", "source_type", "verified_at", "contradicted_at", "evidence", "status", "status_reason", "status_changed_at", "sensitivity", "review_flagged_at"]) {
        raw.exec("DROP INDEX IF EXISTS nodes_status; DROP INDEX IF EXISTS nodes_review;");
        raw.exec(`ALTER TABLE nodes DROP COLUMN ${c}`);
      }
      raw.exec("DELETE FROM schema_version; INSERT INTO schema_version VALUES (18);");
      const census = (d: Database.Database) => ["nodes", "edges", "episodes"].map((t) => (d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
      const before = census(raw);
      raw.close();

      const b = fresh("legacy2");
      process.env["XANIMA_DB_PATH"] = file;
      let mdb: Database.Database;
      try { mdb = getDb(b); } finally { delete process.env["XANIMA_DB_PATH"]; }
      expect(census(mdb)).toEqual(before);
      expect((mdb.prepare("SELECT version FROM schema_version").get() as { version: number }).version).toBe(25);
      const rows = mdb.prepare("SELECT id, source_type, confidence, confidence_score, status, sensitivity FROM nodes").all() as Array<Record<string, unknown>>;
      for (const r of rows) expect(r).toMatchObject({ source_type: "legacy", confidence: "medium", confidence_score: 0.6, sensitivity: "normal" });
      const st = Object.fromEntries(rows.map((r) => [r["id"], r["status"]]));
      expect(st[n1]).toBe("superseded");
      expect(st[n2]).toBe("active");
      expect(st[n3]).toBe("archived");
      expect(mdb.pragma("integrity_check", { simple: true })).toBe("ok");
      closeDb(b);
      // Re-open: idempotent.
      const c = fresh("legacy3");
      process.env["XANIMA_DB_PATH"] = file;
      try { expect(census(getDb(c))).toEqual(before); } finally { delete process.env["XANIMA_DB_PATH"]; }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const SNAPSHOT = process.env["XANIMA_TEST_SNAPSHOT_DB"] ?? process.env["SHARPWAVE_TEST_SNAPSHOT_DB"] ?? "/workspace/brain-snap/main/brain.db";
describe.skipIf(!existsSync(SNAPSHOT))("v19 migration on a COPY of a real brain snapshot", () => {
  it("counts unchanged, every row backfilled legacy/medium, integrity ok, recall works; snapshot untouched", async () => {
    const srcHashes = ["", "-wal", "-shm"].map((s) => sha256(SNAPSHOT + s));
    const dir = mkdtempSync(join(tmpdir(), "xa-snap-v19-"));
    const copy = join(dir, "brain.db");
    try {
      for (const s of ["", "-wal", "-shm"]) if (existsSync(SNAPSHOT + s)) copyFileSync(SNAPSHOT + s, copy + s);
      const pre = new Database(copy);
      const census = (d: Database.Database) => ["nodes", "edges", "episodes"].map((t) => (d.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
      const before = census(pre);
      pre.close();
      const a = fresh("snapv19");
      process.env["XANIMA_DB_PATH"] = copy;
      let db: Database.Database;
      const t0 = performance.now();
      try { db = getDb(a); } finally { delete process.env["XANIMA_DB_PATH"]; }
      const ms = performance.now() - t0;
      expect(census(db)).toEqual(before);
      expect(db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE source_type != 'legacy' OR confidence != 'medium'").get()).toEqual({ n: 0 });
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
      const st = computeBrainStatus(db, DEFAULT_CONFIG);
      expect(st.nodes.total).toBe(before[0]);
      expect(st.nodes.active + st.nodes.archived + st.nodes.superseded + st.nodes.retracted).toBe(before[0]);
      // eslint-disable-next-line no-console
      console.log(`[v19-snapshot] counts=${before.join("/")} migrateMs=${ms.toFixed(1)} status=${JSON.stringify(st.nodes)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    expect(["", "-wal", "-shm"].map((s) => sha256(SNAPSHOT + s))).toEqual(srcHashes);
  });
});

describe("retract", () => {
  it("is kept as history but never recalled, injected or reached by spreading activation", async () => {
    const a = fresh();
    const bad = writeNode(a, "semantic", "Hailey allergy", "Hailey is allergic to peanuts", { deduplicate: false });
    const dep = writeNode(a, "procedural", "Snack rule", "Never order peanut snacks for Hailey", { deduplicate: false });
    const hub = writeNode(a, "semantic", "Hailey food", "Hailey food preferences overview", { deduplicate: false });
    writeEdge(a, bad, dep, "supports");
    writeEdge(a, hub, bad, "associates");
    expect(ftsSearchNodes(a, "peanuts").map((n) => n.id)).toContain(bad);
    const t = Date.now();
    await sleep(5);

    const r = retractNode(a, bad, "Hailey said she is not allergic; it was her brother");
    expect(r.ok).toBe(true);
    expect(r.related.map((x) => x.id)).toContain(dep);
    expect(getNode(a, bad)).toMatchObject({ status: "retracted" });
    expect(getNode(a, bad)!.status_reason).toContain("brother");

    expect(ftsSearchNodes(a, "peanuts").map((n) => n.id)).not.toContain(bad);
    expect((await hybridRetrieve(a, "is Hailey allergic to peanuts", "s1", DEFAULT_CONFIG)).map((n) => n.id)).not.toContain(bad);
    expect(getNeighbors(a, hub).map((n) => n.node.id)).not.toContain(bad);
    const block = await buildRecallContext(a, "is Hailey allergic to peanuts", "s1", DEFAULT_CONFIG);
    expect(block).not.toContain("allergic to peanuts");

    // as_of before the retraction still finds it
    expect(queryAsOf(a, "peanuts", t).map((n) => n.id)).toContain(bad);
    expect(queryAsOf(a, "peanuts", Date.now()).map((n) => n.id)).not.toContain(bad);

    const again = retractNode(a, bad, "again");
    expect(again.ok).toBe(false);
    expect(retractNode(a, dep, "  ").ok).toBe(false);
  });

  it("brain_retract tool returns downstream nodes to re-check", async () => {
    const a = fresh();
    const bad = writeNode(a, "semantic", "Deploy day", "Deploys happen on Friday", { deduplicate: false });
    const dep = writeNode(a, "semantic", "Friday freeze", "Freeze merges Friday morning before deploy", { deduplicate: false });
    writeEdge(a, dep, bad, "used_in");
    const r = await dispatchBrainTool("brain_retract", a, { node_id: bad, reason: "deploys moved to Thursday" }, DEFAULT_CONFIG);
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain("Retracted");
    expect(r.text).toContain("Friday freeze");
    const miss = await dispatchBrainTool("brain_retract", a, { node_id: bad }, DEFAULT_CONFIG);
    expect(miss.isError).toBe(true);
  });
});

describe("supersede with reason", () => {
  it("keeps the old version as superseded history with the reason, links evidence, surfaces downstream", async () => {
    const a = fresh();
    const old = writeNode(a, "semantic", "Office", "The office is in Lisbon", { deduplicate: false });
    const dep = writeNode(a, "semantic", "Commute", "Commute plan to the Lisbon office by train", { deduplicate: false });
    writeEdge(a, old, dep, "supports");
    const t = Date.now();
    await sleep(5);
    const r = supersedeNode(a, old, "The office is in Porto", { reason: "moved in October" });
    expect(r.ok).toBe(true);
    expect(r.related.map((x) => x.id)).toEqual([dep]);
    const o = getNode(a, old)!;
    expect(o.status).toBe("superseded");
    expect(o.status_reason).toContain("moved in October");
    const n = getNode(a, r.newId!)!;
    expect(JSON.parse(n.evidence!)).toEqual([old]);
    const edge = getDb(a).prepare("SELECT meta FROM edges WHERE from_id = ? AND to_id = ? AND type = 'supersedes'").get(r.newId, old) as { meta: string };
    expect(JSON.parse(edge.meta)).toEqual({ reason: "moved in October" });
    const nowIds = ftsSearchNodes(a, "office").map((x) => x.id);
    expect(nowIds).toContain(r.newId);
    expect(nowIds).not.toContain(old);
    const thenIds = queryAsOf(a, "office", t).map((x) => x.id);
    expect(thenIds).toContain(old);
    expect(thenIds).not.toContain(r.newId);
    // tool text
    const r2 = await dispatchBrainTool("brain_supersede", a, { old_node_id: r.newId, new_content: "The office is in Braga", reason: "moved again" }, DEFAULT_CONFIG);
    expect(r2.text).toMatch(/Reason: moved again/);
  });
});

describe("as_of", () => {
  it("returns only what existed and was valid at T", async () => {
    const a = fresh();
    const early = writeNode(a, "semantic", "Plan A", "Project plan uses Postgres", { deduplicate: false });
    await sleep(10);
    const t1 = Date.now();
    await sleep(10);
    const late = writeNode(a, "semantic", "Plan B", "Project plan uses SQLite", { deduplicate: false });
    // a fact that only becomes valid in the future
    const future = writeNode(a, "semantic", "Plan C", "Project plan uses DuckDB", { deduplicate: false });
    getDb(a).prepare("UPDATE nodes SET valid_from = ? WHERE id = ?").run(Date.now() + 86_400_000, future);
    expect(queryAsOf(a, "project plan", t1).map((n) => n.id)).toEqual([early]);
    const nowIds = queryAsOf(a, "project plan", Date.now()).map((n) => n.id).sort();
    expect(nowIds).toEqual([early, late].sort());
    const tool = await dispatchBrainTool("brain_query", a, { query: "project plan", as_of: t1 }, DEFAULT_CONFIG);
    expect(tool.text).toContain("Plan A");
    expect(tool.text).not.toContain("Plan B");
    const num = await dispatchBrainTool("brain_query", a, { query: "project plan", as_of: t1 }, DEFAULT_CONFIG);
    expect(num.isError).toBeFalsy();
    const { BRAIN_TOOL_DEFS } = await import("../src/tools.js");
    expect((BRAIN_TOOL_DEFS["brain_query"]!.inputSchema.properties as Record<string, { type: unknown }>)["as_of"]!.type).toEqual(["string", "number"]);
    const bad = await dispatchBrainTool("brain_query", a, { query: "project plan", as_of: "someday" }, DEFAULT_CONFIG);
    expect(bad.isError).toBe(true);
  });
});

describe("injection labels", () => {
  it("recall lines carry relative time and a (?) marker for low confidence; flags turn them off", async () => {
    const a = fresh();
    writeNode(a, "semantic", "Router model", "The router model is Kestrel X200", { deduplicate: false, confidence: "low" });
    const sure = writeNode(a, "semantic", "Router location", "The router sits in the Kestrel closet", { deduplicate: false, confidence: "high" });
    getDb(a).prepare("UPDATE nodes SET created_at = ? WHERE id = ?").run(Date.now() - 3 * 86_400_000, sure);
    const block = await buildRecallContext(a, "kestrel router", "s1", DEFAULT_CONFIG);
    expect(block).toMatch(/Kestrel X200 \(just now · low confidence \(\?\)\)/);
    expect(block).toMatch(/Kestrel closet \(3 days ago\)/);
    const off = await buildRecallContext(a, "kestrel router", "s2", { ...DEFAULT_CONFIG, beliefMetadata: false, relativeTimeLabels: false });
    expect(off).not.toMatch(/ago|\(\?\)/);
  });
});

describe("brain_status + footer", () => {
  it("reports counts, injection estimate, hot conflicts; footer only when attention is needed", async () => {
    const a = fresh();
    const x = writeNode(a, "semantic", "Tea", "Hailey likes green tea", { deduplicate: false });
    expect(buildStatusFooter(a, DEFAULT_CONFIG)).toBe("");
    const y = writeNode(a, "semantic", "No tea", "Hailey dislikes green tea", { deduplicate: false });
    writeEdge(a, x, y, "contradicts");
    runBeliefReviewPass(a, DEFAULT_CONFIG);
    const st = computeBrainStatus(getDb(a), DEFAULT_CONFIG);
    expect(st.beliefs.contradicted).toBe(2);
    expect(st.beliefs.flaggedForReview).toBe(2);
    expect(st.hotConflicts).toHaveLength(1);
    expect(st.injection.estimatedTokens).toBeGreaterThan(0);
    expect(st.attention.join(" ")).toMatch(/2 disputed beliefs/);
    expect(statusFooter(st)).toMatch(/^\[BRAIN: status\] 2 disputed beliefs/);
    expect(buildStatusFooter(a, { ...DEFAULT_CONFIG, selfStatus: false })).toBe("");
    const tool = await dispatchBrainTool("brain_status", a, {}, DEFAULT_CONFIG);
    expect(tool.text).toMatch(/hot conflicts:/);
    const json = JSON.parse((await dispatchBrainTool("brain_status", a, { format: "json" }, DEFAULT_CONFIG)).text);
    expect(json.beliefs.contradicted).toBe(2);
    // resolving the conflict by retracting one side clears attention for it
    retractNode(a, y, "she does like it");
    const st2 = computeBrainStatus(getDb(a), DEFAULT_CONFIG);
    expect(st2.hotConflicts).toHaveLength(0);
    expect(st2.nodes.retracted).toBe(1);
  });
});

describe("sleep belief review", () => {
  it("stamps contradictions, flags low confidence, records a sleep summary, and protects flagged nodes from pruning", async () => {
    const a = fresh();
    const keep = writeNode(a, "semantic", "Shaky claim", "unverified claim from a tool", { deduplicate: false, confidence: 0.2 });
    const drop = writeNode(a, "semantic", "Faded trivia", "some long-forgotten trivia", { deduplicate: false });
    getDb(a).prepare("UPDATE nodes SET retrievability = 0.001 WHERE id IN (?, ?)").run(keep, drop);
    await runConsolidation(a, DEFAULT_CONFIG, log);
    expect(getNode(a, keep)).not.toBeNull();
    expect(getNode(a, keep)!.review_flagged_at).not.toBeNull();
    expect(getNode(a, drop)).toBeFalsy();
    const s = getSleepSummary(a)!;
    expect(s.flaggedForReview).toBe(1);
    expect(s.pruned).toBe(1);
    expect(s.nodesBefore - s.nodesAfter).toBe(1);
    const st = computeBrainStatus(getDb(a), DEFAULT_CONFIG);
    expect(st.lastSleep.summary?.pruned).toBe(1);
    expect(st.lastSleep.ago).toBe("just now");
  });

  it("first sleep on a migrated brain flags legacy heartbeat / NO_REPLY noise for review (no retire, no delete)", async () => {
    const a = fresh();
    const noise = writeNode(a, "semantic", "NO_REPLY — 8:58 AM", "NO_REPLY — 8:58 AM Phoenix, daytime but nothing urgent in scope", { deduplicate: false });
    const wake = writeNode(a, "semantic", "wake", "[OpenClaw heartbeat poll] check in", { deduplicate: false });
    const real = writeNode(a, "semantic", "Router", "The router is in the hall closet", { deduplicate: false });
    const fresh2 = writeNode(a, "semantic", "NO_REPLY new", "NO_REPLY — written after v19 by the agent", { deduplicate: false });
    getDb(a).prepare("UPDATE nodes SET source_type = 'legacy' WHERE id IN (?, ?, ?)").run(noise, wake, real);
    await runConsolidation(a, DEFAULT_CONFIG, log);
    expect(getNode(a, noise)!.review_flagged_at).not.toBeNull();
    expect(getNode(a, noise)!.status).toBe("active");
    expect(getNode(a, noise)!.status_reason).toMatch(/legacy heartbeat/);
    expect(getNode(a, real)!.review_flagged_at).toBeNull();
    expect(getNode(a, fresh2)!.review_flagged_at).toBeNull();
    const s = getSleepSummary(a)!;
    expect(s.legacyNoiseFlagged).toBeGreaterThanOrEqual(1);
    expect((await dispatchBrainTool("brain_status", a, {}, DEFAULT_CONFIG)).text).toMatch(/look like legacy heartbeat\/NO_REPLY noise/);
    // idempotent: a second sleep does not re-count them
    await runConsolidation(a, DEFAULT_CONFIG, log);
    expect(getSleepSummary(a)!.legacyNoiseFlagged).toBe(0);
  });

  it("can be switched off", async () => {
    const a = fresh();
    const keep = writeNode(a, "semantic", "Shaky", "unverified", { deduplicate: false, confidence: 0.2 });
    await runConsolidation(a, { ...DEFAULT_CONFIG, sleepBeliefReview: false }, log);
    expect(getNode(a, keep)!.review_flagged_at).toBeNull();
  });

  it("retracted and superseded history survives the Deep prune", async () => {
    const a = fresh();
    const r = writeNode(a, "semantic", "Wrong", "wrong thing", { deduplicate: false });
    retractNode(a, r, "wrong");
    getDb(a).prepare("UPDATE nodes SET retrievability = 0.001 WHERE id = ?").run(r);
    await runConsolidation(a, DEFAULT_CONFIG, log);
    expect(getNode(a, r)).not.toBeNull();
    expect(relatedDownstream(getDb(a), r)).toEqual([]);
  });
});
