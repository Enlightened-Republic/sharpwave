import { envGet } from "./env.js";
export type NodeType =
  | "identity" | "semantic" | "episodic" | "pattern"
  | "skill" | "goal" | "emotion" | "procedural" | "schema"
  | "decision" // Xanima 0.2.0 decision ledger (structured row in `decisions`)
  // Xanima 0.3.0 (structured rows in open_items / commitments / plans / reflections)
  | "hypothesis" | "question" | "assumption" | "commitment" | "plan" | "reflection";

// EdgeType: `associates` is the canonical Hebbian/similarity edge type since
// v4.0.0 (CHANGELOG.md [4.0.0] Changed). `associated_with` is retained ONLY
// for read compatibility with legacy rows (368 live in main brain.db as of
// 2026-05-20). New writes should never emit `associated_with`; the LLM-facing
// brain_link description (tools.ts:93) has been pruned to enforce this.
export type EdgeType =
  | "caused_by" | "associates" | "supports" | "instance_of"
  | "goal_of" | "before" | "after" | "inhibits" | "summarizes"
  | "attaches_to" | "contradicts" | "supersedes" | "coreference_of"
  | "generated_skill" | "drives"
  | "used_in" | "led_to" | "derived_from" // Xanima 0.1.0 lightweight causal links
  | "advances" | "conflicts_with_goal" // Xanima 0.2.0 decision → goal
  | "reflects_on" | "about" | "blocked_by" | "evidence_for" | "evidence_against" // Xanima 0.3.0
  | "imported_from" // Xanima 0.4.0 soul package provenance
  | "associated_with"; // legacy — read only

export interface BrainNode {
  id: string;
  type: NodeType;
  label: string;
  content: string;
  importance: number;
  salience: number;
  stability: number;
  retrievability: number;
  ef: number;
  access_count: number;
  emotional_weight: number;
  episode_ids: string | null;
  source: string | null;
  embedding: Buffer | null;
  encoding_context: string | null;
  extraction_confidence: number;
  ripple_count: number;
  eligibility_trace: number;
  // FSRS-6 columns (v12). `ef` and `stability` are kept for backcompat read; new
  // code uses `difficulty` + reinterpreted `stability` per the DSR model.
  difficulty: number;
  last_review: number | null;
  review_count: number;
  // CLS two-store split (v13). 0 = hippocampal-analog (fast/sparse/high-decay);
  // 1 = cortical-analog (slow/dense/low-decay).
  is_consolidated: number;
  consolidated_at: number | null;
  // Pattern separation hash (v14). Top-K=32 sparse projection of embedding,
  // packed as a 4-byte blob. Used by entity-resolution as a Hamming-distance pre-filter.
  ps_hash: Buffer | null;
  valid_from: number | null;
  valid_until: number | null;
  // SIGMA per-node FSRS calibration (v16). review_history is a JSON array of
  // {t,g,r,s,d} entries; stability_sigma is the fitted multiplier (default 1.0).
  review_history: string | null;
  stability_sigma: number;
  // VALOR injection counters (v17). inject_count = times this node was placed in
  // a prompt; inject_hits = times the reply that followed actually used it.
  inject_count: number;
  inject_hits: number;
  // Provenance (v18). Who created this node: an agent id, or a "system:*" value
  // for engine-internal writers (SYSTEM_SLEEP_WRITER for consolidation). NULL on
  // rows written before v18 — see db.ts v18 migration for why there is no backfill.
  writer_agent_id: string | null;
  // ── Belief metadata (v19, Xanima 0.1.0) ──────────────────────────────────
  // How sure the brain is (discrete level + numeric score), where the belief
  // came from, when it was last verified / contradicted, what supports it, and
  // whether it is still current. Existing rows read source_type='legacy',
  // confidence='medium' / 0.6, status='active' (see db.ts v19).
  confidence?: ConfidenceLevel;
  confidence_score?: number;
  source_type?: SourceType;
  verified_at?: number | null;
  contradicted_at?: number | null;
  /** JSON array of supporting episode / node ids. */
  evidence?: string | null;
  status?: BeliefStatus;
  /** Why the node was retracted / superseded (free text). */
  status_reason?: string | null;
  status_changed_at?: number | null;
  sensitivity?: Sensitivity;
  /** Xanima 0.5.0 (v24): JSON list of project / category tags. */
  scope_tags?: string | null;
  /** Set by sleep when the node needs review (low confidence / contradicted). Exempts it from pruning. */
  review_flagged_at?: number | null;
  created_at: number;
  accessed_at: number;
  updated_at: number;
}

