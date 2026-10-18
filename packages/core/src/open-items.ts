/**
 * Xanima 0.3.0 — hypotheses, open questions and assumptions as first-class
 * nodes (types `hypothesis` | `question` | `assumption`) with a structured row
 * in `open_items`: status (open | supported | refuted | closed), evidence for /
 * against, confidence (node belief metadata), links (`about` edges to goals,
 * plans, decisions …), and a load-bearing flag for assumptions.
 *
 * Heuristic capture (no LLM) from the agent's own replies: "I think X because
 * Y" → hypothesis, "open question: X" → question, "assuming X" → assumption.
 * Captured items are drafts that expire (soft) unless touched.
 */
import { getDb, bumpWriteCounter } from "./db.js";
import { writeNode, getNode } from "./nodes.js";
import { writeEdge } from "./edges.js";
import { parseConfidence, confidenceLevel } from "./belief-meta.js";
import { tokenSet, jaccard, REPORTED } from "./decisions.js";
import { deriveKeywords } from "./goals.js";
import { clean, safeJsonArr, resolveRef, sentencesOf, ago, DAY, HOUR } from "./continuity-util.js";
import type { BrainConfig, ConfidenceLevel, SourceType } from "./types.js";

export type OpenKind = "hypothesis" | "question" | "assumption";
export const OPEN_KINDS: OpenKind[] = ["hypothesis", "question", "assumption"];
export type OpenStatus = "open" | "supported" | "refuted" | "closed";
export const OPEN_STATUSES: OpenStatus[] = ["open", "supported", "refuted", "closed"];

export interface Evidence { text: string; node_id?: string; at: number }
export interface OpenItemRow {
  node_id: string; kind: OpenKind; text: string; status: OpenStatus; load_bearing: number;
  evidence_for: string; evidence_against: string; answer: string | null; close_reason: string | null;
  auto_extracted: number; draft_status: string | null; keywords_json: string; contradicted_at: number | null;
  last_surfaced_at: number | null; surfaced_count: number; created_at: number; updated_at: number; closed_at: number | null;
}
export interface OpenItemView extends OpenItemRow { confidence: string; confidence_score: number; links: Array<{ id: string; type: string; label: string }> }

const KIND_LABEL: Record<OpenKind, string> = { hypothesis: "Hypothesis", question: "Question", assumption: "Assumption" };

export interface CreateOpenItemInput {
  kind: OpenKind; text: string; confidence?: ConfidenceLevel | number; loadBearing?: boolean; links?: string[];
  evidenceFor?: string[]; evidenceAgainst?: string[]; autoExtracted?: boolean; sourceType?: SourceType;
  writerAgentId?: string; evidence?: string[]; now?: number;
}

export function getOpenItem(agentId: string, idOrPrefix: string): OpenItemView | null {
  const db = getDb(agentId);
  const id = idOrPrefix.trim();
  let row = db.prepare("SELECT * FROM open_items WHERE node_id = ?").get(id) as OpenItemRow | undefined;
  if (!row && id.length >= 8) {
    const rows = db.prepare("SELECT * FROM open_items WHERE node_id LIKE ? LIMIT 2").all(id + "%") as OpenItemRow[];
    if (rows.length === 1) row = rows[0];
  }
  return row ? view(agentId, row) : null;
}

function view(agentId: string, r: OpenItemRow): OpenItemView {
  const db = getDb(agentId);
  const n = db.prepare("SELECT confidence, confidence_score FROM nodes WHERE id = ?").get(r.node_id) as { confidence: string; confidence_score: number } | undefined;
  const links = db.prepare(`SELECT n.id, n.type, n.label FROM edges e JOIN nodes n ON n.id = e.to_id WHERE e.from_id = ? AND e.type = 'about' AND e.valid_until IS NULL LIMIT 8`).all(r.node_id) as OpenItemView["links"];
  return { ...r, confidence: n?.confidence ?? "medium", confidence_score: n?.confidence_score ?? 0.6, links };
}

function linkAll(agentId: string, id: string, refs: string[] | undefined, writer: string): string | null {
  for (const ref of refs ?? []) {
    const t = resolveRef(agentId, ref);
    if (!t) return `link target ${ref} not found`;
    writeEdge(agentId, id, t.id, "about", { writerAgentId: writer });
  }
  return null;
}

