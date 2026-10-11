/**
 * Xanima 0.4.0 — Soul Package (`xanima-soul/1`).
 *
 * A Soul Package is the portable, high-signal subset of a brain: identity and
 * core values, active goals with their history, high-priority skills, curated
 * decision lessons, key facts above a confidence threshold and (optionally)
 * open hypotheses / questions / assumptions and commitments — each with its
 * provenance. It is deterministic (same brain + options → same bytes),
 * human-readable (pretty JSON, sorted keys) and integrity-checked (sha256 over
 * a canonical form; optional ed25519 signature with a local key).
 *
 * Export reads a Database handle (works on a read-only connection or a backup
 * file). Import, three-way merge and review write through the normal core
 * write paths for one agent's brain (getDb(agentId)). Nothing is ever
 * overwritten: identity / value / goal changes and merge conflicts become
 * review items (`review_items`) that a human (or an admin) accepts or rejects.
 */
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify, generateKeyPairSync } from "node:crypto";
import type Database from "better-sqlite3";
import { getDb } from "./db.js";
import { writeNode } from "./nodes.js";
import { writeEdge } from "./edges.js";
import { supersedeNode, retractNode } from "./beliefs.js";
import { updateSelfModelField } from "./self-model.js";
import { setGoal, updateGoal, currentGoalRow } from "./goals.js";
import { recordDecision, decisionContent } from "./decisions.js";
import { createOpenItem } from "./open-items.js";
import { INJECTION_RE, applyQuarantinedOp, describeQuarantineOp, type QuarantineOp } from "./quarantine.js";
import { dispatchContinuityTool } from "./continuity-tools.js";
import { createCommitment } from "./plans.js";
import type { BrainConfig, NodeType, Sensitivity } from "./types.js";
import { DEFAULT_CONFIG } from "./types.js";

export const SOUL_FORMAT = "xanima-soul/1";
export const SOUL_GENERATOR = "xanima-core 0.4.0";

// ─── types ──────────────────────────────────────────────────────────────────

export interface SoulProvenance { writer: string | null; source_type: string; confidence: number; created_at: string; updated_at: string }
export interface SoulItem {
  id: string; type: string; label: string; content: string; importance: number; sensitivity: string;
  provenance: SoulProvenance;
  /** open items / commitments only */
  status?: string; extra?: Record<string, unknown>;
}
export interface SoulGoalEvent { version: number; at: string; action: string; reason: string | null; change: unknown }
export interface SoulGoal {
  id: string; version: number; title: string; priority: number; status: string; success_criteria: string | null;
  keywords: string[]; provenance: SoulProvenance; history: SoulGoalEvent[];
}
export interface SoulLesson {
  id: string; context: string; chosen: string; outcome: string | null; outcome_status: string | null; lesson: string;
  provenance: SoulProvenance;
}
export interface SoulContent {
  identity: { text: string };
  values: SoulItem[];
  goals: SoulGoal[];
  skills: SoulItem[];
  lessons: SoulLesson[];
  facts: SoulItem[];
  open_items?: SoulItem[];
  commitments?: SoulItem[];
  shared_facts?: SoulItem[];
}
export interface SoulOptions { include_sensitive: boolean; include_shared: boolean; include_open_items: boolean; min_fact_confidence: number; token_budget: number | null }
export interface SoulPackage {
  format: typeof SOUL_FORMAT;
  package_id: string;
  parent_id: string | null;
  fork: boolean;
  created_at: string;
  profile: "compact" | "full";
  generator: string;
  source: { agent_id: string; brain_fingerprint: string; schema_version: number };
  options: SoulOptions;
  stats: { counts: Record<string, number>; approx_tokens: number; content_chars: number; trimmed: number };
  content: SoulContent;
  integrity: { alg: "sha256"; content_hash: string; manifest: Record<string, string> };
  signature?: { alg: "ed25519"; key_id: string; public_key: string; value: string };
}

export interface ExportSoulOptions {
  agentId: string;
  profile?: "compact" | "full";
  includeSensitive?: boolean;
  includeOpenItems?: boolean;
  /** Read-only handle on the shared brain: its facts are added as `shared_facts` (scope shared). */
  sharedDb?: Database.Database;
  parentId?: string | null;
  fork?: boolean;
  config?: Partial<BrainConfig>;
  now?: number;
}

// ─── canonical JSON + hashing ───────────────────────────────────────────────

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) o[k] = sortKeys(x);
    }
    return o;
  }
  return v;
}
/** Canonical JSON: keys sorted recursively, no whitespace, undefined dropped. */
export function canonicalJson(v: unknown): string { return JSON.stringify(sortKeys(v)); }
/** Deterministic, human-readable file form (sorted keys, 2-space indent, trailing newline). */
export function serializeSoul(pkg: SoulPackage): string { return JSON.stringify(sortKeys(pkg), null, 2) + "\n"; }
const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function hashedEnvelope(p: unknown): string {
  const { package_id: _i, integrity: _h, signature: _s, ...rest } = p as SoulPackage;
  return canonicalJson(rest);
}
function manifestOf(c: SoulContent): Record<string, string> {
  const m: Record<string, string> = {};
  for (const k of Object.keys(c).sort()) m[k] = sha256(canonicalJson((c as unknown as Record<string, unknown>)[k]));
  return m;
}
const packageIdFor = (contentHash: string) => `xs1-${contentHash.slice(0, 24)}`;

// ─── helpers ────────────────────────────────────────────────────────────────

