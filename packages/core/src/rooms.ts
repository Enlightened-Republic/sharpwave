// packages/core/src/rooms.ts
//
// Xanima 0.5.0 — rooms (the context bus).
//
// A room is a named namespace with members. Each member holds read, write or admin;
// the creator is the owner (admin). Isolation stays the default: an agent sees no room
// until an admin adds it, and its private brain is never reachable through a room.
//
// Storage
//   • registry   — one SQLite file on the brain service (rooms, members, subscriptions);
//                  opened with openRoomRegistry(path).
//   • room brain — a normal brain named `_room.<name>` (same schema, its own FTS) holding
//                  PUBLISHED COPIES. A copy keeps provenance: writer = original agent,
//                  source_type "agent", the source node id + original timestamp
//                  (room_items), confidence and sensitivity. Unpublishing retracts the
//                  copy (history kept); nothing in a private brain changes.
//   • conflicts  — when two writers assert different things under the same subject,
//                  both stay, a `contradicts` edge links them, both are marked disputed
//                  and a room_conflicts row is recorded. Nothing is overwritten.
//
// The built-in `shared` brain is unchanged: it is the implicit "everyone" room
// (all agents read; writing needs the shared-write token scope). Named rooms are
// additional, opt-in namespaces.

import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getDb } from "./db.js";
import { writeNode, getNode, ftsSearchNodes } from "./nodes.js";
import { writeEdge } from "./edges.js";
import { retractNode } from "./beliefs.js";
import type { BrainNode, NodeType, Sensitivity } from "./types.js";

export type RoomRole = "read" | "write" | "admin";
export const ROOM_ROLES: RoomRole[] = ["read", "write", "admin"];
export const ROOM_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
export const ROOM_BRAIN_PREFIX = "_room.";
export const roomBrainName = (room: string) => `${ROOM_BRAIN_PREFIX}${room}`;
export const isRoomBrain = (brain: string) => brain.startsWith(ROOM_BRAIN_PREFIX) && ROOM_NAME_RE.test(brain.slice(ROOM_BRAIN_PREFIX.length));
/** Node types that can be published (facts, decisions, goals, lessons and similar). Identity never leaves a private brain. */
export const PUBLISHABLE_TYPES = new Set(["semantic", "decision", "goal", "skill", "procedural", "pattern", "schema", "reflection", "hypothesis", "question", "assumption", "commitment", "plan"]);
const RANK: Record<RoomRole, number> = { read: 1, write: 2, admin: 3 };
export const roleAtLeast = (r: RoomRole | null, need: RoomRole) => !!r && RANK[r] >= RANK[need];

// ─── registry ───────────────────────────────────────────────────────────────

export function openRoomRegistry(path: string): Database.Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  ensureRoomRegistry(db);
  return db;
}

