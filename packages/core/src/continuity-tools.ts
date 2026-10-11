/**
 * Xanima 0.2.0 continuity tools: decision ledger + goals. One definition and
 * one dispatcher shared by the MCP server, the OpenClaw plugin (local mode)
 * and xanima-server (which calls it on the caller's private brain).
 */
import type { BrainConfig } from "./types.js";
import {
  recordDecision, updateDecisionOutcome, queryDecisions, formatDecision, OUTCOME_STATUSES, type OutcomeStatus,
} from "./decisions.js";
import {
  setGoal, updateGoal, listGoals, goalHistory, formatGoal, formatGoalHistory, GOAL_ACTIONS, GOAL_STATUSES,
  type GoalAction, type TriggerSpec, type GoalStatus,
} from "./goals.js";

export interface ContinuityToolDef { description: string; inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] } }
export interface ContinuityResult { text: string; isError?: boolean }

const ok = (text: string): ContinuityResult => ({ text });
const err = (text: string): ContinuityResult => ({ text: `Error: ${text}`, isError: true });

const PRIORITY = { type: ["string", "number"], description: "1..5 (1 = highest) or critical | high | medium | low | someday. Default 3 / medium." };
const TRIGGERS = {
  type: "array",
  description: 'Optional prospective triggers that surface this goal when relevant: {"kind":"keyword","keywords":["deploy"]} fires when a turn mentions a keyword (6 h cooldown); {"kind":"time","at":"2026-10-20T09:00:00Z"} or {"kind":"time","every_days":7} fires on schedule.',
  items: { type: "object", properties: { kind: { type: "string", enum: ["time", "keyword"] }, keywords: { type: "array", items: { type: "string" } }, at: { type: ["string", "number"] }, every_days: { type: "number" }, cooldown_hours: { type: "number" } }, required: ["kind"] },
};

