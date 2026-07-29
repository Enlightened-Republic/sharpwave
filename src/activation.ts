import { getDb } from "./db.js";
import { getNeighbors } from "./nodes.js";
import { getInhibitedNodeIds } from "./edges.js";
import { cosineSimilarity, bufferToFloat32 } from "./embeddings.js";
import type { ActivatedNode, BrainNode, BrainConfig, NeuromodState } from "./types.js";

function contextMatchBonus(enc: NeuromodState, cur: NeuromodState): number {
  const a = [enc.dopamine, enc.serotonin, enc.acetylcholine, enc.norepinephrine];
  const b = [cur.dopamine, cur.serotonin, cur.acetylcholine, cur.norepinephrine];
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < 4; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const mag = Math.sqrt(magA) * Math.sqrt(magB);
  // When both vectors are zero (fresh DB), return 1.0 — no penalty on blank slate
  if (mag === 0) return 1.0;
  const sim = dot / mag;
  // Returns 0.7–1.0: memories encoded in similar state get up to 30% boost
  return 0.7 + 0.3 * Math.max(0, sim);
}

export function spreadActivation(
  agentId: string,
  seedNodes: BrainNode[],
  config: BrainConfig,
  queryEmbedding?: Float32Array | null,
  currentNeuromodState?: NeuromodState | null,
  preActivations?: Map<string, number>,
): ActivatedNode[] {
  const HOP_DECAY = 0.4;
  // Start from pre-populated map (e.g. with WM boost) or empty
  const activationMap: Map<string, number> = preActivations
    ? new Map(preActivations)
    : new Map<string, number>();
  const inhibitedIds = new Set<string>();
  // Cache nodes encountered during BFS to avoid re-fetching them in the results loop
  const nodeCache = new Map<string, BrainNode>();
  const db = getDb(agentId);

  // Seed: take max of pre-activation and node salience so WM boost is not overwritten
  for (const node of seedNodes) {
    nodeCache.set(node.id, node);
    const existing = activationMap.get(node.id) ?? 0;
    activationMap.set(node.id, Math.max(existing, node.salience));
    for (const id of getInhibitedNodeIds(agentId, node.id)) {
      inhibitedIds.add(id);
    }
  }

  // BFS-style hop propagation: frontier tracks only nodes added in the PREVIOUS hop.
  // Without this, every hop re-propagates all accumulated nodes, causing exponential fan-out.
  let frontier = new Set(seedNodes.map((n) => n.id));

  for (let hop = 0; hop < config.spreadingActivationHops; hop++) {
    const nextFrontier = new Set<string>();
    const currentLayer = [...frontier]
      .map((id) => [id, activationMap.get(id) ?? 0] as [string, number])
      .filter(([, act]) => act > config.activationThreshold);

    for (const [nodeId, parentActivation] of currentLayer) {
      const neighbors = getNeighbors(agentId, nodeId);

      // ── Fan-out normalization (code-1 Fix #2 / SYNTHESIS T1.2) ──────────────
      // Spreading activation per Collins & Loftus: each emitting node
      // distributes its activation budget across its out-edges. Without this
      // normalization, a hub node with 100 neighbors deposits 100× more total
      // activation than a leaf node with 1 neighbor, violating energy
      // conservation and letting popular hubs dominate every BFS.
      //
      // We divide each delta by the sum of positive neighbor weights so the
      // total emitted activation from this node equals
      //   parentActivation * HOP_DECAY (success path) or
      //   parentActivation * inhibitionStrength (inhibition path)
      // regardless of out-degree. Inhibition uses the same fraction so a
      // high-degree node can't crush its targets disproportionately.
      const totalWeight = neighbors.reduce((s, n) => s + Math.max(0, n.weight), 0);
      if (totalWeight <= 0) continue;

      for (const { node, edgeType, weight } of neighbors) {
        nodeCache.set(node.id, node);
        if (inhibitedIds.has(node.id)) continue;

        const share = Math.max(0, weight) / totalWeight;
        let delta = parentActivation * share * HOP_DECAY;

        // Semantic similarity bonus for nodes close to the query
        if (queryEmbedding && node.embedding) {
          const nodeEmbed = bufferToFloat32(node.embedding as Buffer);
          const sim = cosineSimilarity(queryEmbedding, nodeEmbed);
          if (sim > 0) delta *= (1 + 0.5 * sim);
        }

        const existing = activationMap.get(node.id) ?? 0;

        if (edgeType === "inhibits" || edgeType === "contradicts") {
          // Inhibition path: same normalized share so out-degree doesn't amplify.
          const inhibitDelta = parentActivation * share * config.inhibitionStrength;
          activationMap.set(node.id, Math.max(0, existing - inhibitDelta));
          inhibitedIds.add(node.id);
        } else {
          activationMap.set(node.id, existing + delta);
          nextFrontier.add(node.id);
        }
      }
    }

    frontier = nextFrontier;
    if (frontier.size === 0) break; // no new nodes reached — stop early
  }

  // ── Lateral inhibition (SYNAPSE pattern) ──────────────────────────────────
  // Post-BFS: activated nodes compete with semantically similar activated
  // neighbors. The stronger fires; the weaker is multiplied by
  // (1 - inhibitionStrength). This sharpens the recall signal by preventing
  // redundant near-duplicate memories from consuming the context budget —
  // freeing slots for diverse multi-hop nodes. Threshold 0.82 targets the
  // upper range of the `associates` bucket (0.75–0.85) where two nodes are
  // "the same topic" rather than merely related. Below 0.82 nodes are
  // different enough to contribute distinct information.
  const LATERAL_SIM_THRESHOLD = 0.82;
  // ARIA sim window: [0.72, 0.82) — related but distinct memories that interfere
  const ARIA_SIM_LOW = 0.72;
  const ARIA_MAX_SUPPRESSION = 0.3; // softer than SYNAPSE's inhibitionStrength

  let withEmbeddings: { id: string; act: number; vec: Float32Array }[] = [];

  if (activationMap.size >= 2) {
    withEmbeddings = [...activationMap.entries()]
      .filter(([id, act]) => act > config.activationThreshold && !inhibitedIds.has(id))
      .map(([id, act]) => {
        const node = nodeCache.get(id);
        if (!node?.embedding) return null;
        // Identity/goal nodes hold Marley's self-model — exempt from lateral competition.
        // They are already protected from downscaling; consistency requires protecting
        // them from suppression too so two similar goals don't silence each other.
        if (node.type === "identity" || node.type === "goal") return null;
        return { id, act, vec: bufferToFloat32(node.embedding as Buffer) };
      })
      .filter((x): x is { id: string; act: number; vec: Float32Array } => x !== null)
      .sort((a, b) => b.act - a.act)
      .slice(0, 50); // cap for O(n²) safety on dense activation sets

    for (let i = 0; i < withEmbeddings.length; i++) {
      const winner = withEmbeddings[i];
      if ((activationMap.get(winner.id) ?? 0) < config.activationThreshold) continue;

      for (let j = i + 1; j < withEmbeddings.length; j++) {
        const loser = withEmbeddings[j];
        const loserAct = activationMap.get(loser.id) ?? 0;
        if (loserAct < config.activationThreshold) continue;

        const sim = cosineSimilarity(winner.vec, loser.vec);
        if (sim > LATERAL_SIM_THRESHOLD) {
          activationMap.set(loser.id, loserAct * (1 - config.inhibitionStrength));
        }
      }
    }
  }

  // ── Associative interference (ARIA pattern) ────────────────────────────────
  // Post-SYNAPSE: memories in the 0.72–0.82 similarity window mutually suppress
  // each other in proportion to BOTH semantic similarity AND temporal proximity
  // of encoding. Unlike SYNAPSE (clear winner/loser, one-directional), ARIA
  // applies softer bidirectional attenuation where both nodes carry distinct
  // value but compete for the same representational resources.
  //
  // Cognitive basis: proactive interference (older→newer) and retroactive
  // interference (newer→older) both scale with similarity and temporal overlap
  // of encoding (Anderson & Neely 1996 fan effect; McGeoch 1932 similarity law).
  // Memories encoded far apart in time are stored in different hippocampal
  // theta sequences and interfere much less.
  if (withEmbeddings.length >= 2) {
    const ariaNodes = withEmbeddings
      .filter(n => (activationMap.get(n.id) ?? 0) > config.activationThreshold)
      .map(n => ({ ...n, created_at: nodeCache.get(n.id)?.created_at ?? 0 }));

    for (let i = 0; i < ariaNodes.length; i++) {
      for (let j = i + 1; j < ariaNodes.length; j++) {
        const a = ariaNodes[i];
        const b = ariaNodes[j];
        const sim = cosineSimilarity(a.vec, b.vec);
        if (sim <= ARIA_SIM_LOW || sim > LATERAL_SIM_THRESHOLD) continue;

        // Temporal proximity: 1.0 when same day, decays logarithmically
        // ~0.5 at 9 days apart, ~0.33 at 99 days apart
        const daysDiff = Math.abs(a.created_at - b.created_at) / 86_400_000;
        const temporalProx = 1 / (1 + Math.log10(daysDiff + 1));

        // Bidirectional suppression — both nodes pay the interference cost
        const factor = sim * temporalProx * ARIA_MAX_SUPPRESSION;
        const actA = activationMap.get(a.id) ?? 0;
        const actB = activationMap.get(b.id) ?? 0;
        activationMap.set(a.id, actA * (1 - factor));
        activationMap.set(b.id, actB * (1 - factor));
      }
    }
  }

  const nodeSelect = db.prepare("SELECT * FROM nodes WHERE id = ?");
  const rippleUpdate = db.prepare("UPDATE nodes SET ripple_count = ripple_count + 1 WHERE id = ?");
  const rippleIds: string[] = [];
  const results: ActivatedNode[] = [];

  for (const [nodeId, activation] of activationMap.entries()) {
    if (activation < config.activationThreshold) continue;
    if (inhibitedIds.has(nodeId)) continue;

    // Use cached node from BFS traversal; fall back to DB only for nodes activated via preActivations
    const node = (nodeCache.get(nodeId) ?? nodeSelect.get(nodeId)) as BrainNode | null;
    if (!node) continue;

    let finalActivation = activation;

    // Context-dependent retrieval: apply neuromodulator match bonus
    if (currentNeuromodState && node.encoding_context) {
      try {
        const encCtx = JSON.parse(node.encoding_context) as NeuromodState;
        finalActivation *= contextMatchBonus(encCtx, currentNeuromodState);
      } catch {
        // malformed encoding_context, skip bonus
      }
    }

    results.push({ ...node, activation: finalActivation });
    rippleIds.push(nodeId);
  }

  // Batch all ripple_count increments in one transaction — avoids N individual unbounded UPDATEs
  if (rippleIds.length > 0) {
    db.transaction(() => {
      for (const id of rippleIds) rippleUpdate.run(id);
    })();
  }

  results.sort((a, b) => b.activation - a.activation);
  return results;
}

