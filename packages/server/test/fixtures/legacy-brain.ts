// Generate a synthetic pre-v18 ("legacy", schema 17) brain.db, the shape a
// sharpwave MCP / OpenWave local-mode brain has before the service opens it:
// no writer_agent_id columns, schema_version = 17, and (optionally) part of
// the data only in the -wal (not yet checkpointed into brain.db).
//
// Built with sharpwave-core's own schema (getDb in a throwaway data dir), then
// downgraded: drop the v18 index + columns, set schema_version 17. Content is
// synthetic — no real memory text.

import Database from "better-sqlite3";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "sharpwave-core";

export interface LegacyBrainSpec {
  nodes: number;
  edges: number;
  episodes: number;
  /** Extra rows written but left ONLY in the WAL of the copied files. */
  walNodes?: number;
  walEpisodes?: number;
}

export const marker = (i: number) => `legacy-fixture-content-${i}`;

let seq = 0;

/** Create `<dir>/brain.db` (+ `-wal` when walNodes/walEpisodes > 0). Returns totals. */
export function makeLegacyBrain(dir: string, spec: LegacyBrainSpec): { nodes: number; edges: number; episodes: number } {
  const work = mkdtempSync(join(tmpdir(), "sw-legacy-gen-"));
  const agent = `gen-${process.pid}-${++seq}`;
  const prevDir = process.env["SHARPWAVE_DATA_DIR"];
  process.env["SHARPWAVE_DATA_DIR"] = work;
  try {
    const db = getDb(agent);
    const now = Date.now();
    const insNode = db.prepare("INSERT INTO nodes (id, type, label, content, created_at, accessed_at, updated_at) VALUES (?, 'semantic', ?, ?, ?, ?, ?)");
    const insEdge = db.prepare("INSERT INTO edges (id, from_id, to_id, type, valid_from, learned_at, created_at) VALUES (?, ?, ?, 'related_to', ?, ?, ?)");
    const insEp = db.prepare("INSERT INTO episodes (id, session_id, role, content, created_at) VALUES (?, 'sess-legacy', 'user', ?, ?)");
    db.transaction(() => {
      for (let i = 0; i < spec.nodes; i++) insNode.run(`n${i}`, `legacy fact ${i}`, `${marker(i)} about zebra${i}`, now - i, now, now);
      for (let i = 0; i < spec.edges; i++) insEdge.run(`e${i}`, `n${i % spec.nodes}`, `n${(i + 1) % spec.nodes}`, now, now, now);
      for (let i = 0; i < spec.episodes; i++) insEp.run(`ep${i}`, `legacy episode ${i} kumquat`, now - i);
    })();
    db.exec("DROP INDEX IF EXISTS nodes_writer_agent");
    for (const t of ["nodes", "edges", "episodes"]) db.exec(`ALTER TABLE ${t} DROP COLUMN writer_agent_id`);
    db.exec("DELETE FROM schema_version; INSERT INTO schema_version VALUES (17);");
    db.pragma("wal_checkpoint(TRUNCATE)");
    closeDb(agent);

    const file = join(work, agent, "brain.db");
    mkdirSync(dir, { recursive: true });
    const walNodes = spec.walNodes ?? 0;
    const walEpisodes = spec.walEpisodes ?? 0;
    if (walNodes + walEpisodes > 0) {
      // Keep a writer open with autocheckpoint off so the extra rows live only
      // in the -wal, then copy db + wal while it is still open.
      const w = new Database(file);
      w.pragma("journal_mode = WAL");
      w.pragma("wal_autocheckpoint = 0");
      const t = Date.now();
      w.transaction(() => {
        for (let i = 0; i < walNodes; i++) {
          w.prepare("INSERT INTO nodes (id, type, label, content, created_at, accessed_at, updated_at) VALUES (?, 'semantic', ?, ?, ?, ?, ?)")
            .run(`w${i}`, `wal fact ${i}`, `${marker(100_000 + i)} wal-only`, t, t, t);
        }
        for (let i = 0; i < walEpisodes; i++) {
          w.prepare("INSERT INTO episodes (id, session_id, role, content, created_at) VALUES (?, 'sess-legacy', 'assistant', ?, ?)")
            .run(`wep${i}`, `wal episode ${i}`, t);
        }
      })();
      copyFileSync(file, join(dir, "brain.db"));
      copyFileSync(`${file}-wal`, join(dir, "brain.db-wal"));
      w.close();
    } else {
      copyFileSync(file, join(dir, "brain.db"));
    }
    if (!existsSync(join(dir, "brain.db"))) throw new Error("fixture not written");
    return { nodes: spec.nodes + walNodes, edges: spec.edges, episodes: spec.episodes + walEpisodes };
  } finally {
    if (prevDir === undefined) delete process.env["SHARPWAVE_DATA_DIR"]; else process.env["SHARPWAVE_DATA_DIR"] = prevDir;
    rmSync(work, { recursive: true, force: true });
  }
}
