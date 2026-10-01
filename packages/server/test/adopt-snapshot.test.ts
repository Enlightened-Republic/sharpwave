// Real-copy adoption: a COPY of a real legacy brain snapshot is adopted as
// agent "main" through the real CLI, then served and read back with a minted
// `main` token (brain_stats / brain_query / brain_history + shared).
//
// Source: $SHARPWAVE_SNAPSHOT_DIR (dir with brain.db [+ brain.db-wal]), default
// /workspace/brain-snap/main. Skipped when absent (CI, other machines). The
// snapshot is never opened or modified — only copied — and its sha256 is
// checked unchanged at the end. Expected counts default to the reference
// snapshot (533/1380/248); override with SHARPWAVE_SNAPSHOT_EXPECT="n/e/ep".
// No memory content is asserted on or printed.
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { startService, tempRoot, tool } from "./helpers.js";

const run = promisify(execFile);
const SERVER_CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const CLIENT = fileURLToPath(new URL("../bin/sharpwave-client.mjs", import.meta.url));
const SRC = process.env["SHARPWAVE_SNAPSHOT_DIR"] ?? "/workspace/brain-snap/main";
const has = existsSync(join(SRC, "brain.db"));
const [EN, EE, EP] = (process.env["SHARPWAVE_SNAPSHOT_EXPECT"] ?? (process.env["SHARPWAVE_SNAPSHOT_DIR"] ? "" : "533/1380/248")).split("/").map(Number);
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

describe.skipIf(!has)("adopt a real brain snapshot copy as agent 'main'", () => {
  it("adopts 1:1 (counts, schema 18, integrity ok), serves it to the main token, shared works, snapshot untouched", async () => {
    const files = ["brain.db", "brain.db-wal", "brain.db-shm"].filter((f) => existsSync(join(SRC, f)));
    const shaBefore = Object.fromEntries(files.map((f) => [f, sha(join(SRC, f))]));

    const root = tempRoot("sw-adopt-snap-");
    const legacy = join(root, "dot-sharpwave", "main"); // stands in for C:\Users\<u>\.sharpwave\main
    mkdirSync(legacy, { recursive: true });
    for (const f of files.filter((x) => x !== "brain.db-shm")) copyFileSync(join(SRC, f), join(legacy, f));
    const svcRoot = join(root, "service");

    const cli = (args: string[]) => run(process.execPath, [SERVER_CLI, ...args, "--root", svcRoot, "--tailnet-ip", "none", "--port", "1"]);
    const dry = JSON.parse((await cli(["brain", "adopt", "--agent", "main", "--from", legacy, "--dry-run", "--json"])).stdout);
    expect(dry.dryRun).toBe(true);
    expect(dry.before.schema).toBeLessThan(18);
    if (EN) expect([dry.before.nodes, dry.before.edges, dry.before.episodes]).toEqual([EN, EE, EP]);

    const r = JSON.parse((await cli(["brain", "adopt", "--agent", "main", "--from", legacy, "--json"])).stdout);
    expect(r.integrity).toBe("ok");
    expect(r.after.schema).toBe(18);
    expect([r.after.nodes, r.after.edges, r.after.episodes]).toEqual([r.before.nodes, r.before.edges, r.before.episodes]);
    if (EN) expect([r.after.nodes, r.after.edges, r.after.episodes]).toEqual([EN, EE, EP]);
    expect(r.sourceUnchanged).toBe(true);
    expect(sha(r.backup.path)).toBe(r.backup.sha256);

    // Independent re-check of the adopted file.
    const db = new Database(join(svcRoot, "brains", "main", "brain.db"), { readonly: true });
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(n("SELECT MAX(version) AS n FROM schema_version")).toBe(18);
    expect(n("SELECT COUNT(*) AS n FROM nodes")).toBe(r.before.nodes);
    expect(n("SELECT COUNT(*) AS n FROM edges")).toBe(r.before.edges);
    expect(n("SELECT COUNT(*) AS n FROM episodes")).toBe(r.before.episodes);
    const semantic = n("SELECT COUNT(*) AS n FROM nodes WHERE type='semantic'");
    db.close();

    // Serve it. Tokens minted with the real CLI.
    const h = await startService({}, svcRoot);
    try {
      const mint = async (agent: string, scopes: string) =>
        JSON.parse((await run(process.execPath, [SERVER_CLI, "token", "mint", "--agent", agent, "--scopes", scopes, "--root", svcRoot, "--json"])).stdout).token as string;
      const main = await mint("main", "read,write");
      const cos = await mint("chief-of-staff", "read,write,shared-write");

      const stats = JSON.parse((await tool(h.url, main, "brain_stats", { visibility: "private", format: "json" })).text).brains[0];
      expect(stats.brain).toBe("private");
      expect(stats.nodes).toBe(r.before.nodes);
      expect(stats.episodes).toBe(r.before.episodes);
      expect(stats.nodesByType.semantic).toBe(semantic);
      expect(stats.writers["(none)"]).toBe(r.before.nodes); // no backfill by default

      const q = JSON.parse((await tool(h.url, main, "brain_query", { query: "openclaw", format: "json", scope: "private" })).text);
      expect(q.results.length).toBeGreaterThan(0);
      expect(q.results.every((x: { brain: string }) => x.brain === "private")).toBe(true);

      // Another agent sees none of main's private memories.
      const other = JSON.parse((await tool(h.url, cos, "brain_query", { query: "openclaw", format: "json", scope: "private" })).text);
      expect(other.results).toEqual([]);

      // Shared: CoS writes, main reads (scope all + shared).
      await tool(h.url, cos, "brain_write", { type: "semantic", label: "adopt smoke shared", content: "adoption smoke test shared note quokka", visibility: "shared" });
      const sq = JSON.parse((await tool(h.url, main, "brain_query", { query: "quokka", format: "json", scope: "shared" })).text);
      expect(sq.results.map((x: { brain: string }) => x.brain)).toContain("shared");

      // Episode append lands in main's adopted brain and is findable via brain_history (CLI).
      const ap = await tool(h.url, main, "brain_episode_append", { session_id: "adopt-smoke", role: "user", content: "adoption smoke episode wombat" });
      expect(ap.isError, ap.text).toBe(false);
      const env = { ...process.env, SHARPWAVE_TOKEN: main, SHARPWAVE_TOKEN_FILE: "" };
      const hist = await run(process.execPath, [CLIENT, "history", "wombat", "--url", h.url], { env });
      expect(hist.stdout).toContain("adoption smoke episode wombat");
      expect(hist.stdout).toContain("writer=main");
      const cstats = JSON.parse((await run(process.execPath, [CLIENT, "stats", "--json", "--url", h.url], { env })).stdout);
      expect(cstats.brains.find((b: { brain: string }) => b.brain === "private").episodes).toBe(r.before.episodes + 1);
      expect(cstats.brains.find((b: { brain: string }) => b.brain === "shared").nodes).toBe(1);
    } finally {
      await h.stop();
    }

    const shaAfter = Object.fromEntries(files.map((f) => [f, sha(join(SRC, f))]));
    expect(shaAfter).toEqual(shaBefore);
  });
});
