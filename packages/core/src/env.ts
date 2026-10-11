// packages/core/src/env.ts
//
// Xanima environment variables, with the 0.1.x compatibility window for the
// old SharpWave names.
//
//   envGet("DATA_DIR")  reads XANIMA_DATA_DIR first, then SHARPWAVE_DATA_DIR.
//
// When only the old name is set, it still works, and a one-time deprecation
// warning is written to stderr (once per variable per process). The old names
// are dropped in the release after the first one that reaches a live install (kept through 0.3.x: nothing has shipped yet).
//
// Data dir: ~/.xanima is the new default. If ~/.xanima does not exist but
// ~/.sharpwave does, the old folder is used (and a one-time notice says so),
// so an un-migrated install keeps working. `xanima-server migrate` makes the
// copy; the old folder is never moved or deleted.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const ENV_PREFIX = "XANIMA_";
export const LEGACY_ENV_PREFIX = "SHARPWAVE_";
export const DATA_DIR_NAME = ".xanima";
export const LEGACY_DATA_DIR_NAME = ".sharpwave";

const warned = new Set<string>();
let warnSink: (msg: string) => void = (msg) => {
  try { process.stderr.write(msg + "\n"); } catch { /* never throw from a warning */ }
};

/** Replace where deprecation warnings go (tests, hosts with their own logger). */
export function setDeprecationWarningSink(fn: (msg: string) => void): void {
  warnSink = fn;
}

/** Forget which warnings were already emitted (tests). */
export function resetDeprecationWarnings(): void {
  warned.clear();
}

/** Silence one deprecation key (e.g. "datadir" while `xanima-server migrate` is the fix being run). */
export function suppressDeprecationWarning(key: string): void { warned.add(key); }

export function deprecationWarnOnce(key: string, msg: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  warnSink(`[xanima] DEPRECATED: ${msg}`);
}

/**
 * Read `XANIMA_<suffix>`, falling back to `SHARPWAVE_<suffix>` (deprecated).
 * Empty strings count as unset for the new name only when the old one is set,
 * so `XANIMA_X=` does not silently hide `SHARPWAVE_X=value`.
 */
export function envGet(suffix: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = env[ENV_PREFIX + suffix];
  if (v !== undefined && v !== "") return v;
  const old = env[LEGACY_ENV_PREFIX + suffix];
  if (old !== undefined) {
    if (env === process.env || old !== "") {
      deprecationWarnOnce(
        `env:${suffix}`,
        `${LEGACY_ENV_PREFIX}${suffix} is deprecated; set ${ENV_PREFIX}${suffix} instead (the old name stops working in 0.4.0).`,
      );
    }
    return old;
  }
  return v;
}

/** Set both names so code (and child processes) reading either one agree. */
export function envSet(suffix: string, value: string, env: NodeJS.ProcessEnv = process.env): void {
  env[ENV_PREFIX + suffix] = value;
  env[LEGACY_ENV_PREFIX + suffix] = value;
}

/** Delete both names. */
export function envDelete(suffix: string, env: NodeJS.ProcessEnv = process.env): void {
  delete env[ENV_PREFIX + suffix];
  delete env[LEGACY_ENV_PREFIX + suffix];
}

/** Snapshot both names (for save/restore around a temporary override). */
export function envSnapshot(suffix: string, env: NodeJS.ProcessEnv = process.env): { neu?: string; old?: string } {
  return { neu: env[ENV_PREFIX + suffix], old: env[LEGACY_ENV_PREFIX + suffix] };
}

export function envRestore(suffix: string, snap: { neu?: string; old?: string }, env: NodeJS.ProcessEnv = process.env): void {
  if (snap.neu === undefined) delete env[ENV_PREFIX + suffix]; else env[ENV_PREFIX + suffix] = snap.neu;
  if (snap.old === undefined) delete env[LEGACY_ENV_PREFIX + suffix]; else env[LEGACY_ENV_PREFIX + suffix] = snap.old;
}

function userHome(env: NodeJS.ProcessEnv): string {
  return env["XANIMA_HOME_OVERRIDE"] ?? homedir();
}

/**
 * Default per-user data folder (no env override applied):
 *   ~/.xanima if it exists, else ~/.sharpwave if THAT exists (un-migrated
 *   install, deprecated), else ~/.xanima.
 */
export function defaultDataHome(env: NodeJS.ProcessEnv = process.env): string {
  const home = userHome(env);
  const neu = join(home, DATA_DIR_NAME);
  if (existsSync(neu)) return neu;
  const old = join(home, LEGACY_DATA_DIR_NAME);
  if (existsSync(old)) {
    deprecationWarnOnce(
      "datadir",
      `using the old data folder ${old}. Run \`xanima-server migrate\` to copy it to ${neu} (the old folder is kept as a rollback).`,
    );
    return old;
  }
  return neu;
}

/** Brain data dir: $XANIMA_DATA_DIR → $SHARPWAVE_DATA_DIR → defaultDataHome(). */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return envGet("DATA_DIR", env) ?? defaultDataHome(env);
}
