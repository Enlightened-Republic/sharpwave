// Encrypted off-PC backups: format, destinations, retention, restore, audit.
import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { inspect } from "node:util";
import { basename, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { BackupKey, HEADER_BYTES, MAGIC, decryptFile, encryptFile, generateKeyFile, loadKey, parseKeyText, readHeader } from "../src/crypt.js";
import { applyRetention, assertSafeDestinations, defaultOffsiteConfig, selectRetained } from "../src/offsite.js";
import { checkDatabase, countRows, restoreBackup } from "../src/restore.js";
import { runBackupJob } from "../src/backup-job.js";

import { AuditLog } from "../src/audit.js";
import { memoryLogger } from "../src/log.js";
import { nodeIdFrom, startService, tempRoot, testConfig, tool } from "./helpers.js";

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const SECRET_MARK = "zebra-quokka-7731-plaintext-marker";

function newKey(): { key: BackupKey; b64: string; hex: string } {
  const bytes = randomBytes(32);
  return { key: new BackupKey(bytes, "test"), b64: bytes.toString("base64"), hex: bytes.toString("hex") };
}

function allFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? allFiles(join(dir, e.name)) : [join(dir, e.name)]));
}

function makeDb(path: string, rows = 50): void {
  const db = new Database(path);
  db.exec("CREATE TABLE nodes(id TEXT PRIMARY KEY, content TEXT); CREATE TABLE edges(id INTEGER PRIMARY KEY, a TEXT, b TEXT); CREATE TABLE episodes(id INTEGER PRIMARY KEY, body TEXT);");
  const ins = db.prepare("INSERT INTO nodes VALUES (?, ?)");
  for (let i = 0; i < rows; i++) ins.run(`n${i}`, `${SECRET_MARK} row ${i} ${"x".repeat(200)}`);
  db.prepare("INSERT INTO edges(a,b) VALUES ('n0','n1')").run();
  db.prepare("INSERT INTO episodes(body) VALUES (?)").run(SECRET_MARK);
  db.close();
}

