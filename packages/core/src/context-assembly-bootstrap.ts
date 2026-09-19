import { getSelfModel, formatSelfModelForContext } from "./self-model.js";
import { getMorningBrief, formatMorningBlock } from "./morning.js";
import { getActiveGoals, getReviewQueue } from "./nodes.js";
import { getRecentEpisodes } from "./episodes.js";
import { detectSkillCandidates } from "./skill-evolution.js";
import { bootstrapRetrieve } from "./retrieval.js";
import type { BrainConfig } from "./types.js";
import { BRAIN_HEADER, getDreamContext, type Surface, type ContextAssemblyOptions } from "./context-assembly-shared.js";

export async function buildBootstrapContext(
  agentId: string,
  sessionId: string,
  config: BrainConfig,
  log?: { warn: (msg: string) => void },
  surface: Surface = "chat",
  opts: ContextAssemblyOptions = {},
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

  // Self model prose — skipped when a host curated tier already owns durable
  // identity/goals (see ContextAssemblyOptions.externalMemoryActive).
  if (!opts.externalMemoryActive) {
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

  // Active goals — skipped when a host memory system (MEMORY.md/USER.md) is
  // already active, since goals are exactly the kind of durable, curated
  // content that tier owns. See ContextAssemblyOptions.externalMemoryActive.
  if (!opts.externalMemoryActive) {
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
