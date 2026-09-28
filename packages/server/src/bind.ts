// packages/server/src/bind.ts
//
// Bind policy. The service ALWAYS binds 127.0.0.1 and may additionally bind
// explicit tailnet IPs. Wildcard addresses (0.0.0.0, ::, and their spellings)
// are refused outright — the brain service must never be reachable from a LAN
// or public interface by accident. Hostnames are refused too: a name could
// resolve to a wildcard or a public address at runtime; only IP literals pass.

import { isIP } from "node:net";
import type { Server } from "node:http";

export class BindPolicyError extends Error {}

/** Throws BindPolicyError unless `host` is a specific (non-wildcard) IP literal. */
export function assertBindableHost(host: string): void {
  const h = (host ?? "").trim().replace(/^\[|\]$/g, "");
  if (!h) throw new BindPolicyError("refusing to bind an empty host (that means all interfaces)");
  const fam = isIP(h);
  if (fam === 0) {
    throw new BindPolicyError(`refusing to bind "${host}": only IP literals are allowed (no hostnames, no "*")`);
  }
  if (fam === 4 && h.split(".").every((o) => Number(o) === 0)) {
    throw new BindPolicyError(`refusing to bind ${host}: wildcard address (all interfaces)`);
  }
  if (fam === 6) {
    const lower = h.toLowerCase();
    // ::, ::0, 0:0:0:0:0:0:0:0, and IPv4-mapped wildcards (::ffff:0.0.0.0)
    const stripped = lower.replace(/^::ffff:/, "");
    if (isIP(stripped) === 4 && stripped.split(".").every((o) => Number(o) === 0)) {
      throw new BindPolicyError(`refusing to bind ${host}: wildcard address (all interfaces)`);
    }
    const groups = expandV6(lower);
    if (groups && groups.every((g) => g === 0)) {
      throw new BindPolicyError(`refusing to bind ${host}: wildcard address (all interfaces)`);
    }
  }
}

function expandV6(addr: string): number[] | null {
  if (addr.includes(".")) return null; // embedded v4, handled above
  const [head, tail] = addr.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined ? (tail ? tail.split(":") : []) : [];
  if (tail === undefined && h.length !== 8) return null;
  const fill = tail !== undefined ? new Array(8 - h.length - t.length).fill("0") : [];
  const all = [...h, ...fill, ...t];
  if (all.length !== 8) return null;
  return all.map((g) => parseInt(g || "0", 16));
}

/** One listen attempt. Resolves once bound; rejects with the socket error. */
export function listenOnce(server: Server, host: string, port: number): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      rejectP(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolveP();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host, port, exclusive: true });
  });
}

export interface RetryOptions {
  windowMs: number;
  initialDelayMs: number;
  maxDelayMs: number;
  /** Called before each wait with the error from the failed attempt. */
  onRetry?: (err: NodeJS.ErrnoException, attempt: number, delayMs: number) => void;
  /** Stop retrying early (e.g. service shutting down). */
  signal?: AbortSignal;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((r) => {
    const t = setTimeout(r, ms);
    t.unref?.();
    signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true });
  });

/**
 * Keep trying to bind `host:port` with exponential backoff until it succeeds
 * or `windowMs` elapses. Returns true when bound, false when the window ran out.
 * `makeServer` is called per attempt because a server that failed to listen is
 * not reliably reusable across Node versions.
 */
export async function listenWithRetry(
  makeServer: () => Server,
  host: string,
  port: number,
  opts: RetryOptions,
): Promise<Server | null> {
  const sleep = opts.sleep ?? defaultSleep;
  const deadline = Date.now() + opts.windowMs;
  let delay = Math.max(1, opts.initialDelayMs);
  let attempt = 0;
  for (;;) {
    attempt++;
    const server = makeServer();
    try {
      await listenOnce(server, host, port);
      return server;
    } catch (e) {
      server.close();
      const err = e as NodeJS.ErrnoException;
      if (opts.signal?.aborted) return null;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return null;
      const wait = Math.min(delay, remaining, opts.maxDelayMs);
      opts.onRetry?.(err, attempt, wait);
      await sleep(wait, opts.signal);
      if (opts.signal?.aborted) return null;
      delay = Math.min(delay * 2, opts.maxDelayMs);
    }
  }
}
