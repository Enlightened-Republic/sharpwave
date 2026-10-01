// noise scan / retire / unretire through the REAL CLI on a synthetic brain with
// planted noise (precision + recall), the reversible soft-retire contract
// (backup, audit, registry, exact undo, recall exclusion, sleep never prunes a
// retired node), and the brain_episode_append system-noise guard.
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { startService, tempRoot, tool, nodeIdFrom } from "./helpers.js";
import { parseCsv, parseSelection, toCsv } from "../src/noise.js";

const run = promisify(execFile);
const SERVER_CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const HAVE_CLI = existsSync(SERVER_CLI);

const NOISE_EPISODES: Array<[string, string]> = [
  ["assistant", "NO_REPLY"],
  ["assistant", "NO_REPLY — 8:58 AM, daytime but no owner-blocked work, nothing urgent in scope, she was active 46m ago."],
  ["assistant", "HEARTBEAT_OK"],
  ["user", "[OpenClaw heartbeat poll]"],
  ["user", "[OpenClaw exec completion]\nDisable automatic completion turns with tools.exec.notifyOnExit=false; check per-agent overrides."],
  ["user", "Follow the heartbeat monitor scratch context when provided. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply NO_REPLY."],
];
const REAL_EPISODES: Array<[string, string]> = [
  ["user", "Why does the heartbeat poll keep showing up in my chat? Please fix the delivery target."],
  ["assistant", "The heartbeat had no delivery target, so it fell back to chat; I set it to none. It now replies NO_REPLY silently."],
  ["user", "The quarterly invoices go to the accountant on the 5th."],
];
const NOISE_NODES = [
  "NO_REPLY — 8:58 AM Phoenix, daytime but no Owner-blocked work, nothing urgent in scope, she was active 46m ago. Next tick ~9:28.",
  "HEARTBEAT_OK — monitors green, nothing queued for the owner.",
];
const REAL_NODES = [
  "Owner prefers heartbeat alerts on Telegram, every 6 hours.",
  "The heartbeat runs every 30m; when nothing needs attention it replies NO_REPLY, which OpenClaw hides.",
  "Owner's accountant receives the quarterly invoices on the 5th.",
];

type Row = Record<string, unknown>;
const q = (db: string, sql: string, ...a: unknown[]): Row[] => {
  const d = new Database(db, { readonly: true });
  try { return d.prepare(sql).all(...a) as Row[]; } finally { d.close(); }
};

describe("CSV helpers", () => {
  it("round-trips quoted previews and selects only action=retire rows", () => {
    const rows = [
      { action: "retire", kind: "node", id: "n1", type: "semantic", category: "silent-reply", confidence: "high", importance: 0.6, retrievability: 1, created_at: "", writer: null, source: "sws", session: null, preview: 'NO_REPLY — "quoted", comma' },
      { action: "review", kind: "node", id: "n2", type: "semantic", category: "triage-phrase", confidence: "medium", importance: 0.5, retrievability: 1, created_at: "", writer: null, source: "sws", session: null, preview: "line\nbreak" },
    ] as never;
    const csv = toCsv(rows);
    expect(parseCsv(csv)[1]![12]).toBe('NO_REPLY — "quoted", comma');
    const f = join(tempRoot("sw-noise-csv-"), "r.csv");
    writeFileSync(f, csv);
    expect(parseSelection(f)).toMatchObject({ nodes: ["n1"], episodes: [], ignored: 1 });
    writeFileSync(f, "# reviewed\nnode:n1\nepisode:e1\nbare\n");
    expect(parseSelection(f)).toMatchObject({ nodes: ["n1"], episodes: ["e1"], bare: ["bare"] });
  });
});

