// packages/server/src/noise.ts
//
// Find and (reversibly) retire system-noise memories — OpenClaw heartbeat
// polls, exec/cron wakes, NO_REPLY / HEARTBEAT_OK triage replies — that were
// consolidated into a brain before the openwave 0.1.4 / core sleep guards.
//
//   noise scan     read-only. Lists candidate nodes + episodes with the same
//                  classifier core/openwave use (plus a lower-confidence
//                  "triage phrasing" rule) and writes a CSV + JSON report under
//                  <root>/noise-reports/ (on the PC, never the repo). High
//                  confidence rows are pre-marked action=retire, the rest
//                  action=review. Safe while the service runs (WAL reader).
//   noise check    read-only. FTS top-N for a query (e.g. "Hailey"), marking
//                  which hits are candidates / retired.
//   noise retire   ONLY rows the reviewer left at action=retire (CSV/JSON) or
//                  listed ids (txt). Service must be stopped. Takes a VACUUM INTO
//                  backup first, then per item:
//                    node    valid_until = now (every recall path — FTS, vector,
//                            spreading activation, bootstrap — already excludes it),
//                            ripple_count = 0, eligibility_trace = 0 (so NEXUS/REM/
//                            awake replay don't pick it up);
//                    episode importance = 0, llm_extracted = 1 (below every recap
//                            / SWS floor);
//                  and records the PRIOR values in meta_kv `retired:node:<id>` /
//                  `retired:episode:<id>`. Core sleep never downscales or prunes a
//                  node with a registry row. Nothing is deleted. Audit-logged.
//   noise unretire restores the recorded prior values (by batch, ids file, or all)
//                  and removes the registry rows. Also backed up + audited.
//   noise status   registry summary by batch.

import Database from "better-sqlite3";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  isSilentReplyText, isInternalWakeText, isSystemNoiseEpisode, isHeartbeatSessionKey,
  RETIRED_NODE_META_PREFIX, RETIRED_EPISODE_META_PREFIX,
} from "sharpwave-core";

import { snapshotBrain, snapshotStamp } from "./backup.js";
import type { AuditLog } from "./audit.js";

export type Confidence = "high" | "medium";
export type NoiseCategory = "silent-reply" | "wake-marker" | "heartbeat-session" | "from-noise-episode" | "triage-phrase";

export interface NoiseCandidate {
  kind: "node" | "episode";
  id: string;
  type: string;
  category: NoiseCategory;
  confidence: Confidence;
  action: "retire" | "review";
  importance: number | null;
  retrievability: number | null;
  created_at: string;
  writer: string | null;
  source: string | null;
  session: string | null;
  preview: string;
}

export interface ScanResult {
  agent: string;
  dbPath: string;
  scannedAt: string;
  counts: { nodes: number; episodes: number; candidates: number; nodeCandidates: number; episodeCandidates: number; high: number; medium: number; alreadyRetired: number };
  byCategory: Record<string, number>;
  candidates: NoiseCandidate[];
}

/**
 * Triage phrasing seen in heartbeat replies that did NOT start with a token
 * (e.g. derived REM/NEXUS nodes, or replies that put NO_REPLY at the end).
 * Medium confidence: always action=review, never auto-retired.
 */
export const TRIAGE_PHRASES: readonly RegExp[] = [
  /\bno [\w-]*blocked work\b/i,
  /\bnothing urgent(?: in scope)?\b/i,
  /\bnext (?:scheduled )?(?:heartbeat )?tick\b/i,
  /\b(?:was|is) active \d+\s?m(?:in)? ago\b/i,
  /\bnothing (?:needs|requires) (?:attention|action)\b/i,
  /\b(?:staying|stay|remain) (?:silent|quiet)\b/i,
  /\bno reply (?:needed|required)\b/i,
  /\bheartbeat (?:poll|tick|wake)\b.*\b(?:nothing|no action|silent|NO_REPLY)\b/i,
];

const PREVIEW_CHARS = 120;
const preview = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, PREVIEW_CHARS);
const iso = (ms: unknown) => (typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : "");

function hasColumn(db: Database.Database, table: string, col: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === col);
}

function retiredIds(db: Database.Database, prefix: string): Set<string> {
  try {
    const rows = db.prepare("SELECT key FROM meta_kv WHERE substr(key, 1, ?) = ?").all(prefix.length, prefix) as Array<{ key: string }>;
    return new Set(rows.map((r) => r.key.slice(prefix.length)));
  } catch { return new Set(); }
}

