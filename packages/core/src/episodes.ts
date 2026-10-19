import { randomUUID } from "node:crypto";
import { getDb, bumpWriteCounter } from "./db.js";
import { executeWithWalRetrySync } from "./wal-retry.js";
import type { Episode } from "./types.js";

export function appendEpisode(
  agentId: string,
  sessionId: string,
  role: "user" | "assistant" | "tool",
  content: string,
  importance?: number,
  meta?: Record<string, unknown>,
  opts: {
    /** Provenance (v18): who is writing this episode. Defaults to `agentId`. */
    writerAgentId?: string;
  } = {},
): string {
  const db = getDb(agentId);
  const id = randomUUID();
  const now = Date.now();
  const imp = importance ?? scoreImportance(role, content);

  executeWithWalRetrySync(
    db,
    (d) => {
      d.prepare(`
        INSERT INTO episodes (id, session_id, role, content, importance, tokens, ripple_count, created_at, meta, writer_agent_id)
        VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      `).run(
        id, sessionId, role, content, imp, estimateTokens(content), now,
        meta ? JSON.stringify(meta) : null,
        opts.writerAgentId ?? agentId,
      );
    },
    { op: `episodes.write:${role}` },
  );
  bumpWriteCounter(db);

  return id;
}

export function getEpisodesSince(agentId: string, sinceMs: number, minImportance = 0.2): Episode[] {
  const db = getDb(agentId);
  return db.prepare(`
    SELECT * FROM episodes
    WHERE created_at > ? AND importance >= ?
    ORDER BY created_at ASC
  `).all(sinceMs, minImportance) as Episode[];
}

/**
 * Per-session summaries for the 24h activity recap.
 *
 * Groups episodes by session_id and returns one summary line per session,
 * with a relative timestamp and the first user message as a topic hint.
 * Ported from clawbrain-v4/src/episodes.ts to restore the wake-up recap layer
 * (openwave / xanima-core split, Task 2). Read-only; no schema change.
 */
export function getSessionSummaries(
  agentId: string,
  sinceMs: number,
  minImportance = 0.3,
  excludeSessionId?: string,
  maxSessions = 5,
): Array<{ sessionId: string; channel: string; ago: string; summary: string; latestAt: number }> {
  const db = getDb(agentId);

  interface SessionRow {
    session_id: string;
    first_user: string | null;
    last_assistant: string | null;
    latest_at: number;
    episode_count: number;
  }

  const rows = db.prepare(`
    SELECT
      session_id,
      MIN(CASE WHEN role = 'user' THEN content END) as first_user,
      MAX(CASE WHEN role = 'assistant' THEN content END) as last_assistant,
      MAX(created_at) as latest_at,
      COUNT(*) as episode_count
    FROM episodes
    WHERE created_at > ? AND importance >= ?
      AND (? IS NULL OR session_id != ?)
    GROUP BY session_id
    ORDER BY latest_at DESC
    LIMIT ?
  `).all(sinceMs, minImportance, excludeSessionId ?? null, excludeSessionId ?? null, maxSessions) as SessionRow[];

  return rows.map((r) => {
    const parts = r.session_id.split(":");
    const channel = parts[2] || parts[1] || "session";

    const ageMs = Date.now() - r.latest_at;
    const ago = ageMs < 3_600_000
      ? `${Math.round(ageMs / 60_000)}m ago`
      : ageMs < 86_400_000
        ? `${Math.round(ageMs / 3_600_000)}h ago`
        : `${Math.round(ageMs / 86_400_000)}d ago`;

    const topic = (r.first_user || r.last_assistant || "(no content)")
      .replace(/\s+/g, " ")
      .slice(0, 120)
      .trim();

    return {
      sessionId: r.session_id,
      channel,
      ago,
      summary: topic,
      latestAt: r.latest_at,
    };
  });
}

export function getEpisodeCount(agentId: string): number {
  const db = getDb(agentId);
  const row = db.prepare("SELECT COUNT(*) as n FROM episodes").get() as { n: number };
  return row.n;
}

export function getEpisodesByIds(agentId: string, ids: string[]): Episode[] {
  if (ids.length === 0) return [];
  const db = getDb(agentId);
  const placeholders = ids.map(() => "?").join(",");
  return db.prepare(
    `SELECT * FROM episodes WHERE id IN (${placeholders})`
  ).all(...ids) as Episode[];
}

/** The turns around one stored turn in its own session: `n` before and `n` after, oldest first. */
export function getTurnsAround(agentId: string, episodeId: string, n = 2): { turn: Episode; before: Episode[]; after: Episode[] } | null {
  const db = getDb(agentId);
  const turn = db.prepare("SELECT * FROM episodes WHERE id = ?").get(episodeId) as Episode | undefined;
  if (!turn) return null;
  const k = Math.max(0, Math.min(10, Math.floor(n)));
  if (k === 0) return { turn, before: [], after: [] };
  const before = (db.prepare(
    "SELECT * FROM episodes WHERE session_id = ? AND (created_at < ? OR (created_at = ? AND rowid < (SELECT rowid FROM episodes WHERE id = ?))) ORDER BY created_at DESC, rowid DESC LIMIT ?",
  ).all(turn.session_id, turn.created_at, turn.created_at, episodeId, k) as Episode[]).reverse();
  const after = db.prepare(
    "SELECT * FROM episodes WHERE session_id = ? AND (created_at > ? OR (created_at = ? AND rowid > (SELECT rowid FROM episodes WHERE id = ?))) ORDER BY created_at ASC, rowid ASC LIMIT ?",
  ).all(turn.session_id, turn.created_at, turn.created_at, episodeId, k) as Episode[];
  return { turn, before, after };
}

