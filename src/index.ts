import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { writeNode, getNode, touchNode } from "./nodes.js";
import { writeEdge, closeEdgesFromNode, closeEdgesToNode } from "./edges.js";
import { getSelfModel } from "./self-model.js";
import { searchEpisodes, getEpisodesByIds } from "./episodes.js";
import { getDb, getMeta } from "./db.js";
import { getNeuromodulatorState, forgetNodeById } from "./consolidation.js";
import { hybridRetrieve } from "./retrieval.js";
import { drainEmbeddingQueue, queueEmbedding } from "./embeddings.js";
import { clearStaleWorkingMemory } from "./activation.js";
import { checkForUpdate } from "./update-check.js";
import { DEFAULT_CONFIG } from "./types.js";
import type { BrainConfig, NodeType, EdgeType } from "./types.js";
import { randomUUID } from "node:crypto";

// NEW: Input validation
import {
  validateBrainQuery,
  validateBrainWrite,
  validateBrainLink,
  validateBrainSupersede,
  validateBrainHistory,
  validateBrainExpand,
  validateBrainReview,
  validateBrainForget,
  validateBrainEdges,
  formatValidationErrors,
} from "./validation.js";

// NEW: Database backup
import { createBackup, getLatestBackup, listBackups } from "./db-backup.js";

// NEW: Metrics and observability
import {
  collectMetrics,
  formatPrometheusMetrics,
  formatMetricsAsText,
} from "./metrics.js";

// NEW: Resilience utilities
import { withFallback } from "./resilience.js";

// Injected from package.json at build time by esbuild.mjs — never hardcode it.
// A stale constant misreports the server over MCP and makes checkForUpdate
// compare against the wrong version, nagging users to install what they have.
// The fallback only applies when running the TypeScript directly (tsx/ts-node).
declare const __SHARPWAVE_VERSION__: string;
const VERSION = typeof __SHARPWAVE_VERSION__ === "string" ? __SHARPWAVE_VERSION__ : "0.0.0-dev";

const AGENT_ID = process.env["SHARPWAVE_AGENT_ID"] ?? "default";
const config: BrainConfig = { ...DEFAULT_CONFIG };

// One stdio server process == one conversation, so the session id is minted per
// process. 0.1.0 hardcoded a single literal here, which meant working memory was
// never scoped to a conversation: the last N retrieved nodes were replayed into
// every later query, across restarts, regardless of relevance.
const SESSION_ID = `mcp:${randomUUID()}`;

// Start embedding drain in background every 30s
setInterval(() => {
  void drainEmbeddingQueue(AGENT_ID, config);
}, 30_000);

// ─── Tool helpers ────────────────────────────────────────────────────────

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function err(text: string) {
  return { content: [{ type: "text" as const, text: `Error: ${text}` }], isError: true };
}

