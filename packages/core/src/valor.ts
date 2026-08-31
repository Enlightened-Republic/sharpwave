// ──────────────────────────────────────────────────────────────────────────
// VALOR — Value-Of-Recall utility gating (2026-07-13)
//
// Sources: Anderson & Schooler 1991 (rational analysis of memory — retrieval
// odds should track need probability learned from usage history; ACT-R
// utility learning) + Lisman & Grace 2005 (VTA-hippocampal loop — reward
// signals gate what persists).
//
// Superbrain deviation: humans cannot audit which retrieved memories actually
// informed behavior. We CAN — the assistant reply is observable text. Every
// prompt injection is a spend (context tokens); a node that keeps getting
// injected but never shapes the reply is a bad trade. VALOR measures per-node
// injection payoff and folds it into recall ranking:
//
//   utility  = (inject_hits + 1) / (inject_count + 2)     Laplace-smoothed
//   factor   = 0.5 + utility                              range (0.5, 1.5)
//
// New nodes score exactly 1.0 (neutral). A node injected 10× and never used
// sinks to ×0.58; a node used every time rises to ×1.42. identity/goal nodes
// are exempt (factor 1.0): they are structurally injected via the self-model
// header and rarely quoted verbatim — chronic-miss demotion there would be
// pathological (same reasoning as the Phase-18 SYNAPSE/ARIA immunity).
//
// Fail-safe accounting: inject_count and inject_hits are only written when
// BOTH sides of a turn were observed (injection recorded AND llm_output
// fired). If the reply hook is dropped/timed out, nothing is counted, so a
// broken delivery pipeline cannot silently demote the whole brain.
// ──────────────────────────────────────────────────────────────────────────

import { getDb } from "./db.js";
import { touchNode } from "./nodes.js";
import type { NodeType } from "./types.js";

interface PendingInjection {
  agentId: string;
  entries: Array<{ id: string; label: string; content: string }>;
  ts: number;
}

// Keyed `${agentId}|${sessionId}`. Bounded: stale records evicted at insert.
const pending = new Map<string, PendingInjection>();
const PENDING_TTL_MS = 15 * 60 * 1000;
const PENDING_MAX = 64;

// Types that are structurally injected and must never be utility-demoted.
const VALOR_EXEMPT: ReadonlySet<string> = new Set(["identity", "goal"]);

const STOPWORDS = new Set([
  "this", "that", "these", "those", "with", "from", "have", "has", "had",
  "was", "were", "been", "being", "will", "would", "could", "should",
  "about", "into", "over", "under", "again", "then", "than", "when",
  "what", "which", "while", "where", "your", "their", "there", "here",
  "just", "very", "more", "most", "some", "such", "only", "also", "does",
  "doing", "because", "before", "after", "between", "through", "during",
]);

function significantTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const t of text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)) {
    if (t.length >= 4 && !STOPWORDS.has(t)) out.add(t);
  }
  return out;
}

/**
 * Heuristic: did the reply actually use this node? True when (a) the full
 * label appears verbatim, (b) ≥50% of the label's significant tokens appear
 * in the reply, or (c) ≥40% of the injected content slice's tokens appear.
 * Thresholds calibrated in stress-test Phase 26 against realistic strings.
 */
export function isNodeUsed(reply: string, label: string, content: string): boolean {
  const replyLower = reply.toLowerCase();
  if (label.length >= 6 && replyLower.includes(label.toLowerCase())) return true;

  const replyTokens = significantTokens(reply);
  if (replyTokens.size === 0) return false;

  const labelTokens = significantTokens(label);
  if (labelTokens.size > 0) {
    let hit = 0;
    for (const t of labelTokens) if (replyTokens.has(t)) hit++;
    if (hit / labelTokens.size >= 0.5) return true;
  }

  const contentTokens = significantTokens(content.slice(0, 200));
  if (contentTokens.size >= 3) {
    let hit = 0;
    for (const t of contentTokens) if (replyTokens.has(t)) hit++;
    if (hit / contentTokens.size >= 0.4) return true;
  }
  return false;
}

/** Ranking multiplier. Exempt types return exactly 1.0. */
export function valorFactor(injectHits: number, injectCount: number, type: NodeType | string): number {
  if (VALOR_EXEMPT.has(type)) return 1.0;
  const hits = Math.max(0, injectHits || 0);
  const count = Math.max(hits, injectCount || 0);
  return 0.5 + (hits + 1) / (count + 2);
}

