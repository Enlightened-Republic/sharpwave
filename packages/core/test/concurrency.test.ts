/**
 * Concurrency tests — exercises code-2 C2.1 .. C2.5 scenarios.
 *
 * Node.js is single-threaded but `await` boundaries let other handlers run
 * between statements. better-sqlite3 is synchronous per-statement, so true
 * row-level races are limited — but cross-statement async interleaving can
 * still corrupt invariants. These tests cover the realistic risk surface.
 *
 * C2.1 — Two `appendEpisode` calls in parallel for the same agent
 * C2.2 — `runConsolidation` interleaved with `appendEpisode` (no FTS dropouts)
 * C2.3 — Reconsolidation under concurrent content write (lost-update test)
 * C2.4 — Bootstrap cache leak: open 300 sessions without proper end, assert LRU cap holds
 */

import { describe, it, expect, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { rmSync } from "node:fs";
import { getDb, closeDb } from "../src/db.js";
import { writeNode } from "../src/nodes.js";
import { appendEpisode, getRecentEpisodes, searchEpisodes } from "../src/episodes.js";
import { runConsolidation } from "../src/consolidation.js";
import { DEFAULT_CONFIG } from "../src/types.js";

function agentDir(id: string) { return join(process.env["SHARPWAVE_DATA_DIR"] || join(homedir(), ".sharpwave"), id); }
function cleanupAgent(id: string) {
  try { closeDb(id); } catch { /* ok */ }
  try { rmSync(agentDir(id), { recursive: true, force: true }); } catch { /* ok */ }
}

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

// ─────────────────────────────────────────────────────────────────────────────
// C2.1 — Two appendEpisode calls in parallel
// ─────────────────────────────────────────────────────────────────────────────

describe("concurrency — C2.1: parallel appendEpisode for the same agent", () => {
  const agentId = `c21-${randomUUID().slice(0, 8)}`;
  afterEach(() => cleanupAgent(agentId));

  it("both rows persist when two appendEpisode promises resolve in parallel", async () => {
    getDb(agentId);
    const sessionA = "session-A";
    const sessionB = "session-B";

    const [idA, idB] = await Promise.all([
      Promise.resolve().then(() => appendEpisode(agentId, sessionA, "user", "Concurrent message from channel A — unique-marker-aaa.", 0.6)),
      Promise.resolve().then(() => appendEpisode(agentId, sessionB, "user", "Concurrent message from channel B — unique-marker-bbb.", 0.6)),
    ]);
    expect(idA).not.toBe(idB);

    const recent = getRecentEpisodes(agentId, 5);
    const ids = new Set(recent.map((e) => e.id));
    expect(ids.has(idA)).toBe(true);
    expect(ids.has(idB)).toBe(true);
  });

  it("20 parallel appendEpisode calls produce 20 distinct rows", async () => {
    getDb(agentId);
    const promises: Array<Promise<string>> = [];
    for (let i = 0; i < 20; i++) {
      promises.push(
        Promise.resolve().then(() =>
          appendEpisode(agentId, "burst-session", "user", `Burst message ${i} content for parallel insertion test.`, 0.5)
        ),
      );
    }
    const ids = await Promise.all(promises);
    expect(new Set(ids).size).toBe(20);
    const recent = getRecentEpisodes(agentId, 25);
    const recentIds = new Set(recent.map((e) => e.id));
    for (const id of ids) {
      expect(recentIds.has(id)).toBe(true);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C2.2 — runConsolidation + appendEpisode interleaved: no FTS index dropout
// ─────────────────────────────────────────────────────────────────────────────

describe("concurrency — C2.2: appendEpisode during runConsolidation does not drop FTS rows", () => {
  const agentId = `c22-${randomUUID().slice(0, 8)}`;
  afterEach(() => cleanupAgent(agentId));

  it("episodes appended during consolidation remain searchable via FTS", async () => {
    getDb(agentId);
    // Pre-seed enough episodes to make consolidation non-trivial
    for (let i = 0; i < 6; i++) {
      appendEpisode(
        agentId, "pre-cons-session", i % 2 === 0 ? "user" : "assistant",
        `Pre-consolidation episode ${i} about config debug memory and goal pressure.`, 0.55,
      );
    }

    // Kick off consolidation and append racing episodes with unique tokens
    const consolidationPromise = runConsolidation(agentId, DEFAULT_CONFIG, silentLog);

    const racingTokens: string[] = [];
    const racingPromises: Array<Promise<string>> = [];
    for (let i = 0; i < 8; i++) {
      const token = `mid-flight-token-${i}-${randomUUID().slice(0, 6)}`;
      racingTokens.push(token);
      racingPromises.push(
        new Promise<string>((r) => setImmediate(() => {
          r(appendEpisode(agentId, "racing-session", "user",
            `Racing message ${i}: contains ${token} for FTS verification.`, 0.6));
        })),
      );
    }

    await consolidationPromise;
    await Promise.all(racingPromises);

    // Every racing-token episode must be searchable in FTS
    let missing = 0;
    for (const tok of racingTokens) {
      const hits = searchEpisodes(agentId, tok, 5);
      if (hits.length === 0) missing++;
    }
    expect(missing).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C2.3 — Reconsolidation content append vs concurrent content write
// Verifies the `content || ?` append-style fix (Agent B is shipping). If
// Agent B has not yet landed the fix in consolidation.ts, this test asserts
// at least that BOTH writes left observable traces (i.e. content extended,
// not silently overwritten in their entirety).
// ─────────────────────────────────────────────────────────────────────────────

describe("concurrency — C2.3: reconsolidation under concurrent content write (lost-update probe)", () => {
  const agentId = `c23-${randomUUID().slice(0, 8)}`;
  afterEach(() => cleanupAgent(agentId));

  // NOTE (Step G): the clawbrain-v4 "concurrent content edits both land" case was
  // an it.skip stub gated on a hypothetical future Agent-B change to
  // consolidation.ts reconsolidation (`SET content = content || ?`). sharpwave's
  // engine has no such pending change, so the stub is dropped. The serial control
  // below (reconsolidation must not destroy content) is the real, portable invariant.

  it("control: serial reconsolidation does not destroy content", async () => {
    const db = getDb(agentId);
    const nodeId = writeNode(agentId, "semantic", "serial reconsolidation control",
      "base content for the serial reconsolidation control test", { importance: 0.6 });
    db.prepare("UPDATE nodes SET access_count = 5, eligibility_trace = 0.9 WHERE id = ?").run(nodeId);
    await runConsolidation(agentId, DEFAULT_CONFIG, silentLog);
    const after = (db.prepare("SELECT content FROM nodes WHERE id = ?").get(nodeId) as { content: string }).content;
    expect(after).toContain("base content");
  });
});

// NOTE (Step G): clawbrain-v4's C2.4 ("bootstrap cache LRU cap on 300 orphaned
// sessions") was dropped. bootstrapCache / bootstrapInjected are plugin-runtime
// state that lives in the OpenClaw plugin (packages/openwave), not in
// sharpwave-core — the engine has no session cache. Its one real assertion was
// an it.skip stub; the remaining case only exercised a throwaway local LRU class
// with no engine involvement. This belongs to the openwave test suite.

// ─────────────────────────────────────────────────────────────────────────────
// C2.5 — multi-agent serial tick guarantees idempotent recovery across agents
// (less critical per audit; one assertion that establishes the invariant).
// ─────────────────────────────────────────────────────────────────────────────

describe("concurrency — C2.5: multi-agent serial consolidation is idempotent across re-runs", () => {
  const aliceId = `c25a-${randomUUID().slice(0, 8)}`;
  const bobId   = `c25b-${randomUUID().slice(0, 8)}`;

  afterEach(() => {
    cleanupAgent(aliceId);
    cleanupAgent(bobId);
  });

  it("running consolidation twice for two agents produces stable counts on the second pass", async () => {
    for (const id of [aliceId, bobId]) {
      getDb(id);
      for (let i = 0; i < 5; i++) {
        appendEpisode(id, "session", i % 2 === 0 ? "user" : "assistant",
          `Multi-agent episode ${i} content for consolidation idempotency test.`, 0.6);
      }
    }

    // First pass
    await runConsolidation(aliceId, DEFAULT_CONFIG, silentLog);
    await runConsolidation(bobId,   DEFAULT_CONFIG, silentLog);

    const aliceNodes1 = (getDb(aliceId).prepare("SELECT COUNT(*) as n FROM nodes").get() as { n: number }).n;
    const bobNodes1   = (getDb(bobId).prepare("SELECT COUNT(*) as n FROM nodes").get() as { n: number }).n;

    // Second pass — no new episodes, so consolidation should not invent new nodes.
    // (Some non-determinism in SWS/REM is acceptable; we assert nodes don't grow unboundedly.)
    await runConsolidation(aliceId, DEFAULT_CONFIG, silentLog);
    await runConsolidation(bobId,   DEFAULT_CONFIG, silentLog);

    const aliceNodes2 = (getDb(aliceId).prepare("SELECT COUNT(*) as n FROM nodes").get() as { n: number }).n;
    const bobNodes2   = (getDb(bobId).prepare("SELECT COUNT(*) as n FROM nodes").get() as { n: number }).n;
    // Strict equality not guaranteed (REM may re-emit a pattern), but growth should be bounded.
    expect(aliceNodes2).toBeLessThanOrEqual(aliceNodes1 + 3);
    expect(bobNodes2).toBeLessThanOrEqual(bobNodes1 + 3);
  });
});
