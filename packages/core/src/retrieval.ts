import { applyDecisionBoost } from "./decisions.js";
import { getDb } from "./db.js";
import { ftsSearchNodes, getTopByType, getActiveGoals, markNodesAccessed } from "./nodes.js";
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
    // 2-second race — fall back to FTS-only if OpenRouter embedding is slow/unavailable.
    // Abort the request when the budget wins so it does not sit on a socket for the
    // provider's full timeout (same pattern as proactive-monitor.ts).
    const embedController = new AbortController();
    const embedPromise = fetchEmbedding(query, config, undefined, embedController.signal);
    embedPromise.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<null>((r) => { timer = setTimeout(() => { embedController.abort(); r(null); }, 2000); timer.unref?.(); });
    queryEmbedding = await Promise.race([embedPromise, timeout]);
    if (timer) clearTimeout(timer);
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

  const topNodes = applyDecisionBoost(activated, config).slice(0, limit);

  // Recall is not a review. Surfacing a node is no evidence it was remembered,
  // and scoring every recall as an FSRS "good" ratcheted every injected node
  // toward the 365-day stability cap, promoted it to "consolidated" after five
  // surfacings, and set eligibility_trace = 1.0 on whatever was last shown (so
  // dopamine spikes always landed there). VALOR hits (valor.ts) and explicit
  // brain_review calls are the only automatic review signals; here we only
  // record the access.
  markNodesAccessed(agentId, topNodes.map((n) => n.id));

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
  const goalNodes = getActiveGoals(agentId).slice(0, 3); // 0.5.1: tracked goals only (no untracked legacy fragments)
  const seeds: BrainNode[] = [...identityNodes, ...goalNodes];

  const currentNeuromodState = getNeuromodulatorState(agentId);

  const activated = spreadActivation(agentId, seeds, config, null, currentNeuromodState);

  // Fill remaining budget with top-salience nodes
  const topSalience = db.prepare(
    "SELECT * FROM nodes WHERE salience > 0 AND (valid_until IS NULL OR valid_until > ?) ORDER BY salience DESC LIMIT ?"
  ).all(Date.now(), config.bootstrapTopK) as BrainNode[];

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