const iso = (ms: number | null | undefined) => new Date(typeof ms === "number" && Number.isFinite(ms) && ms > 0 ? ms : 0).toISOString();
const isoMs = (s: string | null | undefined) => { const t = s ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : Date.now(); };
const tableExists = (db: Database.Database, t: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(t);
const short = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
function safeParse(s: string): unknown { try { return JSON.parse(s); } catch { return null; } }

interface NodeRow { id: string; type: string; label: string; content: string; importance: number; sensitivity: string; writer_agent_id: string | null; source_type: string; confidence_score: number; created_at: number; updated_at: number }
const NODE_COLS = "id, type, label, content, importance, sensitivity, writer_agent_id, source_type, confidence_score, created_at, updated_at";
const NODE_COLS_N = NODE_COLS.split(", ").map((c) => `n.${c}`).join(", ");

/** Origin id of a local node: follow `supersedes` edges (new → old, closed ones too) to a mapped or oldest ancestor. */
export function originIdOf(db: Database.Database, localId: string, section = "node"): string {
  const mapQ = tableExists(db, "soul_id_map") ? db.prepare("SELECT origin_id FROM soul_id_map WHERE local_id = ? ORDER BY at DESC LIMIT 1") : null;
  const prevQ = db.prepare("SELECT to_id FROM edges WHERE from_id = ? AND type = 'supersedes' ORDER BY created_at LIMIT 1");
  let cur = localId; const seen = new Set<string>();
  for (let i = 0; i < 64; i++) {
    seen.add(cur);
    const m = mapQ?.get(cur) as { origin_id: string } | undefined;
    if (m) return m.origin_id;
    if (section === "goal") return cur;
    const p = prevQ.get(cur) as { to_id: string } | undefined;
    if (!p || seen.has(p.to_id)) return cur;
    cur = p.to_id;
  }
  return cur;
}

function prov(r: { writer_agent_id: string | null; source_type: string; confidence_score: number; created_at: number; updated_at: number }): SoulProvenance {
  return { writer: r.writer_agent_id ?? null, source_type: r.source_type ?? "legacy", confidence: Math.round(num(r.confidence_score, 0.6) * 1000) / 1000, created_at: iso(r.created_at), updated_at: iso(r.updated_at) };
}
/** Imported nodes carry their ORIGINAL provenance (soul_provenance), not the local import stamp. */
function origProv(db: Database.Database, localId: string): { writer_agent_id: string | null; source_type: string; confidence_score: number; created_at: number; updated_at: number } | null {
  if (!tableExists(db, "soul_provenance")) return null;
  const p = db.prepare("SELECT writer, source_type, confidence, created_at, updated_at FROM soul_provenance WHERE local_id = ?").get(localId) as { writer: string | null; source_type: string; confidence: number; created_at: number; updated_at: number } | undefined;
  return p ? { writer_agent_id: p.writer, source_type: p.source_type, confidence_score: p.confidence, created_at: p.created_at, updated_at: p.updated_at } : null;
}
function nodeItem(db: Database.Database, r: NodeRow, cap: number | null, section: string): SoulItem {
  return { id: originIdOf(db, r.id, section), type: r.type, label: r.label, content: cap ? short(r.content, cap) : r.content,
    importance: Math.round(num(r.importance, 0.5) * 1000) / 1000, sensitivity: r.sensitivity ?? "normal", provenance: prov(origProv(db, r.id) ?? r) };
}

/** Fingerprint of the source brain: agent + every current non-episodic node id and update time. */
export function brainFingerprint(db: Database.Database, agentId: string): string {
  const h = createHash("sha256").update(agentId);
  for (const r of db.prepare("SELECT id, updated_at FROM nodes WHERE status = 'active' AND type != 'episodic' ORDER BY id").iterate() as Iterable<{ id: string; updated_at: number }>) h.update(`${r.id}:${r.updated_at};`);
  return h.digest("hex").slice(0, 32);
}
function lastPackageId(db: Database.Database): string | null {
  try { return (db.prepare("SELECT value FROM meta_kv WHERE key = 'soul:last_package'").get() as { value: string } | undefined)?.value ?? null; } catch { return null; }
}

// ─── export ─────────────────────────────────────────────────────────────────

export function exportSoul(db: Database.Database, o: ExportSoulOptions): SoulPackage {
  const cfg = { ...DEFAULT_CONFIG, ...(o.config ?? {}) };
  const profile = o.profile ?? cfg.soulExportProfile ?? "compact";
  const compact = profile === "compact";
  const now = o.now ?? Date.now();
  const sv = (db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined)?.version ?? 0;
  if (sv < 22) throw new Error(`brain schema v${sv} is too old for a soul export (needs >= 22; run xanima-server migrate or start the service once)`);
  const includeOpen = o.includeOpenItems ?? !compact;
  const options: SoulOptions = {
    include_sensitive: !!o.includeSensitive, include_shared: !!o.sharedDb, include_open_items: includeOpen,
    min_fact_confidence: num(cfg.soulMinFactConfidence, 0.6), token_budget: compact ? num(cfg.soulTokenBudget, 2000) : null,
  };
  const cap = compact ? 400 : null;
  const sensN = options.include_sensitive ? "" : " AND n.sensitivity != 'sensitive'";
  const live = `status = 'active' AND (valid_until IS NULL OR valid_until > ${Math.floor(now)})${options.include_sensitive ? "" : " AND sensitivity != 'sensitive'"}`;

  const identity = { text: ((db.prepare("SELECT identity FROM self_model WHERE id = 'singleton'").get() as { identity?: string } | undefined)?.identity ?? "").trim() };
  const values = (db.prepare(`SELECT ${NODE_COLS} FROM nodes WHERE type = 'identity' AND ${live} ORDER BY importance DESC, id`).all() as NodeRow[]).map((r) => nodeItem(db, r, cap, "value"));

  const goalRows = db.prepare(`SELECT g.*, n.writer_agent_id, n.source_type, n.confidence_score FROM goals g JOIN nodes n ON n.id = g.node_id
                               WHERE g.status = 'active' AND n.status = 'active'${sensN} ORDER BY g.priority, g.lineage_id`).all() as Array<Record<string, unknown>>;
  const evQ = db.prepare("SELECT version, at, action, reason, change_json FROM goal_events WHERE lineage_id = ? ORDER BY at, id");
  const goals: SoulGoal[] = goalRows.map((g) => {
    let hist = (evQ.all(g["lineage_id"]) as Array<{ version: number; at: number; action: string; reason: string | null; change_json: string | null }>).map((e) => ({
      version: e.version, at: iso(e.at), action: e.action, reason: e.reason ?? null, change: e.change_json ? safeParse(e.change_json) : null }));
    if (compact) hist = hist.slice(-3);
    return { id: originIdOf(db, String(g["lineage_id"]), "goal"), version: Number(g["version"]), title: String(g["title"]), priority: Number(g["priority"]), status: String(g["status"]),
      success_criteria: (g["success_criteria"] as string | null) ?? null, keywords: (safeParse(String(g["keywords_json"] ?? "[]")) as string[]) ?? [],
      provenance: prov({ writer_agent_id: g["writer_agent_id"] as string | null, source_type: String(g["source_type"]), confidence_score: Number(g["confidence_score"]), created_at: Number(g["created_at"]), updated_at: Number(g["updated_at"]) }), history: hist };
  });

  const skillsRanked = (db.prepare(`SELECT ${NODE_COLS} FROM nodes WHERE type IN ('skill', 'procedural') AND ${live} ORDER BY importance * confidence_score DESC, id`).all() as NodeRow[])
    .slice(0, compact ? 25 : 100000).map((r) => nodeItem(db, r, cap, "skill"));
  const lessonsRanked = (db.prepare(`SELECT d.node_id, d.context, d.chosen, d.outcome, d.outcome_status, d.lesson, n.writer_agent_id, n.source_type, n.confidence_score, n.created_at, n.updated_at
                                     FROM decisions d JOIN nodes n ON n.id = d.node_id
                                     WHERE d.lesson IS NOT NULL AND d.lesson != '' AND d.merged_into IS NULL AND (d.draft_status IS NULL OR d.draft_status = 'confirmed')
                                       AND n.status = 'active'${sensN} ORDER BY COALESCE(d.outcome_at, d.updated_at) DESC, d.node_id`).all() as Array<Record<string, unknown>>)
    .slice(0, compact ? 20 : 100000).map((d): SoulLesson => ({
      id: originIdOf(db, String(d["node_id"]), "lesson"), context: cap ? short(String(d["context"]), 300) : String(d["context"]), chosen: String(d["chosen"]),
      outcome: d["outcome"] == null ? null : cap ? short(String(d["outcome"]), 300) : String(d["outcome"]), outcome_status: (d["outcome_status"] as string | null) ?? null, lesson: String(d["lesson"]),
      provenance: prov(origProv(db, String(d["node_id"])) ?? (d as never)) }));
  const sp = tableExists(db, "soul_provenance");
  const effConf = sp ? "COALESCE((SELECT confidence FROM soul_provenance WHERE local_id = nodes.id), confidence_score)" : "confidence_score";
  const effSrc = sp ? "COALESCE((SELECT source_type FROM soul_provenance WHERE local_id = nodes.id), source_type)" : "source_type";
  const factsRanked = (db.prepare(`SELECT ${NODE_COLS} FROM nodes WHERE type IN ('semantic', 'schema') AND ${effConf} >= ? AND ${effSrc} != 'inference' AND ${live}
                                   ORDER BY importance * ${effConf} DESC, id`).all(options.min_fact_confidence) as NodeRow[])
    .slice(0, compact ? 40 : 100000).map((r) => nodeItem(db, r, cap, "fact"));

  let openRanked: SoulItem[] = []; let commitRanked: SoulItem[] = [];
  if (includeOpen && tableExists(db, "open_items")) {
    openRanked = (db.prepare(`SELECT o.kind, o.status ostatus, o.load_bearing, o.text otext, ${NODE_COLS_N} FROM open_items o JOIN nodes n ON n.id = o.node_id
                              WHERE o.status IN ('open', 'supported') AND (o.draft_status IS NULL OR o.draft_status = 'confirmed') AND n.status = 'active'${sensN}
                              ORDER BY o.load_bearing DESC, n.updated_at DESC, n.id`).all() as Array<NodeRow & { kind: string; ostatus: string; load_bearing: number; otext: string }>)
      .slice(0, compact ? 10 : 100000).map((r) => ({ ...nodeItem(db, { ...r, content: r.otext }, cap, "open"), status: r.ostatus, extra: { kind: r.kind, load_bearing: !!r.load_bearing } }));
    commitRanked = (db.prepare(`SELECT c.counterparty, c.due_at, c.status cstatus, c.title ctitle, ${NODE_COLS_N} FROM commitments c JOIN nodes n ON n.id = c.node_id
                                WHERE c.status = 'open' AND n.status = 'active'${sensN} ORDER BY COALESCE(c.due_at, 9e15), n.id`).all() as Array<NodeRow & { counterparty: string; due_at: number | null; cstatus: string; ctitle: string }>)
      .slice(0, compact ? 10 : 100000).map((r) => ({ ...nodeItem(db, { ...r, content: r.ctitle }, cap, "commitment"), status: r.cstatus, extra: { to: r.counterparty, due: r.due_at ? iso(r.due_at) : null } }));
  }
  let sharedRanked: SoulItem[] = [];
  if (o.sharedDb) {
    const sdb = o.sharedDb;
    sharedRanked = (sdb.prepare(`SELECT ${NODE_COLS} FROM nodes WHERE type IN ('semantic', 'schema', 'skill') AND confidence_score >= ? AND ${live} ORDER BY importance * confidence_score DESC, id`)
      .all(options.min_fact_confidence) as NodeRow[]).slice(0, compact ? 10 : 100000).map((r) => ({ ...nodeItem(sdb, r, cap, "shared"), extra: { scope: "shared" } }));
  }

  const byId = <T extends { id: string }>(a: T[]) => [...a].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const build = (): SoulContent => {
    const c: SoulContent = { identity, values: byId(values), goals: byId(goals), skills: byId(skillsRanked), lessons: byId(lessonsRanked), facts: byId(factsRanked) };
    if (includeOpen) { c.open_items = byId(openRanked); c.commitments = byId(commitRanked); }
    if (o.sharedDb) c.shared_facts = byId(sharedRanked);
    return c;
  };
  let content = build();
  let trimmed = 0;
  if (compact && options.token_budget) {
    const budget = options.token_budget;
    const tok = () => Math.ceil(canonicalJson(content).length / 4);
    const order: Array<Array<unknown>> = [sharedRanked, factsRanked, openRanked, commitRanked, skillsRanked, lessonsRanked];
    while (tok() > budget) {
      const from = order.find((a) => a.length > 0);
      if (!from) break;
      // drop a few at a time when far over budget (keeps big brains fast)
      const over = tok() - budget;
      const n = Math.max(1, Math.min(from.length, Math.floor(over / 400)));
      from.splice(from.length - n, n); trimmed += n;
      content = build();
    }
  }
  const chars = canonicalJson(content).length;
  const counts: Record<string, number> = { identity: identity.text ? 1 : 0, values: content.values.length, goals: content.goals.length, skills: content.skills.length, lessons: content.lessons.length, facts: content.facts.length };
  if (content.open_items) counts["open_items"] = content.open_items.length;
  if (content.commitments) counts["commitments"] = content.commitments.length;
  if (content.shared_facts) counts["shared_facts"] = content.shared_facts.length;
  // created_at = newest update among the included items (deterministic; no wall clock)
  let newest = 0;
  const walk = (v: unknown) => { if (v && typeof v === "object") for (const [k, x] of Object.entries(v as Record<string, unknown>)) { if (k === "updated_at" && typeof x === "string") newest = Math.max(newest, Date.parse(x) || 0); else walk(x); } };
  walk(content);
  const base = {
    format: SOUL_FORMAT, parent_id: o.parentId === undefined ? lastPackageId(db) : o.parentId, fork: !!o.fork, created_at: iso(newest), profile, generator: SOUL_GENERATOR,
    source: { agent_id: o.agentId, brain_fingerprint: brainFingerprint(db, o.agentId), schema_version: sv }, options,
    stats: { counts, approx_tokens: Math.ceil(chars / 4), content_chars: chars, trimmed }, content,
  };
  const contentHash = sha256(hashedEnvelope(base));
  return { ...base, package_id: packageIdFor(contentHash), integrity: { alg: "sha256", content_hash: contentHash, manifest: manifestOf(content) } } as SoulPackage;
}

// ─── signing ────────────────────────────────────────────────────────────────

/** New ed25519 key pair as PEM strings (the caller stores the private key; never in a repo). */
export function generateSoulKeyPair(): { privateKeyPem: string; publicKeyPem: string; keyId: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return { privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), publicKeyPem, keyId: keyIdOf(publicKeyPem) };
}
function keyIdOf(publicKeyPem: string): string {
  return createHash("sha256").update(createPublicKey(publicKeyPem).export({ type: "spki", format: "der" })).digest("hex").slice(0, 16);
}
const signedBytes = (p: SoulPackage) => Buffer.from(`${SOUL_FORMAT}\n${p.package_id}\n${p.integrity.content_hash}`, "utf8");
export function signSoul(pkg: SoulPackage, privateKeyPem: string): SoulPackage {
  const key = createPrivateKey(privateKeyPem);
  const publicKeyPem = createPublicKey(key).export({ type: "spki", format: "pem" }).toString();
  return { ...pkg, signature: { alg: "ed25519", key_id: keyIdOf(publicKeyPem), public_key: publicKeyPem, value: edSign(null, signedBytes(pkg), key).toString("base64") } };
}

