import { getDb, bumpWriteCounter } from "./db.js";
import { executeWithWalRetrySync } from "./wal-retry.js";
import type { SelfModel } from "./types.js";

export function getSelfModel(agentId: string): SelfModel {
  const db = getDb(agentId);
  return db.prepare("SELECT * FROM self_model WHERE id = 'singleton'").get() as SelfModel;
}

const ALLOWED_SELF_MODEL_FIELDS = ["identity", "goals", "user_model"] as const;
type SelfModelField = typeof ALLOWED_SELF_MODEL_FIELDS[number];

export function updateSelfModelField(
  agentId: string,
  field: SelfModelField,
  value: string,
): void {
  if (!ALLOWED_SELF_MODEL_FIELDS.includes(field)) {
    throw new Error(`Invalid self_model field: ${field}`);
  }
  const db = getDb(agentId);
  // Field is validated against an allowlist — safe to interpolate into column name
  executeWithWalRetrySync(
    db,
    (d) => {
      d.prepare(`UPDATE self_model SET ${field} = ?, updated_at = ? WHERE id = 'singleton'`)
        .run(value, Date.now());
    },
    { op: `self_model.update:${field}` },
  );
  bumpWriteCounter(db);
}

export function formatSelfModelForContext(model: SelfModel, budgetChars: number): string {
  const parts: string[] = [];

  if (model.identity) {
    parts.push(`[BRAIN: self]\n${model.identity.trim()}`);
  }

  try {
    const goals = JSON.parse(model.goals) as string[];
    if (goals.length > 0) {
      parts.push(`[BRAIN: goals]\n${goals.map((g) => `• ${g}`).join("\n")}`);
    }
  } catch { /* malformed */ }

  try {
    const userModel = JSON.parse(model.user_model) as Record<string, string>;
    const entries = Object.entries(userModel);
    if (entries.length > 0) {
      const lines = entries.map(([k, v]) => `• ${k}: ${v}`).join("\n");
      parts.push(`[BRAIN: user-model]\n${lines}`);
    }
  } catch { /* malformed */ }

  const full = parts.join("\n\n");
  if (full.length <= budgetChars) return full;
  return full.slice(0, budgetChars) + "\n[...truncated]";
}
