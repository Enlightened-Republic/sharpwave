/**
 * Episode lane classification.
 *
 * Episodes are stored keyed by the host session key, and several very different
 * kinds of traffic share one agent's episode log:
 *
 *   agent:main:main                          the actual conversation
 *   agent:main:telegram:slash:<chatId>       user-issued slash commands
 *   agent:main:main:heartbeat                background heartbeat runs
 *   agent:main:cron:<jobId>:run:<runId>      scheduled cron runs
 *
 * The `[BRAIN: last 24h activity]` block in before_prompt_build renders assistant
 * rows as `you:` with no timestamp and no lane tag, so background-lane output is
 * indistinguishable from things the agent said to the user a moment ago.
 *
 * Background lanes can massively out-produce the conversation. Measured
 * 2026-07-30: 34 heartbeat episodes vs 14 main-chat in one 24h window, and while
 * the heartbeat was stuck re-running its rotation, 5 of the 8 injected lines were
 * its inner monologue ("We are in a Heartbeat direct conversation. We need to
 * execute the mandatory rotation in HEARTBEAT.md now."). The model anchors on
 * that and answers the wrong thing.
 *
 * Severity scales with background volume, so this is a latent amplifier: quiet
 * while crons/heartbeats are healthy, corrupting the moment one starts looping.
 */

export type EpisodeLane = "foreground" | "heartbeat" | "cron" | "command";

const HEARTBEAT_SUFFIX = ":heartbeat";
const CRON_SEGMENT = ":cron:";
const SLASH_SEGMENT = ":slash:";

/**
 * Classify which lane an episode's session key belongs to.
 *
 * Unknown/empty keys deliberately resolve to "foreground": the filter is used to
 * DROP context, so an unrecognised shape must fail toward keeping the episode
 * rather than silently deleting real conversation.
 */
export function classifyEpisodeLane(sessionId: string | null | undefined): EpisodeLane {
  if (!sessionId) return "foreground";
  if (sessionId.endsWith(HEARTBEAT_SUFFIX)) return "heartbeat";
  if (sessionId.includes(CRON_SEGMENT)) return "cron";
  // Slash traffic is user-initiated but is control plane ("/new", "/models"),
  // not conversation. It only became visible once short user turns floored at
  // 0.3 and started clearing the recap's >= 0.3 filter.
  if (sessionId.includes(SLASH_SEGMENT)) return "command";
  return "foreground";
}

/** True when the episode came from user-facing conversation rather than a background run. */
export function isForegroundLane(sessionId: string | null | undefined): boolean {
  return classifyEpisodeLane(sessionId) === "foreground";
}
