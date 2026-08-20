#!/usr/bin/env node
/**
 * tools/engram-sleep.mjs
 *
 * Memory consolidation digest tool â€” pattern ported from tinkerclaw's
 * scripts/engram-sleep.mjs (their "REM sleep" consolidation cron).
 *
 * Reads a daily memory log file (memory/YYYY-MM-DD.md) and extracts
 * candidate MEMORY.md entries based on recognized patterns:
 *   - ### ... (closed)      â†’ carry closure (L0-L3 lines + edges)
 *   - **ðŸ† Milestones**     â†’ milestone bullet lists
 *   - **ðŸ’¡ Lessons**        â†’ lesson bullet lists
 *   - [meta-rule: ...]      â†’ explicit meta-rule declarations
 *   - **edges:** [...]      â†’ brain edge chains
 *
 * Output is a markdown digest the user (me) reviews and selectively
 * pastes into MEMORY.md. NO auto-write â€” that's the safety boundary.
 * Manual review catches what automation would miss.
 *
 * Flags:
 *   --path <file>      target daily file (default: today's memory/YYYY-MM-DD.md)
 *   --since <date>     only extract sections with date >= since (ISO date)
 *   --kind <pattern>   filter to a single kind (closed|milestone|lesson|meta-rule|edge)
 *   --json             output as JSON for programmatic consumption
 *
 * Companion: tools/engram-sleep.spec.mjs (planned) â€” unit tests for pattern extraction.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PATTERNS = {
  closed: /^###\s+.*?\(closed\)/,
  milestone: /^\*\*ðŸ† Milestones\*\*/,
  lesson: /^\*\*ðŸ’¡ Lessons\*\*/,
  metaRule: /\[meta-rule:\s*([^\]]+)\]/,
  edge: /\*\*edges:\*\*\s+(.+)$/
};

function parseArgs(argv) {
  const out = { _: [], path: null, since: null, kind: null, json: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--path') out.path = argv[++i];
    else if (a === '--since') out.since = argv[++i];
    else if (a === '--kind') out.kind = argv[++i];
    else if (a === '--json') out.json = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else out._.push(a);
  }
  return out;
}

/**
 * Split a daily log into sections by `## Date â€” Title` or `### Date â€” Title` headers.
 * Returns array of { header, body, date } objects.
 */
