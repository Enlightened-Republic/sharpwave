/**
 * Xanima 0.3.0 — structured reflection ("what worked / what didn't / try next").
 *
 * Heuristic, template-based by default (no LLM): it samples decisions whose
 * outcomes landed in the window (outcome deltas, over-confident misses,
 * repeated failures, confirmed lessons), hypotheses / assumptions that were
 * supported or refuted, overdue commitments, drifting goals and a few
 * assistant episodes that report success / failure. The result is a
 * `reflection` node (+ `reflections` row) linked to its sources
 * (`reflects_on` edges) and to the goal it is about — so recall and
 * brain_briefing can inject it later.
 *
 * Near-duplicate reflections for the same scope merge (same similarity as the
 * lesson merge: embedding cosine when vectors exist, lexical fallback) instead
 * of piling up. Opt-in LLM phrasing in sleep (reflectionLlm) rewrites the
 * template text; on any failure the template stays.
 */
import { getDb, getMeta, setMeta, bumpWriteCounter } from "./db.js";
import { writeNode, ftsSearchNodes } from "./nodes.js";
import { writeEdge } from "./edges.js";
import { confidenceLevel } from "./belief-meta.js";
import { tokenSet, jaccard, lessonSimilarity } from "./decisions.js";
import { currentGoalRow, isGoalTalk } from "./goals.js";
import { fetchEmbeddingCached } from "./embeddings.js";
import { callOpenRouter } from "./llm.js";
import { safeJsonArr, ago, DAY } from "./continuity-util.js";
import type { BrainConfig } from "./types.js";

