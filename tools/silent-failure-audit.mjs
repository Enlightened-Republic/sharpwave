#!/usr/bin/env node
/**
 * tools/silent-failure-audit.mjs
 *
 * Linter for the silent-failure trio pattern (LRN-20260819-001).
 * Walks tools/*.mjs and flags catch blocks that swallow errors
 * via console.warn / console.log without throwing, surfacing,
 * or persisting state.
 *
 * Pattern flagged:
 *   } catch (e) {
 *     console.warn(...);    // silent â€” flagged
 *     console.log(...);     // silent â€” flagged
 *     // empty body          // silent â€” flagged
 *   }
 *
 * Pattern OK:
 *   } catch (e) {
 *     console.error(...);    // loud signal â€” OK
 *     throw e;               // re-throw â€” OK
 *     state.errors.push(...) // persist â€” OK
 *     process.exit(1)        // fatal â€” OK
 *   }
 *
 * Flags:
 *   --strict     treat console.log as silent (default: only console.warn + empty)
 *   --json       output as JSON
 *   --dir <path> scan a different directory (default: tools/)
 *
 * Companion: docs in .learnings/LRN-20260819-001-silent-failure-trio.md
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DEFAULT_DIR = resolve(__dirname, '..');

function parseArgs(argv) {
  const out = { _: [], strict: false, json: false, dir: null, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--strict') out.strict = true;
    else if (a === '--json') out.json = true;
    else if (a === '--dir') out.dir = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
    else out._.push(a);
  }
  return out;
}

function walkMjs(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) walkMjs(full, out);
    else if (entry.isFile() && /\.mjs$/.test(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Walk lines, tracking catch-block boundaries. Return array of
 * { lineStart, lineEnd, body } for each catch block found.
 */
function findCatchBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  let inCatch = false;
  let startLine = 0;
  let braceDepth = 0;
  let bodyLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inCatch) {
      // Look for `} catch (...)` or `catch (...)`
      if (/}\s*catch\s*\(/.test(line) || /^\s*catch\s*\(/.test(line)) {
        inCatch = true;
        startLine = i + 1;
        bodyLines = [line];
        // Count braces: opening starts at the catch's own `{`
        const opens = (line.match(/\{/g) || []).length;
        const closes = (line.match(/\}/g) || []).length;
        braceDepth = opens - closes;
        // If the catch opens AND closes on the same line (one-liner like `catch (e) { console.warn('x'); }`)
        if (braceDepth === 0 && opens > 0) {
          blocks.push({ lineStart: startLine, lineEnd: i + 1, body: bodyLines.join('\n') });
          inCatch = false;
        }
      }
    } else {
      bodyLines.push(line);
      const opens = (line.match(/\{/g) || []).length;
      const closes = (line.match(/\}/g) || []).length;
      braceDepth += opens - closes;
      if (braceDepth === 0) {
        blocks.push({ lineStart: startLine, lineEnd: i + 1, body: bodyLines.join('\n') });
        inCatch = false;
      }
    }
  }
  return blocks;
}

/**
 * Classify a catch body as silent or not.
 * Silent = contains console.warn (or console.log if --strict) and lacks:
 *   - throw
 *   - console.error
 *   - process.exit
 *   - state mutation (state.X = ...)
 */
function classifyCatch(body, strict) {
  const hasThrow = /\bthrow\s/.test(body);
  const hasConsoleError = /console\.error/.test(body);
  const hasProcessExit = /process\.exit/.test(body);
  const hasStateMutation = /\bstate\.\w+\s*=/.test(body) || /state\.errors\.push/.test(body);
  const hasConsoleWarn = /console\.warn/.test(body);
  const hasConsoleLog = /console\.log/.test(body);

  // Empty body check (just `catch (e) { }` or `catch (e) {\n}`)
  const stripped = body.replace(/\s+/g, '');
  const isEmpty = /catch\([^)]*\)\{\}/.test(stripped);

  if (isEmpty) return { kind: 'empty', reason: 'catch body is empty â€” error completely swallowed' };
  if (hasThrow || hasConsoleError || hasProcessExit || hasStateMutation) return null;
  if (hasConsoleWarn) return { kind: 'silent-warn', reason: 'console.warn + continue â€” error logged but not surfaced (LRN-20260819-001)' };
  if (strict && hasConsoleLog) return { kind: 'silent-log', reason: 'console.log + continue (strict mode)' };
  // If we got here, the catch has some logic but no throw/error/exit/mutation. Likely a deliberate handler.
  return null;
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(`Usage: node tools/silent-failure-audit.mjs [flags]

Flags:
  --strict      treat console.log as silent (default: only console.warn + empty)
  --json        output as JSON
  --dir <path>  scan a different directory (default: workspace root, recurses into tools/)

LRN-20260819-001 enforcer. Flags silent catch blocks per the pattern.
`);
    process.exit(0);
  }
  const scanRoot = args.dir ? resolve(args.dir) : DEFAULT_DIR;
  const files = walkMjs(scanRoot);
  const report = [];
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    const blocks = findCatchBlocks(text);
    const findings = [];
    for (const block of blocks) {
      const verdict = classifyCatch(block.body, args.strict);
      if (verdict) {
        findings.push({ lineStart: block.lineStart, lineEnd: block.lineEnd, ...verdict });
      }
    }
    if (findings.length) {
      report.push({ file: relative(DEFAULT_DIR, f), findings });
    }
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(report, null, 2));
  } else if (!report.length) {
    process.stdout.write(`âœ… no silent failures found across ${files.length} .mjs files in ${relative(DEFAULT_DIR, scanRoot) || '.'}\n`);
  } else {
    process.stdout.write(`# silent-failure-audit â€” ${report.length} files with findings (${files.length} scanned)\n\n`);
    for (const r of report) {
      process.stdout.write(`## ${r.file}\n`);
      for (const f of r.findings) {
        process.stdout.write(`- lines ${f.lineStart}-${f.lineEnd}: **${f.kind}** â€” ${f.reason}\n`);
      }
      process.stdout.write('\n');
    }
    process.exit(1);
  }
}

main();