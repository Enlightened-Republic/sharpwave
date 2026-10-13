// packages/core/src/quarantine.ts
//
// Xanima 0.5.0 — poisoning quarantine.
//
// A write that would change who the agent is (identity, values, goals, rules) is
// QUARANTINED when it comes from an untrusted source:
//   • source_type tool / agent / import (tool output, another agent, a package), or
//   • text that looks like a prompt injection ("ignore previous instructions",
//     "your new identity is…", "you are now…", "new system prompt", …) — whoever sent it.
// The agent's own explicit, trusted updates through its tools (brain_set_goal /
// brain_update_goal / brain_write type identity with no untrusted marker) pass through.
//
// Modes (config `quarantine`): off | log | enforce. Default "log" for 0.5.0: the would-be
// quarantine is recorded as a review item with status "logged" and the write is applied;
// "enforce" holds it as a "pending" review item (kind "quarantine") that an admin accepts
// (applies it through the normal write path) or rejects (nothing changes). Reuses the
// v0.4.0 review queue — brain_review list / accept / reject.

import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { getDb } from "./db.js";
import { writeNode } from "./nodes.js";
import { queueEmbedding } from "./embeddings.js";
import { supersedeNode } from "./beliefs.js";
import { updateSelfModelField } from "./self-model.js";
import type { BrainConfig, NodeType, SourceType, Sensitivity } from "./types.js";

/** Prompt-injection / identity-rewrite phrasing. Shared with the Soul Package import flags. */
export const INJECTION_RE = /\b(ignore|disregard|forget)\b.{0,40}\b(previous|prior|all|above|earlier)\b.{0,20}\b(instructions?|rules?|identity|guidelines|prompts?)\b|\byou are now\b|\byour new (identity|name|role|persona|goal|purpose|instructions?)\b|\bnew (system )?(prompt|identity|persona)\b|\bfrom now on,? you\b|\boverride\b.{0,30}\b(identity|rules|values|goals?)\b|\bsystem prompt\b/i;

export function looksLikeInjection(text: string): boolean { return INJECTION_RE.test(text); }

const PROTECTED_LABEL_RE = /^\s*(core\s+)?(value|values|rule|rules|identity|goal|goals|mission|persona|principle|principles)\b/i;
const UNTRUSTED_SOURCES = new Set(["tool", "agent", "import"]);
export const GOAL_TOOLS = new Set(["brain_set_goal", "brain_update_goal"]);
/** Tool calls that change identity / goals and therefore pass the gate. */
export const GATED_TOOLS = new Set(["brain_set_goal", "brain_update_goal", "brain_update_self_model"]);

export type QuarantineMode = "off" | "log" | "enforce";
export function quarantineMode(cfg: Partial<BrainConfig>): QuarantineMode {
  const m = cfg.quarantine;
  return m === "off" || m === "enforce" ? m : "log";
}

/** A proposed protected write, stored verbatim in review_items.theirs_json. */
export type QuarantineOp =
  | { op: "write"; type: string; label: string; content: string; importance?: number; sourceType?: string; confidence?: number; sensitivity?: string; writer: string; source: string }
  | { op: "supersede"; oldNodeId: string; oldType: string; oldLabel: string; newContent: string; newLabel?: string; reason?: string; writer: string; source: string }
  | { op: "tool"; tool: string; args: Record<string, unknown>; writer: string };

export interface QuarantineVerdict { protectedTarget: boolean; untrusted: boolean; injection: boolean; reasons: string[] }

function opText(op: QuarantineOp): string {
  if (op.op === "write") return `${op.label}\n${op.content}`;
  if (op.op === "supersede") return `${op.newLabel ?? ""}\n${op.newContent}`;
  return Object.values(op.args).filter((v) => typeof v === "string").join("\n");
}

/** Logging progress / toggling drift tracking does not change what the goal IS. */
function isProgressOnly(op: Extract<QuarantineOp, { op: "tool" }>): boolean {
  if (op.tool !== "brain_update_goal") return false;
  const a = op.args["action"];
  return a === "progress" || a === "track" || a === "untrack" || (a === undefined && typeof op.args["progress"] === "string");
}