export const CONTINUITY_TOOL_DEFS: Record<string, ContinuityToolDef> = {
  brain_record_decision: {
    description: "Record a decision in your decision ledger: the context, the options you considered (with predicted outcomes), what you chose and why, and your expected outcome. Link it to a goal it advances (or conflicts with). Later, record what actually happened with brain_update_decision_outcome — that is how you learn from it.",
    inputSchema: {
      type: "object",
      properties: {
        context: { type: "string", description: "What was being decided and why it mattered." },
        options: { type: "array", description: 'Options considered, e.g. ["Postgres => more ops work", "SQLite => simpler, single writer"] ("option => predicted outcome").', items: { type: "string" } },
        chosen: { type: "string", description: "The option you picked." },
        rationale: { type: "string", description: "Why you picked it." },
        predicted_outcome: { type: "string", description: "What you expect to happen." },
        confidence: { type: ["string", "number"], description: "How sure you are about the prediction: low | medium | high | certain or 0..1." },
        goal_id: { type: "string", description: "Goal this decision advances (id or 8+ char prefix from brain_list_goals)." },
        conflicts_with_goal_ids: { type: "array", items: { type: "string" }, description: "Goals this decision knowingly works against (shown as drift)." },
        skill_ids: { type: "array", items: { type: "string" }, description: "Skill / procedural nodes used in this decision." },
        evidence: { type: "array", items: { type: "string" }, description: "Supporting episode or node ids." },
      },
      required: ["context", "chosen"],
    },
  },
  brain_update_decision_outcome: {
    description: "Record what actually happened after a decision: the outcome, whether it matched your prediction (matched | partial | missed), and the lesson. Sleep uses this to calibrate confidence and (if enabled) promote recurring lessons to skills.",
    inputSchema: {
      type: "object",
      properties: {
        decision_id: { type: "string", description: "Decision node id (or 8+ char prefix)." },
        outcome: { type: "string", description: "What actually happened." },
        outcome_status: { type: "string", enum: OUTCOME_STATUSES, description: "Did it match the prediction?" },
        lesson: { type: "string", description: "What to do (or avoid) next time." },
      },
      required: ["decision_id", "outcome", "outcome_status"],
    },
  },
  brain_query_decisions: {
    description: "Look up past decisions (newest first, or by relevance to a query): context, options, choice, outcome and lesson. Use before a similar choice.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Optional text to match." },
        goal_id: { type: "string", description: "Only decisions linked to this goal." },
        status: { type: "string", enum: ["pending", "resolved", "all"], description: "pending = no outcome yet. Default all." },
        limit: { type: "number", description: "Max results (default 10, max 50)." },
        format: { type: "string", enum: ["text", "json"], description: "Output format (default text)." },
      },
    },
  },
  brain_set_goal: {
    description: "Create a standing goal (versioned, drift-checked): title, priority, success criteria, optional keywords and triggers. Sleep compares your recent activity and decisions against it and injects a short alignment note when you drift.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short goal statement." },
        description: { type: "string", description: "Optional detail." },
        priority: PRIORITY,
        success_criteria: { type: "string", description: "How you will know it is done." },
        keywords: { type: "array", items: { type: "string" }, description: "Words that count as progress when they show up in conversation (derived from the title if omitted)." },
        triggers: TRIGGERS,
      },
      required: ["title"],
    },
  },
  brain_update_goal: {
    description: "Change a goal with history preserved. update / supersede (new version; supersede needs a reason), pause, resume, done, archive, progress (log progress, clears drift), track / untrack (drift checking). Add triggers with any action.",
    inputSchema: {
      type: "object",
      properties: {
        goal_id: { type: "string", description: "Goal id (or 8+ char prefix) from brain_list_goals." },
        action: { type: "string", enum: GOAL_ACTIONS },
        title: { type: "string" }, description: { type: "string" }, priority: PRIORITY,
        success_criteria: { type: "string" }, keywords: { type: "array", items: { type: "string" } },
        reason: { type: "string", description: "Why (required for supersede; recorded in history)." },
        note: { type: "string", description: "Progress note (action progress)." },
        triggers: TRIGGERS,
      },
      required: ["goal_id", "action"],
    },
  },
  brain_list_goals: {
    description: "List your goals with priority, status, last progress and drift flags. Pass goal_id for one goal's full version history and triggers.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: [...GOAL_STATUSES, "all"], description: "Default active." },
        goal_id: { type: "string", description: "Show one goal with its history." },
        format: { type: "string", enum: ["text", "json"], description: "Output format (default text)." },
      },
    },
  },
};

export const CONTINUITY_TOOL_NAMES = Object.keys(CONTINUITY_TOOL_DEFS);

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const strArr = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined);

