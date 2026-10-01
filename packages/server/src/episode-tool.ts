// packages/server/src/episode-tool.ts
//
// brain_episode_append — append one conversation episode to a brain's episode
// log, so remote clients (openwave in brainMode "remote") feed the service's
// sleep/consolidation exactly like local openwave feeds its own brain.db.
//
//   • Needs the `write` scope. Goes to the caller's PRIVATE brain; with
//     visibility:"shared" it goes to the shared brain and needs `shared-write`.
//   • writer_agent_id is stamped from the token (any client-supplied value is
//     ignored and not advertised in the schema).
//   • Uses sharpwave-core's appendEpisode — the same function local openwave
//     calls — on the brain's serialized write queue, so SleepRunner's
//     runConsolidation (shouldConsolidate episode-count gate, SWS
//     pickSwsEpisodes, llm_extracted marking) sees these rows the same way.
//
// Kept in its own file (plus two lines of registration in tools.ts) to stay
// clear of other in-flight packages/server branches.

import { appendEpisode, scoreImportance } from "sharpwave-core";

import { SHARED_BRAIN } from "./brains.js";
import type { Scope } from "./tokens.js";
import type { ToolContext, ToolOutput } from "./tools.js";

export const EPISODE_TOOL_NAME = "brain_episode_append";

const MAX_CONTENT_CHARS = 32_000;
const MAX_SESSION_CHARS = 512;
const MAX_META_BYTES = 8_192;
const ROLES = ["user", "assistant", "tool"] as const;
type Role = (typeof ROLES)[number];

export const EPISODE_TOOL_DEF = {
  name: EPISODE_TOOL_NAME,
  description:
    "Append one conversation episode (a user/assistant/tool turn) to your private brain's episode log (default) or, with visibility:\"shared\" and the shared-write scope, to the shared brain. " +
    "Episodes feed sleep/consolidation (SWS extraction, replay) exactly like a local brain. The writer is always the calling token's agent.",
  inputSchema: {
    type: "object" as const,
    properties: {
      session_id: { type: "string", description: "Conversation/session key the episode belongs to (e.g. agent:main:telegram:123)." },
      role: { type: "string", enum: [...ROLES], description: "Who produced the turn." },
      content: { type: "string", description: `Episode text (max ${MAX_CONTENT_CHARS} chars).` },
      importance: { type: "number", minimum: 0, maximum: 1, description: "0..1. Omit to use the engine's heuristic score (same as local)." },
      meta: { type: "object", description: "Optional small JSON metadata (max 8 KiB)." },
      visibility: { type: "string", enum: ["private", "shared"], description: 'Which brain: "private" (yours, default) or "shared" (needs shared-write).' },
    },
    required: ["session_id", "role", "content"],
  },
};

function err(text: string): ToolOutput {
  return { text: `Error: ${text}`, isError: true };
}
function has(scopes: ReadonlySet<Scope>, s: Scope): boolean {
  return scopes.has(s) || scopes.has("admin");
}

export async function callEpisodeAppend(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolOutput> {
  const p = ctx.principal;
  const vis = args["visibility"] ?? null;
  if (vis !== null && vis !== "" && vis !== "private" && vis !== "shared") return err(`visibility must be "private" or "shared"`);
  if (!has(p.scopes, "write")) return err("forbidden — brain_episode_append needs the write scope");
  let brain: string;
  if (vis === "shared") {
    if (!has(p.scopes, "shared-write")) {
      ctx.audit.append({ agentId: p.agentId, tool: EPISODE_TOOL_NAME, brain: SHARED_BRAIN, nodeId: null, outcome: "denied", detail: "missing shared-write scope" });
      return err("forbidden — appending to the shared brain needs the shared-write scope");
    }
    brain = SHARED_BRAIN;
  } else {
    brain = ctx.brains.privateBrain(p.agentId);
  }

  const sessionId = args["session_id"];
  const role = args["role"];
  const content = args["content"];
  const importance = args["importance"];
  const meta = args["meta"];
  const problems: string[] = [];
  if (typeof sessionId !== "string" || !sessionId.trim()) problems.push("session_id must be a non-empty string");
  else if (sessionId.length > MAX_SESSION_CHARS) problems.push(`session_id must be at most ${MAX_SESSION_CHARS} chars`);
  if (typeof role !== "string" || !ROLES.includes(role as Role)) problems.push(`role must be one of ${ROLES.join(", ")}`);
  if (typeof content !== "string" || !content.trim()) problems.push("content must be a non-empty string");
  else if (content.length > MAX_CONTENT_CHARS) problems.push(`content must be at most ${MAX_CONTENT_CHARS} chars`);
  if (importance !== undefined && importance !== null && (typeof importance !== "number" || !Number.isFinite(importance) || importance < 0 || importance > 1)) {
    problems.push("importance must be a number between 0 and 1");
  }
  if (meta !== undefined && meta !== null) {
    if (typeof meta !== "object" || Array.isArray(meta)) problems.push("meta must be an object");
    else if (JSON.stringify(meta).length > MAX_META_BYTES) problems.push(`meta must serialize to at most ${MAX_META_BYTES} bytes`);
  }
  if (problems.length) return err(`Invalid arguments:\n- ${problems.join("\n- ")}`);

  const imp = typeof importance === "number" ? importance : scoreImportance(role as Role, content as string);
  const id = await ctx.brains.write(brain, () =>
    appendEpisode(brain, sessionId as string, role as Role, content as string, imp, (meta as Record<string, unknown> | undefined) ?? undefined, {
      writerAgentId: p.agentId,
    }),
  );
  ctx.audit.append({ agentId: p.agentId, tool: EPISODE_TOOL_NAME, brain, nodeId: null, outcome: "ok", detail: `episode ${id}` });
  const label = brain === SHARED_BRAIN ? "shared" : "private";
  let text = `Appended: episode ${id} (${role}) brain=${label} writer=${p.agentId} importance=${imp.toFixed(2)}`;
  if (typeof args["writer_agent_id"] === "string" && args["writer_agent_id"] !== p.agentId) {
    text += `\nNote: client-supplied writer_agent_id "${args["writer_agent_id"]}" was ignored; the writer is the token's agent.`;
  }
  return { text };
}
