import { getOperationalProcedures } from "./nodes.js";
import { hybridRetrieve } from "./retrieval.js";
import { recordInjection } from "./valor.js";
import type { BrainConfig } from "./types.js";
import type { Surface } from "./context-assembly-shared.js";

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
