#!/usr/bin/env node
// sharpwave-client — tiny, dependency-free CLI for the SharpWave brain service.
//
// Plain Node (>=18, uses global fetch). No build step, no npm install: copy this
// one file anywhere and run it with `node sharpwave-client.mjs ...` — works the
// same in Windows PowerShell, cmd, and POSIX shells.
//
//   node sharpwave-client.mjs search <query...> [--limit 10] [--scope all|private|shared] [--type semantic]
//   node sharpwave-client.mjs read   <nodeId>   [--shared]
//   node sharpwave-client.mjs write  <content...> --label "Short name" [--type semantic] [--importance 0.6] [--shared]
//   node sharpwave-client.mjs stats  [--scope all|private|shared]
//   node sharpwave-client.mjs health
//
// Options:
//   --url <base>         default $SHARPWAVE_URL or http://127.0.0.1:18790
//   --token <token>      else $SHARPWAVE_TOKEN, else --token-file / $SHARPWAVE_TOKEN_FILE,
//                        else ~/.sharpwave/token (first line)
//   --json               machine-readable output
//
// Exit codes: 0 ok · 1 tool error · 2 usage · 3 auth (401/403) · 4 connection/HTTP error.

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VERSION = "0.1.0";
const BOOL = new Set(["json", "shared", "help", "h", "version"]);

function parse(argv) {
  const out = { _: [], f: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { out._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--") || /^-[a-z]$/i.test(a)) {
      let k = a.replace(/^-+/, "");
      let v;
      const eq = k.indexOf("=");
      if (eq >= 0) { v = k.slice(eq + 1); k = k.slice(0, eq); }
      else if (!BOOL.has(k)) { v = argv[++i]; if (v === undefined) usage(`--${k} needs a value`); }
      out.f[k] = v ?? true;
    } else out._.push(a);
  }
  return out;
}

const HELP = `sharpwave-client ${VERSION}
Usage:
  sharpwave-client search <query...> [--limit N] [--scope all|private|shared] [--type T] [--json]
  sharpwave-client read <nodeId> [--shared] [--json]
  sharpwave-client write <content...> --label "name" [--type semantic] [--importance 0.5] [--shared] [--json]
  sharpwave-client stats [--scope all|private|shared] [--json]
  sharpwave-client health [--json]
Options: --url (default $SHARPWAVE_URL or http://127.0.0.1:18790)
         --token | $SHARPWAVE_TOKEN | --token-file | $SHARPWAVE_TOKEN_FILE | ~/.sharpwave/token`;

function usage(msg) {
  if (msg) process.stderr.write(`sharpwave-client: ${msg}\n\n`);
  process.stderr.write(HELP + "\n");
  process.exit(2);
}

function die(code, msg) {
  process.stderr.write(`sharpwave-client: ${msg}\n`);
  process.exit(code);
}

function resolveToken(f) {
  if (typeof f.token === "string" && f.token) return f.token.trim();
  if (process.env.SHARPWAVE_TOKEN) return process.env.SHARPWAVE_TOKEN.trim();
  const file = (typeof f["token-file"] === "string" && f["token-file"]) || process.env.SHARPWAVE_TOKEN_FILE || join(homedir(), ".sharpwave", "token");
  if (existsSync(file)) {
    const line = readFileSync(file, "utf8").split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (line) return line;
  }
  return null;
}

function baseUrl(f) {
  const u = (typeof f.url === "string" && f.url) || process.env.SHARPWAVE_URL || "http://127.0.0.1:18790";
  return u.replace(/\/+$/, "").replace(/\/mcp$/, "");
}

let rpcId = 0;
async function callTool(base, token, name, args) {
  let res;
  try {
    res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    die(4, `cannot reach ${base} (${e?.cause?.code ?? e?.message ?? e}) — is the brain service running?`);
  }
  if (res.status === 401 || res.status === 403) die(3, `${res.status} ${res.status === 401 ? "unauthorized — missing or invalid token" : "forbidden"}`);
  const raw = await res.text();
  if (!res.ok) die(4, `HTTP ${res.status}: ${raw.slice(0, 300)}`);
  let msg;
  const ctype = res.headers.get("content-type") ?? "";
  if (ctype.includes("text/event-stream")) {
    // SSE fallback: take the last `data:` payload that is a JSON-RPC response.
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      try { const m = JSON.parse(line.slice(5).trim()); if (m && (m.result || m.error)) msg = m; } catch { /* skip */ }
    }
  } else {
    try { msg = JSON.parse(raw); } catch { die(4, `bad response: ${raw.slice(0, 300)}`); }
  }
  if (!msg) die(4, "empty response");
  if (msg.error) die(1, `server error ${msg.error.code}: ${msg.error.message}`);
  const text = (msg.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { text, isError: !!msg.result?.isError };
}

