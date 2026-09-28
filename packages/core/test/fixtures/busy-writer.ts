// Child-process participant for test/busy-timeout.test.ts.
//
// Run via vite-node so it imports the real TypeScript sources (getDb /
// writeNode / appendEpisode), the same code path production uses. All
// participants open the brain at SHARPWAVE_DB_PATH and coordinate through
// marker files in BUSY_SIGNAL_DIR (no timing assumptions):
//
//   Phase 1: guaranteed collision
//     writer:  touch ready-<tag> → wait for `held` → touch attempting-<tag>
//              → RAW `BEGIN IMMEDIATE` insert (NOT wrapped in wal-retry)
//     holder:  wait for every ready-* → BEGIN IMMEDIATE + insert → touch `held`
//              → wait for every attempting-* → keep holding BUSY_HOLD_MS more
//              → record commitAt → COMMIT
//     Each writer's write is issued while the holder still holds the lock, so it
//     can only succeed by waiting on busy_timeout. With busy_timeout=0 it throws
//     SQLITE_BUSY immediately. The parent asserts attemptAt < commitAt <= doneAt.
//
//   Phase 2 (writers only): interleaved stress
//     writeNode + appendEpisode + a raw 5-row batch per iteration, plus reads.
//
// Emits exactly one JSON line on stdout.
import { existsSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getDb, closeAllDbs } from "../../src/db.js";
import { writeNode } from "../../src/nodes.js";
import { appendEpisode } from "../../src/episodes.js";
import { getCounters } from "../../src/observability.js";

const role = process.env["BUSY_ROLE"] ?? "writer";
const tag = process.env["BUSY_TAG"] ?? "child";
const signalDir = process.env["BUSY_SIGNAL_DIR"] ?? "";
const writers = Number(process.env["BUSY_WRITERS"] ?? "2");
const iterations = Number(process.env["BUSY_ITERS"] ?? "30");
const holdMs = Number(process.env["BUSY_HOLD_MS"] ?? "300");
const BARRIER_TIMEOUT_MS = 10_000;

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const touch = (name: string) => writeFileSync(join(signalDir, name), String(Date.now()));
function waitFor(pred: () => boolean, what: string): void {
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`barrier timeout waiting for ${what}`);
    sleepSync(2);
  }
}
const count = (prefix: string) => readdirSync(signalDir).filter((f) => f.startsWith(prefix)).length;
const isBusy = (e: unknown) =>
  /SQLITE_BUSY|SQLITE_LOCKED|database is locked/i.test(String((e as { code?: string })?.code ?? "") + String(e));

const out: Record<string, unknown> = { role, tag };
const errors: string[] = [];
let busy = 0;

try {
  const db = getDb(tag);
  out["busyTimeout"] = db.pragma("busy_timeout", { simple: true });
  const insertEp = db.prepare(
    "INSERT INTO episodes (id, session_id, role, content, importance, tokens, ripple_count, created_at, meta, writer_agent_id) VALUES (?, ?, 'tool', ?, 0.3, 1, 0, ?, NULL, ?)",
  );

  if (role === "holder") {
    waitFor(() => count("ready-") >= writers, "writers ready");
    db.exec("BEGIN IMMEDIATE");
    insertEp.run(`${tag}-held`, `busy:${tag}`, "holder row", Date.now(), tag);
    out["heldAt"] = Date.now();
    touch("held");
    waitFor(() => count("attempting-") >= writers, "writers attempting");
    sleepSync(holdMs); // writers are now blocked inside their BEGIN IMMEDIATE
    out["commitAt"] = Date.now();
    db.exec("COMMIT");
  } else {
    touch(`ready-${tag}`);
    waitFor(() => existsSync(join(signalDir, "held")), "holder lock");

    // Phase 1 — contended raw write, NOT wrapped in wal-retry.
    out["attemptAt"] = Date.now();
    touch(`attempting-${tag}`);
    try {
      db.transaction(() => {
        insertEp.run(`${tag}-collide`, `busy:${tag}`, `collision ${tag}`, Date.now(), tag);
      }).immediate();
      out["doneAt"] = Date.now();
    } catch (e) {
      if (isBusy(e)) busy++;
      errors.push(`phase1: ${String(e)}`);
    }

    // Phase 2 — interleaved stress.
    let nodes = 0;
    let episodes = 1;
    const rawBatch = db.transaction((i: number) => {
      for (let k = 0; k < 5; k++) {
        insertEp.run(`${tag}-raw-${i}-${k}`, `busy:${tag}`, `raw ${tag} ${i} ${k}`, Date.now(), tag);
      }
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
        rawBatch.immediate(i);
        episodes += 5;
        db.prepare("SELECT COUNT(*) AS n FROM nodes").get();
        db.prepare("SELECT id FROM nodes_fts WHERE nodes_fts MATCH ? LIMIT 3").all(`"stress"`);
      } catch (e) {
        if (isBusy(e)) busy++;
        errors.push(String(e));
      }
    }
    out["nodes"] = nodes;
    out["episodes"] = episodes;
  }
} catch (e) {
  if (isBusy(e)) busy++;
  errors.push(String(e));
} finally {
  out["busy"] = busy;
  out["errors"] = errors;
  out["walRetries"] = getCounters()["wal_retries"] ?? 0;
  process.stdout.write(JSON.stringify(out) + "\n");
  try { closeAllDbs(); } catch { /* ignore */ }
}
