// packages/server/src/backup.ts
//
// Per-brain snapshots via `VACUUM INTO` on a READ-ONLY connection — a
// transactionally consistent, defragmented copy taken without blocking the
// writer (WAL readers never block writers). Each snapshot is written to a
// .tmp file, verified with `PRAGMA quick_check`, then renamed into place, and
// the brain's snapshot set is rotated down to `keep`.
//
//   <backupsDir>/<brain>/<brain>-<UTC timestamp>.db
//
// This is intentionally independent of sharpwave-core's getDb(): the
// `sharpwave-server backup now` CLI runs in a separate process next to a live
// service and must never open a write connection or run migrations.
//
// Off-PC encryption + upload happens after this, in offsite.ts (see backup-job.ts).

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export interface SnapshotResult {
  brain: string;
  path: string;
  bytes: number;
  removed: string[];
}

export function snapshotStamp(d = new Date()): string {
  return d.toISOString().replace(/[:.]/g, "-"); // 2026-09-28T16-50-00-123Z — sortable, filename-safe
}

const SNAP_RE = (brain: string) => new RegExp(`^${brain.replace(/[.]/g, "\\.")}-\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}-\\d{3}Z\\.db$`);

export function listSnapshots(backupsDir: string, brain: string): string[] {
  const dir = join(backupsDir, brain);
  if (!existsSync(dir)) return [];
  const re = SNAP_RE(brain);
  return readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => join(dir, f));
}

/** Delete the oldest snapshots so at most `keep` remain. Returns deleted paths. */
export function rotateSnapshots(backupsDir: string, brain: string, keep: number): string[] {
  const all = listSnapshots(backupsDir, brain);
  const excess = all.length - Math.max(1, keep);
  if (excess <= 0) return [];
  const doomed = all.slice(0, excess);
  for (const p of doomed) unlinkSync(p);
  return doomed;
}

export function snapshotBrain(dbPath: string, backupsDir: string, brain: string, keep: number, now = new Date()): SnapshotResult {
  if (!existsSync(dbPath)) throw new Error(`brain ${brain}: ${dbPath} does not exist`);
  const dir = join(backupsDir, brain);
  mkdirSync(dir, { recursive: true });
  let final = join(dir, `${brain}-${snapshotStamp(now)}.db`);
  // Two snapshots in the same millisecond (tests, rapid `backup now`) must not collide.
  for (let bump = 1; existsSync(final); bump++) final = join(dir, `${brain}-${snapshotStamp(new Date(now.getTime() + bump))}.db`);
  const tmp = `${final}.tmp`;
  if (existsSync(tmp)) unlinkSync(tmp);

  const src = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    // vec0 virtual tables need the module present for VACUUM to re-declare them.
    try { sqliteVec.load(src); } catch { /* brain without vectors */ }
    src.prepare("VACUUM INTO ?").run(tmp);
  } finally {
    src.close();
  }

  const check = new Database(tmp, { readonly: true, fileMustExist: true });
  try {
    const res = check.pragma("quick_check", { simple: true });
    if (res !== "ok") throw new Error(`snapshot ${tmp} failed quick_check: ${String(res)}`);
  } catch (e) {
    check.close();
    try { unlinkSync(tmp); } catch { /* */ }
    throw e;
  }
  check.close();
  renameSync(tmp, final);
  const removed = rotateSnapshots(backupsDir, brain, keep);
  return { brain, path: final, bytes: statSync(final).size, removed };
}

/** Snapshot every brain under `brainsDir` (dirs containing brain.db). */
export function snapshotAll(brainsDir: string, backupsDir: string, keep: number, only?: string[]): { ok: SnapshotResult[]; failed: Array<{ brain: string; error: string }> } {
  const ok: SnapshotResult[] = [];
  const failed: Array<{ brain: string; error: string }> = [];
  if (!existsSync(brainsDir)) return { ok, failed };
  const brains = readdirSync(brainsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(brainsDir, e.name, "brain.db")))
    .map((e) => e.name)
    .filter((b) => !only || only.includes(b))
    .sort();
  for (const brain of brains) {
    try {
      ok.push(snapshotBrain(join(brainsDir, brain, "brain.db"), backupsDir, brain, keep));
    } catch (e) {
      failed.push({ brain, error: String(e instanceof Error ? e.message : e) });
    }
  }
  return { ok, failed };
}
