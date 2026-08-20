#!/usr/bin/env node
/**
 * tools/apply-fork-patch.mjs
 *
 * Demonstrates the patch-function architecture from tinkerclaw's
 * apply-fork-wiring.mjs (23 patches that survive upstream merges via
 * 6-layer resolution cascade).
 *
 * Each patch is { name, description, file, find, replace } â€” atomic + verifiable.
 * Idempotent: if the replace string is already present, skip silently.
 * If the find string is missing, report the patch as stale (upstream changed).
 *
 * Flags:
 *   --list                list all patches
 *   --apply <name>        apply one patch
 *   --audit               report which patches would apply cleanly vs stale
 *   --target <file>       target file (default: tools/heartbeat/stamp-rotations.mjs)
 *   --dry-run             preview without writing
 *
 * Architecture reference: tinkerclaw apply-fork-wiring.mjs (23 patches) +
 * FORK_PATCHES.md (the registry this tool emulates at single-file scale).
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PATCHES = [
  {
    name: 'add-fractal-hook-marker',
    description: 'Adds a fractal hook marker comment near the stamper entrypoint (mirrors tinkerclaw hasFractalHook in src/infra/heartbeat-runner.ts)',
    file: 'tools/heartbeat/stamp-rotations.mjs',
    find: '// Heartbeat rotation stamper',
    replace: `// Heartbeat rotation stamper â€” refreshes the 9 lastRotation fields + memReview + lastBeat.
// hasFractalHook: true â€” fractal closure spec lives at tools/fractal-reason.mjs;
// brain-link bridge at tools/brain-link-bridge.mjs.`,
  },
  {
    name: 'add-context-size-snapshot-tracker',
    description: 'Adds a tools/context-size.mjs invocation to the stamper end (LRN-20260819-002 â€” byte-budget visibility in heartbeat)',
    file: 'tools/heartbeat/stamp-rotations.mjs',
    find: `console.log('memReview fired:', memReviewFired);`,
    replace: `console.log('memReview fired:', memReviewFired);
// LRN-20260819-002: log workspace byte-budget snapshot at end of stamper pass.
try { const { execSync } = require('node:child_process'); execSync('node tools/context-size.mjs --threshold 50 --no-snapshot --top 5', { cwd: 'C:/Users/wubbu/.openclaw/workspace', stdio: 'pipe' }); } catch (e) { console.error('context-size tracker failed:', e.message); }`,
  },
  {
    name: 'add-brain-link-bridge-call',
    description: 'Wires brain-link-bridge.mjs into the stamper end (fires brain_write + brain_link on every memReview consolidation)',
    file: 'tools/heartbeat/stamp-rotations.mjs',
    find: `console.log('WROTE', STATE_PATH);`,
    replace: `console.log('WROTE', STATE_PATH);
// Tier 2 #2: emit brain-link-bridge spec after stamper pass.
try { const { execSync } = require('node:child_process'); execSync('node tools/brain-link-bridge.mjs stamper-pass --emit "stamper pass fired \${fireCount} rotations, memReviewFired=\${memReviewFired}" --pattern "stamper pass completed without error" --meta "every stamper pass should land a carry closure in the brain graph" --edges "DRIVES,SUPPORTS"', { cwd: 'C:/Users/wubbu/.openclaw/workspace', stdio: 'pipe' }); } catch (e) { console.error('brain-link-bridge failed:', e.message); }`,
  },
];

function parseArgs(argv) {
  const out = { list: false, apply: null, audit: false, target: null, dryRun: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') out.list = true;
    else if (a === '--apply') out.apply = argv[++i];
    else if (a === '--audit') out.audit = true;
    else if (a === '--target') out.target = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function applyPatch(text, patch) {
  // Idempotency check: if replace string present, skip.
  if (text.includes(patch.replace)) {
    return { status: 'already-applied', reason: 'replace string already in file' };
  }
  if (!text.includes(patch.find)) {
    return { status: 'stale', reason: 'find string not found (upstream may have changed or patch never applied)' };
  }
  return { status: 'would-apply', text: text.replace(patch.find, patch.replace) };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(`Usage: node tools/apply-fork-patch.mjs [flags]

Flags:
  --list              list all patches
  --apply <name>      apply one patch
  --audit             report which patches would apply cleanly vs stale
  --target <file>     target file (default: tools/heartbeat/stamp-rotations.mjs)
  --dry-run           preview without writing

Architecture from tinkerclaw apply-fork-wiring.mjs (23 patches).
Each patch = { find, replace } â€” atomic + idempotent.
`);
    process.exit(0);
  }

  if (args.list) {
    process.stdout.write(`# apply-fork-patch â€” patch registry (${PATCHES.length} patches)\n\n`);
    for (const p of PATCHES) {
      process.stdout.write(`## ${p.name}\n`);
      process.stdout.write(`- file: ${p.file}\n`);
      process.stdout.write(`- description: ${p.description}\n\n`);
    }
    return;
  }

  const targetPath = args.target
    ? resolve(args.target)
    : resolve(__dirname, 'heartbeat', 'stamp-rotations.mjs');

  if (!existsSync(targetPath)) {
    process.stderr.write(`[apply-fork-patch] target not found: ${targetPath}\n`);
    process.exit(1);
  }

  const text = readFileSync(targetPath, 'utf8');

  if (args.audit) {
    process.stdout.write(`# audit â€” ${targetPath}\n\n`);
    for (const p of PATCHES) {
      const r = applyPatch(text, p);
      const sym = r.status === 'already-applied' ? 'âœ“' : r.status === 'would-apply' ? '+' : 'âœ—';
      process.stdout.write(`${sym} ${p.name}: ${r.status} â€” ${r.reason}\n`);
    }
    return;
  }

  if (args.apply) {
    const patch = PATCHES.find(p => p.name === args.apply);
    if (!patch) {
      process.stderr.write(`[apply-fork-patch] no patch named '${args.apply}'\n`);
      process.exit(1);
    }
    const r = applyPatch(text, patch);
    if (r.status === 'would-apply') {
      if (args.dryRun) {
        process.stdout.write(`[dry-run] would apply ${patch.name}\n`);
      } else {
        writeFileSync(targetPath, r.text, 'utf8');
        process.stdout.write(`âœ“ applied ${patch.name}\n`);
      }
    } else {
      process.stdout.write(`âŠ˜ ${patch.name}: ${r.reason}\n`);
    }
  } else {
    process.stdout.write(`[apply-fork-patch] specify --list, --audit, or --apply <name>\n`);
    process.exit(1);
  }
}

main();