// `brain adopt`: adopting an existing (legacy, schema 17) brain.db as an
// agent's private brain. Unit tests on generated fixtures + rollback/restore.
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { closeDb, getDb } from "sharpwave-core";

import { adoptBrain, AdoptError, formatAdoptResult, resolveBackfillWriter, type AdoptOptions } from "../src/adopt.js";
import { servicePortInUse } from "../src/restore.js";
import { startService, tempRoot, tool } from "./helpers.js";
import { makeLegacyBrain, marker } from "./fixtures/legacy-brain.js";

const run = promisify(execFile);
const SERVER_CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const shaDir = (dir: string) => Object.fromEntries(readdirSync(dir).sort().map((f) => [f, sha(join(dir, f))]));

function counts(path: string) {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
    return {
      nodes: n("SELECT COUNT(*) AS n FROM nodes"),
      edges: n("SELECT COUNT(*) AS n FROM edges"),
      episodes: n("SELECT COUNT(*) AS n FROM episodes"),
      schema: n("SELECT MAX(version) AS n FROM schema_version"),
    };
  } finally { db.close(); }
}

function setup(spec = { nodes: 12, edges: 9, episodes: 7, walNodes: 3, walEpisodes: 2 }) {
  const root = tempRoot("sw-adopt-");
  const legacy = join(root, "legacy", "main");
  const totals = makeLegacyBrain(legacy, spec);
  const svcRoot = join(root, "service");
  const opts = (over: Partial<AdoptOptions> = {}): AdoptOptions => ({
    agentId: "main", from: legacy,
    brainsDir: join(svcRoot, "brains"), backupsDir: join(svcRoot, "backups"), auditFile: join(svcRoot, "audit", "audit.jsonl"),
    ...over,
  });
  return { root, legacy, totals, svcRoot, target: join(svcRoot, "brains", "main", "brain.db"), opts };
}

describe("brain adopt — fixture sanity", () => {
  it("generated legacy brain is schema 17 without writer_agent_id, part of the data only in the WAL", () => {
    const { legacy, totals } = setup();
    expect(existsSync(join(legacy, "brain.db-wal"))).toBe(true);
    const work = tempRoot("sw-adopt-chk-");
    for (const f of ["brain.db", "brain.db-wal"]) copyFileSync(join(legacy, f), join(work, f));
    expect(counts(join(work, "brain.db"))).toMatchObject({ ...totals, schema: 17 });
    // Without the WAL the extra rows are missing — that is what adopt must not lose.
    const noWal = tempRoot("sw-adopt-nowal-");
    copyFileSync(join(legacy, "brain.db"), join(noWal, "brain.db"));
    expect(counts(join(noWal, "brain.db")).nodes).toBe(totals.nodes - 3);
    const db = new Database(join(work, "brain.db"), { readonly: true });
    expect((db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string }>).some((c) => c.name === "writer_agent_id")).toBe(false);
    db.close();
  });
});

