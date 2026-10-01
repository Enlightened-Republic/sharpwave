// packages/server/src/backup-job.ts — one backup run: local snapshots, audit,
// then (if enabled) encrypted off-PC copies. Shared by the service scheduler
// and the `backup now` CLI. Off-PC failures never fail the local snapshots.

import { basename } from "node:path";
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
  return r;
}

export async function runBackupJob(cfg: ServiceConfig, log: Logger, audit: AuditLog | undefined, opts: { only?: string[]; offsite?: boolean; offsiteBackup?: OffsiteBackup } = {}): Promise<BackupRun> {
  const r = snapshotAndAudit(cfg, log, audit, opts.only);
  const offsite = opts.offsite === false ? [] : await (opts.offsiteBackup ?? makeOffsite(cfg, log, audit)).processAll(r.ok);
  return { ...r, offsite };
}
