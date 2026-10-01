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
//   node sharpwave-client.mjs forget <nodeId>   [--shared] [--force]
//   node sharpwave-client.mjs history <query...> [--limit 10] [--shared]   (episode log full-text search)
//   node sharpwave-client.mjs health
//   node sharpwave-client.mjs seed   <dir> [--target shared|private|skip] [--map file=shared|private|skip ...]
//                                    [--type file=nodeType ...] [--tag t ...] [--importance 0.6] [--max-chars 1800]
//                                    [--dry-run | --offline | --remove | --list] [--prune]
//
// Options:
//   --url <base>         default $SHARPWAVE_URL or http://127.0.0.1:18790
//   --token <token>      else $SHARPWAVE_TOKEN, else --token-file / $SHARPWAVE_TOKEN_FILE,
//                        else ~/.sharpwave/token (first line)
//   --json               machine-readable output
//
// Exit codes: 0 ok · 1 tool error · 2 usage · 3 auth (401/403) · 4 connection/HTTP error.

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

const VERSION = "0.1.0";
const BOOL = new Set(["json", "shared", "force", "help", "h", "version", "dry-run", "offline", "remove", "list", "prune"]);
const MULTI = new Set(["map", "type", "tag"]);

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
      if (MULTI.has(k)) (out.f[k] = Array.isArray(out.f[k]) ? out.f[k] : []).push(v);
      else out.f[k] = v ?? true;
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
  sharpwave-client forget <nodeId> [--shared] [--force]   (delete one node; needs write / shared-write)
  sharpwave-client history <query...> [--limit N] [--shared]   (search the episode log via brain_history)
  sharpwave-client health [--json]
  sharpwave-client seed <dir> [--target shared|private|skip] [--map file=shared|private|skip ...]
                   [--type file=nodeType ...] [--tag t ...] [--importance 0.6] [--max-chars 1800]
                   [--dry-run | --offline | --remove | --list] [--prune] [--json]
      Imports every *.md in <dir> (chunked by #/##/### heading) via brain_seed (admin token).
      Idempotent: each chunk is keyed by a content hash in source "seed:<file>#<hash>".
      --dry-run asks the server what would be created; --offline only chunks (no server);
      --remove deletes everything seeded from the mapped files; --list counts seeded nodes.
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

// ─── seed: markdown chunking (pure, no I/O) ────────────────────────────────

/**
 * Split markdown into chunks at #, ## and ### headings (outside fenced code).
 * Each chunk: { label: "H1 › H2 › H3", content: body }. Empty sections are
 * dropped; bodies over maxChars are split on blank lines into "(part i/n)".
 */
function chunkMarkdown(text, fileStem, maxChars = 1800) {
  const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
  let i = 0;
  if (lines[0] === "---") { // YAML front matter
    const end = lines.indexOf("---", 1);
    if (end > 0) i = end + 1;
  }
  const sections = [];
  const path = [];
  let body = [];
  let fence = null;
  const flush = () => {
    const content = body.join("\n").trim();
    if (content) sections.push({ label: path.filter(Boolean).join(" \u203a ") || fileStem, content });
    body = [];
  };
  for (; i < lines.length; i++) {
    const line = lines[i];
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) { if (!fence) fence = f[1]; else if (fence === f[1]) fence = null; body.push(line); continue; }
    const h = fence ? null : /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      path.length = level - 1;
      path[level - 1] = h[2].trim();
      continue;
    }
    body.push(line);
  }
  flush();
  const out = [];
  for (const s of sections) {
    const label = s.label.length > 200 ? s.label.slice(0, 199) + "\u2026" : s.label;
    if (s.content.length <= maxChars) { out.push({ label, content: s.content }); continue; }
    const parts = [];
    let cur = "";
    for (const para of s.content.split(/\n{2,}/)) {
      // Oversized paragraph (e.g. a long bullet list): split on line
      // boundaries; only a single line longer than maxChars is hard-cut.
      const units = para.length <= maxChars ? [para] : para.split("\n").flatMap((l) =>
        l.length <= maxChars ? [l] : l.match(new RegExp(`[\\s\\S]{1,${maxChars}}`, "g")));
      const sep = para.length <= maxChars ? "\n\n" : "\n";
      let first = true;
      for (const unit of units) {
        const join = first ? "\n\n" : sep;
        first = false;
        if (cur && cur.length + join.length + unit.length > maxChars) { parts.push(cur); cur = ""; }
        cur = cur ? `${cur}${join}${unit}` : unit;
      }
    }
    if (cur) parts.push(cur);
    parts.forEach((c, k) => out.push({ label: `${label} (part ${k + 1}/${parts.length})`, content: c }));
  }
  return out;
}

function kvList(list, flag) {
  const m = new Map();
  for (const item of list ?? []) {
    const eq = String(item).lastIndexOf("=");
    if (eq <= 0) usage(`--${flag} expects file=value, got "${item}"`);
    m.set(String(item).slice(0, eq).trim(), String(item).slice(eq + 1).trim());
  }
  return m;
}

