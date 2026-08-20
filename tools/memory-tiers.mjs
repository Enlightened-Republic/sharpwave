#!/usr/bin/env node
/**
 * tools/memory-tiers.mjs
 *
 * 5-tier compression lifecycle for MEMORY.md sections â€” pattern lifted
 * from neural-memory (nhadaututtheky/neural-memory). Replaces manual
 * MEMORY.md trim with auto-degradation based on age + access count.
 *
 * Tiers (per section):
 *   full      â†’ original text, all detail preserved
 *   summary   â†’ first paragraph or ~2 sentences
 *   essence   â†’ first phrase / key noun
 *   ghost     â†’ section header + reference link only
 *   metadata  â†’ section title preserved in TOC only, body deleted
 *
 * Each section's tier + access metadata lives in an HTML-comment header:
 *   <!-- tier:full accessed:5 last:2026-08-15 -->
 *   # Section title
 *   ...content...
 *
 * Downgrade rule: if (now - lastAccessed days) > THRESHOLD AND
 *                 accessCount < ACCESS_MAX â†’ drop one tier.
 *
 * Flags:
 *   --dry-run            preview changes, don't write
 *   --apply              write the downgraded file
 *   --path <file>        which MEMORY.md (default: ../memory/2026-08-19.md for daily, or MEMORY.md for long-term)
 *   --threshold-days N   age gate (default 30)
 *   --access-max N       access gate (default 3)
 *   --tier <name>        force-set a section's tier (manual override)
 *   --section <title>    target a specific section by title (with --tier)
 *   --list               list all sections + their current tiers + would-downgrade bool
 *
 * Companion: tools/memory-tiers.spec.mjs (planned) â€” unit tests for tier transition logic.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TIER_ORDER = ['full', 'summary', 'essence', 'ghost', 'metadata'];
const TIER_DOWNGRADE = {
  full: 'summary',
  summary: 'essence',
  essence: 'ghost',
  ghost: 'metadata',
  metadata: 'metadata' // already at the bottom
};

function parseArgs(argv) {
  const out = {
    _: [],
    dryRun: false,
    apply: false,
    path: null,
    thresholdDays: 30,
    accessMax: 3,
    tier: null,
    section: null,
    list: false,
    help: false
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--apply') out.apply = true;
    else if (a === '--path') out.path = argv[++i];
    else if (a === '--threshold-days') out.thresholdDays = parseInt(argv[++i], 10);
    else if (a === '--access-max') out.accessMax = parseInt(argv[++i], 10);
    else if (a === '--tier') out.tier = argv[++i];
    else if (a === '--section') out.section = argv[++i];
    else if (a === '--list') out.list = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else out._.push(a);
  }
  return out;
}

/**
 * Parse a tier metadata comment line.
 * Format: <!-- tier:full accessed:5 last:2026-08-15 -->
 * Returns { tier, accessed, last } or null if malformed.
 */
function parseMetaLine(line) {
  const m = line.match(/<!--\s*tier:(\w+)\s+accessed:(\d+)\s+last:([\d-]+)\s*-->/);
  if (!m) return null;
  return { tier: m[1], accessed: parseInt(m[2], 10), last: m[3] };
}

/**
 * Format a tier metadata comment line.
 */
function formatMetaLine({ tier, accessed, last }) {
  return `<!-- tier:${tier} accessed:${accessed} last:${last} -->`;
}

/**
 * Walk the markdown and return sections with metadata + content.
 * Section = (metaLine | null) + header line + body lines until next header/meta.
 */
function splitSections(text) {
  const lines = text.split('\n');
  const sections = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const meta = parseMetaLine(line);
    const isHeader = /^#{1,6}\s+/.test(line);
    if (meta || isHeader) {
      if (current) sections.push(current);
      current = {
        meta: meta ? { tier: meta.tier, accessed: meta.accessed, last: meta.last } : null,
        header: isHeader ? line : null,
        body: []
      };
      // If meta was on its own line, the header comes next.
      if (meta && i + 1 < lines.length && /^#{1,6}\s+/.test(lines[i + 1])) {
        current.header = lines[++i];
      }
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) sections.push(current);
  return sections;
}

/**
 * Decide whether a section should be downgraded based on age + access.
 */
function shouldDowngrade(section, thresholdDays, accessMax, now = new Date()) {
  if (!section.meta) return false;
  const lastDate = new Date(section.meta.last);
  const ageDays = (now - lastDate) / (1000 * 60 * 60 * 24);
  return ageDays > thresholdDays && section.meta.accessed < accessMax;
}

/**
 * Compress a section's body to the target tier.
 * No LLM call â€” uses structural reduction:
 *   full â†’ summary: first paragraph (until blank line) or first 2 sentences
 *   summary â†’ essence: first phrase (up to first colon or 60 chars)
 *   essence â†’ ghost: section header only (body deleted)
 *   ghost â†’ metadata: section header only, marked as metadata
 */