// ─── Tool definitions ───────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "brain_query",
    description:
      "Search and recall memories using hybrid FTS + vector + spreading activation. Returns ranked nodes with retrievability and salience scores.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language search query" },
        type:  { type: "string", description: "Filter by node type: identity|semantic|episodic|pattern|skill|goal|emotion|procedural|schema" },
        limit: { type: "number", description: "Max results to return (default 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "brain_write",
    description:
      "Store a new memory node. Automatically queues for embedding and PRISM/NEXUS auto-linking.",
    inputSchema: {
      type: "object",
      properties: {
        type:             { type: "string", description: "Node type: identity|semantic|episodic|pattern|skill|goal|emotion|procedural|schema" },
        label:            { type: "string", description: "Short name for this memory" },
        content:          { type: "string", description: "Full content of the memory" },
        importance:       { type: "number", description: "0.0–1.0, default 0.5" },
        emotional_weight: { type: "number", description: "-1.0 to 1.0 (emotional salience)" },
      },
      required: ["type", "label", "content"],
    },
  },
  {
    name: "brain_link",
    description: "Create a typed edge between two existing nodes.",
    inputSchema: {
      type: "object",
      properties: {
        from_id:   { type: "string", description: "Source node ID" },
        to_id:     { type: "string", description: "Target node ID" },
        edge_type: { type: "string", description: "Edge type: caused_by|associates|supports|instance_of|goal_of|before|after|inhibits|summarizes|attaches_to|contradicts|supersedes|coreference_of" },
        weight:    { type: "number", description: "Edge weight 0.0–1.0 (default 1.0)" },
      },
      required: ["from_id", "to_id", "edge_type"],
    },
  },
  {
    name: "brain_supersede",
    description:
      "Replace an outdated node with updated content. Closes old edges, writes a supersedes edge, preserving the memory graph's temporal integrity.",
    inputSchema: {
      type: "object",
      properties: {
        old_node_id: { type: "string", description: "ID of the node being superseded" },
        new_content: { type: "string", description: "Updated content for the replacement node" },
        new_label:   { type: "string", description: "Updated label (defaults to old label)" },
      },
      required: ["old_node_id", "new_content"],
    },
  },
  {
    name: "brain_stats",
    description:
      "Return brain statistics: node/edge/episode counts, neuromodulator state, consolidation status, embedding coverage. Supports format=prometheus for Prometheus metrics.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", description: "Output format: text (default) or prometheus" },
      },
    },
  },
  {
    name: "brain_history",
    description: "Search episode history (raw conversation turns) by keyword.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query for episode history" },
        since: { type: "number", description: "Unix ms timestamp — only return episodes after this" },
        until: { type: "number", description: "Unix ms timestamp — only return episodes before this" },
        limit: { type: "number", description: "Max results (default 10)" },
      },
      required: ["query"],
    },
  },
  {
    name: "brain_expand",
    description:
      "Get full detail for a specific node: content, FSRS metrics, encoding context, and source episodes.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "Node ID to expand" },
      },
      required: ["node_id"],
    },
  },
  {
    name: "brain_review",
    description:
      "Apply an FSRS-6 spaced-repetition review to a node. Updates stability, retrievability, and SIGMA calibration.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "ID of the node to review" },
        quality: {
          type: "integer",
          minimum: 0,
          maximum: 5,
          description: "Recall quality: 0=blackout, 1=incorrect, 2=incorrect+familiar, 3=hard, 4=correct, 5=perfect",
        },
      },
      required: ["node_id", "quality"],
    },
  },
  {
    name: "brain_forget",
    description:
      "Physically delete a node from the brain. Refuses to delete nodes with active edges unless force=true.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "ID of the node to delete" },
        force:   { type: "boolean", description: "If true, also drops active edges (default false)" },
      },
      required: ["node_id"],
    },
  },
  {
    name: "brain_edges",
    description: "Get all active incoming and outgoing edges for a node.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "Node ID to inspect" },
      },
      required: ["node_id"],
    },
  },
] as const;

// ─── Tool handlers ────────────────────────────────────────────────────────

async function handleBrainQuery(args: Record<string, unknown>) {
  const validation = validateBrainQuery(args);
  if (!validation.ok) {
    return err(`Invalid arguments:\n${formatValidationErrors(validation.errors!)}`);
  }
  const { query, type: typeFilter, limit } = validation.data!;

  let results = await hybridRetrieve(AGENT_ID, query, SESSION_ID, config);
  if (typeFilter) results = results.filter((n) => n.type === typeFilter);
  if (results.length === 0) return ok("No matching nodes found.");

  const lines = results.slice(0, limit).map((n) =>
    `[${n.id.slice(0, 8)}] (${n.type}) ${n.label}\n  ${n.content.slice(0, 300)}\n  R=${n.retrievability.toFixed(2)} sal=${n.salience.toFixed(2)} imp=${n.importance.toFixed(2)}`
  );
  return ok(lines.join("\n\n"));
}

