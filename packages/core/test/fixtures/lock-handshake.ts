// Child process for the deterministic contention phase of
// test/busy-timeout.test.ts ("two child processes + parent interleave").
//
// Run via vite-node so it uses the real getDb() (and therefore the real
// busy_timeout wiring). Two modes, coordinated through files in LOCK_DIR:
//
//   LOCK_MODE=hold  — waits until every waiter has written `ready-<tag>`,
//                     then BEGIN IMMEDIATE (takes the write lock), inserts a
//                     row, writes `held` (the lock is now provably held),
//                     keeps the transaction open for LOCK_HOLD_MS, COMMITs.
//   LOCK_MODE=wait  — opens the brain, writes `ready-<tag>`, waits for
//                     `held`, then runs its own BEGIN IMMEDIATE write. Because
//                     `held` is only written while the holder's transaction is
//                     open, this BEGIN cannot succeed until the holder commits:
//                     with busy_timeout > LOCK_HOLD_MS it blocks and then
//                     succeeds; with busy_timeout = 0 it fails SQLITE_BUSY.
//
// Emits exactly one JSON line on stdout:
//   hold: { tag, mode, busyTimeout, lockedAt, commitAt, errors }
//   wait: { tag, mode, busyTimeout, beginAt, acquiredAt, waitedMs, busy, errors }
// Timestamps are Date.now() (wall clock shared by all processes on the box).
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, closeAllDbs } from "../../src/db.js";

const tag = process.env["LOCK_TAG"] ?? "child";
const mode = process.env["LOCK_MODE"] ?? "wait";
const dir = process.env["LOCK_DIR"] ?? ".";
const holdMs = Number(process.env["LOCK_HOLD_MS"] ?? "600");
const waiters = (process.env["LOCK_WAITERS"] ?? "").split(",").filter(Boolean);
const deadline = Date.now() + Number(process.env["LOCK_DEADLINE_MS"] ?? "20000");

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const waitForFile = (name: string) => {
  const p = join(dir, name);
  while (!existsSync(p)) {
    if (Date.now() > deadline) throw new Error(`${tag}: timed out waiting for ${name}`);
    sleepSync(5);
  }
};
const isBusy = (e: unknown) =>
  /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(String((e as { code?: string })?.code ?? "") + String(e));

const errors: string[] = [];
let report: Record<string, unknown> = { tag, mode };
try {
  const db = getDb(tag);
  const busyTimeout = db.pragma("busy_timeout", { simple: true }) as number;
  report.busyTimeout = busyTimeout;
  const insert = db.prepare(
    "INSERT INTO episodes (id, session_id, role, content, importance, tokens, ripple_count, created_at, meta, writer_agent_id) VALUES (?, ?, 'tool', ?, 0.3, 1, 0, ?, NULL, ?)",
  );

  if (mode === "hold") {
    for (const w of waiters) waitForFile(`ready-${w}`);
    db.exec("BEGIN IMMEDIATE");
    try {
      report.lockedAt = Date.now();
      insert.run(`${tag}-lock`, `lock:${tag}`, `lock holder ${tag}`, Date.now(), tag);
      writeFileSync(join(dir, "held"), String(process.pid)); // lock is held from here…
      sleepSync(holdMs); // …for at least holdMs
      db.exec("COMMIT");
      report.commitAt = Date.now();
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }
  } else {
    writeFileSync(join(dir, `ready-${tag}`), String(process.pid));
    waitForFile("held");
    const beginAt = Date.now();
    report.beginAt = beginAt;
    try {
      db.transaction(() => {
        report.acquiredAt = Date.now();
        insert.run(`${tag}-after-lock`, `lock:${tag}`, `lock waiter ${tag}`, Date.now(), tag);
      }).immediate();
      report.waitedMs = (report.acquiredAt as number) - beginAt;
      report.busy = 0;
    } catch (e) {
      report.busy = isBusy(e) ? 1 : 0;
      throw e;
    }
  }
} catch (e) {
  errors.push(String(e));
} finally {
  try { closeAllDbs(); } catch { /* ignore */ }
}
process.stdout.write(JSON.stringify({ ...report, errors }) + "\n");