describe("artifact format + crypto", () => {
  it("round-trips, header is SWBK v1 + key id + nonce, manifest sha256 matches", async () => {
    const root = tempRoot();
    const src = join(root, "plain.db");
    makeDb(src, 2000); // > 64 KiB so the stream spans several chunks
    const { key } = newKey();
    const enc = await encryptFile(src, join(root, "out", "a-2026-01-01T00-00-00-000Z.swbk"), key, { brain: "a" });
    const buf = readFileSync(enc.artifact);
    expect(buf.subarray(0, 4).equals(MAGIC)).toBe(true);
    expect(buf[4]).toBe(1);
    expect(buf.subarray(5, 13).toString("hex")).toBe(key.id);
    expect(buf.length).toBe(statSync(src).size + HEADER_BYTES + 16);
    expect(enc.manifest.sha256).toBe(createHash("sha256").update(buf).digest("hex"));
    expect(buf.includes(Buffer.from(SECRET_MARK))).toBe(false);
    expect(buf.includes(Buffer.from("SQLite format 3"))).toBe(false);
    const out = join(root, "restored.db");
    const r = await decryptFile(enc.artifact, out, key);
    expect(r.manifestChecked).toBe(true);
    expect(readFileSync(out).equals(readFileSync(src))).toBe(true);
  });

  it("two encryptions of the same file use different nonces", async () => {
    const root = tempRoot();
    const src = join(root, "p.db");
    makeDb(src, 5);
    const { key } = newKey();
    const a = await encryptFile(src, join(root, "a.swbk"), key);
    const b = await encryptFile(src, join(root, "b.swbk"), key);
    expect(readHeader(a.artifact).nonce.equals(readHeader(b.artifact).nonce)).toBe(false);
    expect(a.manifest.sha256).not.toBe(b.manifest.sha256);
  });

  it("tampered artifacts fail (sha256 with manifest, GCM tag without) and leave no output", async () => {
    const root = tempRoot();
    const src = join(root, "p.db");
    makeDb(src, 100);
    const { key } = newKey();
    const enc = await encryptFile(src, join(root, "t.swbk"), key);
    const orig = readFileSync(enc.artifact);
    const cases: Array<[string, (b: Buffer) => void]> = [
      ["ciphertext byte", (b) => { b[HEADER_BYTES + 100]! ^= 0x01; }],
      ["nonce byte", (b) => { b[20]! ^= 0x80; }],
      ["tag byte", (b) => { b[b.length - 1]! ^= 0x01; }],
    ];
    for (const [what, mutate] of cases) {
      const b = Buffer.from(orig);
      mutate(b);
      writeFileSync(enc.artifact, b);
      const out = join(root, `out-${what.replace(/ /g, "-")}.db`);
      await expect(decryptFile(enc.artifact, out, key), what).rejects.toThrow(/sha256 mismatch/);
      // Without the manifest the GCM tag alone must catch it.
      await expect(decryptFile(enc.artifact, out, key, { manifestPath: join(root, "absent.json") }), what).rejects.toThrow(/authentication failed/);
      expect(existsSync(out)).toBe(false);
      expect(existsSync(out + ".partial")).toBe(false);
    }
    // Truncation
    writeFileSync(enc.artifact, orig.subarray(0, orig.length - 40));
    await expect(decryptFile(enc.artifact, join(root, "trunc.db"), key, { manifestPath: join(root, "absent.json") })).rejects.toThrow(/authentication failed/);
    // requireManifest
    writeFileSync(enc.artifact, orig);
    await expect(decryptFile(enc.artifact, join(root, "rm.db"), key, { manifestPath: join(root, "absent.json"), requireManifest: true })).rejects.toThrow(/manifest .* not found/);
    await expect(decryptFile(enc.artifact, join(root, "good.db"), key)).resolves.toMatchObject({ manifestChecked: true });
  });

  it("the wrong key fails — by key id, and by GCM tag even if the key id is forged", async () => {
    const root = tempRoot();
    const src = join(root, "p.db");
    makeDb(src, 10);
    const right = newKey().key;
    const wrong = newKey().key;
    const enc = await encryptFile(src, join(root, "w.swbk"), right);
    await expect(decryptFile(enc.artifact, join(root, "o1.db"), wrong)).rejects.toThrow(/wrong key/);
    // Forge the header's key id to the wrong key's id (no manifest so only the tag can object).
    const b = readFileSync(enc.artifact);
    Buffer.from(wrong.id, "hex").copy(b, 5);
    writeFileSync(join(root, "forged.swbk"), b);
    await expect(decryptFile(join(root, "forged.swbk"), join(root, "o2.db"), wrong)).rejects.toThrow(/authentication failed/);
    expect(existsSync(join(root, "o1.db")) || existsSync(join(root, "o2.db"))).toBe(false);
  });

  it("keys: parse base64/hex/comments, env wins over file, errors and inspect never reveal the key", () => {
    const root = tempRoot();
    const { b64, hex, key } = newKey();
    expect(parseKeyText(`# comment\n${b64}\n`, "t").id).toBe(key.id);
    expect(parseKeyText(hex, "t").id).toBe(key.id);
    const bad = "A".repeat(20);
    try { parseKeyText(bad, "t"); expect.unreachable(); } catch (e) { expect(String(e)).not.toContain(bad); }
    const kf = join(root, "k", "backup.key");
    const gen = generateKeyFile(kf);
    if (process.platform !== "win32") expect(statSync(kf).mode & 0o777).toBe(0o600);
    expect(() => generateKeyFile(kf)).toThrow(/already exists/);
    expect(loadKey({ keyFile: kf, env: {} }).id).toBe(gen.id);
    const kf2 = join(root, "k2", "backup.key");
    const first = generateKeyFile(kf2);
    const second = generateKeyFile(kf2, true);
    expect(second.id).not.toBe(first.id);
    const old = readdirSync(join(root, "k2")).filter((f) => f.startsWith("backup.key.old-"));
    expect(old).toHaveLength(1);
    expect(loadKey({ keyFile: join(root, "k2", old[0]!), env: {} }).id).toBe(first.id);
    expect(loadKey({ keyFile: kf, env: { SHARPWAVE_BACKUP_KEY: b64 } }).id).toBe(key.id);
    expect(() => loadKey({ keyFile: join(root, "nope"), env: {} })).toThrow(/does not exist/);
    const shown = `${key} ${JSON.stringify({ key })} ${inspect(key)} ${inspect({ key })}`;
    expect(shown).not.toContain(b64);
    expect(shown).not.toContain(hex);
  });
});

