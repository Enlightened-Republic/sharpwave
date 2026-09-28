import { describe, expect, it } from "vitest";
import { createServer } from "node:http";

import { assertBindableHost, BindPolicyError, listenWithRetry } from "../src/bind.js";
import { BrainService } from "../src/service.js";
import { startService, tempRoot, testConfig } from "./helpers.js";

describe("bind policy", () => {
  it.each(["0.0.0.0", "::", "[::]", "::0", "0:0:0:0:0:0:0:0", "::ffff:0.0.0.0", "0.0.0.00", "", "*", "localhost", "my-pc.tailnet.ts.net"])(
    "refuses %j", (h) => {
      expect(() => assertBindableHost(h)).toThrow(BindPolicyError);
    });

  it.each(["127.0.0.1", "100.121.136.3", "::1", "fd7a:115c:a1e0::1"])("allows %s", (h) => {
    expect(() => assertBindableHost(h)).not.toThrow();
  });

  it("service refuses to construct when a wildcard host is configured (before touching disk)", () => {
    for (const bad of ["0.0.0.0", "::"]) {
      expect(() => new BrainService(testConfig(tempRoot(), { tailnetHosts: [bad] }))).toThrow(/refusing to bind/);
    }
  });

  it("falls back to 127.0.0.1 when the tailnet IP cannot be bound, and warns", async () => {
    // 192.0.2.1 (TEST-NET-1) is never assigned to a local interface → EADDRNOTAVAIL.
    const h = await startService({
      tailnetHosts: ["192.0.2.1"],
      tailnetRetryWindowMs: 300,
      tailnetRetryInitialDelayMs: 20,
      tailnetRetryMaxDelayMs: 80,
      tailnetBackgroundRetryMs: 0,
    });
    try {
      await h.svc.tailnetSettled;
      expect(h.svc.addresses()).toEqual([`127.0.0.1:${h.svc.port}`]);
      const health = await (await fetch(`${h.url}/health`)).json();
      expect(health.addresses).toEqual([`127.0.0.1:${h.svc.port}`]);
      expect(h.log.lines.some((l) => l.startsWith("warn") && l.includes("192.0.2.1") && l.includes("127.0.0.1 only"))).toBe(true);
      // retried more than once inside the window
      expect(h.log.lines.filter((l) => l.includes("retry #")).length).toBeGreaterThan(1);
    } finally {
      await h.stop();
    }
  });

  it("binds the tailnet address too when it is available (127.0.0.2 stands in for the tailnet IP)", async () => {
    const h = await startService({ tailnetHosts: ["127.0.0.2"], tailnetRetryWindowMs: 500 });
    try {
      await h.svc.tailnetSettled;
      expect(h.svc.addresses().sort()).toEqual([`127.0.0.1:${h.svc.port}`, `127.0.0.2:${h.svc.port}`]);
      const res = await fetch(`http://127.0.0.2:${h.svc.port}/health`);
      expect(res.status).toBe(200);
    } finally {
      await h.stop();
    }
  });

  it("listenWithRetry succeeds once the address becomes bindable", async () => {
    // Occupy a port, free it after a short delay; the retry loop must pick it up.
    const blocker = createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", () => r()));
    const port = (blocker.address() as { port: number }).port;
    setTimeout(() => blocker.close(), 120);
    const s = await listenWithRetry(() => createServer(), "127.0.0.1", port, { windowMs: 3000, initialDelayMs: 25, maxDelayMs: 50 });
    expect(s).not.toBeNull();
    s!.close();
  });
});
