import { getSelfModel, formatSelfModelForContext } from "./self-model.js";
import { getMorningBrief, formatMorningBlock } from "./morning.js";
import { getActiveGoals, getReviewQueue, getOperationalProcedures } from "./nodes.js";
import { getRecentEpisodes } from "./episodes.js";
import { detectSkillCandidates } from "./skill-evolution.js";
import { bootstrapRetrieve } from "./retrieval.js";
import { hybridRetrieve } from "./retrieval.js";
import { getNeuromodulatorState } from "./consolidation.js";
import { getMeta } from "./db.js";
import { recordInjection } from "./valor.js";
import type { BrainConfig } from "./types.js";

const BRAIN_HEADER =
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

export async function buildSelfModelHeader(
  agentId: string,
  _config: BrainConfig,
  log?: { warn: (msg: string) => void },
  surface: Surface = "chat",
): Promise<string> {
  const isVoice = surface === "voice";
  const parts: string[] = [];
  if (!isVoice) {
    parts.push(
      "[SharpWave] Identity, goals, and neuromodulator state pre-loaded. Use brain_query for deep recall.",
    );
  }

  try {
    const selfModel = getSelfModel(agentId);
    if (selfModel?.identity) {
      const max = isVoice ? 200 : 400;
      parts.push(`[identity] ${selfModel.identity.trim().slice(0, max)}`);
    }
    // [T1.5] user_model on every turn. Previously only in session_start
    // bootstrap, so the mentalizing slot evaporated after turn 1.
    if (!isVoice && selfModel?.user_model) {
      try {
        const um = JSON.parse(selfModel.user_model) as Record<string, string>;
        const interesting = Object.entries(um)
          .filter(([k]) => !["telegram_id", "timezone"].includes(k))
          .slice(0, 4)
          .map(([k, v]) => `${k}=${v}`)
          .join(" · ");
        if (interesting) parts.push(`[user] ${interesting}`);
      } catch { /* malformed user_model */ }
    }
  } catch (err) {
    log?.warn(`[sharpwave] selfModelHeader identity failed: ${String(err)}`);
  }

  try {
    const goals = getActiveGoals(agentId).slice(0, 3);
    if (goals.length > 0) {
      parts.push(`[goals] ${goals.map((g) => g.label).join(" · ")}`);
    }
  } catch (err) {
    log?.warn(`[sharpwave] selfModelHeader goals failed: ${String(err)}`);
  }

  // Neuromodulator state is irrelevant on a phone call — drop on voice surface.
  if (!isVoice) {
    try {
      const neuro = getNeuromodulatorState(agentId);
      parts.push(
        `[neuro] dopamine=${neuro.dopamine.toFixed(2)} serotonin=${neuro.serotonin.toFixed(2)} ` +
        `acetylcholine=${neuro.acetylcholine.toFixed(2)} norepinephrine=${neuro.norepinephrine.toFixed(2)} — ${neuro.interpretation}`,
      );
    } catch (err) {
      log?.warn(`[sharpwave] selfModelHeader neuro failed: ${String(err)}`);
    }
  }

  return parts.join("\n");
}

