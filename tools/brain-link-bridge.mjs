#!/usr/bin/env node
/**
 * tools/brain-link-bridge.mjs
 *
 * Bridges a fractal-reason.mjs carry closure into ClawBrain v4.
 * Takes the same args (--emit, --pattern, --flaw, --meta, --edges, --carry-id)
 * and emits the brain_write + brain_link command sequence needed to persist
 * the carry as a semantic node with explicit multi-hop edge types.
 *
 * Default --dry-run emits a JSON spec to stdout for the agent or stamper
 * to pick up. --fire requires the brain MCP bridge to be wired (currently
 * not â€” prints a no-op warning and still emits the spec).
 *
 * Edge types all link the carry node to a single sentinel node
 * `marley-self-corrections-sentinel`. The edge type carries the semantic
 * meaning; the sentinel is just a hub for the carry graph.
 *
 * Usage:
 *   node tools/brain-link-bridge.mjs <carry-id> --emit "<text>" [options]
 *   # then either: agent invokes brain_write + brain_link manually, OR
 *   # stamper picks up the spec from a known location + fires
 *
 * Companion: tools/fractal-reason.mjs (produces the markdown this consumes).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const VALID_EDGE_TYPES = new Set([
  'CAUSED_BY', 'LEADS_TO', 'RESOLVED_BY', 'CONTRADICTS', 'SUGGESTS',
  'INHIBITS', 'BEFORE', 'AFTER', 'INSTANCE_OF', 'GOAL_OF',
  'SUPPORTS', 'SUMMARIZES', 'ATTACHES_TO', 'COREFERENCE_OF',
  'GENERATED_SKILL', 'DRIVES', 'ASSOCIATES'
]);

const SENTINEL_NODE = 'marley-self-corrections-sentinel';

function parseArgs(argv) {
  const out = { _: [], emit: null, pattern: null, flaw: null, meta: null, edges: [], fire: false, carryId: null, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--emit') out.emit = argv[++i];
    else if (a === '--pattern') out.pattern = argv[++i];
    else if (a === '--flaw') out.flaw = argv[++i];
    else if (a === '--meta') out.meta = argv[++i];
    else if (a === '--edges') out.edges = argv[++i].split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
    else if (a === '--fire') out.fire = true;
    else if (a === '--carry-id') out.carryId = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function buildWriteCall(carryId, args) {
  const lines = [
    `L0 fix: ${args.emit}`,
    args.pattern ? `L1 pattern: ${args.pattern}` : null,
    args.flaw ? `L2 flaw: ${args.flaw}` : null,
    args.meta ? `L3 meta-rule: ${args.meta}` : null,
  ].filter(Boolean);
  return {
    tool: 'brain_write',
    args: {
      type: 'semantic',
      label: `carry:${carryId}`,
      content: lines.join('\n'),
      importance: args.meta ? 0.8 : 0.5,
      emotional_weight: args.flaw ? -0.2 : 0.1,
    },
    expected_return: 'node_id (string)',
  };
}

function buildLinkCalls(carryNodeId, edges) {
  const valid = edges.filter(e => VALID_EDGE_TYPES.has(e));
  const invalid = edges.filter(e => !VALID_EDGE_TYPES.has(e));
  if (invalid.length) process.stderr.write(`[brain-link-bridge] WARN: unknown edge types dropped: ${invalid.join(', ')}\n`);
  return valid.map(edge => ({
    tool: 'brain_link',
    args: {
      from_id: carryNodeId, // resolved after brain_write returns
      to_id: SENTINEL_NODE,
      edge_type: edge,
      weight: 0.7,
    },
  }));
}

function stampState(carryId, edgeCount, mode) {
  const statePath = resolve(__dirname, '..', 'memory', 'brain-bridge-state.json');
  let state = { count: 0, recent: [] };
  if (existsSync(statePath)) {
    try { state = JSON.parse(readFileSync(statePath, 'utf8')); } catch {}
  }
  state.count = (state.count || 0) + 1;
  state.last = { ts: Date.now(), carryId, edgeCount, mode };
  state.recent = (state.recent || []).slice(0, 9);
  state.recent.unshift(state.last);
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.emit) {
    process.stdout.write(`Usage: node tools/brain-link-bridge.mjs <carry-id> --emit "<text>" [options]

Options:
  --emit "<text>"        L0 fix (required)
  --pattern "<text>"     L1 pattern
  --flaw "<text>"        L2 flaw
  --meta "<text>"        L3 meta-rule
  --edges "E1,E2,E3"     explicit edge types (CAUSED_BY, LEADS_TO, etc.)
  --carry-id <id>        explicit carry id (positional otherwise)
  --fire                 fire via brain MCP bridge (currently no-op â€” emits dry-run spec)

Bridges a fractal-reason.mjs carry closure into ClawBrain v4.
Default emits a JSON spec with brain_write + brain_link calls.
Edge types link the carry node to a single sentinel 'marley-self-corrections-sentinel'.
`);
    process.exit(args.emit ? 0 : 1);
  }
  const carryId = args.carryId || args._[0] || 'unnamed-carry';
  const writeCall = buildWriteCall(carryId, args);
  const linkCalls = buildLinkCalls(`<<resolved-by-brain_write>>`, args.edges);

  const spec = {
    ts: new Date().toISOString(),
    carry: { id: carryId, writeCall, linkCalls, sentinel: SENTINEL_NODE },
  };

  if (args.fire) {
    process.stderr.write(`[brain-link-bridge] --fire requested but brain MCP bridge not wired.\n`);
    process.stderr.write(`[brain-link-bridge] emitting dry-run spec for agent invocation:\n\n`);
  }

  process.stdout.write(JSON.stringify(spec, null, 2) + '\n');
  stampState(carryId, linkCalls.length, args.fire ? 'fire' : 'dry-run');
}

main();