function out(text) {
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
}

async function main() {
  const { _, f } = parse(process.argv.slice(2));
  if (f.version) { out(VERSION); return; }
  const [cmd, ...rest] = _;
  if (!cmd || f.help || f.h) usage();
  const base = baseUrl(f);
  const json = !!f.json;

  if (cmd === "health") {
    let res;
    try { res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(10_000) }); }
    catch (e) { die(4, `cannot reach ${base} (${e?.cause?.code ?? e?.message ?? e})`); }
    const body = await res.json();
    out(json ? JSON.stringify(body, null, 2) : `${body.status}  v${body.version}  ${body.addresses.join(", ")}`);
    return;
  }

  const token = resolveToken(f);
  if (!token) die(3, "no token — pass --token, set SHARPWAVE_TOKEN, or use --token-file");

  let name;
  let args;
  switch (cmd) {
    case "search": {
      const query = rest.join(" ").trim();
      if (!query) usage("search needs a query");
      name = "brain_query";
      args = { query, format: "json" };
      if (f.limit) args.limit = Number(f.limit);
      if (f.scope) args.scope = String(f.scope);
      if (f.type) args.type = String(f.type);
      break;
    }
    case "read": {
      if (!rest[0]) usage("read needs a node id");
      name = "brain_expand";
      args = { node_id: rest[0], format: "json", ...(f.shared ? { visibility: "shared" } : {}) };
      break;
    }
    case "write": {
      const content = rest.join(" ").trim();
      if (!content) usage("write needs content");
      if (typeof f.label !== "string") usage("write needs --label");
      name = "brain_write";
      args = { type: typeof f.type === "string" ? f.type : "semantic", label: f.label, content };
      if (f.importance) args.importance = Number(f.importance);
      if (f.shared) args.visibility = "shared";
      break;
    }
    case "stats": {
      name = "brain_stats";
      args = { format: "json", ...(f.scope ? { visibility: String(f.scope) } : {}) };
      break;
    }
    default:
      usage(`unknown command "${cmd}"`);
  }

  const r = await callTool(base, token, name, args);
  if (r.isError) {
    if (json) out(JSON.stringify({ error: r.text }, null, 2));
    else process.stderr.write(r.text + "\n");
    process.exit(1);
  }

  if (cmd === "write") {
    const m = /node (\S+) \((\w+)\) "(.*)" brain=(\w+) writer=(\S+)/.exec(r.text);
    if (json) out(JSON.stringify(m ? { id: m[1], type: m[2], label: m[3], brain: m[4], writer: m[5], message: r.text } : { message: r.text }, null, 2));
    else out(r.text);
    return;
  }
  let data;
  try { data = JSON.parse(r.text); } catch { out(r.text); return; }
  if (json) { out(JSON.stringify(data, null, 2)); return; }

  if (cmd === "search") {
    if (!data.results.length) { out("No matching memories."); return; }
    out(data.results.map((h, i) =>
      `${i + 1}. [${h.brain}] ${h.label}  (${h.type}, score ${h.score.toFixed(2)})\n   ${h.content.replace(/\s+/g, " ").slice(0, 240)}\n   id ${h.id}${h.writer ? `  writer ${h.writer}` : ""}`,
    ).join("\n\n"));
  } else if (cmd === "read") {
    const n = data.node;
    out([
      `${n.label}  [${data.brain}]`,
      `id ${n.id}  type ${n.type}  writer ${n.writer_agent_id ?? "(none)"}`,
      `created ${new Date(n.created_at).toISOString()}  importance ${Number(n.importance).toFixed(2)}`,
      "",
      n.content,
    ].join("\n"));
  } else if (cmd === "stats") {
    out(data.brains.map((b) =>
      `[${b.brain}] ${b.nodes} nodes, ${b.activeEdges} edges, ${b.episodes} episodes (${b.embedded} embedded)\n` +
      `  ${Object.entries(b.nodesByType).map(([k, v]) => `${k} ${v}`).join(" · ") || "empty"}`,
    ).join("\n"));
  }
}

main().catch((e) => die(4, e?.stack ?? String(e)));
