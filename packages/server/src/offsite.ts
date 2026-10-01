// packages/server/src/offsite.ts
//
// Off-PC backups: after each local VACUUM INTO snapshot, encrypt it into the
// local outbox (ciphertext only), then deliver the encrypted artifact to
//   (a) a folder (e.g. a Google Drive for Desktop synced folder), and/or
//   (b) a command run with execFile-style args and NO shell (e.g. rclone).
// Off-PC retention (N daily + M weekly) is applied to the outbox and the folder.
//
// Failures here are logged + audited and returned; they never undo or fail the
// local snapshot. The key is never logged, never passed to the command, and
// never written anywhere but memory.

import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, unlinkSync } from "node:fs";
import { basename, join, relative, resolve, isAbsolute } from "node:path";

import { ARTIFACT_EXT, MANIFEST_EXT, encryptFile, isArtifact, loadKey, type BackupKey } from "./crypt.js";
import type { AuditLog } from "./audit.js";
import type { Logger } from "./log.js";
import type { SnapshotResult } from "./backup.js";

export interface OffsiteConfig {
  /** Encrypt + ship each snapshot. Default false. */
  enabled: boolean;
  /** Key file (outside the repo), e.g. %USERPROFILE%\.sharpwave\backup.key. */
  keyFile?: string;
  /** Env var holding the key (base64/hex); wins over keyFile when set. Default SHARPWAVE_BACKUP_KEY. */
  keyEnv: string;
  /** Local staging dir for encrypted artifacts. Default <root>/offsite-outbox. */
  outboxDir?: string;
  /** Destination (a): folder, e.g. "G:\\My Drive\\SharpWave". Artifacts go to <folder>/<brain>/. */
  folder?: string;
  /**
   * Destination (b): argv, run without a shell after each artifact. Placeholders:
   * {file} {manifest} {name} {brain} {outbox} {brainOutbox}.
   * e.g. ["rclone", "sync", "{outbox}", "remote:sharpwave"]
   */
  command?: string[];
  commandTimeoutMs: number;
  /** Keep the newest artifact of each of the last N days (UTC). */
  keepDaily: number;
  /** Keep the newest artifact of each of the last M ISO weeks (UTC). */
  keepWeekly: number;
}

export function defaultOffsiteConfig(): OffsiteConfig {
  return { enabled: false, keyEnv: "SHARPWAVE_BACKUP_KEY", commandTimeoutMs: 10 * 60_000, keepDaily: 7, keepWeekly: 8 };
}

// ---------- retention ----------

const STAMP_RE = /-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z\.swbk$/;

export function artifactTime(name: string): Date | undefined {
  const m = STAMP_RE.exec(name);
  if (!m) return undefined;
  const [, y, mo, d, h, mi, s, ms] = m;
  return new Date(Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!, +ms!));
}

function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(y, 0, 1)) / 86_400_000 + 1) / 7);
  return `${y}-W${String(week).padStart(2, "0")}`;
}

/**
 * Grandfather-style selection: the newest artifact of each of the `daily`
 * most recent days that have one, plus the newest of each of the `weekly`
 * most recent ISO weeks. The single newest artifact is always kept.
 * Returns the names to keep (input order preserved).
 */
export function selectRetained(names: string[], daily: number, weekly: number): Set<string> {
  const dated = names.map((n) => ({ n, t: artifactTime(n) })).filter((x): x is { n: string; t: Date } => !!x.t)
    .sort((a, b) => b.t.getTime() - a.t.getTime());
  const keep = new Set<string>();
  if (dated.length) keep.add(dated[0]!.n);
  const pick = (bucket: (d: Date) => string, n: number) => {
    const seen = new Set<string>();
    for (const x of dated) {
      const b = bucket(x.t);
      if (seen.has(b)) continue;
      if (seen.size >= n) break;
      seen.add(b);
      keep.add(x.n);
    }
  };
  pick((d) => d.toISOString().slice(0, 10), Math.max(0, daily));
  pick(isoWeek, Math.max(0, weekly));
  return keep;
}

