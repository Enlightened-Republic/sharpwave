// Concurrency, provenance, visibility, and auth over real HTTP.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { startService, rpc, tool, nodeIdFrom } from "./helpers.js";

let h: Awaited<ReturnType<typeof startService>>;
let tokA: string, tokB: string, tokC: string, tokShared: string, tokReadOnly: string;

beforeAll(async () => {
  h = await startService();
  tokA = h.mint("alice");
  tokB = h.mint("bob");
  tokC = h.mint("carol");
  tokShared = h.mint("dave", ["read", "write", "shared-write"]);
  tokReadOnly = h.mint("erin", ["read"]);
});
afterAll(async () => { await h.stop(); });

describe("concurrent writers", () => {
  it("lands every write from 3 clients firing at once, each stamped with its token's agent, ignoring claimed writers", async () => {
    const per = 15;
    const clients: Array<[string, string]> = [["alice", tokA], ["bob", tokB], ["carol", tokC]];
    const results = await Promise.all(clients.flatMap(([agent, tok]) =>
      Array.from({ length: per }, (_, i) => tool(h.url, tok, "brain_write", {
        type: "semantic",
        label: `${agent} fact ${i}`,
        content: `${agent} distinct observation number ${i} about topic ${agent}-${i}-${Math.random().toString(36).slice(2)}`,
        writer_agent_id: "mallory", // forged claim — must be ignored
      })),
    ));
    expect(results.every((r) => !r.isError)).toBe(true);
    expect(results.every((r) => r.text.includes("ignored"))).toBe(true);

    for (const [agent] of clients) {
      const db = new Database(h.svc.brains.dbPath(agent), { readonly: true });
      const rows = db.prepare("SELECT writer_agent_id AS w, COUNT(*) AS n FROM nodes GROUP BY w").all() as Array<{ w: string; n: number }>;
      db.close();
      expect(rows).toEqual([{ w: agent, n: per }]);
    }
    // No forged writer anywhere, including shared.
    const sdb = new Database(h.svc.brains.dbPath("shared"), { readonly: true });
    expect((sdb.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number }).n).toBe(0);
    sdb.close();

    // Audit: one ok line per write, agent from the token.
    const audit = readFileSync(h.cfg.auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const writes = audit.filter((a) => a.tool === "brain_write" && a.outcome === "ok");
    expect(writes).toHaveLength(per * 3);
    for (const a of writes) {
      expect(["alice", "bob", "carol"]).toContain(a.agentId);
      expect(a.brain).toBe(a.agentId);
      expect(a.nodeId).toMatch(/^[0-9a-f-]{36}$/);
      expect(typeof a.time).toBe("string");
    }
  });
});