function episodeCategory(role: string, content: string, session: string | null): NoiseCategory | null {
  if (!isSystemNoiseEpisode({ role, content, session_id: session })) return null;
  if (role === "assistant" && isSilentReplyText(content)) return "silent-reply";
  if (isHeartbeatSessionKey(session ?? undefined)) return "heartbeat-session";
  return "wake-marker";
}

const triage = (s: string) => TRIAGE_PHRASES.some((re) => re.test(s));

/** Read-only scan of one brain file. */
export function scanBrainFile(dbPath: string, agent: string, opts: { includeRetired?: boolean } = {}): ScanResult {
  if (!existsSync(dbPath)) throw new Error(`no brain at ${dbPath}`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    db.pragma("query_only = ON");
    const writerCol = hasColumn(db, "nodes", "writer_agent_id");
    const epWriterCol = hasColumn(db, "episodes", "writer_agent_id");
    const retiredNodes = retiredIds(db, RETIRED_NODE_META_PREFIX);
    const retiredEps = retiredIds(db, RETIRED_EPISODE_META_PREFIX);
    const out: NoiseCandidate[] = [];
    let alreadyRetired = 0;

    const eps = db.prepare(`SELECT id, session_id, role, content, importance, created_at${epWriterCol ? ", writer_agent_id" : ""} FROM episodes ORDER BY created_at`).all() as Array<{ id: string; session_id: string | null; role: string; content: string; importance: number; created_at: number; writer_agent_id?: string | null }>;
    const noiseEpisode = new Set<string>();
    for (const e of eps) {
      const cat = episodeCategory(e.role, e.content ?? "", e.session_id);
      if (cat) noiseEpisode.add(e.id);
      const medium = !cat && triage(e.content ?? "");
      if (!cat && !medium) continue;
      if (retiredEps.has(e.id)) { alreadyRetired++; if (!opts.includeRetired) continue; }
      out.push({
        kind: "episode", id: e.id, type: e.role, category: cat ?? "triage-phrase", confidence: cat ? "high" : "medium",
        action: cat ? "retire" : "review", importance: e.importance, retrievability: null, created_at: iso(e.created_at),
        writer: e.writer_agent_id ?? null, source: null, session: e.session_id, preview: preview(e.content ?? ""),
      });
    }

    const nodes = db.prepare(`SELECT id, type, label, content, importance, retrievability, source, episode_ids, created_at${writerCol ? ", writer_agent_id" : ""} FROM nodes ORDER BY created_at`).all() as Array<{ id: string; type: string; label: string; content: string; importance: number; retrievability: number; source: string | null; episode_ids: string | null; created_at: number; writer_agent_id?: string | null }>;
    for (const n of nodes) {
      const text = n.content ?? "";
      let cat: NoiseCategory | null = null;
      let conf: Confidence = "high";
      if (isSilentReplyText(text) || isSilentReplyText(n.label ?? "")) cat = "silent-reply";
      else if (isInternalWakeText(text) || isInternalWakeText(n.label ?? "")) cat = "wake-marker";
      else {
        let ids: string[] = [];
        try { const v = JSON.parse(n.episode_ids ?? "[]") as unknown; if (Array.isArray(v)) ids = v.filter((x): x is string => typeof x === "string"); } catch { /* */ }
        const fromNoise = ids.filter((id) => noiseEpisode.has(id)).length;
        if (fromNoise > 0) { cat = "from-noise-episode"; conf = fromNoise === ids.length ? "high" : "medium"; }
        else if (triage(text)) { cat = "triage-phrase"; conf = "medium"; }
      }
      if (!cat) continue;
      if (retiredNodes.has(n.id)) { alreadyRetired++; if (!opts.includeRetired) continue; }
      // identity/goal are protected self-structures: never pre-marked for retirement.
      const protectedType = n.type === "identity" || n.type === "goal";
      out.push({
        kind: "node", id: n.id, type: n.type, category: cat, confidence: conf,
        action: conf === "high" && !protectedType ? "retire" : "review",
        importance: n.importance, retrievability: n.retrievability, created_at: iso(n.created_at),
        writer: n.writer_agent_id ?? null, source: n.source, session: null, preview: preview(text),
      });
    }

    // Nodes first (they are what recall surfaces), highest importance first.
    out.sort((a, b) => (a.kind === b.kind ? (b.importance ?? 0) - (a.importance ?? 0) : a.kind === "node" ? -1 : 1));
    const byCategory: Record<string, number> = {};
    for (const c of out) byCategory[`${c.kind}:${c.category}`] = (byCategory[`${c.kind}:${c.category}`] ?? 0) + 1;
    return {
      agent, dbPath, scannedAt: new Date().toISOString(),
      counts: {
        nodes: nodes.length, episodes: eps.length, candidates: out.length,
        nodeCandidates: out.filter((c) => c.kind === "node").length, episodeCandidates: out.filter((c) => c.kind === "episode").length,
        high: out.filter((c) => c.confidence === "high").length, medium: out.filter((c) => c.confidence === "medium").length, alreadyRetired,
      },
      byCategory,
      candidates: out,
    };
  } finally {
    db.close();
  }
}

