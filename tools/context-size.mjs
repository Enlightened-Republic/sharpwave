#!/usr/bin/env node
/**
 * tools/context-size.mjs
 *
 * Tinker-UI-lite cost dashboard â€” byte-budget snapshot for memory + workspace.
 * Pattern lifted from tinkerclaw's Tinker UI (cost dashboard + context treemap),
 * simplified to what we can ship tonight without a full UI.
 *
 * Scans:
 *   - memory/*.md + memory/*.json + memory/snapshots/*.json
 *   - MEMORY.md (workspace root)
 *   - .learnings/*.md
 *
 * Output:
 *   - Markdown table sorted largest-first (file, bytes, lines, last-touched)
 *   - Total workspace byte-budget
 *   - Bloat warnings (configurable threshold, default 50KB)
 *   - Delta vs previous snapshot (if available)
 *
 * Persists:
 *   - memory/snapshots/context-size-YYYY-MM-DD.json (for delta tracking)
 *
 * Flags:
 *   --threshold <kb>    bloat warning threshold per file (default 50)
 *   --no-snapshot       don't write snapshot (preview only)
 *   --json              output as JSON for programmatic consumption
 *   --top <n>           show only top N files (default 20)
 *
 * Companion: tools/context-size.spec.mjs (planned) â€” snapshot+delta unit tests.
 */

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync, mkdirSync } from 'node:fs';
import { resolve, dirname, basename, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WORKSPACE = resolve(__dirname, '..');
const MEMORY_DIR = resolve(WORKSPACE, 'memory');
const SNAPSHOT_DIR = resolve(MEMORY_DIR, 'snapshots');

const SCAN_PATHS = [
  { root: MEMORY_DIR, pattern: /\.(md|json)$/i, skip: /snapshots\// },
  { root: WORKSPACE, file: 'MEMORY.md', single: true },
  { root: resolve(WORKSPACE, '.learnings'), pattern: /\.md$/i, optional: true },
];

function parseArgs(argv) {
  const out = { _: [], threshold: 50, snapshot: true, json: false, top: 20, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--threshold') out.threshold = parseInt(argv[++i], 10);
    else if (a === '--no-snapshot') out.snapshot = false;
    else if (a === '--json') out.json = true;
    else if (a === '--top') out.top = parseInt(argv[++i], 10);
    else if (a === '--help' || a === '-h') out.help = true;
    else out._.push(a);
  }
  return out;
}

function walkFiles(root, pattern, skip) {
  if (!existsSync(root)) return [];
  const results = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = resolve(root, entry.name);
    if (entry.isDirectory()) {
      if (skip && skip.test(full + '/')) continue;
      results.push(...walkFiles(full, pattern, skip));
    } else if (entry.isFile()) {
      if (pattern && !pattern.test(entry.name)) continue;
      results.push(full);
    }
  }
  return results;
}

function statFile(path) {
  const stat = statSync(path);
  let lines = 0;
  try {
    const text = readFileSync(path, 'utf8');
    lines = text.split('\n').length;
  } catch {}
  return {
    path,
    relPath: relative(WORKSPACE, path),
    bytes: stat.size,
    lines,
    mtime: stat.mtime.toISOString(),
  };
}

function findPreviousSnapshot() {
  if (!existsSync(SNAPSHOT_DIR)) return null;
  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  // Prefer yesterday's snapshot for meaningful delta
  const candidates = [
    resolve(SNAPSHOT_DIR, `context-size-${yesterday}.json`),
    resolve(SNAPSHOT_DIR, `context-size-${today}.json`),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      try {
        return JSON.parse(readFileSync(c, 'utf8'));
      } catch {}
    }
  }
  return null;
}