/** Apply retention to one directory of artifacts. Deletes artifact + manifest. Returns deleted artifact names. */
export function applyRetention(dir: string, daily: number, weekly: number): string[] {
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir).filter((f) => f.endsWith(ARTIFACT_EXT) && artifactTime(f));
  const keep = selectRetained(names, daily, weekly);
  const removed: string[] = [];
  for (const n of names) {
    if (keep.has(n)) continue;
    unlinkSync(join(dir, n));
    try { unlinkSync(join(dir, n + MANIFEST_EXT)); } catch { /* no manifest */ }
    removed.push(n);
  }
  return removed.sort();
}

// ---------- destinations ----------

function isInside(child: string, parent: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Refuse destinations that overlap plaintext locations (brains/, local backups). */
export function assertSafeDestinations(cfg: OffsiteConfig, plaintextDirs: string[], outboxDir: string): void {
  const dests: Array<[string, string]> = [["outboxDir", outboxDir]];
  if (cfg.folder) dests.push(["folder", cfg.folder]);
  for (const [what, d] of dests) {
    for (const p of plaintextDirs) {
      if (isInside(d, p) || isInside(p, d)) throw new Error(`offsiteBackup.${what} (${d}) overlaps a plaintext directory (${p}) — refusing; plaintext must never reach an off-PC destination`);
    }
  }
}

function copyAtomic(src: string, dest: string): void {
  const tmp = join(resolve(dest, ".."), `.${basename(dest)}.partial`);
  copyFileSync(src, tmp);
  renameSync(tmp, dest);
}

export interface CommandOutcome {
  ok: boolean;
  code: number | string | null;
  signal?: string | null;
  stderrTail?: string;
}

export function runCommand(argv: string[], vars: Record<string, string>, timeoutMs: number): Promise<CommandOutcome> {
  const [cmd, ...rest] = argv.map((a) => a.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k]! : m)));
  if (!cmd) return Promise.resolve({ ok: false, code: "EMPTY_COMMAND" });
  return new Promise((res) => {
    // execFile never spawns a shell unless asked; be explicit.
    execFile(cmd, rest, { shell: false, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env: commandEnv() }, (err, _stdout, stderr) => {
      const tail = String(stderr ?? "").trim().slice(-300);
      if (!err) return res({ ok: true, code: 0 });
      const e = err as NodeJS.ErrnoException & { code?: number | string; signal?: string | null; killed?: boolean };
      res({ ok: false, code: e.code ?? null, signal: e.signal ?? null, ...(tail ? { stderrTail: tail } : {}) });
    });
  });
}

/** The child gets the parent env minus any backup-key variable. */
function commandEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/BACKUP_KEY/i.test(k)) delete env[k];
  return env;
}

// ---------- orchestration ----------

export interface OffsiteResult {
  brain: string;
  artifact?: string;
  keyId?: string;
  folder?: { ok: boolean; path?: string; error?: string };
  command?: CommandOutcome;
  removed: { outbox: string[]; folder: string[] };
  error?: string;
}

export interface OffsiteDeps {
  log: Logger;
  audit?: AuditLog;
  outboxDir: string;
  plaintextDirs: string[];
  env?: NodeJS.ProcessEnv;
}

const SYSTEM = "system";

export class OffsiteBackup {
  constructor(readonly cfg: OffsiteConfig, private readonly deps: OffsiteDeps) {}

  private audit(tool: string, brain: string, outcome: "ok" | "error", detail: string): void {
    try { this.deps.audit?.append({ agentId: SYSTEM, tool, brain, nodeId: null, outcome, detail }); } catch (e) {
      this.deps.log.warn(`audit append failed: ${String(e)}`);
    }
  }

  loadKey(): BackupKey {
    return loadKey({ keyFile: this.cfg.keyFile, keyEnv: this.cfg.keyEnv, env: this.deps.env });
  }

  /** Encrypt + deliver every snapshot. Never throws. */
  async processAll(snaps: SnapshotResult[]): Promise<OffsiteResult[]> {
    if (!this.cfg.enabled || snaps.length === 0) return [];
    let key: BackupKey;
    try {
      assertSafeDestinations(this.cfg, this.deps.plaintextDirs, this.deps.outboxDir);
      key = this.loadKey();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.deps.log.error(`offsite backup skipped: ${msg}`);
      for (const s of snaps) this.audit("backup.encrypt", s.brain, "error", msg);
      return snaps.map((s) => ({ brain: s.brain, error: msg, removed: { outbox: [], folder: [] } }));
    }
    const out: OffsiteResult[] = [];
    for (const s of snaps) out.push(await this.processOne(s, key));
    return out;
  }