/** Called by buildRecallContext with the nodes it actually injected. */
export function recordInjection(
  agentId: string,
  sessionId: string,
  nodes: Array<{ id: string; label: string; content: string }>,
): void {
  if (nodes.length === 0) return;
  const now = Date.now();
  // Evict stale + oldest-over-cap so an idle gateway never grows this map.
  for (const [k, v] of pending) {
    if (now - v.ts > PENDING_TTL_MS) pending.delete(k);
  }
  while (pending.size >= PENDING_MAX) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
  pending.set(`${agentId}|${sessionId}`, {
    agentId,
    entries: nodes.map((n) => ({ id: n.id, label: n.label, content: n.content.slice(0, 200) })),
    ts: now,
  });
}

/**
 * Called from the llm_output hook. Pops the pending injection for this
 * session (if any, within TTL) and writes counters in one transaction.
 * Hits additionally get a small eligibility_trace reward (VTA analog).
 */
export function scoreReplyAgainstInjections(
  agentId: string,
  sessionId: string,
  replyText: string,
): { scored: number; hits: number; reviewed: number } | null {
  const key = `${agentId}|${sessionId}`;
  const rec = pending.get(key);
  if (!rec) return null;
  pending.delete(key);
  if (Date.now() - rec.ts > PENDING_TTL_MS) return null;
  if (!replyText.trim()) return null;

  const db = getDb(agentId);
  const missStmt = db.prepare(
    "UPDATE nodes SET inject_count = inject_count + 1 WHERE id = ?"
  );
  const hitStmt = db.prepare(
    "UPDATE nodes SET inject_count = inject_count + 1, inject_hits = inject_hits + 1, " +
    "eligibility_trace = MIN(1.0, eligibility_trace + 0.1) WHERE id = ?"
  );

  let hits = 0;
  const hitIds: string[] = [];
  db.transaction(() => {
    for (const e of rec.entries) {
      if (isNodeUsed(replyText, e.label, e.content)) {
        hitStmt.run(e.id);
        hitIds.push(e.id);
        hits++;
      } else {
        missStmt.run(e.id);
      }
    }
  })();

  // VALOR -> FSRS (2026-07-31). This is the brain's ONLY automatic learning
  // signal, and until now it was not connected to anything that learns.
  //
  // The Fable-5 F-2 audit was right to strip the old blanket touchNode(q=4)
  // from passive recall: surfacing a node is not evidence it was remembered,
  // and reviewing on mere retrieval ratcheted every node toward the 365-day
  // stability cap. But F-2 then reserved FSRS for "explicit brain_review
  // calls, which carry actual recall-quality evidence" — and brain_review is a
  // tool the agent must choose to invoke. It chose to once. Measured
  // 2026-07-31: 1 reviewed node out of 1,670 (0.1%). The learning loop had
  // therefore never run, which is the mechanical reason the brain accumulated
  // 182 nodes/day yet never got better at recalling any of them.
  //
  // A VALOR hit IS the recall-quality evidence F-2 asked for, and it is
  // strictly stronger than what brain_review supplies: the node was injected
  // AND its content demonstrably shaped the reply. That is a successful
  // retrieval, observed rather than self-reported.
  //
  // Only HITS review. A miss is ambiguous — it usually means "not relevant to
  // this turn", not "forgotten" — and scoring it as an FSRS lapse would shred
  // the stability of correct-but-off-topic memories. Misses are already
  // handled, in the right place: valorFactor() demotes them in RANKING, and
  // retrievability decays with time on its own. Ranking penalty and memory
  // strength stay separate concerns.
  //
  // Self-limiting by construction: FSRS's success formula is gated on
  // pre-review retrievability, so a node used on consecutive turns has
  // rPre ~= 1.0 and gains almost nothing. This is exactly the runaway the old
  // q=4-on-every-recall path lacked a brake for.
  for (const id of hitIds) {
    try {
      touchNode(agentId, id, 4);
    } catch {
      // Never let a review failure lose the counter updates already committed.
    }
  }

  return { scored: rec.entries.length, hits, reviewed: hitIds.length };
}

/** Test/diagnostic hook — clears in-memory pending state. */
export function clearPendingInjections(): void {
  pending.clear();
}
