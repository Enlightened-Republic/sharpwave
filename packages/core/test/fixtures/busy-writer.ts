// Child-process writer for test/busy-timeout.test.ts.
//
// Run via vite-node so it imports the real TypeScript sources (getDb /
// writeNode / appendEpisode) — the same code path production uses. Opens the
// brain at SHARPWAVE_DB_PATH (shared with the parent and sibling children),
// waits for a common start barrier, then interleaves:
//   • writeNode + appendEpisode (wal-retry wrapped paths)
//   • a RAW multi-row write transaction that deliberately holds the write lock
//     for a few ms and is NOT wrapped in wal-retry — if busy_timeout were
//     missing, contention here would surface SQLITE_BUSY directly
//   • reads (COUNT + FTS search) between writes
// Emits exactly one JSON line on stdout:
//   { tag, busyTimeout, nodes, episodes, busy, errors, waits, maxWaitMs, walRetries }
// `waits` counts raw batches whose BEGIN IMMEDIATE had to wait >2ms for a
// sibling's lock (proof that real contention happened); `walRetries` is the
// wal-retry.ts counter (should stay 0 — busy_timeout absorbs the waits first).
import { getDb, closeAllDbs } from "../../src/db.js";
import { writeNode } from "../../src/nodes.js";
import { appendEpisode } from "../../src/episodes.js";
import { getCounters } from "../../src/observability.js";

const tag = process.env["BUSY_TAG"] ?? "child";
const iterations = Number(process.env["BUSY_ITERS"] ?? "30");
const startAt = Number(process.env["BUSY_START_AT"] ?? "0");
const holdMs = Number(process.env["BUSY_HOLD_MS"] ?? "10");

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

let nodes = 0;
let episodes = 0;
let busy = 0;
let waits = 0;
let maxWaitMs = 0;
const errors: string[] = [];
const isBusy = (e: unknown) => /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(String((e as { code?: string })?.code ?? "") + String(e));

try {
  const db = getDb(tag);
  const busyTimeout = db.pragma("busy_timeout", { simple: true }) as number;
  while (Date.now() < startAt) sleepSync(2);

  const rawInsert = db.prepare(
    "INSERT INTO episodes (id, session_id, role, content, importance, tokens, ripple_count, created_at, meta, writer_agent_id) VALUES (?, ?, 'tool', ?, 0.3, 1, 0, ?, NULL, ?)",
  );
  const rawBatch = db.transaction((i: number) => {
    for (let k = 0; k < 5; k++) {
      rawInsert.run(`${tag}-raw-${i}-${k}`, `busy:${tag}`, `raw ${tag} ${i} ${k}`, Date.now(), tag);
    }
    sleepSync(holdMs); // hold the write lock so siblings must wait on busy_timeout
  });

  for (let i = 0; i < iterations; i++) {
    try {
      writeNode(tag, "semantic", `busy ${tag} node ${i}`, `busy-timeout stress node ${i} from ${tag}`, {
        deduplicate: false,
        writerAgentId: tag,
      });
      nodes++;
      appendEpisode(tag, `busy:${tag}`, "user", `busy-timeout stress episode ${i} from ${tag}`, 0.5, undefined, { writerAgentId: tag });
      episodes++;
      const t0 = performance.now();
      rawBatch.immediate(i); // BEGIN IMMEDIATE: waits (busy_timeout) if a sibling holds the lock
      const waited = performance.now() - t0 - holdMs;
      episodes += 5;
      if (waited > 2) waits++;
      if (waited > maxWaitMs) maxWaitMs = waited;
      // interleaved reads
      db.prepare("SELECT COUNT(*) AS n FROM nodes").get();
      db.prepare("SELECT id FROM nodes_fts WHERE nodes_fts MATCH ? LIMIT 3").all(`"stress"`);
    } catch (e) {
      if (isBusy(e)) busy++;
      errors.push(String(e));
    }
  }
  const walRetries = getCounters()["wal_retries"] ?? 0;
  process.stdout.write(JSON.stringify({
    tag, busyTimeout, nodes, episodes, busy, errors, waits, maxWaitMs: Math.round(maxWaitMs), walRetries,
  }) + "\n");
} catch (e) {
  if (isBusy(e)) busy++;
  errors.push(String(e));
  process.stdout.write(JSON.stringify({ tag, nodes, episodes, busy, errors }) + "\n");
} finally {
  try { closeAllDbs(); } catch { /* ignore */ }
}
