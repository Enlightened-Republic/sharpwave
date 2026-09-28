/**
 * Schema 18 — writer_agent_id provenance.
 *
 *  • fresh DBs get the column on nodes/episodes/edges + nodes_writer_agent index
 *  • write paths stamp it (default = brain's agentId; explicit override honoured)
 *  • consolidation stamps SYSTEM_SLEEP_WRITER ("system:sleep")
 *  • brain_write accepts optional writer_agent_id; query/history/expand expose it
 *  • v17 → v18 migration is additive + idempotent (synthetic DB)
 *  • v17 → v18 migration of a COPY of a real brain snapshot (box-local; skipped
 *    when the snapshot is absent). The snapshot itself is never opened.
 */
import { describe, it, expect, afterEach } from "vitest";
import { randomUUID, createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { getDb, closeDb, setMeta } from "../src/db.js";
import { writeNode, getNode, ftsSearchNodes } from "../src/nodes.js";
import { appendEpisode } from "../src/episodes.js";
import { writeEdge } from "../src/edges.js";
import { runConsolidation } from "../src/consolidation.js";
import { dispatchBrainTool } from "../src/tools.js";
import { validateBrainWrite } from "../src/validation.js";
import { DEFAULT_CONFIG, SYSTEM_SLEEP_WRITER } from "../src/types.js";

const log = { info: () => {}, warn: () => {}, error: () => {} };
const opened: string[] = [];
function fresh(prefix = "wai"): string {
  const id = `${prefix}-${randomUUID().slice(0, 8)}`;
  opened.push(id);
  return id;
}
afterEach(() => { for (const id of opened.splice(0)) closeDb(id); });

const cols = (db: Database.Database, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

describe("schema 18 — fresh DB", () => {
  it("has writer_agent_id on nodes, episodes, edges and the nodes index", () => {
    const db = getDb(fresh());
    expect(cols(db, "nodes")).toContain("writer_agent_id");
    expect(cols(db, "episodes")).toContain("writer_agent_id");
    expect(cols(db, "edges")).toContain("writer_agent_id");
    const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='nodes_writer_agent'").get();
    expect(idx).toBeTruthy();
    expect((db.prepare("SELECT version FROM schema_version").get() as { version: number }).version).toBe(18);
  });
});

describe("write paths stamp writer_agent_id", () => {
  it("writeNode / appendEpisode / writeEdge default to the brain's agentId", () => {
    const id = fresh();
    const db = getDb(id);
    const a = writeNode(id, "semantic", "alpha", "alpha content for provenance", { deduplicate: false });
    const b = writeNode(id, "semantic", "beta", "beta content for provenance", { deduplicate: false });
    const ep = appendEpisode(id, "s1", "user", "hello provenance");
    const e = writeEdge(id, a, b, "associates");
    expect(getNode(id, a)!.writer_agent_id).toBe(id);
    expect(db.prepare("SELECT writer_agent_id AS w FROM episodes WHERE id = ?").get(ep)).toEqual({ w: id });
    expect(db.prepare("SELECT writer_agent_id AS w FROM edges WHERE id = ?").get(e)).toEqual({ w: id });
  });

  it("explicit writerAgentId overrides the default", () => {
    const id = fresh();
    const db = getDb(id);
    const a = writeNode(id, "semantic", "gamma", "gamma content", { deduplicate: false, writerAgentId: "hailey" });
    const b = writeNode(id, "semantic", "delta", "delta content", { deduplicate: false, writerAgentId: "marley" });
    const ep = appendEpisode(id, "s1", "assistant", "reply", 0.5, undefined, { writerAgentId: "marley" });
    const e = writeEdge(id, a, b, "supports", { writerAgentId: "hailey" });
    expect(getNode(id, a)!.writer_agent_id).toBe("hailey");
    expect(getNode(id, b)!.writer_agent_id).toBe("marley");
    expect(db.prepare("SELECT writer_agent_id AS w FROM episodes WHERE id = ?").get(ep)).toEqual({ w: "marley" });
    expect(db.prepare("SELECT writer_agent_id AS w FROM edges WHERE id = ?").get(e)).toEqual({ w: "hailey" });
  });

  it("a dedupe merge keeps the canonical node's original writer (writer = creator)", () => {
    const id = fresh();
    const content = "The staging cluster runs on three m7g.large nodes in us-west-2.";
    const first = writeNode(id, "semantic", "staging", content, { writerAgentId: "hailey" });
    const second = writeNode(id, "semantic", "staging", content, { writerAgentId: "marley" });
    expect(second).toBe(first);
    expect(getNode(id, first)!.writer_agent_id).toBe("hailey");
  });

  it("consolidation-created nodes are stamped system:sleep", async () => {
    const id = fresh();
    const db = getDb(id);
    for (let i = 0; i < 4; i++) {
      appendEpisode(id, "s-sleep", "user",
        `I prefer running database migrations on staging first before production rollout number ${i}.`, 0.8);
    }
    setMeta(id, "last_consolidation", String(Date.now() - 8 * 24 * 3600 * 1000));
    await runConsolidation(id, { ...DEFAULT_CONFIG, openRouterApiKey: "" }, log);

    const sleepNodes = db.prepare(
      "SELECT source, writer_agent_id AS w FROM nodes WHERE source IN ('sws','nexus','rem','rem-generative')",
    ).all() as Array<{ source: string; w: string | null }>;
    expect(sleepNodes.length).toBeGreaterThan(0);
    for (const n of sleepNodes) expect(n.w).toBe(SYSTEM_SLEEP_WRITER);
    // episodes appended by the agent keep the agent's own stamp
    const epWriters = db.prepare("SELECT DISTINCT writer_agent_id AS w FROM episodes").all();
    expect(epWriters).toEqual([{ w: id }]);
  });
});

describe("tool dispatch", () => {
  it("brain_write defaults writer_agent_id to the agent, accepts an override, and surfaces it", async () => {
    const id = fresh();
    const r1 = await dispatchBrainTool("brain_write", id, {
      type: "semantic", label: "db engine", content: "The production database is PostgreSQL 16 on RDS.",
    }, DEFAULT_CONFIG);
    expect(r1.isError).toBeFalsy();
    expect(r1.text).toContain(`writer=${id}`);
    const nodeId1 = /node ([0-9a-f-]{36})/.exec(r1.text)![1];
    expect(getNode(id, nodeId1)!.writer_agent_id).toBe(id);

    const r2 = await dispatchBrainTool("brain_write", id, {
      type: "semantic", label: "cache", content: "The cache layer is Redis 7 on ElastiCache.", writer_agent_id: "hailey",
    }, DEFAULT_CONFIG);
    const nodeId2 = /node ([0-9a-f-]{36})/.exec(r2.text)![1];
    expect(getNode(id, nodeId2)!.writer_agent_id).toBe("hailey");

    const q = await dispatchBrainTool("brain_query", id, { query: "Redis ElastiCache" }, DEFAULT_CONFIG);
    expect(q.text).toContain("writer=hailey");

    const x = await dispatchBrainTool("brain_expand", id, { node_id: nodeId2 }, DEFAULT_CONFIG);
    expect(x.text).toContain("Writer: hailey");

    appendEpisode(id, "s-hist", "user", "We migrated the zebrafish pipeline yesterday", 0.6, undefined, { writerAgentId: "marley" });
    const h = await dispatchBrainTool("brain_history", id, { query: "zebrafish" }, DEFAULT_CONFIG);
    expect(h.text).toContain("writer=marley");
  });

  it("brain_supersede stamps the replacement with the agent", async () => {
    const id = fresh();
    const oldId = writeNode(id, "semantic", "region", "Primary region is us-east-1.", { writerAgentId: "hailey" });
    const r = await dispatchBrainTool("brain_supersede", id, { old_node_id: oldId, new_content: "Primary region is us-west-2." }, DEFAULT_CONFIG);
    expect(r.isError).toBeFalsy();
    const db = getDb(id);
    const newest = db.prepare("SELECT writer_agent_id AS w FROM nodes WHERE content = 'Primary region is us-west-2.'").get();
    expect(newest).toEqual({ w: id });
  });

  it("validation: writer_agent_id must be a string ≤128 chars; empty falls back to default", () => {
    expect(validateBrainWrite({ type: "semantic", label: "l", content: "c", writer_agent_id: 42 }).ok).toBe(false);
    expect(validateBrainWrite({ type: "semantic", label: "l", content: "c", writer_agent_id: "x".repeat(129) }).ok).toBe(false);
    const empty = validateBrainWrite({ type: "semantic", label: "l", content: "c", writer_agent_id: "  " });
    expect(empty.ok).toBe(true);
    expect(empty.data!.writer_agent_id).toBeUndefined();
  });
});

describe("v17 → v18 migration (synthetic)", () => {
  it("is additive + idempotent: legacy rows stay NULL, new writes are stamped", () => {
    const id = fresh("wai-mig");
    const db1 = getDb(id);
    // Simulate an on-disk v17 brain: drop the v18 index + columns, rewind version.
    db1.exec("DROP INDEX IF EXISTS nodes_writer_agent");
    db1.exec("ALTER TABLE nodes DROP COLUMN writer_agent_id");
    db1.exec("ALTER TABLE episodes DROP COLUMN writer_agent_id");
    db1.exec("ALTER TABLE edges DROP COLUMN writer_agent_id");
    db1.exec("DELETE FROM schema_version");
    db1.exec("INSERT INTO schema_version VALUES (17)");
    const now = Date.now();
    db1.prepare("INSERT INTO nodes (id, type, label, content, created_at, accessed_at, updated_at) VALUES ('legacy-a','semantic','a','legacy a',?,?,?)").run(now, now, now);
    db1.prepare("INSERT INTO nodes (id, type, label, content, created_at, accessed_at, updated_at) VALUES ('legacy-b','semantic','b','legacy b',?,?,?)").run(now, now, now);
    db1.prepare("INSERT INTO edges (id, from_id, to_id, type, valid_from, learned_at, created_at) VALUES ('legacy-e','legacy-a','legacy-b','supports',?,?,?)").run(now, now, now);
    db1.prepare("INSERT INTO episodes (id, session_id, role, content, created_at) VALUES ('legacy-ep','s','user','legacy episode',?)").run(now);
    expect(cols(db1, "nodes")).not.toContain("writer_agent_id");
    closeDb(id);

    const db2 = getDb(id);
    expect((db2.prepare("SELECT version FROM schema_version").get() as { version: number }).version).toBe(18);
    for (const t of ["nodes", "episodes", "edges"]) expect(cols(db2, t)).toContain("writer_agent_id");
    expect(db2.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='nodes_writer_agent'").get()).toBeTruthy();
    expect(db2.prepare("SELECT COUNT(*) AS n FROM nodes WHERE writer_agent_id IS NULL").get()).toEqual({ n: 2 });
    expect(db2.prepare("SELECT writer_agent_id AS w FROM edges WHERE id='legacy-e'").get()).toEqual({ w: null });
    expect(db2.prepare("SELECT writer_agent_id AS w FROM episodes WHERE id='legacy-ep'").get()).toEqual({ w: null });
    const n = writeNode(id, "semantic", "post", "post-migration write", { deduplicate: false });
    expect(getNode(id, n)!.writer_agent_id).toBe(id);
    closeDb(id);

    // third open: already at target — no-op
    expect(() => { getDb(id).prepare("SELECT 1").get(); closeDb(id); }).not.toThrow();
  });
});

// ── Real snapshot (box-local) ────────────────────────────────────────────────
const SNAPSHOT = process.env["SHARPWAVE_TEST_SNAPSHOT_DB"] ?? "/workspace/brain-snap/main/brain.db";
const HAVE_SNAPSHOT = existsSync(SNAPSHOT);

function sha256(path: string): string | null {
  return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
}

describe.skipIf(!HAVE_SNAPSHOT)("v17 → v18 migration on a COPY of a real brain snapshot", () => {
  it("counts unchanged, column present, new writes stamped; source untouched", () => {
    const srcHashes = ["", "-wal", "-shm"].map((s) => sha256(SNAPSHOT + s));
    const dir = mkdtempSync(join(tmpdir(), "sw-snap-mig-"));
    const copy = join(dir, "brain.db");
    try {
      for (const suffix of ["", "-wal", "-shm"]) {
        if (existsSync(SNAPSHOT + suffix)) copyFileSync(SNAPSHOT + suffix, copy + suffix);
      }

      // Pre-migration census on the COPY.
      const pre = new Database(copy);
      const census = (d: Database.Database) => ({
        nodes: (d.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number }).n,
        edges: (d.prepare("SELECT COUNT(*) AS n FROM edges").get() as { n: number }).n,
        episodes: (d.prepare("SELECT COUNT(*) AS n FROM episodes").get() as { n: number }).n,
      });
      const before = census(pre);
      const verBefore = (pre.prepare("SELECT version FROM schema_version").get() as { version: number }).version;
      const sampleLabel = (pre.prepare("SELECT label FROM nodes WHERE length(label) > 8 LIMIT 1").get() as { label: string } | undefined)?.label;
      pre.close();
      expect(verBefore).toBe(17);

      const agentId = "snapmig";
      const prevPath = process.env["SHARPWAVE_DB_PATH"];
      process.env["SHARPWAVE_DB_PATH"] = copy;
      let db: Database.Database;
      const t0 = performance.now();
      try { db = getDb(agentId); } finally {
        if (prevPath === undefined) delete process.env["SHARPWAVE_DB_PATH"]; else process.env["SHARPWAVE_DB_PATH"] = prevPath;
      }
      const migrateMs = performance.now() - t0;

      try {
        expect((db.prepare("SELECT version FROM schema_version").get() as { version: number }).version).toBe(18);
        expect(census(db)).toEqual(before);
        for (const t of ["nodes", "episodes", "edges"]) expect(cols(db, t)).toContain("writer_agent_id");
        expect(db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE writer_agent_id IS NOT NULL").get()).toEqual({ n: 0 });
        expect(db.prepare("SELECT COUNT(*) AS n FROM episodes WHERE writer_agent_id IS NOT NULL").get()).toEqual({ n: 0 });
        expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
        if (sampleLabel) expect(ftsSearchNodes(agentId, sampleLabel, 3).length).toBeGreaterThan(0);

        const n = writeNode(agentId, "semantic", "snap post-migration", "written after v18 migration of snapshot copy", { deduplicate: false });
        const ep = appendEpisode(agentId, "snap-s", "user", "snapshot copy post-migration episode");
        expect(getNode(agentId, n)!.writer_agent_id).toBe(agentId);
        expect(db.prepare("SELECT writer_agent_id AS w FROM episodes WHERE id = ?").get(ep)).toEqual({ w: agentId });
        expect(census(db)).toEqual({ ...before, nodes: before.nodes + 1, episodes: before.episodes + 1 });
        // eslint-disable-next-line no-console
        console.log(`[snapshot-migration] before=${JSON.stringify(before)} migrateMs=${migrateMs.toFixed(1)}`);
      } finally {
        closeDb(agentId);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // The real snapshot was never opened — bytes identical.
    expect(["", "-wal", "-shm"].map((s) => sha256(SNAPSHOT + s))).toEqual(srcHashes);
  });
});