describe("brain adopt", () => {
  it("dry run inspects (WAL included) and writes nothing; source untouched", async () => {
    const { legacy, totals, svcRoot, opts } = setup();
    const before = shaDir(legacy);
    const r = await adoptBrain(opts({ dryRun: true }));
    expect(r.dryRun).toBe(true);
    expect(r.before).toMatchObject({ ...totals, schema: 17 });
    expect(r.targetState).toBe("absent");
    expect(r.actions.join("\n")).toContain("VACUUM INTO");
    expect(existsSync(svcRoot)).toBe(false);
    expect(shaDir(legacy)).toEqual(before); // no -shm created, bytes identical
    expect(formatAdoptResult(r)).toContain("DRY RUN");
  });

  it("copy-adopts: backup + sha256, migrated to schema 18, counts/integrity verified, source byte-identical, audit has no content", async () => {
    const { legacy, totals, target, svcRoot, opts } = setup();
    const before = shaDir(legacy);
    const r = await adoptBrain(opts());
    expect(r.dryRun).toBe(false);
    expect(r.integrity).toBe("ok");
    expect(r.after).toMatchObject({ ...totals });
    expect(r.after!.schema).toBeGreaterThanOrEqual(18);
    expect(r.after!.nullWriters).toEqual({ nodes: totals.nodes, edges: totals.edges, episodes: totals.episodes }); // no backfill by default
    expect(r.backfillWriter).toBeNull();
    expect(counts(target)).toMatchObject({ ...totals, schema: 18 });

    // Pre-adopt backup: exists, sha256 matches result + manifest, schema still 17, counts equal.
    expect(r.backup!.path).toMatch(/[\\/]backups[\\/]main[\\/]pre-adopt[\\/]main-pre-adopt-.*\.db$/);
    expect(sha(r.backup!.path)).toBe(r.backup!.sha256);
    const manifest = JSON.parse(readFileSync(r.backup!.manifest, "utf8"));
    expect(manifest).toMatchObject({ kind: "sharpwave-pre-adopt-backup", agentId: "main", sha256: r.backup!.sha256, counts: { nodes: totals.nodes, edges: totals.edges, episodes: totals.episodes }, schema: 17 });
    expect(counts(r.backup!.path)).toMatchObject({ ...totals, schema: 17 });

    // Source never opened: identical bytes, no -shm next to it.
    expect(r.sourceUnchanged).toBe(true);
    expect(shaDir(legacy)).toEqual(before);
    expect(existsSync(join(legacy, "brain.db-shm"))).toBe(false);

    // One audit line, counts + hashes only.
    const audit = readFileSync(join(svcRoot, "audit", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ agentId: "admin:cli", tool: "brain_adopt", brain: "main", nodeId: null, outcome: "ok" });
    expect(audit[0].detail).toContain(`nodes=${totals.nodes}`);
    expect(audit[0].detail).toContain("schema=17->18");
    expect(JSON.stringify(audit)).not.toContain("legacy-fixture-content");
    expect(JSON.stringify(audit)).not.toContain("kumquat");
  });

  it("refuses a target with data unless --force; --force renames it aside (never deletes)", async () => {
    const { target, opts, totals } = setup();
    await adoptBrain(opts());
    await expect(adoptBrain(opts())).rejects.toMatchObject({ code: "exists" });
    await expect(adoptBrain(opts({ dryRun: true }))).rejects.toMatchObject({ code: "exists" });

    const r = await adoptBrain(opts({ force: true }));
    expect(r.targetState).toBe("has-data");
    expect(r.replacedMovedTo!.length).toBeGreaterThanOrEqual(1);
    const aside = r.replacedMovedTo!.find((p) => /brain\.db\.pre-adopt-[^-]+.*Z$/.test(p))!;
    expect(aside).toBeTruthy();
    expect(counts(aside)).toMatchObject({ nodes: totals.nodes, schema: 18 }); // the previously adopted brain, intact
    expect(counts(target)).toMatchObject({ nodes: totals.nodes, schema: 18 });
  });

  it("an EMPTY existing private brain (e.g. created by a smoke test) is moved aside without --force", async () => {
    const { target, opts, totals } = setup();
    const h = await startService({}, join(opts().brainsDir, ".."));
    try {
      const tok = h.mint("main", ["read"]);
      await tool(h.url, tok, "brain_stats", {}); // opens -> creates an empty brains/main/brain.db
    } finally { await h.stop(false); }
    expect(existsSync(target)).toBe(true);
    const r = await adoptBrain(opts());
    expect(r.targetState).toBe("empty");
    expect(r.replacedMovedTo!.some((p) => p.includes("brain.db.pre-adopt-"))).toBe(true);
    expect(counts(target).nodes).toBe(totals.nodes);
  });

  it("refuses while the service is running (port probe), touching nothing", async () => {
    const { opts, target } = setup();
    const h = await startService({}, join(opts().brainsDir, ".."));
    try {
      const port = Number(new URL(h.url).port);
      await expect(adoptBrain(opts({ serviceRunning: () => servicePortInUse(port) }))).rejects.toMatchObject({ code: "running" });
      expect(existsSync(target)).toBe(false);
      expect(existsSync(join(opts().backupsDir, "main"))).toBe(false);
    } finally { await h.stop(false); }
  });

  it("--backfill-writer legacy stamps NULL writers as legacy:<agent> (optional; default leaves NULL)", async () => {
    expect(resolveBackfillWriter("main", undefined)).toBeNull();
    expect(resolveBackfillWriter("main", "none")).toBeNull();
    expect(resolveBackfillWriter("main", "legacy")).toBe("legacy:main");
    expect(resolveBackfillWriter("main", "main")).toBe("main");
    expect(() => resolveBackfillWriter("main", "bad writer!")).toThrow(AdoptError);

    const { target, opts, totals } = setup();
    const r = await adoptBrain(opts({ backfillWriter: "legacy" }));
    expect(r.backfilled).toEqual({ nodes: totals.nodes, edges: totals.edges, episodes: totals.episodes });
    expect(r.after!.nullWriters).toEqual({ nodes: 0, edges: 0, episodes: 0 });
    const db = new Database(target, { readonly: true });
    expect(db.prepare("SELECT DISTINCT writer_agent_id AS w FROM nodes").all()).toEqual([{ w: "legacy:main" }]);
    db.close();
    // Backup is pre-backfill (no writer column at all).
    expect(counts(r.backup!.path).schema).toBe(17);
  });

  it("--mode move renames the source files aside after success (never deletes)", async () => {
    const { legacy, target, opts, totals } = setup();
    const r = await adoptBrain(opts({ mode: "move" }));
    expect(existsSync(join(legacy, "brain.db"))).toBe(false);
    expect(r.sourceMovedTo!.some((p) => /brain\.db\.adopted-/.test(p))).toBe(true);
    expect(r.sourceMovedTo!.some((p) => /brain\.db-wal\.adopted-/.test(p))).toBe(true);
    expect(counts(target).nodes).toBe(totals.nodes);
  });

  it("rejects bad input before touching anything", async () => {
    const { opts, root, svcRoot } = setup();
    await expect(adoptBrain(opts({ agentId: "shared" }))).rejects.toMatchObject({ code: "usage" });
    await expect(adoptBrain(opts({ agentId: "../x" }))).rejects.toMatchObject({ code: "usage" });
    await expect(adoptBrain(opts({ from: join(root, "nope") }))).rejects.toMatchObject({ code: "source" });
    await expect(adoptBrain(opts({ mode: "link" as never }))).rejects.toMatchObject({ code: "usage" });
    // Corrupt source: refused, nothing written.
    const bad = join(root, "corrupt");
    mkdirSync(bad);
    writeFileSync(join(bad, "brain.db"), Buffer.alloc(8192, 7));
    await expect(adoptBrain(opts({ from: bad }))).rejects.toThrow();
    expect(existsSync(svcRoot)).toBe(false);
  });
});