function handleBrainWrite(args: Record<string, unknown>) {
  const validation = validateBrainWrite(args);
  if (!validation.ok) {
    return err(`Invalid arguments:\n${formatValidationErrors(validation.errors!)}`);
  }
  const { type, label, content, importance, emotional_weight } = validation.data!;

  const nodeId = writeNode(AGENT_ID, type as NodeType, label, content, {
    importance,
    emotional_weight,
    source: "mcp",
  });
  queueEmbedding(AGENT_ID, nodeId);
  return ok(`Written: node ${nodeId} (${type}) "${label}"`);
}

function handleBrainLink(args: Record<string, unknown>) {
  const validation = validateBrainLink(args);
  if (!validation.ok) {
    return err(`Invalid arguments:\n${formatValidationErrors(validation.errors!)}`);
  }
  const { from_id, to_id, edge_type, weight } = validation.data!;

  if (!getNode(AGENT_ID, from_id)) return err(`node ${from_id} not found`);
  if (!getNode(AGENT_ID, to_id))   return err(`node ${to_id} not found`);

  const edgeId = writeEdge(AGENT_ID, from_id, to_id, edge_type as EdgeType, { weight });
  return ok(`Linked: edge ${edgeId} (${from_id.slice(0, 8)} --${edge_type}--> ${to_id.slice(0, 8)})`);
}

function handleBrainSupersede(args: Record<string, unknown>) {
  const validation = validateBrainSupersede(args);
  if (!validation.ok) {
    return err(`Invalid arguments:\n${formatValidationErrors(validation.errors!)}`);
  }
  const { old_node_id, new_content, new_label } = validation.data!;

  const old = getNode(AGENT_ID, old_node_id);
  if (!old) return err(`node ${old_node_id} not found`);

  const newId = writeNode(AGENT_ID, old.type as NodeType, new_label ?? old.label, new_content, {
    importance: old.importance,
    emotional_weight: old.emotional_weight,
    source: "mcp",
  });
  queueEmbedding(AGENT_ID, newId);
  closeEdgesFromNode(AGENT_ID, old.id);
  closeEdgesToNode(AGENT_ID, old.id);
  writeEdge(AGENT_ID, newId, old.id, "supersedes");
  return ok(`Superseded: ${old.id.slice(0, 8)} → new node ${newId.slice(0, 8)}`);
}

function handleBrainStats(args: Record<string, unknown>) {
  const format = String(args["format"] ?? "text").toLowerCase();

  try {
    const metrics = collectMetrics(AGENT_ID, config);
    
    if (format === "prometheus") {
      return ok(formatPrometheusMetrics(metrics));
    } else {
      return ok(formatMetricsAsText(metrics));
    }
  } catch (err) {
    return err(`Failed to collect metrics: ${String(err)}`);
  }
}

async function handleBrainHistory(args: Record<string, unknown>) {
  const validation = validateBrainHistory(args);
  if (!validation.ok) {
    return err(`Invalid arguments:\n${formatValidationErrors(validation.errors!)}`);
  }
  const { query, since, until, limit } = validation.data!;

  let results = searchEpisodes(AGENT_ID, query, limit * 2);
  if (since != null) results = results.filter((e) => e.created_at >= since);
  if (until != null) results = results.filter((e) => e.created_at <= until);
  results = results.slice(0, limit);

  if (results.length === 0) return ok("No matching episodes found.");
  const lines = results.map((e) => {
    const ts = new Date(e.created_at).toISOString().slice(0, 16).replace("T", " ");
    return `[${ts}] ${e.role}: ${e.content.slice(0, 300)}`;
  });
  return ok(lines.join("\n\n"));
}

