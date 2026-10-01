// packages/core/src/system-noise.ts
//
// System-noise classifier shared by every consumer of the engine: OpenClaw
// machinery turns (heartbeat polls, exec-completion / cron / session-event
// wakes, silent NO_REPLY / HEARTBEAT_OK replies, memory-flush runs) are not
// conversation and must never be consolidated into recallable nodes.
//
// Used by:
//   - runSwsPhase (consolidation.ts): noise episodes are consumed (flagged
//     llm_extracted = 1, as SWS does for every episode it reads) but produce no
//     node — this is the brain service's own sleep guard, so episodes appended by
//     older clients (openwave <= 0.1.3) can no longer mint triage nodes.
//   - drainExtractionQueue (extraction.ts): noise episodes are dropped before
//     the LLM / heuristic extractor sees them.
//   - sharpwave-server: brain_episode_append skips them; `noise scan` reuses the
//     same rules to find existing pollution.
//
// Mirrors openwave src/system-noise.ts (OpenClaw 2026.9.7 markers — see that
// file for the structured hook-context flags). Keep the two in sync; both repos
// test the same fixture set.

export const SILENT_REPLY_TOKEN = "NO_REPLY";
export const HEARTBEAT_TOKEN = "HEARTBEAT_OK";

/** OpenClaw INTERNAL_WAKE_TRANSCRIPT_PROMPTS (2026.9.7). */
export const INTERNAL_WAKE_MARKERS = [
  "[OpenClaw heartbeat poll]",
  "[OpenClaw exec completion]",
  "[OpenClaw cron wake]",
  "[OpenClaw session event]",
] as const;

/** EmbeddedRunTrigger values that are system runs, not conversation. */
export const SYSTEM_RUN_TRIGGERS: ReadonlySet<string> = new Set(["heartbeat", "memory"]);

export type InputProvenanceLike = { kind?: string; sourceTool?: string } | undefined | null;

export type TurnSignals = {
  role: "user" | "assistant" | "tool";
  content: string;
  sessionKey?: string;
  /** hookCtx.trigger */
  trigger?: string;
  /** hookCtx.inputProvenance */
  inputProvenance?: InputProvenanceLike;
  /** llm_output event.prompt (the user prompt that produced this output), when present. */
  prompt?: string;
};

export type NoiseVerdict =
  | { skip: false }
  | { skip: true; reason: string; via: "structured" | "session" | "text" | "pattern" };

export type NoiseOptions = {
  /** Master switch (config skipSystemTurns, default true). */
  enabled?: boolean;
  /** Extra regexes (config systemTurnPatterns) tested against the trimmed content of any role. */
  extraPatterns?: readonly RegExp[];
};

const USER_PREFIXES: readonly RegExp[] = [
  // Default heartbeat prompt (HEARTBEAT_CONTEXT_PROMPT) and the legacy one.
  /^Follow the heartbeat monitor scratch context when provided\./,
  /^Read HEARTBEAT\.md if it exists\b/,
  // buildExecEventPrompt / buildCronEventPrompt.
  /^An async command (?:completion event was triggered|you ran earlier (?:has )?completed)\b/,
  /^A scheduled (?:cron event|reminder) has been triggered\b/,
  /^A scheduled cron event was triggered\b/,
];

const SYSTEM_EVENT_LINE: readonly RegExp[] = [
  /^System:\s/,
  /^exec (?:completed|failed) \([a-z0-9_-]{1,64}, (?:code -?\d+|signal [^)]+)\)/i,
  /^exec finished(?::|\s*\()/i,
];

