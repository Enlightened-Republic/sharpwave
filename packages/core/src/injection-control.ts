// packages/core/src/injection-control.ts
//
// Xanima 0.5.0 — controllable injection.
//
// Two layers are kept apart on purpose:
//   • the always-on HEADER (identity, goals / alignment notes, operational rules) — switched
//     only by `injectionCategories` (operator config), never by a per-turn focus;
//   • selective RECALL (query-matched memories + subscribed room items) — shaped per turn by
//     `brain_focus` (suppress / boost a topic, project, room or node type for N turns or a task)
//     and by the sensitivity labels on each memory.
//
// Focus state lives in the brain's meta_kv ("injection_focus"), so it survives restarts and
// is per agent. `tickFocus` is called once per injected turn; a turn-limited focus expires by
// itself and recall is restored. Nothing here needs an LLM.

import type Database from "better-sqlite3";
import type { BrainConfig, InjectionCategories } from "./types.js";

export type FocusKind = "topic" | "project" | "room" | "type";
export interface FocusRule { kind: FocusKind; value: string }
export interface FocusState {
  suppress: FocusRule[];
  boost: FocusRule[];
  /** Turns left (counted per injected turn), or null for a task-scoped focus (until cleared). */
  turnsLeft: number | null;
  task: string | null;
  setAt: number;
}

const META_KEY = "injection_focus";
const KINDS: FocusKind[] = ["topic", "project", "room", "type"];
const MAX_RULES = 12;
const TASK_MAX_TURNS = 200;
export const FOCUS_BOOST = 1.5;

export const DEFAULT_INJECTION_CATEGORIES: Required<InjectionCategories> = {
  identity: true, goals: true, rules: true, recall: true, decisions: true, rooms: true, sensitive: "relevant",
};

export function injectionCategories(cfg: Partial<BrainConfig>): Required<InjectionCategories> {
  return { ...DEFAULT_INJECTION_CATEGORIES, ...(cfg.injectionCategories ?? {}) };
}

/** "project:alpha" | {kind, value} | "alpha" (→ topic). */
export function parseFocusRule(x: unknown): FocusRule | { error: string } {
  if (x && typeof x === "object") {
    const o = x as Record<string, unknown>;
    const kind = String(o["kind"] ?? "topic") as FocusKind;
    const value = String(o["value"] ?? "").trim();
    if (!KINDS.includes(kind)) return { error: `focus kind must be one of ${KINDS.join("|")}` };
    if (!value || value.length > 80) return { error: "focus value must be 1–80 characters" };
    return { kind, value: value.toLowerCase() };
  }
  if (typeof x !== "string" || !x.trim()) return { error: "each focus entry must be a string like \"room:team\" or {kind, value}" };
  const m = /^(topic|project|room|type):(.+)$/i.exec(x.trim());
  const kind = (m ? m[1]!.toLowerCase() : "topic") as FocusKind;
  const value = (m ? m[2]! : x).trim().toLowerCase();
  if (!value || value.length > 80) return { error: "focus value must be 1–80 characters" };
  return { kind, value };
}

export function readFocus(db: Database.Database): FocusState | null {
  try {
    const row = db.prepare("SELECT value FROM meta_kv WHERE key = ?").get(META_KEY) as { value: string } | undefined;
    if (!row?.value) return null;
    const f = JSON.parse(row.value) as FocusState;
    if (!f || (!f.suppress?.length && !f.boost?.length)) return null;
    if (f.turnsLeft !== null && f.turnsLeft <= 0) return null;
    return f;
  } catch { return null; }
}

function writeFocus(db: Database.Database, f: FocusState | null): void {
  if (!f) db.prepare("DELETE FROM meta_kv WHERE key = ?").run(META_KEY);
  else db.prepare("INSERT OR REPLACE INTO meta_kv (key, value) VALUES (?, ?)").run(META_KEY, JSON.stringify(f));
}

export interface FocusArgs { suppress?: unknown; boost?: unknown; ttl?: unknown; task?: unknown; clear?: unknown }

/** brain_focus: set (replace) or clear the focus. Returns a human summary. */
export function setFocus(db: Database.Database, args: FocusArgs, cfg: Partial<BrainConfig>, now = Date.now()): { ok: boolean; text: string; state?: FocusState | null } {
  if (args.clear === true) { writeFocus(db, null); return { ok: true, text: "Focus cleared — recall is back to normal.", state: null }; }
  const rules = (v: unknown): FocusRule[] | { error: string } => {
    if (v === undefined || v === null) return [];
    const arr = Array.isArray(v) ? v : [v];
    if (arr.length > MAX_RULES) return { error: `at most ${MAX_RULES} entries` };
    const out: FocusRule[] = [];
    for (const x of arr) { const r = parseFocusRule(x); if ("error" in r) return r; out.push(r); }
    return out;
  };
  const sup = rules(args.suppress); if ("error" in sup) return { ok: false, text: `Error: suppress: ${sup.error}` };
  const bst = rules(args.boost); if ("error" in bst) return { ok: false, text: `Error: boost: ${bst.error}` };
  if (!sup.length && !bst.length) return { ok: false, text: "Error: give suppress and/or boost (or clear: true)" };
  let turnsLeft: number | null = Math.max(1, Math.floor(cfg.focusDefaultTtl ?? 3));
  let task: string | null = null;
  const ttl = args.ttl;
  if (ttl === "task" || (typeof args.task === "string" && args.task.trim())) {
    turnsLeft = null;
    task = typeof args.task === "string" && args.task.trim() ? args.task.trim().slice(0, 120) : "current task";
  } else if (ttl !== undefined && ttl !== null && ttl !== "") {
    const n = typeof ttl === "number" ? ttl : Number(String(ttl).replace(/\s*turns?$/i, ""));
    if (!Number.isInteger(n) || n < 1 || n > 50) return { ok: false, text: "Error: ttl must be 1–50 turns or \"task\"" };
    turnsLeft = n;
  }
  const state: FocusState = { suppress: sup, boost: bst, turnsLeft, task, setAt: now };
  writeFocus(db, state);
  return { ok: true, state, text: `Focus set: ${describeFocus(state)}. It applies to recall only — identity, goals and rules in the header are unaffected.` };
}

