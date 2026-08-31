import { getRecentEpisodes } from "./episodes.js";
import { getActiveGoals } from "./nodes.js";
import { getDb } from "./db.js";
import type { BrainConfig } from "./types.js";

export interface MorningBrief {
  isMorning: boolean;
  gapHours: number;
  leftOff: string;
  overnightInsights: string[];
  todayGoals: string[];
}

export function getMorningBrief(agentId: string, _config: BrainConfig): MorningBrief | null {
  const db = getDb(agentId);
  const now = Date.now();

  const lastEp = db.prepare(
    "SELECT created_at FROM episodes ORDER BY created_at DESC LIMIT 1"
  ).get() as { created_at: number } | undefined;
  if (!lastEp) return null;

  const gapMs = now - lastEp.created_at;
  const gapHours = gapMs / (1000 * 60 * 60);

  // Wake-up brief fires whenever the gap since last session exceeds 4 hours,
  // regardless of time of day — agents come online at all hours.
  const isMorning = gapHours > 4;
  if (!isMorning) return null;

  const lastEpisodes = getRecentEpisodes(agentId, 2);
  const leftOff = [...lastEpisodes]
    .reverse()
    .map((e) => {
      const preview = e.content.slice(0, 100).replace(/\n/g, " ");
      const speaker = e.role === "user" ? "them" : "you";
      return `${speaker}: ${preview}`;
    })
    .join(" → ");

  const overnightNodes = db.prepare(`
    SELECT label, type FROM nodes
    WHERE created_at > ? AND type IN ('pattern', 'skill')
    ORDER BY created_at DESC LIMIT 4
  `).all(lastEp.created_at) as Array<{ label: string; type: string }>;

  const overnightInsights = overnightNodes.map((n) =>
    n.type === "pattern" ? `Pattern emerged: ${n.label}` : `Skill consolidated: ${n.label}`
  );

  const goals = getActiveGoals(agentId);
  const todayGoals = goals.slice(0, 3).map((g) => g.label);

  return { isMorning, gapHours, leftOff, overnightInsights, todayGoals };
}

export function formatMorningBlock(brief: MorningBrief): string {
  const hours = Math.round(brief.gapHours);
  const gapLabel = hours >= 24 ? `${Math.round(hours / 24)}d gap` : `${hours}h gap`;
  const lines: string[] = [`[waking up — ${gapLabel}]`];

  if (brief.leftOff) lines.push(`· left off: ${brief.leftOff}`);
  if (brief.todayGoals.length > 0) lines.push(`· today: ${brief.todayGoals.join(" · ")}`);
  if (brief.overnightInsights.length > 0) lines.push(`· overnight: ${brief.overnightInsights.join("; ")}`);

  return lines.join("\n");
}