// ─── validation ─────────────────────────────────────────────────────────────

export interface SoulValidation { ok: boolean; errors: string[]; signed: boolean; keyId: string | null }
const CONTENT_KEYS = ["identity", "values", "goals", "skills", "lessons", "facts", "open_items", "commitments", "shared_facts"];

/** Structural check against xanima-soul/1 (mirrors schema/xanima-soul-1.schema.json) + hash + package id + manifest + signature. */
export function validateSoul(input: unknown, opts: { trustedKeyIds?: string[]; requireSignature?: boolean } = {}): SoulValidation {
  const e: string[] = [];
  const r: SoulValidation = { ok: false, errors: e, signed: false, keyId: null };
  if (!input || typeof input !== "object" || Array.isArray(input)) { e.push("package must be a JSON object"); return r; }
  const p = input as Record<string, unknown>;
  if (p["format"] !== SOUL_FORMAT) e.push(`format must be "${SOUL_FORMAT}" (got ${JSON.stringify(p["format"])})`);
  const str = (k: string, o: Record<string, unknown>, path: string) => { if (typeof o[k] !== "string") e.push(`${path} must be a string`); };
  str("package_id", p, "package_id"); str("created_at", p, "created_at"); str("generator", p, "generator");
  if (p["parent_id"] !== null && typeof p["parent_id"] !== "string") e.push("parent_id must be a string or null");
  if (typeof p["fork"] !== "boolean") e.push("fork must be a boolean");
  if (p["profile"] !== "compact" && p["profile"] !== "full") e.push('profile must be "compact" or "full"');
  const src = p["source"] as Record<string, unknown> | undefined;
  if (!src || typeof src !== "object") e.push("source is required");
  else { str("agent_id", src, "source.agent_id"); str("brain_fingerprint", src, "source.brain_fingerprint"); if (typeof src["schema_version"] !== "number") e.push("source.schema_version must be a number"); }
  if (!p["options"] || typeof p["options"] !== "object") e.push("options is required");
  if (!p["stats"] || typeof p["stats"] !== "object") e.push("stats is required");
  const c = p["content"] as Record<string, unknown> | undefined;
  if (!c || typeof c !== "object") e.push("content is required");
  else {
    const id = c["identity"] as Record<string, unknown> | undefined;
    if (!id || typeof id["text"] !== "string") e.push("content.identity.text must be a string");
    const provOk = (x: unknown, path: string) => {
      const pv = x as Record<string, unknown> | undefined;
      if (!pv || typeof pv !== "object") { e.push(`${path}.provenance is required`); return; }
      if (pv["writer"] !== null && typeof pv["writer"] !== "string") e.push(`${path}.provenance.writer must be a string or null`);
      if (typeof pv["source_type"] !== "string") e.push(`${path}.provenance.source_type must be a string`);
      const cf = pv["confidence"];
      if (typeof cf !== "number" || cf < 0 || cf > 1) e.push(`${path}.provenance.confidence must be 0..1`);
      if (typeof pv["created_at"] !== "string" || typeof pv["updated_at"] !== "string") e.push(`${path}.provenance timestamps must be ISO strings`);
    };
    const items = (k: string, req: boolean, fields: string[]) => {
      const a = c[k];
      if (a === undefined && !req) return;
      if (!Array.isArray(a)) { e.push(`content.${k} must be an array`); return; }
      a.forEach((x, i) => {
        const path = `content.${k}[${i}]`;
        if (!x || typeof x !== "object") { e.push(`${path} must be an object`); return; }
        for (const f of fields) if (typeof (x as Record<string, unknown>)[f] !== "string") e.push(`${path}.${f} must be a string`);
        provOk((x as Record<string, unknown>)["provenance"], path);
      });
    };
    items("values", true, ["id", "type", "label", "content"]);
    items("skills", true, ["id", "type", "label", "content"]);
    items("facts", true, ["id", "type", "label", "content"]);
    items("lessons", true, ["id", "context", "chosen", "lesson"]);
    items("goals", true, ["id", "title", "status"]);
    items("open_items", false, ["id", "type", "label", "content"]);
    items("commitments", false, ["id", "type", "label", "content"]);
    items("shared_facts", false, ["id", "type", "label", "content"]);
    for (const k of Object.keys(c)) if (!CONTENT_KEYS.includes(k)) e.push(`content.${k} is not part of ${SOUL_FORMAT}`);
  }
  const integ = p["integrity"] as Record<string, unknown> | undefined;
  if (!integ || integ["alg"] !== "sha256" || typeof integ["content_hash"] !== "string") e.push("integrity.alg must be sha256 with a content_hash");
  if (e.length) return r;
  const pkg = input as SoulPackage;
  const h = sha256(hashedEnvelope(pkg));
  if (h !== pkg.integrity.content_hash) e.push(`content hash mismatch: the package was modified after export (recorded ${pkg.integrity.content_hash.slice(0, 12)}…, actual ${h.slice(0, 12)}…)`);
  else if (packageIdFor(h) !== pkg.package_id) e.push("package_id does not match the content hash");
  if (pkg.integrity.manifest) {
    const m = manifestOf(pkg.content);
    for (const [k, v] of Object.entries(pkg.integrity.manifest)) if (m[k] !== v) e.push(`manifest mismatch for section ${k}`);
  }
  if (pkg.signature) {
    r.signed = true; r.keyId = pkg.signature.key_id;
    try {
      if (keyIdOf(pkg.signature.public_key) !== pkg.signature.key_id) e.push("signature key_id does not match its public key");
      else if (!edVerify(null, signedBytes(pkg), createPublicKey(pkg.signature.public_key), Buffer.from(pkg.signature.value, "base64"))) e.push("signature does not verify");
    } catch (x) { e.push(`signature check failed: ${String(x)}`); }
    if (opts.trustedKeyIds?.length && !opts.trustedKeyIds.includes(pkg.signature.key_id)) e.push(`signed by untrusted key ${pkg.signature.key_id}`);
  } else if (opts.requireSignature) e.push("package is not signed");
  r.ok = e.length === 0;
  return r;
}