function handleBrainExpand(args: Record<string, unknown>) {
  const validation = validateBrainExpand(args);
  if (!validation.ok) {
    return err(`Invalid arguments:\n${formatValidationErrors(validation.errors!)}`);
  }
  const { node_id } = validation.data!;

  const node = getNode(AGENT_ID, node_id);
  if (!node) return err(`node ${node_id} not found`);

  const lines = [
    `Node: [${node.id.slice(0, 8)}] (${node.type}) ${node.label}`,
    `Content: ${node.content}`,
    `Importance: ${node.importance.toFixed(2)} | Stability: ${node.stability.toFixed(1)}d | R: ${node.retrievability.toFixed(3)}`,
    `Difficulty: ${node.difficulty.toFixed(2)} | σ: ${node.stability_sigma.toFixed(3)} | Access count: ${node.access_count}`,
    `Ripple: ${node.ripple_count} | Trace: ${node.eligibility_trace.toFixed(3)} | Consolidated: ${node.is_consolidated === 1 ? "yes" : "no"}`,
    `Created: ${new Date(node.created_at).toISOString()} | Accessed: ${new Date(node.accessed_at).toISOString()}`,
  ];

  if (node.valid_from || node.valid_until) {
    const from = node.valid_from ? new Date(node.valid_from).toISOString() : "always";
    const until = node.valid_until ? new Date(node.valid_until).toISOString() : "current";
    lines.push(`Valid: ${from} → ${until}`);
  }

  if (node.encoding_context) {
    try {
      const ctx = JSON.parse(node.encoding_context) as Record<string, number>;
      lines.push(`Encoded under: dopa=${ctx["dopamine"]?.toFixed(2)} sero=${ctx["serotonin"]?.toFixed(2)} ach=${ctx["acetylcholine"]?.toFixed(2)}`);
    } catch { /* skip */ }
  }

  if (node.episode_ids) {
    try {
      const ids = JSON.parse(node.episode_ids) as string[];
      const episodes = getEpisodesByIds(AGENT_ID, ids);
      if (episodes.length > 0) {
        lines.push(`\nSource episodes (${episodes.length}):`);
        for (const e of episodes) {
          const ts = new Date(e.created_at).toISOString().slice(0, 16).replace("T", " ");
          lines.push(`  [${ts}] ${e.role}: ${e.content.slice(0, 300)}`);
        }
      }
    } catch { /* skip */ }
  }

  return ok(lines.join("\n"));
}

function handleBrainReview(args: Record<string, unknown>) {
  const validation = validateBrainReview(args);
  if (!validation.ok) {
    return err(`Invalid arguments:\n${formatValidationErrors(validation.errors!)}`);
  }
  const { node_id, quality } = validation.data!;

  const before = getNode(AGENT_ID, node_id);
  if (!before) return err(`node ${node_id} not found`);

  touchNode(AGENT_ID, node_id, quality);

  const after = getNode(AGENT_ID, node_id);
  if (!after) return err("could not re-read node after review");

  const outcome =
    quality < 3 ? "recall failed — stability reset" :
    quality === 3 ? "borderline — minimal growth" :
    quality === 4 ? "successful — stability reinforced" :
    "perfect — maximum reinforcement";

  return ok([
    `Reviewed: [${after.id.slice(0, 8)}] "${after.label}"`,
    `Quality: ${quality}/5 — ${outcome}`,
    `Retrievability: ${before.retrievability.toFixed(3)} → ${after.retrievability.toFixed(3)}`,
    `Stability: ${before.stability.toFixed(1)}d → ${after.stability.toFixed(1)}d`,
    `σ: ${before.stability_sigma.toFixed(3)} → ${after.stability_sigma.toFixed(3)}`,
  ].join("\n"));
}

function handleBrainForget(args: Record<string, unknown>) {
  const validation = validateBrainForget(args);
  if (!validation.ok) {
    return err(`Invalid arguments:\n${formatValidationErrors(validation.errors!)}`);
  }
  const { node_id, force } = validation.data!;

  const noop = { info: () => {}, warn: () => {}, error: () => {} };
  const result = forgetNodeById(AGENT_ID, node_id, noop, { force });

  if (result.ok) return ok(`Deleted node ${node_id} (edges cascaded).`);
  if (result.reason === "not_found") return err(`no node found with id ${node_id}`);
  if (result.reason?.startsWith("protected_type:")) {
    return err(`refused — '${result.reason.split(":")[1]}' nodes are protected from deletion`);
  }
  if (result.reason?.startsWith("has_live_edges:")) {
    const n = result.reason.split(":")[1];
    return err(`refused — node has ${n} active edge(s). Use force=true to delete anyway`);
  }
  return err(result.reason ?? "unknown");
}

