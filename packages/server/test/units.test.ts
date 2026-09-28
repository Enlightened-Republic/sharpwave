import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { TokenStore, mintToken, revokeToken, parseScopes, hashToken, validateAgentId } from "../src/tokens.js";
import { SerialQueue } from "../src/brains.js";
import { msUntilNext, parseHHMM } from "../src/schedule.js";
import { resolveConfig } from "../src/config.js";
import { startService, tempRoot, tool } from "./helpers.js";

describe("tokens", () => {
  it("mint stores only the hash; verify resolves agent + scopes; revoke takes effect without restart", () => {
    const f = join(tempRoot(), "tokens.json");
    const store = new TokenStore(f);
    const { token, entry } = mintToken(f, "alice", ["read", "shared-write"]);
    expect(readFileSync(f, "utf8")).not.toContain(token);
    expect(entry.hash).toBe(hashToken(token));
    const p = store.verify(token)!;
    expect(p.agentId).toBe("alice");
    expect([...p.scopes]).toEqual(["read", "shared-write"]);
    expect(store.verify(token + "x")).toBeNull();
    expect(store.verify("")).toBeNull();
    expect(revokeToken(f, entry.id)).toBe(true);
    expect(store.verify(token)).toBeNull();
  });

  it("rejects reserved / malformed agent ids and unknown scopes", () => {
    expect(validateAgentId("shared")).toMatch(/reserved/);
    expect(validateAgentId("../etc")).toMatch(/invalid/);
    expect(validateAgentId("chief-of-staff")).toBeNull();
    expect(() => parseScopes("read,root")).toThrow(/unknown scope/);
    expect(() => mintToken(join(tempRoot(), "t.json"), "shared", ["read"])).toThrow(/reserved/);
  });

  it("refuses to load a token file containing plaintext", () => {
    const f = join(tempRoot(), "tokens.json");
    writeFileSync(f, JSON.stringify({ version: 1, tokens: [{ id: "x", hash: "sha256:00", token: "swt_leak", agentId: "a", scopes: ["read"] }] }));
    expect(() => new TokenStore(f)).toThrow(/plaintext/);
  });
});

describe("SerialQueue", () => {
  it("runs tasks strictly one at a time in order, surviving failures", async () => {
    const q = new SerialQueue();
    const log: string[] = [];
    let active = 0;
    const task = (n: number, fail = false) => q.run(async () => {
      active++;
      expect(active).toBe(1);
      log.push(`s${n}`);
      await new Promise((r) => setTimeout(r, 5));
      log.push(`e${n}`);
      active--;
      if (fail) throw new Error("boom");
      return n;
    });
    const res = await Promise.allSettled([task(1), task(2, true), task(3)]);
    expect(log).toEqual(["s1", "e1", "s2", "e2", "s3", "e3"]);
    expect(res.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });
});

describe("schedule + config", () => {
  it("computes the next HH:MM", () => {
    const now = new Date(2026, 8, 28, 2, 0, 0);
    expect(msUntilNext("02:30", now)).toBe(30 * 60_000);
    expect(msUntilNext("01:00", now)).toBe(23 * 3600_000);
    expect(() => parseHHMM("25:00")).toThrow();
  });

  it("defaults: port 18790, tailnet 100.121.136.3, tokens under root", () => {
    const c = resolveConfig({ root: "/tmp/x" });
    expect(c.port).toBe(18790);
    expect(c.tailnetHosts).toEqual(["100.121.136.3"]);
    expect(c.tokensFile).toBe("/tmp/x/tokens.json");
    expect(c.allowReset).toBe(false);
  });
});

describe("sleep", () => {
  it("runs consolidation in-process on each brain within one budget and audits it", async () => {
    const h = await startService({ sleep: { enabled: false, budgetMs: 60_000, respectGate: false } });
    try {
      const tok = h.mint("alice");
      await tool(h.url, tok, "brain_write", { type: "semantic", label: "sleepy", content: "sleep test payload" });
      const r = await h.svc.runSleepNow(true);
      expect(r.failed).toEqual([]);
      expect(r.ran.sort()).toEqual(["alice", "shared"]);
      const audit = readFileSync(h.cfg.auditFile, "utf8");
      expect(audit).toContain('"tool":"consolidation"');

      // Zero budget: everything deferred to the next cycle.
      (h.svc.sleep as unknown as { budgetMs: number }).budgetMs = 0;
      const r2 = await h.svc.runSleepNow(true);
      expect(r2.ran).toEqual([]);
      expect(r2.deferred.length).toBe(2);
    } finally {
      await h.stop();
    }
  });
});