export function parseSoul(text: string): SoulPackage {
  try { return JSON.parse(text) as SoulPackage; } catch (x) { throw new Error(`not JSON: ${String(x).slice(0, 120)}`); }
}

// ─── item digests (what counts as "changed") ────────────────────────────────

export type SoulSection = "identity" | "values" | "goals" | "skills" | "lessons" | "facts" | "open_items" | "commitments" | "shared_facts";
const SECTIONS: SoulSection[] = ["identity", "values", "goals", "skills", "lessons", "facts", "open_items", "commitments", "shared_facts"];
const NODE_SECTIONS: SoulSection[] = ["values", "skills", "facts", "open_items", "commitments", "shared_facts"];
const REVIEW_SECTIONS: SoulSection[] = ["identity", "values", "goals"];
type AnyItem = SoulItem | SoulGoal | SoulLesson | { id: string; text: string };

function digest(section: SoulSection, x: AnyItem | undefined): string | null {
  if (!x) return null;
  if (section === "identity") return sha256((x as { text: string }).text.trim());
  if (section === "goals") { const g = x as SoulGoal; return sha256(canonicalJson([g.title, g.priority, g.status, g.success_criteria ?? null])); }
  if (section === "lessons") { const l = x as SoulLesson; return sha256(canonicalJson([l.context, l.chosen, l.outcome_status ?? null, l.lesson])); }
  const n = x as SoulItem;
  if (section === "open_items" || section === "commitments") return sha256(canonicalJson([n.content, n.status ?? null]));
  return sha256(canonicalJson([n.label, n.content, n.status ?? null]));
}
function sectionMap(p: SoulPackage, s: SoulSection): Map<string, AnyItem> {
  const m = new Map<string, AnyItem>();
  if (s === "identity") { if (p.content.identity.text.trim()) m.set("identity", { id: "identity", text: p.content.identity.text }); return m; }
  for (const x of ((p.content as unknown as Record<string, AnyItem[] | undefined>)[s] ?? [])) m.set(x.id, x);
  return m;
}
const labelOf = (s: SoulSection, x: AnyItem) => s === "identity" ? "identity" : s === "goals" ? (x as SoulGoal).title : s === "lessons" ? (x as SoulLesson).lesson : (x as SoulItem).label;
const textOf = (s: SoulSection, x: AnyItem | undefined | null): string => {
  if (!x) return "(absent)";
  if (s === "identity") return (x as { text: string }).text;
  if (s === "goals") { const g = x as SoulGoal; return `${g.title} (P${g.priority}, ${g.status})${g.success_criteria ? ` — success: ${g.success_criteria}` : ""}`; }
  if (s === "lessons") { const l = x as SoulLesson; return `${l.context} → ${l.chosen}${l.outcome_status ? ` [${l.outcome_status}]` : ""}. Lesson: ${l.lesson}`; }
  const n = x as SoulItem; return `${n.label}: ${n.content}`;
};

// ─── diff ───────────────────────────────────────────────────────────────────

export interface SoulDiffEntry { section: SoulSection; id: string; label: string; before?: string; after?: string }
export interface SoulDiff { a: string; b: string; added: SoulDiffEntry[]; removed: SoulDiffEntry[]; changed: SoulDiffEntry[]; unchanged: number }

export function diffSoul(a: SoulPackage, b: SoulPackage): SoulDiff {
  const d: SoulDiff = { a: a.package_id, b: b.package_id, added: [], removed: [], changed: [], unchanged: 0 };
  for (const s of SECTIONS) {
    const ma = sectionMap(a, s), mb = sectionMap(b, s);
    for (const [id, x] of mb) {
      const y = ma.get(id);
      if (!y) d.added.push({ section: s, id, label: short(labelOf(s, x), 90), after: short(textOf(s, x), 200) });
      else if (digest(s, x) !== digest(s, y)) d.changed.push({ section: s, id, label: short(labelOf(s, x), 90), before: short(textOf(s, y), 200), after: short(textOf(s, x), 200) });
      else d.unchanged++;
    }
    for (const [id, y] of ma) if (!mb.has(id)) d.removed.push({ section: s, id, label: short(labelOf(s, y), 90), before: short(textOf(s, y), 200) });
  }
  return d;
}
export function formatSoulDiff(d: SoulDiff): string {
  const L = [`soul diff ${d.a} → ${d.b}: +${d.added.length} added, -${d.removed.length} removed, ~${d.changed.length} changed, ${d.unchanged} unchanged`];
  for (const x of d.added) L.push(`+ [${x.section}] ${x.id.slice(0, 8)} ${x.label}`);
  for (const x of d.removed) L.push(`- [${x.section}] ${x.id.slice(0, 8)} ${x.label}`);
  for (const x of d.changed) L.push(`~ [${x.section}] ${x.id.slice(0, 8)} ${x.label}\n    before: ${x.before}\n    after:  ${x.after}`);
  return L.join("\n");
}

// ─── import / merge (write path, one agent's brain) ─────────────────────────

const POISON_RE = INJECTION_RE;
/** Heuristic poisoning flag for identity / value / goal text arriving from outside (same patterns as the 0.5.0 quarantine). */
export function looksLikeIdentityRewrite(text: string): boolean { return POISON_RE.test(text); }

export interface ReviewItem {
  id: string; kind: string; section: string; status: string; package_id: string | null; origin_id: string | null; local_id: string | null; label: string;
  base: unknown; ours: unknown; theirs: unknown; markers: string | null; reason: string | null; flags: string[];
  created_at: number; resolved_at: number | null; resolved_by: string | null; resolution_note: string | null;
}
interface RepEntry { section: SoulSection; origin: string; local?: string; label: string }
interface RepReview { id?: string; kind: string; section: SoulSection; origin: string; label: string; reason: string; flags: string[] }
export interface ImportReport {
  packageId: string; mode: "new" | "merge" | "three-way"; dryRun: boolean;
  created: RepEntry[]; applied: RepEntry[]; review: RepReview[];
  unchanged: number; keptOurs: number; conflicts: number; backup: string | null;
}
export interface ImportOptions {
  mode?: "new" | "merge"; dryRun?: boolean; by?: string; now?: number; config?: Partial<BrainConfig>;
  trustedKeyIds?: string[]; requireSignature?: boolean;
  /** Called once before the first write (take a backup); its return value is reported. Throwing aborts the import. */
  backup?: () => string | null;
}

/** Newest version of a node: follow supersedes edges forward (old ← new). */
function currentOf(db: Database.Database, id: string): string {
  let cur = id; const seen = new Set<string>();
  for (let i = 0; i < 64; i++) {
    seen.add(cur);
    const n = db.prepare("SELECT from_id FROM edges WHERE to_id = ? AND type = 'supersedes' ORDER BY created_at DESC LIMIT 1").get(cur) as { from_id: string } | undefined;
    if (!n || seen.has(n.from_id)) return cur;
    cur = n.from_id;
  }
  return cur;
}
function localIdFor(db: Database.Database, originId: string, section: SoulSection): string | null {
  const cands = tableExists(db, "soul_id_map") ? (db.prepare("SELECT local_id FROM soul_id_map WHERE origin_id = ? ORDER BY at DESC").all(originId) as Array<{ local_id: string }>).map((r) => r.local_id) : [];
  cands.push(originId);
  for (const c of cands) {
    if (section === "goals") { if (db.prepare("SELECT 1 FROM goals WHERE lineage_id = ?").get(c)) return c; continue; }
    if (section === "lessons") { if (db.prepare("SELECT 1 FROM decisions WHERE node_id = ?").get(c)) return c; continue; }
    if (db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(c)) return currentOf(db, c);
  }
  return null;
}
function matchByLabel(db: Database.Database, section: SoulSection, x: AnyItem): string | null {
  if (section === "identity") return null;
  if (section === "goals") return (db.prepare("SELECT lineage_id FROM goals WHERE status = 'active' AND lower(title) = lower(?) LIMIT 1").get((x as SoulGoal).title) as { lineage_id: string } | undefined)?.lineage_id ?? null;
  if (section === "lessons") return (db.prepare("SELECT node_id FROM decisions WHERE lower(lesson) = lower(?) AND merged_into IS NULL LIMIT 1").get((x as SoulLesson).lesson) as { node_id: string } | undefined)?.node_id ?? null;
  const n = x as SoulItem;
  return (db.prepare("SELECT id FROM nodes WHERE status = 'active' AND type = ? AND lower(label) = lower(?) LIMIT 1").get(n.type, n.label) as { id: string } | undefined)?.id ?? null;
}
const identityText = (db: Database.Database) => ((db.prepare("SELECT identity FROM self_model WHERE id = 'singleton'").get() as { identity?: string } | undefined)?.identity ?? "").trim();

