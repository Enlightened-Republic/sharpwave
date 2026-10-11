// Xanima 0.1.0 on the brain service: belief tools over HTTP (retract,
// supersede with reason, as_of, brain_status, belief JSON fields, write
// metadata), service-config engine flags, `migrate` (copy ~/.sharpwave →
// ~/.xanima with per-brain verification), `sleep now`, and env aliases.

import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { nodeIdFrom, startService, tempRoot, tool } from "./helpers.js";
import { mintToken } from "../src/tokens.js";
import { retireItems, unretireItems } from "../src/noise.js";

const run = promisify(execFile);
const SERVER_CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const CLIENT = fileURLToPath(new URL("../bin/xanima-client.mjs", import.meta.url));
const SNAPSHOT = process.env["XANIMA_SNAPSHOT_DIR"] ?? process.env["SHARPWAVE_SNAPSHOT_DIR"] ?? "/workspace/brain-snap/main";
const HAVE_SNAPSHOT = existsSync(join(SNAPSHOT, "brain.db"));
const sha = (p: string) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : "absent");
const cleanEnv = () => {
  const e: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const k of Object.keys(e)) if (/^(XANIMA|SHARPWAVE)_/.test(k)) delete e[k];
  return { ...e, OLLAMA_BASE_URL: "http://127.0.0.1:59999", OPENROUTER_API_KEY: "" };
};
async function cli(args: string[], env: Record<string, string> = cleanEnv()) {
  try {
    const r = await run(process.execPath, [SERVER_CLI, ...args], { env, maxBuffer: 20e6 });
    return { code: 0, out: r.stdout, err: r.stderr };
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string };
    return { code: x.code, out: x.stdout, err: x.stderr };
  }
}

describe("belief tools on the service", () => {
  it("write metadata, JSON belief fields, supersede with reason, retract, as_of, brain_status", async () => {
    const h = await startService();
    try {
      const tok = h.mint("tripp", ["read", "write", "shared-write"]);
      const w = await tool(h.url, tok, "brain_write", { type: "semantic", label: "Gym days", content: "Hailey goes to the gym on Mondays", source_type: "user", confidence: "high" });
      const id = nodeIdFrom(w.text);
      const dep = nodeIdFrom((await tool(h.url, tok, "brain_write", { type: "semantic", label: "Monday plan", content: "Keep Monday evenings free for the gym" })).text);
      await tool(h.url, tok, "brain_link", { from_id: id, to_id: dep, edge_type: "supports" });
      const j = JSON.parse((await tool(h.url, tok, "brain_query", { query: "gym", format: "json", scope: "private" })).text);
      const hit = j.results.find((r: { id: string }) => r.id === id);
      expect(hit).toMatchObject({ confidence: "high", source_type: "user", status: "active", ago: "just now", sensitivity: "normal" });
      expect(typeof hit.created_at).toBe("number");
      const text = (await tool(h.url, tok, "brain_query", { query: "gym" })).text;
      expect(text).toMatch(/conf=high src=user \(just now\)/);
      const bad = await tool(h.url, tok, "brain_write", { type: "semantic", label: "x", content: "y", source_type: "legacy" });
      expect(bad.isError).toBe(true);

      const t0 = Date.now();
      await new Promise((r) => setTimeout(r, 15));
      const sup = await tool(h.url, tok, "brain_supersede", { old_node_id: id, new_content: "Hailey goes to the gym on Tuesdays", reason: "schedule changed" });
      expect(sup.isError).toBe(false);
      expect(sup.text).toMatch(/Reason: schedule changed/);
      expect(sup.text).toContain(dep); // downstream surfaced
      const newId = /new node (\S+)/.exec(sup.text)![1]!;
      const now = JSON.parse((await tool(h.url, tok, "brain_query", { query: "gym", format: "json" })).text).results.map((r: { id: string }) => r.id);
      expect(now).toContain(newId);
      expect(now).not.toContain(id);
      const then = JSON.parse((await tool(h.url, tok, "brain_query", { query: "gym", as_of: t0, format: "json" })).text);
      const old = then.results.find((r: { id: string }) => r.id === id);
      expect(old).toMatchObject({ status_then: "active" });
      expect(old.later_change).toMatch(/^superseded/);
      expect(then.results.map((r: { id: string }) => r.id)).not.toContain(newId);
      const thenText = (await tool(h.url, tok, "brain_query", { query: "gym", as_of: "1 years ago" })).text;
      expect(thenText).toMatch(/no matching beliefs/);

      const rt = await tool(h.url, tok, "brain_retract", { node_id: dep, reason: "no longer true" });
      expect(rt.isError).toBe(false);
      const after = JSON.parse((await tool(h.url, tok, "brain_query", { query: "Monday evenings", format: "json" })).text).results.map((r: { id: string }) => r.id);
      expect(after).not.toContain(dep);
      expect((await tool(h.url, tok, "brain_retract", { node_id: dep, reason: "again" })).isError).toBe(true);

      // shared brain write by tripp → source_type agent from other agents' viewpoint
      const sw = nodeIdFrom((await tool(h.url, tok, "brain_write", { type: "semantic", label: "Team norm", content: "Standup is at nine", visibility: "shared" })).text);
      const sj = JSON.parse((await tool(h.url, tok, "brain_query", { query: "standup", format: "json", scope: "shared" })).text);
      expect(sj.results.find((r: { id: string }) => r.id === sw)).toMatchObject({ source_type: "agent" });

      const st = JSON.parse((await tool(h.url, tok, "brain_status", { format: "json" })).text);
      expect(st.brains.map((b: { brain: string }) => b.brain)).toEqual(["private", "shared"]);
      expect(st.brains[0].nodes).toMatchObject({ retracted: 1, superseded: 1 });
      expect(st.brains[0].injection.estimatedTokens).toBeGreaterThan(0);
      const stText = (await tool(h.url, tok, "brain_status", { visibility: "private" })).text;
      expect(stText).toMatch(/^\[private\] Brain status \(schema v23\)/);

      // audit carries reasons but never content
      const audit = readFileSync(h.cfg.auditFile, "utf8");
      expect(audit).toContain("schedule changed");
      expect(audit).not.toContain("Tuesdays");

      // read-only token cannot retract
      const ro = h.mint("tripp", ["read"]);
      expect((await tool(h.url, ro, "brain_retract", { node_id: newId, reason: "x" })).isError).toBe(true);
    } finally { await h.stop(); }
  });

  it("service config `brain` flags reach the engine (beliefMetadata off → no belief fields)", async () => {
    const h = await startService({ brain: { beliefMetadata: false } });
    try {
      const tok = h.mint("a");
      await tool(h.url, tok, "brain_write", { type: "semantic", label: "k", content: "kiwi fruit fact" });
      const j = JSON.parse((await tool(h.url, tok, "brain_query", { query: "kiwi", format: "json" })).text);
      expect(j.results[0].confidence).toBeUndefined();
      expect((await tool(h.url, tok, "brain_query", { query: "kiwi" })).text).not.toMatch(/conf=/);
    } finally { await h.stop(); }
  });
});

