// packages/core/src/tools.ts
//
// THE single source of truth for the brain_* tool surface.
//
// Both consumers read from here, so the two hosts can never drift:
//   • `packages/mcp`      publishes MCP_TOOL_NAMES     (11 tools)
//   • `packages/openwave` publishes OPENWAVE_TOOL_NAMES (all 16)
//
// The 11 MCP schemas + handler bodies were copied VERBATIM out of
// `packages/mcp/src/index.ts` — the published `sharpwave` npm package's tool
// surface is frozen (plan Global Constraints), and `npm run test:mcp` is the
// regression gate. Do not "tidy" a description, a key order, or an output
// string in this file without re-running that gate.
//
// The remaining 5 (`brain_update_self_model`, `brain_reflect`,
// `brain_generate_skill`, `brain_workspace`, `brain_docs`) were ported from
// `clawbrain-v4/src/tools.ts`, converting their `@sinclair/typebox`
// `Type.Object({...})` schemas to plain JSON Schema. typebox is deliberately
// NOT a dependency of this package.
//
// Imports are sibling-relative (`./nodes.js`) rather than via the barrel
// (`./index.js`) because the barrel re-exports THIS file — going through it
// would create an import cycle.

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { writeNode, getNode, touchNode, getActiveGoals } from "./nodes.js";
import { writeEdge, closeEdgesFromNode, closeEdgesToNode } from "./edges.js";
import { getSelfModel, updateSelfModelField } from "./self-model.js";
import { searchEpisodes, getEpisodesByIds } from "./episodes.js";
import { getDb } from "./db.js";
import { forgetNodeById } from "./consolidation.js";
import { hybridRetrieve } from "./retrieval.js";
import { queueEmbedding } from "./embeddings.js";
import { resetBrain } from "./reset.js";
import { createBackup } from "./db-backup.js";
import { detectSkillCandidates, generateSkill } from "./skill-evolution.js";
import {
  collectMetrics, formatPrometheusMetrics, formatMetricsAsText,
} from "./metrics.js";
import {
  validateBrainQuery, validateBrainWrite, validateBrainLink, validateBrainSupersede,
  validateBrainHistory, validateBrainExpand, validateBrainReview, validateBrainForget,
  validateBrainEdges, formatValidationErrors,
} from "./validation.js";
import type { BrainConfig, NodeType, EdgeType } from "./types.js";

// ─── Types ──────────────────────────────────────────────────────────────────

/** Plain JSON Schema for a tool's arguments. Host-agnostic — no MCP, no typebox. */
export interface BrainToolInputSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
}

export interface BrainToolDef {
  description: string;
  inputSchema: BrainToolInputSchema;
}

/** What every tool hands back. Hosts adapt this to their own envelope. */
export interface BrainToolResult {
  text: string;
  isError?: boolean;
}

// ─── Result helpers ─────────────────────────────────────────────────────────
//
// These mirror `packages/mcp/src/index.ts`'s local ok()/err() exactly — err()
// prefixes "Error: " AND flags isError. The smoke test asserts on that text.

function ok(text: string): BrainToolResult {
  return { text };
}

function err(text: string): BrainToolResult {
  return { text: `Error: ${text}`, isError: true };
}

// One process == one conversation, so the session id is minted once per module
// load, not per call. A fresh id on every call would silently disable working
// memory (the 0.1.1 / 0.2.1 fixes both depend on a stable per-process id).
const TOOL_SESSION_ID = `tool:${randomUUID()}`;

const NO_OP_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

// ─── Tool definitions ───────────────────────────────────────────────────────