export async function buildBootstrapContext(
  agentId: string,
  sessionId: string,
  config: BrainConfig,
  log?: { warn: (msg: string) => void },
  surface: Surface = "chat",
): Promise<string> {
  const isVoice = surface === "voice";
  // Voice surface gets a tight budget — Vapi has ~22s LLM tolerance and the
  // brain bootstrap is the primary latency driver on phone calls. Chat gets
  // the full budget. (2026-05-20 — per agent2 hybrid architecture option A.)
  const budgetChars = isVoice
    ? Math.min(config.contextBudget * 4, 6000)
    : config.contextBudget * 4;
  const blocks: string[] = [];
  let used = BRAIN_HEADER.length + 2;

  // Dream context
  try {
    const dreamBlock = getDreamContext(agentId);
    if (dreamBlock) { blocks.push(dreamBlock); used += dreamBlock.length; }
  } catch (err) {
    log?.warn(`[sharpwave] bootstrap dream failed: ${String(err)}`);
  }

  // Self model
  try {
    const selfModel = getSelfModel(agentId);
    if (selfModel) {
      const selfFrac = isVoice ? 0.15 : 0.25;
      const selfBlock = formatSelfModelForContext(selfModel, Math.floor(budgetChars * selfFrac));
      if (selfBlock) { blocks.push(selfBlock); used += selfBlock.length; }
    }
  } catch (err) {
    log?.warn(`[sharpwave] bootstrap self-model failed: ${String(err)}`);
  }

  // Morning brief — only on chat surface (irrelevant on a phone call).
  if (!isVoice) {
    try {
      const brief = getMorningBrief(agentId, config);
      if (brief) {
        const morningBlock = formatMorningBlock(brief);
        blocks.push(morningBlock);
        used += morningBlock.length;
      }
    } catch (err) {
      log?.warn(`[sharpwave] bootstrap morning-brief failed: ${String(err)}`);
    }
  }

  // Active goals
  try {
    const goals = getActiveGoals(agentId);
    if (goals.length > 0) {
      const goalLines = goals.slice(0, 5).map((g) => `• ${g.label}`).join("\n");
      const goalBlock = `[BRAIN: active goals]\n${goalLines}`;
      blocks.push(goalBlock);
      used += goalBlock.length;
    }
  } catch (err) {
    log?.warn(`[sharpwave] bootstrap goals failed: ${String(err)}`);
  }

  // Bootstrap retrieval — top semantic/skill nodes. Voice caps at 3, chat at 8.
  if (used < budgetChars * 0.7) {
    try {
      const topNodes = await bootstrapRetrieve(agentId, sessionId, config);
      if (topNodes.length > 0) {
        const cap = isVoice ? 3 : 8;
        const knowLines = topNodes.slice(0, cap).map((n) =>
          `[${n.type}] ${n.label}: ${n.content.slice(0, 120)}`
        ).join("\n");
        const knowBlock = `[BRAIN: know]\n${knowLines}`;
        blocks.push(knowBlock);
        used += knowBlock.length;
      }
    } catch (err) {
      log?.warn(`[sharpwave] bootstrap retrieval failed: ${String(err)}`);
    }
  }

  // Recent episodes — voice trimmed to 1 (just the immediately prior turn).
  try {
    const recentCap = isVoice ? 1 : 3;
    const recent = getRecentEpisodes(agentId, recentCap);
    if (recent.length > 0) {
      const epLines = [...recent].reverse().map((e) => {
        const speaker = e.role === "user" ? "them" : e.role === "assistant" ? "you" : "tool";
        return `${speaker}: ${e.content.slice(0, 150)}`;
      }).join("\n");
      const epBlock = `[BRAIN: recent]\n${epLines}`;
      if (used + epBlock.length < budgetChars) { blocks.push(epBlock); used += epBlock.length; }
    }
  } catch (err) {
    log?.warn(`[sharpwave] bootstrap episodes failed: ${String(err)}`);
  }

  // Review queue + skill candidates — chat-surface only. Both are FSRS/skill-
  // evolution prompts meant for considered Telegram/Discord turns, not phone
  // calls where Mac has to talk back in <3s.
  if (!isVoice) {
    try {
      const reviewQueue = getReviewQueue(agentId, 3);
      if (reviewQueue.length > 0) {
        const reviewLines = reviewQueue.map((n) =>
          `[fading] ${n.label} (R=${n.retrievability.toFixed(2)})`
        ).join("\n");
        const reviewBlock = `[BRAIN: review — use these or lose them]\n${reviewLines}`;
        if (used + reviewBlock.length < budgetChars) blocks.push(reviewBlock);
      }
    } catch (err) {
      log?.warn(`[sharpwave] bootstrap review-queue failed: ${String(err)}`);
    }

    try {
      // skill-evolution is a stub in sharpwave-core (returns `unknown[]`), so the
      // section stays empty until it is de-stubbed. Cast keeps the .map typed;
      // guarded by `.length > 0` which is always false for the stub.
      const candidates = detectSkillCandidates(agentId, config) as Array<{
        patternLabel: string;
        instanceCount: number;
      }>;
      if (candidates.length > 0) {
        const candBlock = `[BRAIN: skill candidates ready — call brain_generate_skill]\n${candidates.slice(0, 2).map((c) => `• ${c.patternLabel} (${c.instanceCount} instances)`).join("\n")}`;
        if (used + candBlock.length < budgetChars) blocks.push(candBlock);
      }
    } catch (err) {
      log?.warn(`[sharpwave] bootstrap skill-candidates failed: ${String(err)}`);
    }
  }

  const body = blocks.join("\n\n");
  return `${BRAIN_HEADER}\n\n${body}`;
}

