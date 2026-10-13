/**
 * Xanima 0.3.0: small helpers shared by reflection / open items / plans / meta-tools.
 */
import { getDb } from "./db.js";
import { resolveNodeId, resolveGoalCurrent } from "./decisions.js";

export const DAY = 86_400_000;
export const HOUR = 3_600_000;

export const clean = (s: unknown, max: number): string => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "");
export const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
export const strArr = (v: unknown): string[] | undefined =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : typeof v === "string" && v.trim() ? [v] : undefined;

export function safeJsonArr<T = string>(s: string | null | undefined): T[] {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? (v as T[]) : []; } catch { return []; }
}

/** Cut to `max` chars on a line boundary, with an explicit "(+N more …)" marker. */
export function capLines(lines: string[], max: number): string {
  const out: string[] = [];
  let n = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const last = i === lines.length - 1;
    if (n + l.length + 1 > (last ? max : max - 90)) {
      const rest = lines.length - i;
      out.push(`… (+${rest} more line${rest === 1 ? "" : "s"}; narrow the query or raise metaToolMaxChars)`);
      break;
    }
    out.push(l);
    n += l.length + 1;
  }
  return out.join("\n");
}

/**
 * Parse a due / since / until value: epoch ms, ISO date(time), "now", "today",
 * "tomorrow", "yesterday", "in N <unit>", "N <unit> ago" (min, h, day, week, month).
 */
export function parseWhen(v: unknown, now = Date.now()): number | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "number") return Number.isFinite(v) && v > 0 ? v : null;
  const s = String(v).trim().toLowerCase();
  if (/^\d{10,}$/.test(s)) return Number(s);
  if (s === "now" || s === "today") return now;
  if (s === "tomorrow") return now + DAY;
  if (s === "yesterday") return now - DAY;
  const unit = (u: string) => (u.startsWith("min") ? 60_000 : u.startsWith("h") ? HOUR : u.startsWith("w") ? 7 * DAY : u.startsWith("mo") ? 30 * DAY : DAY);
  const fut = /^in\s+(\d+(?:\.\d+)?)\s*(min(?:ute)?s?|h(?:ours?|rs?)?|days?|d|weeks?|w|months?)$/.exec(s);
  if (fut) return now + Number(fut[1]) * unit(fut[2]!);
  const past = /^(\d+(?:\.\d+)?)\s*(min(?:ute)?s?|h(?:ours?|rs?)?|days?|d|weeks?|w|months?)\s+ago$/.exec(s);
  if (past) return now - Number(past[1]) * unit(past[2]!);
  const t = Date.parse(String(v).trim());
  return Number.isFinite(t) ? t : null;
}

/** A goal (lineage / node id / prefix → current goal node) or any node id / 8+ char prefix. */
export function resolveRef(agentId: string, ref: string): { id: string; type: string; label: string } | null {
  const g = resolveGoalCurrent(agentId, ref);
  const id = g ? g.node_id : resolveNodeId(agentId, ref);
  if (!id) return null;
  const n = getDb(agentId).prepare("SELECT id, type, label FROM nodes WHERE id = ?").get(id) as { id: string; type: string; label: string } | undefined;
  return n ?? null;
}

/** Sentences of an assistant message with code, quoted spans and block quotes removed. */
export function sentencesOf(text: string): string[] {
  const stripped = text.replace(/```[\s\S]*?```/g, " ").replace(/`[^`]*`/g, (m) => m.slice(1, -1))
    .replace(/"[^"\n]{0,400}"|“[^”\n]{0,400}”|«[^»\n]{0,400}»/g, " … ");
  return stripped.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s && !s.startsWith(">"));
}

export const ago = (ts: number | null | undefined, now = Date.now()): string => {
  if (!ts) return "never";
  const d = now - ts;
  if (d < 0) { const f = -d; return f < HOUR ? `in ${Math.max(1, Math.round(f / 60_000))} min` : f < DAY ? `in ${Math.round(f / HOUR)} h` : `in ${Math.round(f / DAY)} days`; }
  if (d < 60_000) return "just now";
  if (d < HOUR) return `${Math.round(d / 60_000)} min ago`;
  if (d < DAY) return `${Math.round(d / HOUR)} h ago`;
  const days = Math.floor(d / DAY);
  return days === 1 ? "yesterday" : `${days} days ago`;
};
