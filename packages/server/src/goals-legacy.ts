// xanima-server goals list-legacy | pause-legacy | resume-legacy  (0.5.1)
//
// Pre-0.2.0 goal nodes were backfilled as *untracked* goals; on real brains they are
// mostly chat fragments ("I want to …") minted by the old sleep. Since 0.5.1 they are
// not injected / exported / counted as active, and these commands let the operator
// pause them for good. list-legacy is read-only. pause-legacy / resume-legacy write the
// brain file (service must be stopped), take a VACUUM INTO backup first and are audited.
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { listLegacyGoals, pauseLegacyGoals, resumeLegacyGoals } from "xanima-core";
import type { LegacyGoal, LegacyPauseResult } from "xanima-core";
import { snapshotBrain } from "./backup.js";
import type { AuditLog } from "./audit.js";

function open(dbPath: string, readonly: boolean): Database.Database {
  if (!existsSync(dbPath)) throw new Error(`no brain at ${dbPath}`);
  const db = new Database(dbPath, { fileMustExist: true, readonly, timeout: 10_000 });
  if (!readonly) db.pragma("journal_mode = WAL");
  return db;
}

export function listLegacyGoalsFile(dbPath: string): LegacyGoal[] {
  const db = open(dbPath, true);
  try { return listLegacyGoals(db); } finally { db.close(); }
}

export interface LegacyOpts { dbPath: string; brain: string; backupsDir: string; audit?: AuditLog; dryRun?: boolean; by?: string; now?: number }

export function pauseLegacyGoalsFile(o: LegacyOpts & { all?: boolean }): LegacyPauseResult & { backup: string | null } {
  let backup: string | null = null;
  if (!o.dryRun) backup = snapshotBrain(o.dbPath, join(o.backupsDir, o.brain), "goals-pause", 1_000_000).path;
  const db = open(o.dbPath, false);
  try {
    const r = pauseLegacyGoals(db, { all: o.all, dryRun: o.dryRun, ...(o.now ? { now: o.now } : {}) });
    if (!o.dryRun) {
      for (const g of r.paused) o.audit?.append({ agentId: o.by ?? "admin:cli", tool: "goals.pause-legacy", brain: o.brain, nodeId: g.node_id, outcome: "ok", detail: `${r.batch} ${g.fragment ?? "untracked"}` });
      o.audit?.append({ agentId: o.by ?? "admin:cli", tool: "goals.pause-legacy", brain: o.brain, nodeId: null, outcome: "ok", detail: `batch ${r.batch}: paused=${r.paused.length} kept=${r.kept.length} backup=${backup}` });
    }
    return { ...r, backup };
  } finally { db.close(); }
}

export function resumeLegacyGoalsFile(o: LegacyOpts & { batch: string }): { batch: string; resumed: string[]; backup: string | null } {
  let backup: string | null = null;
  if (!o.dryRun) backup = snapshotBrain(o.dbPath, join(o.backupsDir, o.brain), "goals-pause", 1_000_000).path;
  const db = open(o.dbPath, false);
  try {
    const r = resumeLegacyGoals(db, o.batch, { dryRun: o.dryRun, ...(o.now ? { now: o.now } : {}) });
    if (!o.dryRun) o.audit?.append({ agentId: o.by ?? "admin:cli", tool: "goals.resume-legacy", brain: o.brain, nodeId: null, outcome: "ok", detail: `batch ${o.batch}: resumed=${r.resumed.length} backup=${backup}` });
    return { ...r, backup };
  } finally { db.close(); }
}