/**
 * Turns stored closest to a moment (for a memory that recorded no source turn,
 * e.g. one the agent wrote with brain_write mid-conversation): the `limit`
 * nearest episodes within `windowMs`, ordered by distance.
 */
export function getEpisodesNear(agentId: string, atMs: number, windowMs = 10 * 60_000, limit = 1): Episode[] {
  const db = getDb(agentId);
  return db.prepare(
    "SELECT * FROM episodes WHERE created_at BETWEEN ? AND ? ORDER BY ABS(created_at - ?) ASC LIMIT ?",
  ).all(atMs - windowMs, atMs + windowMs, atMs, limit) as Episode[];
}

/**
 * The conversation a memory came from, as text: for each recorded source turn
 * (nodes.episode_ids) the turn itself with `n` turns of context either side in
 * the same session; for a memory with no recorded source, the turns around the
 * moment it was written. Up to `maxSources` source turns, `perTurnChars` each.
 */
export function formatSourceTurns(
  agentId: string,
  node: { created_at: number; episode_ids?: string | null },
  n: number,
  o: { maxSources?: number; perTurnChars?: number } = {},
): string[] {
  const maxSources = o.maxSources ?? 3;
  const perTurn = o.perTurnChars ?? 600;
  let ids: string[] = [];
  try { ids = node.episode_ids ? (JSON.parse(node.episode_ids) as string[]) : []; } catch { ids = []; }
  const line = (e: Episode, mark: string) => {
    const ts = new Date(e.created_at).toISOString().slice(0, 16).replace("T", " ");
    const text = e.content.replace(/\s+/g, " ").trim();
    return `  ${mark} [${ts}] ${e.role}: ${text.length > perTurn ? `${text.slice(0, perTurn)}…` : text}`;
  };
  const out: string[] = [];
  const render = (t: { turn: Episode; before: Episode[]; after: Episode[] }, head: string) => {
    out.push(head);
    for (const e of t.before) out.push(line(e, " "));
    out.push(line(t.turn, "»"));
    for (const e of t.after) out.push(line(e, " "));
  };
  const seen = new Set<string>();
  for (const id of ids.slice(0, maxSources)) {
    const t = getTurnsAround(agentId, id, n);
    if (!t || seen.has(t.turn.id)) continue;
    seen.add(t.turn.id);
    render(t, `\nSource turn ${t.turn.id.slice(0, 8)} in session ${t.turn.session_id} (» = the turn this memory was distilled from; ±${n} turns):`);
  }
  if (out.length === 0) {
    const near = getEpisodesNear(agentId, node.created_at, 10 * 60_000, 1)[0];
    if (!near) return ["\nSource turns: none recorded, and no conversation stored within 10 minutes of when this memory was written."];
    const t = getTurnsAround(agentId, near.id, n);
    if (t) render(t, `\nNo source turn recorded for this memory; the conversation around when it was written (session ${t.turn.session_id}, » = nearest turn; ±${n} turns):`);
  }
  return out;
}

export function getRecentEpisodes(agentId: string, limit = 3): Episode[] {
  const db = getDb(agentId);
  return db.prepare(
    "SELECT * FROM episodes ORDER BY created_at DESC LIMIT ?"
  ).all(limit) as Episode[];
}

export function searchEpisodes(agentId: string, query: string, limit = 10): Episode[] {
  const db = getDb(agentId);
  try {
    const safe = query.replace(/"/g, "").trim();
    if (!safe) return [];
    return db.prepare(`
      SELECT e.* FROM episodes e
      JOIN episodes_fts f ON e.rowid = f.rowid
      WHERE episodes_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(`"${safe}"`, limit) as Episode[];
  } catch {
    return [];
  }
}

export function incrementEpisodeRipple(agentId: string, episodeId: string): void {
  const db = getDb(agentId);
  db.prepare(
    "UPDATE episodes SET ripple_count = ripple_count + 1 WHERE id = ?"
  ).run(episodeId);
}

export function scoreImportance(role: string, content: string): number {
  if (role === "tool") return 0.3;
  const lower = content.toLowerCase();
  if (role === "user" && /\b(remember|always|never|important|critical)\b/.test(lower)) return 0.85;
  const emotionWords = ["love", "hate", "excited", "worried", "happy", "sad", "frustrated", "proud", "angry"];
  if (emotionWords.some((w) => lower.includes(w))) return 0.75;
  if (content.length < 30) return 0.2;
  return 0.5;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
