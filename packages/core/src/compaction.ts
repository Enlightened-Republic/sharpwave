import { writeNode, ftsSearchNodes } from "./nodes.js";
import { writeEdge, edgeExists } from "./edges.js";
import { queueEmbedding } from "./embeddings.js";
import { appendEpisode } from "./episodes.js";
import { classifySentence, importanceForType, jaccardSim } from "./utils.js";
import { applyTaskSignals } from "./task-signals.js";
import { getTaskFrame, currentTaskEnabled } from "./task-frame.js";
import { recentHandoffs } from "./now-context.js";
import type { BrainConfig, NodeType } from "./types.js";

interface CompactionPayload {
  summary?: string;
  messages?: Array<{ role: string; content?: unknown }>;
  sourceEpisodeIds?: string[];
}

export interface CompactionOptions {
  /**
   * 0.7: the session that was compacted. With it, the summary is read for task signals
   * ("we are working on X", "X was handed to Y"), and the session's current task plus
   * recent handoffs are written back as one episode so the next turn's context still
   * says what the conversation was doing — the compaction removed the turns that did.
   */
  sessionKey?: string;
  now?: number;
}

export function handleCompaction(
  agentId: string,
  payload: CompactionPayload,
  config: BrainConfig,
  log: { info: (msg: string) => void; warn: (msg: string) => void },
  opts: CompactionOptions = {},
): void {
  const summary = payload.summary;
  if (!summary || summary.length < 50) return;

  try {
    const nodeIds = extractNodesFromSummary(agentId, summary, payload.sourceEpisodeIds ?? []);
    log.info(`[xanima] compaction: extracted ${nodeIds.length} node(s) from summary (agent=${agentId})`);
  } catch (err) {
    log.warn(`[xanima] compaction extraction failed: ${String(err)}`);
  }

  if (opts.sessionKey && currentTaskEnabled(config)) {
    try {
      const now = opts.now ?? Date.now();
      const applied = applyTaskSignals(agentId, opts.sessionKey, summary, { config, origin: "compaction", now });
      const frame = getTaskFrame(agentId, opts.sessionKey, config, now);
      const handoffs = recentHandoffs(agentId, now - 7 * 86_400_000, 3);
      if (frame || handoffs.length) {
        const parts = [
          frame ? `working on: ${frame.title}${frame.note ? ` (${frame.note})` : ""}` : "",
          ...handoffs.map((h) => `${h.kind} "${h.title}" handed off to ${h.to}`),
        ].filter(Boolean);
        appendEpisode(agentId, opts.sessionKey, "tool", `[session state after compaction] ${parts.join("; ")}`, 0.2);
      }
      if (applied.focus || applied.handoffs.length) log.info(`[xanima] compaction: task state from summary — focus=${applied.focus?.title ?? "-"} handoffs=${applied.handoffs.map((h) => `${h.kind}:${h.title}→${h.to}`).join(",") || "-"} (agent=${agentId})`);
    } catch (err) {
      log.warn(`[xanima] compaction task-state restore failed: ${String(err)}`);
    }
  }
}

function extractNodesFromSummary(
  agentId: string,
  summary: string,
  episodeIds: string[],
): string[] {
  const nodeIds: string[] = [];
  const sentences = summary
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);

  for (const sentence of sentences) {
    const type = classifySentence(sentence);
    if (!type) continue;

    const importance = importanceForType(type);
    const label = sentence.slice(0, 60).replace(/\s+/g, " ");

    // Deduplicate via FTS similarity
    const existing = ftsSearchNodes(agentId, label, 3);
    const duplicate = existing.some((n) => jaccardSim(n.label, label) > 0.8);
    if (duplicate) continue;

    const nodeId = writeNode(agentId, type, label, sentence, {
      importance,
      source: "compaction",
      writerAgentId: agentId,
      episode_ids: episodeIds,
    });
    nodeIds.push(nodeId);
    queueEmbedding(agentId, nodeId);

    // Link sequential nodes
    if (nodeIds.length > 1) {
      const prev = nodeIds[nodeIds.length - 2];
      if (!edgeExists(agentId, prev, nodeId, "before")) {
        writeEdge(agentId, prev, nodeId, "before", { weight: 0.5 });
      }
    }
  }

  return nodeIds;
}

export type { NodeType };