function splitDaily(text) {
  const lines = text.split('\n');
  const sections = [];
  let current = null;
  for (const line of lines) {
    const headerMatch = line.match(/^(#{2,3})\s+(.+)$/);
    if (headerMatch) {
      if (current) sections.push(current);
      current = { header: line, level: headerMatch[1].length, body: [], meta: {} };
      const dateMatch = headerMatch[2].match(/(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) current.date = dateMatch[1];
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) sections.push(current);
  return sections;
}

/**
 * Classify a section by which patterns it matches.
 */
function classify(section) {
  const all = (section.header + '\n' + section.body.join('\n'));
  const kinds = [];
  if (PATTERNS.closed.test(section.header)) kinds.push('closed');
  if (PATTERNS.milestone.test(all)) kinds.push('milestone');
  if (PATTERNS.lesson.test(all)) kinds.push('lesson');
  if (PATTERNS.metaRule.test(all)) kinds.push('meta-rule');
  if (PATTERNS.edge.test(all)) kinds.push('edge');
  return kinds;
}

/**
 * Extract structured fields from a carry-closure section.
 * Looks for the fractal-reason.mjs format (L0/L1/L2/L3 + edges).
 */
function extractCarry(section) {
  const text = section.body.join('\n');
  const out = { header: section.header, date: section.date };
  const l0 = text.match(/\*\*L0 â€” fix:\*\*\s+(.+)/);
  const l1 = text.match(/\*\*L1 â€” pattern:\*\*\s+(.+)/);
  const l2 = text.match(/\*\*L2 â€” flaw:\*\*\s+(.+)/);
  const l3 = text.match(/\*\*L3 â€” meta-rule:\*\*\s+(.+)/);
  if (l0) out.l0 = l0[1].trim();
  if (l1) out.l1 = l1[1].trim();
  if (l2) out.l2 = l2[1].trim();
  if (l3) out.l3 = l3[1].trim();
  const metaRule = text.match(/\[meta-rule:\s*([^\]]+)\]/);
  if (metaRule) out.metaRule = metaRule[1].trim();
  const edges = text.match(/\*\*edges:\*\*\s+(.+)/);
  if (edges) out.edges = edges[1].trim();
  return out;
}

/**
 * Render a digest entry for a carry closure in MEMORY.md append format.
 */
function renderCarryMarkdown(c) {
  const lines = [];
  lines.push(`### ${c.date || 'unknown'} â€” ${c.header.replace(/^#+\s*/, '').replace(/\s*\(closed\)\s*/, '')}`);
  lines.push('');
  if (c.l0) lines.push(`- **L0 fix:** ${c.l0}`);
  if (c.l1) lines.push(`- **L1 pattern:** ${c.l1}`);
  if (c.l2) lines.push(`- **L2 flaw:** ${c.l2}`);
  if (c.l3) lines.push(`- **L3 meta-rule:** ${c.l3}`);
  if (c.metaRule) lines.push(`- **meta-rule:** ${c.metaRule}`);
  if (c.edges) lines.push(`- **edges:** ${c.edges}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Render a digest entry for a milestone/lesson bullet list.
 * Extracts the bullet points immediately following the header.
 */
function renderBulletsMarkdown(section, kind) {
  const lines = [];
  const title = section.header.replace(/^#+\s*/, '').trim();
  lines.push(`### ${title}`);
  lines.push('');
  // Pull bullets from body until we hit a non-bullet line or a sub-header
  const inBlock = section.body.findIndex(l => l.includes(`**${kind === 'milestone' ? 'ðŸ† Milestones' : 'ðŸ’¡ Lessons'}**`));
  if (inBlock >= 0) {
    for (let i = inBlock + 1; i < section.body.length; i++) {
      const line = section.body[i].trim();
      if (!line || line.startsWith('#') || line.startsWith('**')) break;
      if (line.startsWith('-') || line.startsWith('*')) {
        lines.push(line);
      }
    }
  }
  lines.push('');
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(`Usage: node tools/engram-sleep.mjs [flags]

Flags:
  --path <file>      target daily file (default: today's memory/YYYY-MM-DD.md)
  --since <date>     only extract sections with date >= since (ISO date)
  --kind <pattern>   filter: closed|milestone|lesson|meta-rule|edge
  --json             output as JSON

Extracts candidate MEMORY.md entries from a daily log. Manual review required.
`);
    process.exit(0);
  }
  const target = args.path
    ? resolve(args.path)
    : resolve(__dirname, '..', 'memory', `${new Date().toISOString().slice(0, 10)}.md`);
  if (!existsSync(target)) {
    process.stderr.write(`[engram-sleep] file not found: ${target}\n`);
    process.exit(1);
  }
  const text = readFileSync(target, 'utf8');
  const sections = splitDaily(text);
  const since = args.since ? new Date(args.since) : null;
  const kindFilter = args.kind;

  const digest = { sections: [] };
  for (const section of sections) {
    if (since && section.date && new Date(section.date) < since) continue;
    const kinds = classify(section);
    if (!kinds.length) continue;
    if (kindFilter && !kinds.includes(kindFilter)) continue;
    const entry = { kinds, header: section.header, date: section.date };
    if (kinds.includes('closed')) {
      entry.carry = extractCarry(section);
      entry.markdown = renderCarryMarkdown(entry.carry);
    } else if (kinds.includes('milestone')) {
      entry.markdown = renderBulletsMarkdown(section, 'milestone');
    } else if (kinds.includes('lesson')) {
      entry.markdown = renderBulletsMarkdown(section, 'lesson');
    } else {
      entry.markdown = section.body.join('\n').trim();
    }
    digest.sections.push(entry);
  }

  if (args.json) {
    process.stdout.write(JSON.stringify(digest, null, 2));
  } else {
    process.stdout.write(`# engram-sleep digest â€” ${target}\n`);
    process.stdout.write(`# extracted ${digest.sections.length} candidate entries\n\n`);
    for (const entry of digest.sections) {
      process.stdout.write(entry.markdown);
      process.stdout.write('\n---\n\n');
    }
  }
}

main();