describe("brain adopt — restore / rollback", () => {
  it("pre-adopt backup restores to a working local brain with the original counts", async () => {
    const { opts, totals, root } = setup();
    const r = await adoptBrain(opts());
    // Restore drill: drop the backup in as a legacy-layout brain and open it through core (local mode).
    const restored = join(root, "restored");
    mkdirSync(join(restored, "main"), { recursive: true });
    copyFileSync(r.backup!.path, join(restored, "main", "brain.db"));
    expect(sha(join(restored, "main", "brain.db"))).toBe(r.backup!.sha256);
    const prev = process.env["SHARPWAVE_DATA_DIR"];
    process.env["SHARPWAVE_DATA_DIR"] = restored;
    try {
      const db = getDb("main");
      expect((db.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number }).n).toBe(totals.nodes);
      expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    } finally {
      closeDb("main");
      if (prev === undefined) delete process.env["SHARPWAVE_DATA_DIR"]; else process.env["SHARPWAVE_DATA_DIR"] = prev;
    }
  });

  it("rollback to local mode: the copied-from source still works; remote-mode writes diverge (not in the local file)", async () => {
    const { legacy, opts, totals, root } = setup();
    await adoptBrain(opts());
    const h = await startService({}, join(opts().brainsDir, ".."));
    let remoteId = "";
    try {
      const tok = h.mint("main");
      const w = await tool(h.url, tok, "brain_write", { type: "semantic", label: "written in remote mode", content: "remote-only divergence marker" });
      remoteId = /node (\S+)/.exec(w.text)![1]!;
      const st = JSON.parse((await tool(h.url, tok, "brain_stats", { visibility: "private", format: "json" })).text).brains[0];
      expect(st.nodes).toBe(totals.nodes + 1);
    } finally { await h.stop(false); }

    // "brainMode local" again = core opening ~/.sharpwave/main/brain.db directly.
    const prev = process.env["SHARPWAVE_DATA_DIR"];
    process.env["SHARPWAVE_DATA_DIR"] = join(root, "legacy");
    try {
      const db = getDb("main");
      expect((db.prepare("SELECT COUNT(*) AS n FROM nodes").get() as { n: number }).n).toBe(totals.nodes);
      expect(db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(remoteId)).toBeUndefined();
      expect((db.prepare("SELECT content FROM nodes WHERE id = 'n0'").get() as { content: string }).content).toContain(marker(0));
    } finally {
      closeDb("main");
      if (prev === undefined) delete process.env["SHARPWAVE_DATA_DIR"]; else process.env["SHARPWAVE_DATA_DIR"] = prev;
    }
    expect(existsSync(join(legacy, "brain.db"))).toBe(true);
  });
});

