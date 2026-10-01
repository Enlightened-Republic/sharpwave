// packages/server/src/adopt.ts
//
// `sharpwave-server brain adopt` — make an EXISTING per-agent brain.db (e.g. a
// legacy OpenWave / sharpwave-MCP brain at ~/.sharpwave/<agent>/brain.db) the
// service's private brain for that agent:
//
//   <root>/brains/<agentId>/brain.db
//
// Safety model (rollback first):
//   • The source is NEVER opened by SQLite. Its files (brain.db + -wal [+ -journal])
//     are byte-copied into a private staging dir and hashed before and after;
//     if the hashes move, something is writing to the source and we abort.
//     A read-only SQLite open would still create a -shm next to the source and
//     take a shared lock on it — staging avoids both.
//   • The staged copy's WAL is checkpointed (TRUNCATE), then a pre-adopt backup
//     is taken with VACUUM INTO (so WAL content is included), integrity-checked,
//     sha256-recorded and kept under <backups>/<agent>/pre-adopt/.
//   • That verified backup is what gets copied into the service's brain path.
//     Default mode is `copy`: the source stays where it is, byte-identical, so
//     OpenWave local mode (or the sharpwave MCP) keeps working as a rollback.
//     `move` renames the source files aside (never deletes) after success.
//   • The adopted copy is opened through sharpwave-core's getDb(), which runs
//     the additive schema migrations (… → 18, writer_agent_id with NO backfill).
//     Optional `--backfill-writer` stamps NULL writers afterwards.
//   • Verification: PRAGMA integrity_check = ok, node/edge/episode counts equal
//     to the backup, schema_version >= 18. On failure the adopted file is moved
//     aside and any brain that was replaced is put back.
//   • Refuses while the service is listening on its port, and refuses to replace
//     an existing private brain that has data unless --force (then it is MOVED
//     aside in place as brain.db.pre-adopt-<UTC>[-wal|-shm], never deleted — same
//     convention as `backup restore`). An empty existing brain (e.g. one created
//     by a smoke test) is moved aside the same way without --force.
//   • One audit line (counts, schema, hashes, file names — no memory content).

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { closeDb, getDb } from "sharpwave-core";

import { AuditLog } from "./audit.js";
import { snapshotStamp } from "./backup.js";
import { validateAgentId } from "./tokens.js";

/** Minimum schema the adopted brain must reach (core v18 = writer_agent_id). */
export const ADOPT_MIN_SCHEMA = 18;
/** Sidecar files that belong to a SQLite database file. */
const SIDECARS = ["-wal", "-shm", "-journal"] as const;

export type AdoptMode = "copy" | "move";

export interface AdoptOptions {
  agentId: string;
  /** Source brain: a brain.db file, or a directory containing brain.db. */
  from: string;
  brainsDir: string;
  backupsDir: string;
  auditFile: string;
  mode?: AdoptMode;
  dryRun?: boolean;
  force?: boolean;
  /**
   * Stamp rows whose writer_agent_id IS NULL after migration. `undefined`/null
   * = leave NULL (default, core's documented semantics: "written before
   * provenance existed"). "legacy" expands to `legacy:<agentId>`.
   */
  backfillWriter?: string | null;
  /** Resolves true when the brain service is (or may be) running. Omit = no check. */
  serviceRunning?: () => Promise<boolean>;
  now?: Date;
}

export interface BrainCounts {
  nodes: number;
  edges: number;
  episodes: number;
  schema: number;
  /** Nodes with a stored embedding BLOB (informational). */
  embedded: number;
  /** Rows with writer_agent_id NULL (only after schema 18; else = row count). */
  nullWriters?: { nodes: number; edges: number; episodes: number };
}

export type TargetState = "absent" | "empty" | "has-data";

