#!/usr/bin/env node
// End-to-end MCP smoke test against the local build (dist/index.js).
//
// Simulates a stranger's environment, which is where every bug found in this
// package so far has lived: no Ollama (embedding host points at a dead port),
// no OpenRouter key, isolated data dir. Run it before publishing:
//
//   npm run build && npm run test:mcp
//
// Covers the three shipped regressions:
//   0.1.0  FTS exact-phrase search made natural-language recall return nothing
//          without a local embedding provider.
//   0.1.1  Working memory was a single global bucket shared across processes.
//   0.2.1  workingMemoryBoost INSERTED nodes the query never surfaced, so within
//          one long-lived MCP session every query polluted the next.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "dist", "index.js");
const DATA = mkdtempSync(join(tmpdir(), "sharpwave-smoke-"));

function client() {
  const proc = spawn(process.execPath, [SERVER], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      SHARPWAVE_DATA_DIR: DATA,
      SHARPWAVE_AGENT_ID: "smoke",
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
  proc.stderr.on("data", () => {});
  const rpc = (method, params) => {
    const rid = id++;
    return new Promise((res) => {
      const t = setTimeout(() => { pending.delete(rid); res({ __timeout: true }); }, 30000);
      pending.set(rid, (m) => { clearTimeout(t); res(m); });
      proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: rid, method, params }) + "\n");
    });
  };
  const notify = (m, p) => proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: m, params: p }) + "\n");
  return { proc, rpc, notify };
}

const text = (r) => { try { return r.result.content.map((c) => c.text).join("\n"); } catch { return JSON.stringify(r); } };
const call = (c, name, args) => c.rpc("tools/call", { name, arguments: args });
let failures = 0;
const check = (name, pass, detail) => {
  if (!pass) failures++;
  console.log(`${pass ? "ok  " : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const ONTOPIC = "what database do we use in production?";
const UNRELATED = "how do I bake sourdough bread at high altitude?";
const leaked = (t) => /postgres|jwt|thursday/i.test(t);

(async () => {
  const a = client();
  const init = await a.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  check("initialize", !!init.result, `v${init?.result?.serverInfo?.version}`);
  a.notify("notifications/initialized", {});

  const tools = await a.rpc("tools/list", {});
  check("tools/list", (tools?.result?.tools?.length ?? 0) > 0, `${tools?.result?.tools?.length} tools`);

  for (const [label, content] of [
    ["Postgres is the primary datastore", "The production database is PostgreSQL 16 running on RDS in us-east-1."],
    ["Deploys go out on Thursdays", "The team ships to production every Thursday afternoon after staging soak."],
    ["Auth uses short-lived JWTs", "Authentication issues JWT access tokens with a fifteen minute expiry."],
  ]) {
    await call(a, "brain_write", { type: "semantic", label, content });
  }
  check("brain_write x3 without an embedding provider", true);

  // 0.1.0 regression — NL recall must work on FTS alone.
  const hit = text(await call(a, "brain_query", { query: ONTOPIC }));
  check("NL query hits via FTS fallback", /postgres/i.test(hit), /postgres/i.test(hit) ? "" : hit.slice(0, 120));

  // 0.2.1 regression — a warm session must not leak the prior answer.
  const after = text(await call(a, "brain_query", { query: UNRELATED }));
  check("unrelated query misses with WARM working memory", !leaked(after), leaked(after) ? `LEAKED: ${after.slice(0, 120)}` : "");

  // brain_reset — refuses without the exact agent id, then wipes everything.
  const refused = text(await call(a, "brain_reset", { confirm: "wrong" }));
  check("brain_reset refuses a bad confirm", /refused/i.test(refused), refused.slice(0, 80));
  const still = text(await call(a, "brain_query", { query: ONTOPIC }));
  check("brain still intact after a refused reset", /postgres/i.test(still), still.slice(0, 80));

  const wiped = text(await call(a, "brain_reset", { confirm: "smoke" }));
  check("brain_reset succeeds with the right confirm", /Brain reset/i.test(wiped) && /Backup:/.test(wiped), wiped.slice(0, 120));
  const stats = text(await call(a, "brain_stats", {}));
  check("brain has 0 nodes after reset", /\b0\b/.test(stats) && !/postgres/i.test(text(await call(a, "brain_query", { query: ONTOPIC }))), stats.slice(0, 120));

  // Writing works again after a reset (embedding path untouched).
  await call(a, "brain_write", { type: "semantic", label: "post-reset write", content: "The cache layer is Redis 7 on ElastiCache." });
  const postReset = text(await call(a, "brain_query", { query: "what cache do we use?" }));
  check("brain_write + recall work after a reset", /redis/i.test(postReset), postReset.slice(0, 120));

  a.proc.kill();
  await new Promise((r) => setTimeout(r, 500));

  // 0.1.1 regression — a brand new process must start clean.
  const b = client();
  await b.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
  b.notify("notifications/initialized", {});
  const fresh = text(await call(b, "brain_query", { query: UNRELATED }));
  check("unrelated query misses in a fresh process", !leaked(fresh), leaked(fresh) ? `LEAKED: ${fresh.slice(0, 120)}` : "");
  b.proc.kill();

  try { rmSync(DATA, { recursive: true, force: true }); } catch {}
  console.log(failures ? `\n${failures} check(s) FAILED` : "\nall checks passed");
  process.exit(failures ? 1 : 0);
})();