function handleBrainEdges(args: Record<string, unknown>) {
  const validation = validateBrainEdges(args);
  if (!validation.ok) {
    return err(`Invalid arguments:\n${formatValidationErrors(validation.errors!)}`);
  }
  const { node_id } = validation.data!;

  const node = getNode(AGENT_ID, node_id);
  if (!node) return err(`node ${node_id} not found`);

  const db = getDb(AGENT_ID);

  const edgesFrom = db.prepare(`
    SELECT e.id, e.type, e.to_id, e.weight, n.label as to_label, n.type as to_type
    FROM edges e JOIN nodes n ON e.to_id = n.id
    WHERE e.from_id = ? AND e.valid_until IS NULL LIMIT 50
  `).all(node_id) as Array<{ id: string; type: string; to_id: string; to_label: string; to_type: string; weight: number }>;

  const edgesTo = db.prepare(`
    SELECT e.id, e.type, e.from_id, e.weight, n.label as from_label, n.type as from_type
    FROM edges e JOIN nodes n ON e.from_id = n.id
    WHERE e.to_id = ? AND e.valid_until IS NULL LIMIT 50
  `).all(node_id) as Array<{ id: string; type: string; from_id: string; from_label: string; from_type: string; weight: number }>;

  return ok(JSON.stringify({
    nodeId: node_id,
    nodeLabel: node.label,
    nodeType: node.type,
    outgoing: edgesFrom.map((e) => ({
      edgeId: e.id, edgeType: e.type, connectedId: e.to_id, connectedLabel: e.to_label, connectedType: e.to_type, weight: e.weight,
    })),
    incoming: edgesTo.map((e) => ({
      edgeId: e.id, edgeType: e.type, connectedId: e.from_id, connectedLabel: e.from_label, connectedType: e.from_type, weight: e.weight,
    })),
  }, null, 2));
}

// ─── Dispatcher ─────────────────────────────────────────────────────────

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

async function dispatch(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case "brain_query":    return await handleBrainQuery(args);
    case "brain_write":    return handleBrainWrite(args);
    case "brain_link":     return handleBrainLink(args);
    case "brain_supersede": return handleBrainSupersede(args);
    case "brain_stats":    return handleBrainStats(args);
    case "brain_history":  return await handleBrainHistory(args);
    case "brain_expand":   return handleBrainExpand(args);
    case "brain_review":   return handleBrainReview(args);
    case "brain_forget":   return handleBrainForget(args);
    case "brain_edges":    return handleBrainEdges(args);
    default:
      return err(`unknown tool: ${name}`);
  }
}

// ─── MCP server setup ───────────────────────────────────────────────────────

const server = new Server(
  { name: "sharpwave", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return await dispatch(name, (args as Record<string, unknown>) ?? {});
});

// Anything in working_memory at startup was written by a session that no longer
// exists. Dropping it also repairs databases left poisoned by 0.1.0.
let purged = 0;
try {
  purged = clearStaleWorkingMemory(AGENT_ID);
} catch {
  // Never let scratch-state cleanup stop the server from coming up.
}

const transport = new StdioServerTransport();
await server.connect(transport);

process.stderr.write(
  `[sharpwave] started — v${VERSION} agentId="${AGENT_ID}" session="${SESSION_ID}"` +
    (purged > 0 ? ` (cleared ${purged} stale working-memory row${purged === 1 ? "" : "s"})` : "") +
    "\n",
);

// Detached on purpose: the server is already serving, and a slow or unreachable
// registry must never delay or fail startup.
void checkForUpdate(AGENT_ID, VERSION);
