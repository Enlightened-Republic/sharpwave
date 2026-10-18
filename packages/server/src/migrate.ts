// packages/server/src/migrate.ts
//
// `xanima-server migrate`: COPY a SharpWave data folder (~/.sharpwave) to the
// Xanima one (~/.xanima), then bring every brain.db in the copy up to the
// current schema and verify it.
//
// Safety contract (the old folder is the rollback):
//   • The source is only ever READ: files are copied byte-for-byte and
//     sha256-checked; SQLite files in the source are never opened (opening a
//     WAL database can write its -shm / checkpoint), so the source tree is
//     bit-identical afterwards.
//   • Refuses if the target already exists and is non-empty (never merges,
//     never overwrites, never deletes).
//   • Refuses while a brain service answers on the configured port (a live
//     writer could leave the copy torn) unless --skip-port-check.
//   • Old install-attempt backups (`_backup-*` folders) are skipped unless
//     --include-backups.
//   • Per brain: counts (nodes / edges / episodes) taken on the raw copy
//     BEFORE migrating must equal the counts AFTER; integrity_check must be ok.
//   • config.json in the copied service root: string values that point into
//     the old folder are rewritten to the new folder (in the COPY only), and
//     every rewrite is listed in the report.
//   • A report is written to <to>/MIGRATED-FROM-SHARPWAVE.json (no memory content).

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { closeDb, getDb, envSnapshot, envRestore, envSet, SCHEMA_VERSION } from "xanima-core";

export interface MigrateOptions {
  from: string;
  to: string;
  dryRun?: boolean;
  includeBackups?: boolean;
  /** Called with progress lines. */
  log?: (m: string) => void;
}

export interface BrainMigration {
  path: string; // relative to `to`
  before: { nodes: number; edges: number; episodes: number; schema: number };
  after: { nodes: number; edges: number; episodes: number; schema: number };
  integrity: string;
  ok: boolean;
  backfill: { legacySourceType: number; superseded: number; archived: number };
}

export interface MigrateResult {
  from: string;
  to: string;
  dryRun: boolean;
  files: number;
  bytes: number;
  skipped: string[];
  brains: BrainMigration[];
  configRewrites: Array<{ file: string; key: string; from: string; to: string }>;
  sourceUnchanged: boolean;
  ok: boolean;
  errors: string[];
}

export class MigrateError extends Error {
  constructor(msg: string, readonly code: "usage" | "refused" | "verify") { super(msg); }
}

const SKIP_DIR = /^_backup-/;

function sha256File(p: string): string {
  return createHash("sha256").update(readFileSync(p)).digest("hex");
}

function walk(root: string, includeBackups: boolean, skipped: string[]): string[] {
  const out: string[] = [];
  const rec = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (!includeBackups && SKIP_DIR.test(e.name)) { skipped.push(relative(root, p)); continue; }
        if (e.name === "node_modules") { skipped.push(relative(root, p)); continue; }
        rec(p);
      } else if (e.isFile()) {
        out.push(p);
      }
    }
  };
  rec(root);
  return out;
}