export const BRAIN_TOOL_DEFS: Record<string, BrainToolDef> = {
  // ── the 11 published by the MCP server (VERBATIM from packages/mcp) ──────
  brain_query: {
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
  brain_write: {
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
  brain_link: {
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
  brain_supersede: {
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
  brain_stats: {
    description:
      "Return brain statistics: node/edge/episode counts, neuromodulator state, consolidation status, embedding coverage. Supports format=prometheus for Prometheus metrics.",
    inputSchema: {
      type: "object",
      properties: {
        format: { type: "string", description: "Output format: text (default) or prometheus" },
      },
    },
  },
  brain_history: {
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
  brain_expand: {
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
  brain_review: {
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
  brain_forget: {
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
  brain_edges: {
    description: "Get all active incoming and outgoing edges for a node.",
    inputSchema: {
      type: "object",
      properties: {
        node_id: { type: "string", description: "Node ID to inspect" },
      },
      required: ["node_id"],
    },
  },
  brain_reset: {
    description:
      "DESTRUCTIVE. Wipe this agent's entire brain — every node, edge, episode, vector, working-memory row, and the self-model — and re-seed an empty self-model. A timestamped .db backup is taken first. Embedding config (Ollama/OpenRouter) and the vec table's dimension are untouched. Requires confirm to exactly equal this agent's id.",
    inputSchema: {
      type: "object",
      properties: {
        confirm: {
          type: "string",
          description: "Must exactly equal this agent's id for the reset to proceed.",
        },
      },
      required: ["confirm"],
    },
  },

  // ── the 5 plugin-only tools (ported from clawbrain-v4/src/tools.ts) ──────
  brain_update_self_model: {
    description:
      "Update identity, goals, or user_model in the self model. Use to set who I am, what I care about, and what I know about the user.",
    inputSchema: {
      type: "object",
      properties: {
        field: { type: "string", description: "Field to update: identity | goals | user_model" },
        value: { type: "string", description: "New value (goals and user_model must be valid JSON)" },
      },
      required: ["field", "value"],
    },
  },
  brain_reflect: {
    description: "Read the current self model — identity, goals, user model, last updated.",
    inputSchema: { type: "object", properties: {} },
  },
  brain_generate_skill: {
    description: "Generate a reusable skill from a recurring pattern node.",
    inputSchema: {
      type: "object",
      properties: {
        pattern_node_id: {
          type: "string",
          description: "ID of the pattern node to evolve. If omitted, auto-detects the highest-priority candidate.",
        },
      },
    },
  },
  brain_workspace: {
    description: "List files in the brain's skills workspace directory.",
    inputSchema: { type: "object", properties: {} },
  },
  brain_docs: {
    description: "Read the brain design documentation.",
    inputSchema: {
      type: "object",
      properties: {
        section: {
          type: "string",
          enum: ["memo", "overview", "schema", "retrieval", "consolidation", "tools", "v3-upgrades"],
          description: "Which section of the brain design docs to read. Use 'memo' for the operator system overview (BRAIN_MEMO.md).",
        },
      },
      required: ["section"],
    },
  },
};

/**
 * The 11 tools `packages/mcp` publishes, in the exact order its `TOOLS` array
 * had them. The published order is part of the frozen surface — do not sort.
 */
export const MCP_TOOL_NAMES: string[] = [
  "brain_query",
  "brain_write",
  "brain_link",
  "brain_supersede",
  "brain_stats",
  "brain_history",
  "brain_expand",
  "brain_review",
  "brain_forget",
  "brain_edges",
  "brain_reset",
];

/** Everything the openwave plugin exposes: all 16. */
export const OPENWAVE_TOOL_NAMES: string[] = Object.keys(BRAIN_TOOL_DEFS);

// ─── brain_docs section tables (from clawbrain-v4/src/tools.ts) ─────────────

const SECTION_FILE_NAME: Record<string, string> = {
  memo:          "BRAIN_MEMO.md",
  overview:      "BRAIN_DESIGN.md",
  schema:        "BRAIN_DESIGN.md",
  retrieval:     "BRAIN_DESIGN.md",
  consolidation: "BRAIN_DESIGN.md",
  tools:         "BRAIN_DESIGN.md",
  "v3-upgrades": "BRAIN_DESIGN_V3.md",
};

const SECTION_MARKER: Record<string, string> = {
  memo:          "",
  overview:      "## Overview",
  schema:        "## Schema",
  retrieval:     "## Retrieval",
  consolidation: "## Consolidation",
  tools:         "## Tools",
  "v3-upgrades": "## What v3 Adds",
};

// ─── brain_workspace directory scan (from clawbrain-v4/src/tools.ts) ────────

interface WsEntry { name: string; isDir: boolean; size: number; modified: number; children?: WsEntry[] }

function resolveWorkspacePath(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function scanWorkspace(root: string): WsEntry[] {
  const count = { n: 0 };
  const scanDir = (path: string, depth = 0): WsEntry[] => {
    if (depth > 3 || count.n >= 500) return [];
    const entries: WsEntry[] = [];
    try {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        if (count.n >= 500) break;
        count.n++;
        if (entry.isDirectory()) {
          entries.push({ name: entry.name, isDir: true, size: 0, modified: 0, children: scanDir(join(path, entry.name), depth + 1) });
        } else if (entry.isFile()) {
          const s = statSync(join(path, entry.name));
          entries.push({ name: entry.name, isDir: false, size: s.size, modified: s.mtimeMs });
        }
      }
    } catch { /* ignore permission errors */ }
    return entries;
  };
  return scanDir(root);
}

// ─── Dispatcher ─────────────────────────────────────────────────────────────

/**
 * Execute one brain_* tool against an ALREADY-RESOLVED agent.
 *
 * Agent resolution is a transport concern and stays with the host: the MCP
 * server has its pinned/multi-agent gate, openwave has openclaw's ctx. This
 * function never throws for an unknown tool — it returns an error result.
 */
export async function dispatchBrainTool(
  name: string,
  agentId: string,
  args: Record<string, unknown>,
  config: BrainConfig,
): Promise<BrainToolResult> {
  switch (name) {
    // ── brain_query ───────────────────────────────────────────────────────
    case "brain_query": {
      const validation = validateBrainQuery(args);
      if (!validation.ok) {
        return err(`Invalid arguments:\n${formatValidationErrors(validation.errors!)}`);
      }
      const { query, type: typeFilter, limit } = validation.data!;

      let results = await hybridRetrieve(agentId, query, TOOL_SESSION_ID, config);
      if (typeFilter) results = results.filter((n) => n.type === typeFilter);
      if (results.length === 0) return ok("No matching nodes found.");

      const lines = results.slice(0, limit).map((n) =>
        `[${n.id.slice(0, 8)}] (${n.type}) ${n.label}\n  ${n.content.slice(0, 300)}\n  R=${n.retrievability.toFixed(2)} sal=${n.salience.toFixed(2)} imp=${n.importance.toFixed(2)}`
      );
      return ok(lines.join("\n\n"));
    }

    // ── brain_write ───────────────────────────────────────────────────────
    case "brain_write": {
      const validation = validateBrainWrite(args);
      if (!validation.ok) {
        return err(`Invalid arguments:\n${formatValidationErrors(validation.errors!)}`);
      }
      const { type, label, content, importance, emotional_weight } = validation.data!;

      const nodeId = writeNode(agentId, type as NodeType, label, content, {
        importance,
        emotional_weight,
        source: "mcp",
      });
      queueEmbedding(agentId, nodeId);
      return ok(`Written: node ${nodeId} (${type}) "${label}"`);
    }

    // ── brain_link ────────────────────────────────────────────────────────
    case "brain_link": {
      const validation = validateBrainLink(args);
      if (!validation.ok) {
        return err(`Invalid arguments:\n${formatValidationErrors(validation.errors!)}`);
      }
      const { from_id, to_id, edge_type, weight } = validation.data!;

      if (!getNode(agentId, from_id)) return err(`node ${from_id} not found`);
      if (!getNode(agentId, to_id))   return err(`node ${to_id} not found`);

      const edgeId = writeEdge(agentId, from_id, to_id, edge_type as EdgeType, { weight });
      return ok(`Linked: edge ${edgeId} (${from_id.slice(0, 8)} --${edge_type}--> ${to_id.slice(0, 8)})`);
    }

    // ── brain_supersede ───────────────────────────────────────────────────
    case "brain_supersede": {
      const validation = validateBrainSupersede(args);
      if (!validation.ok) {
        return err(`Invalid arguments:\n${formatValidationErrors(validation.errors!)}`);
      }
      const { old_node_id, new_content, new_label } = validation.data!;

      const old = getNode(agentId, old_node_id);
      if (!old) return err(`node ${old_node_id} not found`);

      const newId = writeNode(agentId, old.type as NodeType, new_label ?? old.label, new_content, {
        importance: old.importance,
        emotional_weight: old.emotional_weight,
        source: "mcp",
      });
      queueEmbedding(agentId, newId);
      closeEdgesFromNode(agentId, old.id);
      closeEdgesToNode(agentId, old.id);
      writeEdge(agentId, newId, old.id, "supersedes");
      return ok(`Superseded: ${old.id.slice(0, 8)} → new node ${newId.slice(0, 8)}`);
    }

    // ── brain_stats ───────────────────────────────────────────────────────
    case "brain_stats": {
      const format = String(args["format"] ?? "text").toLowerCase();

      try {
        const metrics = await collectMetrics(agentId, config);

        if (format === "prometheus") {
          return ok(formatPrometheusMetrics(metrics));
        } else {
          return ok(formatMetricsAsText(metrics));
        }
      } catch (thrownErr) {
        return err(`Failed to collect metrics: ${String(thrownErr)}`);
      }
    }

    // ── brain_history ─────────────────────────────────────────────────────
    case "brain_history": {
      const validation = validateBrainHistory(args);
      if (!validation.ok) {
        return err(`Invalid arguments:\n${formatValidationErrors(validation.errors!)}`);
      }
      const { query, since, until, limit = 10 } = validation.data!;

      let results = searchEpisodes(agentId, query, limit * 2);
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

    // ── brain_expand ──────────────────────────────────────────────────────
    case "brain_expand": {
      const validation = validateBrainExpand(args);
      if (!validation.ok) {
        return err(`Invalid arguments:\n${formatValidationErrors(validation.errors!)}`);
      }
      const { node_id } = validation.data!;

      const node = getNode(agentId, node_id);
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
          const episodes = getEpisodesByIds(agentId, ids);
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

    // ── brain_review ──────────────────────────────────────────────────────
    case "brain_review": {
      const validation = validateBrainReview(args);
      if (!validation.ok) {
        return err(`Invalid arguments:\n${formatValidationErrors(validation.errors!)}`);
      }
      const { node_id, quality } = validation.data!;

      const before = getNode(agentId, node_id);
      if (!before) return err(`node ${node_id} not found`);

      touchNode(agentId, node_id, quality);

      const after = getNode(agentId, node_id);
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

    // ── brain_forget ──────────────────────────────────────────────────────
    case "brain_forget": {
      const validation = validateBrainForget(args);
      if (!validation.ok) {
        return err(`Invalid arguments:\n${formatValidationErrors(validation.errors!)}`);
      }
      const { node_id, force } = validation.data!;

      const noop = { info: () => {}, warn: () => {}, error: () => {} };
      const result = forgetNodeById(agentId, node_id, noop, { force });

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

    // ── brain_edges ───────────────────────────────────────────────────────
    case "brain_edges": {
      const validation = validateBrainEdges(args);
      if (!validation.ok) {
        return err(`Invalid arguments:\n${formatValidationErrors(validation.errors!)}`);
      }
      const { node_id } = validation.data!;

      const node = getNode(agentId, node_id);
      if (!node) return err(`node ${node_id} not found`);

      const db = getDb(agentId);

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

    // ── brain_reset ───────────────────────────────────────────────────────
    case "brain_reset": {
      const confirm = typeof args["confirm"] === "string" ? args["confirm"] : "";
      if (confirm !== agentId) {
        return err(
          `refused — brain_reset needs confirm: "${agentId}" (this agent's id). ` +
            `This permanently wipes every memory; a backup is taken but nothing is auto-restored.`,
        );
      }

      let backupPath: string;
      try {
        backupPath = createBackup(agentId, "brain_reset");
      } catch (e) {
        return err(`aborted before wiping anything — backup failed: ${String(e)}`);
      }

      const cleared = resetBrain(agentId);
      return ok(
        [
          `Brain reset for "${agentId}".`,
          `Backup: ${backupPath}`,
          `Cleared: ${cleared.nodes} nodes, ${cleared.edges} edges, ${cleared.episodes} episodes, ` +
            `${cleared.vectors} vectors, ${cleared.associations} associations, ${cleared.workingMemory} working-memory rows.`,
          `Self-model reset to empty. Embedding config (Ollama/OpenRouter) unchanged — new memories embed as before.`,
        ].join("\n"),
      );
    }

    // ── brain_update_self_model (clawbrain-v4) ────────────────────────────
    case "brain_update_self_model": {
      const field = typeof args["field"] === "string" ? args["field"] : "";
      const value = typeof args["value"] === "string" ? args["value"] : "";
      if (!["identity", "goals", "user_model"].includes(field)) {
        return err("field must be identity, goals, or user_model");
      }
      if (field !== "identity") {
        try { JSON.parse(value); } catch {
          return err(`value for ${field} must be valid JSON`);
        }
      }
      updateSelfModelField(agentId, field as "identity" | "goals" | "user_model", value);
      return ok(`Updated self_model.${field}`);
    }

    // ── brain_reflect (clawbrain-v4) ──────────────────────────────────────
    case "brain_reflect": {
      const model = getSelfModel(agentId);
      if (!model) return ok("Self model not initialized — try again after the first session.");
      const goals = getActiveGoals(agentId).map((g) => g.label);
      const lines = [
        `Identity: ${model.identity || "(not set)"}`,
        `Active goals: ${goals.length > 0 ? goals.join(", ") : "(none)"}`,
        `Goals JSON: ${model.goals}`,
        `User model: ${model.user_model}`,
        `Last updated: ${new Date(model.updated_at).toISOString()}`,
      ];
      return ok(lines.join("\n"));
    }

    // ── brain_generate_skill (clawbrain-v4) ───────────────────────────────
    //
    // DEGRADED in sharpwave-core: `detectSkillCandidates` / `generateSkill`
    // are stubs here (they return [] / null — see skill-evolution.ts). The
    // ported control flow therefore reports "no candidates" or an honest
    // generation failure. It never fabricates a skill file.
    case "brain_generate_skill": {
      const patternNodeId = typeof args["pattern_node_id"] === "string"
        ? args["pattern_node_id"].trim()
        : "";
      let candidate: unknown;

      if (patternNodeId) {
        const db = getDb(agentId);
        const row = db.prepare(
          "SELECT id, label, content FROM nodes WHERE id = ? AND type = 'pattern'"
        ).get(patternNodeId) as { id: string; label: string; content: string } | undefined;
        if (!row) return err(`pattern node ${patternNodeId} not found`);
        const instanceCount = (db.prepare(
          "SELECT COUNT(*) as n FROM edges WHERE to_id = ? AND type = 'instance_of' AND valid_until IS NULL"
        ).get(row.id) as { n: number }).n;
        candidate = {
          patternNodeId: row.id,
          patternLabel: row.label,
          patternContent: row.content,
          instanceCount,
          topic: row.label.replace(/^Pattern:\s*/i, "").trim(),
        };
      } else {
        const candidates = detectSkillCandidates(agentId, config);
        if (candidates.length === 0) {
          return ok(`No skill candidates ready. Patterns need at least ${config.skillEvolveMinPatternCount} instances before a skill can be generated.`);
        }
        candidate = candidates[0];
      }

      // `generateSkill` is a stub in core (always null); the cast documents the
      // shape a real implementation returns without pretending one ran.
      const result = generateSkill(agentId, candidate, config, NO_OP_LOGGER) as
        | { skillName: string; skillNodeId: string; filePath: string }
        | null;
      if (!result) return ok("Skill generation failed — check logs for details.");
      return ok(`Generated skill: "${result.skillName}"\nNode: ${result.skillNodeId.slice(0, 8)}\nFile: ${result.filePath}`);
    }

    // ── brain_workspace (clawbrain-v4) ────────────────────────────────────
    case "brain_workspace": {
      const configured = (config.workspaceSkillsDir ?? "").trim();
      if (!configured) {
        return ok("brain_workspace: workspace skills dir not configured. Set workspaceSkillsDir in your brain config to point at your skills directory.");
      }
      const dir = resolveWorkspacePath(configured);
      if (!existsSync(dir)) return ok(JSON.stringify({ dir, files: [] }));
      return ok(JSON.stringify({ dir, files: scanWorkspace(dir) }));
    }

    // ── brain_docs (clawbrain-v4) ─────────────────────────────────────────
    case "brain_docs": {
      const docsDir = config.brainDocsDir;
      if (!docsDir) {
        return ok(
          "brain_docs: brainDocsDir is not configured. Set it in your openclaw plugin config to point to your BRAIN_DESIGN.md directory."
        );
      }

      const section = typeof args["section"] === "string" ? args["section"] : "";
      const fileName = SECTION_FILE_NAME[section];
      if (!fileName) {
        return err(`unknown section "${section}" — expected one of ${Object.keys(SECTION_FILE_NAME).join(", ")}`);
      }
      const marker = SECTION_MARKER[section] ?? "";
      const file = join(docsDir, fileName);

      try {
        const content = readFileSync(file, "utf-8");
        const idx = marker ? content.indexOf(marker) : -1;
        if (idx === -1) return ok(content.slice(0, 4000));
        return ok(content.slice(idx, idx + 4000));
      } catch (readErr) {
        return ok(`brain_docs: cannot read ${file} — ${String(readErr)}`);
      }
    }

    default:
      return { text: `unknown tool: ${name}`, isError: true };
  }
}