describe("xanima-server migrate (copy ~/.sharpwave → ~/.xanima)", () => {
  function fakeSharpwaveHome(): { home: string; old: string; brains: string[] } {
    const home = tempRoot("xa-fakehome-");
    const old = join(home, ".sharpwave");
    // service root with tokens + config + two brains, a legacy local brain, a tokens folder, and old backup folders
    mkdirSync(join(old, "service", "brains", "shared"), { recursive: true });
    mkdirSync(join(old, "service", "brains", "gano"), { recursive: true });
    mkdirSync(join(old, "main"), { recursive: true });
    mkdirSync(join(old, "tokens"), { recursive: true });
    mkdirSync(join(old, "_backup-pre-openwave-20260920-010101", "main"), { recursive: true });
    writeFileSync(join(old, "tokens", "main.token"), "swt_fake_token_for_tests_only\n");
    writeFileSync(join(old, "_backup-pre-openwave-20260920-010101", "main", "junk.txt"), "old attempt");
    writeFileSync(join(old, "service", "config.json"), JSON.stringify({
      root: join(old, "service"), port: 18790, logFile: join(old, "service", "logs", "service.log"),
      offsiteBackup: { keyFile: "~/.sharpwave/backup.key" }, tailnetHosts: [],
    }, null, 2));
    mintToken(join(old, "service", "tokens.json"), "main", ["read", "write"]);
    return { home, old, brains: [] };
  }

  it("does not print the old-data-folder deprecation warning while migrating (it IS the fix)", async () => {
    const { home } = fakeSharpwaveHome();
    try {
      const env = { ...cleanEnv(), HOME: home, USERPROFILE: home, XANIMA_HOME_OVERRIDE: home };
      const r = await cli(["migrate", "--dry-run"], env);
      expect(r.code, r.err + r.out).toBe(0);
      expect(r.err + r.out).not.toMatch(/using the old data folder/);
      const other = await cli(["token", "list"], env);
      expect(other.err).toMatch(/using the old data folder/);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("copies, migrates and verifies every brain; source untouched; refuses a non-empty target", async () => {
    const { home, old } = fakeSharpwaveHome();
    try {
      // Real brains: service brains via a running service (schema current), legacy main from the snapshot when present.
      const svc = await startService({}, join(old, "service"));
      const t = svc.mint("gano");
      for (let i = 0; i < 5; i++) await tool(svc.url, t, "brain_write", { type: "semantic", label: `g${i}`, content: `gano fact number ${i} about migration` });
      await svc.stop(false);
      if (HAVE_SNAPSHOT) {
        for (const s of ["", "-wal", "-shm"]) if (existsSync(join(SNAPSHOT, "brain.db" + s))) copyFileSync(join(SNAPSHOT, "brain.db" + s), join(old, "main", "brain.db" + s));
      }
      const listFiles = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? listFiles(join(d, e.name)) : [join(d, e.name)]));
      const before = new Map(listFiles(old).map((f) => [f, sha(f)]));
      const mtimes = new Map(listFiles(old).map((f) => [f, statSync(f).mtimeMs]));

      const to = join(home, ".xanima");
      const dry = await cli(["migrate", "--from", old, "--to", to, "--dry-run", "--root", join(old, "service")]);
      expect(dry.code).toBe(0);
      expect(existsSync(to)).toBe(false);

      const r = await cli(["migrate", "--from", old, "--to", to, "--json", "--root", join(old, "service"), "--skip-port-check"]);
      expect(r.code, r.err + r.out).toBe(0);
      const j = JSON.parse(r.out);
      expect(j.ok).toBe(true);
      expect(j.sourceUnchanged).toBe(true);
      expect(j.skipped.some((s: string) => s.startsWith("_backup-pre-openwave"))).toBe(true);
      expect(existsSync(join(to, "_backup-pre-openwave-20260920-010101"))).toBe(false);
      const paths = j.brains.map((b: { path: string }) => b.path.replace(/\\/g, "/")).sort();
      expect(paths).toEqual([...(HAVE_SNAPSHOT ? ["main/brain.db"] : []), "service/brains/gano/brain.db", "service/brains/shared/brain.db"].sort());
      for (const b of j.brains) {
        expect(b.ok).toBe(true);
        expect(b.after).toMatchObject({ nodes: b.before.nodes, edges: b.before.edges, episodes: b.before.episodes, schema: 23 });
        expect(b.integrity).toBe("ok");
      }
      const gano = j.brains.find((b: { path: string }) => b.path.includes("gano"));
      expect(gano.after.nodes).toBe(5);
      if (HAVE_SNAPSHOT) {
        const main = j.brains.find((b: { path: string }) => b.path.startsWith("main"));
        expect(main.before).toMatchObject({ nodes: 533, edges: 1380, episodes: 248 });
        expect(main.backfill.legacySourceType).toBe(533);
      }
      // tokens + config carried over; config paths rewritten in the COPY only
      expect(readFileSync(join(to, "tokens", "main.token"), "utf8")).toContain("swt_fake");
      expect(readFileSync(join(to, "service", "tokens.json"), "utf8")).toEqual(readFileSync(join(old, "service", "tokens.json"), "utf8"));
      const cfg = JSON.parse(readFileSync(join(to, "service", "config.json"), "utf8"));
      expect(cfg.root).toBe(join(to, "service"));
      expect(cfg.logFile).toBe(join(to, "service", "logs", "service.log"));
      expect(cfg.offsiteBackup.keyFile).toBe("~/.xanima/backup.key");
      expect(JSON.parse(readFileSync(join(old, "service", "config.json"), "utf8")).root).toBe(join(old, "service"));
      expect(j.configRewrites.length).toBe(3);
      expect(existsSync(join(to, "MIGRATED-FROM-SHARPWAVE.json"))).toBe(true);
      expect(readFileSync(join(to, "MIGRATED-FROM-SHARPWAVE.json"), "utf8")).not.toMatch(/gano fact/);

      // source byte-identical and not even touched
      for (const [f, h] of before) expect(sha(f), f).toBe(h);
      for (const [f, m] of mtimes) expect(statSync(f).mtimeMs, f).toBe(m);
      expect(listFiles(old).length).toBe(before.size);

      // the migrated service starts on the new root and serves the copied tokens' brains
      const svc2 = await startService({}, join(to, "service"));
      try {
        const t2 = svc2.mint("gano");
        expect((await tool(svc2.url, t2, "brain_query", { query: "gano fact migration" })).text).toMatch(/gano fact/);
      } finally { await svc2.stop(false); }

      // re-running refuses (never merges / overwrites)
      const again = await cli(["migrate", "--from", old, "--to", to, "--root", join(old, "service"), "--skip-port-check"]);
      expect(again.code).not.toBe(0);
      expect(again.err + again.out).toMatch(/already exists and is not empty/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  it("refuses while a service is listening on the configured port", async () => {
    const h = await startService();
    const home = tempRoot("xa-fakehome2-");
    try {
      mkdirSync(join(home, ".sharpwave"));
      const r = await cli(["migrate", "--from", join(home, ".sharpwave"), "--to", join(home, ".xanima"), "--root", h.root, "--port", String(h.svc.port)]);
      expect(r.code).not.toBe(0);
      expect(r.err).toMatch(/stop it/);
      expect(existsSync(join(home, ".xanima"))).toBe(false);
    } finally { await h.stop(); rmSync(home, { recursive: true, force: true }); }
  });
});

describe("sleep now + defaults + env aliases", () => {
  it("sleep now --force runs a cycle offline and records the sleep summary", async () => {
    const h = await startService();
    const tok = h.mint("a");
    for (let i = 0; i < 3; i++) await tool(h.url, tok, "brain_write", { type: "semantic", label: `s${i}`, content: `sleep fact ${i}`, confidence: 0.2 });
    await h.stop(false);
    try {
      const r = await cli(["sleep", "now", "--force", "--brain", "a", "--json", "--root", h.root, "--port", "1"]);
      expect(r.code, r.err).toBe(0);
      expect(JSON.parse(r.out).ran).toEqual(["a"]);
      const db = new Database(join(h.root, "brains", "a", "brain.db"), { readonly: true });
      const s = JSON.parse((db.prepare("SELECT value FROM meta_kv WHERE key = 'xanima:last_sleep_summary'").get() as { value: string }).value);
      expect(s.flaggedForReview).toBe(3);
      db.close();
    } finally { rmSync(h.root, { recursive: true, force: true }); }
  });

  it("default root is ~/.xanima/service, falling back to ~/.sharpwave/service before migration", async () => {
    const home = tempRoot("xa-home-");
    try {
      const env = { ...cleanEnv(), HOME: home, USERPROFILE: home };
      mkdirSync(join(home, ".sharpwave", "service"), { recursive: true });
      const a = await cli(["token", "list", "--json"], env);
      expect(a.err).toMatch(/DEPRECATED: using the old data folder/);
      expect(existsSync(join(home, ".sharpwave", "service", "tokens.json")) || a.out.trim() === "[]").toBe(true);
      mkdirSync(join(home, ".xanima", "service"), { recursive: true });
      const m = await cli(["token", "mint", "--agent", "z", "--json"], env);
      expect(JSON.parse(m.out).tokensFile).toBe(join(home, ".xanima", "service", "tokens.json"));
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it("xanima-client reads XANIMA_TOKEN, and SHARPWAVE_TOKEN with a deprecation warning", async () => {
    const h = await startService();
    try {
      const tok = h.mint("c");
      const base = { ...cleanEnv(), HOME: tempRoot("xa-chome-") };
      const a = await run(process.execPath, [CLIENT, "stats", "--url", h.url], { env: { ...base, XANIMA_TOKEN: tok } });
      expect(a.stdout).toMatch(/\[private\] \d+ nodes/);
      expect(a.stderr).not.toMatch(/DEPRECATED/);
      const b = await run(process.execPath, [CLIENT, "stats", "--url", h.url], { env: { ...base, SHARPWAVE_TOKEN: tok } });
      expect(b.stdout).toMatch(/\[private\] \d+ nodes/);
      expect(b.stderr).toMatch(/DEPRECATED: SHARPWAVE_TOKEN/);
    } finally { await h.stop(); }
  });
});

describe("noise retire/unretire keeps v19 status in step", () => {
  it("retired noise is archived; unretired is active again", async () => {
    const h = await startService();
    const tok = h.mint("n");
    const id = nodeIdFrom((await tool(h.url, tok, "brain_write", { type: "semantic", label: "NO_REPLY triage", content: "NO_REPLY nothing to do" })).text);
    await h.stop(false);
    try {
      const dbPath = join(h.root, "brains", "n", "brain.db");
      const o = { dbPath, brain: "n", backupsDir: join(h.root, "backups") };
      const r = retireItems({ nodes: [id], episodes: [], bare: [], ignored: 0 }, o);
      const st = () => new Database(dbPath, { readonly: true }).prepare("SELECT status, valid_until FROM nodes WHERE id = ?").get(id) as { status: string; valid_until: number | null };
      expect(st().status).toBe("archived");
      unretireItems({ ...o, batch: r.batch });
      expect(st()).toEqual({ status: "active", valid_until: null });
    } finally { rmSync(h.root, { recursive: true, force: true }); }
  });
});
