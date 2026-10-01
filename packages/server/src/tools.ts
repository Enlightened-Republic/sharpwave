// packages/server/src/tools.ts
//
// The brain_* tool surface as served by the brain service, with agent scoping
// enforced from the bearer token:
//
//   • The caller's identity is the TOKEN's agentId. There is no `agent`
//     argument, and any client-supplied `writer_agent_id` is ignored — every
//     node/edge this service writes is stamped with the token's agent.
//   • Reads see the caller's private brain + the shared brain (merged and
//     labelled for brain_query). Another agent's private brain is unreachable:
//     no argument can name it.
//   • Writes go to the caller's private brain; `visibility: "shared"` targets
//     the shared brain and requires the `shared-write` scope.
//   • brain_reset needs the `admin` scope AND `allowReset: true` in config.
//
// Argument validation reuses sharpwave-core's validators; mutations run on the
// brain's serialized write queue; pure reads use read-only WAL connections.

import type Database from "better-sqlite3";
import {
  writeNode, getNode, touchNode, writeEdge, closeEdgesFromNode, closeEdgesToNode,
  queueEmbedding, fetchEmbedding, ftsSearchNodes, vectorSearchNodes, rrfFuse,
  spreadActivation, workingMemoryBoost, updateWorkingMemory, getNeuromodulatorState,
  dispatchBrainTool, BRAIN_TOOL_DEFS,
  validateBrainQuery, validateBrainWrite, validateBrainLink, validateBrainSupersede,
  validateBrainHistory, validateBrainExpand, validateBrainEdges, formatValidationErrors,
  getDb, forgetNodeById,
} from "sharpwave-core";
import { createHash } from "node:crypto";
import type { BrainConfig, BrainNode, ActivatedNode, NodeType, EdgeType } from "sharpwave-core";

import { SHARED_BRAIN, type BrainManager } from "./brains.js";
import type { AuditLog } from "./audit.js";
import type { Principal, Scope } from "./tokens.js";
import { EPISODE_TOOL_DEF, EPISODE_TOOL_NAME, callEpisodeAppend } from "./episode-tool.js";

export const WRITE_SOURCE = "sharpwave-server";

export interface ToolContext {
  principal: Principal;
  brains: BrainManager;
  audit: AuditLog;
  brainConfig: BrainConfig;
  allowReset: boolean;
  /** Stable per-agent working-memory session id for this process. */
  sessionId: (agentId: string) => string;
  /** brain_episode_append skips system-noise turns (ServiceConfig.skipSystemNoiseEpisodes). Default true. */
  skipSystemNoiseEpisodes?: boolean;
}

export interface ToolOutput {
  text: string;
  isError?: boolean;
}

type Visibility = "private" | "shared";

const VIS_PROP = {
  type: "string",
  enum: ["private", "shared"],
  description: 'Which brain: "private" (your own, default) or "shared" (visible to every agent; writing needs the shared-write scope).',
};
const FORMAT_PROP = { type: "string", enum: ["text", "json"], description: "Output format (default text)." };

function def(name: string) {
  const d = BRAIN_TOOL_DEFS[name];
  if (!d) throw new Error(`core has no tool ${name}`);
  return d;
}

function withProps(name: string, extra: Record<string, unknown>, drop: string[] = [], description?: string) {
  const base = def(name);
  const props: Record<string, unknown> = { ...(base.inputSchema.properties ?? {}) };
  for (const k of drop) delete props[k];
  return {
    name,
    description: description ?? base.description,
    inputSchema: {
      type: "object" as const,
      properties: { ...props, ...extra },
      ...(base.inputSchema.required ? { required: base.inputSchema.required } : {}),
    },
  };
}

