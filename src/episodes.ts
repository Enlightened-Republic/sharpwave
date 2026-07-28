import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import type { Episode } from "./types.js";

export function appendEpisode(
  agentId: string,
  sessionId: string,
  role: "user" | "assistant" | "tool",
  content: string,
  importance?: number,
  meta?: Record<string, unknown>,
): string {
  const db = getDb(agentId);
  const id = randomUUID();
  const now = Date.now();
  const imp = importance ?? scoreImportance(role, content);

  db.prepare(`
    INSERT INTO episodes (id, session_id, role, content, importance, tokens, ripple_count, created_at, meta)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(id, sessionId, role, content, imp, estimateTokens(content), now, meta ? JSON.stringify(meta) : null);

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