function compressBody(body, fromTier, toTier) {
  const text = body.join('\n').trim();
  if (toTier === 'summary') {
    // First paragraph or first 2 sentences, max 500 chars
    const firstPara = text.split(/\n\s*\n/)[0] || text;
    const truncated = firstPara.length > 500 ? firstPara.slice(0, 500) + 'â€¦' : firstPara;
    return truncated;
  }
  if (toTier === 'essence') {
    // First phrase (up to first period, colon, or 80 chars)
    const stop = text.search(/[.:]/);
    const phrase = stop > 0 && stop < 80 ? text.slice(0, stop + 1) : text.slice(0, 80);
    return phrase + (text.length > phrase.length ? 'â€¦' : '');
  }
  if (toTier === 'ghost' || toTier === 'metadata') {
    // Body deleted entirely; only header survives
    return '';
  }
  return text;
}

/**
 * Reassemble sections into a full markdown document.
 */
function reassemble(sections) {
  const out = [];
  for (const s of sections) {
    if (s.meta) out.push(formatMetaLine(s.meta));
    if (s.header) out.push(s.header);
    if (s.body.length) {
      // Trim trailing empty lines from body
      while (s.body.length && s.body[s.body.length - 1].trim() === '') s.body.pop();
      out.push(...s.body);
      out.push('');
    } else if (s.header) {
      out.push('');
    }
  }
  return out.join('\n');
}

/**
 * Track an access: bump accessed count + update last date.
 * (Future: integrate with brain_query access log.)
 */
function bumpAccess(meta) {
  if (!meta) return;
  meta.accessed = (meta.accessed || 0) + 1;
  meta.last = new Date().toISOString().slice(0, 10);
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    process.stdout.write(`Usage: node tools/memory-tiers.mjs [flags]

Flags:
  --dry-run              preview changes, don't write
  --apply                write the downgraded file
  --path <file>          target MEMORY.md path (default: ../MEMORY.md)
  --threshold-days N     age gate (default 30)
  --access-max N         access gate (default 3)
  --tier <name>          force-set tier for a section
  --section <title>      target section by title (with --tier)
  --list                 list all sections + tiers + would-downgrade

5-tier lifecycle: full â†’ summary â†’ essence â†’ ghost â†’ metadata
Pattern lifted from neural-memory. Compression is structural (no LLM call).
`);
    process.exit(0);
  }
  const targetPath = args.path
    ? resolve(args.path)
    : resolve(__dirname, '..', 'MEMORY.md');
  if (!existsSync(targetPath)) {
    process.stderr.write(`[memory-tiers] file not found: ${targetPath}\n`);
    process.exit(1);
  }
  const original = readFileSync(targetPath, 'utf8');
  const sections = splitSections(original);

  if (args.list) {
    process.stdout.write(`# sections in ${targetPath}\n\n`);
    for (const s of sections) {
      const header = s.header || '(no header)';
      const tier = s.meta ? s.meta.tier : '(untracked)';
      const wouldDowngrade = shouldDowngrade(s, args.thresholdDays, args.accessMax);
      process.stdout.write(`- [${tier}]${wouldDowngrade ? ' â¬‡ï¸' : ''} ${header}\n`);
    }
    process.exit(0);
  }

  // Manual tier override
  if (args.tier && args.section) {
    const target = sections.find(s => s.header && s.header.includes(args.section));
    if (!target) {
      process.stderr.write(`[memory-tiers] section not found: ${args.section}\n`);
      process.exit(1);
    }
    if (!target.meta) target.meta = { tier: 'full', accessed: 0, last: new Date().toISOString().slice(0, 10) };
    target.meta.tier = args.tier;
    target.meta.last = new Date().toISOString().slice(0, 10);
    const out = reassemble(sections);
    if (args.dryRun) {
      process.stdout.write(`# would set [${args.section}] to tier:${args.tier}\n\n`);
      process.stdout.write(out);
    } else {
      writeFileSync(targetPath, out);
      process.stdout.write(`[memory-tiers] set [${args.section}] to tier:${args.tier}\n`);
    }
    process.exit(0);
  }

  // Auto-downgrade pass
  let downgradeCount = 0;
  for (const s of sections) {
    if (!s.meta) continue;
    if (shouldDowngrade(s, args.thresholdDays, args.accessMax)) {
      const newTier = TIER_DOWNGRADE[s.meta.tier] || s.meta.tier;
      if (newTier !== s.meta.tier) {
        process.stdout.write(`[memory-tiers] â¬‡ï¸  ${s.header || '(no header)'}: ${s.meta.tier} â†’ ${newTier}\n`);
        s.meta.tier = newTier;
        s.body = compressBody(s.body, s.meta.tier, newTier).split('\n');
        downgradeCount++;
      }
    }
  }

  if (downgradeCount === 0) {
    process.stdout.write(`[memory-tiers] no sections qualified for downgrade (threshold=${args.thresholdDays}d, access-max=${args.accessMax}).\n`);
  }

  const out = reassemble(sections);
  if (args.dryRun) {
    process.stdout.write(`\n# --- DRY RUN: ${targetPath} ---\n\n`);
    process.stdout.write(out);
  } else if (args.apply) {
    writeFileSync(targetPath, out);
    process.stdout.write(`[memory-tiers] applied ${downgradeCount} downgrades to ${targetPath}\n`);
  } else {
    process.stdout.write(`\n[memory-tiers] use --apply to write changes, or --dry-run to preview.\n`);
  }
}

main();