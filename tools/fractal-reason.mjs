#!/usr/bin/env node
/**
 * tools/fractal-reason.mjs
 *
 * Fractal Reasoning helper (Level 0 â†’ Level 3) â€” pattern lifted from
 * tinkerclaw (globalcaos/tinkerclaw) per Marley's 2026-08-19 analysis.
 *
 * Most agents stop at Level 0 (fix the bug). This helper forces the
 * full 4-level breakdown so every carry closure captures:
 *   Level 0 â€” what was fixed (concrete)
 *   Level 1 â€” what pattern allowed it (systemic)
 *   Level 2 â€” what flaw in thinking produced the pattern (deeper systemic)
 *   Level 3 â€” the meta-rule that prevents recurrence (encodes principle)
 *
 * Designed to be called by commitments.md ledger updates + future
 * heartbeat closure flows.
 *
 * Usage:
 *   node tools/fractal-reason.mjs "<carry-id>" --emit "<what-was-fixed>"
 *   # then interactive prompts for L1/L2/L3 OR pass all via flags
 *
 * Flags:
 *   --emit "<text>"      Level 0: concrete fix description (required)
 *   --pattern "<text>"   Level 1: the systemic pattern
 *   --flaw "<text>"      Level 2: the deeper flaw in thinking
 *   --meta "<text>"      Level 3: the meta-rule / principle
 *   --edges "<a,b,c>"    comma-separated explicit edges to attach (CAUSED_BY, LEADS_TO, ...)
 *   --no-stamp           don't auto-stamp lastFractalReason
 *
 * Output: a markdown block ready to paste into commitments.md carry closure.
 *
 * Companion file: tools/fractal-reason.spec.mjs (planned) â€” unit tests
 * for the 4-level structure enforcement.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const STATE_PATH = resolve(__dirname, '..', 'memory', 'fractal-state.json');

const VALID_EDGE_TYPES = [
  'CAUSED_BY', 'LEADS_TO', 'RESOLVED_BY', 'CONTRADICTS', 'SUGGESTS',
  'INHIBITS', 'BEFORE', 'AFTER', 'INSTANCE_OF', 'GOAL_OF',
  'SUPPORTS', 'SUMMARIZES', 'ATTACHES_TO', 'COREFERENCE_OF',
  'GENERATED_SKILL', 'DRIVES', 'ASSOCIATES'
];

/**
 * Parse argv into a structured call. Minimal, no external deps.
 */
function parseArgs(argv) {
  const out = { _: [], emit: null, pattern: null, flaw: null, meta: null, edges: [], stamp: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--emit') out.emit = argv[++i];
    else if (a === '--pattern') out.pattern = argv[++i];
    else if (a === '--flaw') out.flaw = argv[++i];
    else if (a === '--meta') out.meta = argv[++i];
    else if (a === '--edges') out.edges = argv[++i].split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--no-stamp') out.stamp = false;
    else if (a === '--help' || a === '-h') out.help = true;
    else out._.push(a);
  }
  return out;
}

/**
 * Validate edges against the 17 defined edge types in clawbrain.
 * Unknown edges become a warning rather than a failure â€” that's
 * the graceful path for new edge discoveries.
 */
function validateEdges(edges) {
  const known = new Set(VALID_EDGE_TYPES);
  const unknown = edges.filter(e => !known.has(e));
  if (unknown.length) {
    process.stderr.write(`[fractal-reason] WARN: unknown edge types: ${unknown.join(', ')}\n`);
    process.stderr.write(`[fractal-reason] known: ${VALID_EDGE_TYPES.join(', ')}\n`);
  }
  return edges.filter(e => known.has(e));
}

/**
 * Render the 4-level block as a markdown snippet.
 */
function renderMarkdown({ carryId, emit, pattern, flaw, meta, edges }) {
  const lines = [];
  lines.push(`### ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC â€” ${carryId} (closed)`);
  lines.push('');
  lines.push(`- **L0 â€” fix:** ${emit}`);
  if (pattern) lines.push(`- **L1 â€” pattern:** ${pattern}`);
  if (flaw) lines.push(`- **L2 â€” flaw:** ${flaw}`);
  if (meta) lines.push(`- **L3 â€” meta-rule:** ${meta}`);
  if (edges.length) {
    lines.push(`- **edges:** ${edges.map(e => `[${e}]`).join(' ')}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * Stamp lastFractalReason timestamp so the heartbeat can detect
 * "fractal-reason was used today" â€” the meta-rule for "every closure
 * gets the full 4-level breakdown" can be verified via this flag.
 */
function stamp(reasonText) {
  if (!existsSync(STATE_PATH)) {
    writeFileSync(STATE_PATH, JSON.stringify({
      lastFractalReason: null,
      count: 0,
      recent: []
    }, null, 2));
  }
  const state = JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  state.lastFractalReason = Date.now();
  state.count = (state.count || 0) + 1;
  state.recent = state.recent || [];
  state.recent.unshift({ ts: state.lastFractalReason, reason: reasonText.slice(0, 200) });
  state.recent = state.recent.slice(0, 10);
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * Main: render the block + stamp + print to stdout.
 */
function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.emit) {
    process.stdout.write(`Usage: node tools/fractal-reason.mjs "<carry-id>" --emit "<text>" [--pattern "<text>"] [--flaw "<text>"] [--meta "<text>"] [--edges "CAUSED_BY,LEADS_TO"] [--no-stamp]\n\nFractal Reasoning 4-level helper. Level 0 (emit) is required. Levels 1-3 + edges are optional but encouraged â€” closures without them miss the systemic fix.\n`);
    process.exit(args.emit ? 0 : 1);
  }
  const carryId = args._[0] || 'unnamed-carry';
  const edges = validateEdges(args.edges || []);
  const md = renderMarkdown({
    carryId,
    emit: args.emit,
    pattern: args.pattern,
    flaw: args.flaw,
    meta: args.meta,
    edges
  });
  if (args.stamp) {
    stamp(args.emit);
  }
  process.stdout.write(md);
}

main();