/** Discrete confidence levels, lowest to highest. */
export type ConfidenceLevel = "low" | "medium" | "high" | "certain";
export const CONFIDENCE_LEVELS: readonly ConfidenceLevel[] = ["low", "medium", "high", "certain"];

/** Where a belief came from. `legacy` = written before Xanima 0.1.0 (unknown origin). */
export type SourceType = "user" | "self_observation" | "inference" | "tool" | "agent" | "seed" | "legacy" | "import";
export const SOURCE_TYPES: readonly SourceType[] = ["user", "self_observation", "inference", "tool", "agent", "seed", "legacy", "import"];

/** Lifecycle of a belief. Only `active` nodes are recalled or injected. */
export type BeliefStatus = "active" | "superseded" | "retracted" | "archived" | "dormant";
export const BELIEF_STATUSES: readonly BeliefStatus[] = ["active", "superseded", "retracted", "archived"];

/** `confirm_before_acting`: shown with a marker; the agent should check before acting on it. */
export type Sensitivity = "normal" | "sensitive" | "confirm_before_acting";
export const SENSITIVITIES: readonly Sensitivity[] = ["normal", "sensitive", "confirm_before_acting"];

export interface BrainEdge {
  id: string;
  from_id: string;
  to_id: string;
  type: EdgeType;
  weight: number;
  valid_from: number;
  valid_until: number | null;
  learned_at: number;
  created_at: number;
  meta: string | null;
  /** Provenance (v18) — see BrainNode.writer_agent_id. */
  writer_agent_id?: string | null;
}

export interface Episode {
  id: string;
  session_id: string;
  role: "user" | "assistant" | "tool";
  content: string;
  importance: number;
  tokens: number;
  ripple_count: number;
  created_at: number;
  meta: string | null;
  /** Provenance (v18) — see BrainNode.writer_agent_id. */
  writer_agent_id?: string | null;
}

/**
 * writer_agent_id stamped on nodes/edges created by sleep-style consolidation
 * (SWS extraction, NEXUS schemas, REM patterns, contradiction edges). These are
 * derived by the engine, not asserted by any one agent — in a shared brain the
 * sleep cycle is a system process — so they are attributed to the system rather
 * than to whichever agent's turn happened to trigger consolidation.
 */
export const SYSTEM_SLEEP_WRITER = "system:sleep";

export interface SelfModel {
  id: string;
  identity: string;
  goals: string;
  user_model: string;
  created_at: number;
  updated_at: number;
}

export interface ActivatedNode extends BrainNode {
  activation: number;
}

export interface NeuromodState {
  dopamine: number;
  serotonin: number;
  acetylcholine: number;
  norepinephrine: number;
  interpretation: string;
}