// ─── report files ───────────────────────────────────────────────────────────

const CSV_COLS: Array<keyof NoiseCandidate> = ["action", "kind", "id", "type", "category", "confidence", "importance", "retrievability", "created_at", "writer", "source", "session", "preview"];

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: NoiseCandidate[]): string {
  return [CSV_COLS.join(","), ...rows.map((r) => CSV_COLS.map((c) => csvCell(r[c])).join(","))].join("\r\n") + "\r\n";
}

/** Minimal RFC-4180 parser (quoted fields, "" escapes, CRLF/LF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let q = false;
  const t = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    if (q) {
      if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && t[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
    } else cell += ch;
  }
  row.push(cell);
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

export function writeReport(scan: ScanResult, outBase: string): { csv: string; json: string } {
  const base = outBase.replace(/\.(csv|json)$/i, "");
  mkdirSync(join(base, ".."), { recursive: true });
  const csv = `${base}.csv`;
  const json = `${base}.json`;
  writeFileSync(csv, toCsv(scan.candidates), { mode: 0o600 });
  writeFileSync(json, JSON.stringify(scan, null, 2) + "\n", { mode: 0o600 });
  return { csv, json };
}

export function defaultReportBase(root: string, agent: string, now = new Date()): string {
  return join(root, "noise-reports", `${agent}-${snapshotStamp(now)}`);
}

// ─── reviewed ids file ──────────────────────────────────────────────────────

export interface Selection { nodes: string[]; episodes: string[]; bare: string[]; ignored: number }

/**
 * Parse a reviewed file. CSV / JSON report: ONLY rows whose action is "retire"
 * (case-insensitive) are selected — edit a row to keep/review/blank to spare it.
 * Plain text: one id per line, optionally prefixed node: / episode:; # comments.
 */
export function parseSelection(path: string): Selection {
  const text = readFileSync(path, "utf8");
  const sel: Selection = { nodes: [], episodes: [], bare: [], ignored: 0 };
  const add = (kind: string | undefined, id: string) => {
    const v = id.trim();
    if (!v) return;
    if (kind === "node") sel.nodes.push(v);
    else if (kind === "episode") sel.episodes.push(v);
    else sel.bare.push(v);
  };
  const trimmed = text.replace(/^\uFEFF/, "").trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const v = JSON.parse(trimmed) as unknown;
    const list = Array.isArray(v) ? v : ((v as { candidates?: unknown[] }).candidates ?? []);
    for (const item of list) {
      if (typeof item === "string") add(undefined, item);
      else if (item && typeof item === "object") {
        const o = item as { id?: string; kind?: string; action?: string };
        if (String(o.action ?? "").toLowerCase() === "retire" && o.id) add(o.kind, o.id); else sel.ignored++;
      }
    }
  } else if (/^\s*action\s*,/i.test(trimmed) || /,\s*id\s*,/i.test(trimmed.split(/\r?\n/)[0] ?? "")) {
    const rows = parseCsv(text);
    const head = rows.shift()!.map((h) => h.trim().toLowerCase());
    const ia = head.indexOf("action"), ik = head.indexOf("kind"), ii = head.indexOf("id");
    if (ii < 0) throw new Error(`${path}: CSV has no "id" column`);
    for (const r of rows) {
      if (ia >= 0 && (r[ia] ?? "").trim().toLowerCase() !== "retire") { sel.ignored++; continue; }
      add(ik >= 0 ? (r[ik] ?? "").trim().toLowerCase() : undefined, r[ii] ?? "");
    }
  } else {
    for (const line of text.split(/\r?\n/)) {
      const l = line.replace(/#.*$/, "").trim();
      if (!l) continue;
      const m = /^(node|episode):(.+)$/i.exec(l);
      if (m) add(m[1]!.toLowerCase(), m[2]!); else add(undefined, l);
    }
  }
  sel.nodes = [...new Set(sel.nodes)];
  sel.episodes = [...new Set(sel.episodes)];
  sel.bare = [...new Set(sel.bare)];
  return sel;
}