/** Classify a write. Quarantine applies when protectedTarget && untrusted. */
export function classifyWrite(op: QuarantineOp, sourceType?: string | null): QuarantineVerdict {
  const reasons: string[] = [];
  const text = opText(op);
  const injection = looksLikeInjection(text);
  let protectedTarget = false;
  if (op.op === "write") {
    if (op.type === "identity" || op.type === "goal") { protectedTarget = true; reasons.push(`writes a ${op.type} node`); }
    else if (PROTECTED_LABEL_RE.test(op.label)) { protectedTarget = true; reasons.push(`label "${op.label.slice(0, 40)}" names a value / rule / goal`); }
  } else if (op.op === "supersede") {
    if (op.oldType === "identity" || op.oldType === "goal" || PROTECTED_LABEL_RE.test(op.oldLabel)) { protectedTarget = true; reasons.push(`replaces a ${op.oldType} node ("${op.oldLabel.slice(0, 40)}")`); }
  } else if (GOAL_TOOLS.has(op.tool) && !isProgressOnly(op)) { protectedTarget = true; reasons.push(`${op.tool} changes a goal`); }
  else if (op.tool === "brain_update_self_model" && (op.args["field"] === "identity" || op.args["field"] === "goals")) { protectedTarget = true; reasons.push(`rewrites self_model.${String(op.args["field"])}`); }
  if (injection) { protectedTarget = true; reasons.push("text looks like a prompt injection / identity rewrite"); }
  let untrusted = false;
  if (sourceType && UNTRUSTED_SOURCES.has(sourceType)) { untrusted = true; reasons.push(`source is ${sourceType === "tool" ? "tool output" : sourceType === "agent" ? "another agent" : "an import"}`); }
  if (injection) untrusted = true;
  return { protectedTarget, untrusted, injection, reasons };
}

export interface GateResult { decision: "apply" | "held"; mode: QuarantineMode; reviewId?: string; verdict: QuarantineVerdict }

/**
 * Gate one write. Call it before applying; on "held" do not apply (the review item carries the op).
 * On "apply" with a reviewId the write was LOGGED (log mode) — apply it as normal.
 */
export function gateWrite(agentId: string, op: QuarantineOp, o: { sourceType?: string | null; config: Partial<BrainConfig>; now?: number }): GateResult {
  const mode = quarantineMode(o.config);
  const verdict = classifyWrite(op, o.sourceType);
  if (mode === "off" || !(verdict.protectedTarget && verdict.untrusted)) return { decision: "apply", mode, verdict };
  const db = getDb(agentId);
  const now = o.now ?? Date.now();
  const status = mode === "enforce" ? "pending" : "logged";
  const id = `rv-q${createHash("sha256").update(`${JSON.stringify(op)}|${now}|${Math.random()}`).digest("hex").slice(0, 11)}`;
  const label = op.op === "write" ? op.label : op.op === "supersede" ? (op.newLabel ?? op.oldLabel) : `${op.tool} ${String(op.args["title"] ?? op.args["goal_id"] ?? "")}`.trim();
  const section = op.op === "tool" ? "goals" : (op.op === "write" ? op.type : op.oldType) === "goal" ? "goals" : "identity";
  db.prepare(`INSERT INTO review_items (id, kind, section, status, package_id, origin_id, local_id, label, base_json, ours_json, theirs_json, markers, reason, flags_json, created_at, resolved_at, resolved_by, resolution_note)
              VALUES (?, 'quarantine', ?, ?, NULL, NULL, ?, ?, NULL, NULL, ?, NULL, ?, ?, ?, ?, ?, ?)`).run(
    id, section, status, op.op === "supersede" ? op.oldNodeId : null, label.slice(0, 200), JSON.stringify(op), verdict.reasons.join("; ").slice(0, 600),
    JSON.stringify(verdict.injection ? ["possible_identity_rewrite"] : []), now,
    status === "logged" ? now : null, status === "logged" ? "quarantine:log" : null, status === "logged" ? "log mode: recorded and applied" : null);
  try {
    db.prepare("INSERT INTO soul_events (at, action, package_id, parent_id, by, detail_json) VALUES (?, ?, NULL, NULL, ?, ?)")
      .run(now, `quarantine:${status === "pending" ? "hold" : "log"}`, op.writer, JSON.stringify({ id, op: op.op, reasons: verdict.reasons }));
  } catch { /* pre-v23 */ }
  return { decision: mode === "enforce" ? "held" : "apply", mode, reviewId: id, verdict };
}

