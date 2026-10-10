// brain_provision_agent: scope model, loopback-only, idempotency, guards, audit.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";

import { startService, tool, rpc } from "./helpers.js";
import { readTokenFile } from "../src/tokens.js";
import { ProvisionRateLimiter, assertSafeProvisionScopes } from "../src/provision.js";
import { BrainService } from "../src/service.js";
import { testConfig, tempRoot } from "./helpers.js";

let h: Awaited<ReturnType<typeof startService>> | null = null;
afterEach(async () => { await h?.stop(); h = null; });

const parse = (t: string) => JSON.parse(t);

describe("brain_provision_agent", () => {
  it("provisions a new agent: creates its brain, mints read,write,shared-write, returns the token once, token works", async () => {
    h = await startService();
    const prov = h.mint("openwave-provisioner", ["provision"]);
    const r = await tool(h.url, prov, "brain_provision_agent", { agentId: "gano", label: "gano (Gano) via OpenWave" });
    expect(r.isError).toBe(false);
    const out = parse(r.text);
    expect(out.status).toBe("provisioned");
    expect(out.scopes).toEqual(["read", "write", "shared-write"]);
    expect(out.token).toMatch(/^swt_/);
    expect(existsSync(h.svc.brains.dbPath("gano"))).toBe(true);
    const entry = readTokenFile(h.cfg.tokensFile).tokens.find((t) => t.id === out.tokenId)!;
    expect(entry.label).toBe("gano (Gano) via OpenWave");
    expect(JSON.stringify(readTokenFile(h.cfg.tokensFile))).not.toContain(out.token);

    const w = await tool(h.url, out.token, "brain_write", { type: "semantic", label: "first", content: "Gano's first memory about zebras" });
    expect(w.isError).toBe(false);
    const q = await tool(h.url, out.token, "brain_query", { query: "zebras" });
    expect(q.text).toContain("zebras");

    const audit = readFileSync(h.cfg.auditFile, "utf8");
    expect(audit).not.toContain(out.token);
    expect(audit).toContain(out.tokenId);
  });

  it("is idempotent: second call returns already-provisioned and no token; rotate=true revokes and re-mints", async () => {
    h = await startService();
    const prov = h.mint("openwave-provisioner", ["provision"]);
    const first = parse((await tool(h.url, prov, "brain_provision_agent", { agentId: "wren" })).text);
    const again = parse((await tool(h.url, prov, "brain_provision_agent", { agentId: "wren" })).text);
    expect(again.status).toBe("already-provisioned");
    expect(again.token).toBeUndefined();
    expect(again.tokenIds).toEqual([first.tokenId]);
    // A hand-minted token counts too (e.g. agents provisioned before this feature).
    h.mint("neva", ["read", "write", "shared-write"]);
    expect(parse((await tool(h.url, prov, "brain_provision_agent", { agentId: "neva" })).text).status).toBe("already-provisioned");

    const rot = parse((await tool(h.url, prov, "brain_provision_agent", { agentId: "wren", rotate: true })).text);
    expect(rot.status).toBe("rotated");
    expect(rot.revoked).toEqual([first.tokenId]);
    expect((await rpc(h.url, first.token, "tools/list", {})).status).toBe(401);
    expect((await tool(h.url, rot.token, "brain_stats", {})).isError).toBe(false);
  });

  it("the provision scope grants no read/write; non-provision tokens cannot provision", async () => {
    h = await startService();
    const prov = h.mint("openwave-provisioner", ["provision"]);
    const agent = h.mint("tripp", ["read", "write", "shared-write"]);
    for (const [name, args] of [
      ["brain_query", { query: "x" }], ["brain_write", { type: "semantic", label: "l", content: "c" }],
      ["brain_write", { type: "semantic", label: "l", content: "c", visibility: "shared" }],
      ["brain_stats", {}], ["brain_history", {}], ["brain_episode_append", { role: "user", content: "hi" }],
      ["brain_seed", { mode: "list", source: "*" }],
    ] as const) {
      const r = await tool(h.url, prov, name, args as Record<string, unknown>);
      expect(r.isError, name).toBe(true);
      expect(r.text).toMatch(/forbidden|Invalid|scope/i);
    }
    const list = await rpc(h.url, prov, "tools/list", {});
    expect(list.body.result.tools.map((t: { name: string }) => t.name)).toEqual(["brain_provision_agent"]);
    const agentList = await rpc(h.url, agent, "tools/list", {});
    expect(agentList.body.result.tools.map((t: { name: string }) => t.name)).not.toContain("brain_provision_agent");
    const r = await tool(h.url, agent, "brain_provision_agent", { agentId: "evil" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("provision scope");
    // admin also works (CoS token)
    const admin = h.mint("chief-of-staff", ["read", "write", "shared-write", "admin"]);
    expect(parse((await tool(h.url, admin, "brain_provision_agent", { agentId: "cade" })).text).status).toBe("provisioned");
  });

  it("never escalates: request scopes are ignored, privileged agents refused, bad ids refused, config cannot grant admin", async () => {
    h = await startService();
    const prov = h.mint("openwave-provisioner", ["provision"]);
    const r = parse((await tool(h.url, prov, "brain_provision_agent", { agentId: "gray", scopes: ["admin"] } as never)).text);
    expect(r.scopes).toEqual(["read", "write", "shared-write"]);
    h.mint("chief-of-staff", ["admin"]);
    for (const id of ["chief-of-staff", "openwave-provisioner", "shared", "../etc", "", "a/b"]) {
      const x = await tool(h.url, prov, "brain_provision_agent", { agentId: id, rotate: true });
      expect(x.isError, id).toBe(true);
    }
    expect(() => assertSafeProvisionScopes(["read", "admin"])).toThrow(/admin/);
    expect(() => assertSafeProvisionScopes(["provision"])).toThrow(/provision/);
    expect(() => new BrainService(testConfig(tempRoot(), { provisioning: { scopes: ["admin"] } as never }))).toThrow(/admin/);
    const audit = readFileSync(h.cfg.auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((a) => a.tool === "brain_provision_agent");
    expect(audit.filter((a) => a.outcome === "denied").length).toBeGreaterThanOrEqual(6);
  });

  it("custom server-side scopes, maxAgents and rate limit", async () => {
    h = await startService({ provisioning: { scopes: ["read"], maxAgents: 2, maxPerHour: 100 } });
    const prov = h.mint("p", ["provision"]);
    expect(parse((await tool(h.url, prov, "brain_provision_agent", { agentId: "a1" })).text).scopes).toEqual(["read"]);
    await tool(h.url, prov, "brain_provision_agent", { agentId: "a2" });
    const third = await tool(h.url, prov, "brain_provision_agent", { agentId: "a3" });
    expect(third.text).toContain("max agents");
    let t = 0;
    const lim = new ProvisionRateLimiter(2, () => t);
    expect([lim.take(), lim.take(), lim.take()]).toEqual([true, true, false]);
    t = 3_600_001;
    expect(lim.take()).toBe(true);
  });

  it("disabled provisioning refuses", async () => {
    h = await startService({ provisioning: { enabled: false } });
    const prov = h.mint("p", ["provision"]);
    expect((await tool(h.url, prov, "brain_provision_agent", { agentId: "x" })).text).toContain("disabled");
  });

  it("refuses provisioning that arrives on a non-loopback (tailnet) listener", async () => {
    const ip = Object.values(networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    if (!ip) return; // no non-loopback interface in this sandbox
    h = await startService({ tailnetHosts: [ip] });
    await h.svc.tailnetSettled;
    const prov = h.mint("p", ["provision"]);
    const remote = `http://${ip}:${h.svc.port}`;
    const r = await tool(remote, prov, "brain_provision_agent", { agentId: "x" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("127.0.0.1");
    expect(existsSync(h.svc.brains.dbPath("x"))).toBe(false);
    expect(parse((await tool(h.url, prov, "brain_provision_agent", { agentId: "x" })).text).status).toBe("provisioned");
  });

  it("provision-only token is refused by EVERY non-provisioning tool (allowlist, not per-tool checks)", async () => {
    h = await startService();
    const prov = h.mint("openwave-provisioner", ["provision"]);
    const { SERVICE_TOOLS } = await import("../src/tools.js");
    for (const t of SERVICE_TOOLS) {
      if (t.name === "brain_provision_agent") continue;
      const r = await tool(h.url, prov, t.name, {});
      expect(r.isError, t.name).toBe(true);
      expect(r.text, t.name).toMatch(/forbidden/);
    }
    expect(h.svc.brains.listBrains()).not.toContain("openwave-provisioner");
  });

  it("is idempotent under concurrent requests: one new agent, 8 parallel calls, exactly one token minted", async () => {
    h = await startService();
    const prov = h.mint("openwave-provisioner", ["provision"]);
    const rs = await Promise.all(Array.from({ length: 8 }, () => tool(h!.url, prov, "brain_provision_agent", { agentId: "wren" })));
    const st = rs.map((r) => parse(r.text).status);
    expect(st.filter((s) => s === "provisioned")).toHaveLength(1);
    expect(st.filter((s) => s === "already-provisioned")).toHaveLength(7);
    expect(rs.filter((r) => r.text.includes("swt_"))).toHaveLength(1);
    expect(readTokenFile(h.cfg.tokensFile).tokens.filter((t) => t.agentId === "wren" && !t.revoked)).toHaveLength(1);
  });
});