describe("private vs shared visibility", () => {
  it("shared brain starts empty", async () => {
    const r = await tool(h.url, tokA, "brain_stats", { visibility: "shared", format: "json" });
    const s = JSON.parse(r.text);
    expect(s.brains[0]).toMatchObject({ brain: "shared", nodes: 0 });
  });

  it("A cannot read B's private memory, but both read shared; results are labelled", async () => {
    const bPriv = await tool(h.url, tokB, "brain_write", { type: "semantic", label: "bob secret zebra", content: "bob private zebracorn note" });
    const bId = nodeIdFrom(bPriv.text);
    const sh = await tool(h.url, tokShared, "brain_write", { type: "semantic", label: "shared zebracorn fact", content: "zebracorn deploy procedure lives in the runbook", visibility: "shared" });
    expect(sh.isError).toBe(false);
    expect(sh.text).toContain("brain=shared writer=dave");
    const shId = nodeIdFrom(sh.text);

    const aQ = await tool(h.url, tokA, "brain_query", { query: "zebracorn", format: "json" });
    const aHits = JSON.parse(aQ.text).results as Array<{ id: string; brain: string; writer: string }>;
    expect(aHits.map((x) => x.id)).toContain(shId);
    expect(aHits.map((x) => x.id)).not.toContain(bId);
    expect(aHits.find((x) => x.id === shId)).toMatchObject({ brain: "shared", writer: "dave" });

    const bQ = await tool(h.url, tokB, "brain_query", { query: "zebracorn", format: "json" });
    const bHits = JSON.parse(bQ.text).results as Array<{ id: string; brain: string }>;
    expect(bHits.find((x) => x.id === bId)?.brain).toBe("private");
    expect(bHits.find((x) => x.id === shId)?.brain).toBe("shared");

    // Direct fetch by id of another agent's node is also impossible.
    const aExpand = await tool(h.url, tokA, "brain_expand", { node_id: bId });
    expect(aExpand.isError).toBe(true);
    const aShared = await tool(h.url, tokA, "brain_expand", { node_id: shId });
    expect(aShared.isError).toBe(false);
    expect(aShared.text).toContain("[shared]");
  });

  it("denies shared writes without shared-write scope (and audits the denial)", async () => {
    const r = await tool(h.url, tokA, "brain_write", { type: "semantic", label: "nope", content: "should not land in shared", visibility: "shared" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/shared-write/);
    const link = await tool(h.url, tokA, "brain_forget", { node_id: "00000000-0000-0000-0000-000000000000", visibility: "shared" });
    expect(link.isError).toBe(true);
    const audit = readFileSync(h.cfg.auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.some((a) => a.agentId === "alice" && a.brain === "shared" && a.outcome === "denied")).toBe(true);
  });

  it("read-only token cannot write at all", async () => {
    const r = await tool(h.url, tokReadOnly, "brain_write", { type: "semantic", label: "x", content: "y" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/forbidden/);
  });

  it("brain_reset is disabled by default even for admin", async () => {
    const admin = h.mint("root-admin", ["read", "write", "admin"]);
    const r = await tool(h.url, admin, "brain_reset", { confirm: "root-admin" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/disabled/);
  });

  it("link / supersede / edges are scoped and server-stamped", async () => {
    const a1 = nodeIdFrom((await tool(h.url, tokA, "brain_write", { type: "semantic", label: "alpha one", content: "alpha one unique content qq1" })).text);
    const a2 = nodeIdFrom((await tool(h.url, tokA, "brain_write", { type: "semantic", label: "alpha two", content: "alpha two unique content qq2" })).text);
    const l = await tool(h.url, tokA, "brain_link", { from_id: a1, to_id: a2, edge_type: "supports" });
    expect(l.isError).toBe(false);
    const edges = JSON.parse((await tool(h.url, tokA, "brain_edges", { node_id: a1 })).text);
    expect(edges.outgoing[0]).toMatchObject({ connectedId: a2, edgeType: "supports" });
    const s = await tool(h.url, tokA, "brain_supersede", { old_node_id: a2, new_content: "alpha two revised qq3" });
    expect(s.text).toContain("writer=alice");
    // bob cannot link alice's nodes (they don't exist in bob's brain)
    const bl = await tool(h.url, tokB, "brain_link", { from_id: a1, to_id: a2, edge_type: "supports" });
    expect(bl.isError).toBe(true);
  });
});

describe("auth + health", () => {
  it("401 for a missing token", async () => {
    const r = await rpc(h.url, null, "tools/list", {});
    expect(r.status).toBe(401);
    expect(JSON.stringify(r.body)).not.toMatch(/alice|zebra|brain_write/);
  });

  it("401 for a bad token (including a token-shaped forgery and a hash)", async () => {
    for (const bad of ["nope", "swt_" + "A".repeat(43), tokA.slice(0, -1) + (tokA.endsWith("A") ? "B" : "A")]) {
      const r = await rpc(h.url, bad, "tools/call", { name: "brain_query", arguments: { query: "zebracorn" } });
      expect(r.status).toBe(401);
    }
    const hash = JSON.parse(readFileSync(h.cfg.tokensFile, "utf8")).tokens[0].hash as string;
    expect((await rpc(h.url, hash, "tools/list", {})).status).toBe(401);
  });

  it("token file holds hashes only", () => {
    const raw = readFileSync(h.cfg.tokensFile, "utf8");
    for (const t of [tokA, tokB, tokC, tokShared]) expect(raw).not.toContain(t);
    expect(raw).toMatch(/"sha256:[0-9a-f]{64}"/);
  });

  it("/health is unauthenticated and returns only status, version, addresses", async () => {
    const res = await fetch(`${h.url}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["addresses", "status", "version"]);
    expect(body.status).toBe("ok");
    expect(body.addresses).toEqual([`127.0.0.1:${h.svc.port}`]);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/alice|bob|zebra|nodes|sha256|swt_/);
  });

  it("refuses browser origins and non-POST on /mcp", async () => {
    const r = await rpc(h.url, tokA, "tools/list", {}, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
    const g = await fetch(`${h.url}/mcp`, { headers: { authorization: `Bearer ${tokA}` } });
    expect(g.status).toBe(405);
  });

  it("works with the official MCP SDK client (Streamable HTTP)", async () => {
    const client = new Client({ name: "test", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${h.url}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${tokA}` } },
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "brain_query", "brain_write", "brain_link", "brain_supersede", "brain_stats",
      "brain_history", "brain_expand", "brain_review", "brain_forget", "brain_edges", "brain_reset",
    ]);
    // writer_agent_id is not even advertised
    const w = tools.find((t) => t.name === "brain_write")!;
    expect(Object.keys((w.inputSchema as { properties: object }).properties)).not.toContain("writer_agent_id");
    const r = await client.callTool({ name: "brain_query", arguments: { query: "zebracorn" } });
    expect(JSON.stringify(r.content)).toContain("[shared]");
    await client.close();
  });
});