/** The local item, in package shape, for digest comparison. */
function localItem(db: Database.Database, section: SoulSection, localId: string, originId: string): AnyItem | undefined {
  if (section === "identity") { const t = identityText(db); return t ? { id: "identity", text: t } : undefined; }
  if (section === "goals") {
    const g = db.prepare("SELECT * FROM goals WHERE lineage_id = ? AND status != 'superseded' ORDER BY version DESC LIMIT 1").get(localId) as Record<string, unknown> | undefined;
    return g ? ({ id: originId, version: Number(g["version"]), title: String(g["title"]), priority: Number(g["priority"]), status: String(g["status"]), success_criteria: (g["success_criteria"] as string | null) ?? null, keywords: [], history: [] } as unknown as SoulGoal) : undefined;
  }
  if (section === "lessons") {
    const d = db.prepare("SELECT * FROM decisions WHERE node_id = ?").get(localId) as Record<string, unknown> | undefined;
    return d ? ({ id: originId, context: String(d["context"]), chosen: String(d["chosen"]), outcome: (d["outcome"] as string | null) ?? null, outcome_status: (d["outcome_status"] as string | null) ?? null, lesson: String(d["lesson"] ?? "") } as unknown as SoulLesson) : undefined;
  }
  const n = db.prepare(`SELECT ${NODE_COLS}, status FROM nodes WHERE id = ?`).get(localId) as (NodeRow & { status: string }) | undefined;
  if (!n || n.status !== "active") return undefined;
  let status: string | undefined; let content = n.content;
  if (section === "open_items") { const o = db.prepare("SELECT status, text FROM open_items WHERE node_id = ?").get(localId) as { status: string; text: string } | undefined; status = o?.status; content = o?.text ?? content; }
  if (section === "commitments") { const o = db.prepare("SELECT status, title FROM commitments WHERE node_id = ?").get(localId) as { status: string; title: string } | undefined; status = o?.status; content = o?.title ?? content; }
  return { id: originId, type: n.type, label: n.label, content, importance: n.importance, sensitivity: n.sensitivity, ...(status ? { status } : {}) } as SoulItem;
}