describe("retention (N daily + M weekly)", () => {
  const name = (d: Date) => `b-${d.toISOString().replace(/[:.]/g, "-")}.swbk`;

  it("keeps the newest per day for N days and per ISO week for M weeks", () => {
    // Two artifacts per day for 60 days ending Wed 2026-09-30.
    const names: string[] = [];
    for (let i = 0; i < 60; i++) {
      const day = new Date(Date.UTC(2026, 8, 30 - i, 2, 30));
      names.push(name(day), name(new Date(day.getTime() + 3600_000)));
    }
    const keep = selectRetained(names, 7, 4);
    const kept = [...keep].sort();
    // 7 daily (Sep 24..30, the 03:30 one each) + weekly picks for 4 ISO weeks (3 of which are already covered by daily ones).
    const days = new Set(kept.map((n) => n.slice(2, 12)));
    for (let d = 24; d <= 30; d++) expect(days.has(`2026-09-${d}`)).toBe(true);
    expect(kept.every((n) => n.includes("T03-30"))).toBe(true); // newest of each bucket
    // Weeks: W40 (Sep 28-30), W39 (Sep 21-27, newest Sep 27), W38 (newest Sep 20), W37 (newest Sep 13)
    expect(days.has("2026-09-20")).toBe(true);
    expect(days.has("2026-09-13")).toBe(true);
    expect(days.has("2026-09-06")).toBe(false);
    expect(kept.length).toBe(9);
  });

  it("always keeps the newest; 0/0 keeps just one", () => {
    const names = [name(new Date("2026-09-01T00:00:00Z")), name(new Date("2026-09-02T00:00:00Z"))];
    expect([...selectRetained(names, 0, 0)]).toEqual([names[1]]);
  });

  it("applyRetention deletes artifact + manifest and ignores unrelated files", () => {
    const dir = join(tempRoot(), "r");
    mkdirSync(dir);
    const names = [1, 2, 3, 4].map((d) => name(new Date(Date.UTC(2026, 8, d, 2, 30))));
    for (const n of names) { writeFileSync(join(dir, n), "x"); writeFileSync(join(dir, n + ".json"), "{}"); }
    writeFileSync(join(dir, "notes.txt"), "keep");
    const removed = applyRetention(dir, 2, 0);
    expect(removed).toEqual(names.slice(0, 2));
    expect(readdirSync(dir).sort()).toEqual([...names.slice(2).flatMap((n) => [n, n + ".json"]), "notes.txt"].sort());
  });
});

