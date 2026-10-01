// brain_episode_append over real HTTP: scopes, provenance, visibility, and
// pickup by the service's sleep/consolidation (same path as local episodes).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import Database from "better-sqlite3";

import { startService, rpc, tool } from "./helpers.js";

let h: Awaited<ReturnType<typeof startService>>;
let tokA: string, tokB: string, tokShared: string, tokReadOnly: string;

beforeAll(async () => {
  h = await startService();
  tokA = h.mint("ep-alice");
  tokB = h.mint("ep-bob");
  tokShared = h.mint("ep-dave", ["read", "write", "shared-write"]);
  tokReadOnly = h.mint("ep-erin", ["read"]);
});
afterAll(async () => { await h.stop(); });

type EpRow = { id: string; session_id: string; role: string; content: string; importance: number; writer_agent_id: string; llm_extracted: number; meta: string | null };

function episodes(brain: string): EpRow[] {
  const db = new Database(h.svc.brains.dbPath(brain), { readonly: true });
  try {
    return db.prepare("SELECT * FROM episodes ORDER BY created_at, rowid").all() as EpRow[];
  } finally {
    db.close();
  }
}

function meta(brain: string, key: string): string | null {
  const db = new Database(h.svc.brains.dbPath(brain), { readonly: true });
  try {
    return (db.prepare("SELECT value FROM meta_kv WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
  } finally {
    db.close();
  }
}

const idFrom = (text: string) => /episode ([0-9a-f-]{36})/.exec(text)![1]!;

describe("brain_episode_append", () => {
  it("is advertised in tools/list without a writer_agent_id field", async () => {
    const r = await rpc(h.url, tokA, "tools/list", {});
    const t = (r.body.result.tools as Array<{ name: string; inputSchema: { properties: Record<string, unknown>; required: string[] } }>).find((x) => x.name === "brain_episode_append");
    expect(t).toBeTruthy();
    expect(t!.inputSchema.properties).not.toHaveProperty("writer_agent_id");
    expect(t!.inputSchema.required).toEqual(["session_id", "role", "content"]);
  });

  it("appends to the caller's private brain, stamped with the token's agent (forged writer ignored)", async () => {
    const r = await tool(h.url, tokA, "brain_episode_append", {
      session_id: "agent:main:telegram:1", role: "user", content: "Alice mentions the pelican migration schedule", importance: 0.6,
      meta: { channel: "telegram" }, writer_agent_id: "mallory",
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("brain=private writer=ep-alice");
    expect(r.text).toContain("ignored");
    const rows = episodes("ep-alice");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: idFrom(r.text), session_id: "agent:main:telegram:1", role: "user", importance: 0.6, writer_agent_id: "ep-alice", llm_extracted: 0 });
    expect(JSON.parse(rows[0]!.meta!)).toEqual({ channel: "telegram" });
    // Nowhere else.
    expect(episodes("shared")).toHaveLength(0);
    await tool(h.url, tokB, "brain_stats", {}); // opens bob's brain
    expect(episodes("ep-bob")).toHaveLength(0);
    const audit = readFileSync(h.cfg.auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.some((a) => a.tool === "brain_episode_append" && a.agentId === "ep-alice" && a.brain === "ep-alice" && a.outcome === "ok")).toBe(true);
  });

  it("omitted importance uses the engine heuristic (same as local appendEpisode)", async () => {
    const r = await tool(h.url, tokB, "brain_episode_append", { session_id: "s", role: "user", content: "Please remember: the boiler code is in the blue folder" });
    expect(r.text).toContain("importance=0.85");
  });

  it("enforces scopes: read-only refused; shared needs shared-write (denial audited); shared-write lands in shared", async () => {
    const ro = await tool(h.url, tokReadOnly, "brain_episode_append", { session_id: "s", role: "user", content: "read only attempt" });
    expect(ro.isError).toBe(true);
    expect(ro.text).toMatch(/forbidden.*write scope/);

    const denied = await tool(h.url, tokA, "brain_episode_append", { session_id: "s", role: "user", content: "alice tries shared", visibility: "shared" });
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/shared-write/);
    const audit = readFileSync(h.cfg.auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit.some((a) => a.tool === "brain_episode_append" && a.agentId === "ep-alice" && a.outcome === "denied")).toBe(true);
    expect(episodes("shared")).toHaveLength(0);

    const ok = await tool(h.url, tokShared, "brain_episode_append", { session_id: "team", role: "assistant", content: "Team-wide note from dave", visibility: "shared" });
    expect(ok.text).toContain("brain=shared writer=ep-dave");
    const shared = episodes("shared");
    expect(shared).toHaveLength(1);
    expect(shared[0]!.writer_agent_id).toBe("ep-dave");
    // dave's private brain did not get it
    await tool(h.url, tokShared, "brain_stats", {});
    expect(episodes("ep-dave")).toHaveLength(0);
  });

  it("validates arguments", async () => {
    const bad = [
      {},
      { session_id: "s", role: "narrator", content: "x" },
      { session_id: "", role: "user", content: "x" },
      { session_id: "s", role: "user", content: "   " },
      { session_id: "s", role: "user", content: "x", importance: 2 },
      { session_id: "s", role: "user", content: "x", meta: [1, 2] },
      { session_id: "s", role: "user", content: "x".repeat(32_001) },
      { session_id: "s", role: "user", content: "x", visibility: "everyone" },
    ];
    for (const args of bad) {
      const r = await tool(h.url, tokB, "brain_episode_append", args);
      expect(r.isError, JSON.stringify(args).slice(0, 80)).toBe(true);
    }
  });
});

describe("sleep/consolidation picks up appended episodes", () => {
  it("they count toward the episode gate and SWS consumes them (llm_extracted=1), exactly like local episodes", async () => {
    const tok = h.mint("ep-frank");
    const send = (i: number) => tool(h.url, tok, "brain_episode_append", {
      session_id: `agent:main:chat:${i % 3}`, role: i % 2 ? "assistant" : "user", importance: 0.6,
      content: `Frank discussed the walnut orchard irrigation plan, item ${i}, with valve ${i * 7} details and timing notes`,
    });
    for (let i = 0; i < 4; i++) expect((await send(i)).isError).toBe(false);

    // Gate (respectGate=true, default episode gate 10): 4 new episodes is not enough.
    const r1 = await h.svc.runSleepNow(false);
    expect(r1.skippedGate).toContain("ep-frank");
    expect(meta("ep-frank", "last_consolidation")).toBeNull();

    for (let i = 4; i < 10; i++) await send(i);
    const r2 = await h.svc.runSleepNow(false);
    expect(r2.ran).toContain("ep-frank");
    expect(meta("ep-frank", "last_consolidation")).not.toBeNull();
    expect(meta("ep-frank", "last_consolidation_episode_count")).toBe("10");
  });

  it("a forced cycle runs SWS over appended episodes and marks them consumed", async () => {
    const tok = h.mint("ep-gina");
    for (let i = 0; i < 3; i++) {
      await tool(h.url, tok, "brain_episode_append", {
        session_id: `agent:main:chat:${i}`, role: "user", importance: 0.7,
        content: `Gina says the quarterly kiln maintenance happens on the first Monday, reminder ${i}`,
      });
    }
    expect(episodes("ep-gina").every((e) => e.llm_extracted === 0)).toBe(true);
    const r = await h.svc.runSleepNow(true);
    expect(r.ran).toContain("ep-gina");
    const after = episodes("ep-gina");
    expect(after).toHaveLength(3);
    expect(after.every((e) => e.llm_extracted === 1)).toBe(true);
  });
});