export function createOpenItem(agentId: string, input: CreateOpenItemInput): { ok: boolean; error?: string; id?: string } {
  if (!OPEN_KINDS.includes(input.kind)) return { ok: false, error: `kind must be one of ${OPEN_KINDS.join(", ")}` };
  const text = clean(input.text, 600);
  if (text.length < 4) return { ok: false, error: `${input.kind} text is required` };
  const conf = input.confidence !== undefined ? parseConfidence(input.confidence) : null;
  if (input.confidence !== undefined && !conf) return { ok: false, error: "confidence must be low|medium|high|certain or a number 0..1" };
  for (const ref of input.links ?? []) if (!resolveRef(agentId, ref)) return { ok: false, error: `link target ${ref} not found` };
  const now = input.now ?? Date.now();
  const auto = input.autoExtracted === true;
  const lb = input.kind === "assumption" && input.loadBearing === true;
  const id = writeNode(agentId, input.kind, `${KIND_LABEL[input.kind]}: ${text.slice(0, 90)}`, `${KIND_LABEL[input.kind]}${lb ? " (load-bearing)" : ""}: ${text}`, {
    importance: auto ? 0.45 : lb ? 0.75 : 0.6, source: auto ? `${input.kind}:auto` : input.kind, deduplicate: false,
    writerAgentId: input.writerAgentId ?? agentId,
    ...(input.sourceType ? { sourceType: input.sourceType } : auto ? { sourceType: "self_observation" as const } : {}),
    ...(conf ? { confidence: conf.score } : auto ? { confidence: "low" as const } : {}),
    ...(input.evidence?.length ? { evidence: input.evidence.slice(0, 20) } : {}),
  });
  const ev = (xs: string[] | undefined) => JSON.stringify((xs ?? []).map((t) => ({ text: clean(t, 400), at: now })).filter((e) => e.text));
  getDb(agentId).prepare(`INSERT INTO open_items (node_id, kind, text, status, load_bearing, evidence_for, evidence_against, auto_extracted, draft_status, keywords_json, created_at, updated_at)
                          VALUES (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, input.kind, text, lb ? 1 : 0, ev(input.evidenceFor), ev(input.evidenceAgainst), auto ? 1 : 0, auto ? "pending" : null, JSON.stringify(deriveKeywords(text)), now, now);
  linkAll(agentId, id, input.links, input.writerAgentId ?? agentId);
  recompute(agentId, id, now);
  bumpWriteCounter(getDb(agentId));
  return { ok: true, id };
}

/** Confidence from evidence balance; a load-bearing assumption with more against than for is contradicted. */
function recompute(agentId: string, id: string, now: number): void {
  const db = getDb(agentId);
  const r = db.prepare("SELECT * FROM open_items WHERE node_id = ?").get(id) as OpenItemRow;
  const f = safeJsonArr(r.evidence_for).length, a = safeJsonArr(r.evidence_against).length;
  if (f || a) {
    const base = (db.prepare("SELECT confidence_score FROM nodes WHERE id = ?").get(id) as { confidence_score: number }).confidence_score;
    const target = r.status === "refuted" ? Math.min(base, 0.15) : r.status === "supported" ? Math.max(base, 0.75) : Math.max(0.05, Math.min(0.95, 0.5 + 0.12 * f - 0.18 * a));
    db.prepare("UPDATE nodes SET confidence_score = ?, confidence = ?, updated_at = ? WHERE id = ?").run(target, confidenceLevel(target), now, id);
  }
  const contradicted = r.kind === "assumption" && (r.status === "refuted" || (a > f && a > 0));
  if (contradicted && !r.contradicted_at) {
    db.prepare("UPDATE open_items SET contradicted_at = ? WHERE node_id = ?").run(now, id);
    db.prepare("UPDATE nodes SET contradicted_at = COALESCE(contradicted_at, ?) WHERE id = ?").run(now, id);
  } else if (!contradicted && r.contradicted_at && r.status !== "refuted") {
    db.prepare("UPDATE open_items SET contradicted_at = NULL WHERE node_id = ?").run(id);
  }
}

export type OpenAction = "update" | "support" | "refute" | "evidence" | "close" | "reopen" | "answer" | "confirm";

export interface UpdateOpenItemInput {
  action: OpenAction; text?: string; confidence?: ConfidenceLevel | number; loadBearing?: boolean; links?: string[];
  evidenceFor?: string[]; evidenceAgainst?: string[]; evidence?: string; evidenceNodeId?: string; answer?: string; reason?: string;
  writerAgentId?: string; now?: number;
}

export function updateOpenItem(agentId: string, idOrPrefix: string, input: UpdateOpenItemInput): { ok: boolean; error?: string; item?: OpenItemView } {
  const cur = getOpenItem(agentId, idOrPrefix);
  if (!cur) return { ok: false, error: `open item ${idOrPrefix} not found (brain_list_open shows ids)` };
  if (cur.draft_status === "expired") return { ok: false, error: "that draft expired; create it again if it still matters" };
  const db = getDb(agentId);
  const now = input.now ?? Date.now();
  const writer = input.writerAgentId ?? agentId;
  const evFor = safeJsonArr<{ text: string; node_id?: string; at: number }>(cur.evidence_for);
  const evAg = safeJsonArr<{ text: string; node_id?: string; at: number }>(cur.evidence_against);
  const addEv = (list: typeof evFor, texts: string[] | undefined, stance: "for" | "against") => {
    for (const t of texts ?? []) {
      const x = clean(t, 400);
      if (!x) continue;
      const e: { text: string; node_id?: string; at: number } = { text: x, at: now };
      // a bare node id (or 8+ char prefix) links the evidence node itself
      const ref = /^[0-9a-f][0-9a-f-]{7,35}$/.test(x) ? resolveRef(agentId, x) : null;
      if (ref) { e.node_id = ref.id; e.text = ref.label; writeEdge(agentId, ref.id, cur.node_id, stance === "for" ? "evidence_for" : "evidence_against", { writerAgentId: writer }); }
      list.push(e);
    }
  };
  let status: OpenStatus = cur.status;
  let closeReason = cur.close_reason;
  let answer = cur.answer;
  let text = cur.text;
  switch (input.action) {
    case "update": case "confirm": case "evidence": break;
    case "support": status = "supported"; if (!input.evidence && !input.evidenceFor?.length) return { ok: false, error: "support needs evidence (what supports it)" }; break;
    case "refute": status = "refuted"; if (!input.evidence && !input.evidenceAgainst?.length) return { ok: false, error: "refute needs evidence (what contradicts it)" }; break;
    case "close": status = "closed"; closeReason = clean(input.reason, 300) || "closed"; break;
    case "reopen": status = "open"; closeReason = null; break;
    case "answer": if (cur.kind !== "question") return { ok: false, error: "only questions take an answer" }; answer = clean(input.answer, 800); if (!answer) return { ok: false, error: "answer is required" }; status = "closed"; closeReason = "answered"; break;
    default: return { ok: false, error: "action must be update | support | refute | evidence | close | reopen | answer | confirm" };
  }
  addEv(evFor, input.evidenceFor, "for");
  addEv(evAg, input.evidenceAgainst, "against");
  if (input.evidence) addEv(input.action === "refute" ? evAg : evFor, [input.evidence], input.action === "refute" ? "against" : "for");
  if (input.text) text = clean(input.text, 600) || text;
  const err = linkAll(agentId, cur.node_id, input.links, writer);
  if (err) return { ok: false, error: err };
  const lb = cur.kind === "assumption" ? (input.loadBearing ?? !!cur.load_bearing) : false;
  db.prepare(`UPDATE open_items SET text = ?, status = ?, load_bearing = ?, evidence_for = ?, evidence_against = ?, answer = ?, close_reason = ?,
                draft_status = CASE WHEN draft_status = 'pending' THEN 'confirmed' ELSE draft_status END, keywords_json = ?, updated_at = ?,
                closed_at = CASE WHEN ? IN ('closed') THEN COALESCE(closed_at, ?) ELSE NULL END WHERE node_id = ?`)
    .run(text, status, lb ? 1 : 0, JSON.stringify(evFor.slice(-30)), JSON.stringify(evAg.slice(-30)), answer, closeReason, JSON.stringify(deriveKeywords(text)), now, status, now, cur.node_id);
  const conf = input.confidence !== undefined ? parseConfidence(input.confidence) : null;
  if (input.confidence !== undefined && !conf) return { ok: false, error: "confidence must be low|medium|high|certain or a number 0..1" };
  const content = `${KIND_LABEL[cur.kind]}${lb ? " (load-bearing)" : ""}: ${text}${status !== "open" ? ` [${status}${closeReason && status === "closed" ? `: ${closeReason}` : ""}]` : ""}${answer ? `. Answer: ${answer}` : ""}`;
  db.prepare(`UPDATE nodes SET content = ?, label = ?, updated_at = ?${conf ? ", confidence_score = ?, confidence = ?" : ""}${status === "supported" ? ", verified_at = ?" : ""} WHERE id = ?`)
    .run(...[content.slice(0, 2000), `${KIND_LABEL[cur.kind]}: ${text.slice(0, 90)}`, now, ...(conf ? [conf.score, conf.level] : []), ...(status === "supported" ? [now] : []), cur.node_id]);
  recompute(agentId, cur.node_id, now);
  bumpWriteCounter(db);
  return { ok: true, item: getOpenItem(agentId, cur.node_id)! };
}

export interface ListOpenInput { kind?: OpenKind; status?: OpenStatus | "all" | "active"; query?: string; about?: string; limit?: number }

export function listOpenItems(agentId: string, input: ListOpenInput = {}): OpenItemView[] {
  const db = getDb(agentId);
  const where = ["COALESCE(o.draft_status, '') != 'expired'", "n.status = 'active'"];
  const args: unknown[] = [];
  if (input.kind) { where.push("o.kind = ?"); args.push(input.kind); }
  const st = input.status ?? "active";
  if (st === "active") where.push("o.status IN ('open', 'supported')");
  else if (st !== "all") { where.push("o.status = ?"); args.push(st); }
  if (input.about) {
    const t = resolveRef(agentId, input.about);
    if (!t) return [];
    where.push("o.node_id IN (SELECT from_id FROM edges WHERE type = 'about' AND to_id = ? AND valid_until IS NULL)"); args.push(t.id);
  }
  let rows = db.prepare(`SELECT o.* FROM open_items o JOIN nodes n ON n.id = o.node_id WHERE ${where.join(" AND ")} ORDER BY o.load_bearing DESC, o.updated_at DESC LIMIT 200`).all(...args) as OpenItemRow[];
  const q = (input.query ?? "").trim();
  if (q) {
    const qt = tokenSet(q);
    rows = rows.map((r) => ({ r, s: overlap(qt, tokenSet(r.text)) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).map((x) => x.r);
  }
  return rows.slice(0, Math.max(1, Math.min(50, input.limit ?? 15))).map((r) => view(agentId, r));
}
const overlap = (a: Set<string>, b: Set<string>) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i; };

export function formatOpenItem(o: OpenItemView, now = Date.now()): string {
  const L = [`${o.node_id} ${KIND_LABEL[o.kind]}${o.load_bearing ? " (load-bearing)" : ""} [${o.status}] ${o.text}  (${ago(o.created_at, now)} · conf=${confidenceLevel(o.confidence_score)}${o.draft_status === "pending" ? " · captured draft (unconfirmed)" : ""}${o.contradicted_at ? ` · CONTRADICTED ${ago(o.contradicted_at, now)}` : ""})`];
  const f = safeJsonArr<{ text: string }>(o.evidence_for), a = safeJsonArr<{ text: string }>(o.evidence_against);
  if (f.length) L.push(`  for: ${f.slice(-3).map((e) => e.text).join(" | ")}${f.length > 3 ? ` (+${f.length - 3})` : ""}`);
  if (a.length) L.push(`  against: ${a.slice(-3).map((e) => e.text).join(" | ")}${a.length > 3 ? ` (+${a.length - 3})` : ""}`);
  if (o.answer) L.push(`  answer: ${o.answer}`);
  if (o.close_reason && o.status === "closed" && o.close_reason !== "answered") L.push(`  closed: ${o.close_reason}`);
  if (o.links.length) L.push(`  about: ${o.links.map((l) => `${l.label} (${l.id.slice(0, 8)})`).join("; ")}`);
  return L.join("\n");
}

// ─── heuristic capture ─────────────────────────────────────────────────────

/** Stronger guard than decisions: "I think" is already hedged, so only conditionals / hypotheticals / negations are excluded. */
const COND = /\b(?:if|unless|suppose|supposing|hypothetically|imagine|in theory|i'd|we'd|you'd|don't think|do not think|not sure|wonder)\b/i;
const HYP = /\bI\s+(?:think|suspect|believe|bet)\s+(?:that\s+)?(.{4,200}?)\s*,?\s+because\s+(.{3,200}?)\s*[.!]?$/i;
const QUESTION = /\bopen question:\s*(.{4,240}?)\s*$/i;
const ASSUME = /(?:\b(?:I'm|I am|we're|we are)\s+assuming\s+(?:that\s+)?|^assuming\s+(?:that\s+)?)(.{4,200}?)(?:\s*[,.!]|$)/i;

export interface OpenItemCandidate { kind: OpenKind; text: string; because?: string; sentence: string }

export function extractOpenItemCandidates(text: string): OpenItemCandidate[] {
  if (!text) return [];
  const out: OpenItemCandidate[] = [];
  for (const s of sentencesOf(text)) {
    if (out.length >= 2) break;
    if (REPORTED.test(s)) continue;
    const q = QUESTION.exec(s);
    if (q) { out.push({ kind: "question", text: q[1]!.replace(/[\s,;:]+$/, ""), sentence: s.slice(0, 400) }); continue; }
    if (s.endsWith("?") || COND.test(s)) continue;
    const h = HYP.exec(s);
    if (h) { out.push({ kind: "hypothesis", text: h[1]!.replace(/[\s,;:]+$/, ""), because: h[2]!.replace(/[\s,;:]+$/, ""), sentence: s.slice(0, 400) }); continue; }
    const a = ASSUME.exec(s);
    if (a) out.push({ kind: "assumption", text: a[1]!.replace(/[\s,;:]+$/, ""), sentence: s.slice(0, 400) });
  }
  return out.filter((c) => c.text.split(/\s+/).length >= 2 && c.text.split(/\s+/).length <= 40);
}

export function autoExtractOpenItems(agentId: string, text: string, config: Partial<BrainConfig>, opts: { writerAgentId?: string; evidence?: string[]; now?: number } = {}): string[] {
  if (config.openItemCapture === false) return [];
  const cands = extractOpenItemCandidates(text);
  if (!cands.length) return [];
  const db = getDb(agentId);
  const now = opts.now ?? Date.now();
  const recent = db.prepare("SELECT text FROM open_items WHERE created_at > ? AND kind = ?");
  const ids: string[] = [];
  for (const c of cands) {
    const t = tokenSet(c.text);
    if ((recent.all(now - 7 * DAY, c.kind) as Array<{ text: string }>).some((r) => jaccard(t, tokenSet(r.text)) >= 0.8)) continue;
    const r = createOpenItem(agentId, {
      kind: c.kind, text: c.text, autoExtracted: true, ...(c.because ? { evidenceFor: [c.because] } : {}),
      ...(opts.writerAgentId ? { writerAgentId: opts.writerAgentId } : {}), ...(opts.evidence ? { evidence: opts.evidence } : {}), now,
    });
    if (r.ok && r.id) ids.push(r.id);
  }
  return ids;
}

/** Sleep: captured drafts nobody touched (status open, unlinked) after openItemDraftTtlDays are soft-retired. */
export function expireOpenItemDrafts(agentId: string, config: Partial<BrainConfig>, now = Date.now()): string[] {
  const ttl = config.openItemDraftTtlDays ?? 14;
  if (!(ttl > 0)) return [];
  const db = getDb(agentId);
  const rows = db.prepare(`SELECT o.node_id FROM open_items o JOIN nodes n ON n.id = o.node_id
                            WHERE o.auto_extracted = 1 AND o.draft_status = 'pending' AND o.status = 'open' AND n.status = 'active' AND o.created_at < ?
                              AND NOT EXISTS (SELECT 1 FROM edges e WHERE (e.from_id = o.node_id OR e.to_id = o.node_id) AND e.type IN ('about', 'evidence_for', 'evidence_against', 'blocked_by'))`)
    .all(now - ttl * DAY) as Array<{ node_id: string }>;
  if (!rows.length) return [];
  const reason = `expired: unconfirmed captured draft (untouched for ${ttl}d)`;
  db.transaction(() => {
    for (const r of rows) {
      db.prepare("UPDATE open_items SET draft_status = 'expired', status = 'closed', close_reason = ?, closed_at = ?, updated_at = ? WHERE node_id = ?").run(reason, now, now, r.node_id);
      db.prepare("UPDATE nodes SET status = 'archived', status_reason = ?, status_changed_at = ?, valid_until = COALESCE(valid_until, ?), updated_at = ? WHERE id = ?").run(reason, now, now, now, r.node_id);
    }
  })();
  return rows.map((r) => r.node_id);
}

/** Question / auxiliary words that say nothing about what an item is about. */
const FILLER = new Set("do does did doing done have has had having want wants should would could will can may might must is are was were be been being which what how why when where who whom whose there their they them this that these those about into from with does not".split(" "));

/** One relevant open question / hypothesis / assumption for this turn (keyword match, 6 h cooldown each). */
export function surfaceOpenItem(agentId: string, prompt: string, config: Partial<BrainConfig>, now = Date.now()): { id: string; line: string } | null {
  if (config.openItemSurfacing === false || !prompt.trim()) return null;
  const db = getDb(agentId);
  const stem = (w: string) => w.replace(/(?:ies)$/, "y").replace(/(?:es|s)$/, "");
  const pt = new Set([...tokenSet(prompt)].map(stem));
  if (pt.size === 0) return null;
  const rows = db.prepare(`SELECT o.* FROM open_items o JOIN nodes n ON n.id = o.node_id WHERE o.status IN ('open', 'supported') AND COALESCE(o.draft_status, '') != 'expired' AND n.status = 'active'
                             AND (o.last_surfaced_at IS NULL OR o.last_surfaced_at < ?) ORDER BY o.load_bearing DESC, o.updated_at DESC LIMIT 300`).all(now - 6 * HOUR) as OpenItemRow[];
  let best: { r: OpenItemRow; s: number } | null = null;
  for (const r of rows) {
    const kws = safeJsonArr(r.keywords_json).filter((k) => !FILLER.has(k));
    const s = kws.filter((k) => pt.has(stem(k))).length;
    const need = kws.length <= 1 ? 1 : 2; // one shared word (e.g. a name) is not "about" the item
    if (s >= need && (!best || s > best.s)) best = { r, s };
  }
  if (!best) return null;
  const r = best.r;
  db.prepare("UPDATE open_items SET last_surfaced_at = ?, surfaced_count = surfaced_count + 1 WHERE node_id = ?").run(now, r.node_id);
  const head = r.kind === "question" ? `Open question (asked ${ago(r.created_at, now)})` : r.kind === "assumption" ? `Assumption you're relying on${r.contradicted_at ? " — CONTRADICTED" : ""}` : `Open hypothesis${r.status === "supported" ? " (supported)" : ""}`;
  return { id: r.node_id, line: `${head}: ${r.text.slice(0, 150)}` };
}

export function openItemCounts(db: ReturnType<typeof getDb>): {
  hypotheses: number; questions: number; assumptions: number; draftsPending: number; draftsExpired: number;
  hotQuestions: Array<{ id: string; text: string }>; contradictedAssumptions: Array<{ id: string; text: string; since: number }>;
} {
  const zero = { hypotheses: 0, questions: 0, assumptions: 0, draftsPending: 0, draftsExpired: 0, hotQuestions: [], contradictedAssumptions: [] };
  try {
    const act = "o.status IN ('open', 'supported') AND COALESCE(o.draft_status, '') != 'expired' AND n.status = 'active'";
    const c = db.prepare(`SELECT SUM(o.kind='hypothesis') h, SUM(o.kind='question') q, SUM(o.kind='assumption') a, SUM(o.draft_status='pending') d FROM open_items o JOIN nodes n ON n.id = o.node_id WHERE ${act}`).get() as Record<string, number | null>;
    const x = (db.prepare("SELECT COUNT(*) n FROM open_items WHERE draft_status = 'expired'").get() as { n: number }).n;
    const hot = db.prepare(`SELECT o.node_id id, o.text FROM open_items o JOIN nodes n ON n.id = o.node_id WHERE ${act} AND o.kind = 'question' AND (COALESCE(o.draft_status, '') != 'pending' OR o.surfaced_count > 0)
                              ORDER BY COALESCE(o.last_surfaced_at, 0) + o.surfaced_count * 3600000 DESC, o.updated_at DESC LIMIT 2`).all() as Array<{ id: string; text: string }>;
    const contra = db.prepare(`SELECT o.node_id id, o.text, o.contradicted_at since FROM open_items o JOIN nodes n ON n.id = o.node_id
                                 WHERE o.kind = 'assumption' AND o.load_bearing = 1 AND o.contradicted_at IS NOT NULL AND o.status != 'closed' AND n.status = 'active' ORDER BY o.contradicted_at DESC LIMIT 3`).all() as Array<{ id: string; text: string; since: number }>;
    return { hypotheses: c["h"] ?? 0, questions: c["q"] ?? 0, assumptions: c["a"] ?? 0, draftsPending: c["d"] ?? 0, draftsExpired: x, hotQuestions: hot, contradictedAssumptions: contra };
  } catch { return zero; }
}

export { getNode };