export interface BrainConfig {
  contextBudget: number;
  workingMemorySlots: number;
  spreadingActivationHops: number;
  activationThreshold: number;
  inhibitionStrength: number;
  recallTopK: number;
  bootstrapTopK: number;
  efDefault: number;
  retrievabilityFloor: number;
  consolidationTimeGateHours: number;
  consolidationEpisodeGate: number;
  pruneAfterDays: number;
  /**
   * What sleep's Deep phase does with memories whose retrievability has decayed
   * to nothing (< 0.01, no live links; old episodic < 0.05 past pruneAfterDays).
   *   "dormant" (default): keep the row; mark it dormant and take it out of
   *     recall ranking. A dormant memory comes back when the agent searches for
   *     it (brain_query include_dormant) — forgetting is a retrieval failure,
   *     not erasure.
   *   "delete": the pre-0.6 behaviour — physically delete the row.
   */
  forgetting: "dormant" | "delete";
  ingestionModel: string;
  remModel?: string;
  openRouterApiKey: string;
  embeddingModel: string;
  llmExtractionEnabled: boolean;
  llmExtractionMinImportance: number;
  // Compat fields used by some engine paths
  skillEvolution: boolean;
  skillEvolveMinPatternCount: number;
  workspaceSkillsDir: string;
  brainDocsDir: string;
  // ── Xanima 0.1.0 feature flags (all optional; defaults below) ────────────
  /** Belief metadata on writes + labels on recall (confidence, retracted/superseded exclusion). Default true. */
  beliefMetadata?: boolean;
  /** brain_status self-summary + a one-line status footer on injection when something needs attention. Default true. */
  selfStatus?: boolean;
  /** "3 days ago" labels on recall and injection. Default true. */
  relativeTimeLabels?: boolean;
  /** Numeric confidence below which a node counts as low-confidence (marked "(?)" and flagged by sleep). Default 0.4. */
  lowConfidenceThreshold?: number;
  /** Sleep pass that flags low-confidence / contradicted nodes for review (and protects them from pruning). Default true. */
  sleepBeliefReview?: boolean;
  // ── Xanima 0.2.0 continuity flags (all heuristic; no LLM needed) ─────────
  /** Decision ledger tools + decision recall boost + sleep decision pass. Default true. */
  decisionLedger?: boolean;
  /** Draft low-confidence decisions from the agent's own "I'll go with X over Y because…" text. Default true. */
  decisionAutoExtract?: boolean;
  /** Promote recurring / high-value lessons from resolved decisions to skill nodes during sleep. Default false. */
  decisionLessonPromotion?: boolean;
  /** Activation multiplier for decision nodes that match the current context. Default 1.2. */
  decisionBoost?: number;
  /** Drift check against active tracked goals: "sleep" (during consolidation, default), "daily" (at most once a day, at turn time), "off". */
  intentDriftCheck?: "off" | "daily" | "sleep";
  /** Days without progress before a goal counts as drifting. Default 7. */
  driftDays?: number;
  /** Time / keyword triggers that surface a goal when relevant. Default true. */
  goalTriggers?: boolean;
  /** Token cap for the injected alignment note + goal trigger lines. Default 60 (~240 chars). */
  alignmentNoteMaxTokens?: number;
  /** Days before an unconfirmed, unlinked, outcome-less auto-extracted decision draft expires (soft-retired by sleep). Default 14. */
  decisionDraftTtlDays?: number;
  /** Cosine similarity at/above which a new lesson merges into an existing skill (embedding path). Default 0.86. */
  lessonMergeSimilarity?: number;
  // ── Xanima 0.3.0: reflection, open items, commitments, plans, meta-tools ──
  /** Sleep reflection phase: "sleep" writes a templated what-worked / what-didn't / try-next reflection from recent outcomes. Default "off". */
  reflection?: "off" | "sleep";
  /** Use the LLM to phrase reflections (opt-in; falls back to the template). Default false. */
  reflectionLlm?: boolean;
  /** Window a reflection looks back over when no since/until is given. Default 7 days. */
  reflectionWindowDays?: number;
  /** Capture "I think … because …", "open question: …", "assuming …" from the agent's own replies as drafts. Default true. */
  openItemCapture?: boolean;
  /** Days before an unconfirmed captured hypothesis / question / assumption draft expires (soft). Default 14. */
  openItemDraftTtlDays?: number;
  /** Surface one relevant open question / hypothesis per turn when the prompt matches it (6 h cooldown each). Default true. */
  openItemSurfacing?: boolean;
  /** One-line nudge for overdue / blocked commitments (consumed only by a real reply). Default true. */
  commitmentNudges?: boolean;
  /** Character cap for brain_replay output. Default 1600. */
  replayMaxChars?: number;
  /** Character cap for brain_changes / brain_conflicts / brain_briefing / brain_forget_impact output. Default 2400. */
  metaToolMaxChars?: number;
  // ── Xanima 0.4.0 Soul Package ──
  /** Default export profile. Default "compact". */
  soulExportProfile?: "compact" | "full";
  /** Token budget (≈ chars / 4) for a compact package's content. Default 2000. */
  soulTokenBudget?: number;
  /** Facts below this confidence score are left out of a package. Default 0.6. */
  soulMinFactConfidence?: number;
  /** Confidence score cap for imported memories (original kept in soul_provenance). Default 0.5. */
  soulImportConfidence?: number;
  /** Three-way merge: apply theirs-only changes to skills / facts / lessons (as supersede, history kept). Identity, values and goals always go to review. Default true. */
  soulMergeApplyTheirs?: boolean;
  /** xanima-server backup now: also write a compact soul package next to each private-brain snapshot. Default false. */
  soulPackageOnExport?: boolean;
  // ── Xanima 0.5.0 rooms, injection control, quarantine ──
  /** Rooms (named shared namespaces with members) on the brain service. Default true (no room exists until an admin creates one). */
  rooms?: boolean;
  /** Max subscribed-room items added to a turn's recall (tagged [type·room·writer]). Default 3. */
  roomRecallMax?: number;
  /** Which injection categories are on. Header = identity / goals / rules (always-on); recall = selective. Defaults: all true, sensitive "relevant". */
  injectionCategories?: InjectionCategories;
  /** brain_focus default lifetime in turns when ttl is omitted. Default 3. */
  focusDefaultTtl?: number;
  /** Poisoning quarantine for identity / value / goal / rule writes from untrusted sources: off | log (record, still apply) | enforce (hold for review). Default "log". */
  quarantine?: "off" | "log" | "enforce";
  /** Agent-evolved identity (brain_identity): locked fields (default ["Name"]), rate limit, size caps. See identity.ts. */
  /** brain_identity guardrails; each is one switch (see identity.ts). */
  identity?: { selfEdit?: boolean; refuseUntrusted?: boolean; saveRefusedAsNote?: boolean; locked?: string[]; maxChangesPerDay?: number; maxChars?: number; requireAttestation?: boolean; changesFrom?: Array<"owner_turn" | "reflection" | "agent_turn"> };
}