// ─── retire / unretire ──────────────────────────────────────────────────────

interface NodePrev { valid_until: number | null; ripple_count: number | null; eligibility_trace: number | null }
interface EpisodePrev { importance: number; llm_extracted: number }
interface RegistryRow { kind: "node" | "episode"; batch: string; retiredAt: number; by: string; reason: string; prev: NodePrev | EpisodePrev }

export interface RetireOptions {
  dbPath: string;
  brain: string;
  backupsDir: string;
  audit?: AuditLog;
  by?: string;
  reason?: string;
  dryRun?: boolean;
  now?: () => number;
}

export interface RetireResult {
  batch: string;
  dryRun: boolean;
  backup: string | null;
  manifest: string | null;
  retired: { nodes: string[]; episodes: string[] };
  skipped: Array<{ id: string; reason: string }>;
}

function openWrite(dbPath: string): Database.Database {
  if (!existsSync(dbPath)) throw new Error(`no brain at ${dbPath}`);
  const db = new Database(dbPath, { fileMustExist: true, timeout: 10_000 });
  db.pragma("journal_mode = WAL");
  return db;
}

function takeBackup(o: { dbPath: string; brain: string; backupsDir: string }): string {
  // <backups>/<brain>/noise-retire/noise-retire-<UTC>.db — outside the nightly
  // rotation set (rotateSnapshots only matches <brain>-<UTC>.db files).
  return snapshotBrain(o.dbPath, join(o.backupsDir, o.brain), "noise-retire", 1_000_000).path;
}

