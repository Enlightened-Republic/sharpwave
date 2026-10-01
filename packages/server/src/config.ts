// packages/server/src/config.ts
//
// Service configuration: defaults, JSON config-file loading, and resolution of
// derived paths. Everything the service touches on disk lives under `root`
// unless a path is explicitly overridden.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { defaultOffsiteConfig, type OffsiteConfig } from "./offsite.js";

export type { OffsiteConfig } from "./offsite.js";

export const DEFAULT_PORT = 18790;
export const DEFAULT_TAILNET_IP = "100.121.136.3";
export const LOOPBACK = "127.0.0.1";

export interface SleepConfig {
  /** Run in-process consolidation on a schedule. */
  enabled: boolean;
  /** Local wall-clock time "HH:MM" for the daily run. */
  at: string;
  /** Single wall-clock budget (ms) for one sleep cycle across ALL brains. */
  budgetMs: number;
  /** Only consolidate brains whose core gate (`shouldConsolidate`) says so. */
  respectGate: boolean;
}

export interface BackupConfig {
  /** Nightly VACUUM INTO snapshots. */
  enabled: boolean;
  /** Local wall-clock time "HH:MM". */
  at: string;
  /** Snapshots kept per brain (oldest are deleted first). */
  keep: number;
  /** Where snapshots go. Default `<root>/backups`. */
  dir?: string;
}

export interface ServiceConfig {
  /** Service root: brains/, backups/, audit/, tokens.json live here. */
  root: string;
  port: number;
  /**
   * Extra (non-loopback) addresses to bind — the tailnet IP. 127.0.0.1 is
   * always bound in addition. `[]` disables. Wildcards (0.0.0.0, ::) are refused.
   */
  tailnetHosts: string[];
  /** How long startup keeps retrying a tailnet bind that fails (Tailscale not up yet). */
  tailnetRetryWindowMs: number;
  /** Initial retry delay; doubles up to tailnetRetryMaxDelayMs. */
  tailnetRetryInitialDelayMs: number;
  tailnetRetryMaxDelayMs: number;
  /** After the startup window expires, keep retrying the tailnet bind at this interval (0 = give up). */
  tailnetBackgroundRetryMs: number;
  /** Token file (hashes only). Default `<root>/tokens.json`. */
  tokensFile: string;
  /** Audit log (JSONL). Default `<root>/audit/audit.jsonl`. */
  auditFile: string;
  /** Read-only WAL connections per brain. */
  readConnectionsPerBrain: number;
  /** brain_reset is refused unless this is true AND the token has `admin`. */
  allowReset: boolean;
  /** Background embedding drain interval (ms). 0 disables. */
  embedDrainIntervalMs: number;
  /** Max request body in bytes. */
  maxBodyBytes: number;
  /** Browser Origins allowed to call /mcp. Default none (requests with an Origin header are refused). */
  allowedOrigins: string[];
  sleep: SleepConfig;
  backup: BackupConfig;
  /** Encrypted off-PC copies of each snapshot (off by default). */
  offsiteBackup: OffsiteConfig;
  /** Optional log file (append). When unset logs go to stderr. */
  logFile?: string;
}

export function defaultRoot(): string {
  return join(homedir(), ".sharpwave", "service");
}

export function defaultConfig(root = defaultRoot()): ServiceConfig {
  return {
    root,
    port: DEFAULT_PORT,
    tailnetHosts: [DEFAULT_TAILNET_IP],
    tailnetRetryWindowMs: 120_000,
    tailnetRetryInitialDelayMs: 1_000,
    tailnetRetryMaxDelayMs: 15_000,
    tailnetBackgroundRetryMs: 60_000,
    tokensFile: join(root, "tokens.json"),
    auditFile: join(root, "audit", "audit.jsonl"),
    readConnectionsPerBrain: 2,
    allowReset: false,
    embedDrainIntervalMs: 30_000,
    maxBodyBytes: 1_000_000,
    allowedOrigins: [],
    sleep: { enabled: true, at: "03:30", budgetMs: 15 * 60_000, respectGate: true },
    backup: { enabled: true, at: "02:30", keep: 7 },
    offsiteBackup: defaultOffsiteConfig(),
  };
}