export interface InjectionCategories {
  /** Header: the brain's identity line. */
  identity?: boolean;
  /** Header: active goals / alignment notes. */
  goals?: boolean;
  /** Header: operational rules (procedural block). */
  rules?: boolean;
  /** Selective recall block. */
  recall?: boolean;
  /** Decision nodes inside recall. */
  decisions?: boolean;
  /** Subscribed room items inside recall. */
  rooms?: boolean;
  /** Sensitive items: "relevant" (only when the turn names their topic), "never", or "always". */
  sensitive?: "relevant" | "never" | "always";
}

export const DEFAULT_CONFIG: BrainConfig = {
  contextBudget: 2000,
  workingMemorySlots: 7,
  spreadingActivationHops: 1,
  activationThreshold: 0.1,
  inhibitionStrength: 0.6,
  recallTopK: 10,
  bootstrapTopK: 15,
  efDefault: 2.5,
  retrievabilityFloor: 0.05,
  consolidationTimeGateHours: 4,
  consolidationEpisodeGate: 10,
  pruneAfterDays: 90,
  forgetting: "dormant",
  ingestionModel: "openrouter/deepseek/deepseek-v4-flash",
  openRouterApiKey: process.env["OPENROUTER_API_KEY"] ?? envGet("OPENROUTER_API_KEY") ?? "",
  embeddingModel: envGet("EMBEDDING_MODEL") ?? "ollama/qwen3-embedding:0.6b",
  llmExtractionEnabled: false,
  llmExtractionMinImportance: 0.4,
  skillEvolution: false,
  skillEvolveMinPatternCount: 5,
  workspaceSkillsDir: "",
  brainDocsDir: "",
  beliefMetadata: true,
  selfStatus: true,
  relativeTimeLabels: true,
  lowConfidenceThreshold: 0.4,
  sleepBeliefReview: true,
  decisionLedger: true,
  decisionAutoExtract: true,
  decisionLessonPromotion: false,
  decisionBoost: 1.2,
  intentDriftCheck: "sleep",
  driftDays: 7,
  goalTriggers: true,
  alignmentNoteMaxTokens: 60,
  decisionDraftTtlDays: 14,
  reflection: "off",
  reflectionLlm: false,
  reflectionWindowDays: 7,
  openItemCapture: true,
  openItemDraftTtlDays: 14,
  openItemSurfacing: true,
  commitmentNudges: true,
  replayMaxChars: 1600,
  metaToolMaxChars: 2400,
  soulExportProfile: "compact",
  soulTokenBudget: 2000,
  soulMinFactConfidence: 0.6,
  soulImportConfidence: 0.5,
  soulMergeApplyTheirs: true,
  soulPackageOnExport: false,
  rooms: true,
  roomRecallMax: 3,
  injectionCategories: { identity: true, goals: true, rules: true, recall: true, decisions: true, rooms: true, sensitive: "relevant" },
  focusDefaultTtl: 3,
  quarantine: "log",
  lessonMergeSimilarity: 0.86,
};