const THINK_BLOCK = /^\s*<\s*(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking)\b[^<>]*>[\s\S]*?<\s*\/\s*(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking)\s*>\s*/i;
const SILENT_INTENT = /^\s*(?:i|i'll|i\s+will|i'm|i\s+am|we|we'll|we\s+will|the\s+assistant|assistant|openclaw)\s+(?:(?:will\s+)?(?:stay|remain|keep|be)\s+(?:quiet|silent)\b.*|(?:do\s+not|don't|dont|will\s+not|won't)\s+(?:reply|respond)\b.*|(?:have|has)\s+nothing\s+(?:to|for)\s+(?:say|add|reply|respond)\b.*)$/i;
const LEADING_TOKEN = /^[\s*_`"'([]*(?:NO_REPLY|HEARTBEAT_OK)(?!_)/i;
const TRAILING_TOKEN = /(?:^|[\s*.])(?:NO_REPLY|HEARTBEAT_OK)[\s*.]*$/i;
const HEARTBEAT_ACK_MAX_CHARS = 300;

function stripThink(text: string): string {
  let cur = text;
  for (;;) {
    const next = cur.replace(THINK_BLOCK, "");
    if (next === cur) return cur;
    cur = next;
  }
}

/** True when an assistant text is a silent / heartbeat-ack reply (OpenClaw would not deliver it). */
export function isSilentReplyText(raw: string): boolean {
  const text = stripThink(raw.trim()).trim();
  if (!text) return false;
  if (LEADING_TOKEN.test(text)) return true;
  // JSON string / {"action":"NO_REPLY"} envelopes.
  if ((text.startsWith("\"") || text.startsWith("{")) && /NO_REPLY|HEARTBEAT_OK/.test(text)) {
    try {
      const v = JSON.parse(text) as unknown;
      if (typeof v === "string" && /^(?:NO_REPLY|HEARTBEAT_OK)$/i.test(v.trim())) return true;
      if (v && typeof v === "object" && !Array.isArray(v)) {
        const keys = Object.keys(v);
        const a = (v as Record<string, unknown>)["action"];
        if (keys.length === 1 && typeof a === "string" && /^(?:NO_REPLY|HEARTBEAT_OK)$/i.test(a.trim())) return true;
      }
    } catch { /* not JSON */ }
  }
  if (TRAILING_TOKEN.test(text)) {
    const rest = text.replace(TRAILING_TOKEN, "").trim();
    if (!rest) return true;
    // HEARTBEAT_OK with a short remainder is an ack (OpenClaw ackMaxChars = 300).
    if (/HEARTBEAT_OK[\s*.]*$/i.test(text) && rest.length <= HEARTBEAT_ACK_MAX_CHARS) return true;
    const lastLine = rest.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
    if (SILENT_INTENT.test(rest) || SILENT_INTENT.test(lastLine)) return true;
  }
  return false;
}

/** True when a user-role text is an OpenClaw internal wake / system-event body. */
export function isInternalWakeText(raw: string): boolean {
  const text = raw.trim();
  if (!text) return false;
  for (const m of INTERNAL_WAKE_MARKERS) if (text.startsWith(m)) return true;
  for (const re of USER_PREFIXES) if (re.test(text)) return true;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length > 0 && lines.every((l) => SYSTEM_EVENT_LINE.some((re) => re.test(l)))) return true;
  return false;
}

export function isHeartbeatSessionKey(sessionKey: string | undefined): boolean {
  return !!sessionKey && sessionKey.endsWith(":heartbeat");
}

export function classifySystemTurn(t: TurnSignals, opts: NoiseOptions = {}): NoiseVerdict {
  if (opts.enabled === false) return { skip: false };
  // 1. Structured provenance from the host.
  if (t.trigger && SYSTEM_RUN_TRIGGERS.has(t.trigger)) return { skip: true, reason: `trigger:${t.trigger}`, via: "structured" };
  const prov = t.inputProvenance;
  if (prov && prov.kind === "internal_system" && prov.sourceTool !== "cron") {
    return { skip: true, reason: `provenance:internal_system:${prov.sourceTool ?? "unknown"}`, via: "structured" };
  }
  if (isHeartbeatSessionKey(t.sessionKey)) return { skip: true, reason: "session:heartbeat", via: "session" };
  // 2. Text fallback.
  const content = String(t.content ?? "");
  if (t.role === "assistant" && isSilentReplyText(content)) return { skip: true, reason: "text:silent_reply", via: "text" };
  if (t.role === "user" && isInternalWakeText(content)) return { skip: true, reason: "text:internal_wake", via: "text" };
  if (t.role === "assistant" && typeof t.prompt === "string" && isInternalWakeText(t.prompt)) {
    return { skip: true, reason: "text:reply_to_internal_wake", via: "text" };
  }
  // 3. Operator-supplied extra patterns.
  const trimmed = content.trim();
  for (const re of opts.extraPatterns ?? []) {
    re.lastIndex = 0;
    if (re.test(trimmed)) return { skip: true, reason: `pattern:${re.source.slice(0, 40)}`, via: "pattern" };
  }
  return { skip: false };
}

export function isSystemNoiseTurn(t: TurnSignals, opts: NoiseOptions = {}): boolean {
  return classifySystemTurn(t, opts).skip;
}

/** Compile config systemTurnPatterns; invalid entries are returned in `invalid` (and ignored). */
export function compileSystemTurnPatterns(raw: unknown): { patterns: RegExp[]; invalid: string[] } {
  const patterns: RegExp[] = [];
  const invalid: string[] = [];
  if (!Array.isArray(raw)) return { patterns, invalid };
  for (const p of raw) {
    if (typeof p !== "string" || !p.trim() || p.length > 500) { invalid.push(String(p)); continue; }
    try { patterns.push(new RegExp(p, "i")); } catch { invalid.push(p); }
  }
  return { patterns, invalid };
}

const PAIR_WINDOW_MS = 10 * 60 * 1000;

/**
 * Pairs a skipped user turn with the assistant reply that answers it, for
 * hosts/paths where the reply carries no structured flag: after a user turn in
 * session S is classified as noise, the next assistant output in S (within 10
 * minutes) is skipped too.
 */
export class NoisePairTracker {
  private pending = new Map<string, number>();
  constructor(private readonly now: () => number = Date.now) {}
  markUserSkipped(sessionKey: string | undefined): void {
    if (!sessionKey) return;
    this.pending.set(sessionKey, this.now() + PAIR_WINDOW_MS);
    if (this.pending.size > 500) {
      const t = this.now();
      for (const [k, exp] of this.pending) if (exp < t) this.pending.delete(k);
    }
  }
  /** True (and consumed) when the previous user turn in this session was skipped. */
  takeReplySkip(sessionKey: string | undefined): boolean {
    if (!sessionKey) return false;
    const exp = this.pending.get(sessionKey);
    if (exp === undefined) return false;
    this.pending.delete(sessionKey);
    return exp >= this.now();
  }
  /** A real (non-noise) user turn cancels any pending pairing for the session. */
  clear(sessionKey: string | undefined): void {
    if (sessionKey) this.pending.delete(sessionKey);
  }
}

export type SystemNoiseSettings = { enabled: boolean; extraPatterns: RegExp[]; invalidPatterns: string[] };

export function resolveSystemNoiseSettings(cfg: { skipSystemTurns?: unknown; systemTurnPatterns?: unknown }): SystemNoiseSettings {
  const { patterns, invalid } = compileSystemTurnPatterns(cfg.systemTurnPatterns);
  return { enabled: cfg.skipSystemTurns !== false, extraPatterns: patterns, invalidPatterns: invalid };
}

/** Episode-shaped input (role/content/session_id) — the only signals stored in the episode log. */
export function isSystemNoiseEpisode(ep: { role: string; content: string; session_id?: string | null }, opts: NoiseOptions = {}): boolean {
  const role = ep.role === "user" || ep.role === "assistant" || ep.role === "tool" ? ep.role : "tool";
  return classifySystemTurn({ role, content: ep.content ?? "", sessionKey: ep.session_id ?? undefined }, opts).skip;
}

/**
 * meta_kv key prefixes for the reversible "retire" registry used by
 * sharpwave-server `noise retire`. A node is retired by setting valid_until
 * (every recall path already filters it) and recording its prior state under
 * `retired:node:<id>`; an episode by zeroing importance under
 * `retired:episode:<id>`. Sleep (SWS downscale, Deep prune) never touches a
 * node that has a registry row, so `noise unretire` can restore it exactly.
 */
export const RETIRED_NODE_META_PREFIX = "retired:node:";
export const RETIRED_EPISODE_META_PREFIX = "retired:episode:";
