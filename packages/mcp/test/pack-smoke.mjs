#!/usr/bin/env node
// Pre-publish gate: pack `sharpwave` and install the tarball in a clean directory
// with NO workspace, then drive the installed server over MCP.
//
//   npm run test:pack
//
// This is the ONLY gate that catches a C1-class bug — a build-time-only package
// (`sharpwave-core`, `"private": true`, never on the registry) leaking into
// `"dependencies"`. `npm install <tarball>` in a workspace-free dir is exactly
// where such an entry 404s, which is what every external `npm install sharpwave`
// would hit. It is slow and touches the network (real `npm install`), so it is
// deliberately NOT part of `test:all`.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const MCP_DIR = resolve(HERE, "..");
const ROOT = resolve(MCP_DIR, "..", "..");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

let failures = 0;
const check = (name, pass, detail) => {
  if (!pass) failures++;
  console.log(`${pass ? "ok  " : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

function run(cmd, args, cwd) {
  console.log(`\n$ ${cmd} ${args.join(" ")}   (cwd: ${cwd})`);
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", shell: process.platform === "win32" });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} exited ${r.status}`);
  return r;
}

const cleanup = [];
process.on("exit", () => { for (const fn of cleanup.reverse()) { try { fn(); } catch {} } });

// ── 1. Build core + mcp from the workspace ────────────────────────────────────
run(NPM, ["run", "build", "--workspace", "sharpwave-core"], ROOT);
run(NPM, ["run", "build", "--workspace", "sharpwave"], ROOT);

// ── 2. npm pack the published package ─────────────────────────────────────────
const packOut = run(NPM, ["pack"], MCP_DIR).stdout.trim();
const tarball = packOut.split("\n").pop().trim(); // last line is the filename
const tarballAbs = join(MCP_DIR, tarball);
cleanup.push(() => rmSync(tarballAbs, { force: true }));
check("npm pack produced a tarball", /^sharpwave-\d.*\.tgz$/.test(tarball), tarball);

// ── 3. Install the tarball in a clean, workspace-free directory ───────────────
const INSTALL = mkdtempSync(join(tmpdir(), "sharpwave-pack-"));
cleanup.push(() => rmSync(INSTALL, { recursive: true, force: true }));
writeFileSync(join(INSTALL, "package.json"), JSON.stringify({ name: "pack-smoke-consumer", private: true, version: "1.0.0" }, null, 2));
// This is where a bad "dependencies" entry (unpublished sharpwave-core) 404s.
run(NPM, ["install", tarballAbs, "--no-audit", "--no-fund"], INSTALL);

const SERVER = join(INSTALL, "node_modules", "sharpwave", "dist", "index.js");

// ── 4. Drive the installed server over MCP (stranger's environment) ───────────
const DATA = mkdtempSync(join(tmpdir(), "sharpwave-pack-data-"));
cleanup.push(() => rmSync(DATA, { recursive: true, force: true }));

const proc = spawn(process.execPath, [SERVER], {
  stdio: ["pipe", "pipe", "pipe"],
  env: {
    ...process.env,
    SHARPWAVE_DATA_DIR: DATA,
    SHARPWAVE_AGENT_ID: "pack-smoke",
    OLLAMA_BASE_URL: "http://127.0.0.1:59999",
    OPENROUTER_API_KEY: "",
    SHARPWAVE_OPENROUTER_API_KEY: "",
  },
});
let buf = ""; const pending = new Map(); let id = 1;
proc.stdout.on("data", (d) => {
  buf += d.toString(); let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id != null && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
let stderr = "";
proc.stderr.on("data", (d) => { stderr += d.toString(); });
const rpc = (method, params) => {
  const rid = id++;
  return new Promise((res) => {
    const t = setTimeout(() => { pending.delete(rid); res({ __timeout: true }); }, 30000);
    pending.set(rid, (m) => { clearTimeout(t); res(m); });
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n");
  });
};
const notify = (m, p) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: m, params: p }) + "\n");
const text = (r) => { try { return r.result.content.map((c) => c.text).join("\n"); } catch { return JSON.stringify(r); } };
const call = (name, args) => rpc("tools/call", { name, arguments: args });

try {
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "pack-smoke", version: "1" } });
  check("initialize", !!init.result, `v${init?.result?.serverInfo?.version}`);
  notify("notifications/initialized", {});

  const tools = await rpc("tools/list", {});
  const n = tools?.result?.tools?.length ?? 0;
  check("tools/list returns exactly 11", n === 11, `${n} tools`);

  await call("brain_write", { type: "semantic", label: "db", content: "The production database is PostgreSQL 16 on RDS." });
  const hit = text(await call("brain_query", { query: "what database do we use in production?" }));
  check("brain_write + brain_query round-trip", /postgres/i.test(hit), hit.slice(0, 160));

  proc.kill();
} catch (e) {
  failures++;
  console.log(`FAIL  MCP drive threw — ${e?.message}`);
  console.log(stderr.slice(0, 500));
  proc.kill();
}

console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed — tarball installs standalone and the server works");
process.exit(failures ? 1 : 0);
