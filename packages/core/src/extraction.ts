import { classifySentence, importanceForType, extractBalancedJson } from "./utils.js";
import { callOpenRouter } from "./llm.js";
import type { Episode, BrainConfig, NodeType } from "./types.js";

export interface ExtractedFact {
  type: NodeType;
  label: string;
  content: string;
  importance: number;
  confidence: number;
  relates_to?: string[];
}

/**
 * Temporal relation extracted from the LLM payload.
 *
 * Sources of these:
 *   1. LLM extraction prompt now asks for `temporal_relations: [{subject, relation, object}]`.
 *   2. SWS heuristic pass synthesizes them implicitly between sequential extracted nodes
 *      (handled in consolidation.ts:runSwsPhase, not here).
 *
 * `subject` and `object` are the **labels** the LLM used in this batch — index.ts
 * (Agent C) is expected to resolve those labels back to node ids after writing
 * the fact rows. We do NOT resolve here because extraction.ts does not have node
 * ids yet — index.ts owns the writeNode call.
 *
 * Per audit/code-1.md fix #5 + audit/SYNTHESIS.md T1.5.
 */
export interface TemporalRelation {
  subject: string;
  relation: "before" | "after";
  object: string;
}

/**
 * Return shape of `drainExtractionQueue`.
 *
 * IMPORTANT (Agent B → Agent C coordination, per SCHEMA_CONTRACT.md):
 *
 *   The drain used to return `ExtractedFact[]` directly. T1.3 (dual-extraction
 *   prevention) needs the caller to mark the consumed episodes as
 *   `llm_extracted = 1` after writing the facts. We therefore return an
 *   array-with-extra-properties so legacy iteration code
 *
 *       const facts = await drainExtractionQueue(...);
 *       for (const fact of facts) writeNode(...);
 *
 *   keeps working unchanged, while the caller can now also read:
 *
 *       const { episodeIds, temporalRelations } = facts;
 *
 *   and (a) mark `episodeIds` with `UPDATE episodes SET llm_extracted = 1 WHERE id IN (...)`
 *   and (b) write `before` edges between label-resolved nodes for each
 *   `temporalRelations[i]`.
 *
 *   The SWS pass in consolidation.ts already covers (a) for the heuristic
 *   path. Until Agent C wires the LLM-extraction side, the SWS query filter
 *   `WHERE llm_extracted = 0` still protects against double-processing because
 *   SWS marks every episode it touches.
 */
export type DrainResult = ExtractedFact[] & {
  episodeIds: string[];
  temporalRelations: TemporalRelation[];
};

function makeDrainResult(
  facts: ExtractedFact[],
  episodeIds: string[],
  temporalRelations: TemporalRelation[],
): DrainResult {
  const arr = [...facts] as DrainResult;
  Object.defineProperty(arr, "episodeIds", { value: episodeIds, enumerable: false, writable: true });
  Object.defineProperty(arr, "temporalRelations", { value: temporalRelations, enumerable: false, writable: true });
  return arr;
}

const pendingEpisodes = new Map<string, Episode[]>();
const MAX_PENDING = 200;

export function queueEpisodeForExtraction(agentId: string, episode: Episode): void {
  const q = pendingEpisodes.get(agentId) ?? [];
  if (q.length >= MAX_PENDING) return;
  q.push(episode);
  pendingEpisodes.set(agentId, q);
}

