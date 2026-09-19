import { getMeta } from "./db.js";

export const BRAIN_HEADER =
  "[SharpWave active] Your memory is pre-loaded below — no manual lookup needed. brain_write to record new facts, brain_reflect to review identity/goals, brain_query only for deep dives. Memory consolidates automatically in the background (awake replay every 30 min; deeper consolidation once enough new experience accumulates). Use brain_docs section='memo' for full system overview." +
  " (compat: ClawBrain v3)";

export function getDreamContext(agentId: string): string {
  const raw = getMeta(agentId, "dream_context");
  if (!raw) return "";
  try {
    const parsed = JSON.parse(raw) as { ts: number; lines: string[] };
    const ageMs = Date.now() - parsed.ts;
    if (ageMs > 30 * 60 * 1000) return "";
    if (!parsed.lines || parsed.lines.length === 0) return "";
    return `[BRAIN: subconscious — active while you were away]\n${parsed.lines.join("\n")}`;
  } catch {
    return "";
  }
}

/**
 * Layer 1 of the 3-layer injection model (CLAWBRAIN_V3_INJECTION_FIX_PLAN.md).
 *
 * Pure-read self-model header injected via appendSystemContext on every turn.
 * The system prompt layer is never compacted by lossless-claw, so identity,
 * goals, and neuromodulator state remain present for the agent's lifetime.
 *
 * IMPORTANT — only call read-only DB queries here:
 *   - getSelfModel()           → SELECT only
 *   - getNeuromodulatorState() → COUNT queries only
 *   - getActiveGoals()         → SELECT only
 *
 * NEVER run bootstrapRetrieve / spreadActivation / hybridRetrieve here. Those
 * mutate ripple_count and corrupt consolidation signal (see BLOCKER 1 in plan).
 */
export type Surface = "voice" | "chat";

export interface ContextAssemblyOptions {
  /**
   * Set when a host-level memory system (e.g. OpenClaw's bundled memory-core
   * and its dreaming-curated MEMORY.md/USER.md) is already active for this
   * agent. Suppresses the sections whose *purpose* — not literal text —
   * duplicates what that curated tier already owns:
   *   - buildSelfModelHeader: durable identity, user_model, active goals
   *     (banner + neuromodulator state still inject)
   *   - buildBootstrapContext: self-model prose + active goals
   *     (header, dream/subconscious, morning brief, know/retrieval,
   *     episodes, review queue, skill candidates still inject)
   * false/omit = unchanged legacy behavior. Graph-specific recall,
   * procedural, dream, and neuro content stay; only host-curated durable
   * identity/goals prose is suppressed.
   */
  externalMemoryActive?: boolean;
}