class Writer {
  anchor: string | null = null;
  constructor(public agentId: string, public pkgId: string, public srcAgent: string, public pkgDesc: string, public cfg: BrainConfig, public by: string, public now: number) {}
  get db() { return getDb(this.agentId); }
  ensureAnchor(): string {
    if (this.anchor) return this.anchor;
    const key = `soul:anchor:${this.pkgId}`;
    const ex = (this.db.prepare("SELECT value FROM meta_kv WHERE key = ?").get(key) as { value: string } | undefined)?.value;
    if (ex) return (this.anchor = ex);
    const id = writeNode(this.agentId, "schema", `Soul package ${this.pkgId}`, `Provenance anchor: memories imported from soul package ${this.pkgId} (${this.pkgDesc}).`, { deduplicate: false, sourceType: "import", writerAgentId: this.by, importance: 0.1 });
    this.db.prepare("UPDATE nodes SET status = 'archived', status_reason = 'soul package provenance anchor (never recalled)', status_changed_at = ? WHERE id = ?").run(this.now, id);
    this.db.prepare("INSERT OR REPLACE INTO meta_kv (key, value) VALUES (?, ?)").run(key, id);
    return (this.anchor = id);
  }
  conf(p: SoulProvenance | undefined) { return Math.min(num(p?.confidence, 0.5), num(this.cfg.soulImportConfidence, 0.5)); }
  writer(p: SoulProvenance | undefined) { return p?.writer ?? this.srcAgent; }
  record(originId: string, localId: string, section: SoulSection, p?: SoulProvenance) {
    this.db.prepare("INSERT OR REPLACE INTO soul_id_map (origin_id, local_id, package_id, section, at) VALUES (?, ?, ?, ?, ?)").run(originId, localId, this.pkgId, section, this.now);
    if (!p) return;
    this.db.prepare("INSERT OR REPLACE INTO soul_provenance (local_id, origin_id, package_id, source_agent, writer, source_type, confidence, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(localId, originId, this.pkgId, this.srcAgent, p.writer, p.source_type, p.confidence, isoMs(p.created_at), isoMs(p.updated_at));
    if (section !== "goals" && section !== "identity" && this.db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(localId)) {
      writeEdge(this.agentId, localId, this.ensureAnchor(), "imported_from", { writerAgentId: this.by, meta: { package_id: this.pkgId, origin_id: originId } });
    }
  }
  /** Create a new local item (never touches an existing one). Identity / values / goals never come here from an import. */
  create(section: SoulSection, x: AnyItem): string | null {
    const db = this.db;
    if (section === "lessons") {
      const l = x as SoulLesson;
      const r = recordDecision(this.agentId, { context: l.context, chosen: l.chosen, writerAgentId: this.writer(l.provenance), sourceType: "import", confidence: this.conf(l.provenance), source: `soul:${this.pkgId}` });
      if (!r.ok || !r.id) return null;
      db.prepare("UPDATE decisions SET outcome = ?, outcome_status = ?, outcome_at = ?, lesson = ? WHERE node_id = ?").run(l.outcome, l.outcome_status, l.outcome || l.outcome_status ? this.now : null, l.lesson, r.id);
      db.prepare("UPDATE nodes SET content = ?, label = ? WHERE id = ?").run(decisionContent({ context: l.context, chosen: l.chosen, options: [], outcome: l.outcome, outcome_status: l.outcome_status, lesson: l.lesson }), `Lesson: ${short(l.lesson, 80)}`, r.id);
      this.record(l.id, r.id, section, l.provenance);
      return r.id;
    }
    const n = x as SoulItem;
    if (section === "open_items") {
      const kind = String(n.extra?.["kind"] ?? n.type) as "hypothesis" | "question" | "assumption";
      const r = createOpenItem(this.agentId, { kind, text: n.content, confidence: this.conf(n.provenance), loadBearing: !!n.extra?.["load_bearing"], sourceType: "import", writerAgentId: this.writer(n.provenance) });
      if (!r.ok || !r.id) return null;
      this.record(n.id, r.id, section, n.provenance); return r.id;
    }
    if (section === "commitments") {
      const due = n.extra?.["due"];
      const r = createCommitment(this.agentId, { title: n.content, to: String(n.extra?.["to"] ?? "user"), ...(typeof due === "string" ? { due } : {}), note: `imported from soul ${this.pkgId}`, writerAgentId: this.writer(n.provenance) });
      const id = (r.commitment as unknown as { node_id?: string; id?: string } | undefined);
      const nid = id?.node_id ?? id?.id;
      if (!r.ok || !nid) return null;
      db.prepare("UPDATE nodes SET source_type = 'import' WHERE id = ?").run(nid);
      this.record(n.id, nid, section, n.provenance); return nid;
    }
    const type = (section === "shared_facts" ? (n.type === "skill" ? "skill" : "semantic") : n.type) as NodeType;
    const id = writeNode(this.agentId, type, n.label, n.content, { importance: n.importance, sourceType: "import", confidence: this.conf(n.provenance), writerAgentId: this.writer(n.provenance), deduplicate: false, source: `soul:${this.pkgId}`, sensitivity: (n.sensitivity as Sensitivity) ?? "normal" });
    this.record(n.id, id, section, n.provenance);
    return id;
  }
  /** Apply a change to an existing local item (nodes: supersede, old version kept with the reason). */
  change(section: SoulSection, localId: string, x: AnyItem, reason: string): string | null {
    if (section === "lessons") {
      const l = x as SoulLesson;
      const db = this.db;
      const prev = db.prepare("SELECT context, chosen, outcome, outcome_status, lesson FROM decisions WHERE node_id = ?").get(localId);
      db.prepare("UPDATE decisions SET context = ?, chosen = ?, outcome = ?, outcome_status = ?, lesson = ?, updated_at = ? WHERE node_id = ?").run(l.context, l.chosen, l.outcome, l.outcome_status, l.lesson, this.now, localId);
      db.prepare("UPDATE nodes SET content = ?, updated_at = ?, evidence = ? WHERE id = ?").run(decisionContent({ context: l.context, chosen: l.chosen, options: [], outcome: l.outcome, outcome_status: l.outcome_status, lesson: l.lesson }), this.now, JSON.stringify({ previous: prev, reason }), localId);
      this.record(l.id, localId, section, l.provenance); return localId;
    }
    const n = x as SoulItem;
    const r = supersedeNode(this.agentId, localId, n.content, { reason, newLabel: n.label, writerAgentId: this.writer(n.provenance), sourceType: "import", confidence: this.conf(n.provenance) });
    if (!r.ok || !r.newId) return null;
    this.record(n.id, r.newId, section, n.provenance);
    return r.newId;
  }
  review(kind: string, section: SoulSection, originId: string, localId: string | null, label: string, base: AnyItem | undefined, ours: AnyItem | undefined, theirs: AnyItem | undefined, reason: string): string {
    const flags: string[] = [];
    if (REVIEW_SECTIONS.includes(section) && theirs && looksLikeIdentityRewrite(textOf(section, theirs))) flags.push("possible_identity_rewrite");
    const markers = kind === "conflict" ? `<<<<<<< ours (${this.agentId})\n${textOf(section, ours)}\n||||||| base\n${textOf(section, base)}\n=======\n${textOf(section, theirs)}\n>>>>>>> theirs (${this.pkgId} from ${this.srcAgent})` : null;
    const id = `rv-${sha256(`${this.pkgId}|${section}|${originId}|${kind}`).slice(0, 12)}`;
    this.db.prepare(`INSERT OR IGNORE INTO review_items (id, kind, section, status, package_id, origin_id, local_id, label, base_json, ours_json, theirs_json, markers, reason, flags_json, created_at)
                     VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, kind, section, this.pkgId, originId, localId, short(label, 200),
      base ? JSON.stringify(base) : null, ours ? JSON.stringify(ours) : null, theirs ? JSON.stringify(theirs) : null, markers, reason, JSON.stringify(flags), this.now);
    return id;
  }
  event(action: string, parent: string | null, detail: unknown) {
    this.db.prepare("INSERT INTO soul_events (at, action, package_id, parent_id, by, detail_json) VALUES (?, ?, ?, ?, ?, ?)").run(this.now, action, this.pkgId, parent, this.by, JSON.stringify(detail));
  }
}
const writerFor = (agentId: string, pkg: SoulPackage, cfg: BrainConfig, by: string, now: number) =>
  new Writer(agentId, pkg.package_id, pkg.source.agent_id, `agent ${pkg.source.agent_id}, ${pkg.profile}, created ${pkg.created_at}`, cfg, by, now);

function assertValid(pkg: SoulPackage, o: { trustedKeyIds?: string[]; requireSignature?: boolean }, what = "package") {
  const v = validateSoul(pkg, o);
  if (!v.ok) throw new Error(`${what} rejected: ${v.errors.slice(0, 5).join("; ")}`);
}
const kindFor = (s: SoulSection) => (s === "identity" ? "identity" : s === "goals" ? "goal" : s === "values" ? "value" : "change");
const noun = (s: SoulSection) => (s === "identity" ? "identity" : s === "goals" ? "goal" : s === "values" ? "value" : "item");

/**
 * Import a package into one agent's brain. `new` needs a brain without a
 * curated self (no identity, goals, values, skills, facts or decisions);
 * `merge` adds what is missing and sends every difference to review.
 * Identity, values and goals ALWAYS go to review — they never reach the
 * header without an accept.
 */
export function importSoul(agentId: string, pkg: SoulPackage, o: ImportOptions = {}): ImportReport {
  assertValid(pkg, o);
  const cfg = { ...DEFAULT_CONFIG, ...(o.config ?? {}) };
  const mode = o.mode ?? "new";
  const now = o.now ?? Date.now();
  const db = getDb(agentId);
  const rep: ImportReport = { packageId: pkg.package_id, mode, dryRun: !!o.dryRun, created: [], applied: [], review: [], unchanged: 0, keptOurs: 0, conflicts: 0, backup: null };
  if (mode === "new") {
    const curated = (db.prepare("SELECT COUNT(*) n FROM nodes WHERE status = 'active' AND type IN ('identity', 'goal', 'skill', 'procedural', 'semantic', 'schema', 'decision') AND source_type != 'import'").get() as { n: number }).n;
    const ident = identityText(db);
    if (curated > 0 || ident) throw new Error(`mode new needs a fresh brain, but ${agentId} already has ${curated} curated memories${ident ? " and an identity" : ""}; use --mode merge (differences go to review)`);
  }
  const w = writerFor(agentId, pkg, cfg, o.by ?? "admin", now);
  const plan: Array<() => void> = [];
  for (const s of SECTIONS) {
    for (const [origin, x] of sectionMap(pkg, s)) {
      const label = labelOf(s, x);
      const local = s === "identity" ? null : (localIdFor(db, origin, s) ?? matchByLabel(db, s, x));
      const ours = s === "identity" ? localItem(db, s, "", "identity") : local ? localItem(db, s, local, origin) : undefined;
      if (ours && digest(s, ours) === digest(s, x)) { rep.unchanged++; if (local) plan.push(() => w.record(origin, local, s)); continue; }
      if (REVIEW_SECTIONS.includes(s) || (ours && local)) {
        const kind = REVIEW_SECTIONS.includes(s) ? kindFor(s) : "conflict";
        const reason = REVIEW_SECTIONS.includes(s)
          ? (ours ? `imported ${noun(s)} differs from this brain's; needs review` : `new ${noun(s)} from an import; needs review before it reaches the header`)
          : "this brain already has a different version; kept ours, imported version needs review";
        if (kind === "conflict") rep.conflicts++;
        const entry: RepReview = { kind, section: s, origin, label: short(label, 90), reason, flags: REVIEW_SECTIONS.includes(s) && looksLikeIdentityRewrite(textOf(s, x)) ? ["possible_identity_rewrite"] : [] };
        rep.review.push(entry);
        plan.push(() => { entry.id = w.review(kind, s, origin, local, label, undefined, ours, x, reason); });
        continue;
      }
      const entry: RepEntry = { section: s, origin, label: short(label, 90) };
      rep.created.push(entry);
      plan.push(() => { entry.local = w.create(s, x) ?? undefined; });
    }
  }
  if (o.dryRun) return rep;
  rep.backup = o.backup ? o.backup() : null;
  db.transaction(() => {
    for (const f of plan) f();
    db.prepare("INSERT OR REPLACE INTO meta_kv (key, value) VALUES ('soul:last_package', ?)").run(pkg.package_id);
    w.event(`import:${mode}`, pkg.parent_id, { created: rep.created.length, unchanged: rep.unchanged, review: rep.review.length, backup: rep.backup });
  })();
  return rep;
}

/**
 * Three-way merge of a fork back into `agentId` (the "ours" side).
 * base = the package the fork started from; theirs = the fork's export (its parent_id is base).
 * Per item: unchanged | theirs-only (applied for skills / facts / lessons /
 * open items when soulMergeApplyTheirs — as a supersede with history;
 * identity / values / goals → review) | ours-only (kept) | both changed
 * differently → conflict review item with markers. Removals in theirs → review.
 */
