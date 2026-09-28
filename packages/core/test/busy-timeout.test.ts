/**
 * busy_timeout + multi-connection / multi-process concurrency (0.4.5).
 *
 * The single-writer-per-brain contract is unchanged (README) — these tests pin
 * that when two connections or processes DO touch one brain.db (e.g. a stray
 * second server, the openwave plugin + an MCP server during migration to the
 * shared-brain service), short lock waits are absorbed by SQLite's
 * busy_timeout instead of surfacing SQLITE_BUSY, and no write is lost.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { getDb, closeDb, resolveBusyTimeoutMs, DEFAULT_BUSY_TIMEOUT_MS } from "../src/db.js";
import { writeNode } from "../src/nodes.js";
import { appendEpisode } from "../src/episodes.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    prev[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try { return fn(); } finally {
    for (const k of Object.keys(prev)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

describe("resolveBusyTimeoutMs", () => {
  it("defaults to 5000", () => {
    withEnv({ SHARPWAVE_BUSY_TIMEOUT_MS: undefined }, () => {
      expect(DEFAULT_BUSY_TIMEOUT_MS).toBe(5000);
      expect(resolveBusyTimeoutMs()).toBe(5000);
    });
  });
  it("honours SHARPWAVE_BUSY_TIMEOUT_MS, explicit override wins", () => {
    withEnv({ SHARPWAVE_BUSY_TIMEOUT_MS: "1234" }, () => {
      expect(resolveBusyTimeoutMs()).toBe(1234);
      expect(resolveBusyTimeoutMs(250)).toBe(250);
      expect(resolveBusyTimeoutMs(0)).toBe(0);
    });
  });
  it("falls back to default on garbage / negative, clamps huge values", () => {
    withEnv({ SHARPWAVE_BUSY_TIMEOUT_MS: "banana" }, () => expect(resolveBusyTimeoutMs()).toBe(5000));
    withEnv({ SHARPWAVE_BUSY_TIMEOUT_MS: "-5" }, () => expect(resolveBusyTimeoutMs()).toBe(5000));
    withEnv({ SHARPWAVE_BUSY_TIMEOUT_MS: undefined }, () => {
      expect(resolveBusyTimeoutMs(Number.NaN)).toBe(5000);
      expect(resolveBusyTimeoutMs(10_000_000)).toBe(600_000);
    });
  });
});

describe("getDb applies PRAGMA busy_timeout", () => {
  const ids: string[] = [];
  afterEach(() => { for (const id of ids.splice(0)) closeDb(id); });

  it("default connection has busy_timeout = 5000 and WAL", () => {
    const id = `bt-default-${randomUUID().slice(0, 8)}`; ids.push(id);
    const db = withEnv({ SHARPWAVE_BUSY_TIMEOUT_MS: undefined }, () => getDb(id));
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
  });

  it("env and explicit option are applied on first open", () => {
    const a = `bt-env-${randomUUID().slice(0, 8)}`; ids.push(a);
    const b = `bt-opt-${randomUUID().slice(0, 8)}`; ids.push(b);
    const dbA = withEnv({ SHARPWAVE_BUSY_TIMEOUT_MS: "777" }, () => getDb(a));
    expect(dbA.pragma("busy_timeout", { simple: true })).toBe(777);
    const dbB = getDb(b, { busyTimeoutMs: 1500 });
    expect(dbB.pragma("busy_timeout", { simple: true })).toBe(1500);
  });
});

describe("two connections, one brain file", () => {
  let dir = "";
  afterEach(() => {
    closeDb("bt-conn-a"); closeDb("bt-conn-b");
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("interleaved writes + cross-connection reads: no SQLITE_BUSY, every row lands", () => {
    dir = mkdtempSync(join(tmpdir(), "sw-bt-conn-"));
    const path = join(dir, "brain.db");
    const [a, b] = withEnv({ SHARPWAVE_DB_PATH: path }, () => [getDb("bt-conn-a"), getDb("bt-conn-b")]);
    expect(a).not.toBe(b);

    const N = 100;
    for (let i = 0; i < N; i++) {
      const writer = i % 2 === 0 ? "bt-conn-a" : "bt-conn-b";
      const reader = i % 2 === 0 ? b : a;
      const nodeId = writeNode(writer, "semantic", `conn node ${i}`, `two-connection node ${i}`, { deduplicate: false });
      const epId = appendEpisode(writer, "s-conn", "user", `two-connection episode ${i}`, 0.5);
      // read-after-write through the OTHER connection
      expect(reader.prepare("SELECT writer_agent_id AS w FROM nodes WHERE id = ?").get(nodeId)).toEqual({ w: writer });
      expect(reader.prepare("SELECT 1 AS ok FROM episodes WHERE id = ?").get(epId)).toEqual({ ok: 1 });
    }

    // A long-lived read snapshot on B does not block writes on A (WAL).
    const snap = b.transaction(() => {
      const before = (b.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number }).n;
      writeNode("bt-conn-a", "semantic", "during snapshot", "written while B holds a read txn", { deduplicate: false });
      const inside = (b.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number }).n;
      return { before, inside };
    });
    const { before, inside } = snap.deferred();
    expect(inside).toBe(before); // snapshot isolation held

    const counts = a.prepare(`
      SELECT (SELECT COUNT(*) FROM nodes) AS nodes, (SELECT COUNT(*) FROM episodes) AS episodes
    `).get() as { nodes: number; episodes: number };
    expect(counts).toEqual({ nodes: N + 1, episodes: N });
    expect(a.pragma("integrity_check", { simple: true })).toBe("ok");
  });
});

describe("multiple processes, one brain file", () => {
  let dir = "";
  afterEach(() => {
    closeDb("bt-parent");
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  it("two child processes + parent interleave writes/reads: no SQLITE_BUSY, all rows land", async () => {
    dir = mkdtempSync(join(tmpdir(), "sw-bt-proc-"));
    const path = join(dir, "brain.db");
    // Create + migrate once up front so children don't race schema init.
    const parentDb = withEnv({ SHARPWAVE_DB_PATH: path }, () => getDb("bt-parent"));

    const req = createRequire(import.meta.url);
    const viteNode = join(dirname(req.resolve("vite-node/package.json")), "vite-node.mjs");
    const fixture = join(HERE, "fixtures", "busy-writer.ts");
    const ITERS = 30;
    const startAt = Date.now() + 1200; // common barrier after child startup

    const runChild = (tag: string) => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn(process.execPath, [viteNode, fixture], {
        env: {
          ...process.env,
          SHARPWAVE_DB_PATH: path,
          SHARPWAVE_BUSY_TIMEOUT_MS: "5000",
          BUSY_TAG: tag,
          BUSY_ITERS: String(ITERS),
          BUSY_START_AT: String(startAt),
          BUSY_HOLD_MS: "10",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = ""; let err = "";
      child.stdout.on("data", (d) => { out += d; });
      child.stderr.on("data", (d) => { err += d; });
      child.on("close", (code) => resolve({ code, out, err }));
    });

    const children = [runChild("proc-a"), runChild("proc-b")];

    // Parent joins the fray from its own connection, yielding between steps so
    // it can also collect child output.
    while (Date.now() < startAt) await new Promise((r) => setTimeout(r, 10));
    let parentBusy = 0;
    const PARENT_ITERS = 40;
    for (let i = 0; i < PARENT_ITERS; i++) {
      try {
        writeNode("bt-parent", "semantic", `parent node ${i}`, `parent stress node ${i}`, { deduplicate: false });
        parentDb.prepare("SELECT COUNT(*) FROM episodes").get();
      } catch (e) {
        if (/BUSY|locked/i.test(String(e))) parentBusy++;
        throw e;
      }
      await new Promise((r) => setImmediate(r));
    }

    const results = await Promise.all(children);
    const reports = results.map((r) => {
      expect(r.code, r.err).toBe(0);
      const line = r.out.trim().split("\n").pop() ?? "{}";
      return JSON.parse(line) as {
        tag: string; busyTimeout: number; nodes: number; episodes: number; busy: number; errors: string[];
        waits: number; maxWaitMs: number; walRetries: number;
      };
    });

    for (const rep of reports) {
      expect(rep.errors, `${rep.tag}: ${rep.errors.join(" | ")}`).toEqual([]);
      expect(rep.busy).toBe(0);
      expect(rep.busyTimeout).toBe(5000);
      expect(rep.nodes).toBe(ITERS);
      // busy_timeout absorbed every wait; the wal-retry backstop never fired.
      expect(rep.walRetries).toBe(0);
    }
    expect(parentBusy).toBe(0);
    // The two children each hold the write lock ~10ms per iteration from a
    // common start barrier, so they MUST have waited on each other at least
    // once — otherwise this test would not be exercising contention at all.
    expect(reports.reduce((s, r) => s + r.waits, 0)).toBeGreaterThan(0);

    const perWriter = parentDb.prepare(
      "SELECT writer_agent_id AS w, COUNT(*) AS n FROM nodes GROUP BY writer_agent_id ORDER BY w",
    ).all();
    expect(perWriter).toEqual([
      { w: "bt-parent", n: PARENT_ITERS },
      { w: "proc-a", n: ITERS },
      { w: "proc-b", n: ITERS },
    ]);
    const expectedEpisodesPerChild = ITERS * 6; // 1 appendEpisode + 5 raw rows per iteration
    const epPerWriter = parentDb.prepare(
      "SELECT writer_agent_id AS w, COUNT(*) AS n FROM episodes GROUP BY writer_agent_id ORDER BY w",
    ).all();
    expect(epPerWriter).toEqual([
      { w: "proc-a", n: expectedEpisodesPerChild },
      { w: "proc-b", n: expectedEpisodesPerChild },
    ]);
    expect(parentDb.pragma("integrity_check", { simple: true })).toBe("ok");
  }, 15_000);
});