describe("offsite pipeline through the service", () => {
  it("round-trip on a generated brain: folder destination gets only ciphertext; restore matches counts, integrity ok", async () => {
    const keyRoot = tempRoot("sw-key-");
    const keyFile = join(keyRoot, "backup.key");
    generateKeyFile(keyFile);
    const drive = join(tempRoot("sw-drive-"), "My Drive", "SharpWave");
    const h = await startService({ offsiteBackup: { enabled: true, keyFile, folder: drive, keepDaily: 7, keepWeekly: 4 } });
    try {
      const tok = h.mint("alice");
      const ids: string[] = [];
      const topics = ["gateway scheduled task on the host", "weekly sync moved to thursdays", "tailscale address for the desktop", "grocery list includes oat milk"];
      for (let i = 0; i < 4; i++) {
        ids.push(nodeIdFrom((await tool(h.url, tok, "brain_write", { type: "semantic", label: topics[i], content: `${topics[i]} ${SECRET_MARK}` })).text));
      }
      expect(new Set(ids).size).toBe(4);
      const link = await tool(h.url, tok, "brain_link", { from_id: ids[0], to_id: ids[1], edge_type: "supports" });
      expect(link.isError, link.text).toBe(false);
      const r = await h.svc.runBackup(["alice"]);
      expect(r.failed).toEqual([]);
      expect(r.offsite).toHaveLength(1);
      const o = r.offsite[0]!;
      expect(o.error).toBeUndefined();
      expect(o.folder?.ok).toBe(true);

      // Destination + outbox: only SWBK artifacts and JSON manifests, no plaintext.
      const shipped = [...allFiles(drive), ...allFiles(h.cfg.offsiteBackup.outboxDir!)];
      expect(shipped.length).toBe(4);
      for (const f of shipped) {
        const b = readFileSync(f);
        expect(b.includes(Buffer.from(SECRET_MARK)), f).toBe(false);
        expect(b.includes(Buffer.from("SQLite format 3")), f).toBe(false);
        if (f.endsWith(".swbk")) expect(b.subarray(0, 4).equals(MAGIC)).toBe(true);
        else expect(f.endsWith(".swbk.json")).toBe(true);
      }

      // Restore from the DESTINATION copy.
      const art = allFiles(drive).find((f) => f.endsWith(".swbk"))!;
      const out = join(tempRoot("sw-restore-"), "restored.db");
      const res = await restoreBackup({ artifact: art, out, key: loadKey({ keyFile, env: {} }), brainsDir: join(h.root, "brains"), audit: h.svc.audit });
      expect(res.integrity).toBe("ok");
      expect(res.manifestChecked).toBe(true);
      const live = new Database(join(h.root, "brains", "alice", "brain.db"), { readonly: true });
      const expected = countRows(live);
      live.close();
      expect(expected.nodes).toBe(4);
      expect(expected.edges).toBeGreaterThanOrEqual(1);
      expect(res.counts).toEqual(expected);

      const audit = readFileSync(h.cfg.auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const tools = audit.filter((a) => a.agentId === "system").map((a) => `${a.tool}:${a.outcome}`);
      expect(tools).toEqual(expect.arrayContaining(["backup.snapshot:ok", "backup.encrypt:ok", "backup.upload:ok", "backup.restore:ok"]));
    } finally {
      await h.stop();
    }
  });

  it("a failing command destination is logged + audited and does not break the local backup or folder copy", async () => {
    const root = tempRoot();
    const { b64 } = newKey();
    const drive = join(tempRoot("sw-drive-"), "dest");
    const cfg = testConfig(root, { offsiteBackup: { enabled: true, folder: drive, command: [process.execPath, "-e", "process.stderr.write('boom'); process.exit(7)"] } });
    mkdirSync(join(root, "brains", "x"), { recursive: true });
    makeDb(join(root, "brains", "x", "brain.db"));
    const log = memoryLogger();
    const audit = new AuditLog(cfg.auditFile);
    const env = { SHARPWAVE_BACKUP_KEY: b64 };
    const { makeOffsite } = await import("../src/backup-job.js");
    const r = await runBackupJob(cfg, log, audit, { offsiteBackup: makeOffsite(cfg, log, audit, env) });
    expect(r.failed).toEqual([]);
    expect(r.ok).toHaveLength(1);
    expect(existsSync(r.ok[0]!.path)).toBe(true); // local snapshot intact
    expect(r.offsite[0]!.folder?.ok).toBe(true);
    expect(r.offsite[0]!.command).toMatchObject({ ok: false, code: 7 });
    expect(log.lines.some((l) => l.startsWith("error") && /command .* failed .*exit=7/.test(l))).toBe(true);
    const a = readFileSync(cfg.auditFile, "utf8");
    expect(a).toMatch(/"tool":"backup.upload","brain":"x","nodeId":null,"outcome":"error"/);
    // Missing executable: ENOENT, still no throw.
    const cfg2 = testConfig(root, { offsiteBackup: { enabled: true, command: [join(root, "no-such-uploader")] } });
    const r2 = await runBackupJob(cfg2, log, audit, { offsiteBackup: makeOffsite(cfg2, log, audit, env) });
    expect(r2.ok).toHaveLength(1);
    expect(r2.offsite[0]!.command).toMatchObject({ ok: false, code: "ENOENT" });
    expect(log.lines.join("\n")).not.toContain(b64);
  });

  it("command runs without a shell, gets placeholders literally, and never sees the key env var", async () => {
    const root = tempRoot();
    const { b64 } = newKey();
    const probe = join(root, "probe.json");
    const pwned = join(root, "pwned");
    const script = `require('fs').writeFileSync(${JSON.stringify(probe)}, JSON.stringify({argv: process.argv.slice(1), key: process.env.SHARPWAVE_BACKUP_KEY ?? null}))`;
    const cfg = testConfig(root, { offsiteBackup: { enabled: true, command: [process.execPath, "-e", script, "{file}", `{name}; touch ${pwned}`, "{brain}", "{unknown}"] } });
    mkdirSync(join(root, "brains", "x"), { recursive: true });
    makeDb(join(root, "brains", "x", "brain.db"));
    const log = memoryLogger();
    const { makeOffsite } = await import("../src/backup-job.js");
    const prev = process.env["SHARPWAVE_BACKUP_KEY"];
    process.env["SHARPWAVE_BACKUP_KEY"] = b64; // parent env has it; the child must not
    try {
      const r = await runBackupJob(cfg, log, undefined, { offsiteBackup: makeOffsite(cfg, log, undefined) });
      expect(r.offsite[0]!.command?.ok).toBe(true);
    } finally {
      if (prev === undefined) delete process.env["SHARPWAVE_BACKUP_KEY"]; else process.env["SHARPWAVE_BACKUP_KEY"] = prev;
    }
    const p = JSON.parse(readFileSync(probe, "utf8"));
    expect(p.key).toBeNull();
    expect(p.argv[0]).toMatch(/x-.*\.swbk$/);
    expect(p.argv[1]).toBe(`${basename(p.argv[0])}; touch ${pwned}`);
    expect(p.argv[2]).toBe("x");
    expect(p.argv[3]).toBe("{unknown}");
    expect(existsSync(pwned)).toBe(false);
  });

  it("missing key: offsite is skipped with an error, local snapshot still made", async () => {
    const root = tempRoot();
    const cfg = testConfig(root, { offsiteBackup: { enabled: true, keyFile: join(root, "missing.key") } });
    mkdirSync(join(root, "brains", "x"), { recursive: true });
    makeDb(join(root, "brains", "x", "brain.db"));
    const log = memoryLogger();
    const { makeOffsite } = await import("../src/backup-job.js");
    const r = await runBackupJob(cfg, log, undefined, { offsiteBackup: makeOffsite(cfg, log, undefined, {}) });
    expect(r.ok).toHaveLength(1);
    expect(r.offsite[0]!.error).toMatch(/does not exist/);
    expect(log.lines.some((l) => l.startsWith("error offsite backup skipped"))).toBe(true);
  });

  it("refuses destinations that overlap plaintext dirs", () => {
    const root = tempRoot();
    const c = { ...defaultOffsiteConfig(), enabled: true, folder: join(root, "backups", "x") };
    expect(() => assertSafeDestinations(c, [join(root, "brains"), join(root, "backups")], join(root, "offsite-outbox"))).toThrow(/overlaps a plaintext directory/);
    expect(() => assertSafeDestinations({ ...c, folder: undefined }, [join(root, "brains")], join(root, "brains", "o"))).toThrow(/outboxDir/);
    expect(() => assertSafeDestinations({ ...c, folder: join(root, "drive") }, [join(root, "brains"), join(root, "backups")], join(root, "offsite-outbox"))).not.toThrow();
  });
});

describe("restore safety", () => {
  async function artifactFor(root: string, key: BackupKey) {
    const src = join(root, "src.db");
    makeDb(src, 20);
    return (await encryptFile(src, join(root, "a-2026-01-01T00-00-00-000Z.swbk"), key)).artifact;
  }

  it("refuses to overwrite without --force; refuses a live brain while the service runs; moves old files (incl. -wal) aside", async () => {
    const root = tempRoot();
    const { key } = newKey();
    const art = await artifactFor(root, key);
    const plainOut = join(root, "existing.db");
    writeFileSync(plainOut, "old");
    await expect(restoreBackup({ artifact: art, out: plainOut, key })).rejects.toThrow(/already exists/);
    expect(readFileSync(plainOut, "utf8")).toBe("old");

    const brains = join(root, "brains");
    const liveDir = join(brains, "main");
    mkdirSync(liveDir, { recursive: true });
    const live = join(liveDir, "brain.db");
    writeFileSync(live, "live");
    writeFileSync(live + "-wal", "stale wal");
    await expect(restoreBackup({ artifact: art, out: live, key, brainsDir: brains })).rejects.toThrow(/already exists/);
    await expect(restoreBackup({ artifact: art, out: join(brains, "new", "brain.db"), key, brainsDir: brains })).rejects.toThrow(/live brain path/);
    await expect(restoreBackup({ artifact: art, out: live, key, brainsDir: brains, force: true, serviceRunning: async () => true })).rejects.toThrow(/service is running/);
    expect(readFileSync(live, "utf8")).toBe("live");
    expect(readdirSync(liveDir).sort()).toEqual(["brain.db", "brain.db-wal"]); // no stray temp files

    const r = await restoreBackup({ artifact: art, out: live, key, brainsDir: brains, force: true, serviceRunning: async () => false });
    expect(r.integrity).toBe("ok");
    expect(r.counts.nodes).toBe(20);
    expect(r.movedAside).toHaveLength(2);
    expect(existsSync(live + "-wal")).toBe(false);
    expect(readFileSync(r.movedAside.find((p) => p.endsWith("-wal"))!, "utf8")).toBe("stale wal");
    expect(checkDatabase(live).integrity).toBe("ok");
  });

  it("a decryptable artifact that is not a valid database is rejected and nothing is written", async () => {
    const root = tempRoot();
    const { key } = newKey();
    writeFileSync(join(root, "junk.bin"), randomBytes(5000));
    const enc = await encryptFile(join(root, "junk.bin"), join(root, "j.swbk"), key);
    const out = join(root, "o.db");
    await expect(restoreBackup({ artifact: enc.artifact, out, key })).rejects.toThrow(/not a readable SQLite database|integrity_check/);
    expect(readdirSync(root).filter((f) => f.startsWith(".restore-") || f.startsWith("o.db"))).toEqual([]);
  });
});

describe("CLI: keygen, backup now (offsite), restore; key never printed or logged", () => {
  it("end to end", async () => {
    const h = await startService();
    const tok = h.mint("bob");
    await tool(h.url, tok, "brain_write", { type: "semantic", label: "cli offsite", content: `${SECRET_MARK} cli` });
    await h.stop(false);
    const root = h.root;
    const keyFile = join(tempRoot("sw-key-"), ".sharpwave", "backup.key");
    const drive = join(tempRoot("sw-drive-"), "SharpWave");
    const logFile = join(root, "logs", "service.log");
    const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args, "--root", root], { encoding: "utf8", env: { ...process.env, SHARPWAVE_BACKUP_KEY: "" } });

    const kg = run("backup", "keygen", "--key-file", keyFile);
    expect(kg.status, kg.stderr).toBe(0);
    expect(kg.stdout).toMatch(/password manager/);
    const keyText = readFileSync(keyFile, "utf8").trim().split("\n").at(-1)!;
    const keyHex = Buffer.from(keyText, "base64").toString("hex");

    writeFileSync(join(root, "config.json"), JSON.stringify({
      logFile,
      offsiteBackup: { enabled: true, keyFile, folder: drive, command: [process.execPath, "-e", "process.exit(2)"] },
    }));
    const bn = run("backup", "now");
    expect(bn.status, bn.stdout + bn.stderr).toBe(3); // local ok, offsite command failed
    expect(bn.stdout).toMatch(/ok\s+bob/);
    expect(bn.stdout).toMatch(/OFFSITE FAILED bob .*exit=2.*local snapshot kept/);
    const art = allFiles(drive).find((f) => f.includes("bob-") && f.endsWith(".swbk"))!;
    expect(art).toBeTruthy();

    const out = join(tempRoot("sw-cli-restore-"), "bob.db");
    const rs = run("backup", "restore", art, "--out", out);
    expect(rs.status, rs.stderr).toBe(0);
    expect(rs.stdout).toMatch(/integrity\s+ok/);
    expect(rs.stdout).toMatch(/nodes=1 /);
    const again = run("backup", "restore", art, "--out", out);
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/already exists/);
    const live = run("backup", "restore", art, "--out", join(root, "brains", "bob", "brain.db"));
    expect(live.stderr).toMatch(/already exists|live brain/);

    // Wrong key via env (env wins over the file).
    const wrong = spawnSync(process.execPath, [CLI, "backup", "restore", art, "--out", out + "2", "--root", root], { encoding: "utf8", env: { ...process.env, SHARPWAVE_BACKUP_KEY: randomBytes(32).toString("base64") } });
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toMatch(/wrong key/);

    const everything = [kg, bn, rs, again, live, wrong].map((r) => r.stdout + r.stderr).join("\n") +
      readFileSync(logFile, "utf8") + readFileSync(join(root, "audit", "audit.jsonl"), "utf8") +
      allFiles(drive).filter((f) => f.endsWith(".json")).map((f) => readFileSync(f, "utf8")).join("\n");
    expect(everything).not.toContain(keyText);
    expect(everything).not.toContain(keyHex);
    expect(everything).not.toContain(SECRET_MARK);
    expect(readFileSync(join(root, "audit", "audit.jsonl"), "utf8")).toMatch(/backup\.restore/);
  });

  it("restore to a live brain is refused while the service answers on its port", async () => {
    const h = await startService();
    try {
      const { key, b64 } = newKey();
      const root = tempRoot();
      const src = join(root, "s.db");
      makeDb(src, 3);
      const art = (await encryptFile(src, join(root, "s-2026-01-01T00-00-00-000Z.swbk"), key)).artifact;
      const r = spawnSync(process.execPath, [CLI, "backup", "restore", art, "--out", join(h.root, "brains", "shared", "brain.db"), "--force", "--root", h.root, "--port", String(h.svc.port)], { encoding: "utf8", env: { ...process.env, SHARPWAVE_BACKUP_KEY: b64 } });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/service is running/);
      expect(r.stderr + r.stdout).not.toContain(b64);
    } finally {
      await h.stop();
    }
  });
});