async function seedCommand(rest, f, base, json) {
  const dir = rest[0];
  if (!dir) usage("seed needs a directory");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) die(2, `not a directory: ${dir}`);
  const TARGETS = new Set(["shared", "private", "skip"]);
  const def = typeof f.target === "string" ? f.target : null;
  if (def && !TARGETS.has(def)) usage(`--target must be shared, private or skip`);
  const map = kvList(f.map, "map");
  for (const [k, v] of map) if (!TARGETS.has(v)) usage(`--map ${k}=${v}: target must be shared, private or skip`);
  const types = kvList(f.type, "type");
  const tags = (f.tag ?? []).map(String);
  const maxChars = f["max-chars"] ? Number(f["max-chars"]) : 1800;
  if (!Number.isFinite(maxChars) || maxChars < 200) usage("--max-chars must be >= 200");
  const importance = f.importance !== undefined ? Number(f.importance) : undefined;
  const mode = f.list ? "list" : f.remove ? "remove" : f["dry-run"] ? "dry-run" : f.offline ? "offline" : "import";

  const files = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".md")).sort();
  for (const k of map.keys()) if (!files.includes(k)) die(2, `--map names ${k}, which is not a .md file in ${dir}`);
  const plan = files.map((file) => ({ file, target: map.get(file) ?? def ?? "unmapped" }));
  const unmapped = plan.filter((p) => p.target === "unmapped").map((p) => p.file);
  if (unmapped.length && mode !== "list") die(2, `no target for: ${unmapped.join(", ")} (use --map file=shared|private|skip or --target)`);

  let token = null;
  if (mode !== "offline") {
    token = resolveToken(f);
    if (!token) die(3, "no token — seeding needs an admin token (--token-file / SHARPWAVE_TOKEN_FILE)");
  }

  if (mode === "list") {
    const rows = [];
    for (const visibility of ["private", "shared"]) {
      const r = await callTool(base, token, "brain_seed", { mode: "list", source: "*", visibility });
      if (r.isError) die(1, r.text);
      rows.push(JSON.parse(r.text));
    }
    if (json) out(JSON.stringify(rows, null, 2));
    else out(rows.map((r) => `[${r.brain}] ${r.total} seeded nodes${Object.entries(r.sources).map(([k, v]) => `\n  ${k}: ${v}`).join("")}`).join("\n"));
    return;
  }

  const results = [];
  for (const p of plan) {
    if (p.target === "skip") { results.push({ file: p.file, target: "skip" }); continue; }
    const stem = basename(p.file, ".md");
    const chunks = mode === "remove" ? [] : chunkMarkdown(readFileSync(join(dir, p.file), "utf8"), stem, maxChars).map((c) => ({
      ...c,
      ...(types.get(p.file) ? { type: types.get(p.file) } : {}),
      ...(importance !== undefined ? { importance } : {}),
      tags: ["seed", stem, ...tags],
    }));
    if (mode === "offline") { results.push({ file: p.file, target: p.target, chunks: chunks.length }); continue; }
    const args = { mode, source: p.file, visibility: p.target, ...(mode === "remove" ? {} : { chunks }), ...(f.prune && mode === "import" ? { prune: true } : {}) };
    const r = await callTool(base, token, "brain_seed", args);
    if (r.isError) die(1, `${p.file}: ${r.text}`);
    results.push({ file: p.file, target: p.target, ...JSON.parse(r.text) });
  }
  if (json) { out(JSON.stringify({ mode, results }, null, 2)); return; }
  const lines = results.map((r) => {
    if (r.target === "skip") return `skip     ${r.file}`;
    if (mode === "offline") return `${r.target.padEnd(8)} ${r.file}  chunks=${r.chunks}`;
    if (mode === "remove") return `${r.target.padEnd(8)} ${r.file}  removed=${r.removed}`;
    const made = mode === "import" ? `created=${r.created}` : `wouldCreate=${r.wouldCreate}`;
    return `${r.target.padEnd(8)} ${r.file}  chunks=${r.chunks} ${made} existing=${r.existing}` +
      (r.staleFromEarlierVersions ? ` stale=${r.staleFromEarlierVersions}` : "") + (r.pruned ? ` pruned=${r.pruned}` : "");
  });
  const sum = (k) => results.reduce((s, r) => s + (r[k] ?? 0), 0);
  for (const t of ["shared", "private"]) {
    const rs = results.filter((r) => r.target === t);
    if (rs.length) lines.push(`total ${t}: ${rs.reduce((s, r) => s + (r.chunks ?? r.removed ?? 0), 0)} ${mode === "remove" ? "removed" : "chunks"} in ${rs.length} file(s)`);
  }
  if (mode === "import") lines.push(`created ${sum("created")}, already present ${sum("existing")}`);
  if (mode === "dry-run") lines.push(`would create ${sum("wouldCreate")}, already present ${sum("existing")} (nothing written)`);
  out(lines.join("\n"));
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

  if (cmd === "seed") { await seedCommand(rest, f, base, json); return; }

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
    case "forget": {
      if (!rest[0]) usage("forget needs a node id");
      name = "brain_forget";
      args = { node_id: rest[0], ...(f.force ? { force: true } : {}), ...(f.shared ? { visibility: "shared" } : {}) };
      break;
    }
    case "history": {
      const query = rest.join(" ").trim();
      if (!query) usage("history needs a query");
      name = "brain_history";
      args = { query, ...(f.limit ? { limit: Number(f.limit) } : {}), ...(f.shared ? { visibility: "shared" } : {}) };
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