export function ensureRoomRegistry(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      name        TEXT PRIMARY KEY,
      owner       TEXT NOT NULL,
      description TEXT,
      created_at  INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS room_members (
      room        TEXT NOT NULL,
      agent_id    TEXT NOT NULL,
      role        TEXT NOT NULL,
      added_by    TEXT,
      added_at    INTEGER NOT NULL,
      revoked_at  INTEGER,
      revoked_by  TEXT,
      PRIMARY KEY (room, agent_id)
    );
    CREATE TABLE IF NOT EXISTS room_subscriptions (
      room        TEXT NOT NULL,
      agent_id    TEXT NOT NULL,
      filter_json TEXT NOT NULL DEFAULT '{}',
      created_at  INTEGER NOT NULL,
      PRIMARY KEY (room, agent_id)
    );
    CREATE TABLE IF NOT EXISTS room_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      at          INTEGER NOT NULL,
      room        TEXT NOT NULL,
      actor       TEXT NOT NULL,
      action      TEXT NOT NULL,
      detail      TEXT
    );
  `);
}

const log = (reg: Database.Database, room: string, actor: string, action: string, detail = "") =>
  reg.prepare("INSERT INTO room_log (at, room, actor, action, detail) VALUES (?, ?, ?, ?, ?)").run(Date.now(), room, actor, action, detail.slice(0, 500));

export interface RoomInfo { name: string; owner: string; description: string | null; created_at: number }
export function getRoom(reg: Database.Database, name: string): RoomInfo | null {
  return (reg.prepare("SELECT * FROM rooms WHERE name = ?").get(name) as RoomInfo | undefined) ?? null;
}

export function createRoom(reg: Database.Database, o: { name: string; owner: string; description?: string; now?: number }): { ok: boolean; error?: string } {
  if (!ROOM_NAME_RE.test(o.name)) return { ok: false, error: "room name must be 1–32 lowercase letters, digits or - (starting with a letter or digit)" };
  if (o.name === "shared") return { ok: false, error: `"shared" is the built-in everyone room; pick another name` };
  if (getRoom(reg, o.name)) return { ok: false, error: `room ${o.name} already exists` };
  const now = o.now ?? Date.now();
  reg.transaction(() => {
    reg.prepare("INSERT INTO rooms (name, owner, description, created_at) VALUES (?, ?, ?, ?)").run(o.name, o.owner, o.description?.slice(0, 300) ?? null, now);
    reg.prepare("INSERT OR REPLACE INTO room_members (room, agent_id, role, added_by, added_at) VALUES (?, ?, 'admin', ?, ?)").run(o.name, o.owner, o.owner, now);
    log(reg, o.name, o.owner, "create", o.description ?? "");
  })();
  return { ok: true };
}

/** Effective role (null when not a member, revoked, or the room does not exist). */
export function roleOf(reg: Database.Database, room: string, agent: string): RoomRole | null {
  const r = reg.prepare("SELECT role FROM room_members WHERE room = ? AND agent_id = ? AND revoked_at IS NULL").get(room, agent) as { role: RoomRole } | undefined;
  return r?.role ?? null;
}

export function setMember(reg: Database.Database, o: { room: string; agent: string; role: RoomRole; by: string; now?: number }): { ok: boolean; error?: string; previous?: RoomRole | null } {
  const room = getRoom(reg, o.room);
  if (!room) return { ok: false, error: `room ${o.room} not found` };
  if (!ROOM_ROLES.includes(o.role)) return { ok: false, error: "role must be read, write or admin" };
  if (o.agent === room.owner && o.role !== "admin") return { ok: false, error: "the owner always keeps admin" };
  const previous = roleOf(reg, o.room, o.agent);
  reg.prepare(`INSERT INTO room_members (room, agent_id, role, added_by, added_at, revoked_at, revoked_by) VALUES (?, ?, ?, ?, ?, NULL, NULL)
               ON CONFLICT(room, agent_id) DO UPDATE SET role = excluded.role, added_by = excluded.added_by, added_at = excluded.added_at, revoked_at = NULL, revoked_by = NULL`)
    .run(o.room, o.agent, o.role, o.by, o.now ?? Date.now());
  log(reg, o.room, o.by, "invite", `${o.agent}=${o.role}`);
  return { ok: true, previous };
}

/** Revoke a member: future access stops at once and the subscription is dropped. Withdrawal of published items is separate (withdrawAll). */
export function revokeMember(reg: Database.Database, o: { room: string; agent: string; by: string; now?: number }): { ok: boolean; error?: string } {
  const room = getRoom(reg, o.room);
  if (!room) return { ok: false, error: `room ${o.room} not found` };
  if (o.agent === room.owner) return { ok: false, error: "the owner cannot be revoked" };
  const r = reg.prepare("UPDATE room_members SET revoked_at = ?, revoked_by = ? WHERE room = ? AND agent_id = ? AND revoked_at IS NULL").run(o.now ?? Date.now(), o.by, o.room, o.agent);
  if (!r.changes) return { ok: false, error: `${o.agent} is not an active member of ${o.room}` };
  reg.prepare("DELETE FROM room_subscriptions WHERE room = ? AND agent_id = ?").run(o.room, o.agent);
  log(reg, o.room, o.by, "revoke", o.agent);
  return { ok: true };
}

export interface MemberRow { agent_id: string; role: RoomRole; added_by: string | null; added_at: number; revoked_at: number | null; revoked_by: string | null }
export function listMembers(reg: Database.Database, room: string, includeRevoked = false): MemberRow[] {
  return reg.prepare(`SELECT agent_id, role, added_by, added_at, revoked_at, revoked_by FROM room_members WHERE room = ? ${includeRevoked ? "" : "AND revoked_at IS NULL"} ORDER BY added_at, agent_id`).all(room) as MemberRow[];
}

export function roomsFor(reg: Database.Database, agent: string): Array<RoomInfo & { role: RoomRole; subscribed: boolean }> {
  return (reg.prepare(`SELECT r.*, m.role, (SELECT COUNT(*) FROM room_subscriptions s WHERE s.room = r.name AND s.agent_id = m.agent_id) AS sub
                       FROM rooms r JOIN room_members m ON m.room = r.name WHERE m.agent_id = ? AND m.revoked_at IS NULL ORDER BY r.name`).all(agent) as Array<RoomInfo & { role: RoomRole; sub: number }>)
    .map(({ sub, ...r }) => ({ ...r, subscribed: sub > 0 }));
}
export function allRooms(reg: Database.Database): RoomInfo[] {
  return reg.prepare("SELECT * FROM rooms ORDER BY name").all() as RoomInfo[];
}

// ─── subscriptions ──────────────────────────────────────────────────────────

export interface RoomFilter { types?: string[]; topics?: string[]; writers?: string[] }
export function parseRoomFilter(x: unknown): RoomFilter | { error: string } {
  if (x === undefined || x === null) return {};
  if (typeof x !== "object" || Array.isArray(x)) return { error: "filter must be an object like {\"types\":[\"decision\"],\"topics\":[\"deploy\"]}" };
  const o = x as Record<string, unknown>;
  const list = (k: string) => {
    const v = o[k];
    if (v === undefined) return undefined;
    if (!Array.isArray(v) || v.length > 20 || !v.every((s) => typeof s === "string" && s.length > 0 && s.length <= 60)) throw new Error(`filter.${k} must be up to 20 short strings`);
    return (v as string[]).map((s) => s.toLowerCase());
  };
  try {
    const f: RoomFilter = {};
    const t = list("types"); if (t) f.types = t;
    const p = list("topics"); if (p) f.topics = p;
    const w = list("writers"); if (w) f.writers = w;
    return f;
  } catch (e) { return { error: (e as Error).message }; }
}
export function subscribe(reg: Database.Database, o: { room: string; agent: string; filter: RoomFilter; now?: number }): void {
  reg.prepare("INSERT OR REPLACE INTO room_subscriptions (room, agent_id, filter_json, created_at) VALUES (?, ?, ?, ?)").run(o.room, o.agent, JSON.stringify(o.filter), o.now ?? Date.now());
  log(reg, o.room, o.agent, "subscribe", JSON.stringify(o.filter));
}
export function unsubscribe(reg: Database.Database, o: { room: string; agent: string }): boolean {
  const r = reg.prepare("DELETE FROM room_subscriptions WHERE room = ? AND agent_id = ?").run(o.room, o.agent);
  if (r.changes) log(reg, o.room, o.agent, "unsubscribe");
  return r.changes > 0;
}
/** Subscriptions whose membership is still live (a revoked member's subscription is gone anyway). */
export function subscriptionsFor(reg: Database.Database, agent: string): Array<{ room: string; filter: RoomFilter }> {
  return (reg.prepare(`SELECT s.room, s.filter_json FROM room_subscriptions s JOIN room_members m ON m.room = s.room AND m.agent_id = s.agent_id AND m.revoked_at IS NULL
                       WHERE s.agent_id = ? ORDER BY s.room`).all(agent) as Array<{ room: string; filter_json: string }>)
    .map((r) => ({ room: r.room, filter: (() => { try { return JSON.parse(r.filter_json) as RoomFilter; } catch { return {}; } })() }));
}
export function filterAccepts(f: RoomFilter, it: { type: string; label: string; content: string; writer: string | null }): boolean {
  if (f.types?.length && !f.types.some((t) => t === it.type || (t === "fact" && it.type === "semantic") || (t === "lesson" && (it.type === "skill" || it.type === "procedural")))) return false;
  if (f.writers?.length && !(it.writer && f.writers.includes(it.writer.toLowerCase()))) return false;
  if (f.topics?.length) { const hay = `${it.label}\n${it.content}`.toLowerCase(); if (!f.topics.some((t) => hay.includes(t))) return false; }
  return true;
}

// ─── room content (runs on the room brain's write connection) ──────────────

const words = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []));
function jaccard(a: Set<string>, b: Set<string>): number {
  if (!a.size && !b.size) return 1;
  let i = 0; for (const x of a) if (b.has(x)) i++;
  return i / (a.size + b.size - i);
}
const normLabel = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const SUBJECT_GROUPS: Record<string, string> = { semantic: "fact", pattern: "fact", schema: "fact", decision: "decision", goal: "goal", skill: "lesson", procedural: "lesson", reflection: "lesson" };
const groupOf = (t: string) => SUBJECT_GROUPS[t] ?? t;

export interface RoomItem {
  id: string; room: string; type: string; label: string; content: string;
  writer: string | null; origin_node_id: string | null; origin_created_at: number | null; published_at: number | null;
  created_at: number; confidence?: string | null; confidence_score?: number | null; contradicted_at?: number | null; sensitivity?: string | null; source_type?: string | null;
  status: string;
}

export interface PublishResult {
  published: Array<{ origin: string; roomId: string; label: string }>;
  already: Array<{ origin: string; roomId: string }>;
  skipped: Array<{ id: string; reason: string }>;
  conflicts: Array<{ id: string; a: string; b: string; aWriter: string | null; bWriter: string | null; label: string }>;
}

/**
 * Publish copies of `nodes` (already read from the publisher's private brain) into the room brain.
 * Idempotent per (agent, origin node). Detects conflicts with other writers' live items.
 */
export function publishNodes(room: string, agent: string, nodes: BrainNode[], o: { allowSensitive?: boolean; now?: number } = {}): PublishResult {
  const brain = roomBrainName(room);
  const db = getDb(brain);
  const now = o.now ?? Date.now();
  const out: PublishResult = { published: [], already: [], skipped: [], conflicts: [] };
  for (const n of nodes) {
    if (!PUBLISHABLE_TYPES.has(n.type)) { out.skipped.push({ id: n.id, reason: `type ${n.type} cannot be published` }); continue; }
    if ((n.status ?? "active") !== "active" || n.valid_until) { out.skipped.push({ id: n.id, reason: `not active (${n.status ?? "closed"})` }); continue; }
    if (n.sensitivity === "sensitive" && !o.allowSensitive) { out.skipped.push({ id: n.id, reason: "marked sensitive (pass allow_sensitive to publish it)" }); continue; }
    const prev = db.prepare("SELECT room_node_id FROM room_items WHERE origin_agent = ? AND origin_node_id = ? AND status = 'active'").get(agent, n.id) as { room_node_id: string } | undefined;
    if (prev) { out.already.push({ origin: n.id, roomId: prev.room_node_id }); continue; }
    const id = writeNode(brain, n.type as NodeType, n.label, n.content, {
      importance: n.importance, source: `room:${room}:${agent}:${n.id}`, writerAgentId: agent, sourceType: "agent",
      ...(typeof n.confidence_score === "number" ? { confidence: n.confidence_score } : {}),
      ...(n.sensitivity ? { sensitivity: n.sensitivity as Sensitivity } : {}), deduplicate: false,
    });
    db.prepare("INSERT INTO room_items (room_node_id, origin_agent, origin_node_id, origin_created_at, published_at, status) VALUES (?, ?, ?, ?, ?, 'active')").run(id, agent, n.id, n.created_at, now);
    if (n.scope_tags) db.prepare("UPDATE nodes SET scope_tags = ? WHERE id = ?").run(n.scope_tags, id);
    out.published.push({ origin: n.id, roomId: id, label: n.label });
    // conflicts: same subject, different writer, different claim
    const g = groupOf(n.type);
    const nl = normLabel(n.label); const lw = words(n.label); const cw = words(n.content);
    const others = db.prepare("SELECT id, type, label, content, writer_agent_id FROM nodes WHERE status = 'active' AND valid_until IS NULL AND id != ? AND COALESCE(writer_agent_id, '') != ?").all(id, agent) as Array<{ id: string; type: string; label: string; content: string; writer_agent_id: string | null }>;
    for (const x of others) {
      if (groupOf(x.type) !== g) continue;
      const sameSubject = normLabel(x.label) === nl || jaccard(lw, words(x.label)) >= 0.6;
      if (!sameSubject) continue;
      if (jaccard(cw, words(x.content)) >= 0.9) continue; // same claim, not a conflict
      const cid = `rc-${createHash("sha256").update([id, x.id].sort().join("|")).digest("hex").slice(0, 12)}`;
      const ins = db.prepare("INSERT OR IGNORE INTO room_conflicts (id, a_node_id, b_node_id, a_writer, b_writer, label, reason, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)")
        .run(cid, x.id, id, x.writer_agent_id, agent, n.label.slice(0, 200), `${x.writer_agent_id ?? "?"} and ${agent} assert different ${g}s about "${n.label.slice(0, 60)}"`, now);
      if (!ins.changes) continue;
      try { writeEdge(brain, id, x.id, "contradicts", { writerAgentId: agent }); } catch { /* */ }
      db.prepare("UPDATE nodes SET contradicted_at = COALESCE(contradicted_at, ?) WHERE id IN (?, ?)").run(now, id, x.id);
      out.conflicts.push({ id: cid, a: x.id, b: id, aWriter: x.writer_agent_id, bWriter: agent, label: n.label });
    }
  }
  return out;
}

/** Retract the room copy of one item (by room node id or the publisher's origin id). Only its publisher or a room admin. */
export function unpublish(room: string, o: { agent: string; id: string; isAdmin: boolean; reason?: string; now?: number }): { ok: boolean; error?: string; roomId?: string } {
  const brain = roomBrainName(room);
  const db = getDb(brain);
  const row = db.prepare("SELECT * FROM room_items WHERE status = 'active' AND (room_node_id = ? OR room_node_id LIKE ? OR (origin_node_id = ? AND origin_agent = ?))").all(o.id, `${o.id}%`, o.id, o.agent) as Array<{ room_node_id: string; origin_agent: string }>;
  if (row.length !== 1) return { ok: false, error: row.length ? `id ${o.id} is ambiguous` : `no published item ${o.id} in ${room}` };
  const it = row[0]!;
  if (it.origin_agent !== o.agent && !o.isAdmin) return { ok: false, error: `only ${it.origin_agent} (the publisher) or a room admin can unpublish it` };
  const reason = (o.reason ?? `unpublished by ${o.agent}`).slice(0, 300);
  const r = retractNode(brain, it.room_node_id, reason, { by: o.agent });
  if (!r.ok) return { ok: false, error: r.error };
  db.prepare("UPDATE room_items SET status = 'withdrawn', withdrawn_at = ?, withdrawn_reason = ? WHERE room_node_id = ?").run(o.now ?? Date.now(), reason, it.room_node_id);
  return { ok: true, roomId: it.room_node_id };
}

/** Withdraw everything an agent published in the room (revocation with withdraw). */
export function withdrawAll(room: string, agent: string, reason: string, now = Date.now()): number {
  const brain = roomBrainName(room);
  const db = getDb(brain);
  let n = 0;
  for (const r of db.prepare("SELECT room_node_id FROM room_items WHERE origin_agent = ? AND status = 'active'").all(agent) as Array<{ room_node_id: string }>) {
    const x = retractNode(brain, r.room_node_id, reason, { by: "room-admin" });
    if (x.ok || /already retracted/.test(x.error ?? "")) {
      db.prepare("UPDATE room_items SET status = 'withdrawn', withdrawn_at = ?, withdrawn_reason = ? WHERE room_node_id = ?").run(now, reason, r.room_node_id);
      n++;
    }
  }
  return n;
}

function toItem(room: string, db: Database.Database, n: BrainNode): RoomItem {
  const ri = db.prepare("SELECT origin_node_id, origin_created_at, published_at, origin_agent FROM room_items WHERE room_node_id = ?").get(n.id) as { origin_node_id: string; origin_created_at: number | null; published_at: number; origin_agent: string } | undefined;
  return { id: n.id, room, type: n.type, label: n.label, content: n.content, writer: ri?.origin_agent ?? n.writer_agent_id ?? null, origin_node_id: ri?.origin_node_id ?? null,
    origin_created_at: ri?.origin_created_at ?? null, published_at: ri?.published_at ?? null, created_at: ri?.origin_created_at ?? n.created_at,
    confidence: n.confidence ?? null, confidence_score: n.confidence_score ?? null, contradicted_at: n.contradicted_at ?? null, sensitivity: n.sensitivity ?? null, source_type: n.source_type ?? null, status: n.status ?? "active" };
}

/** Live items matching a query (FTS) — or the newest items when the query is empty. Pure read. */
export function roomQuery(room: string, query: string, limit = 10, db0?: Database.Database): RoomItem[] {
  const brain = roomBrainName(room);
  const db = db0 ?? getDb(brain);
  const lim = Math.max(1, Math.min(limit, 50));
  const rows: BrainNode[] = query.trim()
    ? (db0 ? ftsRead(db, query, lim * 3) : ftsSearchNodes(brain, query, lim * 3))
    : db.prepare("SELECT * FROM nodes ORDER BY created_at DESC LIMIT ?").all(lim * 3) as BrainNode[];
  return rows.filter((n) => (n.status ?? "active") === "active" && !n.valid_until).slice(0, lim).map((n) => toItem(room, db, n));
}

/** FTS on a read-only connection (same match fallback as ftsSearchNodes: phrase → OR of words). */
function ftsRead(db: Database.Database, query: string, limit: number): BrainNode[] {
  const terms = (query.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []).slice(0, 12);
  if (!terms.length) return [];
  try {
    return db.prepare("SELECT n.* FROM nodes n JOIN nodes_fts f ON n.rowid = f.rowid WHERE nodes_fts MATCH ? ORDER BY rank LIMIT ?").all(terms.map((t) => `"${t}"`).join(" OR "), limit) as BrainNode[];
  } catch { return []; }
}

export interface RoomConflict { id: string; room: string; label: string; reason: string | null; status: string; created_at: number; a: RoomItem | null; b: RoomItem | null }
export function roomConflicts(room: string, o: { status?: "open" | "all" } = {}, db0?: Database.Database): RoomConflict[] {
  const db = db0 ?? getDb(roomBrainName(room));
  let rows: Array<{ id: string; a_node_id: string; b_node_id: string; label: string; reason: string | null; status: string; created_at: number }> = [];
  try { rows = db.prepare(`SELECT * FROM room_conflicts ${o.status === "all" ? "" : "WHERE status = 'open'"} ORDER BY created_at DESC LIMIT 50`).all() as typeof rows; } catch { return []; }
  const node = (id: string) => { const n = db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as BrainNode | undefined; return n ? toItem(room, db, n) : null; };
  return rows.map((r) => ({ id: r.id, room, label: r.label, reason: r.reason, status: r.status, created_at: r.created_at, a: node(r.a_node_id), b: node(r.b_node_id) }));
}

export function formatRoomItem(it: RoomItem, ago: (t: number) => string): string {
  return `[${it.room}·${it.writer ?? "?"}] ${it.id.slice(0, 8)} (${it.type}) ${it.label}\n  ${it.content.slice(0, 300)}\n  by ${it.writer ?? "?"} · from ${it.origin_node_id?.slice(0, 8) ?? "?"} · written ${ago(it.created_at)}${it.published_at ? ` · published ${ago(it.published_at)}` : ""} · conf=${it.confidence ?? "medium"}${it.contradicted_at ? " · DISPUTED" : ""}${it.sensitivity && it.sensitivity !== "normal" ? ` · ${it.sensitivity.replace(/_/g, " ")}` : ""}`;
}

export function formatRoomConflict(c: RoomConflict, ago: (t: number) => string): string {
  const side = (x: RoomItem | null) => x ? `${x.writer ?? "?"}: "${x.content.slice(0, 160)}" (${x.id.slice(0, 8)}, ${ago(x.created_at)}, conf=${x.confidence ?? "medium"}${x.status !== "active" ? `, ${x.status}` : ""})` : "(missing)";
  return `${c.id} [${c.room}] ${c.label} — ${c.status}\n  A ${side(c.a)}\n  B ${side(c.b)}`;
}


// ─── tool definitions (served by xanima-server; proxied by the plugin in remote mode) ──

export interface RoomToolDef { description: string; inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] } }
export const ROOM_TOOL_DEFS: Record<string, RoomToolDef> = {
  brain_room: {
    description: "Rooms (shared namespaces with members). list (your rooms), members, conflicts (open conflicts in a room); create (needs the room-admin token scope), invite {agent, role read|write|admin} and revoke {agent, withdraw} (room admins). Revoking stops access at once; withdraw:true also retracts everything that member published there.",
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["list", "members", "conflicts", "create", "invite", "revoke"] },
      room: { type: "string", description: "Room name (lowercase letters, digits, -)." },
      agent: { type: "string", description: "invite / revoke: the member's agent id." },
      role: { type: "string", enum: ["read", "write", "admin"], description: "invite: role (default read)." },
      withdraw: { type: "boolean", description: "revoke: also withdraw (retract) the member's published items. Default false." },
      description: { type: "string", description: "create: what the room is for." },
      status: { type: "string", enum: ["open", "all"], description: "conflicts filter (default open)." },
    }, required: ["action"] },
  },
  brain_publish: {
    description: "Copy selected memories from your private brain into a room you can write to (facts, decisions, goals, lessons…; identity never). Each copy keeps you as the writer, its original time, confidence and the source node id. Conflicting claims by other members are kept side by side and recorded as a conflict — nothing is overwritten.",
    inputSchema: { type: "object", properties: {
      node_ids: { type: "array", items: { type: "string" }, description: "Ids of nodes in your private brain (max 20)." },
      room: { type: "string" },
      allow_sensitive: { type: "boolean", description: "Publish items marked sensitive too (default false)." },
    }, required: ["node_ids", "room"] },
  },
  brain_unpublish: {
    description: "Withdraw something you published from a room (by its room id or your original node id). The room copy is retracted, kept as history; your private memory is unchanged. Room admins can unpublish anyone's item.",
    inputSchema: { type: "object", properties: { room: { type: "string" }, node_id: { type: "string" }, reason: { type: "string" } }, required: ["room", "node_id"] },
  },
  brain_room_query: {
    description: "Search a room you are a member of. Each result shows [room·writer], the source node, when it was written and published, confidence, and DISPUTED when another member asserted something different.",
    inputSchema: { type: "object", properties: { room: { type: "string" }, query: { type: "string", description: "Search text (empty = newest items)." }, limit: { type: "number" }, format: { type: "string", enum: ["text", "json"] } }, required: ["room"] },
  },
  brain_subscribe: {
    description: "Subscribe to a room so its relevant items surface in your recall each turn, tagged [type·room·writer] (capped by roomRecallMax). Optional filter {types, topics, writers}. unsubscribe:true stops it.",
    inputSchema: { type: "object", properties: {
      room: { type: "string" },
      filter: { type: "object", properties: { types: { type: "array", items: { type: "string" } }, topics: { type: "array", items: { type: "string" } }, writers: { type: "array", items: { type: "string" } } } },
      unsubscribe: { type: "boolean" },
    }, required: ["room"] },
  },
};
export const ROOM_TOOL_NAMES = Object.keys(ROOM_TOOL_DEFS);