type Log = { info: (m: string) => void; warn: (m: string) => void };
const short = (s: string | null | undefined, n: number) => { const t = (s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "…" : t; };
const LEXICAL_MERGE = 0.5;

export interface ReflectInput { topic?: string; goalId?: string; since?: number; until?: number; origin?: "sleep" | "tool"; now?: number }
export interface ReflectionDraft {
  scopeKind: "window" | "goal" | "topic"; scopeRef: string | null; scopeLabel: string; since: number; until: number;
  worked: string[]; didnt: string[]; next: string[]; sources: string[]; goalNodeId: string | null;
}
export interface ReflectResult { ok: boolean; error?: string; empty?: boolean; id?: string; merged?: boolean; similarity?: number; method?: string; draft?: ReflectionDraft; text?: string }

interface Dec { node_id: string; context: string; chosen: string; predicted_outcome: string | null; predicted_confidence: number | null; outcome: string | null; outcome_status: string | null; outcome_at: number | null; lesson: string | null; lesson_node_id: string | null; goal_id: string | null; created_at: number }

export function draftReflection(agentId: string, input: ReflectInput, config: Partial<BrainConfig>): ReflectionDraft | { error: string } {
  const db = getDb(agentId);
  const now = input.now ?? Date.now();
  const until = input.until ?? now;
  const since = input.since ?? until - Math.max(1, config.reflectionWindowDays ?? 7) * DAY;
  if (since >= until) return { error: "since must be before until" };
  let scopeKind: ReflectionDraft["scopeKind"] = "window", scopeRef: string | null = null, scopeLabel = `${ago(since, now)} → ${until >= now - 60_000 ? "now" : ago(until, now)}`;
  let goalNodeId: string | null = null;
  let inScope: (text: string, d?: Dec) => boolean = () => true;
  if (input.goalId) {
    const g = currentGoalRow(agentId, input.goalId);
    if (!g) return { error: `goal ${input.goalId} not found` };
    scopeKind = "goal"; scopeRef = g.lineage_id; scopeLabel = `goal "${g.title}"`; goalNodeId = g.node_id;
    const gt = tokenSet(`${g.title} ${g.success_criteria ?? ""}`);
    inScope = (text, d) => (d ? d.goal_id === g.lineage_id : overlap(gt, tokenSet(text)) >= 2);
  } else if (input.topic && input.topic.trim()) {
    const topic = input.topic.trim().slice(0, 200);
    scopeKind = "topic"; scopeRef = topic.toLowerCase(); scopeLabel = `"${short(topic, 60)}"`;
    let hits = new Set<string>();
    try { hits = new Set(ftsSearchNodes(agentId, topic, 80).map((n) => n.id)); } catch { /* ignore */ }
    const tt = tokenSet(topic);
    inScope = (text, d) => (d && hits.has(d.node_id)) || overlap(tt, tokenSet(text)) >= Math.min(2, tt.size);
  }
  const worked: string[] = [], didnt: string[] = [], next: string[] = [], sources: string[] = [];
  const decs = (db.prepare(`SELECT d.* FROM decisions d JOIN nodes n ON n.id = d.node_id WHERE d.merged_into IS NULL AND n.status = 'active' AND d.outcome_at BETWEEN ? AND ? ORDER BY d.outcome_at`).all(since, until) as Dec[])
    .filter((d) => inScope(`${d.context} ${d.chosen} ${d.outcome ?? ""}`, d));
  const misses: Dec[] = [];
  for (const d of decs) {
    sources.push(d.node_id);
    const what = `${short(d.chosen, 50)} for ${short(d.context, 60)}`;
    if (d.outcome_status === "matched" || d.outcome_status === "better") {
      worked.push(`${what} → ${d.outcome_status === "better" ? "better than expected" : "as predicted"}${d.outcome ? ` (${short(d.outcome, 60)})` : ""}`);
      if (d.lesson && d.lesson_node_id) worked.push(`lesson held: ${short(d.lesson, 90)}`);
    } else if (d.outcome_status === "missed" || d.outcome_status === "worse" || d.outcome_status === "partial") {
      misses.push(d);
      const over = (d.predicted_confidence ?? 0) >= 0.7 && d.outcome_status !== "partial";
      didnt.push(`${what} → ${d.outcome_status}${d.outcome ? ` (${short(d.outcome, 60)})` : ""}${over ? ` — expected it with ${confidenceLevel(d.predicted_confidence!)} confidence` : ""}`);
      if (d.lesson) next.push(short(d.lesson, 110));
    }
  }
  // repeated failures: ≥ 2 misses with similar context / choice
  const used = new Set<string>();
  for (const a of misses) {
    if (used.has(a.node_id)) continue;
    const group = misses.filter((b) => b === a || jaccard(tokenSet(`${a.context} ${a.chosen}`), tokenSet(`${b.context} ${b.chosen}`)) >= 0.4);
    if (group.length >= 2) { group.forEach((g) => used.add(g.node_id)); didnt.unshift(`repeated failure (${group.length}×): ${short(a.chosen, 50)} for ${short(a.context, 60)}`); next.unshift(`change approach for ${short(a.context, 70)} — the same choice failed ${group.length} times`); }
  }
  // hypotheses / assumptions resolved in the window
  for (const o of db.prepare("SELECT node_id, kind, text, status, load_bearing, contradicted_at FROM open_items WHERE updated_at BETWEEN ? AND ? AND status IN ('supported', 'refuted') OR (contradicted_at BETWEEN ? AND ?)").all(since, until, since, until) as Array<{ node_id: string; kind: string; text: string; status: string; load_bearing: number; contradicted_at: number | null }>) {
    if (!inScope(o.text)) continue;
    sources.push(o.node_id);
    if (o.status === "supported") worked.push(`${o.kind} held up: ${short(o.text, 90)}`);
    else { didnt.push(`${o.kind} ${o.kind === "assumption" ? "contradicted" : "refuted"}: ${short(o.text, 90)}`); if (o.load_bearing) next.unshift(`re-check what rests on: ${short(o.text, 80)}`); }
  }
  // overdue commitments, drifting goals, stale pending decisions
  for (const c of db.prepare("SELECT node_id, title, due_at FROM commitments WHERE status = 'open' AND due_at BETWEEN ? AND ?").all(since, Math.min(until, now)) as Array<{ node_id: string; title: string; due_at: number }>) {
    if (!inScope(c.title)) continue;
    didnt.push(`commitment slipped: ${short(c.title, 80)} (due ${ago(c.due_at, now)})`); next.push(`finish, re-date or drop: ${short(c.title, 70)}`); sources.push(c.node_id);
  }
  for (const g of db.prepare(`SELECT lineage_id, title, drift_reason FROM goals g WHERE g.version = (SELECT MAX(version) FROM goals x WHERE x.lineage_id = g.lineage_id) AND status = 'active' AND drift_reason IS NOT NULL`).all() as Array<{ lineage_id: string; title: string; drift_reason: string }>) {
    if (scopeKind === "goal" ? g.lineage_id !== scopeRef : scopeKind === "topic" && !inScope(g.title)) continue;
    next.push(`take one concrete step on "${short(g.title, 60)}" (${short(g.drift_reason, 60)})`);
  }
  for (const d of db.prepare("SELECT node_id, chosen, context, goal_id, created_at FROM decisions d WHERE merged_into IS NULL AND outcome_at IS NULL AND COALESCE(draft_status, '') NOT IN ('expired', 'pending') AND created_at BETWEEN ? AND ? ORDER BY created_at LIMIT 20").all(since - 30 * DAY, until - 7 * DAY) as Dec[]) {
    if (!inScope(`${d.context} ${d.chosen}`, d)) continue;
    if (next.length < 8) next.push(`record the outcome of "${short(d.chosen, 50)}" (decided ${ago(d.created_at, now)})`);
  }
  // a few assistant episodes reporting success / failure (not memory-tool chatter)
  const eps = db.prepare("SELECT id, content FROM episodes WHERE role = 'assistant' AND created_at BETWEEN ? AND ? ORDER BY created_at DESC LIMIT 400").all(since, until) as Array<{ id: string; content: string }>;
  let ew = 0, ed = 0;
  for (const e of eps) {
    if (isGoalTalk(e.content) || !inScope(e.content)) continue;
    const s = e.content.split(/(?<=[.!?])\s+|\n+/).find((x) => FAIL.test(x) || WIN.test(x));
    if (!s || /\?$/.test(s.trim())) continue;
    if (FAIL.test(s) && ed < 2) { didnt.push(`reported: ${short(s, 90)}`); ed++; sources.push(e.id); }
    else if (WIN.test(s) && !FAIL.test(s) && ew < 2) { worked.push(`reported: ${short(s, 90)}`); ew++; sources.push(e.id); }
  }
  return { scopeKind, scopeRef, scopeLabel, since, until, worked: dedupe(worked).slice(0, 6), didnt: dedupe(didnt).slice(0, 6), next: dedupe(next).slice(0, 5), sources: [...new Set(sources)].slice(0, 40), goalNodeId };
}
const FAIL = /\b(?:failed|failing|broke|broken|didn't work|did not work|timed out|regression|crash(?:ed)?|errored|rolled back)\b/i;
const WIN = /\b(?:fixed|shipped|works now|working now|succeeded|passed|resolved|deployed|landed|completed)\b/i;
const overlap = (a: Set<string>, b: Set<string>) => { let i = 0; for (const x of a) if (b.has(x)) i++; return i; };
function dedupe(xs: string[]): string[] {
  const out: string[] = [];
  for (const x of xs) if (!out.some((y) => jaccard(tokenSet(x), tokenSet(y)) >= 0.8)) out.push(x);
  return out;
}

export function reflectionBody(d: Pick<ReflectionDraft, "worked" | "didnt" | "next">): string {
  const sec = (h: string, xs: string[]) => (xs.length ? `${h}: ${xs.join("; ")}.` : "");
  return [sec("Worked", d.worked), sec("Didn't", d.didnt), sec("Try next", d.next)].filter(Boolean).join(" ");
}

/** Store (or merge into a near-duplicate for the same scope). `vectors` optional: "new" + "r:<id>" → embedding path; otherwise lexical. */
export function storeReflection(agentId: string, draft: ReflectionDraft, opts: { origin?: "sleep" | "tool"; method?: "template" | "llm"; body?: string; vectors?: Map<string, Float32Array>; mergeSimilarity?: number; now?: number } = {}): ReflectResult {
  const db = getDb(agentId);
  const now = opts.now ?? Date.now();
  const body = opts.body ?? reflectionBody(draft);
  const prev = db.prepare(`SELECT r.*, n.content FROM reflections r JOIN nodes n ON n.id = r.node_id WHERE n.status = 'active' AND r.scope_kind = ? AND r.scope_ref IS ? AND r.updated_at > ? ORDER BY r.updated_at DESC LIMIT 20`)
    .all(draft.scopeKind, draft.scopeRef, now - 30 * DAY) as Array<{ node_id: string; worked_json: string; didnt_json: string; next_json: string; sources_json: string; merge_count: number; history_json: string; since: number; content: string }>;
  let best: { r: (typeof prev)[number]; sim: number; method: string } | null = null;
  for (const r of prev) {
    const s = lessonSimilarity(body, r.content.replace(/^Reflection[^:]*:\s*/, ""), opts.vectors?.get("new"), opts.vectors?.get(`r:${r.node_id}`));
    const thr = s.method === "embedding" ? (opts.mergeSimilarity ?? 0.86) : LEXICAL_MERGE;
    if (s.sim >= thr && (!best || s.sim > best.sim)) best = { r, sim: s.sim, method: s.method };
  }
  const head = `Reflection on ${draft.scopeLabel} (${new Date(draft.since).toISOString().slice(0, 10)} → ${new Date(draft.until).toISOString().slice(0, 10)})`;
  if (best) {
    const r = best.r;
    const worked = dedupe([...draft.worked, ...safeJsonArr(r.worked_json)]).slice(0, 8), didnt = dedupe([...draft.didnt, ...safeJsonArr(r.didnt_json)]).slice(0, 8), next = dedupe([...draft.next, ...safeJsonArr(r.next_json)]).slice(0, 6);
    const sources = [...new Set([...safeJsonArr(r.sources_json), ...draft.sources])].slice(0, 60);
    const hist = [...safeJsonArr<Record<string, unknown>>(r.history_json), { at: now, similarity: Math.round(best.sim * 1000) / 1000, method: best.method, origin: opts.origin ?? "tool", added_sources: draft.sources.length }].slice(-20);
    const merged = reflectionBody({ worked, didnt, next });
    const conf = (db.prepare("SELECT confidence_score FROM nodes WHERE id = ?").get(r.node_id) as { confidence_score: number }).confidence_score;
    const after = Math.min(0.9, conf + 0.05);
    db.transaction(() => {
      db.prepare("UPDATE reflections SET worked_json = ?, didnt_json = ?, next_json = ?, sources_json = ?, merge_count = merge_count + 1, history_json = ?, since = MIN(since, ?), until = MAX(until, ?), updated_at = ? WHERE node_id = ?")
        .run(JSON.stringify(worked), JSON.stringify(didnt), JSON.stringify(next), JSON.stringify(sources), JSON.stringify(hist), draft.since, draft.until, now, r.node_id);
      db.prepare("UPDATE nodes SET content = ?, evidence = ?, confidence_score = ?, confidence = ?, updated_at = ? WHERE id = ?")
        .run(`${head}: ${merged} (merged ${r.merge_count + 1} reflections)`.slice(0, 3000), JSON.stringify(sources.slice(0, 50)), after, confidenceLevel(after), now, r.node_id);
    })();
    for (const s of draft.sources.slice(0, 10)) if (db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(s)) writeEdge(agentId, r.node_id, s, "reflects_on", { writerAgentId: opts.origin === "sleep" ? "system:sleep" : agentId });
    bumpWriteCounter(db);
    return { ok: true, id: r.node_id, merged: true, similarity: best.sim, method: best.method, draft, text: `${head}: ${merged}` };
  }
  const id = writeNode(agentId, "reflection", `Reflection: ${draft.scopeLabel}`.slice(0, 100), `${head}: ${body}`.slice(0, 3000), {
    importance: 0.65, source: `reflection:${opts.origin ?? "tool"}`, deduplicate: false, writerAgentId: opts.origin === "sleep" ? "system:sleep" : agentId,
    sourceType: "inference", confidence: "medium", evidence: draft.sources.slice(0, 50),
  });
  db.prepare(`INSERT INTO reflections (node_id, scope_kind, scope_ref, since, until, worked_json, didnt_json, next_json, sources_json, origin, method, merge_count, history_json, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, '[]', ?, ?)`)
    .run(id, draft.scopeKind, draft.scopeRef, draft.since, draft.until, JSON.stringify(draft.worked), JSON.stringify(draft.didnt), JSON.stringify(draft.next), JSON.stringify(draft.sources), opts.origin ?? "tool", opts.method ?? "template", now, now);
  for (const s of draft.sources.slice(0, 10)) if (db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(s)) writeEdge(agentId, id, s, "reflects_on", { writerAgentId: opts.origin === "sleep" ? "system:sleep" : agentId });
  if (draft.goalNodeId) writeEdge(agentId, id, draft.goalNodeId, "about", { writerAgentId: opts.origin === "sleep" ? "system:sleep" : agentId });
  bumpWriteCounter(db);
  return { ok: true, id, merged: false, draft, text: `${head}: ${body}` };
}

/** On-demand reflection (brain_reflect): template path, lexical merge. */
export function reflect(agentId: string, input: ReflectInput, config: Partial<BrainConfig>): ReflectResult {
  const d = draftReflection(agentId, input, config);
  if ("error" in d) return { ok: false, error: d.error };
  if (!d.worked.length && !d.didnt.length && !d.next.length) return { ok: true, empty: true, draft: d, text: `Nothing to reflect on for ${d.scopeLabel} (no outcomes, resolved hypotheses, slipped commitments or reported results in the window). Nothing stored.` };
  return storeReflection(agentId, d, { origin: input.origin ?? "tool", ...(input.now ? { now: input.now } : {}), mergeSimilarity: config.lessonMergeSimilarity ?? 0.86 });
}

export function formatReflection(r: ReflectResult): string {
  if (!r.ok) return `Error: ${r.error}`;
  if (r.empty || !r.draft) return r.text ?? "Nothing to reflect on.";
  const d = r.draft;
  const L = [`Reflection on ${d.scopeLabel}${r.merged ? ` — merged into existing reflection ${r.id} (similarity ${r.similarity?.toFixed(2)}, ${r.method})` : ` — stored as ${r.id}`}:`];
  L.push(`What worked: ${d.worked.length ? "" : "(nothing recorded)"}`); for (const x of d.worked) L.push(`  + ${x}`);
  L.push(`What didn't: ${d.didnt.length ? "" : "(nothing recorded)"}`); for (const x of d.didnt) L.push(`  - ${x}`);
  L.push(`Try next: ${d.next.length ? "" : "(nothing)"}`); for (const x of d.next) L.push(`  > ${x}`);
  return L.join("\n");
}

/** Sleep reflection phase (reflection: "sleep"). One window reflection + up to 3 goal-scoped ones. Async for the opt-in embedding / LLM paths. */
export async function runReflectionPass(agentId: string, config: Partial<BrainConfig>, log?: Log, now = Date.now()): Promise<{ written: number; merged: number; ids: string[]; method: string }> {
  const res = { written: 0, merged: 0, ids: [] as string[], method: "template" };
  if ((config.reflection ?? "off") !== "sleep") return res;
  const db = getDb(agentId);
  const last = Number(getMeta(agentId, "reflection:last_until") ?? 0);
  const win = Math.max(1, config.reflectionWindowDays ?? 7) * DAY;
  const since = Math.max(now - win, last || 0, 1);
  const scopes: ReflectInput[] = [{}];
  const goals = db.prepare(`SELECT DISTINCT goal_id FROM decisions WHERE goal_id IS NOT NULL AND outcome_at BETWEEN ? AND ? LIMIT 3`).all(since, now) as Array<{ goal_id: string }>;
  for (const g of goals) scopes.push({ goalId: g.goal_id });
  for (const sc of scopes) {
    const d = draftReflection(agentId, { ...sc, since, until: now, now }, config);
    if ("error" in d || (!d.worked.length && !d.didnt.length)) continue; // sleep only writes when there are outcomes to learn from
    let body = reflectionBody(d), method: "template" | "llm" = "template";
    if (config.reflectionLlm === true && config.openRouterApiKey) {
      try {
        const out = await callOpenRouter(`Rewrite this agent self-reflection as three short sections "Worked:", "Didn't:", "Try next:" (max 80 words total, keep facts, no new claims):\n${body}`, config.remModel ?? "openrouter/deepseek/deepseek-v4-flash", config.openRouterApiKey, 300, 0.2);
        if (out && /Worked:|Didn't:|Try next:/.test(out) && out.length < 1200) { body = out.replace(/\s+/g, " ").trim(); method = "llm"; }
      } catch (err) { log?.warn(`[xanima] reflection LLM failed, using the template: ${String(err)}`); }
    }
    let vectors: Map<string, Float32Array> | undefined;
    if (config.embeddingModel) {
      try {
        const v = await fetchEmbeddingCached(body, config as BrainConfig);
        if (v) {
          vectors = new Map([["new", v]]);
          for (const r of db.prepare("SELECT r.node_id, n.content FROM reflections r JOIN nodes n ON n.id = r.node_id WHERE n.status = 'active' AND r.scope_kind = ? AND r.scope_ref IS ? ORDER BY r.updated_at DESC LIMIT 10").all(d.scopeKind, d.scopeRef) as Array<{ node_id: string; content: string }>) {
            const rv = await fetchEmbeddingCached(r.content.replace(/^Reflection[^:]*:\s*/, ""), config as BrainConfig);
            if (rv) vectors.set(`r:${r.node_id}`, rv);
          }
        }
      } catch { vectors = undefined; }
    }
    const r = storeReflection(agentId, d, { origin: "sleep", method, body, ...(vectors ? { vectors } : {}), mergeSimilarity: config.lessonMergeSimilarity ?? 0.86, now });
    if (r.ok && r.id) { res.ids.push(r.id); if (r.merged) res.merged++; else res.written++; if (method === "llm") res.method = "llm"; }
  }
  setMeta(agentId, "reflection:last_until", String(now));
  if (res.ids.length) log?.info(`[xanima] reflection: ${res.written} written, ${res.merged} merged (${res.method}, agent=${agentId})`);
  return res;
}