export function retireItems(sel: Selection, o: RetireOptions): RetireResult {
  const now = o.now ?? Date.now;
  const batch = `noise-${snapshotStamp(new Date(now()))}`;
  const res: RetireResult = { batch, dryRun: !!o.dryRun, backup: null, manifest: null, retired: { nodes: [], episodes: [] }, skipped: [] };
  const db = openWrite(o.dbPath);
  try {
    const getNode = db.prepare("SELECT id, type, valid_until, ripple_count, eligibility_trace FROM nodes WHERE id = ?");
    const getEp = db.prepare("SELECT id, importance, llm_extracted FROM episodes WHERE id = ?");
    const hasReg = db.prepare("SELECT 1 FROM meta_kv WHERE key = ?");
    const plan: Array<{ kind: "node"; row: { id: string; type: string } & NodePrev } | { kind: "episode"; row: { id: string } & EpisodePrev }> = [];
    const consider = (kind: "node" | "episode" | undefined, id: string) => {
      const n = kind !== "episode" ? (getNode.get(id) as ({ id: string; type: string } & NodePrev) | undefined) : undefined;
      if (n) {
        if (n.type === "identity" || n.type === "goal") return res.skipped.push({ id, reason: `protected type ${n.type}` });
        if (hasReg.get(RETIRED_NODE_META_PREFIX + id)) return res.skipped.push({ id, reason: "already retired" });
        return plan.push({ kind: "node", row: n });
      }
      const e = kind !== "node" ? (getEp.get(id) as ({ id: string } & EpisodePrev) | undefined) : undefined;
      if (e) {
        if (hasReg.get(RETIRED_EPISODE_META_PREFIX + id)) return res.skipped.push({ id, reason: "already retired" });
        return plan.push({ kind: "episode", row: e });
      }
      res.skipped.push({ id, reason: "not found" });
    };
    for (const id of sel.nodes) consider("node", id);
    for (const id of sel.episodes) consider("episode", id);
    for (const id of sel.bare) consider(undefined, id);
    for (const p of plan) (p.kind === "node" ? res.retired.nodes : res.retired.episodes).push(p.row.id);
    if (o.dryRun || plan.length === 0) return res;

    db.close();
    res.backup = takeBackup(o); // abort (throw) before any write if the backup fails
    const w = openWrite(o.dbPath);
    try {
      const t = now();
      const by = o.by ?? "admin:cli";
      const reason = o.reason ?? "system-noise";
      const setNode = w.prepare("UPDATE nodes SET valid_until = ?, ripple_count = 0, eligibility_trace = 0 WHERE id = ?");
      const setEp = w.prepare("UPDATE episodes SET importance = 0, llm_extracted = 1 WHERE id = ?");
      const reg = w.prepare("INSERT INTO meta_kv (key, value) VALUES (?, ?)");
      w.transaction(() => {
        for (const p of plan) {
          if (p.kind === "node") {
            const prev: NodePrev = { valid_until: p.row.valid_until, ripple_count: p.row.ripple_count, eligibility_trace: p.row.eligibility_trace };
            setNode.run(p.row.valid_until && p.row.valid_until < t ? p.row.valid_until : t, p.row.id);
            reg.run(RETIRED_NODE_META_PREFIX + p.row.id, JSON.stringify({ kind: "node", batch, retiredAt: t, by, reason, prev } satisfies RegistryRow));
          } else {
            const prev: EpisodePrev = { importance: p.row.importance, llm_extracted: p.row.llm_extracted };
            setEp.run(p.row.id);
            reg.run(RETIRED_EPISODE_META_PREFIX + p.row.id, JSON.stringify({ kind: "episode", batch, retiredAt: t, by, reason, prev } satisfies RegistryRow));
          }
        }
      })();
    } finally {
      w.close();
    }
    const manifestDir = join(o.backupsDir, o.brain, "noise-retire");
    mkdirSync(manifestDir, { recursive: true });
    res.manifest = join(manifestDir, `${batch}.json`);
    writeFileSync(res.manifest, JSON.stringify({ ...res, brain: o.brain, plan: plan.map((p) => ({ kind: p.kind, ...p.row })) }, null, 2) + "\n", { mode: 0o600 });
    for (const id of res.retired.nodes) o.audit?.append({ agentId: o.by ?? "admin:cli", tool: "noise.retire", brain: o.brain, nodeId: id, outcome: "ok", detail: `node ${batch}` });
    for (const id of res.retired.episodes) o.audit?.append({ agentId: o.by ?? "admin:cli", tool: "noise.retire", brain: o.brain, nodeId: null, outcome: "ok", detail: `episode ${id} ${batch}` });
    o.audit?.append({ agentId: o.by ?? "admin:cli", tool: "noise.retire", brain: o.brain, nodeId: null, outcome: "ok", detail: `batch ${batch}: nodes=${res.retired.nodes.length} episodes=${res.retired.episodes.length} backup=${res.backup}` });
    return res;
  } finally {
    if (db.open) db.close();
  }
}

export interface UnretireOptions extends Omit<RetireOptions, "reason"> {
  batch?: string;
  ids?: Selection;
  all?: boolean;
}

export interface UnretireResult { dryRun: boolean; backup: string | null; restored: { nodes: string[]; episodes: string[] }; skipped: Array<{ id: string; reason: string }> }

function readRegistry(db: Database.Database): Array<{ key: string; id: string; row: RegistryRow }> {
  const out: Array<{ key: string; id: string; row: RegistryRow }> = [];
  for (const prefix of [RETIRED_NODE_META_PREFIX, RETIRED_EPISODE_META_PREFIX]) {
    const rows = db.prepare("SELECT key, value FROM meta_kv WHERE substr(key, 1, ?) = ?").all(prefix.length, prefix) as Array<{ key: string; value: string }>;
    for (const r of rows) {
      try { out.push({ key: r.key, id: r.key.slice(prefix.length), row: JSON.parse(r.value) as RegistryRow }); } catch { /* foreign row */ }
    }
  }
  return out;
}