// Restore drill against a COPY of the real snapshot (never the original).
const SNAP = process.env["SHARPWAVE_SNAPSHOT_DIR"] ?? "/workspace/brain-snap/main";
const hasSnap = existsSync(join(SNAP, "brain.db"));
const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

describe.skipIf(!hasSnap)("restore drill on a copy of the real snapshot", () => {
  it("snapshot -> encrypt -> folder -> restore: counts match, integrity ok, original untouched", async () => {
    const files = ["brain.db", "brain.db-wal"].filter((f) => existsSync(join(SNAP, f)));
    const before = Object.fromEntries(files.map((f) => [f, sha(join(SNAP, f))]));
    const root = tempRoot("sw-drill-");
    const baseDir = join(root, "baseline");
    mkdirSync(baseDir, { recursive: true });
    for (const f of files) copyFileSync(join(SNAP, f), join(baseDir, f));
    const base = new Database(join(baseDir, "brain.db"));
    const expected = countRows(base);
    base.close();
    expect(expected.nodes).toBeGreaterThan(0);

    const mount = join(root, "brains", "main");
    mkdirSync(mount, { recursive: true });
    for (const f of files) copyFileSync(join(SNAP, f), join(mount, f));
    const keyFile = join(root, "keys", "backup.key");
    generateKeyFile(keyFile);
    const drive = join(root, "drive");
    const cfg = testConfig(root, { offsiteBackup: { enabled: true, keyFile, folder: drive } });
    const log = memoryLogger();
    const audit = new AuditLog(cfg.auditFile);
    const r = await runBackupJob(cfg, log, audit);
    expect(r.failed).toEqual([]);
    expect(r.offsite[0]?.folder?.ok).toBe(true);
    const art = allFiles(drive).find((f) => f.endsWith(".swbk"))!;
    expect(readFileSync(art).includes(Buffer.from("SQLite format 3"))).toBe(false);

    const out = join(root, "restore", "brain.db");
    const res = await restoreBackup({ artifact: art, out, key: loadKey({ keyFile, env: {} }), brainsDir: join(root, "brains"), audit, requireManifest: true, force: true, serviceRunning: async () => false });
    expect(res.integrity).toBe("ok");
    expect(res.counts).toEqual(expected);
    // eslint-disable-next-line no-console
    console.log(`[restore drill] nodes=${res.counts.nodes} edges=${res.counts.edges} episodes=${res.counts.episodes} integrity=${res.integrity}`);
    unlinkSync(out);
    const after = Object.fromEntries(files.map((f) => [f, sha(join(SNAP, f))]));
    expect(after).toEqual(before);
  });
});

