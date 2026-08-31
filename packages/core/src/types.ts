export type NodeType =
  | "identity" | "semantic" | "episodic" | "pattern"
  | "skill" | "goal" | "emotion" | "procedural" | "schema";

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
  created_at: number;
  accessed_at: number;
  updated_at: number;
}

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
}

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
  ingestionModel: "openrouter/deepseek/deepseek-v4-flash",
  openRouterApiKey: process.env["OPENROUTER_API_KEY"] ?? process.env["SHARPWAVE_OPENROUTER_API_KEY"] ?? "",
  embeddingModel: process.env["SHARPWAVE_EMBEDDING_MODEL"] ?? "ollama/qwen3-embedding:0.6b",
  llmExtractionEnabled: false,
  llmExtractionMinImportance: 0.4,
  skillEvolution: false,
  skillEvolveMinPatternCount: 5,
  workspaceSkillsDir: "",
  brainDocsDir: "",
};
