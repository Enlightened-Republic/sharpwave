import { getSelfModel } from "./self-model.js";
import { getActiveGoals } from "./nodes.js";
import { getNeuromodulatorState } from "./consolidation.js";
import type { BrainConfig } from "./types.js";
import type { Surface, ContextAssemblyOptions } from "./context-assembly-shared.js";

export async function buildSelfModelHeader(
  agentId: string,
  _config: BrainConfig,
  log?: { warn: (msg: string) => void },
  surface: Surface = "chat",
  opts: ContextAssemblyOptions = {},
): Promise<string> {
  const isVoice = surface === "voice";
  const parts: string[] = [];
  if (!isVoice) {
    parts.push(
      "[SharpWave] Identity, goals, and neuromodulator state pre-loaded. Use brain_query for deep recall.",
    );
  }

  // When a host curated tier (MEMORY.md/USER.md) is active, skip durable
  // identity, user_model, and goals — that tier already owns them. Keep the
  // SharpWave banner and neuromodulator snapshot (graph-specific).
  if (!opts.externalMemoryActive) {
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