describe("brain adopt — CLI", () => {
  it("dry-run, real run, refusal exit codes; port probe refuses next to a live service", async () => {
    const { legacy, svcRoot, totals } = setup();
    const cli = async (args: string[]) => {
      try {
        const r = await run(process.execPath, [SERVER_CLI, ...args]);
        return { code: 0, out: r.stdout, err: r.stderr };
      } catch (e) {
        const x = e as { code: number; stdout: string; stderr: string };
        return { code: x.code, out: x.stdout, err: x.stderr };
      }
    };
    // Port 1 is never a listening service here; keeps the probe deterministic.
    const base = ["brain", "adopt", "--agent", "main", "--from", legacy, "--root", svcRoot, "--tailnet-ip", "none", "--port", "1"];
    const dry = await cli([...base, "--dry-run"]);
    expect(dry.code, dry.err).toBe(0);
    expect(dry.out).toContain("DRY RUN");
    expect(dry.out).toContain(`${totals.nodes} nodes, ${totals.edges} edges, ${totals.episodes} episodes, schema 17`);
    expect(existsSync(svcRoot)).toBe(false);

    const real = await cli([...base, "--json"]);
    expect(real.code, real.err).toBe(0);
    const j = JSON.parse(real.out);
    expect(j).toMatchObject({ dryRun: false, integrity: "ok", sourceUnchanged: true, after: { nodes: totals.nodes, schema: 18 } });

    const again = await cli(base);
    expect(again.code).toBe(1);
    expect(again.err).toContain("already exists with data");

    const h = await startService({}, tempRoot("sw-adopt-live-"));
    try {
      const port = new URL(h.url).port;
      const live = await cli(["brain", "adopt", "--agent", "main", "--from", legacy, "--root", tempRoot("sw-adopt-r-"), "--tailnet-ip", "none", "--port", port]);
      expect(live.code).toBe(1);
      expect(live.err).toContain("stop the brain service");
    } finally { await h.stop(); }

    const help = await cli(["help"]);
    expect(help.out).toContain("brain adopt --agent <id> --from");
  });
});