/** Published tool list (order is stable). */
export const SERVICE_TOOLS = [
  withProps("brain_query", {
    scope: { type: "string", enum: ["all", "private", "shared"], description: 'Which brains to search: "all" (default: your private brain + shared), "private", or "shared".' },
    format: FORMAT_PROP,
  }, [], "Search your private brain and the shared brain (hybrid FTS + vector + spreading activation). Results are merged and each is labelled [private] or [shared]."),
  withProps("brain_write", { visibility: VIS_PROP }, ["writer_agent_id"],
    "Store a new memory node in your private brain (default) or, with visibility:\"shared\" and the shared-write scope, in the shared brain. The writer is always the calling token's agent."),
  withProps("brain_link", { visibility: VIS_PROP }),
  withProps("brain_supersede", { visibility: VIS_PROP }),
  withProps("brain_stats", { visibility: { type: "string", enum: ["all", "private", "shared"], description: "Which brain(s) to report (default all)." }, format: FORMAT_PROP }, ["format"],
    "Brain statistics for your private brain and/or the shared brain: node counts by type, edges, episodes, embedding coverage, writers."),
  withProps("brain_history", { visibility: VIS_PROP }),
  withProps("brain_expand", { visibility: { ...VIS_PROP, description: "Which brain holds the node. Default: your private brain, then shared." }, format: FORMAT_PROP }),
  withProps("brain_review", { visibility: VIS_PROP }),
  withProps("brain_forget", { visibility: VIS_PROP }),
  withProps("brain_edges", { visibility: { ...VIS_PROP, description: "Which brain holds the node. Default: your private brain, then shared." } }),
  withProps("brain_reset", { visibility: VIS_PROP }, [],
    "ADMIN ONLY, disabled unless the service sets allowReset. Wipes one brain (backup taken first). confirm must equal the brain name (your agent id, or \"shared\")."),
  {
    name: "brain_seed",
    description:
      "ADMIN ONLY (operator tooling, normally driven by `sharpwave-client seed`). Idempotent bulk import of pre-chunked " +
      "notes from one source file into your private brain (default) or the shared brain. Every node gets " +
      "source=\"seed:<source>#<content-hash>\", so re-importing the same chunk is a no-op. " +
      "mode: import | dry-run (count new vs existing, write nothing) | remove (delete every node from this source) | " +
      "list (count nodes per seed source; source \"*\" = all).",
    inputSchema: {
      type: "object" as const,
      properties: {
        mode: { type: "string", enum: ["import", "dry-run", "remove", "list"] },
        source: { type: "string", description: "Source file name, e.g. 01-overview.md (letters, digits, . _ -). \"*\" only with mode=list." },
        visibility: VIS_PROP,
        prune: { type: "boolean", description: "import only: also delete nodes from this source whose hash is not in this batch (the batch must be the whole file)." },
        chunks: {
          type: "array",
          description: "import / dry-run: the chunks of this source file.",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              content: { type: "string" },
              type: { type: "string", description: "Node type (default semantic). identity/goal are refused (they cannot be rolled back)." },
              importance: { type: "number" },
              tags: { type: "array", items: { type: "string" } },
            },
            required: ["label", "content"],
          },
        },
      },
      required: ["mode", "source"],
    },
  },
  EPISODE_TOOL_DEF,
];

const TOOL_NAMES = new Set(SERVICE_TOOLS.map((t) => t.name));

/** Tools listed to a principal: brain_seed only shows up for admin tokens. */
export function toolsFor(p: Principal) {
  return SERVICE_TOOLS.filter((t) => t.name !== "brain_seed" || p.scopes.has("admin"));
}

// ─── seeding ────────────────────────────────────────────────────────────────

export const SEED_SOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SEED_TAG_RE = /^[A-Za-z0-9][A-Za-z0-9 _.:\/-]{0,63}$/;
const SEED_MAX_CHUNKS = 1000;
const SEED_UNROLLABLE = new Set(["identity", "goal"]);

/** Node `source` for a seeded chunk: seed:<file>#<first 16 hex of sha256(type, label, content)>. */
export function seedSourceFor(source: string, type: string, label: string, content: string): string {
  const h = createHash("sha256").update(`${type}\n${label}\n${content}`, "utf8").digest("hex").slice(0, 16);
  return `seed:${source}#${h}`;
}

interface SeedChunk { type: NodeType; label: string; content: string; importance?: number; src: string }

function prepareSeedChunks(source: string, raw: unknown): { chunks: SeedChunk[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: "chunks must be an array" };
  if (raw.length > SEED_MAX_CHUNKS) return { error: `too many chunks (${raw.length} > ${SEED_MAX_CHUNKS}); split the file` };
  const out: SeedChunk[] = [];
  const problems: string[] = [];
  raw.forEach((c, i) => {
    if (!c || typeof c !== "object") { problems.push(`chunk ${i}: not an object`); return; }
    const o = c as Record<string, unknown>;
    const type = typeof o["type"] === "string" && o["type"] ? o["type"] : "semantic";
    if (SEED_UNROLLABLE.has(type)) { problems.push(`chunk ${i}: type "${type}" is protected from deletion, so it can't be seeded (no rollback)`); return; }
    const tags = o["tags"] === undefined ? [] : o["tags"];
    if (!Array.isArray(tags) || tags.length > 20 || !tags.every((t) => typeof t === "string" && SEED_TAG_RE.test(t))) {
      problems.push(`chunk ${i}: tags must be up to 20 short strings (letters, digits, space _ . : / -)`); return;
    }
    const content = typeof o["content"] === "string" && tags.length ? `${o["content"]}\n\nTags: ${tags.join(", ")}` : o["content"];
    const v = validateBrainWrite({ type, label: o["label"], content, importance: o["importance"] });
    if (!v.ok) { problems.push(`chunk ${i}: ${formatValidationErrors(v.errors!).replace(/\n/g, "; ")}`); return; }
    const d = v.data!;
    out.push({ type: d.type as NodeType, label: d.label, content: d.content, importance: d.importance, src: seedSourceFor(source, d.type, d.label, d.content) });
  });
  if (problems.length) return { error: `Invalid chunks:\n${problems.slice(0, 20).join("\n")}${problems.length > 20 ? `\n(+${problems.length - 20} more)` : ""}` };
  return { chunks: out };
}