describe("brain_episode_append system-noise guard", () => {
  it("skips noise turns by default (not an error, audited) and stores them when disabled", async () => {
    for (const skip of [true, false]) {
      const h = await startService({ skipSystemNoiseEpisodes: skip });
      try {
        const tok = h.mint("nz-ep");
        for (const [role, content] of [...NOISE_EPISODES, ...REAL_EPISODES]) {
          const r = await tool(h.url, tok, "brain_episode_append", { session_id: "agent:nz-ep:main", role, content });
          expect(r.isError).toBe(false);
          const isNoise = NOISE_EPISODES.some(([, c]) => c === content);
          expect(r.text.startsWith("Skipped: system-noise")).toBe(skip && isNoise);
        }
        const n = (q(h.svc.brains.dbPath("nz-ep"), "SELECT COUNT(*) AS n FROM episodes")[0]!["n"]) as number;
        expect(n).toBe(skip ? REAL_EPISODES.length : NOISE_EPISODES.length + REAL_EPISODES.length);
        if (skip) expect(readFileSync(h.cfg.auditFile, "utf8")).toContain("skipped system-noise");
      } finally { await h.stop(); }
    }
  });
});

describe.skipIf(!HAVE_CLI)("noise scan / retire / unretire (real CLI, synthetic brain)", () => {
  it("finds every planted noise item with no false positives at high confidence, retires reversibly, undoes exactly", async () => {
    const root = tempRoot("sw-noise-");
    // Plant: an older client (no guard) wrote noise episodes; sleep/extraction wrote noise nodes.
    let h = await startService({ skipSystemNoiseEpisodes: false }, root);
    const tok = h.mint("nz");
    const nodeIds: Record<string, string> = {};
    for (const [role, content] of [...NOISE_EPISODES, ...REAL_EPISODES]) await tool(h.url, tok, "brain_episode_append", { session_id: "agent:nz:main", role, content });
    for (const c of [...NOISE_NODES, ...REAL_NODES]) nodeIds[c] = nodeIdFrom((await tool(h.url, tok, "brain_write", { type: "semantic", label: c.slice(0, 40), content: c, importance: 0.7 })).text);
    const before = (await tool(h.url, tok, "brain_query", { query: "Owner", scope: "private", format: "json" })).text;
    expect(before).toContain(nodeIds[NOISE_NODES[0]!]!); // the triage node surfaces for the owner's name
    const port = h.cfg.port;
    const dbPath = h.svc.brains.dbPath("nz");
    const cli = (args: string[]) => run(process.execPath, [SERVER_CLI, ...args, "--root", root, "--tailnet-ip", "none", "--port", String(h.svc.url().split(":").pop())]);

    // scan is read-only and safe while the service runs
    const scan = JSON.parse((await cli(["noise", "scan", "--agent", "nz", "--json"])).stdout);
    const report = JSON.parse(readFileSync(scan.report.json, "utf8"));
    expect(scan.report.csv.startsWith(join(root, "noise-reports"))).toBe(true);
    const high = report.candidates.filter((c: Row) => c["confidence"] === "high");
    const highText = high.map((c: Row) => String(c["preview"]));
    // recall: every planted noise item is high confidence
    for (const [, c] of NOISE_EPISODES) expect(highText.some((p: string) => c.replace(/\s+/g, " ").startsWith(p.slice(0, 30)))).toBe(true);
    for (const c of NOISE_NODES) expect(high.some((x: Row) => x["id"] === nodeIds[c])).toBe(true);
    // precision: nothing real is high confidence
    expect(high).toHaveLength(NOISE_EPISODES.length + NOISE_NODES.length);
    for (const c of REAL_NODES) expect(high.some((x: Row) => x["id"] === nodeIds[c])).toBe(false);

    // retire refuses while the service is listening
    await expect(cli(["noise", "retire", "--agent", "nz", "--ids-file", scan.report.csv])).rejects.toThrow(/stop it first/);
    await h.svc.stop();

    const snap = (sqlTable: "nodes" | "episodes") => q(dbPath, sqlTable === "nodes"
      ? "SELECT id, valid_until, ripple_count, eligibility_trace, importance, content FROM nodes ORDER BY id"
      : "SELECT id, importance, llm_extracted, content FROM episodes ORDER BY id");
    const n0 = snap("nodes"), e0 = snap("episodes");

    const dry = JSON.parse((await cli(["noise", "retire", "--agent", "nz", "--ids-file", scan.report.csv, "--dry-run", "--json"])).stdout);
    expect(dry.backup).toBeNull();
    expect(snap("nodes")).toEqual(n0);

    const r = JSON.parse((await cli(["noise", "retire", "--agent", "nz", "--ids-file", scan.report.csv, "--json"])).stdout);
    expect(r.retired.nodes.sort()).toEqual(NOISE_NODES.map((c) => nodeIds[c]).sort());
    expect(r.retired.episodes).toHaveLength(NOISE_EPISODES.length);
    expect(existsSync(r.backup)).toBe(true);
    expect(q(r.backup, "SELECT COUNT(*) AS n FROM nodes WHERE valid_until IS NULL")[0]!["n"]).toBe(n0.filter((x) => x["valid_until"] === null).length);
    // nothing deleted
    expect(snap("nodes")).toHaveLength(n0.length);
    expect(snap("episodes")).toHaveLength(e0.length);
    const audit = readFileSync(join(root, "audit", "audit.jsonl"), "utf8");
    expect(audit).toContain("noise.retire");
    expect(JSON.parse((await cli(["noise", "status", "--agent", "nz", "--json"])).stdout)[0]).toMatchObject({ batch: r.batch, nodes: 2, episodes: NOISE_EPISODES.length });
    // second retire of the same file is a no-op
    const again = JSON.parse((await cli(["noise", "retire", "--agent", "nz", "--ids-file", scan.report.csv, "--json"])).stdout);
    expect(again.retired.nodes).toHaveLength(0);

    // recall no longer surfaces them; sleep neither prunes nor downscales them
    h = await startService({ skipSystemNoiseEpisodes: false }, root);
    const after = (await tool(h.url, tok, "brain_query", { query: "Owner", scope: "private", format: "json" })).text;
    for (const c of NOISE_NODES) expect(after).not.toContain(nodeIds[c]!);
    expect(after).toContain(nodeIds[REAL_NODES[0]!]!);
    await h.svc.runSleepNow(true);
    await h.svc.stop();
    for (const c of NOISE_NODES) expect(q(dbPath, "SELECT COUNT(*) AS n FROM nodes WHERE id = ?", nodeIds[c])[0]!["n"]).toBe(1);

    // scan now reports only already-retired items
    const scan2 = JSON.parse((await cli(["noise", "scan", "--agent", "nz", "--json"])).stdout);
    expect(scan2.high).toBe(0);
    expect(scan2.alreadyRetired).toBe(NOISE_EPISODES.length + NOISE_NODES.length);

    // undo restores the prior values exactly and clears the registry
    const u = JSON.parse((await cli(["noise", "unretire", "--agent", "nz", "--batch", r.batch, "--json"])).stdout);
    expect(u.restored.nodes).toHaveLength(2);
    expect(existsSync(u.backup)).toBe(true);
    const n1 = snap("nodes");
    for (const c of NOISE_NODES) {
      const a = n0.find((x) => x["id"] === nodeIds[c])!, b = n1.find((x) => x["id"] === nodeIds[c])!;
      expect(b["valid_until"]).toBe(a["valid_until"]);
      expect(b["content"]).toBe(a["content"]);
    }
    const e1 = snap("episodes");
    for (const a of e0) expect(e1.find((x) => x["id"] === a["id"])!["importance"]).toBe(a["importance"]);
    expect(JSON.parse((await cli(["noise", "status", "--agent", "nz", "--json"])).stdout)).toEqual([]);
    expect(readFileSync(join(root, "audit", "audit.jsonl"), "utf8")).toContain("noise.unretire");
    h = await startService({}, root);
    expect((await tool(h.url, tok, "brain_query", { query: "Owner", scope: "private", format: "json" })).text).toContain(nodeIds[NOISE_NODES[0]!]!);
    await h.stop();
    void port;
  }, 60_000);
});
