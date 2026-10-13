// packages/core/src/belief-meta.ts
//
// Pure helpers for Xanima belief metadata (no DB access, safe to import from
// anywhere — nodes.ts uses them on every write).

import type { ConfidenceLevel, SourceType, Sensitivity } from "./types.js";
import { CONFIDENCE_LEVELS, SOURCE_TYPES, SENSITIVITIES } from "./types.js";

/** Numeric score each level maps to when only a level is given. */
export const CONFIDENCE_LEVEL_SCORE: Record<ConfidenceLevel, number> = {
  low: 0.3,
  medium: 0.6,
  high: 0.8,
  certain: 0.95,
};

/** Default confidence for a fresh write, by source. */
export const DEFAULT_CONFIDENCE_BY_SOURCE: Record<SourceType, number> = {
  user: 0.8,             // the user said it (still fallible — people misspeak)
  seed: 0.8,             // operator-curated import
  self_observation: 0.7, // the agent deliberately recorded something it saw/did
  tool: 0.65,            // tool output (can be stale or wrong)
  agent: 0.6,            // another agent said so
  legacy: 0.6,           // pre-Xanima row, origin unknown
  inference: 0.45,       // derived by sleep / extraction heuristics
  import: 0.5,           // loaded from a Soul Package (original confidence kept in soul_provenance)
};

/** Score → level. Boundaries: <0.4 low, <0.7 medium, <0.9 high, else certain. */
export function confidenceLevel(score: number): ConfidenceLevel {
  if (!Number.isFinite(score)) return "medium";
  if (score < 0.4) return "low";
  if (score < 0.7) return "medium";
  if (score < 0.9) return "high";
  return "certain";
}

export function isConfidenceLevel(v: unknown): v is ConfidenceLevel {
  return typeof v === "string" && (CONFIDENCE_LEVELS as readonly string[]).includes(v);
}
export function isSourceType(v: unknown): v is SourceType {
  return typeof v === "string" && (SOURCE_TYPES as readonly string[]).includes(v);
}
export function isSensitivity(v: unknown): v is Sensitivity {
  return typeof v === "string" && (SENSITIVITIES as readonly string[]).includes(v);
}

/**
 * Normalize a confidence given as a level ("high"), a number (0..1) or a
 * numeric string. Returns null when it can't be parsed.
 */
export function parseConfidence(v: unknown): { level: ConfidenceLevel; score: number } | null {
  if (v === undefined || v === null || v === "") return null;
  if (isConfidenceLevel(v)) return { level: v, score: CONFIDENCE_LEVEL_SCORE[v] };
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 1) return null;
  return { level: confidenceLevel(n), score: Math.round(n * 1000) / 1000 };
}

/**
 * Infer source_type for a write that didn't say. Used by writeNode:
 *   • engine writers ("system:*", sws/nexus/rem/compaction sources) → inference
 *   • seeds ("seed:*", brain_manager) → seed
 *   • llm_extraction → user (facts extracted from conversation turns)
 *   • a writer that is NOT the brain's own agent → agent
 *   • otherwise (the agent's own brain_write) → self_observation
 */
export function inferSourceType(opts: { source?: string | null; writerAgentId?: string | null; brainAgentId?: string }): SourceType {
  const src = (opts.source ?? "").toLowerCase();
  const writer = opts.writerAgentId ?? null;
  if ((writer && writer.startsWith("system:")) || ["sws", "nexus", "rem", "rem-generative", "compaction", "awake-replay"].includes(src)) return "inference";
  if (src.startsWith("seed") || src === "brain_manager") return "seed";
  if (src === "llm_extraction" || src === "extraction") return "user";
  if (src === "tool") return "tool";
  if (writer && opts.brainAgentId && writer !== opts.brainAgentId) return "agent";
  return "self_observation";
}

// ─── time ──────────────────────────────────────────────────────────────────

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "just now", "5 min ago", "3 h ago", "yesterday", "3 days ago", "2 weeks ago", "4 months ago", "2 years ago". */
export function relativeTime(ts: number | null | undefined, now: number = Date.now()): string {
  if (ts === null || ts === undefined || !Number.isFinite(ts)) return "unknown time";
  const d = now - ts;
  if (d < 0) {
    const f = -d;
    if (f < HOUR) return `in ${Math.max(1, Math.round(f / MIN))} min`;
    if (f < DAY) return `in ${Math.round(f / HOUR)} h`;
    return `in ${Math.round(f / DAY)} days`;
  }
  if (d < MIN) return "just now";
  if (d < HOUR) return `${Math.round(d / MIN)} min ago`;
  if (d < DAY) return `${Math.round(d / HOUR)} h ago`;
  const days = Math.floor(d / DAY);
  if (days === 1) return "yesterday";
  if (days < 14) return `${days} days ago`;
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  if (days < 730) return `${Math.round(days / 30)} months ago`;
  return `${Math.round(days / 365)} years ago`;
}

/**
 * Parse an `as_of` value: epoch ms (number or numeric string), an ISO date /
 * datetime, "now", "yesterday", or "<n> <unit>(s) ago" (min, hour, day, week,
 * month, year). Returns epoch ms, or null if unparseable.
 */
export function parseAsOf(v: unknown, now: number = Date.now()): number | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  const s = String(v).trim().toLowerCase();
  if (/^\d{10,}$/.test(s)) return Number(s);
  if (s === "now") return now;
  if (s === "yesterday") return now - DAY;
  const m = /^(\d+(?:\.\d+)?)\s*(min(?:ute)?s?|h(?:ours?|rs?)?|days?|d|weeks?|w|months?|years?|y)\s+ago$/.exec(s);
  if (m) {
    const n = Number(m[1]);
    const u = m[2]!;
    const unit = u.startsWith("min") ? MIN
      : u.startsWith("h") ? HOUR
      : u.startsWith("d") ? DAY
      : u.startsWith("w") ? 7 * DAY
      : u.startsWith("mo") ? 30 * DAY
      : 365 * DAY;
    return now - n * unit;
  }
  const t = Date.parse(String(v).trim());
  return Number.isFinite(t) ? t : null;
}

/**
 * Compact belief tag for recall / injection lines, e.g. "3 days ago · low (?)".
 * Pieces are dropped when they carry no signal (medium/high confidence adds no
 * marker; only low gets "(?)" and contradicted gets "disputed").
 */
export function beliefTag(
  n: { created_at?: number; confidence?: string | null; confidence_score?: number | null; contradicted_at?: number | null; sensitivity?: string | null; source_type?: string | null },
  opts: { now?: number; relativeTime?: boolean; lowThreshold?: number } = {},
): string {
  const parts: string[] = [];
  if (opts.relativeTime !== false && n.created_at) parts.push(relativeTime(n.created_at, opts.now));
  const low = opts.lowThreshold ?? 0.4;
  const score = typeof n.confidence_score === "number" ? n.confidence_score : null;
  if ((score !== null && score < low) || (score === null && n.confidence === "low")) parts.push("low confidence (?)");
  if (n.contradicted_at) parts.push("disputed");
  if (n.sensitivity === "confirm_before_acting") parts.push("confirm before acting");
  else if (n.sensitivity === "sensitive") parts.push("sensitive");
  return parts.join(" · ");
}
