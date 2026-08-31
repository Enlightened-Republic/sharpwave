import type { NodeType } from "./types.js";

// ─── Session-key parsing (Code-1 P1-1 fix) ─────────────────────────────────────

/**
 * Resolve an agentId from a session key string.
 *
 * Prior v3 logic was `sessionKey.split(":")[0]`, which for keys like
 * `"telegram:hailey:chat-id"` returned the channel name "telegram" instead of
 * an agent id — every hook then no-op'd via `if (!config.agents.includes(...))`.
 *
 * Strategy here:
 *   1. Empty key → first configured agent, else "main".
 *   2. `agent:<id>` prefix → return `<id>`.
 *   3. Any other segment that matches `configAgents` → return it.
 *   4. Fallback: first configured agent.
 */
export function agentIdFromKey(sessionKey: string, configAgents: string[]): string {
  if (!sessionKey) return configAgents[0] ?? "main";

  if (sessionKey.startsWith("agent:")) {
    const rest = sessionKey.slice("agent:".length);
    const id = rest.split(":")[0];
    if (id) return id;
  }
  const segments = sessionKey.split(":");
  for (const seg of segments) {
    if (configAgents.includes(seg)) return seg;
  }
  return configAgents[0] ?? "main";
}

// ─── Bounded TTL map / set (Tier 3 T3.4) ───────────────────────────────────────

/**
 * In-memory map with LRU eviction at `capacity` and per-entry TTL.
 *
 * Used by index.ts for `bootstrapCache`, `bootstrapInjected`, and
 * `queuedSessions` to bound state growth across long uptimes — orphaned
 * sessions (gateway killed without session_end) are evicted automatically.
 */
export class BoundedTtlMap<V> {
  private map = new Map<string, { value: V; insertedAt: number }>();
  constructor(private capacity: number, private ttlMs: number) {}

  set(key: string, value: V): void {
    // Touch by deleting+re-inserting so LRU order reflects last write.
    this.map.delete(key);
    this.map.set(key, { value, insertedAt: Date.now() });
    while (this.map.size > this.capacity) {
      // Oldest insertion is at the front (Map iteration order = insertion order).
      const firstKey = this.map.keys().next().value as string | undefined;
      if (firstKey === undefined) break;
      this.map.delete(firstKey);
    }
  }

  get(key: string): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.insertedAt > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return entry.value;
  }

  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    return this.map.size;
  }
}

export class BoundedTtlSet {
  private inner: BoundedTtlMap<true>;
  constructor(capacity: number, ttlMs: number) {
    this.inner = new BoundedTtlMap<true>(capacity, ttlMs);
  }
  add(key: string): void { this.inner.set(key, true); }
  has(key: string): boolean { return this.inner.has(key); }
  delete(key: string): void { this.inner.delete(key); }
  clear(): void { this.inner.clear(); }
  get size(): number { return this.inner.size; }
}


/**
 * Classifies a sentence into a memory node type.
 *
 * Order matters: more specific patterns are checked first so that sentences
 * matching multiple patterns (e.g. "I want to learn how to deploy") resolve
 * to the highest-priority type (goal beats skill).
 */
export function classifySentence(s: string): NodeType | null {
  const lower = s.toLowerCase();
  if (s.length < 25) return null;

  // Goal — checked first: "I am trying to X" is a goal, not identity
  if (/\b(i want to|i need to|i'?m trying to|i am trying to|i aim to|i plan to|i intend to|my goal is|goal is to|working toward)\b/.test(lower)) return "goal";

  // Emotion — checked before identity: "I am excited/worried/proud" is an emotional state, not identity
  const EMOTION_WORDS = /\b(sad|happy|angry|frustrated|excited|worried|anxious|proud|scared|nervous|stressed|overwhelmed|grateful|disappointed|hopeful|lonely|devastated|thrilled|depressed|elated)\b/;
  if (/\b(i feel|i felt|i am|i'm|i was)\b/.test(lower) && EMOTION_WORDS.test(lower)) return "emotion";

  // Identity — self-defining statements (emotion-free "I am" sentences: roles, traits, values)
  if (/\b(i am|my name is|i identify|my personality|i value|i prefer)\b/.test(lower)) return "identity";

  // Procedural — explicit step sequences ("first … then", numbered steps, etc.)
  if (
    /\b(step\s+\d+|following steps|do the following|run the following|in sequence|step-by-step)\b/.test(lower) ||
    (/\bfirst[,:]/.test(lower) && /\bthen\b/.test(lower))
  ) return "procedural";

  // Skill — how-to knowledge
  if (/\b(to do|in order to|the steps|procedure|how to|technique|method|command|run|execute)\b/.test(lower)) return "skill";

  // Pattern — recurring behaviors
  if (/\b(always|usually|often|tends to|pattern|recurring|habit|consistently)\b/.test(lower)) return "pattern";

  // Semantic — factual / definitional (must be substantive)
  if (/\b(is|are|was|were|means|defined as|refers to|known as)\b/.test(lower) && s.length > 40) return "semantic";

  // Episodic — time-anchored events
  if (/\b(on|today|yesterday|last|when|during|after|the user|we|i)\b/.test(lower)) return "episodic";

  return null;
}

export function importanceForType(type: NodeType | string): number {
  const map: Partial<Record<NodeType, number>> = {
    identity:   0.85,
    goal:       0.80,
    schema:     0.80,
    skill:      0.75,
    procedural: 0.75,
    pattern:    0.70,
    emotion:    0.65,
    semantic:   0.60,
    episodic:   0.45,
  };
  return (map as Record<string, number>)[type] ?? 0.5;
}

/**
 * Extract the first balanced JSON object or array from free-form LLM output.
 *
 * Replaces the greedy `/\{[\s\S]*\}/` regex (Opus audit #5): when a model
 * returned `{...}` followed by any trailing text containing another `}` (an
 * example, a second object, commentary), the greedy match spanned both and
 * JSON.parse threw — silently dropping the whole batch. This scanner tracks
 * brace depth and string/escape state, so trailing garbage is ignored.
 *
 * Returns the balanced slice starting at the first `open` character, or null
 * when no balanced value exists.
 *
 * Ported verbatim from clawbrain-v4/src/utils.ts (openwave / sharpwave-core
 * split, Task 6d) — used by extraction.ts to parse the fact-extraction payload.
 */
export function extractBalancedJson(text: string, open: "{" | "[" = "{"): string | null {
  const close = open === "{" ? "}" : "]";
  const start = text.indexOf(open);
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

export function jaccardSim(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/).filter(Boolean));
  const setB = new Set(b.toLowerCase().split(/\s+/).filter(Boolean));
  if (setA.size === 0 && setB.size === 0) return 0;
  const intersection = [...setA].filter((w) => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}
