import { randomUUID } from "node:crypto";
import { getDb, bumpWriteCounter } from "./db.js";
import { executeWithWalRetrySync } from "./wal-retry.js";
import type { BrainEdge, EdgeType } from "./types.js";

/**
 * Insert an active edge between two nodes.
 *
 * Self-loop guard (code-1 bonus / SYNTHESIS T1.6): a node may not have an edge
 * to itself. Self-loops break spreading-activation invariants (infinite
 * recursion on `from_id = to_id` traversal under the wrong query plan) and
 * historically appear as artifacts of `mergeCoreferentNodes` repointing edges
 * to the canonical id. We refuse the write and emit a structured warning so
 * the caller has a chance to fix the upstream bug instead of silently inserting
 * pathological data.
 *
 * Returns the new edge id on success, or empty string when the write was refused.
 */
export function writeEdge(
  agentId: string,
  fromId: string,
  toId: string,
  type: EdgeType,
  opts: {
    weight?: number;
    validFrom?: number;
    meta?: Record<string, unknown>;
  } = {},
): string {
  if (fromId === toId) {
    // Structured warning to stderr (no Logger threaded through writeEdge).
    // eslint-disable-next-line no-console
    console.warn(`[sharpwave] writeEdge: refused self-loop (agent=${agentId} id=${fromId} type=${type})`);
    return "";
  }

  const db = getDb(agentId);
  const id = randomUUID();
  const now = Date.now();

  executeWithWalRetrySync(
    db,
    (d) => {
      d.prepare(`
        INSERT INTO edges (id, from_id, to_id, type, weight, valid_from, valid_until, learned_at, created_at, meta)
        VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)
      `).run(
        id, fromId, toId, type,
        opts.weight ?? 1.0,
        opts.validFrom ?? now,
        now, now,
        opts.meta ? JSON.stringify(opts.meta) : null,
      );
    },
    { op: `edges.write:${type}` },
  );
  bumpWriteCounter(db);

  return id;
}

export function closeEdge(agentId: string, edgeId: string): void {
  const db = getDb(agentId);
  executeWithWalRetrySync(
    db,
    (d) => { d.prepare("UPDATE edges SET valid_until = ? WHERE id = ?").run(Date.now(), edgeId); },
    { op: `edges.close:${edgeId.slice(0, 8)}` },
  );
  bumpWriteCounter(db);
}

export function closeEdgesFromNode(agentId: string, nodeId: string, type?: EdgeType): void {
  const db = getDb(agentId);
  executeWithWalRetrySync(
    db,
    (d) => {
      if (type) {
        d.prepare(
          "UPDATE edges SET valid_until = ? WHERE from_id = ? AND type = ? AND valid_until IS NULL"
        ).run(Date.now(), nodeId, type);
      } else {
        d.prepare(
          "UPDATE edges SET valid_until = ? WHERE from_id = ? AND valid_until IS NULL"
        ).run(Date.now(), nodeId);
      }
    },
    { op: `edges.closeFrom:${nodeId.slice(0, 8)}` },
  );
  bumpWriteCounter(db);
}

export function closeEdgesToNode(agentId: string, nodeId: string): void {
  const db = getDb(agentId);
  executeWithWalRetrySync(
    db,
    (d) => {
      d.prepare(
        "UPDATE edges SET valid_until = ? WHERE to_id = ? AND valid_until IS NULL"
      ).run(Date.now(), nodeId);
    },
    { op: `edges.closeTo:${nodeId.slice(0, 8)}` },
  );
  bumpWriteCounter(db);
}

export function getActiveEdgesFrom(agentId: string, nodeId: string): BrainEdge[] {
  const db = getDb(agentId);
  return db.prepare(
    "SELECT * FROM edges WHERE from_id = ? AND valid_until IS NULL"
  ).all(nodeId) as BrainEdge[];
}

export function getInhibitedNodeIds(agentId: string, nodeId: string): string[] {
  const db = getDb(agentId);
  const rows = db.prepare(`
    SELECT to_id as node_id FROM edges WHERE from_id = ? AND type = 'inhibits' AND valid_until IS NULL
    UNION
    SELECT from_id as node_id FROM edges WHERE to_id = ? AND type = 'contradicts' AND valid_until IS NULL
  `).all(nodeId, nodeId) as Array<{ node_id: string }>;
  return rows.map((r) => r.node_id).filter(Boolean);
}

export function edgeExists(agentId: string, fromId: string, toId: string, type: EdgeType): boolean {
  const db = getDb(agentId);
  const row = db.prepare(
    "SELECT id FROM edges WHERE from_id = ? AND to_id = ? AND type = ? AND valid_until IS NULL LIMIT 1"
  ).get(fromId, toId, type);
  return !!row;
}

/**
 * Direction-agnostic existence check for SYMMETRIC edge types (`associates`).
 * Fable-5 audit F-8: autoLinkNode could write A→B when A's embedding drained
 * and B→A when B's drained later — getNeighbors unions both directions, so the
 * pair contributed two edges to fan-out shares and spreading activation
 * double-counted the association.
 */
export function edgeExistsEitherDirection(agentId: string, aId: string, bId: string, type: EdgeType): boolean {
  const db = getDb(agentId);
  const row = db.prepare(
    "SELECT id FROM edges WHERE type = ? AND valid_until IS NULL AND ((from_id = ? AND to_id = ?) OR (from_id = ? AND to_id = ?)) LIMIT 1"
  ).get(type, aId, bId, bId, aId);
  return !!row;
}

export function getEdge(agentId: string, id: string): BrainEdge | null {
  const db = getDb(agentId);
  return db.prepare("SELECT * FROM edges WHERE id = ?").get(id) as BrainEdge | null;
}