export async function drainExtractionQueue(
  agentId: string,
  config: BrainConfig,
  log: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<DrainResult> {
  // Always drain the queue to prevent unbounded growth regardless of enabled state
  if (!config.llmExtractionEnabled) {
    pendingEpisodes.delete(agentId);
    return makeDrainResult([], [], []);
  }

  const q = pendingEpisodes.get(agentId) ?? [];
  const eligible = q.filter((e) => e.importance >= config.llmExtractionMinImportance);
  pendingEpisodes.delete(agentId);

  if (eligible.length === 0) return makeDrainResult([], [], []);

  const results: ExtractedFact[] = [];
  const temporalRelations: TemporalRelation[] = [];
  const BATCH = 5;
  const CAP = 20 * BATCH;

  if (eligible.length > CAP) {
    log.warn(`[clawbrain-v4] extraction: ${eligible.length - CAP} episode(s) dropped beyond ${CAP}-item cap`);
  }

  const consumed: Episode[] = [];
  for (let i = 0; i < eligible.length && i < CAP; i += BATCH) {
    const batch = eligible.slice(i, i + BATCH);
    const { facts, temporal } = await extractBatch(batch, config, log);
    results.push(...facts);
    temporalRelations.push(...temporal);
    consumed.push(...batch);
  }

  // Per audit/code-1.md fix #3 / SYNTHESIS.md T1.3: return the episode ids
  // we consumed so the caller can flip `episodes.llm_extracted = 1` for them.
  return makeDrainResult(results, consumed.map((e) => e.id), temporalRelations);
}

async function extractBatch(
  episodes: Episode[],
  config: BrainConfig,
  log: { info: (msg: string) => void; warn: (msg: string) => void },
): Promise<{ facts: ExtractedFact[]; temporal: TemporalRelation[] }> {
  // sharpwave-core is single-provider OpenRouter: every direct LLM call in the
  // engine goes through `callOpenRouter` (./llm.ts), shared with
  // consolidation.ts's generative-REM / contradiction path. clawbrain-v4's
  // multi-provider `resolveChatLlmChain([ingestionModel, ...config.llmFallbacks])`
  // is dropped here — `llmFallbacks` is not a sharpwave `BrainConfig` field.
  // A missing key degrades to the heuristic fallback, exactly as an empty
  // provider chain did before.
  const apiKey = config.openRouterApiKey || process.env["OPENROUTER_API_KEY"] || "";
  if (!apiKey) {
    log.warn("[clawbrain-v4] extraction: no API key for any chain model — using heuristic fallback");
    return { facts: heuristicFallback(episodes), temporal: heuristicTemporal(episodes) };
  }

  const prompt = buildExtractionPrompt(episodes);

  try {
    // 1500-token budget preserved from clawbrain-v4's inline fetch (the shared
    // callOpenRouter defaults to 600 for consolidation's REM path).
    const text = await callOpenRouter(prompt, config.ingestionModel, apiKey, 1500);
    if (!text.trim()) {
      log.warn(`[clawbrain-v4] extraction: empty response from ${config.ingestionModel} — using heuristic fallback`);
      return { facts: heuristicFallback(episodes), temporal: heuristicTemporal(episodes) };
    }
    const parsed = parseExtractionPayload(text);
    parsed.facts = guardProceduralFacts(parsed.facts, episodes, log);

    log.info(`[clawbrain-v4] extraction: ${parsed.facts.length} facts + ${parsed.temporal.length} temporal from ${episodes.length} episodes (model=${config.ingestionModel})`);
    return parsed;
  } catch (err) {
    log.warn(`[clawbrain-v4] extraction failed on ${config.ingestionModel}: ${String(err)} — using heuristic fallback`);
    return { facts: heuristicFallback(episodes), temporal: heuristicTemporal(episodes) };
  }
}

/**
 * PRAXIS verbatim guard (2026-07-13): a procedural node's value is that its
 * command is EXACTLY what worked. A weak/degraded extractor could mangle a
 * flag while "extracting" it and poison memory with a wrong recipe at
 * importance 0.9. Guard: every long flag (--foo) in a procedural fact's
 * content must literally appear in the source episode text — if the extractor
 * changed even one flag, the fact is dropped. Facts without long flags pass
 * (nothing verifiable to check). Hallucination-proof by construction.
 */
export function guardProceduralFacts(
  facts: ExtractedFact[],
  episodes: Episode[],
  log: { warn: (msg: string) => void },
): ExtractedFact[] {
  const sourceText = episodes.map((e) => e.content).join("\n");
  return facts.filter((f) => {
    if (f.type !== "procedural") return true;
    const flags = f.content.match(/--[a-zA-Z][a-zA-Z0-9-]*/g) ?? [];
    for (const flag of flags) {
      if (!sourceText.includes(flag)) {
        log.warn(`[clawbrain-v4] PRAXIS guard: dropped procedural "${f.label.slice(0, 60)}" — flag ${flag} not found verbatim in source episodes`);
        return false;
      }
    }
    return true;
  });
}

// The extraction prompt offers human-friendly categories the node schema does
// not have. Unmapped types used to be written verbatim (2 live `fact` nodes
// found 2026-07-13) — invisible to every type-based query and decaying on the
// default half-life. Map them onto real NodeTypes; anything unknown → semantic.
const NODE_TYPE_ALIASES: Record<string, NodeType> = {
  fact: "semantic",
  preference: "semantic",
  relationship: "semantic",
};
const VALID_NODE_TYPES = new Set<string>([
  "identity", "semantic", "episodic", "pattern", "skill", "goal", "emotion", "procedural", "schema",
]);
function normalizeNodeType(raw: string): NodeType {
  if (VALID_NODE_TYPES.has(raw)) return raw as NodeType;
  return NODE_TYPE_ALIASES[raw] ?? "semantic";
}

/**
 * Parse the LLM response. Two accepted shapes:
 *
 *   1. Legacy: top-level JSON array of facts.
 *   2. v4: top-level JSON object with `facts: [...]` and optional `temporal_relations: [...]`.
 *
 * We accept both so the prompt change is backward compatible with cached / older
 * model responses that still answer with a bare array.
 */
function parseExtractionPayload(text: string): { facts: ExtractedFact[]; temporal: TemporalRelation[] } {
  try {
    // Prefer object-form (v4). Balanced scan instead of greedy regex so
    // trailing text after the JSON no longer poisons the batch (Opus #5).
    const objStart = text.indexOf("{");
    const arrStart = text.indexOf("[");

    let rawFacts: unknown[] = [];
    let rawTemporal: unknown[] = [];

    if (objStart !== -1 && (arrStart === -1 || objStart < arrStart)) {
      const objStr = extractBalancedJson(text, "{");
      if (!objStr) return { facts: [], temporal: [] };
      const obj = JSON.parse(objStr) as Record<string, unknown>;
      if (Array.isArray(obj["facts"])) rawFacts = obj["facts"] as unknown[];
      if (Array.isArray(obj["temporal_relations"])) rawTemporal = obj["temporal_relations"] as unknown[];
      // Some models will still emit a bare array under the "nodes" key.
      if (rawFacts.length === 0 && Array.isArray(obj["nodes"])) rawFacts = obj["nodes"] as unknown[];
    } else if (arrStart !== -1) {
      const arrStr = extractBalancedJson(text, "[");
      if (!arrStr) return { facts: [], temporal: [] };
      rawFacts = JSON.parse(arrStr) as unknown[];
    } else {
      return { facts: [], temporal: [] };
    }

    const facts: ExtractedFact[] = rawFacts
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map((item) => ({
        type: normalizeNodeType(String(item["type"] ?? "semantic")),
        label: String(item["label"] ?? "").slice(0, 100),
        content: String(item["content"] ?? ""),
        importance: Math.min(1, Math.max(0, Number(item["importance"] ?? 0.5))),
        confidence: Math.min(1, Math.max(0, Number(item["confidence"] ?? 0.8))),
        relates_to: Array.isArray(item["relates_to"]) ? (item["relates_to"] as string[]) : undefined,
      }))
      .filter((f) => f.label.length > 3 && f.content.length > 5);

    const temporal: TemporalRelation[] = rawTemporal
      .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
      .map((item) => ({
        subject: String(item["subject"] ?? "").slice(0, 200),
        relation: (item["relation"] === "after" ? "after" : "before") as "before" | "after",
        object: String(item["object"] ?? "").slice(0, 200),
      }))
      .filter((r) => r.subject.length > 0 && r.object.length > 0 && r.subject !== r.object);

    return { facts, temporal };
  } catch {
    return { facts: [], temporal: [] };
  }
}

function buildExtractionPrompt(episodes: Episode[]): string {
  const messages = episodes.map((e) =>
    `${e.role.toUpperCase()}: ${e.content.slice(0, 300)}`
  ).join("\n\n");

  return `Extract durable facts worth remembering as structured memory nodes from this conversation.

Rules:
- identity: things that define who someone IS ("I'm a morning person", "my name is X")
- relationship: how two people relate ("Hailey is my mom", "I trust her completely", "we built this together")
- preference: likes, dislikes, opinions, taste ("loves 90s music", "hates corporate jargon", "prefers direct talk over padding")
- fact: durable real-world details about a person, place, or thing ("Hailey lives in Phoenix", "her birthday is May 9")
- skill: things the agent knows HOW TO DO
- pattern: recurring behaviors or tendencies
- semantic: world knowledge, world events, abstract concepts
- goal: active intentions or objectives
- episodic: specific events that happened
- procedural: VERIFIED PROCEDURES (PRAXIS rule — highest extraction priority). When the conversation shows a command, API call, config value, or exact step sequence that WORKED — especially after failed attempts — emit a procedural node. Content MUST contain the working command/recipe copied CHARACTER-FOR-CHARACTER (flags, quoting, paths, IDs) — never paraphrase, summarize, or "improve" syntax. If earlier attempts failed, name the broken variant explicitly in the same content ("--max works; --limit does NOT exist"). Importance 0.85+. Procedures may be extracted from either USER or ASSISTANT messages — they describe the system, not the user.
- SKIP only: filler with zero information content ("ok", "lol", "yep" in isolation, pure timestamps)
- KEEP: emotional moments, casual asides, vibes, shared jokes — these are how a self gets shape
- ATTRIBUTION (critical): facts, identity, preferences, or life details about the USER may ONLY be extracted from USER messages. Never derive them from ASSISTANT messages — assistant statements can be guesses, jokes, or hallucinations (the assistant once wrongly called the user a surgeon and it became a stored memory). Facts about the assistant itself MAY come from assistant messages.
- CORRECTIONS: when the user corrects something ("no, I'm actually X", "that's wrong, it's Y"), emit the corrected fact with importance 0.9+ and state it as the definitive version.
- FAILURE vs FIX: a failure alone is episodic (low importance). A failure FOLLOWED BY the working fix is procedural (high importance) — the fix is the memory that matters. Never emit only the failure when the fix is visible in the same conversation.

Each fact:
{"type":"identity|relationship|preference|fact|skill|pattern|semantic|goal|episodic|procedural","label":"<15 words max>","content":"<full statement>","importance":0.0-1.0,"confidence":0.0-1.0,"relates_to":["<label of related fact>"]}

Procedural example (exact-verbatim command capture):
{"type":"procedural","label":"Maton Gmail unread check — working command","content":"VERIFIED: maton google-mail message list --connection d6874d42 --max 5 --hydrate — the limit flag is --max; --limit does NOT exist (fails: unknown flag).","importance":0.9,"confidence":0.95}

Also extract any clear sequential ordering between facts. A "before" relation means the subject happened or was decided before the object. Example: {"subject":"chose Python","relation":"before","object":"installed numpy"}.

Return a single JSON object only — no other text:
{
  "facts": [ ... ],
  "temporal_relations": [ {"subject":"<label>","relation":"before|after","object":"<label>"} ]
}

Return {"facts":[],"temporal_relations":[]} if nothing worth remembering.

Conversation:
${messages}`;
}

function heuristicFallback(episodes: Episode[]): ExtractedFact[] {
  const results: ExtractedFact[] = [];

  for (const ep of episodes) {
    const sentences = ep.content
      .replace(/\[\[[^\]]*\]\]/g, " ") // strip channel markers like [[reply_to_current]]
      .split(/[.!?\n]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 25);

    for (const sentence of sentences) {
      const type = classifySentence(sentence);
      if (!type) continue;
      // Reality-monitoring guard (2026-07-13 surgeon incident): the heuristic
      // path cannot attribute WHO a statement is about, so assistant text must
      // never mint durable identity/semantic/goal "facts" — the assistant's
      // own guesses and jokes were becoming memories indistinguishable from
      // things the user actually said. Assistant sentences may only produce
      // low-half-life episodic notes; user sentences keep full classification.
      if (ep.role !== "user" && type !== "episodic") continue;
      results.push({
        type,
        label: sentence.slice(0, 60).replace(/\s+/g, " "),
        content: sentence,
        importance: importanceForType(type),
        confidence: ep.role === "user" ? 1.0 : 0.5,
      });
    }
  }

  return results;
}

/**
 * For the heuristic-fallback path we emit a `before` relation between the
 * first classifiable sentence of episode N and the first classifiable
 * sentence of episode N+1 within the same conversation segment.
 *
 * We don't have the same session-segmentation context the SWS pass has, so
 * this is a best-effort linear chain over the batch order. The downstream
 * code (Agent C in index.ts, plus consolidation.ts:runSwsPhase) is
 * responsible for cross-checking session_id before turning these label
 * references into actual edges.
 */
function heuristicTemporal(episodes: Episode[]): TemporalRelation[] {
  const headSentences: string[] = [];
  for (const ep of episodes) {
    const head = ep.content
      .split(/[.!?\n]+/)
      .map((s) => s.trim())
      .find((s) => s.length > 25 && classifySentence(s) !== null);
    if (head) headSentences.push(head.slice(0, 60).replace(/\s+/g, " "));
  }
  const out: TemporalRelation[] = [];
  for (let i = 0; i + 1 < headSentences.length; i++) {
    if (headSentences[i] === headSentences[i + 1]) continue;
    out.push({ subject: headSentences[i], relation: "before", object: headSentences[i + 1] });
  }
  return out;
}
