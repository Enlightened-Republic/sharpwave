/**
 * Xanima 0.2.0 continuity tools: decision ledger + goals. One definition and
 * one dispatcher shared by the MCP server, the OpenClaw plugin (local mode)
 * and xanima-server (which calls it on the caller's private brain).
 */
import type { BrainConfig } from "./types.js";
import { reflect, formatReflection } from "./reflection.js";
import { createOpenItem, updateOpenItem, getOpenItem, listOpenItems, formatOpenItem, type OpenKind, type OpenStatus, type OpenAction } from "./open-items.js";
import { createCommitment, updateCommitment, listCommitments, formatCommitment, createPlan, updatePlan, getPlan, listPlans, formatPlan, type CommitAction, type PlanAction, type PlanStatus } from "./plans.js";
import { replay, changesSince, formatChanges, conflicts, briefing, forgetImpact } from "./meta-tools.js";
import { parseWhen, capLines, ago, DAY } from "./continuity-util.js";

import {
  confirmDecision,   recordDecision, updateDecisionOutcome, queryDecisions, formatDecision, OUTCOME_STATUSES, type OutcomeStatus,
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
    description: "Record what actually happened after a decision: the outcome, whether it matched your prediction (matched | partial | missed), and the lesson. Sleep uses this to calibrate confidence and (if enabled) promote recurring lessons to skills. Or pass confirm=true (outcome optional) to confirm an auto-extracted draft as a real decision (optionally with goal_id to link it); unconfirmed drafts expire after decisionDraftTtlDays.",
    inputSchema: {
      type: "object",
      properties: {
        decision_id: { type: "string", description: "Decision node id (or 8+ char prefix)." },
        outcome: { type: "string", description: "What actually happened." },
        outcome_status: { type: "string", enum: OUTCOME_STATUSES, description: "Did it match the prediction?" },
        lesson: { type: "string", description: "What to do (or avoid) next time." },
        confirm: { type: "boolean", description: "Confirm an auto-extracted draft (no outcome needed)." },
        goal_id: { type: "string", description: "With confirm: link the decision to the goal it advances." },
      },
      required: ["decision_id"],
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
        source_type: { type: "string", description: "Where this change came from (user|self_observation|inference|tool|agent). Goal changes from tool output or another agent are quarantined for review." },
      },
      required: ["title"],
    },
  },
  brain_update_goal: {
    description: "Change a goal with history preserved. update / supersede (new version; supersede needs a reason), pause, resume, done, archive, progress (log real progress with a note; clears drift — talking about a goal is not progress), track / untrack (drift checking). Shortcut: {goal_id, progress: \"what got done\"}. Add triggers with any action.",
    inputSchema: {
      type: "object",
      properties: {
        goal_id: { type: "string", description: "Goal id (or 8+ char prefix) from brain_list_goals." },
        action: { type: "string", enum: GOAL_ACTIONS },
        title: { type: "string" }, description: { type: "string" }, priority: PRIORITY,
        success_criteria: { type: "string" }, keywords: { type: "array", items: { type: "string" } },
        reason: { type: "string", description: "Why (required for supersede; recorded in history)." },
        note: { type: "string", description: "Progress note (action progress)." },
        progress: { type: "string", description: "Shortcut for action=progress with this note: what concretely advanced the goal." },
        triggers: TRIGGERS,
        source_type: { type: "string", description: "Where this change came from (user|self_observation|inference|tool|agent). Goal changes from tool output or another agent are quarantined for review." },
      },
      required: ["goal_id"],
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

// ── Xanima 0.3.0: reflection, replay, open items, commitments, plans, meta-tools ──
const LINKS = { type: "array", items: { type: "string" }, description: "Ids (or 8+ char prefixes) of goals, plans, decisions or other nodes this is about." };
const WHEN = { type: ["string", "number"] };
Object.assign(CONTINUITY_TOOL_DEFS, {
  brain_reflect: {
    description: "Reflect: what worked, what didn't, and what to try next — built from decision outcomes, resolved hypotheses, slipped commitments and reported results in a window. Scope it to a topic or goal_id (or neither for everything). The reflection is stored (merging into a near-duplicate one) and comes back in recall and briefings. No arguments in local mode also shows your self model.",
    inputSchema: { type: "object", properties: {
      topic: { type: "string" }, goal_id: { type: "string" },
      since: { ...WHEN, description: 'Window start: ISO date, epoch ms or "7 days ago". Default: reflectionWindowDays back.' },
      until: { ...WHEN, description: "Window end. Default now." },
    } },
  },
  brain_replay: {
    description: "Experience replay: a few compressed past trajectories (what was said → the decision → what happened → the lesson) for a goal, a skill, or a query. Budget-capped. Use it before repeating a kind of decision.",
    inputSchema: { type: "object", properties: { goal_id: { type: "string" }, skill_id: { type: "string" }, query: { type: "string" }, k: { type: "number", description: "How many trajectories (1-10, default 3)." } } },
  },
  brain_hypothesis: {
    description: "Hypotheses and assumptions as first-class items. create (statement, kind hypothesis|assumption, load_bearing for assumptions your plan rests on, confidence, evidence_for/against, links), evidence (add evidence_for / evidence_against), support / refute (with evidence), close (reason), reopen, confirm (keep a captured draft), update. A load-bearing assumption with more evidence against than for shows as CONTRADICTED in brain_status.",
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["create", "update", "evidence", "support", "refute", "close", "reopen", "confirm"] },
      id: { type: "string", description: "The hypothesis / assumption id (not for create)." },
      statement: { type: "string" }, kind: { type: "string", enum: ["hypothesis", "assumption"], description: "Default hypothesis." },
      load_bearing: { type: "boolean" }, confidence: { type: ["string", "number"] },
      evidence: { type: "string", description: "One piece of evidence (support → for, refute → against). A bare node id links that node." },
      evidence_for: { type: "array", items: { type: "string" } }, evidence_against: { type: "array", items: { type: "string" } },
      links: LINKS, reason: { type: "string" },
    }, required: ["action"] },
  },
  brain_question: {
    description: "Open questions you want to keep alive across sessions. ask (question, links), answer (id, answer — closes it), close (id, reason), reopen, update. Open questions resurface when a turn is about them.",
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["ask", "answer", "close", "reopen", "update", "confirm"] },
      id: { type: "string" }, question: { type: "string" }, answer: { type: "string" }, reason: { type: "string" }, links: LINKS,
    }, required: ["action"] },
  },
  brain_list_open: {
    description: "List open hypotheses, questions and assumptions (load-bearing first). Filter by kind, status (active = open + supported, or open | supported | refuted | closed | all), a query, or about (a goal / plan / decision id).",
    inputSchema: { type: "object", properties: {
      kind: { type: "string", enum: ["hypothesis", "question", "assumption"] }, status: { type: "string", enum: ["active", "open", "supported", "refuted", "closed", "all"] },
      query: { type: "string" }, about: { type: "string" }, limit: { type: "number" }, format: { type: "string", enum: ["text", "json"] },
    } },
  },
  brain_commit: {
    description: "Commitments you made — to the user or to yourself. create (title, to: user | self | a name, due: ISO / \"tomorrow\" / \"in 3 days\", blocked_by: ids, links), update (title / due / note), done, drop (reason), reopen, block (blocked_by), unblock. Overdue or blocked commitments show in brain_status and as a one-line nudge.",
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["create", "update", "done", "drop", "reopen", "block", "unblock"] },
      id: { type: "string" }, title: { type: "string" }, to: { type: "string" }, due: WHEN, note: { type: "string" }, reason: { type: "string" },
      blocked_by: { type: "array", items: { type: "string" }, description: "Ids of what this waits on: commitments, decisions, plans, hypotheses, goals, or plan steps as step:<n>." },
      links: LINKS,
    }, required: ["action"] },
  },
  brain_commitments: {
    description: "List your commitments: open (default), overdue, blocked, done, or all.",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: ["open", "overdue", "blocked", "done", "all"] }, format: { type: "string", enum: ["text", "json"] } } },
  },
  brain_plan: {
    description: "Plans with steps. create (title, steps[], goal_id), list (status), show (plan_id), add_steps, step (step number, status todo|doing|done|blocked|skipped, note, blocked_by), park (note — why), resume (returns a briefing: the plan, what's still open, and what changed while it was parked), done, abandon.",
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["create", "list", "show", "update", "add_steps", "step", "park", "resume", "done", "abandon"] },
      plan_id: { type: "string" }, title: { type: "string" }, goal_id: { type: "string" }, steps: { type: "array", items: { type: "string" } },
      step: { type: "number" }, status: { type: "string" }, note: { type: "string" }, blocked_by: { type: "array", items: { type: "string" } }, links: LINKS,
    }, required: ["action"] },
  },
  brain_changes: {
    description: "What changed about a goal, plan or topic in the last N days: decisions and outcomes, goal events, new / updated / retired memories, hypotheses that moved, commitments done or due. Fast, read-only, budget-capped.",
    inputSchema: { type: "object", properties: { goal_id: { type: "string" }, plan_id: { type: "string" }, topic: { type: "string" }, days: { type: "number", description: "Default 7." } } },
  },
  brain_conflicts: {
    description: "Contradictions, low-confidence or disputed memories, refuted hypotheses and contradicted assumptions about a topic, plus open conflicts in your rooms (brain service). Without a topic: only the room conflicts. Read-only, budget-capped.",
    inputSchema: { type: "object", properties: { topic: { type: "string", description: "What to check. Optional on the brain service (room conflicts only); required in local mode." } } },
  },
  brain_briefing: {
    description: "A short resume briefing for a plan, goal or topic: where it stands, what's open, recent decisions, commitments, the last reflection, and what changed. Read-only, budget-capped.",
    inputSchema: { type: "object", properties: { plan_id: { type: "string" }, goal_id: { type: "string" }, topic: { type: "string" }, since: WHEN } },
  },
  brain_forget_impact: {
    description: "Dry run: what would be lost by compacting or forgetting a cluster (a node id and its members) or everything matching a query — unique facts, protected items, links cut, references, recoverable episodes. Changes nothing.",
    inputSchema: { type: "object", properties: { cluster: { type: "string" }, query: { type: "string" } } },
  },
} satisfies Record<string, ContinuityToolDef>);