function renderMarkdown(entries, totalBytes, threshold, previous, topN) {
  const thresholdBytes = threshold * 1024;
  const sorted = [...entries].sort((a, b) => b.bytes - a.bytes).slice(0, topN);
  const lines = [];
  lines.push(`# context-size snapshot â€” ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`);
  lines.push('');
  lines.push(`**Total workspace footprint**: ${(totalBytes / 1024).toFixed(1)} KB across ${entries.length} tracked files`);
  if (previous) {
    const prevTotal = previous.totalBytes || 0;
    const delta = totalBytes - prevTotal;
    const sign = delta >= 0 ? '+' : '';
    lines.push(`**Delta vs previous snapshot**: ${sign}${(delta / 1024).toFixed(1)} KB (${sign}${((delta / prevTotal) * 100).toFixed(1)}%)`);
  }
  lines.push('');
  lines.push(`| file | bytes | KB | lines | last touched |`);
  lines.push(`|------|------:|---:|------:|--------------|`);
  for (const e of sorted) {
    const kb = (e.bytes / 1024).toFixed(1);
    const warn = e.bytes > thresholdBytes ? ' âš ï¸' : '';
    const deltaStr = previous?.files?.[e.relPath]
      ? ` (${e.bytes - previous.files[e.relPath].bytes >= 0 ? '+' : ''}${((e.bytes - previous.files[e.relPath].bytes) / 1024).toFixed(1)}KB)`
      : '';
    lines.push(`| \`${e.relPath}\`${warn} | ${e.bytes} | ${kb} | ${e.lines} | ${e.mtime.slice(0, 16).replace('T', ' ')}${deltaStr} |`);
  }
  lines.push('');
  // Bloat warnings
  const bloat = entries.filter(e => e.bytes > thresholdBytes);
  if (bloat.length) {
    lines.push(`## âš ï¸ Bloat warnings (threshold ${threshold}KB)`);
    for (const e of bloat) {
      lines.push(`- \`${e.relPath}\` â€” ${(e.bytes / 1024).toFixed(1)} KB (${e.lines} lines)`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(`Usage: node tools/context-size.mjs [flags]

Flags:
  --threshold <kb>    bloat warning threshold per file (default 50)
  --no-snapshot       don't write snapshot (preview only)
  --json              output as JSON
  --top <n>           show only top N files (default 20)

Tinker-UI-lite byte-budget dashboard. Scans memory/*.md + MEMORY.md + .learnings/*.md.
`);
  process.exit(0);
  }

  // Gather files
  const files = [];
  for (const spec of SCAN_PATHS) {
    if (spec.single) {
      const p = spec.root ? resolve(spec.root, spec.file) : spec.file;
      if (existsSync(p)) files.push(p);
    } else if (spec.optional && !existsSync(spec.root)) {
      continue;
    } else {
      files.push(...walkFiles(spec.root, spec.pattern, spec.skip));
    }
  }

  // Stat each
  const entries = files.map(statFile);
  const totalBytes = entries.reduce((sum, e) => sum + e.bytes, 0);
  const previous = findPreviousSnapshot();

  if (args.json) {
    const out = { ts: new Date().toISOString(), totalBytes, fileCount: entries.length, files: entries };
    process.stdout.write(JSON.stringify(out, null, 2));
  } else {
    process.stdout.write(renderMarkdown(entries, totalBytes, args.threshold, previous, args.top));
  }

  // Snapshot
  if (args.snapshot) {
    if (!existsSync(SNAPSHOT_DIR)) mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const today = new Date().toISOString().slice(0, 10);
    const snapPath = resolve(SNAPSHOT_DIR, `context-size-${today}.json`);
    const filesMap = {};
    for (const e of entries) filesMap[e.relPath] = { bytes: e.bytes, lines: e.lines, mtime: e.mtime };
    writeFileSync(snapPath, JSON.stringify({
      ts: new Date().toISOString(),
      totalBytes,
      fileCount: entries.length,
      files: filesMap,
    }, null, 2));
    process.stderr.write(`[context-size] snapshot written: ${snapPath}\n`);
  }
}

main();