export function mergeSoul(agentId: string, base: SoulPackage, theirs: SoulPackage, o: Omit<ImportOptions, "mode"> & { force?: boolean } = {}): ImportReport {
  assertValid(base, o, "base package"); assertValid(theirs, o, "theirs package");
  if (base.profile !== "full" || theirs.profile !== "full") throw new Error("merge needs full-profile packages (soul fork or soul export --profile full); a compact package leaves items out, which would look like deletions");
  if (theirs.parent_id !== base.package_id && !o.force) throw new Error(`theirs.parent_id (${theirs.parent_id ?? "none"}) is not the base package ${base.package_id}; wrong base? (--force merges anyway)`);
  const cfg = { ...DEFAULT_CONFIG, ...(o.config ?? {}) };
  const now = o.now ?? Date.now();
  const db = getDb(agentId);
  const ours = exportSoul(db, { agentId, profile: "full", includeOpenItems: base.options.include_open_items, includeSensitive: base.options.include_sensitive, config: { ...cfg, soulMinFactConfidence: base.options.min_fact_confidence }, parentId: null, now });
  const rep: ImportReport = { packageId: theirs.package_id, mode: "three-way", dryRun: !!o.dryRun, created: [], applied: [], review: [], unchanged: 0, keptOurs: 0, conflicts: 0, backup: null };
  const w = writerFor(agentId, theirs, cfg, o.by ?? "admin", now);
  const plan: Array<() => void> = [];
  for (const s of SECTIONS) {
    const mb = sectionMap(base, s), mo = sectionMap(ours, s), mt = sectionMap(theirs, s);
    const keys = [...new Set([...mb.keys(), ...mo.keys(), ...mt.keys()])].sort();
    for (const k of keys) {
      const b = mb.get(k), oo = mo.get(k), t = mt.get(k);
      const hb = digest(s, b), ho = digest(s, oo), ht = digest(s, t);
      if (ht === hb) { if (ho === hb) rep.unchanged++; else rep.keptOurs++; continue; }
      if (ho === ht) { rep.unchanged++; continue; }
      const label = labelOf(s, (t ?? oo ?? b)!);
      const local = s === "identity" ? null : localIdFor(db, k, s);
      const queue = (kind: string, reason: string, flags: string[] = []) => {
        const entry: RepReview = { kind, section: s, origin: k, label: short(label, 90), reason, flags };
        rep.review.push(entry);
        plan.push(() => { entry.id = w.review(kind, s, k, local, label, b, oo, t, reason); });
      };
      if (ho !== hb) {
        rep.conflicts++;
        queue("conflict", !t ? "theirs removed it, ours changed it" : !oo ? "ours removed it, theirs changed it" : !b ? "added on both sides with different content" : "changed on both sides");
        continue;
      }
      if (!t) { queue("removal", "removed in the fork; retract here?"); continue; }
      if (REVIEW_SECTIONS.includes(s) || !cfg.soulMergeApplyTheirs) {
        queue(kindFor(s), `${b ? "changed" : "added"} in the fork (${theirs.source.agent_id}); needs review`, REVIEW_SECTIONS.includes(s) && looksLikeIdentityRewrite(textOf(s, t)) ? ["possible_identity_rewrite"] : []);
        continue;
      }
      const entry: RepEntry = { section: s, origin: k, label: short(label, 90) };
      if (!b || !local) { rep.created.push(entry); plan.push(() => { entry.local = w.create(s, t) ?? undefined; }); }
      else { rep.applied.push(entry); plan.push(() => { entry.local = w.change(s, local, t, `merged from fork ${theirs.package_id} (${theirs.source.agent_id})`) ?? undefined; }); }
    }
  }
  if (o.dryRun) return rep;
  rep.backup = o.backup ? o.backup() : null;
  db.transaction(() => {
    for (const f of plan) f();
    w.event("merge", base.package_id, { base: base.package_id, created: rep.created.length, applied: rep.applied.length, review: rep.review.length, conflicts: rep.conflicts, keptOurs: rep.keptOurs, unchanged: rep.unchanged, backup: rep.backup });
  })();
  return rep;
}

