import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { randomUUID } from "node:crypto";

// Engine surface — the entire brain engine lives in `xanima-core` now.
// esbuild inlines its compiled dist/*.js into this single bundle (it is NOT in
// the esbuild `external` list); only the native modules stay external.
import {
  drainEmbeddingQueue,
  clearStaleWorkingMemory,
  checkForUpdate,
  DEFAULT_CONFIG,
  // the unified brain_* tool surface — schemas AND handlers live in core so
  // this server and the openwave plugin can never drift apart.
  BRAIN_TOOL_DEFS, MCP_TOOL_NAMES, dispatchBrainTool,
  envGet,
} from "xanima-core";
import type { BrainConfig } from "xanima-core";

// Injected from package.json at build time by esbuild.mjs — never hardcode it.
// A stale constant misreports the server over MCP and makes checkForUpdate
// compare against the wrong version, nagging users to install what they have.
// The fallback only applies when running the TypeScript directly (tsx/ts-node).
declare const __SHARPWAVE_VERSION__: string;
const VERSION = typeof __SHARPWAVE_VERSION__ === "string" ? __SHARPWAVE_VERSION__ : "0.0.0-dev";

const config: BrainConfig = { ...DEFAULT_CONFIG };

// ─── Agent scoping ──────────────────────────────────────────────────────────
//
// Single-agent mode (default, backward compatible): `XANIMA_AGENT_ID` (or the deprecated `SHARPWAVE_AGENT_ID`) pins
// this process to one agent; the `agent` tool argument is optional and, if
// given, must match.
//
// Multi-agent mode (`XANIMA_AGENT_ID` (or the deprecated `SHARPWAVE_AGENT_ID`) unset): one process serves many
// agents. Every brain_* call MUST carry an `agent` argument — the calling
// agent's own id. Each id maps to its own `<dataDir>/<agentId>/brain.db`.
// `XANIMA_AGENTS` (comma list), when set, is an allowlist.
const PINNED_AGENT_ID = envGet("AGENT_ID")?.trim() || undefined;
const MULTI = !PINNED_AGENT_ID;
const AGENT_ALLOWLIST = (envGet("AGENTS") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const AGENT_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9])?$/;

// XANIMA_DB_PATH pins core to ONE file for every agent id. That is what a
// single-agent install wants; in multi-agent mode it would silently route every
// agent's writes into the same brain. Refuse the combination up front rather
// than merge brains that were meant to be separate.
if (MULTI && envGet("DB_PATH")) {
  process.stderr.write(
    "[xanima] refusing to start: XANIMA_DB_PATH (or SHARPWAVE_DB_PATH) is set but XANIMA_AGENT_ID is not. " +
    "A single db path cannot serve many agents — either pin one agent with XANIMA_AGENT_ID, " +
    "or unset the db path and use XANIMA_DATA_DIR (one <dataDir>/<agentId>/brain.db per agent).\n",
  );
  process.exit(2);
}

const initedAgents = new Set<string>();
function touchAgent(agentId: string): void {
  if (initedAgents.has(agentId)) return;
  initedAgents.add(agentId);
  // Stale working memory belongs to a session that no longer exists; also
  // repairs 0.1.0-poisoned dbs. getDb() inside creates the db on first touch.
  try { clearStaleWorkingMemory(agentId); } catch { /* never block a call */ }
}

type AgentResolve = { ok: true; agentId: string } | { ok: false; error: string };
function resolveAgent(args: Record<string, unknown>): AgentResolve {
  const given = typeof args["agent"] === "string" ? (args["agent"] as string).trim() : "";
  if (PINNED_AGENT_ID) {
    if (given && given !== PINNED_AGENT_ID) {
      return { ok: false, error: `this server is pinned to agent "${PINNED_AGENT_ID}" — refusing "${given}"` };
    }
    touchAgent(PINNED_AGENT_ID);
    return { ok: true, agentId: PINNED_AGENT_ID };
  }
  if (!given) return { ok: false, error: `multi-agent mode: pass "agent" (your own agent id) with every brain_* call` };
  if (!AGENT_ID_RE.test(given)) return { ok: false, error: `invalid agent id "${given}"` };
  if (AGENT_ALLOWLIST.length && !AGENT_ALLOWLIST.includes(given)) {
    return { ok: false, error: `agent "${given}" is not in XANIMA_AGENTS` };
  }
  touchAgent(given);
  return { ok: true, agentId: given };
}