export function workingMemoryBoost(
  activationMap: Map<string, number>,
  sessionId: string,
  agentId: string,
  bonus = 0.3,
): void {
  const db = getDb(agentId);
  const wmNodes = db.prepare(
    "SELECT node_id, activation FROM working_memory WHERE session_id = ?"
  ).all(sessionId) as { node_id: string; activation: number }[];

  for (const wm of wmNodes) {
    const current = activationMap.get(wm.node_id) ?? 0;
    activationMap.set(wm.node_id, current + bonus);
  }
}

export function updateWorkingMemory(
  agentId: string,
  sessionId: string,
  topNodes: ActivatedNode[],
  slots: number,
): void {
  const db = getDb(agentId);
  const now = Date.now();

  const existing = db.prepare(
    "SELECT node_id, activation FROM working_memory WHERE session_id = ?"
  ).all(sessionId) as { node_id: string; activation: number }[];
  const existingMap = new Map(existing.map((e) => [e.node_id, e.activation]));

  const upsert = db.prepare(
    "INSERT OR REPLACE INTO working_memory (node_id, activation, entered_at, session_id) VALUES (?, ?, ?, ?)"
  );
  const bump = db.prepare(
    "UPDATE working_memory SET activation = ? WHERE node_id = ? AND session_id = ?"
  );

  for (const node of topNodes) {
    if (existingMap.has(node.id)) {
      const boosted = Math.max(existingMap.get(node.id)!, node.activation);
      bump.run(boosted, node.id, sessionId);
    } else {
      upsert.run(node.id, node.activation, now, sessionId);
    }
  }

  const total = (
    db.prepare(
      "SELECT COUNT(*) as n FROM working_memory WHERE session_id = ?"
    ).get(sessionId) as { n: number }
  ).n;

  if (total > slots) {
    db.prepare(`
      DELETE FROM working_memory
      WHERE session_id = ? AND node_id IN (
        SELECT node_id FROM working_memory
        WHERE session_id = ?
        ORDER BY activation ASC
        LIMIT ?
      )
    `).run(sessionId, sessionId, total - slots);
  }
}

export function clearWorkingMemory(agentId: string, sessionId: string): void {
  const db = getDb(agentId);
  db.prepare("DELETE FROM working_memory WHERE session_id = ?").run(sessionId);
}

/**
 * Drop every working-memory row for an agent.
 *
 * Working memory is per-conversation scratch state — it is meaningless once the
 * process that owned the session is gone. The stdio server is one process per
 * session, so anything already on disk at startup belongs to a dead session.
 *
 * This also repairs databases written by 0.1.0, which labelled every session
 * with the same literal id and therefore accumulated rows that were replayed
 * into every subsequent query forever.
 */
export function clearStaleWorkingMemory(agentId: string): number {
  const db = getDb(agentId);
  return db.prepare("DELETE FROM working_memory").run().changes;
}
