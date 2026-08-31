import { getDb } from "./db.js";
import { ftsSearchNodes, getTopByType, touchNode } from "./nodes.js";
import { fetchEmbedding, vectorSearchNodes, rrfFuse, drainEmbeddingQueue } from "./embeddings.js";
import { spreadActivation, workingMemoryBoost, updateWorkingMemory } from "./activation.js";
import { getNeuromodulatorState } from "./consolidation.js";
import { bumpCounter, logObservabilityEvent } from "./observability.js";
import type { BrainConfig, BrainNode, ActivatedNode } from "./types.js";

export async function hybridRetrieve(
  agentId: string,
  query: string,
  sessionId: string,
  config: BrainConfig,
): Promise<ActivatedNode[]> {
  const limit = config.recallTopK;

  // drainEmbeddingQueue intentionally moved to background tick — do NOT call here.
  // Embedding API calls (15s timeout) in the before_prompt_build hot path block the
  // event loop, starve Discord WS heartbeats, and cause 1006 reconnect loops.

  const ftsResults = ftsSearchNodes(agentId, query, limit * 2);

  let vecResults: BrainNode[] = [];
  let queryEmbedding: Float32Array | null = null;
  if (query.length > 0) {
    // 2-second race — fall back to FTS-only if OpenRouter embedding is slow/unavailable
    queryEmbedding = await Promise.race([
      fetchEmbedding(query, config),
      new Promise<null>((r) => setTimeout(() => r(null), 2000)),
    ]);
    if (queryEmbedding) {
      vecResults = vectorSearchNodes(agentId, queryEmbedding, limit * 2);
    }
  }

  const fused = vecResults.length > 0
    ? rrfFuse([ftsResults, vecResults])
    : ftsResults;

  const seedNodes = fused.slice(0, limit);
  const currentNeuromodState = getNeuromodulatorState(agentId);

  // Build pre-activation map with WM boost and pass into spreadActivation so it
  // actually influences the hop propagation (the map was previously built but discarded).
  const activationMap = new Map<string, number>(
    seedNodes.map((n) => [n.id, n.salience])
  );
  workingMemoryBoost(activationMap, sessionId, agentId);

  const activated = spreadActivation(
    agentId,
    seedNodes,
    config,
    queryEmbedding,
    currentNeuromodState,
    activationMap,
  );

  const topNodes = activated.slice(0, limit);

  for (const node of topNodes) {
    touchNode(agentId, node.id);
  }

  updateWorkingMemory(agentId, sessionId, topNodes, config.workingMemorySlots);

  if (topNodes.length > 0) {
    bumpCounter("memories_recalled", topNodes.length);
    logObservabilityEvent("recall", {
      agentId,
      queryLength: query.length,
      resultCount: topNodes.length,
    });
  }

  return topNodes;
}

export async function bootstrapRetrieve(
  agentId: string,
  sessionId: string,
  config: BrainConfig,
): Promise<ActivatedNode[]> {
  const db = getDb(agentId);

  const identityNodes = getTopByType(agentId, "identity", 3);
  const goalNodes = getTopByType(agentId, "goal", 3);
  const seeds: BrainNode[] = [...identityNodes, ...goalNodes];

  const currentNeuromodState = getNeuromodulatorState(agentId);

  const activated = spreadActivation(agentId, seeds, config, null, currentNeuromodState);

  // Fill remaining budget with top-salience nodes
  const topSalience = db.prepare(
    "SELECT * FROM nodes WHERE salience > 0 ORDER BY salience DESC LIMIT ?"
  ).all(config.bootstrapTopK) as BrainNode[];

  const seen = new Set(activated.map((n) => n.id));
  const combined: ActivatedNode[] = [...activated];

  for (const node of topSalience) {
    if (!seen.has(node.id)) {
      combined.push({ ...node, activation: node.salience });
      seen.add(node.id);
    }
  }

  const topNodes = combined.slice(0, config.bootstrapTopK);
  updateWorkingMemory(agentId, sessionId, topNodes, config.workingMemorySlots);
  return topNodes;
}