function counts(db: Database.Database): { nodes: number; edges: number; episodes: number; schema: number } {
  const has = (t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  const n = (t: string) => (has(t) ? (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n : 0);
  let schema = 0;
  try { schema = (db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number | null }).v ?? 0; } catch { /* */ }
  return { nodes: n("nodes"), edges: n("edges"), episodes: n("episodes"), schema };
}

function rewriteConfig(file: string, fromRoot: string, toRoot: string, rewrites: MigrateResult["configRewrites"], relTo: string): void {
  let raw: string;
  try { raw = readFileSync(file, "utf8").replace(/^\uFEFF/, ""); } catch { return; }
  let json: unknown;
  try { json = JSON.parse(raw); } catch { return; }
  const variants = new Set([fromRoot, fromRoot.replace(/\\/g, "/"), fromRoot.replace(/\//g, "\\")]);
  const swap = (v: string): string => {
    for (const f of variants) {
      if (v.toLowerCase().startsWith(f.toLowerCase())) {
        const rest = v.slice(f.length);
        const sepChar = f.includes("\\") ? "\\" : "/";
        const target = sepChar === "\\" ? toRoot.replace(/\//g, "\\") : toRoot.replace(/\\/g, "/");
        return target + rest;
      }
    }
    // "~/.sharpwave/..." / "%USERPROFILE%\\.sharpwave\\..." style
    return v.replace(/([~%][^/\\]*[/\\])\.sharpwave(?=[/\\]|$)/, "$1.xanima");
  };
  let changed = false;
  const visit = (o: unknown, path: string): unknown => {
    if (typeof o === "string") {
      const n = swap(o);
      if (n !== o) { rewrites.push({ file: relTo, key: path, from: o, to: n }); changed = true; }
      return n;
    }
    if (Array.isArray(o)) return o.map((x, i) => visit(x, `${path}[${i}]`));
    if (o && typeof o === "object") {
      const r: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) r[k] = visit(v, path ? `${path}.${k}` : k);
      return r;
    }
    return o;
  };
  const next = visit(json, "");
  if (changed) writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
}

/**
 * Open one copied brain through xanima-core (applies the v19 migration),
 * then verify counts and integrity. Uses DB_PATH with a unique cache key.
 */
function migrateOneBrain(file: string, key: string): { after: BrainMigration["after"]; integrity: string; backfill: BrainMigration["backfill"] } {
  const dbPath = envSnapshot("DB_PATH");
  const dataDir = envSnapshot("DATA_DIR");
  envSet("DB_PATH", file);
  try {
    getDb(key);
    closeDb(key);
  } finally {
    envRestore("DB_PATH", dbPath);
    envRestore("DATA_DIR", dataDir);
  }
  const db = new Database(file);
  try {
    const after = counts(db);
    const integrity = (db.pragma("integrity_check", { simple: true }) as string) ?? "unknown";
    const one = (sql: string) => { try { return (db.prepare(sql).get() as { n: number }).n; } catch { return 0; } };
    const backfill = {
      legacySourceType: one("SELECT COUNT(*) AS n FROM nodes WHERE source_type = 'legacy'"),
      superseded: one("SELECT COUNT(*) AS n FROM nodes WHERE status = 'superseded'"),
      archived: one("SELECT COUNT(*) AS n FROM nodes WHERE status = 'archived'"),
    };
    db.pragma("wal_checkpoint(TRUNCATE)");
    return { after, integrity, backfill };
  } finally {
    db.close();
  }
}

export function migrateDataDir(opts: MigrateOptions): MigrateResult {
  const log = opts.log ?? (() => {});
  const from = resolve(opts.from);
  const to = resolve(opts.to);
  if (!existsSync(from) || !statSync(from).isDirectory()) throw new MigrateError(`source folder ${from} does not exist`, "usage");
  if (from === to || to.startsWith(from + sep) || from.startsWith(to + sep)) throw new MigrateError("source and target must be separate folders (neither inside the other)", "usage");
  if (existsSync(to) && readdirSync(to).length > 0) {
    throw new MigrateError(`target ${to} already exists and is not empty — refusing to merge or overwrite (move it aside yourself if you want to redo the migration)`, "refused");
  }

  const result: MigrateResult = {
    from, to, dryRun: !!opts.dryRun, files: 0, bytes: 0, skipped: [], brains: [], configRewrites: [],
    sourceUnchanged: true, ok: true, errors: [],
  };
  const files = walk(from, !!opts.includeBackups, result.skipped);
  const srcHashes = new Map<string, string>();
  for (const f of files) {
    if (/\.db(-wal|-shm)?$/.test(f) || /tokens\.json$/.test(f)) srcHashes.set(f, sha256File(f));
    result.files++;
    result.bytes += statSync(f).size;
  }
  log(`${result.files} files (${(result.bytes / 1e6).toFixed(1)} MB) to copy; skipped ${result.skipped.length} folder(s)`);
  if (opts.dryRun) return result;

  // 1. Copy byte-for-byte; verify each SQLite file's hash.
  mkdirSync(to, { recursive: true });
  for (const f of files) {
    const dst = join(to, relative(from, f));
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(f, dst);
    const h = srcHashes.get(f);
    if (h && sha256File(dst) !== h) {
      result.ok = false;
      result.errors.push(`copy hash mismatch: ${relative(from, f)}`);
    }
  }

  // 2. Migrate + verify every brain.db in the copy.
  const brainFiles = files.filter((f) => /(^|[/\\])brain\.db$/.test(f)).map((f) => join(to, relative(from, f)));
  let i = 0;
  for (const file of brainFiles) {
    const rel = relative(to, file);
    let before: BrainMigration["before"];
    try {
      // Raw copy, opened directly: replays the copied WAL into the COPY only.
      const raw = new Database(file);
      try { before = counts(raw); } finally { raw.close(); }
    } catch (e) {
      result.ok = false;
      result.errors.push(`${rel}: cannot open copy: ${String(e instanceof Error ? e.message : e)}`);
      continue;
    }
    try {
      const m = migrateOneBrain(file, `xanima-migrate-${process.pid}-${i++}`);
      const ok = m.integrity === "ok" && m.after.nodes === before.nodes && m.after.edges === before.edges
        && m.after.episodes === before.episodes && m.after.schema >= SCHEMA_VERSION;
      if (!ok) { result.ok = false; result.errors.push(`${rel}: verify failed (before ${JSON.stringify(before)} after ${JSON.stringify(m.after)} integrity=${m.integrity})`); }
      result.brains.push({ path: rel, before, after: m.after, integrity: m.integrity, ok, backfill: m.backfill });
      log(`${ok ? "ok  " : "FAIL"} ${rel}: nodes ${before.nodes}→${m.after.nodes} edges ${before.edges}→${m.after.edges} episodes ${before.episodes}→${m.after.episodes} schema ${before.schema}→${m.after.schema}`);
    } catch (e) {
      result.ok = false;
      result.errors.push(`${rel}: migrate failed: ${String(e instanceof Error ? e.message : e)}`);
    }
  }

  // 3. Point copied config.json files at the new folder.
  for (const f of files.filter((x) => /(^|[/\\])config\.json$/.test(x))) {
    rewriteConfig(join(to, relative(from, f)), from, to, result.configRewrites, relative(from, f));
  }

  // 4. Source untouched?
  for (const [f, h] of srcHashes) {
    if (!existsSync(f) || sha256File(f) !== h) { result.sourceUnchanged = false; result.ok = false; result.errors.push(`source changed: ${relative(from, f)}`); }
  }

  const report = { ...result, migratedAt: new Date().toISOString(), schemaVersion: SCHEMA_VERSION, note: "Copy of the SharpWave data folder. The source folder was not modified and is the rollback." };
  writeFileSync(join(to, "MIGRATED-FROM-SHARPWAVE.json"), JSON.stringify(report, null, 2) + "\n");
  return result;
}

export function formatMigrateResult(r: MigrateResult): string {
  const L = [
    `${r.dryRun ? "[dry-run] " : ""}migrate ${r.from} -> ${r.to}: ${r.ok ? "OK" : "FAILED"}`,
    `  files ${r.files} (${(r.bytes / 1e6).toFixed(1)} MB), skipped folders: ${r.skipped.length ? r.skipped.join(", ") : "none"}`,
  ];
  for (const b of r.brains) {
    L.push(`  ${b.ok ? "ok  " : "FAIL"} ${b.path}: nodes ${b.before.nodes}->${b.after.nodes}, edges ${b.before.edges}->${b.after.edges}, episodes ${b.before.episodes}->${b.after.episodes}, schema ${b.before.schema}->${b.after.schema}, integrity ${b.integrity}; backfill legacy=${b.backfill.legacySourceType} superseded=${b.backfill.superseded} archived=${b.backfill.archived}`);
  }
  for (const c of r.configRewrites) L.push(`  config ${c.file} ${c.key}: ${c.from} -> ${c.to}`);
  if (!r.dryRun) L.push(`  source unchanged: ${r.sourceUnchanged ? "yes" : "NO"}`);
  for (const e of r.errors) L.push(`  error: ${e}`);
  return L.join("\n");
}
