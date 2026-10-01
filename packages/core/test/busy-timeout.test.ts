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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

  // busy_timeout handed to every process in this test (children via env,
  // parent via getDb option). Must comfortably exceed LOCK_HOLD_MS. Setting
  // this to 0 MUST make the test fail (SQLITE_BUSY in the waiters) — that is
  // the negative check that proves the test exercises busy_timeout at all.
  const BUSY_TIMEOUT_MS = 5000;
  // How long the holder keeps BEGIN IMMEDIATE open after signalling `held`.
  const LOCK_HOLD_MS = 600;

  it("two child processes + parent interleave writes/reads: no SQLITE_BUSY, all rows land", async () => {
    dir = mkdtempSync(join(tmpdir(), "sw-bt-proc-"));
    const path = join(dir, "brain.db");
    const lockDir = join(dir, "lock");
    mkdirSync(lockDir);
    // Create + migrate once up front so children don't race schema init.
    const parentDb = withEnv({ SHARPWAVE_DB_PATH: path }, () => getDb("bt-parent", { busyTimeoutMs: BUSY_TIMEOUT_MS }));
    expect(parentDb.pragma("busy_timeout", { simple: true })).toBe(BUSY_TIMEOUT_MS);

    const req = createRequire(import.meta.url);
    const viteNode = join(dirname(req.resolve("vite-node/package.json")), "vite-node.mjs");
    const runChild = (fixtureName: string, env: Record<string, string>) =>
      new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
        const child = spawn(process.execPath, [viteNode, join(HERE, "fixtures", fixtureName)], {
          env: { ...process.env, SHARPWAVE_DB_PATH: path, SHARPWAVE_BUSY_TIMEOUT_MS: String(BUSY_TIMEOUT_MS), ...env },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let out = ""; let err = "";
        child.stdout.on("data", (d) => { out += d; });
        child.stderr.on("data", (d) => { err += d; });
        child.on("close", (code) => resolve({ code, out, err }));
      });
    const lastJson = <T,>(r: { code: number | null; out: string; err: string }): T => {
      expect(r.code, r.err).toBe(0);
      return JSON.parse(r.out.trim().split("\n").pop() ?? "{}") as T;
    };

    // ── Phase 1: deterministic contention ────────────────────────────────
    // proc-a takes BEGIN IMMEDIATE and signals `held` (file) while holding it
    // for LOCK_HOLD_MS. proc-b and the parent wait for `held`, then attempt
    // their own BEGIN IMMEDIATE write. Neither can acquire the lock until
    // proc-a commits, so both MUST wait — no timing luck involved.
    const lockEnv = { LOCK_DIR: lockDir, LOCK_HOLD_MS: String(LOCK_HOLD_MS) };
    const holder = runChild("lock-handshake.ts", { ...lockEnv, LOCK_TAG: "proc-a", LOCK_MODE: "hold", LOCK_WAITERS: "proc-b,bt-parent" });
    const waiter = runChild("lock-handshake.ts", { ...lockEnv, LOCK_TAG: "proc-b", LOCK_MODE: "wait" });

    writeFileSync(join(lockDir, "ready-bt-parent"), String(process.pid));
    const handshakeDeadline = Date.now() + 20_000;
    while (!existsSync(join(lockDir, "held"))) {
      if (Date.now() > handshakeDeadline) throw new Error("lock holder never signalled `held`");
      await new Promise((r) => setTimeout(r, 5));
    }
    // The lock is held right now. This BEGIN IMMEDIATE blocks (synchronously,
    // inside SQLite's busy handler) until proc-a commits.
    const parentInsert = parentDb.prepare(
      "INSERT INTO episodes (id, session_id, role, content, importance, tokens, ripple_count, created_at, meta, writer_agent_id) VALUES (?, ?, 'tool', ?, 0.3, 1, 0, ?, NULL, ?)",
    );
    const parentBeginAt = Date.now();
    let parentAcquiredAt = 0;
    let parentError = "";
    try {
      parentDb.transaction(() => {
        parentAcquiredAt = Date.now();
        parentInsert.run("bt-parent-after-lock", "lock:bt-parent", "lock waiter bt-parent", Date.now(), "bt-parent");
      }).immediate();
    } catch (e) {
      parentError = String(e);
    }

    type HoldReport = { tag: string; busyTimeout: number; lockedAt: number; commitAt: number; errors: string[] };
    type WaitReport = { tag: string; busyTimeout: number; beginAt: number; acquiredAt: number; waitedMs: number; busy: number; errors: string[] };
    const [holdRes, waitRes] = await Promise.all([holder, waiter]);
    const hold = lastJson<HoldReport>(holdRes);
    const wait = lastJson<WaitReport>(waitRes);

    expect(hold.errors, `proc-a: ${hold.errors.join(" | ")}`).toEqual([]);
    expect(wait.errors, `proc-b: ${wait.errors.join(" | ")}`).toEqual([]);
    expect(parentError, "parent BEGIN IMMEDIATE while proc-a held the lock").toBe("");
    expect(hold.busyTimeout).toBe(BUSY_TIMEOUT_MS);
    expect(wait.busyTimeout).toBe(BUSY_TIMEOUT_MS);
    expect(wait.busy).toBe(0);
    // Both waiters acquired the write lock only after proc-a released it
    // (10ms slack for Date.now() granularity across processes)…
    expect(hold.commitAt - hold.lockedAt).toBeGreaterThanOrEqual(LOCK_HOLD_MS - 10);
    expect(wait.acquiredAt).toBeGreaterThanOrEqual(hold.commitAt - 10);
    expect(parentAcquiredAt).toBeGreaterThanOrEqual(hold.commitAt - 10);
    // …which means each of them genuinely waited on busy_timeout.
    expect(wait.acquiredAt - wait.beginAt).toBeGreaterThan(0);
    expect(parentAcquiredAt - parentBeginAt).toBeGreaterThan(0);

    // ── Phase 2: interleaved stress (no-loss / no-BUSY under real churn) ──
    // Contention here is opportunistic (scheduler-dependent), so we assert
    // only outcomes that must hold regardless of interleaving; the
    // "must actually have waited" proof lives in phase 1.
    const fixture = "busy-writer.ts";
    const ITERS = 30;
    const startAt = Date.now() + 1200; // common barrier after child startup
    const stressEnv = (tag: string) => ({
      BUSY_TAG: tag,
      BUSY_ITERS: String(ITERS),
      BUSY_START_AT: String(startAt),
      BUSY_HOLD_MS: "10",
    });
    const children = [runChild(fixture, stressEnv("proc-a")), runChild(fixture, stressEnv("proc-b"))];

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

    const reports = (await Promise.all(children)).map((r) => lastJson<{
      tag: string; busyTimeout: number; nodes: number; episodes: number; busy: number; errors: string[];
      waits: number; maxWaitMs: number; walRetries: number;
    }>(r));

    for (const rep of reports) {
      expect(rep.errors, `${rep.tag}: ${rep.errors.join(" | ")}`).toEqual([]);
      expect(rep.busy).toBe(0);
      expect(rep.busyTimeout).toBe(BUSY_TIMEOUT_MS);
      expect(rep.nodes).toBe(ITERS);
      // busy_timeout absorbed every wait; the wal-retry backstop never fired.
      expect(rep.walRetries).toBe(0);
    }
    expect(parentBusy).toBe(0);

    const perWriter = parentDb.prepare(
      "SELECT writer_agent_id AS w, COUNT(*) AS n FROM nodes GROUP BY writer_agent_id ORDER BY w",
    ).all();
    expect(perWriter).toEqual([
      { w: "bt-parent", n: PARENT_ITERS },
      { w: "proc-a", n: ITERS },
      { w: "proc-b", n: ITERS },
    ]);
    // phase 2: 1 appendEpisode + 5 raw rows per iteration; phase 1: 1 row each.
    const expectedEpisodesPerChild = ITERS * 6 + 1;
    const epPerWriter = parentDb.prepare(
      "SELECT writer_agent_id AS w, COUNT(*) AS n FROM episodes GROUP BY writer_agent_id ORDER BY w",
    ).all();
    expect(epPerWriter).toEqual([
      { w: "bt-parent", n: 1 },
      { w: "proc-a", n: expectedEpisodesPerChild },
      { w: "proc-b", n: expectedEpisodesPerChild },
    ]);
    expect(parentDb.pragma("integrity_check", { simple: true })).toBe("ok");
  }, 30_000);
});