export function expandHome(p: string): string {
  // %USERPROFILE% / %APPDATA% style (Windows config files) — expanded on every OS.
  p = p.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, k: string) => {
    if (k.toUpperCase() === "USERPROFILE" || k.toUpperCase() === "HOME") return process.env[k] ?? homedir();
    return process.env[k] ?? m;
  });
  if (p === "~") return homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(homedir(), p.slice(2));
  return p;
}

/** Default key file: ~/.sharpwave/backup.key (i.e. %USERPROFILE%\\.sharpwave\\backup.key). */
export function defaultKeyFile(): string {
  return join(homedir(), ".sharpwave", "backup.key");
}

export type Partialish = Partial<Omit<ServiceConfig, "sleep" | "backup" | "offsiteBackup">> & {
  sleep?: Partial<SleepConfig>;
  backup?: Partial<BackupConfig>;
  offsiteBackup?: Partial<OffsiteConfig>;
};

/**
 * Merge overrides onto defaults. `root` is resolved first so the derived
 * paths (tokens, audit) follow it unless explicitly overridden.
 */
export function resolveConfig(overrides: Partialish = {}): ServiceConfig {
  const root = resolve(expandHome(overrides.root ?? defaultRoot()));
  const base = defaultConfig(root);
  const cfg: ServiceConfig = {
    ...base,
    ...stripUndefined(overrides),
    root,
    sleep: { ...base.sleep, ...stripUndefined(overrides.sleep ?? {}) },
    backup: { ...base.backup, ...stripUndefined(overrides.backup ?? {}) },
    offsiteBackup: { ...base.offsiteBackup, ...stripUndefined(overrides.offsiteBackup ?? {}) },
  };
  cfg.tokensFile = resolve(expandHome(overrides.tokensFile ?? base.tokensFile));
  cfg.auditFile = resolve(expandHome(overrides.auditFile ?? base.auditFile));
  if (cfg.backup.dir) cfg.backup.dir = resolve(expandHome(cfg.backup.dir));
  const o = cfg.offsiteBackup;
  if (o.keyFile) o.keyFile = resolve(expandHome(o.keyFile));
  if (o.folder) o.folder = resolve(expandHome(o.folder));
  o.outboxDir = resolve(expandHome(o.outboxDir ?? join(root, "offsite-outbox")));
  if (o.command !== undefined && (!Array.isArray(o.command) || o.command.some((a) => typeof a !== "string"))) {
    throw new Error("offsiteBackup.command must be an array of strings (argv; no shell is used)");
  }
  if (cfg.logFile) cfg.logFile = resolve(expandHome(cfg.logFile));
  return cfg;
}

export function loadConfigFile(path: string): Partialish {
  // Strip a UTF-8 BOM: Windows PowerShell 5.1's `Set-Content -Encoding UTF8`
  // and Notepad's "UTF-8 with BOM" both write one, and JSON.parse rejects it.
  const raw = readFileSync(expandHome(path), "utf8").replace(/^\uFEFF/, "");
  const parsed = JSON.parse(raw) as Partialish;
  if (!parsed || typeof parsed !== "object") throw new Error(`config ${path}: not a JSON object`);
  return parsed;
}

/** Default config file location, used by the CLI when --config is not given. */
export function defaultConfigPath(root = defaultRoot()): string | undefined {
  const p = join(root, "config.json");
  return existsSync(p) ? p : undefined;
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out as Partial<T>;
}

export function brainsDir(cfg: ServiceConfig): string {
  return join(cfg.root, "brains");
}

export function backupsDir(cfg: ServiceConfig): string {
  return cfg.backup.dir ?? join(cfg.root, "backups");
}