// One stdio server process == one conversation, so the session id is minted per
// process. 0.1.0 hardcoded a single literal here, which meant working memory was
// never scoped to a conversation: the last N retrieved nodes were replayed into
// every later query, across restarts, regardless of relevance.
const SESSION_ID = `mcp:${randomUUID()}`;

// Start embedding drain in background every 30s — for every agent touched so far.
// unref(): the timer must not keep this process alive once the client has
// closed stdio; a stdio MCP server that outlives its client is an orphan that
// holds the brain file open (and, on Windows, blocks the next launch).
const drainTimer = setInterval(() => {
  const ids = PINNED_AGENT_ID ? [PINNED_AGENT_ID] : [...initedAgents];
  for (const id of ids) void drainEmbeddingQueue(id, config);
}, 30_000);
drainTimer.unref();

// ─── Tool definitions ───────────────────────────────────────────────────────
//
// Schemas come straight from `xanima-core`'s BRAIN_TOOL_DEFS. This server
// publishes exactly the names in MCP_TOOL_NAMES, in that order — the
// published surface of the `sharpwave` npm package is frozen.

const TOOLS = MCP_TOOL_NAMES.map((name) => ({ name, ...BRAIN_TOOL_DEFS[name] }));

// ─── Dispatcher ─────────────────────────────────────────────────────────
//
// Agent resolution is transport-specific and stays here; everything past it
// is core's `dispatchBrainTool`, shared with the openwave plugin.

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

async function dispatch(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  // Base sharpwave@0.4.0 checked the tool name before resolving the agent, so an
  // unknown tool with no `agent` arg (multi-agent mode) returned the unknown-tool
  // error, not the agent-resolution error. Preserve that ordering.
  if (!MCP_TOOL_NAMES.includes(name)) {
    return { content: [{ type: "text", text: `Error: unknown tool: ${name}` }], isError: true };
  }

  const ag = resolveAgent(args);
  if (!ag.ok) return { content: [{ type: "text", text: `Error: ${ag.error}` }], isError: true };

  const r = await dispatchBrainTool(name, ag.agentId, args ?? {}, config);
  return {
    content: [{ type: "text", text: r.text }],
    ...(r.isError ? { isError: true } : {}),
  };
}

// ─── MCP server setup ───────────────────────────────────────────────────────

const server = new Server(
  { name: "xanima", version: VERSION },
  { capabilities: { tools: {} } },
);

// In multi-agent mode every tool gains a required `agent` argument, injected
// first so it reads first in tool listings.
function toolsForMode() {
  if (!MULTI) return TOOLS;
  return TOOLS.map((t) => {
    const s = t.inputSchema as { type: string; properties: Record<string, unknown>; required?: readonly string[] };
    return {
      ...t,
      inputSchema: {
        ...s,
        properties: {
          agent: { type: "string", description: "Your own agent id (this is a multi-agent brain server)." },
          ...s.properties,
        },
        required: ["agent", ...(s.required ?? [])],
      },
    };
  });
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolsForMode() }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return await dispatch(name, (args as Record<string, unknown>) ?? {});
});

// Single-agent mode: drop stale working memory for the pinned agent at startup
// (a session that no longer exists wrote it; also repairs 0.1.0-poisoned dbs).
// Multi-agent mode does this per-agent on first touch instead.
let purged = 0;
if (PINNED_AGENT_ID) {
  try {
    purged = clearStaleWorkingMemory(PINNED_AGENT_ID);
  } catch {
    // Never let scratch-state cleanup stop the server from coming up.
  }
}

const transport = new StdioServerTransport();
// When the client closes our stdin the transport reports close: stop the drain
// timer and let the process exit on its own (the timer is unref'd, and no other
// handle keeps the loop alive). Not process.exit(): an in-flight drain or
// write finishes first.
server.onclose = () => { clearInterval(drainTimer); };
await server.connect(transport);

process.stderr.write(
  `[xanima] started — v${VERSION} agentId="${PINNED_AGENT_ID ?? "(multi-agent)"}" session="${SESSION_ID}"` +
    (purged > 0 ? ` (cleared ${purged} stale working-memory row${purged === 1 ? "" : "s"})` : "") +
    "\n",
);

// Detached on purpose: the server is already serving, and a slow or unreachable
// registry must never delay or fail startup. Skipped in multi-agent mode (no
// single agent db to store the last-check timestamp against).
if (PINNED_AGENT_ID) void checkForUpdate(PINNED_AGENT_ID, VERSION);
