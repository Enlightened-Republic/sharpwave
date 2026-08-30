import { getMeta, setMeta } from "./db.js";

/**
 * Update notifier.
 *
 * An MCP server is launched by a client (OpenClaw, Claude Code, Cursor, …) and
 * its stderr is the only channel a user ever sees, so that is where the notice
 * goes. Constraints this is written to respect:
 *
 *   - never block startup: the check runs detached, after the transport is up
 *   - never fail loudly: no network, offline, DNS blocked, registry 500 — all silent
 *   - never chat: at most one line, only when a newer version actually exists
 *   - never phone home on every launch: throttled to once per day
 *   - always opt-out-able: one env var, plus the conventional CI/no-notifier ones
 *
 * Only the version string is requested, via the registry's abbreviated metadata
 * endpoint. No identifiers are sent, nothing is uploaded.
 */

const REGISTRY_URL = "https://registry.npmjs.org/sharpwave/latest";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 3000;
const LAST_CHECK_KEY = "update_check:last_run";

/** Honour the usual opt-out conventions plus our own. */
export function updateCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const truthy = (v: string | undefined) =>
    v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";

  return (
    truthy(env["SHARPWAVE_NO_UPDATE_CHECK"]) ||
    truthy(env["NO_UPDATE_NOTIFIER"]) ||
    truthy(env["CI"]) ||
    env["NODE_ENV"] === "test"
  );
}

/**
 * Compare two semver-ish strings.
 * Returns true when `candidate` is strictly newer than `current`.
 *
 * Prerelease versions never notify: someone who deliberately installed 0.2.0-rc.1
 * should not be nagged, and a published prerelease should not be pushed at
 * everyone on stable.
 */
export function isNewer(candidate: string, current: string): boolean {
  const parse = (v: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(v.trim());
    if (!m) return null;
    return {
      nums: [Number(m[1]), Number(m[2]), Number(m[3])],
      prerelease: m[4] !== undefined,
    };
  };

  const a = parse(candidate);
  const b = parse(current);
  if (!a || !b) return false;
  if (a.prerelease || b.prerelease) return false;

  for (let i = 0; i < 3; i++) {
    if (a.nums[i] > b.nums[i]) return true;
    if (a.nums[i] < b.nums[i]) return false;
  }
  return false;
}

/** True when enough time has passed since the last check to run another. */
function dueForCheck(agentId: string, now: number): boolean {
  try {
    const last = Number(getMeta(agentId, LAST_CHECK_KEY) ?? 0);
    if (!Number.isFinite(last) || last <= 0) return true;
    return now - last >= CHECK_INTERVAL_MS;
  } catch {
    // No database yet, or it is unreadable — checking is not important enough
    // to be the thing that surfaces that.
    return false;
  }
}

async function fetchLatestVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(REGISTRY_URL, {
      signal: controller.signal,
      headers: { accept: "application/vnd.npm.install-v1+json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Run the check and, if a newer stable release exists, write one line to stderr.
 * Resolves to the notified version, or null when nothing was shown.
 *
 * Safe to call without awaiting — every failure path resolves to null.
 */
export async function checkForUpdate(
  agentId: string,
  currentVersion: string,
  write: (msg: string) => void = (m) => process.stderr.write(m),
): Promise<string | null> {
  if (updateCheckDisabled()) return null;

  const now = Date.now();
  if (!dueForCheck(agentId, now)) return null;

  // Record the attempt before the request, not after. A registry that is slow
  // or down should cost one attempt per day, not one per launch.
  try {
    setMeta(agentId, LAST_CHECK_KEY, String(now));
  } catch {
    return null;
  }

  const latest = await fetchLatestVersion();
  if (!latest || !isNewer(latest, currentVersion)) return null;

  write(
    `[sharpwave] update available: ${currentVersion} → ${latest}` +
      `  (npm install sharpwave@latest — set SHARPWAVE_NO_UPDATE_CHECK=1 to silence)\n`,
  );
  return latest;
}