export function unretireItems(o: UnretireOptions): UnretireResult {
  if (!o.batch && !o.ids && !o.all) throw new Error("unretire needs --batch <id>, --ids-file <file>, or --all");
  const res: UnretireResult = { dryRun: !!o.dryRun, backup: null, restored: { nodes: [], episodes: [] }, skipped: [] };
  const db = openWrite(o.dbPath);
  let picked: Array<{ key: string; id: string; row: RegistryRow }>;
  try {
    const reg = readRegistry(db);
    const wanted = o.ids ? new Set([...o.ids.nodes, ...o.ids.episodes, ...o.ids.bare]) : null;
    picked = reg.filter((r) => (o.all ? true : o.batch ? r.row.batch === o.batch : wanted!.has(r.id)));
    if (wanted) for (const id of wanted) if (!reg.some((r) => r.id === id)) res.skipped.push({ id, reason: "not retired" });
  } finally {
    db.close();
  }
  for (const p of picked) (p.row.kind === "node" ? res.restored.nodes : res.restored.episodes).push(p.id);
  if (o.dryRun || picked.length === 0) return res;
  res.backup = takeBackup(o);
  const w = openWrite(o.dbPath);
  try {
    const setNode = w.prepare("UPDATE nodes SET valid_until = ?, ripple_count = ?, eligibility_trace = ? WHERE id = ?");
    const setEp = w.prepare("UPDATE episodes SET importance = ?, llm_extracted = ? WHERE id = ?");
    const del = w.prepare("DELETE FROM meta_kv WHERE key = ?"); // registry row only — never a memory
    w.transaction(() => {
      for (const p of picked) {
        if (p.row.kind === "node") {
          const prev = p.row.prev as NodePrev;
          setNode.run(prev.valid_until ?? null, prev.ripple_count ?? 0, prev.eligibility_trace ?? 0, p.id);
        } else {
          const prev = p.row.prev as EpisodePrev;
          setEp.run(prev.importance, prev.llm_extracted, p.id);
        }
        del.run(p.key);
      }
    })();
  } finally {
    w.close();
  }
  for (const p of picked) o.audit?.append({ agentId: o.by ?? "admin:cli", tool: "noise.unretire", brain: o.brain, nodeId: p.row.kind === "node" ? p.id : null, outcome: "ok", detail: `${p.row.kind} ${p.id} from ${p.row.batch}` });
  o.audit?.append({ agentId: o.by ?? "admin:cli", tool: "noise.unretire", brain: o.brain, nodeId: null, outcome: "ok", detail: `restored nodes=${res.restored.nodes.length} episodes=${res.restored.episodes.length} backup=${res.backup}` });
  return res;
}

export function registryStatus(dbPath: string): Array<{ batch: string; nodes: number; episodes: number; retiredAt: string; by: string }> {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    const by = new Map<string, { batch: string; nodes: number; episodes: number; retiredAt: string; by: string }>();
    for (const r of readRegistry(db)) {
      const b = by.get(r.row.batch) ?? { batch: r.row.batch, nodes: 0, episodes: 0, retiredAt: iso(r.row.retiredAt), by: r.row.by };
      if (r.row.kind === "node") b.nodes++; else b.episodes++;
      by.set(r.row.batch, b);
    }
    return [...by.values()].sort((a, b) => a.batch.localeCompare(b.batch));
  } finally {
    db.close();
  }
}

// ─── check (FTS recall probe) ───────────────────────────────────────────────

const STOP = new Set(["the", "and", "for", "you", "your", "what", "who", "how", "when", "where", "this", "that", "with", "from", "about"]);

/** FTS top-N over CURRENT nodes (same valid_until filter as core ftsSearchNodes). */
export function ftsProbe(dbPath: string, query: string, limit = 10): Array<{ id: string; type: string; preview: string; retired: boolean }> {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    const terms = query.replace(/"/g, "").split(/\s+/).map((w) => w.trim()).filter((w) => w.length >= 3 && !STOP.has(w.toLowerCase()));
    if (terms.length === 0) return [];
    const match = terms.map((w) => `"${w}"`).join(" OR ");
    const retired = retiredIds(db, RETIRED_NODE_META_PREFIX);
    const rows = db.prepare(`
      SELECT n.id, n.type, n.content FROM nodes n JOIN nodes_fts f ON n.rowid = f.rowid
      WHERE nodes_fts MATCH ? AND (n.valid_until IS NULL OR n.valid_until > ?)
      ORDER BY rank LIMIT ?`).all(match, Date.now(), limit) as Array<{ id: string; type: string; content: string }>;
    return rows.map((r) => ({ id: r.id, type: r.type, preview: preview(r.content ?? ""), retired: retired.has(r.id) }));
  } finally {
    db.close();
  }
}
