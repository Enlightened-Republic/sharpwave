/**
 * WAL retry helper — exponential backoff on SQLite lock contention.
 *
 * Ported from ClawBrain v0.4.0 audit (item #2). The better-sqlite3 driver
 * surfaces SQLITE_BUSY and SQLITE_LOCKED as `SqliteError` instances with a
 * `.code` field; when that fires during a write transaction, callers should
 * retry with backoff rather than aborting the entire batch.
 *
 * Pattern (matches the Python reference):
 *   - 100ms → 200ms → 400ms exponential base
 *   - +0-50ms random jitter to avoid lockstep retries
 *   - max 3 attempts (4 total attempts including the initial one)
 *
 * Observability: when the observability module is wired (Item 5), retries
 * bump the `wal_retries` counter and emit a `wal_retry` event; exhausted
 * retries bump `wal_retry_failures`. When observability is disabled (default),
 * both calls are cheap no-ops.
 */

import type Database from "better-sqlite3";
import { bumpCounter, logObservabilityEvent } from "./observability.js";

const SQLITE_BUSY = "SQLITE_BUSY";
const SQLITE_LOCKED = "SQLITE_LOCKED";
const RETRY_DELAYS_MS = [100, 200, 400]; // exponential backoff base
const RETRY_JITTER_MS = 50;              // 0..50ms random jitter
const MAX_ATTEMPTS = 3;                  // total attempts = MAX_ATTEMPTS + 1

/**
 * True when the error is a recoverable SQLite lock-contention signal.
 * Both SQLITE_BUSY (another connection has the lock) and SQLITE_LOCKED
 * (a different table within the same database) are retryable per the
 * Python reference.
 */
function isLockError(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") {
      return code === SQLITE_BUSY || code === SQLITE_LOCKED;
    }
  }
  // Fallback: better-sqlite3 historically wrapped these as plain Error
  // before the SqliteError type stabilized. Defensive substring match.
  const msg = String(err);
  return msg.includes("SQLITE_BUSY") || msg.includes("SQLITE_LOCKED")
    || msg.toLowerCase().includes("database is locked");
}

function jitteredDelayMs(attempt: number): number {
  const base = RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
  return base + Math.floor(Math.random() * RETRY_JITTER_MS);
}

/**
 * Sleep helper — `setTimeout` is enough; we never want to spin the event loop
 * with `Atomics.wait` here since the goal is to release the lock to another
 * write path, not to busy-wait.
 */
function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface WalRetryOptions {
  /** Override the max attempts (default 3, matches Python reference). */
  maxAttempts?: number;
  /** Override the operation label written to observability events. */
  op?: string;
}

/**
 * Run a write operation against a better-sqlite3 Database with retry on
 * SQLITE_BUSY / SQLITE_LOCKED.
 *
 * The callback receives the prepared `db` and may invoke any number of
 * statements; better-sqlite3's transactions are synchronous so a single
 * `db.transaction(...)` invocation handles the whole batch. On a lock
 * error the entire callback is retried from the top — this is intentional
 * and matches the Python reference behavior: a partial transaction is
 * rolled back by SQLite's WAL semantics, so re-running the whole batch
 * is safe.
 */
export async function executeWithWalRetry<T>(
  db: Database.Database,
  fn: (db: Database.Database) => T,
  opts: WalRetryOptions = {},
): Promise<T> {
  const op = opts.op ?? "write";
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      return fn(db);
    } catch (err) {
      lastErr = err;
      if (!isLockError(err) || attempt >= maxAttempts) {
        if (isLockError(err)) {
          bumpCounter("wal_retry_failures");
          logObservabilityEvent("wal_retry", {
            op,
            attempt: attempt + 1,
            maxAttempts: maxAttempts + 1,
            exhausted: true,
          });
        }
        throw err;
      }
      bumpCounter("wal_retries");
      logObservabilityEvent("wal_retry", {
        op,
        attempt: attempt + 1,
        maxAttempts: maxAttempts + 1,
      });
      await sleepMs(jitteredDelayMs(attempt));
    }
  }
  // Unreachable — the loop either returns or throws — but TS doesn't know.
  throw lastErr;
}

/**
 * Synchronous variant. Useful for write paths that don't want to be async
 * (better-sqlite3 itself is synchronous, so most callers will prefer this).
 * The retry loop itself is synchronous (uses a busy-wait sleep via `Atomics.wait`
 * if available, else yields via `setImmediate`); the operation never crosses
 * an async boundary so callers stay synchronous end-to-end.
 */
export function executeWithWalRetrySync<T>(
  db: Database.Database,
  fn: (db: Database.Database) => T,
  opts: WalRetryOptions = {},
): T {
  const op = opts.op ?? "write";
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    try {
      return fn(db);
    } catch (err) {
      lastErr = err;
      if (!isLockError(err) || attempt >= maxAttempts) {
        if (isLockError(err)) {
          bumpCounter("wal_retry_failures");
          logObservabilityEvent("wal_retry", {
            op,
            attempt: attempt + 1,
            maxAttempts: maxAttempts + 1,
            exhausted: true,
          });
        }
        throw err;
      }
      bumpCounter("wal_retries");
      logObservabilityEvent("wal_retry", {
        op,
        attempt: attempt + 1,
        maxAttempts: maxAttempts + 1,
      });
      // Block the synchronous loop for the backoff window. better-sqlite3 is
      // sync, so this is the natural place to wait. Atomics.wait is the
      // standard JS busy-sleep; falls back to a setTimeout wait if not allowed.
      const ms = jitteredDelayMs(attempt);
      const sab = new SharedArrayBuffer(4);
      const view = new Int32Array(sab);
      Atomics.wait(view, 0, 0, ms);
    }
  }
  throw lastErr;
}