export interface AdoptResult {
  dryRun: boolean;
  agentId: string;
  mode: AdoptMode;
  source: string;
  sourceFiles: string[];
  sourceSha256: Record<string, string>;
  sourceUnchanged: boolean;
  target: string;
  targetState: TargetState;
  targetCounts?: Pick<BrainCounts, "nodes" | "edges" | "episodes">;
  before: BrainCounts;
  after?: BrainCounts;
  integrity?: string;
  backup?: { path: string; sha256: string; bytes: number; manifest: string };
  replacedMovedTo?: string[];
  sourceMovedTo?: string[];
  backfillWriter: string | null;
  backfilled?: { nodes: number; edges: number; episodes: number };
  warnings: string[];
  actions: string[];
}

export class AdoptError extends Error {
  constructor(message: string, readonly code: "usage" | "running" | "exists" | "source" | "verify") {
    super(message);
  }
}

const sha256File = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** Resolve `--from` to the brain.db file path. */
export function resolveSource(from: string): string {
  const p = resolve(from);
  if (!existsSync(p)) throw new AdoptError(`source ${p} does not exist`, "source");
  const st = statSync(p);
  const file = st.isDirectory() ? join(p, "brain.db") : p;
  if (!existsSync(file) || !statSync(file).isFile()) throw new AdoptError(`source ${file} is not a file`, "source");
  return file;
}

/** The brain file plus whichever sidecars exist (data-bearing ones only: -wal, -journal). */
function dataFiles(dbFile: string): string[] {
  return [dbFile, ...["-wal", "-journal"].map((s) => dbFile + s).filter((f) => existsSync(f))];
}

/** Resolve the backfill flag. Returns null for "leave NULL". */
export function resolveBackfillWriter(agentId: string, v: string | null | undefined): string | null {
  if (v === undefined || v === null || v === "" || v === "none" || v === "null") return null;
  const w = v === "legacy" ? `legacy:${agentId}` : v;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(w)) throw new AdoptError(`--backfill-writer "${v}" is not a valid writer id`, "usage");
  return w;
}

function count(db: Database.Database, sql: string): number {
  try { return (db.prepare(sql).get() as { n: number }).n; } catch { return 0; }
}

function hasColumn(db: Database.Database, table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === col);
}

export function countBrain(db: Database.Database): BrainCounts {
  const out: BrainCounts = {
    nodes: count(db, "SELECT COUNT(*) AS n FROM nodes"),
    edges: count(db, "SELECT COUNT(*) AS n FROM edges"),
    episodes: count(db, "SELECT COUNT(*) AS n FROM episodes"),
    schema: count(db, "SELECT COALESCE(MAX(version), 0) AS n FROM schema_version"),
    embedded: count(db, "SELECT COUNT(*) AS n FROM nodes WHERE embedding IS NOT NULL"),
  };
  if (hasColumn(db, "nodes", "writer_agent_id")) {
    out.nullWriters = {
      nodes: count(db, "SELECT COUNT(*) AS n FROM nodes WHERE writer_agent_id IS NULL"),
      edges: count(db, "SELECT COUNT(*) AS n FROM edges WHERE writer_agent_id IS NULL"),
      episodes: count(db, "SELECT COUNT(*) AS n FROM episodes WHERE writer_agent_id IS NULL"),
    };
  }
  return out;
}

function openRO(path: string): Database.Database {
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 5000 });
  try { sqliteVec.load(db); } catch { /* brain without vectors */ }
  return db;
}

function openRW(path: string): Database.Database {
  const db = new Database(path, { fileMustExist: true, timeout: 5000 });
  try { sqliteVec.load(db); } catch { /* brain without vectors */ }
  return db;
}

function integrity(db: Database.Database): string {
  const rows = db.pragma("integrity_check") as Array<{ integrity_check: string }>;
  return rows.map((r) => r.integrity_check).join("; ");
}

