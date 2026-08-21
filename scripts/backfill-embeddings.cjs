#!/usr/bin/env node
// scripts/backfill-embeddings.cjs
//
// Backfill embeddings for an existing sharpwave brain DB.
//
// What it does:
//   1. Scans `nodes` table for rows where `embedding IS NULL`
//   2. For each, fetches a fresh embedding from the configured provider
//      (Ollama by default at $OLLAMA_BASE_URL or http://localhost:11434)
//   3. Writes the vector into `nodes.embedding` (BLOB column)
//   4. Also writes into `nodes_vec` (sqlite-vec virtual table) so
//      vector similarity search actually works
//
// Idempotent: re-running skips nodes that already have embeddings.
//
// Usage:
//   node scripts/backfill-embeddings.js [agentId]
//   # defaults: agentId="mila", reads ~/.sharpwave/mila/brain.db
//
// Env vars:
//   OLLAMA_BASE_URL              default http://localhost:11434
//   SHARPWAVE_EMBEDDING_MODEL    default ollama/qwen3-embedding:0.6b
//   SHARPWAVE_HOME               default ~/.sharpwave

'use strict';

const path = require('path');
const fs = require('fs');

// sharpwave loads sqlite-vec through its own bundled better-sqlite3.
// Allow the script to run from anywhere by looking up sharpwave's node_modules.
function resolveSharpwaveModules() {
  try {
    const sharpwaveRoot = path.dirname(require.resolve('sharpwave/package.json'));
    return path.join(sharpwaveRoot, 'node_modules');
  } catch {
    return null;
  }
}

const sharpwaveNodeModules = resolveSharpwaveModules();
if (sharpwaveNodeModules) {
  module.paths.push(sharpwaveNodeModules);
  process.env.NODE_PATH = (process.env.NODE_PATH ? process.env.NODE_PATH + path.delimiter : '') + sharpwaveNodeModules;
  require('module').Module._initPaths();
}

let Database, sqliteVec;
try {
  Database = require('better-sqlite3');
  sqliteVec = require('sqlite-vec');
} catch (e) {
  console.error('Missing deps. Run `npm install` inside the sharpwave repo,');
  console.error('or set NODE_PATH to sharpwave\'s node_modules:');
  console.error('  export NODE_PATH="$(npm root -g)/sharpwave/node_modules"');
  console.error('Underlying error:', e.message);
  process.exit(2);
}

const agentId = process.argv[2] || 'mila';
const home = process.env.SHARPWAVE_HOME || path.join(process.env.USERPROFILE || process.env.HOME || `C:/Users/${process.env.USERNAME || 'User'}`, '.sharpwave');
const dbPath = path.join(home, agentId, 'brain.db');
const ollamaUrl = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
const model = process.env.SHARPWAVE_EMBEDDING_MODEL || 'ollama/qwen3-embedding:0.6b';
const TARGET_DIM = 1024; // qwen3-embedding:0.6b default; mismatch will be rejected

console.log('sharpwave backfill-embeddings');
console.log('  agent:      ', agentId);
console.log('  db:         ', dbPath);
console.log('  ollama url: ', ollamaUrl);
console.log('  model:      ', model);

if (!fs.existsSync(dbPath)) {
  console.error(`Brain DB not found at ${dbPath}. Set SHARPWAVE_HOME or pass a different agentId.`);
  process.exit(2);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

try { sqliteVec.load(db); }
catch (e) { console.warn('WARN: sqlite-vec failed to load — vector search will remain FTS-only:', e.message); }

async function fetchEmbedding(text) {
  const r = await fetch(`${ollamaUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: text.slice(0, 1000) }),
  });
  if (!r.ok) throw new Error(`ollama ${r.status}: ${await r.text()}`);
  const j = await r.json();
  if (!j.embedding || j.embedding.length !== TARGET_DIM) {
    throw new Error(`embedding dim mismatch: got ${j.embedding?.length}, expected ${TARGET_DIM}. Switched provider? See SETUP.md §6.`);
  }
  return j.embedding;
}

(async () => {
  const needEmbed = db.prepare(`SELECT id, rowid, label, content FROM nodes WHERE embedding IS NULL`).all();
  const needVec = db.prepare(`
    SELECT n.id, n.embedding FROM nodes n
    WHERE n.embedding IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM nodes_vec v WHERE v.rowid = n.rowid)
  `).all();

  console.log(`  nodes needing BLOB embedding: ${needEmbed.length}`);
  console.log(`  nodes needing vec-table insert: ${needVec.length}`);

  let embOk = 0, embFail = 0;
  for (const r of needEmbed) {
    try {
      const text = `${r.label}: ${r.content}`;
      const vec = await fetchEmbedding(text);
      db.prepare(`UPDATE nodes SET embedding = ? WHERE id = ?`)
        .run(Buffer.from(new Float32Array(vec).buffer), r.id);
      embOk++;
      if (embOk % 10 === 0) console.log(`    ...${embOk}/${needEmbed.length}`);
    } catch (e) {
      embFail++;
      console.error(`  FAIL ${r.id} (${r.label}):`, e.message);
    }
  }

  let vecOk = 0, vecFail = 0;
  for (const r of needVec) {
    try {
      // sqlite-vec requires INSERT...SELECT pattern when specifying rowid explicitly
      db.prepare(`INSERT OR REPLACE INTO nodes_vec(rowid, embedding) SELECT rowid, ? FROM nodes WHERE id = ?`)
        .run(r.embedding, r.id);
      vecOk++;
    } catch (e) {
      vecFail++;
      console.error(`  VEC FAIL ${r.id}:`, e.message);
    }
  }

  const summary = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN embedding IS NOT NULL THEN 1 ELSE 0 END) as embedded
    FROM nodes
  `).get();
  let vecTotal = null;
  try { vecTotal = db.prepare('SELECT COUNT(*) as n FROM nodes_vec').get().n; } catch {}

  console.log('');
  console.log('✓ done');
  console.log(`  BLOB embeddings: ${embOk} added, ${embFail} failed`);
  console.log(`  vec-table rows:  ${vecOk} added, ${vecFail} failed`);
  console.log(`  brain now: ${summary.embedded}/${summary.total} nodes have embeddings`);
  if (vecTotal !== null) console.log(`  nodes_vec rows:  ${vecTotal}`);
  console.log('');
  console.log('Verify with: brain_stats format=text   (look for Embeddings: X/Y (NN%))');

  db.close();
  process.exit(embFail + vecFail > 0 ? 1 : 0);
})().catch(e => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(1);
});