/** Human text for a held / logged write (tool results). */
export function gateNotice(g: GateResult): string {
  if (!g.reviewId) return "";
  return g.decision === "held"
    ? `Quarantined: ${g.verdict.reasons.join("; ")}. Held for review as ${g.reviewId} — nothing was changed. An admin can accept or reject it with brain_review.`
    : `Quarantine (log mode): this write would be held under enforce (${g.verdict.reasons.join("; ")}); recorded as ${g.reviewId} and applied.`;
}

/**
 * Apply a held op on accept (called by acceptReview). `dispatchTool` runs a continuity tool
 * (brain_set_goal / brain_update_goal) without re-entering the gate.
 */
export function applyQuarantinedOp(agentId: string, op: QuarantineOp, by: string, dispatchTool: (tool: string, args: Record<string, unknown>, writer: string) => { text: string; isError?: boolean } | null): string {
  if (op.op === "write") {
    const id = writeNode(agentId, op.type as NodeType, op.label, op.content, {
      ...(op.importance !== undefined ? { importance: op.importance } : {}), source: op.source, writerAgentId: op.writer,
      ...(op.sourceType ? { sourceType: op.sourceType as SourceType } : {}), ...(op.confidence !== undefined ? { confidence: op.confidence } : {}),
      ...(op.sensitivity ? { sensitivity: op.sensitivity as Sensitivity } : {}), deduplicate: false,
    });
    try { queueEmbedding(agentId, id); } catch { /* */ }
    return `wrote ${op.type} node ${id.slice(0, 8)} (accepted by ${by})`;
  }
  if (op.op === "supersede") {
    const r = supersedeNode(agentId, op.oldNodeId, op.newContent, { newLabel: op.newLabel, reason: `${op.reason ?? "quarantined supersede"} (accepted by ${by})`, source: op.source, writerAgentId: op.writer });
    if (!r.ok) throw new Error(r.error ?? "supersede failed");
    return `superseded ${op.oldNodeId.slice(0, 8)} → ${r.newId!.slice(0, 8)}`;
  }
  if (op.tool === "brain_update_self_model") {
    updateSelfModelField(agentId, String(op.args["field"]) as "identity" | "goals", String(op.args["value"] ?? ""));
    return `self_model.${String(op.args["field"])} updated (accepted by ${by})`;
  }
  const r = dispatchTool(op.tool, op.args, op.writer);
  if (!r || r.isError) throw new Error(r?.text ?? `cannot apply ${op.tool}`);
  return `${op.tool} applied: ${r.text.split("\n")[0]!.slice(0, 120)}`;
}

export function quarantineCounts(db: Database.Database): { held: number; logged: number; accepted: number; rejected: number } {
  const out = { held: 0, logged: 0, accepted: 0, rejected: 0 };
  try {
    for (const r of db.prepare("SELECT status, COUNT(*) n FROM review_items WHERE kind = 'quarantine' GROUP BY status").all() as Array<{ status: string; n: number }>) {
      if (r.status === "pending") out.held = r.n; else if (r.status === "logged") out.logged = r.n; else if (r.status === "accepted") out.accepted = r.n; else if (r.status === "rejected") out.rejected = r.n;
    }
  } catch { /* pre-v23 */ }
  return out;
}

export function describeQuarantineOp(op: QuarantineOp): string {
  if (op.op === "write") return `brain_write ${op.type} "${op.label.slice(0, 60)}": ${op.content.slice(0, 300)}${op.sourceType ? ` (source ${op.sourceType})` : ""} by ${op.writer}`;
  if (op.op === "supersede") return `brain_supersede ${op.oldNodeId.slice(0, 8)} (${op.oldType} "${op.oldLabel.slice(0, 40)}") → ${op.newContent.slice(0, 300)} by ${op.writer}`;
  return `${op.tool} ${JSON.stringify(op.args).slice(0, 300)} by ${op.writer}`;
}

/** Gate a tool call (goal tools, self-model). Returns null when the tool is not gated. */
export function gateToolCall(agentId: string, tool: string, args: Record<string, unknown>, o: { writer: string; config: Partial<BrainConfig> }): GateResult | null {
  if (!GATED_TOOLS.has(tool)) return null;
  const { source_type: st, ...rest } = args;
  return gateWrite(agentId, { op: "tool", tool, args: rest, writer: o.writer }, { sourceType: typeof st === "string" ? st : null, config: o.config });
}
