// Seeding: brain_seed (server) + `sharpwave-client seed` (client), against a
// live test server with FAKE fixture markdown (no real seed content here).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { rpc, startService, tool } from "./helpers.js";

const run = promisify(execFile);
const CLIENT = fileURLToPath(new URL("../bin/sharpwave-client.mjs", import.meta.url));

let h: Awaited<ReturnType<typeof startService>>;
let admin: string;     // "cos": admin + shared-write
let agent: string;     // "writer-1": read + write
let fixtures: string;

async function client(args: string[]) {
  try {
    const r = await run(process.execPath, [CLIENT, ...args], { env: { ...process.env, SHARPWAVE_TOKEN: "", SHARPWAVE_TOKEN_FILE: "" } });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string };
    return { code: x.code, stdout: x.stdout, stderr: x.stderr };
  }
}
const seed = (extra: string[], token = admin) =>
  client(["seed", fixtures, "--url", h.url, "--token", token,
    "--map", "00-readme.md=skip", "--map", "01-team.md=shared", "--map", "02-widgets.md=shared", "--map", "03-private.md=private",
    ...extra]);

beforeAll(async () => {
  h = await startService();
  admin = h.mint("cos", ["admin", "shared-write"]);
  agent = h.mint("writer-1", ["read", "write"]);
  fixtures = mkdtempSync(join(tmpdir(), "sw-seed-fx-"));
  writeFileSync(join(fixtures, "00-readme.md"), "# Readme\n\nNot imported.\n");
  writeFileSync(join(fixtures, "01-team.md"), [
    "# Team", "", "Fixture intro about the zebra team.", "",
    "## Lanes", "", "Zebra lane owns fixture widgets.", "",
    "## Empty", "",
    "## Rituals", "### Daily", "Zebra standup at nine.", "### Weekly", "", "#### Notes", "Zebra retro on fridays.", "",
  ].join("\n"));
  writeFileSync(join(fixtures, "02-widgets.md"), "# Widgets\r\n\r\n## Blue\r\n\r\nBlue widget fixture.\r\n\r\n```\r\n# not a heading\r\n```\r\n\r\n## Red\r\n\r\n" +
    Array.from({ length: 12 }, (_, i) => `Red widget fixture paragraph ${i} ${"lorem ".repeat(30)}`).join("\n\n") + "\r\n");
  writeFileSync(join(fixtures, "03-private.md"), "# Private\n\n## Quokka account\n\nQuokka fixture account detail.\n");
});
afterAll(async () => {
  await h.stop();
  rmSync(fixtures, { recursive: true, force: true });
});