function targetState(target: string): { state: TargetState; counts?: Pick<BrainCounts, "nodes" | "edges" | "episodes"> } {
  if (!existsSync(target)) return { state: "absent" };
  // Stage a copy so we never take a lock on (or create -shm next to) a brain
  // a service might be about to open.
  const stage = mkdtempSync(join(tmpdir(), "sw-adopt-target-"));
  try {
    for (const f of dataFiles(target)) copyFileSync(f, join(stage, basename(f)));
    const db = openRO(join(stage, basename(target)));
    try {
      const c = countBrain(db);
      const counts = { nodes: c.nodes, edges: c.edges, episodes: c.episodes };
      return { state: c.nodes + c.edges + c.episodes > 0 ? "has-data" : "empty", counts };
    } finally { db.close(); }
  } catch {
    // Unreadable/corrupt existing file: treat as data (never silently replace).
    return { state: "has-data" };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * Rename a db file and its sidecars aside in place: brain.db -> brain.db.<tag>,
 * brain.db-wal -> brain.db.<tag>-wal (same scheme as `backup restore`). Never
 * deletes. Returns [from, to] pairs so the move can be undone.
 */
function moveDbAside(dbFile: string, tag: string): Array<[string, string]> {
  const moved: Array<[string, string]> = [];
  for (const s of ["", ...SIDECARS]) {
    const f = dbFile + s;
    if (!existsSync(f)) continue;
    const to = `${dbFile}.${tag}${s}`;
    renameSync(f, to);
    moved.push([f, to]);
  }
  return moved;
}

function withCoreDataDir<T>(brainsDir: string, fn: () => T): T {
  const prevDir = process.env["SHARPWAVE_DATA_DIR"];
  const prevPath = process.env["SHARPWAVE_DB_PATH"];
  delete process.env["SHARPWAVE_DB_PATH"];
  process.env["SHARPWAVE_DATA_DIR"] = brainsDir;
  try {
    return fn();
  } finally {
    if (prevDir === undefined) delete process.env["SHARPWAVE_DATA_DIR"]; else process.env["SHARPWAVE_DATA_DIR"] = prevDir;
    if (prevPath !== undefined) process.env["SHARPWAVE_DB_PATH"] = prevPath;
  }
}

export async function adoptBrain(opts: AdoptOptions): Promise<AdoptResult> {
  const agentId = opts.agentId;
  const bad = validateAgentId(agentId ?? "");
  if (bad) throw new AdoptError(bad, "usage");
  const mode: AdoptMode = opts.mode ?? "copy";
  if (mode !== "copy" && mode !== "move") throw new AdoptError(`--mode must be copy or move`, "usage");
  const dryRun = !!opts.dryRun;
  const backfillWriter = resolveBackfillWriter(agentId, opts.backfillWriter);
  const now = opts.now ?? new Date();
  const stamp = snapshotStamp(now);
  const warnings: string[] = [];
  const actions: string[] = [];

  const source = resolveSource(opts.from);
  const target = join(resolve(opts.brainsDir), agentId, "brain.db");
  if (resolve(source).toLowerCase() === resolve(target).toLowerCase()) {
    throw new AdoptError(`source and target are the same file (${target})`, "usage");
  }

  // 1. The service must not be running (it would hold the target open).
  if (opts.serviceRunning && await opts.serviceRunning()) {
    throw new AdoptError("the brain service port is in use — stop the brain service before adopting (adopt never runs next to a live service)", "running");
  }

  // 2. Existing private brain?
  const t = targetState(target);
  if (t.state === "has-data" && !opts.force) {
    const c = t.counts ? ` (${t.counts.nodes} nodes, ${t.counts.edges} edges, ${t.counts.episodes} episodes)` : "";
    throw new AdoptError(`target ${target} already exists with data${c} — pass --force to move it aside (renamed to brain.db.pre-adopt-<UTC>, not deleted) and adopt anyway`, "exists");
  }

  // 3. Stage the source (byte copy, source never opened) and hash it.
  const files = dataFiles(source);
  if (existsSync(source + "-shm") && !existsSync(source + "-wal")) warnings.push("source has a -shm without a -wal (harmless; ignored)");
  const shaBefore = Object.fromEntries(files.map((f) => [basename(f), sha256File(f)]));
  const stage = mkdtempSync(join(tmpdir(), "sw-adopt-"));
  let result: AdoptResult | undefined;
  try {
    for (const f of files) copyFileSync(f, join(stage, basename(f)));
    const staged = join(stage, basename(source));

    // 4. Checkpoint the staged WAL into the staged main file, then measure.
    const sdb = openRW(staged);
    let before: BrainCounts;
    let srcIntegrity: string;
    try {
      try { sdb.pragma("wal_checkpoint(TRUNCATE)"); } catch { /* rollback-journal brain: nothing to checkpoint */ }
      srcIntegrity = integrity(sdb);
      before = countBrain(sdb);
    } finally { sdb.close(); }
    if (srcIntegrity !== "ok") throw new AdoptError(`source integrity_check failed: ${srcIntegrity.slice(0, 300)}`, "source");
    if (before.schema < 11 && before.embedded > 0) {
      warnings.push(`source schema ${before.schema} < 11: the v11 migration recreates the vector index (1024-dim); embeddings are re-queued lazily`);
    }
    if (before.schema > ADOPT_MIN_SCHEMA) warnings.push(`source schema ${before.schema} is newer than this build's ${ADOPT_MIN_SCHEMA}`);

    const shaMid = Object.fromEntries(files.map((f) => [basename(f), existsSync(f) ? sha256File(f) : "missing"]));
    if (JSON.stringify(shaMid) !== JSON.stringify(shaBefore)) {
      throw new AdoptError("the source brain changed while it was being copied — something is writing to it (OpenWave local mode, the sharpwave MCP, another tool). Stop it and retry.", "source");
    }

    result = {
      dryRun, agentId, mode, source, sourceFiles: files, sourceSha256: shaBefore, sourceUnchanged: true,
      target, targetState: t.state, ...(t.counts ? { targetCounts: t.counts } : {}),
      before, backfillWriter, warnings, actions,
    };

    const backupDir = join(opts.backupsDir, agentId, "pre-adopt");
    const backupPath = join(backupDir, `${agentId}-pre-adopt-${stamp}.db`);
    const asideTag = `pre-adopt-${stamp}`;
    actions.push(`pre-adopt backup (VACUUM INTO, WAL included) -> ${backupPath}`);
    if (t.state !== "absent") actions.push(`move existing ${t.state} target aside -> ${target}.${asideTag}`);
    actions.push(`copy backup -> ${target}`);
    actions.push(`open via sharpwave-core (migrate schema ${before.schema} -> ${Math.max(before.schema, ADOPT_MIN_SCHEMA)})`);
    actions.push(backfillWriter ? `backfill NULL writer_agent_id -> "${backfillWriter}"` : "leave writer_agent_id NULL on existing rows");
    actions.push("verify integrity_check, counts, schema; checkpoint WAL");
    if (mode === "move") actions.push(`rename source files aside (${basename(source)}.adopted-${stamp})`);
    else actions.push("leave the source untouched (rollback = keep using it locally)");

    if (dryRun) return result;

    // 5. Pre-adopt backup from the checkpointed staging copy.
    mkdirSync(backupDir, { recursive: true });
    const tmp = `${backupPath}.tmp`;
    if (existsSync(tmp)) unlinkSync(tmp);
    const vdb = openRO(staged);
    try { vdb.prepare("VACUUM INTO ?").run(tmp); } finally { vdb.close(); }
    const bdb = openRO(tmp);
    let bCounts: BrainCounts;
    let bIntegrity: string;
    try { bIntegrity = integrity(bdb); bCounts = countBrain(bdb); } finally { bdb.close(); }
    if (bIntegrity !== "ok" || bCounts.nodes !== before.nodes || bCounts.edges !== before.edges || bCounts.episodes !== before.episodes) {
      try { unlinkSync(tmp); } catch { /* */ }
      throw new AdoptError(`pre-adopt backup failed verification (integrity=${bIntegrity})`, "verify");
    }
    renameSync(tmp, backupPath);
    const backupSha = sha256File(backupPath);
    const manifest = `${backupPath}.json`;
    writeFileSync(manifest, JSON.stringify({
      kind: "sharpwave-pre-adopt-backup", createdAt: now.toISOString(), agentId,
      source, sourceSha256: shaBefore, backup: basename(backupPath), sha256: backupSha,
      counts: { nodes: before.nodes, edges: before.edges, episodes: before.episodes }, schema: before.schema,
    }, null, 2) + "\n");
    result.backup = { path: backupPath, sha256: backupSha, bytes: statSync(backupPath).size, manifest };

    // 6. Move an existing target aside (never delete).
    let movedAside: Array<[string, string]> = [];
    mkdirSync(dirname(target), { recursive: true });
    if (t.state !== "absent" || SIDECARS.some((s) => existsSync(target + s))) {
      movedAside = moveDbAside(target, asideTag);
      result.replacedMovedTo = movedAside.map(([, to]) => to);
    }

    // 7. Copy the verified backup into place (tmp + rename).
    const tgtTmp = `${target}.adopt-tmp`;
    copyFileSync(backupPath, tgtTmp);
    renameSync(tgtTmp, target);

    const rollbackTarget = (why: string): never => {
      const failedTag = `failed-adopt-${stamp}`;
      try { closeDb(agentId); } catch { /* */ }
      try { moveDbAside(target, failedTag); } catch { /* */ }
      for (const [from, to] of movedAside) { try { renameSync(to, from); } catch { /* */ } }
      throw new AdoptError(`${why} — adopted copy moved aside to ${target}.${failedTag}${movedAside.length ? "; previous brain restored" : ""}. The source was not modified.`, "verify");
    };

    // 8. Open through core: runs migrations. Optional writer backfill.
    try {
      withCoreDataDir(resolve(opts.brainsDir), () => {
        closeDb(agentId); // never reuse a cached connection to another file
        try {
          const db = getDb(agentId);
          if (backfillWriter) {
            const tx = db.transaction(() => ({
              nodes: db.prepare("UPDATE nodes SET writer_agent_id = ? WHERE writer_agent_id IS NULL").run(backfillWriter).changes,
              edges: db.prepare("UPDATE edges SET writer_agent_id = ? WHERE writer_agent_id IS NULL").run(backfillWriter).changes,
              episodes: db.prepare("UPDATE episodes SET writer_agent_id = ? WHERE writer_agent_id IS NULL").run(backfillWriter).changes,
            }));
            result!.backfilled = tx();
          }
          db.pragma("wal_checkpoint(TRUNCATE)");
        } finally {
          closeDb(agentId);
        }
      });
    } catch (e) {
      rollbackTarget(`opening/migrating the adopted brain failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    // 9. Verify with a fresh read-only connection.
    const adb = openRO(target);
    let after: BrainCounts;
    let aIntegrity: string;
    try { aIntegrity = integrity(adb); after = countBrain(adb); } finally { adb.close(); }
    result.after = after;
    result.integrity = aIntegrity;
    const problems: string[] = [];
    if (aIntegrity !== "ok") problems.push(`integrity_check: ${aIntegrity.slice(0, 200)}`);
    for (const k of ["nodes", "edges", "episodes"] as const) if (after[k] !== before[k]) problems.push(`${k} ${before[k]} -> ${after[k]}`);
    if (after.schema < ADOPT_MIN_SCHEMA) problems.push(`schema_version ${after.schema} < ${ADOPT_MIN_SCHEMA}`);
    if (problems.length) rollbackTarget(`verification failed (${problems.join(", ")})`);

    // 10. Source: copy mode leaves it alone (prove it); move mode renames it aside.
    const shaAfter = Object.fromEntries(files.map((f) => [basename(f), existsSync(f) ? sha256File(f) : "missing"]));
    result.sourceUnchanged = JSON.stringify(shaAfter) === JSON.stringify(shaBefore);
    if (!result.sourceUnchanged) warnings.push("the source changed after it was copied — writes made to it after the copy are NOT in the adopted brain");
    if (mode === "move") {
      const moved: string[] = [];
      for (const f of [source, ...SIDECARS.map((s) => source + s)]) {
        if (!existsSync(f)) continue;
        const to = `${f}.adopted-${stamp}`;
        renameSync(f, to);
        moved.push(to);
      }
      result.sourceMovedTo = moved;
    }

    // 11. Audit (no content).
    try {
      new AuditLog(opts.auditFile).append({
        time: now.toISOString(), agentId: "admin:cli", tool: "brain_adopt", brain: agentId, nodeId: null, outcome: "ok",
        detail: [
          `mode=${mode}`, `nodes=${after.nodes}`, `edges=${after.edges}`, `episodes=${after.episodes}`,
          `schema=${before.schema}->${after.schema}`, `integrity=${aIntegrity}`,
          `backup=${basename(backupPath)}`, `backup_sha256=${backupSha}`,
          `source_sha256=${shaBefore[basename(source)]}`, `writer_backfill=${backfillWriter ?? "none"}`,
          `replaced=${result.replacedMovedTo?.length ? basename(result.replacedMovedTo[0]!) : "none"}`,
        ].join(" "),
      });
    } catch (e) {
      warnings.push(`audit log write failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return result;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/** Human summary (no content). */
export function formatAdoptResult(r: AdoptResult): string {
  const c = (x: { nodes: number; edges: number; episodes: number }) => `${x.nodes} nodes, ${x.edges} edges, ${x.episodes} episodes`;
  const lines: string[] = [];
  lines.push(`${r.dryRun ? "DRY RUN — nothing written" : "ADOPTED"}: agent "${r.agentId}" (mode ${r.mode})`);
  lines.push(`  source   ${r.source}`);
  for (const [f, h] of Object.entries(r.sourceSha256)) lines.push(`           ${f} sha256 ${h}`);
  lines.push(`           ${c(r.before)}, schema ${r.before.schema}, ${r.before.embedded} embedded`);
  lines.push(`  target   ${r.target} (${r.targetState}${r.targetCounts ? `: ${c(r.targetCounts)}` : ""})`);
  if (r.dryRun) {
    lines.push("  would:");
    for (const a of r.actions) lines.push(`    - ${a}`);
  } else {
    if (r.backup) lines.push(`  backup   ${r.backup.path}\n           sha256 ${r.backup.sha256}  (${(r.backup.bytes / 1024).toFixed(0)} KiB)`);
    if (r.replacedMovedTo?.length) lines.push(`  replaced brain moved aside -> ${r.replacedMovedTo.join(", ")}`);
    if (r.after) lines.push(`  after    ${c(r.after)}, schema ${r.after.schema}, integrity ${r.integrity}`);
    lines.push(`  counts   ${r.after && r.after.nodes === r.before.nodes && r.after.edges === r.before.edges && r.after.episodes === r.before.episodes ? "MATCH" : "MISMATCH"}`);
    lines.push(`  writer   ${r.backfillWriter ? `backfilled "${r.backfillWriter}" (${r.backfilled ? c(r.backfilled) : "0"})` : "existing rows left NULL (no backfill)"}`);
    if (r.mode === "copy") lines.push(`  source   ${r.sourceUnchanged ? "unchanged (sha256 re-checked)" : "CHANGED after copy — see warning"}`);
    if (r.sourceMovedTo?.length) lines.push(`  source moved aside -> ${r.sourceMovedTo.join(", ")}`);
  }
  for (const w of r.warnings) lines.push(`  WARNING  ${w}`);
  return lines.join("\n");
}
