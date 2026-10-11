// packages/server/src/backup-job.ts — one backup run: local snapshots, audit,
// then (if enabled) encrypted off-PC copies. Shared by the service scheduler
// and the `backup now` CLI. Off-PC failures never fail the local snapshots.

import { basename, join, dirname } from "node:path";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import Database from "better-sqlite3";
import { exportSoul, serializeSoul } from "xanima-core";
import { snapshotAll, type SnapshotResult } from "./backup.js";
import { OffsiteBackup, type OffsiteResult } from "./offsite.js";
import { backupsDir, brainsDir, type ServiceConfig } from "./config.js";
import type { AuditLog } from "./audit.js";
import type { Logger } from "./log.js";

export interface BackupRun {
  ok: SnapshotResult[];
  failed: Array<{ brain: string; error: string }>;
  offsite: OffsiteResult[];
}

export function makeOffsite(cfg: ServiceConfig, log: Logger, audit?: AuditLog, env?: NodeJS.ProcessEnv): OffsiteBackup {
  return new OffsiteBackup(cfg.offsiteBackup, {
    log, audit, env,
    outboxDir: cfg.offsiteBackup.outboxDir!,
    plaintextDirs: [brainsDir(cfg), backupsDir(cfg)],
  });
}

export function snapshotAndAudit(cfg: ServiceConfig, log: Logger, audit: AuditLog | undefined, only?: string[], srcBrainsDir = brainsDir(cfg)) {
  const r = snapshotAll(srcBrainsDir, backupsDir(cfg), cfg.backup.keep, only);
  const a = (brain: string, outcome: "ok" | "error", detail: string) => {
    try { audit?.append({ agentId: "system", tool: "backup.snapshot", brain, nodeId: null, outcome, detail }); } catch (e) { log.warn(`audit append failed: ${String(e)}`); }
  };
  for (const s of r.ok) a(s.brain, "ok", `${basename(s.path)} bytes=${s.bytes}${s.removed.length ? ` rotated=${s.removed.length}` : ""}`);
  for (const f of r.failed) {
    log.warn(`backup failed for brain ${f.brain}: ${f.error}`);
    a(f.brain, "error", f.error);
  }
  log.info(`backup: ${r.ok.length} snapshot(s), ${r.failed.length} failure(s)`);
  if (cfg.brain?.soulPackageOnExport) for (const s of r.ok) if (s.brain !== "shared") writeSoulSidecar(s, cfg, log, a);
  return r;
}

/**
 * soulPackageOnExport: a compact Soul Package of each private-brain snapshot, read from the snapshot file
 * (never the live brain) into <backups>/<brain>/soul-packages/, rotated with the same keep count.
 */
export function writeSoulSidecar(s: SnapshotResult, cfg: ServiceConfig, log: Logger, a: (brain: string, outcome: "ok" | "error", detail: string) => void): string | null {
  try {
    const db = new Database(s.path, { readonly: true, fileMustExist: true });
    try {
      const pkg = exportSoul(db, { agentId: s.brain, profile: "compact", config: cfg.brain ?? {} });
      const dir = join(dirname(s.path), "soul-packages");
      mkdirSync(dir, { recursive: true });
      const f = join(dir, basename(s.path).replace(/\.db$/, ".soul.json"));
      writeFileSync(f, serializeSoul(pkg));
      const all = readdirSync(dir).filter((x) => x.endsWith(".soul.json")).sort();
      for (const old of all.slice(0, Math.max(0, all.length - Math.max(1, cfg.backup.keep)))) rmSync(join(dir, old), { force: true });
      a(s.brain, "ok", `soul package ${pkg.package_id} -> ${basename(f)}`);
      return f;
    } finally { db.close(); }
  } catch (e) {
    log.warn(`soul package for ${s.brain} failed: ${String(e)}`);
    a(s.brain, "error", `soul package: ${String(e).slice(0, 200)}`);
    return null;
  }
}

export async function runBackupJob(cfg: ServiceConfig, log: Logger, audit: AuditLog | undefined, opts: { only?: string[]; offsite?: boolean; offsiteBackup?: OffsiteBackup } = {}): Promise<BackupRun> {
  const r = snapshotAndAudit(cfg, log, audit, opts.only);
  const offsite = opts.offsite === false ? [] : await (opts.offsiteBackup ?? makeOffsite(cfg, log, audit)).processAll(r.ok);
  return { ...r, offsite };
}