describe("seed", () => {
  it("--offline chunks by heading without a server", async () => {
    const r = await client(["seed", fixtures, "--offline", "--json", "--target", "shared", "--map", "00-readme.md=skip", "--map", "03-private.md=private"]);
    expect(r.code, r.stderr).toBe(0);
    const res = JSON.parse(r.stdout).results;
    expect(res).toEqual([
      { file: "00-readme.md", target: "skip" },
      { file: "01-team.md", target: "shared", chunks: 4 },     // intro, Lanes, Daily, Weekly (Empty dropped, #### stays in body)
      { file: "02-widgets.md", target: "shared", chunks: 1 + 2 }, // Blue + Red (~2.5k chars) split into 2 parts at 1800
      { file: "03-private.md", target: "private", chunks: 1 },
    ]);
  });

  it("splits an oversized bullet list on line boundaries, never mid-line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sw-seed-log-"));
    try {
      const bullets = Array.from({ length: 40 }, (_, i) => `- (2026-01-${String(i % 28 + 1).padStart(2, "0")}) fixture decision number ${i} ${"x".repeat(60)}`);
      writeFileSync(join(dir, "log.md"), `# Log\n\n${bullets.join("\n")}\n`);
      const r = await client(["seed", dir, "--offline", "--json", "--target", "shared", "--max-chars", "1000"]);
      expect(r.code, r.stderr).toBe(0);
      expect(JSON.parse(r.stdout).results[0].chunks).toBe(5); // ~4k chars greedily packed into <=1000-char chunks
      // Import for real and check every chunk holds only whole bullet lines.
      const base = ["seed", dir, "--target", "shared", "--max-chars", "1000", "--url", h.url, "--token", admin, "--json"];
      expect((await client(base)).code).toBe(0);
      const hits = JSON.parse((await tool(h.url, admin, "brain_query", { query: "fixture decision", limit: 20, scope: "shared", format: "json" })).text).results;
      expect(hits.length).toBe(5);
      for (const hit of hits) {
        const body = (hit.content as string).split("\n\nTags:")[0]!;
        for (const line of body.split("\n")) expect(line).toMatch(/^- \(2026-01-\d\d\) fixture decision number \d+ x{60}$/);
      }
      expect(JSON.parse((await client([...base, "--remove"])).stdout).results[0].removed).toBe(5);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("refuses unmapped files", async () => {
    const r = await client(["seed", fixtures, "--offline", "--map", "01-team.md=shared"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no target for");
  });

  it("dry-run writes nothing; import creates; re-import is a no-op", async () => {
    const dry = await seed(["--dry-run", "--json"]);
    expect(dry.code, dry.stderr).toBe(0);
    const d = JSON.parse(dry.stdout).results.filter((x: { target: string }) => x.target !== "skip");
    expect(d.map((x: { wouldCreate: number }) => x.wouldCreate)).toEqual([4, 3, 1]);
    let stats = JSON.parse((await tool(h.url, admin, "brain_stats", { format: "json" })).text);
    expect(stats.brains.map((b: { nodes: number }) => b.nodes)).toEqual([0, 0]);

    const imp = await seed(["--json"]);
    expect(imp.code, imp.stderr).toBe(0);
    const i1 = JSON.parse(imp.stdout).results.filter((x: { target: string }) => x.target !== "skip");
    expect(i1.map((x: { created: number }) => x.created)).toEqual([4, 3, 1]);

    const again = await seed(["--json"]);
    const i2 = JSON.parse(again.stdout).results.filter((x: { target: string }) => x.target !== "skip");
    expect(i2.map((x: { created: number; existing: number }) => [x.created, x.existing])).toEqual([[0, 4], [0, 3], [0, 1]]);

    stats = JSON.parse((await tool(h.url, admin, "brain_stats", { format: "json" })).text);
    const by = Object.fromEntries(stats.brains.map((b: { brain: string; nodes: number; writers: Record<string, number> }) => [b.brain, b]));
    expect(by.private.nodes).toBe(1);
    expect(by.shared.nodes).toBe(7);
    expect(by.shared.writers).toEqual({ cos: 7 });
  });

  it("private chunks stay private; shared chunks are visible to other agents with the seed source", async () => {
    const mine = JSON.parse((await tool(h.url, admin, "brain_query", { query: "quokka", format: "json" })).text).results;
    expect(mine[0]).toMatchObject({ brain: "private", writer: "cos" });
    const theirs = JSON.parse((await tool(h.url, agent, "brain_query", { query: "quokka", format: "json" })).text).results;
    expect(theirs).toEqual([]);

    const z = JSON.parse((await tool(h.url, agent, "brain_query", { query: "zebra standup", format: "json" })).text).results;
    expect(z[0]).toMatchObject({ brain: "shared", writer: "cos", label: "Team \u203a Rituals \u203a Daily" });
    const exp = await tool(h.url, agent, "brain_expand", { node_id: z[0].id });
    expect(exp.text).toMatch(/Source: seed:01-team\.md#[0-9a-f]{16}/);
    expect(exp.text).toContain("Tags: seed, 01-team");
  });

  it("audit log has one brain_seed line per created node", () => {
    const lines = readFileSync(h.cfg.auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const seeded = lines.filter((l) => l.tool === "brain_seed" && !String(l.detail).includes("log.md"));
    expect(seeded).toHaveLength(8);
    // the split test's import + remove were audited too
    expect(lines.filter((l) => l.detail === "seed:log.md")).toHaveLength(5);
    expect(lines.filter((l) => l.detail === "remove seed:log.md")).toHaveLength(5);
    expect(new Set(seeded.map((l) => l.agentId))).toEqual(new Set(["cos"]));
    expect(seeded.filter((l) => l.detail === "seed:03-private.md").every((l) => l.brain === "cos")).toBe(true);
  });

  it("non-admin tokens cannot seed and don't see the tool", async () => {
    const r = await seed(["--json"], agent);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("admin scope");
    const listAgent = await rpc(h.url, agent, "tools/list", {});
    expect(listAgent.body.result.tools.map((t: { name: string }) => t.name)).not.toContain("brain_seed");
    const listAdmin = await rpc(h.url, admin, "tools/list", {});
    expect(listAdmin.body.result.tools.map((t: { name: string }) => t.name)).toContain("brain_seed");
  });

  it("edited file: new chunk added, stale counted, --prune removes it", async () => {
    const f = join(fixtures, "03-private.md");
    writeFileSync(f, "# Private\n\n## Quokka account\n\nQuokka fixture account detail, revised.\n");
    const r = JSON.parse((await seed(["--json", "--prune"])).stdout).results.find((x: { file: string }) => x.file === "03-private.md");
    expect(r).toMatchObject({ created: 1, existing: 0, staleFromEarlierVersions: 1, pruned: 1 });
    const stats = JSON.parse((await tool(h.url, admin, "brain_stats", { visibility: "private", format: "json" })).text);
    expect(stats.brains[0].nodes).toBe(1);
  });

  it("--list counts per source; --remove deletes only seeded nodes (rollback by source)", async () => {
    await tool(h.url, admin, "brain_write", { type: "semantic", label: "Hand written", content: "Not from a seed file", visibility: "shared" });
    const l = await seed(["--list", "--json"]);
    const rows = JSON.parse(l.stdout);
    expect(rows[1]).toMatchObject({ brain: "shared", total: 7, sources: { "01-team.md": 4, "02-widgets.md": 3 } });
    expect(rows[0]).toMatchObject({ brain: "private", total: 1, sources: { "03-private.md": 1 } });

    const rm = await seed(["--remove", "--json"]);
    expect(rm.code, rm.stderr).toBe(0);
    expect(JSON.parse(rm.stdout).results.filter((x: { target: string }) => x.target !== "skip").map((x: { removed: number }) => x.removed)).toEqual([4, 3, 1]);
    const stats = JSON.parse((await tool(h.url, admin, "brain_stats", { format: "json" })).text);
    const by = Object.fromEntries(stats.brains.map((b: { brain: string; nodes: number }) => [b.brain, b.nodes]));
    expect(by).toEqual({ private: 0, shared: 1 }); // the hand-written node survives
  });

  it("client forget deletes one node (private and --shared)", async () => {
    const w = JSON.parse((await client(["write", "temporary", "smoke", "--label", "smoke", "--url", h.url, "--token", agent, "--json"])).stdout);
    const f = await client(["forget", w.id, "--url", h.url, "--token", agent]);
    expect(f.code, f.stderr).toBe(0);
    expect(f.stdout).toContain(`Deleted node ${w.id}`);
    const r = await client(["read", w.id, "--url", h.url, "--token", agent]);
    expect(r.code).toBe(1);
    const sw = JSON.parse((await client(["write", "shared", "smoke", "--label", "smoke", "--shared", "--url", h.url, "--token", admin, "--json"])).stdout);
    const denied = await client(["forget", sw.id, "--shared", "--url", h.url, "--token", agent]);
    expect(denied.code).toBe(1);
    expect(denied.stderr).toContain("shared-write");
    expect((await client(["forget", sw.id, "--shared", "--url", h.url, "--token", admin])).code).toBe(0);
  });

  it("server validates inputs", async () => {
    const bad = await tool(h.url, admin, "brain_seed", { mode: "import", source: "../x.md", chunks: [] });
    expect(bad.isError).toBe(true);
    const prot = await tool(h.url, admin, "brain_seed", { mode: "import", source: "x.md", chunks: [{ label: "l", content: "c", type: "identity" }] });
    expect(prot.isError).toBe(true);
    expect(prot.text).toContain("protected");
  });
});