/** Read-only continuity tools (read scope on the service). */
export const CONTINUITY_READ_ONLY_TOOLS = ["brain_query_decisions", "brain_list_goals", "brain_replay", "brain_list_open", "brain_commitments", "brain_changes", "brain_conflicts", "brain_briefing", "brain_forget_impact"];

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
      const outcomeText = str(args["outcome"]);
      if (args["confirm"] === true && !outcomeText) {
        const c = confirmDecision(agentId, str(args["decision_id"]) ?? "", { goalId: str(args["goal_id"]), writerAgentId: opts.writerAgentId, ...(now ? { now } : {}) });
        if (!c.ok) return err(c.error!);
        return ok(`Decision confirmed${c.linkedGoal ? ` and linked to goal "${c.linkedGoal}" (progress logged)` : ""}.\n${formatDecision(c.decision!)}`);
      }
      if (!outcomeText || !str(args["outcome_status"])) return err("outcome and outcome_status are required (or pass confirm=true to confirm a draft)");
      if (args["confirm"] === true || str(args["goal_id"])) {
        const c = confirmDecision(agentId, str(args["decision_id"]) ?? "", { goalId: str(args["goal_id"]), writerAgentId: opts.writerAgentId, ...(now ? { now } : {}) });
        if (!c.ok) return err(c.error!);
      }
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
      const progressNote = str(args["progress"]);
      const action = (str(args["action"]) ?? (progressNote ? "progress" : undefined)) as GoalAction;
      if (!action) return err("action is required (or pass progress: \"note\")");
      if (action === "progress" && !progressNote && !str(args["note"])) return err("progress needs a note: what concretely advanced the goal");
      const r = updateGoal(agentId, str(args["goal_id"]) ?? "", {
        action, title: str(args["title"]), description: str(args["description"]), priority: args["priority"], successCriteria: str(args["success_criteria"]),
        keywords: strArr(args["keywords"]), reason: str(args["reason"]), note: str(args["note"]) ?? progressNote, triggers: args["triggers"] as TriggerSpec[] | undefined,
        writerAgentId: opts.writerAgentId, ...(now ? { now } : {}),
      });
      if (!r.ok) return err(r.error!);
      const ver = r.previous && r.goal!.version !== r.previous.version ? ` (v${r.previous.version} → v${r.goal!.version}; v${r.previous.version} kept as history)` : "";
      return ok(`Goal ${action}${ver}:\n${formatGoal(r.goal!)}`);
    }
    case "brain_reflect": {
      const since = args["since"] !== undefined ? parseWhen(args["since"], now ?? Date.now()) : undefined;
      const until = args["until"] !== undefined ? parseWhen(args["until"], now ?? Date.now()) : undefined;
      if (since === null || until === null) return err('since / until must be an ISO date, epoch ms or "N days ago"');
      const r = reflect(agentId, { topic: str(args["topic"]), goalId: str(args["goal_id"]), ...(since ? { since } : {}), ...(until ? { until } : {}), origin: "tool", ...(now ? { now } : {}) }, config);
      if (!r.ok) return err(r.error!);
      return ok(formatReflection(r));
    }
    case "brain_replay": {
      const r = replay(agentId, { goalId: str(args["goal_id"]), skillId: str(args["skill_id"]), query: str(args["query"]), ...(typeof args["k"] === "number" ? { k: args["k"] } : {}) }, config, now ?? Date.now());
      return r.ok ? ok(r.text!) : err(r.error!);
    }
    case "brain_hypothesis": case "brain_question": {
      const q = name === "brain_question";
      const action = (str(args["action"]) ?? "").toLowerCase();
      const text = str(args[q ? "question" : "statement"]);
      if (action === "create" || action === "ask") {
        const kind = q ? "question" : ((str(args["kind"]) ?? "hypothesis") as OpenKind);
        if (!q && kind !== "hypothesis" && kind !== "assumption") return err("kind must be hypothesis or assumption");
        const r = createOpenItem(agentId, {
          kind, text: text ?? "", loadBearing: args["load_bearing"] === true, links: strArr(args["links"]),
          ...(args["confidence"] !== undefined ? { confidence: args["confidence"] as number } : {}),
          evidenceFor: [...(strArr(args["evidence_for"]) ?? []), ...(str(args["evidence"]) ? [str(args["evidence"])!] : [])], evidenceAgainst: strArr(args["evidence_against"]),
          writerAgentId: opts.writerAgentId, ...(now ? { now } : {}),
        });
        if (!r.ok) return err(r.error!);
        return ok(`Recorded ${kind} ${r.id}.\n${formatOpenItem(getOpenItem(agentId, r.id!)!, now)}`);
      }
      const id = str(args["id"]);
      if (!id) return err("id is required (brain_list_open shows ids)");
      const map: Record<string, OpenAction> = { update: "update", evidence: "evidence", support: "support", refute: "refute", close: "close", reopen: "reopen", confirm: "confirm", answer: "answer" };
      if (!map[action]) return err(`unknown action ${action}`);
      const r = updateOpenItem(agentId, id, {
        action: map[action]!, text, loadBearing: typeof args["load_bearing"] === "boolean" ? args["load_bearing"] : undefined, links: strArr(args["links"]),
        ...(args["confidence"] !== undefined ? { confidence: args["confidence"] as number } : {}),
        evidence: str(args["evidence"]), evidenceFor: strArr(args["evidence_for"]), evidenceAgainst: strArr(args["evidence_against"]),
        answer: str(args["answer"]), reason: str(args["reason"]), writerAgentId: opts.writerAgentId, ...(now ? { now } : {}),
      });
      if (!r.ok) return err(r.error!);
      return ok(`${r.item!.kind} ${action === "answer" ? "answered" : action === "close" ? "closed" : action === "refute" ? "refuted" : action === "support" ? "supported" : "updated"}.\n${formatOpenItem(r.item!, now)}`);
    }
    case "brain_list_open": {
      const st = str(args["status"]) as OpenStatus | "all" | "active" | undefined;
      const rows = listOpenItems(agentId, { kind: str(args["kind"]) as OpenKind | undefined, ...(st ? { status: st } : {}), query: str(args["query"]), about: str(args["about"]), ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {}) });
      if (json) return ok(JSON.stringify({ items: rows }, null, 2));
      if (!rows.length) return ok("No open hypotheses, questions or assumptions match.");
      return ok(capLines(rows.map((o) => formatOpenItem(o, now)), Math.max(400, config.metaToolMaxChars ?? 2400)));
    }
    case "brain_commit": {
      const action = (str(args["action"]) ?? "").toLowerCase();
      if (action === "create") {
        const r = createCommitment(agentId, { title: str(args["title"]) ?? "", to: str(args["to"]), due: args["due"], note: str(args["note"]), links: strArr(args["links"]), blockedBy: strArr(args["blocked_by"]), writerAgentId: opts.writerAgentId, ...(now ? { now } : {}) });
        if (!r.ok) return err(r.error!);
        return ok(`Commitment recorded.\n${formatCommitment(r.commitment!, now)}`);
      }
      const id = str(args["id"]);
      if (!id) return err("id is required (brain_commitments shows ids)");
      const r = updateCommitment(agentId, id, { action: action as CommitAction, title: str(args["title"]), ...(args["due"] !== undefined ? { due: args["due"] } : {}), note: str(args["note"]), blockedBy: strArr(args["blocked_by"]), reason: str(args["reason"]), ...(now ? { now } : {}) });
      if (!r.ok) return err(r.error!);
      return ok(`Commitment ${action}.\n${formatCommitment(r.commitment!, now)}`);
    }
    case "brain_commitments": {
      const rows = listCommitments(agentId, { status: (str(args["status"]) ?? "open") as "open", ...(now ? { now } : {}) });
      if (json) return ok(JSON.stringify({ commitments: rows }, null, 2));
      return ok(rows.length ? capLines(rows.map((c) => formatCommitment(c, now)), Math.max(400, config.metaToolMaxChars ?? 2400)) : "No commitments match.");
    }
    case "brain_plan": {
      const action = (str(args["action"]) ?? "").toLowerCase();
      if (action === "create") {
        const r = createPlan(agentId, { title: str(args["title"]) ?? "", goalId: str(args["goal_id"]), steps: strArr(args["steps"]), links: strArr(args["links"]), writerAgentId: opts.writerAgentId, ...(now ? { now } : {}) });
        return r.ok ? ok(`Plan created.\n${formatPlan(r.plan!, now)}`) : err(r.error!);
      }
      if (action === "list") {
        const rows = listPlans(agentId, (str(args["status"]) ?? "active") as PlanStatus);
        return ok(rows.length ? capLines(rows.map((p) => formatPlan(p, now)), Math.max(400, config.metaToolMaxChars ?? 2400)) : "No plans match.");
      }
      const id = str(args["plan_id"]);
      if (!id) return err("plan_id is required");
      if (action === "show") { const p = getPlan(agentId, id); return p ? ok(formatPlan(p, now)) : err(`plan ${id} not found`); }
      const r = updatePlan(agentId, id, { action: action as PlanAction, title: str(args["title"]), steps: strArr(args["steps"]), ...(typeof args["step"] === "number" ? { step: args["step"] } : {}), status: str(args["status"]), note: str(args["note"]), blockedBy: strArr(args["blocked_by"]), ...(now ? { now } : {}) });
      if (!r.ok) return err(r.error!);
      if (action === "resume") {
        const b = briefing(agentId, { planId: r.plan!.node_id, ...(r.previousParkedAt ? { since: r.previousParkedAt } : {}) }, config, now ?? Date.now());
        return ok(`Plan resumed (parked ${r.previousParkedAt ? ago(r.previousParkedAt, now ?? Date.now()) : "?"}).\n${b.text}`);
      }
      return ok(`Plan ${action}.\n${formatPlan(r.plan!, now)}`);
    }
    case "brain_changes": {
      const days = typeof args["days"] === "number" && args["days"] > 0 ? Math.min(365, args["days"]) : 7;
      const t = now ?? Date.now();
      const r = changesSince(agentId, { goalId: str(args["goal_id"]), planId: str(args["plan_id"]), topic: str(args["topic"]), since: t - days * DAY, until: t });
      if (r.error) return err(r.error);
      return ok(formatChanges(r.scope!.label, r.changes, t - days * DAY, config, t));
    }
    case "brain_conflicts": {
      const topic = str(args["topic"]);
      if (!topic) return err("topic is required (without a topic, brain_conflicts on the brain service lists room conflicts)");
      return ok(conflicts(agentId, topic, config, now ?? Date.now()).text);
    }
    case "brain_briefing": {
      const since = args["since"] !== undefined ? parseWhen(args["since"], now ?? Date.now()) : undefined;
      const r = briefing(agentId, { planId: str(args["plan_id"]), goalId: str(args["goal_id"]), topic: str(args["topic"]), ...(since ? { since } : {}) }, config, now ?? Date.now());
      return r.ok ? ok(r.text!) : err(r.error!);
    }
    case "brain_forget_impact": {
      const r = forgetImpact(agentId, { cluster: str(args["cluster"]), query: str(args["query"]) }, config, now ?? Date.now());
      return r.ok ? ok(r.text!) : err(r.error!);
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