export function dispatchContinuityTool(
  name: string, agentId: string, args: Record<string, unknown>, config: Partial<BrainConfig>,
  opts: { writerAgentId?: string; now?: number } = {},
): ContinuityResult | null {
  if (!(name in CONTINUITY_TOOL_DEFS)) return null;
  if (config.decisionLedger === false && name.includes("decision")) return err("the decision ledger is disabled (decisionLedger: false)");
  const json = String(args["format"] ?? "text").toLowerCase() === "json";
  const now = opts.now;
  switch (name) {
    case "brain_record_decision": {
      if (args["options"] !== undefined && !Array.isArray(args["options"])) return err("options must be an array");
      const r = recordDecision(agentId, {
        context: str(args["context"]) ?? "", chosen: str(args["chosen"]) ?? "",
        options: args["options"] as Array<string>, rationale: str(args["rationale"]), predictedOutcome: str(args["predicted_outcome"]),
        ...(args["confidence"] !== undefined ? { confidence: args["confidence"] as number } : {}),
        goalId: str(args["goal_id"]), conflictsWithGoalIds: strArr(args["conflicts_with_goal_ids"]), skillIds: strArr(args["skill_ids"]),
        evidence: strArr(args["evidence"]), writerAgentId: opts.writerAgentId, ...(now ? { now } : {}),
      });
      if (!r.ok) return err(r.error!);
      return ok(`Recorded decision ${r.id}${r.goal ? ` (advances goal "${r.goal.title}")` : ""}${r.conflicts?.length ? ` — conflicts with: ${r.conflicts.join(", ")}` : ""}.\nRecord what happens later with brain_update_decision_outcome {"decision_id":"${r.id!.slice(0, 8)}", ...}.`);
    }
    case "brain_update_decision_outcome": {
      const st = str(args["outcome_status"]) as OutcomeStatus;
      const r = updateDecisionOutcome(agentId, str(args["decision_id"]) ?? "", { outcome: str(args["outcome"]) ?? "", status: st, lesson: str(args["lesson"]), ...(now ? { now } : {}) });
      if (!r.ok) return err(r.error!);
      return ok(`Outcome recorded (${st}).${r.goalProgress ? ` Progress logged on goal "${r.goalProgress}".` : ""}\n${formatDecision(r.decision!)}`);
    }
    case "brain_query_decisions": {
      const st = str(args["status"]) ?? "all";
      if (!["pending", "resolved", "all"].includes(st)) return err("status must be pending, resolved or all");
      const lim = args["limit"];
      if (lim !== undefined && (typeof lim !== "number" || lim < 1)) return err("limit must be a positive number");
      const rows = queryDecisions(agentId, { query: str(args["query"]), goalId: str(args["goal_id"]), status: st as "all", limit: lim as number | undefined });
      if (json) return ok(JSON.stringify({ decisions: rows }, null, 2));
      if (!rows.length) return ok("No matching decisions.");
      return ok(rows.map((d) => formatDecision(d)).join("\n\n"));
    }
    case "brain_set_goal": {
      const r = setGoal(agentId, {
        title: str(args["title"]) ?? "", description: str(args["description"]), priority: args["priority"], successCriteria: str(args["success_criteria"]),
        keywords: strArr(args["keywords"]), triggers: args["triggers"] as TriggerSpec[] | undefined, writerAgentId: opts.writerAgentId, ...(now ? { now } : {}),
      });
      if (!r.ok) return err(r.error!);
      return ok(`Goal set: ${formatGoal(r.goal!)}${r.triggers?.length ? `\n  triggers: ${r.triggers.join(", ")}` : ""}`);
    }
    case "brain_update_goal": {
      const action = str(args["action"]) as GoalAction;
      const r = updateGoal(agentId, str(args["goal_id"]) ?? "", {
        action, title: str(args["title"]), description: str(args["description"]), priority: args["priority"], successCriteria: str(args["success_criteria"]),
        keywords: strArr(args["keywords"]), reason: str(args["reason"]), note: str(args["note"]), triggers: args["triggers"] as TriggerSpec[] | undefined,
        writerAgentId: opts.writerAgentId, ...(now ? { now } : {}),
      });
      if (!r.ok) return err(r.error!);
      const ver = r.previous && r.goal!.version !== r.previous.version ? ` (v${r.previous.version} → v${r.goal!.version}; v${r.previous.version} kept as history)` : "";
      return ok(`Goal ${action}${ver}:\n${formatGoal(r.goal!)}`);
    }
    case "brain_list_goals": {
      const gid = str(args["goal_id"]);
      if (gid) {
        const h = goalHistory(agentId, gid);
        if (!h) return err(`goal ${gid} not found`);
        if (json) return ok(JSON.stringify(h, null, 2));
        return ok(`${formatGoal(h.versions[h.versions.length - 1]!)}\n${formatGoalHistory(h)}`);
      }
      const st = (str(args["status"]) ?? "active") as GoalStatus | "all";
      if (st !== "all" && !GOAL_STATUSES.includes(st)) return err(`status must be one of ${[...GOAL_STATUSES, "all"].join(", ")}`);
      const rows = listGoals(agentId, { status: st });
      if (json) return ok(JSON.stringify({ goals: rows }, null, 2));
      if (!rows.length) return ok(st === "active" ? "No active goals. Create one with brain_set_goal." : "No goals.");
      return ok(rows.map((g) => formatGoal(g)).join("\n\n"));
    }
  }
  return null;
}
