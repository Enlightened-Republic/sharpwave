import { writeNode, ftsSearchNodes } from "./nodes.js";
import { writeEdge, edgeExists } from "./edges.js";
import { queueEmbedding } from "./embeddings.js";
import { classifySentence, importanceForType, jaccardSim } from "./utils.js";
import type { BrainConfig, NodeType } from "./types.js";

interface CompactionPayload {
  summary?: string;
  messages?: Array<{ role: string; content?: unknown }>;
  sourceEpisodeIds?: string[];
}

export function handleCompaction(
  agentId: string,
  payload: CompactionPayload,
  _config: BrainConfig,
  log: { info: (msg: string) => void; warn: (msg: string) => void },
): void {
  const summary = payload.summary;
  if (!summary || summary.length < 50) return;

  try {
    const nodeIds = extractNodesFromSummary(agentId, summary, payload.sourceEpisodeIds ?? []);
    log.info(`[sharpwave] compaction: extracted ${nodeIds.length} node(s) from summary (agent=${agentId})`);
  } catch (err) {
    log.warn(`[sharpwave] compaction extraction failed: ${String(err)}`);
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