export function describeFocus(f: FocusState): string {
  const r = (x: FocusRule[]) => x.map((y) => `${y.kind}:${y.value}`).join(", ");
  return [f.suppress.length ? `suppress ${r(f.suppress)}` : "", f.boost.length ? `boost ${r(f.boost)}` : "",
    f.turnsLeft === null ? `until the task "${f.task}" ends (brain_focus {"clear":true})` : `for ${f.turnsLeft} more turn${f.turnsLeft === 1 ? "" : "s"}`].filter(Boolean).join("; ");
}

/** Count one injected turn. Returns the focus that applied to THIS turn (before the tick). */
export function tickFocus(db: Database.Database): FocusState | null {
  const f = readFocus(db);
  if (!f) return null;
  if (f.turnsLeft === null) {
    const used = ((f as FocusState & { used?: number }).used ?? 0) + 1;
    writeFocus(db, used >= TASK_MAX_TURNS ? null : { ...f, used } as FocusState);
    return f;
  }
  const left = f.turnsLeft - 1;
  writeFocus(db, left <= 0 ? null : { ...f, turnsLeft: left });
  return f;
}

/** Minimal shape of anything that can be injected as a recall line. */
export interface Injectable {
  type: string; label: string; content: string;
  sensitivity?: string | null; scope_tags?: string | null; source?: string | null;
  /** Set for room items. */
  room?: string | null;
  activation?: number;
}

const words = (s: string) => new Set((s.toLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []).filter((w) => !STOP.has(w)));
const STOP = new Set(["the", "and", "for", "with", "that", "this", "what", "about", "from", "your", "you", "are", "was", "have", "has", "not", "but", "all", "any", "can", "how", "who", "why", "when", "does", "did", "our", "out", "get", "let", "now"]);

function tagsOf(n: Injectable): string[] {
  const raw = n.scope_tags;
  if (!raw) return [];
  try { const j = JSON.parse(raw); if (Array.isArray(j)) return j.map((x) => String(x).toLowerCase()); } catch { /* comma list */ }
  return String(raw).split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
}

export function matchesRule(n: Injectable, r: FocusRule): boolean {
  switch (r.kind) {
    case "type": return n.type.toLowerCase() === r.value || (r.value === "fact" && n.type === "semantic") || (r.value === "lesson" && (n.type === "skill" || n.type === "procedural"));
    case "room": return (n.room ?? "").toLowerCase() === r.value;
    case "project": return tagsOf(n).includes(r.value) || tagsOf(n).includes(`project:${r.value}`) || new RegExp(`\\b${escapeRe(r.value)}\\b`, "i").test(`${n.label}`);
    case "topic": return new RegExp(`\\b${escapeRe(r.value)}`, "i").test(`${n.label}\n${n.content}`);
  }
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A sensitive memory is "explicitly relevant" when the turn names its topic (a label word or tag). */
export function sensitiveRelevant(n: Injectable, query: string): boolean {
  const q = words(query);
  if (!q.size) return false;
  for (const w of words(n.label)) if (q.has(w)) return true;
  for (const t of tagsOf(n)) if (q.has(t)) return true;
  return false;
}

export interface ControlReport { suppressedByFocus: number; boosted: number; sensitiveHeld: number; categoryDropped: number; focus: FocusState | null }

/**
 * Shape a recall list for injection: category switches, sensitivity, focus suppress / boost.
 * Order is preserved except that boosted items move up (activation × FOCUS_BOOST when present).
 */
export function applyInjectionControls<T extends Injectable>(items: T[], o: { query: string; focus: FocusState | null; config: Partial<BrainConfig> }): { items: T[]; report: ControlReport } {
  const cats = injectionCategories(o.config);
  const rep: ControlReport = { suppressedByFocus: 0, boosted: 0, sensitiveHeld: 0, categoryDropped: 0, focus: o.focus };
  if (!cats.recall) return { items: [], report: { ...rep, categoryDropped: items.length } };
  const kept: Array<{ n: T; score: number; i: number }> = [];
  items.forEach((n, i) => {
    if (!cats.decisions && n.type === "decision") { rep.categoryDropped++; return; }
    if (!cats.rooms && n.room) { rep.categoryDropped++; return; }
    if (n.sensitivity === "sensitive") {
      if (cats.sensitive === "never" || (cats.sensitive === "relevant" && !sensitiveRelevant(n, o.query))) { rep.sensitiveHeld++; return; }
    }
    if (o.focus?.suppress.some((r) => matchesRule(n, r))) { rep.suppressedByFocus++; return; }
    let score = typeof n.activation === "number" ? n.activation : items.length - i;
    if (o.focus?.boost.some((r) => matchesRule(n, r))) { score *= FOCUS_BOOST; rep.boosted++; }
    kept.push({ n, score, i });
  });
  if (rep.boosted) kept.sort((a, b) => b.score - a.score || a.i - b.i);
  return { items: kept.map((k) => k.n), report: rep };
}
