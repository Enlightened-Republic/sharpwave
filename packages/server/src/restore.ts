// packages/server/src/restore.ts
//
// `sharpwave-server backup restore <artifact> --out <path> [--force]`
//
//   1. refuse to clobber: an existing --out needs --force; a LIVE brain path
//      (anything under <root>/brains, or any file named brain.db) additionally
//      needs the service to be stopped (its /health must not answer);
//   2. verify the manifest sha256 of the whole artifact (when the manifest is
//      next to it), the key id, then stream-decrypt — the GCM tag and the
//      manifest's plaintext HMAC must verify before the bytes are kept;
//   3. `PRAGMA integrity_check` must return "ok" (plus node/edge/episode counts);
//   4. only then is the result renamed to --out. A file being replaced is moved
//      aside (with its -wal/-shm, so a stale WAL can't be replayed onto the
//      restored DB) to <out>.pre-restore-<stamp>, never deleted.

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { existsSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { randomBytes } from "node:crypto";

import { decryptFile, type BackupKey } from "./crypt.js";
import { snapshotStamp } from "./backup.js";
import type { AuditLog } from "./audit.js";

export interface RestoreCounts {
  nodes: number | null;
  edges: number | null;
  episodes: number | null;
}

export interface RestoreResult {
  out: string;
  keyId: string;
  integrity: string;
  counts: RestoreCounts;
  manifestChecked: boolean;
  movedAside: string[];
}

export interface RestoreOptions {
  artifact: string;
  out: string;
  key: BackupKey;
  force?: boolean;
  /** <root>/brains — anything inside is treated as a live brain. */
  brainsDir?: string;
  /** Resolves true when the service is up (default: GET http://127.0.0.1:<port>/health). */
  serviceRunning?: () => Promise<boolean>;
  audit?: AuditLog;
  requireManifest?: boolean;
}

function inside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function isLiveBrainPath(out: string, brainsDir?: string): boolean {
  return basename(out).toLowerCase() === "brain.db" || (!!brainsDir && inside(out, brainsDir));
}

export async function healthAnswers(port: number, host = "127.0.0.1", timeoutMs = 1500): Promise<boolean> {
  try {
    const res = await fetch(`http://${host}:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel();
    return true; // any HTTP answer means something is listening on the service port
  } catch {
    return false;
  }
}

export function countRows(db: Database.Database): RestoreCounts {
  const has = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const n = (t: string) => (has(t) ? (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n : null);
  return { nodes: n("nodes"), edges: n("edges"), episodes: n("episodes") };
}

/** Open (read-write, so a WAL-mode header is handled cleanly), integrity_check, count, close. */
export function checkDatabase(path: string): { integrity: string; counts: RestoreCounts } {
  const db = new Database(path, { fileMustExist: true });
  try {
    try { sqliteVec.load(db); } catch { /* no vectors */ }
    const rows = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
    const integrity = rows.map((r) => r.integrity_check).join("; ");
    return { integrity, counts: countRows(db) };
  } finally {
    db.close();
  }
}

export async function restoreBackup(o: RestoreOptions): Promise<RestoreResult> {
  const out = resolve(o.out);
  const artifactName = basename(o.artifact);
  const fail = (msg: string): never => {
    try { o.audit?.append({ agentId: "system", tool: "backup.restore", brain: "-", nodeId: null, outcome: "error", detail: `${artifactName}: ${msg}` }); } catch { /* */ }
    throw new Error(msg);
  };

  const live = isLiveBrainPath(out, o.brainsDir);
  if (existsSync(out) && !o.force) fail(`${out} already exists — refusing to overwrite (pass --force to replace it; the old file is moved aside, not deleted)`);
  if (live) {
    if (!o.force) fail(`${out} is a live brain path — refusing without --force (and the service must be stopped)`);
    const running = await (o.serviceRunning ?? (async () => false))();
    if (running) fail(`the SharpWave service is running — stop it first (Stop-ScheduledTask -TaskName "SharpWave Brain Service"), then retry with --force`);
  }

  const tmp = join(dirname(out), `.restore-${randomBytes(6).toString("hex")}.db`);
  let dec;
  try {
    dec = await decryptFile(o.artifact, tmp, o.key, { requireManifest: o.requireManifest });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  let check: ReturnType<typeof checkDatabase>;
  try {
    check = checkDatabase(tmp);
  } catch (e) {
    for (const s of ["", "-wal", "-shm"]) try { unlinkSync(tmp + s); } catch { /* */ }
    return fail(`restored file is not a readable SQLite database: ${e instanceof Error ? e.message : String(e)}`);
  }
  for (const s of ["-wal", "-shm"]) try { unlinkSync(tmp + s); } catch { /* */ }
  if (check.integrity !== "ok") {
    try { unlinkSync(tmp); } catch { /* */ }
    fail(`PRAGMA integrity_check failed: ${check.integrity.slice(0, 500)}`);
  }

  const movedAside: string[] = [];
  const stamp = snapshotStamp();
  for (const s of ["", "-wal", "-shm"]) {
    if (existsSync(out + s)) {
      const aside = `${out}.pre-restore-${stamp}${s}`;
      renameSync(out + s, aside);
      movedAside.push(aside);
    }
  }
  renameSync(tmp, out);
  const c = check.counts;
  try {
    o.audit?.append({ agentId: "system", tool: "backup.restore", brain: "-", nodeId: null, outcome: "ok",
      detail: `${artifactName} -> ${basename(out)} keyId=${dec.keyId} integrity=ok nodes=${c.nodes} edges=${c.edges} episodes=${c.episodes}${movedAside.length ? ` movedAside=${movedAside.length}` : ""}` });
  } catch { /* */ }
  return { out, keyId: dec.keyId, integrity: check.integrity, counts: c, manifestChecked: dec.manifestChecked, movedAside };
}