  async processOne(snap: SnapshotResult, key: BackupKey): Promise<OffsiteResult> {
    const r: OffsiteResult = { brain: snap.brain, keyId: key.id, removed: { outbox: [], folder: [] } };
    const brainOutbox = join(this.deps.outboxDir, snap.brain);
    const name = basename(snap.path).replace(/\.db$/, "") + ARTIFACT_EXT;
    const artifact = join(brainOutbox, name);
    try {
      const enc = await encryptFile(snap.path, artifact, key, { brain: snap.brain, source: basename(snap.path) });
      r.artifact = artifact;
      this.audit("backup.encrypt", snap.brain, "ok", `${name} keyId=${key.id} bytes=${enc.manifest.bytes} sha256=${enc.manifest.sha256}`);
      this.deps.log.info(`offsite: encrypted ${snap.brain} -> ${artifact} (key ${key.id})`);
    } catch (e) {
      r.error = `encrypt failed: ${e instanceof Error ? e.message : String(e)}`;
      this.audit("backup.encrypt", snap.brain, "error", r.error);
      this.deps.log.error(`offsite: ${snap.brain} ${r.error}`);
      return r;
    }
    // Belt and braces: only a file that starts with the SWBK magic may leave the outbox.
    if (!isArtifact(artifact)) {
      r.error = "refusing to deliver: artifact does not carry the SWBK header";
      this.audit("backup.upload", snap.brain, "error", r.error);
      return r;
    }
    const manifest = artifact + MANIFEST_EXT;

    if (this.cfg.folder) {
      const destDir = join(this.cfg.folder, snap.brain);
      try {
        mkdirSync(destDir, { recursive: true });
        const dest = join(destDir, name);
        copyAtomic(artifact, dest);
        copyAtomic(manifest, dest + MANIFEST_EXT);
        r.folder = { ok: true, path: dest };
        this.audit("backup.upload", snap.brain, "ok", `folder ${name}`);
        this.deps.log.info(`offsite: copied ${name} to folder ${destDir}`);
        r.removed.folder = applyRetention(destDir, this.cfg.keepDaily, this.cfg.keepWeekly);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        r.folder = { ok: false, error: msg };
        this.audit("backup.upload", snap.brain, "error", `folder ${name}: ${msg}`);
        this.deps.log.error(`offsite: folder copy of ${name} failed: ${msg}`);
      }
    }

    // Outbox retention runs before the command so `rclone sync {outbox}` mirrors it.
    try { r.removed.outbox = applyRetention(brainOutbox, this.cfg.keepDaily, this.cfg.keepWeekly); } catch (e) {
      this.deps.log.warn(`offsite: outbox retention failed for ${snap.brain}: ${String(e)}`);
    }

    if (this.cfg.command?.length) {
      const res = await runCommand(this.cfg.command, {
        file: artifact, manifest, name, brain: snap.brain, outbox: this.deps.outboxDir, brainOutbox,
      }, this.cfg.commandTimeoutMs);
      r.command = res;
      const prog = basename(this.cfg.command[0]!);
      if (res.ok) {
        this.audit("backup.upload", snap.brain, "ok", `command ${prog} ${name}`);
        this.deps.log.info(`offsite: command ${prog} ok for ${name}`);
      } else {
        const why = `exit=${String(res.code)}${res.signal ? ` signal=${res.signal}` : ""}`;
        this.audit("backup.upload", snap.brain, "error", `command ${prog} ${name} ${why}`);
        this.deps.log.error(`offsite: command ${prog} failed for ${name} (${why})${res.stderrTail ? `: ${res.stderrTail}` : ""} — local snapshot and encrypted artifact are kept`);
      }
    }
    return r;
  }
}

/** Overall success: encrypted and every configured destination succeeded. */
export function offsiteOk(r: OffsiteResult): boolean {
  return !r.error && (r.folder?.ok ?? true) && (r.command?.ok ?? true);
}