/** Node ids whose source starts with `seed:<source>#` (or any seed when source is "*"). */
function seededRows(brain: string, source: string): Array<{ id: string; source: string }> {
  const prefix = source === "*" ? "seed:" : `seed:${source}#`;
  return getDb(brain)
    .prepare("SELECT id, source FROM nodes WHERE substr(source, 1, ?) = ? ORDER BY created_at")
    .all(prefix.length, prefix) as Array<{ id: string; source: string }>;
}

async function brainSeed(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutput> {
  const p = ctx.principal;
  if (!p.scopes.has("admin")) return err("forbidden — brain_seed needs the admin scope");
  const mode = args["mode"];
  if (mode !== "import" && mode !== "dry-run" && mode !== "remove" && mode !== "list") return err("mode must be import, dry-run, remove, or list");
  const source = args["source"];
  if (typeof source !== "string" || !(SEED_SOURCE_RE.test(source) || (source === "*" && mode === "list"))) {
    return err(`source must be a file name (letters, digits, . _ -; max 128)${mode === "list" ? ' or "*"' : ""}`);
  }
  const vis = visibilityOf(args);
  if (vis === "invalid") return err(`visibility must be "private" or "shared"`);
  const brain = vis === "shared" ? SHARED_BRAIN : ctx.brains.privateBrain(p.agentId);
  const where = label(ctx, brain);

  if (mode === "list") {
    const rows = await ctx.brains.write(brain, () => seededRows(brain, source));
    const bySource: Record<string, number> = {};
    for (const r of rows) {
      const f = r.source.slice("seed:".length).split("#")[0]!;
      bySource[f] = (bySource[f] ?? 0) + 1;
    }
    return ok(JSON.stringify({ mode, brain: where, total: rows.length, sources: bySource }, null, 2));
  }

  if (mode === "remove") {
    const removed = await ctx.brains.write(brain, () => {
      const noop = { info: () => {}, warn: () => {}, error: () => {} };
      const ids: string[] = [];
      for (const r of seededRows(brain, source)) {
        if (forgetNodeById(brain, r.id, noop, { force: true }).ok) ids.push(r.id);
      }
      return ids;
    });
    for (const id of removed) ctx.audit.append({ agentId: p.agentId, tool: "brain_seed", brain, nodeId: id, outcome: "ok", detail: `remove seed:${source}` });
    return ok(JSON.stringify({ mode, brain: where, source, removed: removed.length }, null, 2));
  }

  const prep = prepareSeedChunks(source, args["chunks"]);
  if ("error" in prep) return err(prep.error);
  const prune = args["prune"] === true;
  const res = await ctx.brains.write(brain, () => {
    const existing = new Map(seededRows(brain, source).map((r) => [r.source, r.id]));
    const seen = new Set<string>();
    const created: string[] = [];
    let already = 0;
    let duplicateInBatch = 0;
    for (const c of prep.chunks) {
      if (seen.has(c.src)) { duplicateInBatch++; continue; }
      seen.add(c.src);
      if (existing.has(c.src)) { already++; continue; }
      if (mode === "import") {
        const id = writeNode(brain, c.type, c.label, c.content, {
          importance: c.importance ?? 0.6, source: c.src, writerAgentId: p.agentId, deduplicate: false,
        });
        queueEmbedding(brain, id);
        created.push(id);
      } else {
        created.push("");
      }
    }
    const stale = [...existing.entries()].filter(([src]) => !seen.has(src)).map(([, id]) => id);
    const pruned: string[] = [];
    if (mode === "import" && prune) {
      const noop = { info: () => {}, warn: () => {}, error: () => {} };
      for (const id of stale) if (forgetNodeById(brain, id, noop, { force: true }).ok) pruned.push(id);
    }
    return { created, already, duplicateInBatch, stale: stale.length, pruned };
  });
  if (mode === "import") {
    for (const id of res.created) ctx.audit.append({ agentId: p.agentId, tool: "brain_seed", brain, nodeId: id, outcome: "ok", detail: `seed:${source}` });
    for (const id of res.pruned) ctx.audit.append({ agentId: p.agentId, tool: "brain_seed", brain, nodeId: id, outcome: "ok", detail: `prune seed:${source}` });
  }
  return ok(JSON.stringify({
    mode, brain: where, source, writer: p.agentId,
    chunks: prep.chunks.length,
    [mode === "import" ? "created" : "wouldCreate"]: res.created.length,
    existing: res.already,
    duplicateInBatch: res.duplicateInBatch,
    staleFromEarlierVersions: res.stale,
    ...(mode === "import" ? { pruned: res.pruned.length } : {}),
  }, null, 2));
}

// ─── helpers ────────────────────────────────────────────────────────────────

function ok(text: string): ToolOutput {
  return { text };
}
function err(text: string): ToolOutput {
  return { text: `Error: ${text}`, isError: true };
}
function has(p: Principal, s: Scope): boolean {
  return p.scopes.has(s) || p.scopes.has("admin");
}
function visibilityOf(args: Record<string, unknown>): Visibility | null | "invalid" {
  const v = args["visibility"];
  if (v === undefined || v === null || v === "") return null;
  if (v === "private" || v === "shared") return v;
  return "invalid";
}
function stripClientFields(args: Record<string, unknown>): Record<string, unknown> {
  const { visibility: _v, writer_agent_id: _w, agent: _a, scope: _s, format: _f, ...rest } = args;
  return rest;
}

/** Resolve the target brain for a MUTATION, enforcing scopes. */
function writeTarget(ctx: ToolContext, tool: string, args: Record<string, unknown>): { brain: string } | ToolOutput {
  const vis = visibilityOf(args);
  if (vis === "invalid") return err(`visibility must be "private" or "shared"`);
  const p = ctx.principal;
  if (!has(p, "write") && !has(p, "shared-write")) return err(`forbidden — this token has no write scope`);
  if (vis === "shared") {
    if (!has(p, "shared-write")) {
      ctx.audit.append({ agentId: p.agentId, tool, brain: SHARED_BRAIN, nodeId: null, outcome: "denied", detail: "missing shared-write scope" });
      return err(`forbidden — writing to the shared brain needs the shared-write scope`);
    }
    return { brain: SHARED_BRAIN };
  }
  if (!has(p, "write")) return err(`forbidden — this token has no write scope for its private brain`);
  return { brain: ctx.brains.privateBrain(p.agentId) };
}

function readBrains(ctx: ToolContext, which: "all" | "private" | "shared"): string[] {
  const mine = ctx.brains.privateBrain(ctx.principal.agentId);
  if (which === "private") return [mine];
  if (which === "shared") return [SHARED_BRAIN];
  return [mine, SHARED_BRAIN];
}

function label(ctx: ToolContext, brain: string): "private" | "shared" {
  return brain === SHARED_BRAIN ? "shared" : "private";
}

// ─── recall ─────────────────────────────────────────────────────────────────

/**
 * Hybrid recall on one brain using core's primitives (the same pipeline as
 * core's hybridRetrieve). With `reinforce`, the recalled nodes are touched
 * (FSRS reinforcement) and working memory updated — that is a mutation, so the
 * caller runs it on the write queue. The shared brain is recalled with
 * reinforce=false: reading shared memories never mutates them.
 */
function recall(
  brain: string,
  query: string,
  emb: Float32Array | null,
  cfg: BrainConfig,
  sessionId: string | null,
  reinforce: boolean,
): ActivatedNode[] {
  const limit = cfg.recallTopK;
  const fts = ftsSearchNodes(brain, query, limit * 2);
  const vec: BrainNode[] = emb ? vectorSearchNodes(brain, emb, limit * 2) : [];
  const fused = vec.length > 0 ? rrfFuse([fts, vec]) : fts;
  const seeds = fused.slice(0, limit);
  if (seeds.length === 0) return [];
  const neuro = getNeuromodulatorState(brain);
  const pre = new Map<string, number>(seeds.map((n) => [n.id, n.salience]));
  if (sessionId) workingMemoryBoost(pre, sessionId, brain);
  const top = spreadActivation(brain, seeds, cfg, emb, neuro, pre).slice(0, limit);
  if (reinforce && sessionId) {
    for (const n of top) touchNode(brain, n.id);
    updateWorkingMemory(brain, sessionId, top, cfg.workingMemorySlots);
  }
  return top;
}

async function embedQuery(query: string, cfg: BrainConfig): Promise<Float32Array | null> {
  if (!query) return null;
  try {
    return await Promise.race([
      fetchEmbedding(query, cfg),
      new Promise<null>((r) => { const t = setTimeout(() => r(null), 2000); t.unref?.(); }),
    ]);
  } catch {
    return null;
  }
}

// ─── read-connection queries ────────────────────────────────────────────────

function readNode(db: Database.Database, id: string): BrainNode | undefined {
  return db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as BrainNode | undefined;
}

function findNodeBrain(ctx: ToolContext, nodeId: string, vis: Visibility | null): string | null {
  const order = vis ? [vis === "shared" ? SHARED_BRAIN : ctx.brains.privateBrain(ctx.principal.agentId)] : readBrains(ctx, "all");
  for (const b of order) {
    if (ctx.brains.read(b, (db) => readNode(db, nodeId))) return b;
  }
  return null;
}

interface BrainStats {
  brain: "private" | "shared";
  nodes: number;
  nodesByType: Record<string, number>;
  activeEdges: number;
  episodes: number;
  embedded: number;
  writers: Record<string, number>;
  lastConsolidation: string | null;
}

function statsFor(db: Database.Database, which: "private" | "shared"): BrainStats {
  const byType = db.prepare("SELECT type, COUNT(*) AS n FROM nodes GROUP BY type ORDER BY type").all() as Array<{ type: string; n: number }>;
  const nodes = byType.reduce((s, r) => s + r.n, 0);
  const activeEdges = (db.prepare("SELECT COUNT(*) AS n FROM edges WHERE valid_until IS NULL").get() as { n: number }).n;
  const episodes = (db.prepare("SELECT COUNT(*) AS n FROM episodes").get() as { n: number }).n;
  const embedded = (db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE embedding IS NOT NULL").get() as { n: number }).n;
  let writers: Array<{ w: string | null; n: number }> = [];
  try {
    writers = db.prepare("SELECT writer_agent_id AS w, COUNT(*) AS n FROM nodes GROUP BY writer_agent_id ORDER BY n DESC LIMIT 20").all() as typeof writers;
  } catch { /* pre-v18 brain opened read-only */ }
  let last: string | null = null;
  try {
    const row = db.prepare("SELECT value FROM meta_kv WHERE key = 'last_consolidation'").get() as { value: string } | undefined;
    if (row?.value) last = new Date(Number(row.value)).toISOString();
  } catch { /* */ }
  return {
    brain: which,
    nodes,
    nodesByType: Object.fromEntries(byType.map((r) => [r.type, r.n])),
    activeEdges,
    episodes,
    embedded,
    writers: Object.fromEntries(writers.map((r) => [r.w ?? "(none)", r.n])),
    lastConsolidation: last,
  };
}

// ─── dispatcher ─────────────────────────────────────────────────────────────

export async function callTool(ctx: ToolContext, name: string, rawArgs: Record<string, unknown>): Promise<ToolOutput> {
  if (name === EPISODE_TOOL_NAME) {
    try { return await callEpisodeAppend(ctx, rawArgs ?? {}); } catch (e) { return err(String(e instanceof Error ? e.message : e)); }
  }
  if (!TOOL_NAMES.has(name)) return err(`unknown tool: ${name}`);
  const args = rawArgs ?? {};
  const p = ctx.principal;
  const cfg = ctx.brainConfig;
  try {
    switch (name) {
      case "brain_seed":
        return await brainSeed(ctx, args);

      case "brain_query": {
        if (!has(p, "read")) return err("forbidden — this token has no read scope");
        const v = validateBrainQuery(stripClientFields(args));
        if (!v.ok) return err(`Invalid arguments:\n${formatValidationErrors(v.errors!)}`);
        const { query, type: typeFilter, limit } = v.data!;
        const scopeArg = args["scope"] ?? "all";
        if (scopeArg !== "all" && scopeArg !== "private" && scopeArg !== "shared") return err(`scope must be all, private, or shared`);
        const emb = await embedQuery(query, cfg);
        const sid = ctx.sessionId(p.agentId);
        type Hit = { brain: "private" | "shared"; node: ActivatedNode };
        const hits: Hit[] = [];
        for (const brain of readBrains(ctx, scopeArg)) {
          const rows = brain === SHARED_BRAIN
            ? recall(brain, query, emb, cfg, null, false)
            : await ctx.brains.write(brain, () => recall(brain, query, emb, cfg, sid, true));
          for (const node of rows) hits.push({ brain: label(ctx, brain), node });
        }
        let merged = hits.sort((a, b) => b.node.activation - a.node.activation);
        if (typeFilter) merged = merged.filter((h) => h.node.type === typeFilter);
        merged = merged.slice(0, limit ?? 10);
        if (args["format"] === "json") {
          return ok(JSON.stringify({
            results: merged.map((h) => ({
              brain: h.brain, id: h.node.id, type: h.node.type, label: h.node.label, content: h.node.content,
              score: round(h.node.activation), retrievability: round(h.node.retrievability),
              importance: round(h.node.importance), writer: h.node.writer_agent_id ?? null,
            })),
          }, null, 2));
        }
        if (merged.length === 0) return ok("No matching nodes found.");
        return ok(merged.map((h) => {
          const n = h.node;
          const writer = n.writer_agent_id ? ` writer=${n.writer_agent_id}` : "";
          return `[${h.brain}] ${n.id} (${n.type}) ${n.label}\n  ${n.content.slice(0, 300)}\n  score=${n.activation.toFixed(2)} R=${n.retrievability.toFixed(2)} imp=${n.importance.toFixed(2)}${writer}`;
        }).join("\n\n"));
      }

      case "brain_write": {
        const t = writeTarget(ctx, name, args);
        if ("text" in t) return t;
        const claimed = typeof args["writer_agent_id"] === "string" ? args["writer_agent_id"] : null;
        const v = validateBrainWrite(stripClientFields(args));
        if (!v.ok) return err(`Invalid arguments:\n${formatValidationErrors(v.errors!)}`);
        const { type, label: lbl, content, importance, emotional_weight } = v.data!;
        const started = Date.now();
        const { id, merged } = await ctx.brains.write(t.brain, () => {
          const nodeId = writeNode(t.brain, type as NodeType, lbl, content, {
            importance, emotional_weight, source: WRITE_SOURCE, writerAgentId: p.agentId,
          });
          queueEmbedding(t.brain, nodeId);
          const row = getNode(t.brain, nodeId);
          return { id: nodeId, merged: !!row && row.created_at < started };
        });
        ctx.audit.append({ agentId: p.agentId, tool: name, brain: t.brain, nodeId: id, outcome: "ok", ...(merged ? { detail: "merged-into-near-duplicate" } : {}) });
        const brainLabel = label(ctx, t.brain);
        let text = `Written: node ${id} (${type}) "${lbl}" brain=${brainLabel} writer=${p.agentId}`;
        if (merged) text += " (merged into an existing near-duplicate node)";
        if (claimed && claimed !== p.agentId) text += `\nNote: client-supplied writer_agent_id "${claimed}" was ignored; the writer is the token's agent.`;
        return ok(text);
      }

      case "brain_link": {
        const t = writeTarget(ctx, name, args);
        if ("text" in t) return t;
        const v = validateBrainLink(stripClientFields(args));
        if (!v.ok) return err(`Invalid arguments:\n${formatValidationErrors(v.errors!)}`);
        const { from_id, to_id, edge_type, weight } = v.data!;
        const res = await ctx.brains.write(t.brain, () => {
          if (!getNode(t.brain, from_id)) return { error: `node ${from_id} not found in the ${label(ctx, t.brain)} brain` };
          if (!getNode(t.brain, to_id)) return { error: `node ${to_id} not found in the ${label(ctx, t.brain)} brain` };
          const edgeId = writeEdge(t.brain, from_id, to_id, edge_type as EdgeType, { weight, writerAgentId: p.agentId });
          return { edgeId };
        });
        if ("error" in res) return err(res.error!);
        if (!res.edgeId) return err("edge refused (self-loop)");
        ctx.audit.append({ agentId: p.agentId, tool: name, brain: t.brain, nodeId: from_id, edgeId: res.edgeId, outcome: "ok" });
        return ok(`Linked: edge ${res.edgeId} (${from_id} --${edge_type}--> ${to_id}) brain=${label(ctx, t.brain)}`);
      }

      case "brain_supersede": {
        const t = writeTarget(ctx, name, args);
        if ("text" in t) return t;
        const v = validateBrainSupersede(stripClientFields(args));
        if (!v.ok) return err(`Invalid arguments:\n${formatValidationErrors(v.errors!)}`);
        const { old_node_id, new_content, new_label } = v.data!;
        const res = await ctx.brains.write(t.brain, () => {
          const old = getNode(t.brain, old_node_id);
          if (!old) return { error: `node ${old_node_id} not found in the ${label(ctx, t.brain)} brain` };
          const newId = writeNode(t.brain, old.type as NodeType, new_label ?? old.label, new_content, {
            importance: old.importance, emotional_weight: old.emotional_weight, source: WRITE_SOURCE,
            writerAgentId: p.agentId, deduplicate: false,
          });
          queueEmbedding(t.brain, newId);
          closeEdgesFromNode(t.brain, old.id);
          closeEdgesToNode(t.brain, old.id);
          writeEdge(t.brain, newId, old.id, "supersedes", { writerAgentId: p.agentId });
          return { newId, oldId: old.id };
        });
        if ("error" in res) return err(res.error!);
        ctx.audit.append({ agentId: p.agentId, tool: name, brain: t.brain, nodeId: res.newId!, outcome: "ok", detail: `supersedes ${res.oldId}` });
        return ok(`Superseded: ${res.oldId} → new node ${res.newId} brain=${label(ctx, t.brain)} writer=${p.agentId}`);
      }

      case "brain_review":
      case "brain_forget": {
        const t = writeTarget(ctx, name, args);
        if ("text" in t) return t;
        const clean = stripClientFields(args);
        const r = await ctx.brains.write(t.brain, () => dispatchBrainTool(name, t.brain, clean, cfg, WRITE_SOURCE));
        if (!r.isError) {
          ctx.audit.append({ agentId: p.agentId, tool: name, brain: t.brain, nodeId: String(clean["node_id"] ?? ""), outcome: "ok" });
        }
        return { text: r.text + (r.isError ? "" : `\n(brain=${label(ctx, t.brain)})`), ...(r.isError ? { isError: true } : {}) };
      }

      case "brain_reset": {
        if (!ctx.allowReset) return err("brain_reset is disabled on this service (set allowReset: true to enable; admin scope required)");
        if (!p.scopes.has("admin")) return err("forbidden — brain_reset needs the admin scope");
        const vis = visibilityOf(args);
        if (vis === "invalid") return err(`visibility must be "private" or "shared"`);
        const brain = vis === "shared" ? SHARED_BRAIN : ctx.brains.privateBrain(p.agentId);
        const r = await ctx.brains.write(brain, () => dispatchBrainTool(name, brain, { confirm: args["confirm"] }, cfg, WRITE_SOURCE));
        ctx.audit.append({ agentId: p.agentId, tool: name, brain, nodeId: null, outcome: r.isError ? "error" : "ok" });
        return { text: r.text, ...(r.isError ? { isError: true } : {}) };
      }

      case "brain_stats": {
        if (!has(p, "read")) return err("forbidden — this token has no read scope");
        const which = (args["visibility"] ?? "all") as string;
        if (which !== "all" && which !== "private" && which !== "shared") return err("visibility must be all, private, or shared");
        const stats = readBrains(ctx, which).map((b) => ctx.brains.read(b, (db) => statsFor(db, label(ctx, b))));
        if (args["format"] === "json") return ok(JSON.stringify({ agentId: p.agentId, brains: stats }, null, 2));
        return ok(stats.map((s) => [
          `[${s.brain}] nodes=${s.nodes} edges=${s.activeEdges} episodes=${s.episodes} embedded=${s.embedded}/${s.nodes}`,
          `  by type: ${Object.entries(s.nodesByType).map(([k, n]) => `${k}=${n}`).join(" ") || "(empty)"}`,
          `  writers: ${Object.entries(s.writers).map(([k, n]) => `${k}=${n}`).join(" ") || "(none)"}`,
          `  last consolidation: ${s.lastConsolidation ?? "never"}`,
        ].join("\n")).join("\n\n"));
      }

      case "brain_history": {
        if (!has(p, "read")) return err("forbidden — this token has no read scope");
        const vis = visibilityOf(args);
        if (vis === "invalid") return err(`visibility must be "private" or "shared"`);
        const v = validateBrainHistory(stripClientFields(args));
        if (!v.ok) return err(`Invalid arguments:\n${formatValidationErrors(v.errors!)}`);
        const { query, since, until, limit = 10 } = v.data!;
        const brain = vis === "shared" ? SHARED_BRAIN : ctx.brains.privateBrain(p.agentId);
        const safe = query.replace(/"/g, "").trim();
        if (!safe) return ok("No matching episodes found.");
        let rows = ctx.brains.read(brain, (db) => {
          try {
            return db.prepare(`SELECT e.* FROM episodes e JOIN episodes_fts f ON e.rowid = f.rowid
              WHERE episodes_fts MATCH ? ORDER BY rank LIMIT ?`).all(`"${safe}"`, limit * 2) as Array<{ created_at: number; role: string; content: string; writer_agent_id?: string | null }>;
          } catch { return []; }
        });
        if (since != null) rows = rows.filter((e) => e.created_at >= since);
        if (until != null) rows = rows.filter((e) => e.created_at <= until);
        rows = rows.slice(0, limit);
        if (rows.length === 0) return ok("No matching episodes found.");
        return ok(rows.map((e) => {
          const ts = new Date(e.created_at).toISOString().slice(0, 16).replace("T", " ");
          return `[${ts}] ${e.role}: ${e.content.slice(0, 300)}${e.writer_agent_id ? ` writer=${e.writer_agent_id}` : ""}`;
        }).join("\n\n"));
      }

      case "brain_expand": {
        if (!has(p, "read")) return err("forbidden — this token has no read scope");
        const vis = visibilityOf(args);
        if (vis === "invalid") return err(`visibility must be "private" or "shared"`);
        const v = validateBrainExpand(stripClientFields(args));
        if (!v.ok) return err(`Invalid arguments:\n${formatValidationErrors(v.errors!)}`);
        const { node_id } = v.data!;
        const brain = findNodeBrain(ctx, node_id, vis);
        if (!brain) return err(`node ${node_id} not found`);
        const node = ctx.brains.read(brain, (db) => readNode(db, node_id))!;
        if (args["format"] === "json") {
          const { embedding: _e, ps_hash: _p, ...rest } = node;
          return ok(JSON.stringify({ brain: label(ctx, brain), node: rest }, null, 2));
        }
        const lines = [
          `Node: ${node.id} (${node.type}) ${node.label}   [${label(ctx, brain)}]`,
          `Content: ${node.content}`,
          `Importance: ${node.importance.toFixed(2)} | Stability: ${node.stability.toFixed(1)}d | R: ${node.retrievability.toFixed(3)}`,
          `Access count: ${node.access_count} | Consolidated: ${node.is_consolidated === 1 ? "yes" : "no"}`,
          `Created: ${new Date(node.created_at).toISOString()} | Accessed: ${new Date(node.accessed_at).toISOString()}`,
          `Writer: ${node.writer_agent_id ?? "(none)"} | Source: ${node.source ?? "(none)"}`,
        ];
        if (node.valid_until) lines.push(`Valid until: ${new Date(node.valid_until).toISOString()} (superseded/expired)`);
        return ok(lines.join("\n"));
      }

      case "brain_edges": {
        if (!has(p, "read")) return err("forbidden — this token has no read scope");
        const vis = visibilityOf(args);
        if (vis === "invalid") return err(`visibility must be "private" or "shared"`);
        const v = validateBrainEdges(stripClientFields(args));
        if (!v.ok) return err(`Invalid arguments:\n${formatValidationErrors(v.errors!)}`);
        const { node_id } = v.data!;
        const brain = findNodeBrain(ctx, node_id, vis);
        if (!brain) return err(`node ${node_id} not found`);
        const out = ctx.brains.read(brain, (db) => {
          const node = readNode(db, node_id)!;
          const outgoing = db.prepare(`SELECT e.id, e.type, e.to_id AS other, e.weight, n.label, n.type AS ntype
            FROM edges e JOIN nodes n ON e.to_id = n.id WHERE e.from_id = ? AND e.valid_until IS NULL LIMIT 50`).all(node_id) as EdgeRow[];
          const incoming = db.prepare(`SELECT e.id, e.type, e.from_id AS other, e.weight, n.label, n.type AS ntype
            FROM edges e JOIN nodes n ON e.from_id = n.id WHERE e.to_id = ? AND e.valid_until IS NULL LIMIT 50`).all(node_id) as EdgeRow[];
          const map = (e: EdgeRow) => ({ edgeId: e.id, edgeType: e.type, connectedId: e.other, connectedLabel: e.label, connectedType: e.ntype, weight: e.weight });
          return { brain: label(ctx, brain), nodeId: node_id, nodeLabel: node.label, nodeType: node.type, outgoing: outgoing.map(map), incoming: incoming.map(map) };
        });
        return ok(JSON.stringify(out, null, 2));
      }
    }
  } catch (e) {
    return err(String(e instanceof Error ? e.message : e));
  }
  return err(`unknown tool: ${name}`);
}

interface EdgeRow { id: string; type: string; other: string; weight: number; label: string; ntype: string }

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
