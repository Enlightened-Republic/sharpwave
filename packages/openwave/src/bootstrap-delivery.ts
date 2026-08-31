/**
 * Bootstrap delivery arbitration.
 *
 * session_start enqueues the bootstrap through
 * `api.session.workflow.enqueueNextTurnInjection` and flags the session as
 * queued. before_prompt_build then deliberately skips injecting for a queued
 * session so the bootstrap is not delivered twice, on the assumption that
 * agent_turn_prepare will receive it in `event.queuedInjections` and clear the
 * flag.
 *
 * That assumption does not hold in practice. Measured on OpenClaw 2026.7.1-2
 * (gateway log, session 4229850f, same gateway process, two minutes apart):
 *
 *     11:47:49  enqueueNextTurnInjection   outcome=ok
 *     11:49:44  agent_turn_prepare         queuedCount=0  gotKeys=""
 *
 * The enqueue succeeds and the drain hands back an empty array, so the flag is
 * never cleared and before_prompt_build skips forever. Net effect: a session
 * whose first turn runs in the SAME process as its session_start receives no
 * identity, no goals and no morning brief at all. Sessions that straddle a
 * gateway restart accidentally work, because the in-memory flag is lost and
 * before_prompt_build falls through to its rebuild branch.
 *
 * The queue is therefore treated as best-effort: if the host did not hand us
 * our own injection this turn, release the guard so before_prompt_build injects
 * the cached bootstrap instead. Releasing cannot double-inject, because the
 * guard is only released when our key is absent from what the host delivered.
 */

export type BootstrapDeliveryDecision =
  /** Host delivered our bootstrap. Mark injected and drop the cache. */
  | "delivered"
  /** Host delivered nothing of ours. Clear the flag so before_prompt_build injects. */
  | "release_guard"
  /** Nothing queued and nothing delivered. */
  | "noop";

/** The idempotency key session_start enqueues under, and the drain must match. */
export function bootstrapIdempotencyKey(sessionId: string): string {
  return `openwave:bootstrap:${sessionId}`;
}

export function decideBootstrapDelivery(args: {
  sessionId: string;
  /** Whether this session is still flagged as having a queued bootstrap. */
  wasQueued: boolean;
  /** idempotencyKeys the host drained for this session this turn. */
  deliveredKeys: readonly (string | undefined)[];
}): BootstrapDeliveryDecision {
  const expected = bootstrapIdempotencyKey(args.sessionId);
  if (args.deliveredKeys.some((key) => key === expected)) return "delivered";
  return args.wasQueued ? "release_guard" : "noop";
}