// Provenance tag for recall lines (reality monitoring, 2026-07-13). The model
// needs to know HOW a memory was formed to weigh it: heuristic SWS/compaction
// fragments are unattributed gists (the "surgeon" confabulation was one);
// llm_extraction items were attributed at extraction time; agent/brain_manager
// items were deliberately written. Keep tags short — they ride every turn.
function provenanceTag(source: string | null): string {
  switch (source) {
    case "sws":
    case "compaction":
    case "rem":
    case "rem-generative":
    case "nexus":       return "gist";
    case "llm_extraction": return "heard";
    case "agent":
    case "brain_manager":
    case "seed":        return "known";
    default:            return "";
  }
}

export async function buildRecallContext(
  agentId: string,
  query: string,
  sessionId: string,
  config: BrainConfig,
  surface: Surface = "chat",
  /** Populated with the ids actually injected, so later blocks can de-dup. */
  outInjectedIds?: Set<string>,
): Promise<string> {
  if (!query || query.length < 3) return "";

  const results = await hybridRetrieve(agentId, query, sessionId, config);
  if (results.length === 0) return "";

  // Voice: cap to top 3 query-relevant nodes, shorter content. Chat: full.
  const cap = surface === "voice" ? 3 : results.length;
  const contentMax = surface === "voice" ? 120 : 200;
  const injected = results.slice(0, cap);
  const lines = injected.map((n) => {
    const tag = provenanceTag(n.source);
    return `[${n.type}${tag ? "·" + tag : ""}] ${n.label}: ${n.content.slice(0, contentMax)}`;
  });

  // VALOR: remember exactly what was injected so llm_output can score the
  // reply against it. In-memory only — counters are written at scoring time.
  recordInjection(agentId, sessionId, injected);
  if (outInjectedIds) for (const n of injected) outInjectedIds.add(n.id);

  return `[BRAIN: on your mind — ·gist items are rough unattributed fragments; do not assert them as facts about Hailey without checking]\n${lines.join("\n")}`;
}

/** Total chars the procedural block may add to a prompt. Prompt size drives
 *  adaptive-thinking latency on M3, so this stays bounded — but it buys back
 *  a measured ~30% shell-tool failure rate, so it earns its space. */
const PROCEDURAL_MAX_CHARS = 2600;
const PROCEDURAL_MAX_NODES = 8;
/** Generous ON PURPOSE. These nodes state a trap AND its remedy, and the remedy
 *  is always last — at a 200-char cap the PowerShell rule kept "ternary/&&/||
 *  fail as parser errors" but lost "chain on success = cmd1; if ($?) { cmd2 }",
 *  which is the only actionable half. A procedure truncated before its fix is
 *  worse than no procedure: it tells the agent it is stuck with no way out. */
const PROCEDURAL_CONTENT_MAX = 450;

/**
 * Always-on operational rules block.
 *
 * Unlike buildRecallContext this is NOT query-gated — see getOperationalProcedures
 * for why procedural memory can never win a similarity ranking. Injected nodes are
 * recorded through the normal VALOR path so utility is measurable: if this block is
 * not earning its place, procedural `inject_hits` will stay flat while `inject_count`
 * climbs, and that is the signal to cut it. Before this existed, procedural
 * inject_count was 0 forever, so nothing could be measured at all.
 *
 * `excludeIds` prevents double-injection of anything hybridRetrieve already returned.
 */
export function buildProceduralContext(
  agentId: string,
  sessionId: string,
  excludeIds: Set<string> = new Set(),
): string {
  const nodes = getOperationalProcedures(agentId, PROCEDURAL_MAX_NODES)
    .filter((n) => !excludeIds.has(n.id));
  if (nodes.length === 0) return "";

  const injected: typeof nodes = [];
  const lines: string[] = [];
  let budget = PROCEDURAL_MAX_CHARS;
  for (const n of nodes) {
    const line = `[${n.label}] ${n.content.slice(0, PROCEDURAL_CONTENT_MAX)}`;
    // `continue`, not `break`: pack greedily so one oversized rule near the top
    // of the ranking cannot starve every smaller rule behind it.
    if (line.length > budget) continue;
    budget -= line.length;
    lines.push(line);
    injected.push(n);
  }
  if (injected.length === 0) return "";

  recordInjection(agentId, sessionId, injected);

  return `[BRAIN: operational rules — verified on THIS machine, follow them over your priors]\n${lines.join("\n")}`;
}

export { BRAIN_HEADER };