export function formatImportReport(r: ImportReport): string {
  const L = [`${r.dryRun ? "DRY RUN: " : ""}soul ${r.mode === "three-way" ? "merge" : `import (${r.mode})`} ${r.packageId}: created ${r.created.length}, applied ${r.applied.length}, unchanged ${r.unchanged}, kept ours ${r.keptOurs}, to review ${r.review.length} (${r.conflicts} conflicts)`];
  if (r.backup) L.push(`backup ${r.backup}`);
  const by: Record<string, number> = {};
  for (const c of r.created) by[c.section] = (by[c.section] ?? 0) + 1;
  if (r.created.length) L.push(`created: ${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  for (const a of r.applied) L.push(`applied [${a.section}] ${a.label}`);
  for (const v of r.review) L.push(`review ${v.id ?? "(dry run)"} ${v.kind} [${v.section}] ${v.label}: ${v.reason}${v.flags.length ? ` [${v.flags.join(", ")}]` : ""}`);
  if (r.review.length && !r.dryRun) L.push("Nothing in review was applied. Review with: xanima-server soul review list --agent <id> (then accept | reject).");
  return L.join("\n");
}

// ─── review queue ───────────────────────────────────────────────────────────

function rowToReview(r: Record<string, unknown>): ReviewItem {
  const j = (k: string) => (r[k] ? safeParse(String(r[k])) : null);
  return { id: String(r["id"]), kind: String(r["kind"]), section: String(r["section"]), status: String(r["status"]), package_id: (r["package_id"] as string) ?? null, origin_id: (r["origin_id"] as string) ?? null,
    local_id: (r["local_id"] as string) ?? null, label: String(r["label"]), base: j("base_json"), ours: j("ours_json"), theirs: j("theirs_json"), markers: (r["markers"] as string) ?? null,
    reason: (r["reason"] as string) ?? null, flags: (safeParse(String(r["flags_json"] ?? "[]")) as string[]) ?? [], created_at: Number(r["created_at"]),
    resolved_at: (r["resolved_at"] as number) ?? null, resolved_by: (r["resolved_by"] as string) ?? null, resolution_note: (r["resolution_note"] as string) ?? null };
}
export function listReviews(db: Database.Database, o: { status?: "pending" | "accepted" | "rejected" | "logged" | "all"; limit?: number; kind?: string } = {}): ReviewItem[] {
  if (!tableExists(db, "review_items")) return [];
  const st = o.status ?? "pending";
  const lim = Math.max(1, Math.min(o.limit ?? 200, 1000));
  const kind = o.kind ?? null;
  const rows = (st === "all"
    ? db.prepare("SELECT * FROM review_items WHERE (? IS NULL OR kind = ?) ORDER BY created_at, id LIMIT ?").all(kind, kind, lim)
    : db.prepare("SELECT * FROM review_items WHERE status = ? AND (? IS NULL OR kind = ?) ORDER BY created_at, id LIMIT ?").all(st, kind, kind, lim)) as Array<Record<string, unknown>>;
  return rows.map(rowToReview);
}
export function getReview(db: Database.Database, idOrPrefix: string): ReviewItem | null {
  if (!tableExists(db, "review_items") || !idOrPrefix) return null;
  const rows = db.prepare("SELECT * FROM review_items WHERE id = ? OR id LIKE ? LIMIT 2").all(idOrPrefix, `${idOrPrefix}%`) as Array<Record<string, unknown>>;
  return rows.length === 1 ? rowToReview(rows[0]!) : null;
}
export function reviewCounts(db: Database.Database): { pending: number; byKind: Record<string, number>; flagged: number } {
  const out = { pending: 0, byKind: {} as Record<string, number>, flagged: 0 };
  if (!tableExists(db, "review_items")) return out;
  for (const r of db.prepare("SELECT kind, flags_json FROM review_items WHERE status = 'pending'").all() as Array<{ kind: string; flags_json: string }>) {
    out.pending++; out.byKind[r.kind] = (out.byKind[r.kind] ?? 0) + 1; if (r.flags_json !== "[]") out.flagged++;
  }
  return out;
}
export function formatReview(r: ReviewItem, full = false): string {
  const s = r.section as SoulSection;
  if (r.kind === "quarantine") {
    const op = r.theirs as QuarantineOp | null;
    const head = `${r.id} [${r.status}] quarantine (${r.section}) ${short(r.label, 80)}${r.flags.length ? ` ⚠ ${r.flags.join(", ")}` : ""}: ${r.reason ?? ""}`;
    if (!full) return head;
    return [head, `  proposed: ${op ? describeQuarantineOp(op) : "(missing)"}`,
      ...(r.resolved_at ? [`  resolved by ${r.resolved_by} at ${iso(r.resolved_at)}${r.resolution_note ? `: ${r.resolution_note}` : ""}`] : [])].join("\n");
  }
  const head = `${r.id} [${r.status}] ${r.kind} (${r.section}) ${short(r.label, 80)}${r.flags.length ? ` ⚠ ${r.flags.join(", ")}` : ""}: ${r.reason ?? ""}`;
  if (!full) return head;
  return [head,
    ...(r.markers ? [r.markers] : [`  ours:   ${short(textOf(s, r.ours as AnyItem), 400)}`, `  theirs: ${short(textOf(s, r.theirs as AnyItem), 400)}`]),
    ...(r.package_id ? [`  package ${r.package_id}`] : []),
    ...(r.resolved_at ? [`  resolved by ${r.resolved_by} at ${iso(r.resolved_at)}${r.resolution_note ? `: ${r.resolution_note}` : ""}`] : [])].join("\n");
}

/** Accept a review item: apply "theirs" through the normal write paths (supersede / goal versions keep history). */
export function acceptReview(agentId: string, idOrPrefix: string, o: { by?: string; note?: string; now?: number; config?: Partial<BrainConfig> } = {}): { ok: boolean; error?: string; applied?: string; id?: string } {
  const db = getDb(agentId);
  const r = getReview(db, idOrPrefix);
  if (!r) return { ok: false, error: `review item ${idOrPrefix} not found (or ambiguous)` };
  if (r.status !== "pending") return { ok: false, error: `review item ${r.id} is already ${r.status}` };
  const cfg = { ...DEFAULT_CONFIG, ...(o.config ?? {}) };
  const now = o.now ?? Date.now();
  const by = o.by ?? "admin";
  const s = r.section as SoulSection;
  const t = r.theirs as AnyItem | null;
  const srcWriter = (t as { provenance?: SoulProvenance } | null)?.provenance?.writer ?? "import";
  const w = new Writer(agentId, r.package_id ?? "manual", srcWriter, `review ${r.id}`, cfg, by, now);
  let applied = "";
  const localLive = r.local_id && db.prepare("SELECT 1 FROM nodes WHERE id = ? AND status = 'active'").get(r.local_id);
  const run = db.transaction(() => {
    if (r.kind === "quarantine") {
      if (!t) throw new Error("quarantined op is missing");
      applied = applyQuarantinedOp(agentId, t as unknown as QuarantineOp, by, (tool, args, writer) => dispatchContinuityTool(tool, agentId, args, cfg, { writerAgentId: writer }));
    } else if (r.kind === "removal") {
      if (localLive) { const x = retractNode(agentId, r.local_id!, `removed in soul ${r.package_id ?? ""} (review ${r.id} accepted by ${by})`, { by }); applied = x.ok ? `retracted ${r.local_id!.slice(0, 8)}` : `nothing to retract (${x.error ?? ""})`; }
      else applied = "nothing to retract";
    } else if (!t) {
      applied = "theirs is absent; nothing applied";
    } else if (s === "identity") {
      updateSelfModelField(agentId, "identity", (t as { text: string }).text);
      applied = "identity updated";
    } else if (s === "goals") {
      const g = t as SoulGoal;
      const cur = r.local_id ? currentGoalRow(agentId, r.local_id) : null;
      if (cur) {
        const u = updateGoal(agentId, cur.lineage_id, { action: "update", title: g.title, priority: g.priority, successCriteria: g.success_criteria ?? undefined, reason: `soul review ${r.id} accepted by ${by}`, writerAgentId: by });
        if (!u.ok) throw new Error(u.error ?? "goal update failed");
        w.record(g.id, cur.lineage_id, "goals");
        applied = `goal ${cur.lineage_id.slice(0, 8)} updated to v${u.goal?.version ?? "?"}`;
      } else {
        const sg = setGoal(agentId, { title: g.title, priority: g.priority, successCriteria: g.success_criteria ?? undefined, keywords: g.keywords?.length ? g.keywords : undefined, writerAgentId: g.provenance?.writer ?? by, sourceType: "import" });
        if (!sg.ok || !sg.goal) throw new Error(sg.error ?? "goal create failed");
        w.record(g.id, sg.goal.lineage_id, "goals");
        applied = `goal ${sg.goal.lineage_id.slice(0, 8)} created`;
      }
    } else if (s === "lessons" && r.local_id && db.prepare("SELECT 1 FROM decisions WHERE node_id = ?").get(r.local_id)) {
      w.change(s, r.local_id, t, `soul review ${r.id} accepted by ${by}`);
      applied = `lesson ${r.local_id.slice(0, 8)} updated (previous kept in evidence)`;
    } else if (localLive) {
      const id = w.change(s, r.local_id!, t, `soul review ${r.id} accepted by ${by}`);
      applied = `replaced ${r.local_id!.slice(0, 8)} with ${String(id).slice(0, 8)} (old version kept as superseded)`;
    } else if (s === "values") {
      const n = t as SoulItem;
      const id = writeNode(agentId, "identity", n.label, n.content, { importance: n.importance, sourceType: "import", confidence: w.conf(n.provenance), writerAgentId: w.writer(n.provenance), deduplicate: false });
      w.record(n.id, id, s, n.provenance);
      applied = `value ${id.slice(0, 8)} added`;
    } else {
      const id = w.create(s, t);
      applied = `created ${String(id).slice(0, 8)}`;
    }
    db.prepare("UPDATE review_items SET status = 'accepted', resolved_at = ?, resolved_by = ?, resolution_note = ? WHERE id = ?").run(now, by, o.note ? `${o.note} (${applied})` : applied, r.id);
    w.event("review:accept", null, { id: r.id, kind: r.kind, applied });
  });
  try { run(); } catch (x) { return { ok: false, error: x instanceof Error ? x.message : String(x) }; }
  return { ok: true, applied, id: r.id };
}
export function rejectReview(agentId: string, idOrPrefix: string, o: { by?: string; reason?: string; now?: number } = {}): { ok: boolean; error?: string; id?: string } {
  const db = getDb(agentId);
  const r = getReview(db, idOrPrefix);
  if (!r) return { ok: false, error: `review item ${idOrPrefix} not found (or ambiguous)` };
  if (r.status !== "pending") return { ok: false, error: `review item ${r.id} is already ${r.status}` };
  const now = o.now ?? Date.now();
  const by = o.by ?? "admin";
  db.prepare("UPDATE review_items SET status = 'rejected', resolved_at = ?, resolved_by = ?, resolution_note = ? WHERE id = ?").run(now, by, o.reason ?? "rejected", r.id);
  db.prepare("INSERT INTO soul_events (at, action, package_id, parent_id, by, detail_json) VALUES (?, 'review:reject', ?, NULL, ?, ?)").run(now, r.package_id, by, JSON.stringify({ id: r.id, kind: r.kind, reason: o.reason ?? null }));
  return { ok: true, id: r.id };
}

// ─── SQLite subset dump + summary ───────────────────────────────────────────

/** Write the package's node subset (+ live edges among them) into an empty SQLite database. */
export function writeSoulSqlite(src: Database.Database, pkg: SoulPackage, out: Database.Database): { nodes: number; edges: number } {
  out.exec(`CREATE TABLE IF NOT EXISTS soul_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, origin_id TEXT NOT NULL, section TEXT NOT NULL, type TEXT NOT NULL, label TEXT NOT NULL, content TEXT NOT NULL, importance REAL, confidence_score REAL, source_type TEXT, writer_agent_id TEXT, sensitivity TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS edges (id TEXT PRIMARY KEY, from_id TEXT NOT NULL, to_id TEXT NOT NULL, type TEXT NOT NULL, weight REAL, created_at INTEGER);`);
  const ins = out.prepare("INSERT OR REPLACE INTO nodes VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const meta = out.prepare("INSERT OR REPLACE INTO soul_meta VALUES (?, ?)");
  const ids = new Set<string>();
  out.transaction(() => {
    meta.run("format", SOUL_FORMAT); meta.run("package_id", pkg.package_id); meta.run("content_hash", pkg.integrity.content_hash);
    for (const s of NODE_SECTIONS) {
      if (s === "shared_facts") continue;
      for (const x of ((pkg.content as unknown as Record<string, SoulItem[] | undefined>)[s] ?? [])) {
        const local = localIdFor(src, x.id, s) ?? x.id;
        const r = src.prepare(`SELECT ${NODE_COLS} FROM nodes WHERE id = ?`).get(local) as NodeRow | undefined;
        if (!r) continue;
        ids.add(r.id);
        ins.run(r.id, x.id, s, r.type, r.label, r.content, r.importance, r.confidence_score, r.source_type, r.writer_agent_id, r.sensitivity, r.created_at, r.updated_at);
      }
    }
  })();
  let edges = 0;
  const ie = out.prepare("INSERT OR REPLACE INTO edges VALUES (?, ?, ?, ?, ?, ?)");
  out.transaction(() => {
    for (const e of src.prepare("SELECT id, from_id, to_id, type, weight, created_at FROM edges WHERE valid_until IS NULL").all() as Array<{ id: string; from_id: string; to_id: string; type: string; weight: number; created_at: number }>) {
      if (ids.has(e.from_id) && ids.has(e.to_id)) { ie.run(e.id, e.from_id, e.to_id, e.type, e.weight, e.created_at); edges++; }
    }
  })();
  return { nodes: ids.size, edges };
}

export function soulSummary(pkg: SoulPackage, bytes?: number): string {
  const c = pkg.stats.counts;
  return [`${pkg.package_id} (${SOUL_FORMAT}, ${pkg.profile}${pkg.fork ? ", fork" : ""}) from ${pkg.source.agent_id}${pkg.parent_id ? `, parent ${pkg.parent_id}` : ""}`,
    `  identity ${c["identity"] ? "yes" : "none"} · values ${c["values"]} · goals ${c["goals"]} · skills ${c["skills"]} · lessons ${c["lessons"]} · facts ${c["facts"]}${c["open_items"] !== undefined ? ` · open items ${c["open_items"]} · commitments ${c["commitments"]}` : ""}${c["shared_facts"] !== undefined ? ` · shared ${c["shared_facts"]}` : ""}`,
    `  ~${pkg.stats.approx_tokens} tokens (${pkg.stats.content_chars} content chars${bytes ? `, ${bytes} bytes on disk` : ""})${pkg.stats.trimmed ? `, ${pkg.stats.trimmed} lower-ranked items trimmed to fit the budget` : ""}`,
    `  sha256 ${pkg.integrity.content_hash}${pkg.signature ? ` · signed ed25519 key ${pkg.signature.key_id}` : " · unsigned"}`,
    `  excluded: raw episodes, retired / superseded / expired / draft items${pkg.options.include_sensitive ? "" : ", sensitive items"}${pkg.options.include_shared ? "" : ", shared-brain items"}`].join("\n");
}
