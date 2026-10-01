// Real-looking OpenClaw 2026.9.7 system-turn fixtures (synthetic content; no
// memory text). Mirror of openwave test/fixtures/system-noise-fixtures.ts — keep in sync.
import type { TurnSignals } from "../../src/system-noise.js";

export const HEARTBEAT_PROMPT_9_7 =
  "Follow the heartbeat monitor scratch context when provided. Recurring tasks are automations; create or change their schedules with the automations tool, not heartbeat scratch. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply NO_REPLY.";

/** Turns that MUST be skipped, with the reason family expected. */
export const NOISE: Array<[string, TurnSignals, string]> = [
  // ── text markers: user side (INTERNAL_WAKE_TRANSCRIPT_PROMPTS) ──
  ["heartbeat poll transcript marker", { role: "user", content: "[OpenClaw heartbeat poll]" }, "text:internal_wake"],
  ["exec completion marker (9.7, with notifyOnExit hint)", { role: "user", content: "[OpenClaw exec completion]\nDisable automatic completion turns with tools.exec.notifyOnExit=false; check per-agent overrides. Background exec and process poll remain available." }, "text:internal_wake"],
  ["exec completion marker (legacy)", { role: "user", content: "[OpenClaw exec completion]" }, "text:internal_wake"],
  ["cron wake marker", { role: "user", content: "[OpenClaw cron wake]" }, "text:internal_wake"],
  ["session event marker", { role: "user", content: "[OpenClaw session event]" }, "text:internal_wake"],
  ["default heartbeat prompt + current-time line", { role: "user", content: `${HEARTBEAT_PROMPT_9_7}\nCurrent time: Thursday, October 1st, 2026 — 3:12 PM (America/Denver)` }, "text:internal_wake"],
  ["legacy HEARTBEAT.md prompt", { role: "user", content: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK." }, "text:internal_wake"],
  ["exec event prompt", { role: "user", content: "An async command you ran earlier has completed. The command completion details are:\n\nexec completed (k3x9, code 0) :: build ok\n\nPlease relay the command output to the user in a helpful way." }, "text:internal_wake"],
  ["exec event prompt, delivery disabled", { role: "user", content: "An async command completion event was triggered, but user delivery is disabled for this run. Handle the result internally and reply NO_REPLY only. Do not mention, summarize, or reuse command output." }, "text:internal_wake"],
  ["cron reminder prompt", { role: "user", content: "A scheduled reminder has been triggered. The reminder content is:\n\nwater the ferns\n\nHandle this reminder internally. Do not relay it to the user unless explicitly requested." }, "text:internal_wake"],
  ["empty cron event prompt", { role: "user", content: "A scheduled cron event was triggered, but no event content was found. Reply NO_REPLY." }, "text:internal_wake"],
  ["bare System: event lines", { role: "user", content: "System: [2026-10-01 15:12:04 MDT] Exec finished (gateway id=9f2c, code 0)\nSystem: Exec finished (node=pc id=77aa, code 1)" }, "text:internal_wake"],
  ["structured exec completion line", { role: "user", content: "exec failed (q7w2, signal SIGTERM) :: killed" }, "text:internal_wake"],
  // ── text markers: assistant side (SILENT_REPLY_TOKEN / HEARTBEAT_TOKEN) ──
  ["exact NO_REPLY", { role: "assistant", content: "NO_REPLY" }, "text:silent_reply"],
  ["NO_REPLY with triage reasoning", { role: "assistant", content: "NO_REPLY — 3:12 PM, quiet afternoon, no blocked work in scope, last activity 40m ago. Next scheduled tick ~15:42." }, "text:silent_reply"],
  ["NO_REPLY glued to text", { role: "assistant", content: "NO_REPLYThe user is idle; nothing to report." }, "text:silent_reply"],
  ["bold NO_REPLY", { role: "assistant", content: "**NO_REPLY**" }, "text:silent_reply"],
  ["lower-case no_reply", { role: "assistant", content: "no_reply" }, "text:silent_reply"],
  ["JSON string NO_REPLY", { role: "assistant", content: "\"NO_REPLY\"" }, "text:silent_reply"],
  ["JSON action envelope", { role: "assistant", content: "{\"action\":\"NO_REPLY\"}" }, "text:silent_reply"],
  ["reasoning-prefixed NO_REPLY", { role: "assistant", content: "<think>Inbox empty, calendar clear.</think>\nNO_REPLY" }, "text:silent_reply"],
  ["silent intent + trailing token", { role: "assistant", content: "I'll stay quiet for now.\nNO_REPLY" }, "text:silent_reply"],
  ["exact HEARTBEAT_OK", { role: "assistant", content: "HEARTBEAT_OK" }, "text:silent_reply"],
  ["HEARTBEAT_OK leading", { role: "assistant", content: "HEARTBEAT_OK — all checks green, nothing queued." }, "text:silent_reply"],
  ["short ack ending in HEARTBEAT_OK", { role: "assistant", content: "Checked monitors, all fine. HEARTBEAT_OK" }, "text:silent_reply"],
  // ── structured flags (preferred) ──
  ["trigger=heartbeat, ordinary-looking reply", { role: "assistant", content: "Checked the inbox and the deploy queue; nothing new since this morning.", trigger: "heartbeat" }, "trigger:heartbeat"],
  ["trigger=memory (memory-flush run)", { role: "assistant", content: "Saved today's notes to memory/2026-10-01.md.", trigger: "memory" }, "trigger:memory"],
  ["provenance internal_system/exec", { role: "assistant", content: "The build finished cleanly.", inputProvenance: { kind: "internal_system", sourceTool: "exec" } }, "provenance:internal_system:exec"],
  ["provenance internal_system/heartbeat (user side)", { role: "user", content: "anything", inputProvenance: { kind: "internal_system", sourceTool: "heartbeat" } }, "provenance:internal_system:heartbeat"],
  ["isolated heartbeat session key", { role: "assistant", content: "Monitors green.", sessionKey: "agent:main:main:heartbeat" }, "session:heartbeat"],
  ["reply whose prompt was the heartbeat prompt", { role: "assistant", content: "Two monitors flagged; details in the scratch.", prompt: HEARTBEAT_PROMPT_9_7 }, "text:reply_to_internal_wake"],
];

/** Normal turns that merely mention heartbeats / tokens: MUST be kept. */
export const KEEP: Array<[string, TurnSignals]> = [
  ["user asks about heartbeats", { role: "user", content: "Your heartbeats are fine — can you check why the heartbeat poll fired twice last night?" }],
  ["user quotes the marker mid-sentence", { role: "user", content: "What does [OpenClaw heartbeat poll] mean in my transcript?" }],
  ["user asks to change heartbeat config", { role: "user", content: "Set the heartbeat to every 6h and send alerts to Telegram." }],
  ["user message starting with a bracket", { role: "user", content: "[urgent] the deploy failed, please look" }],
  ["assistant explains NO_REPLY", { role: "assistant", content: "The heartbeat runs every 30m; when nothing needs attention it replies NO_REPLY, which OpenClaw hides." }],
  ["assistant sentence ending in the token", { role: "assistant", content: "Set notify=false and the agent replies NO_REPLY." }],
  ["assistant mentions HEARTBEAT_OK", { role: "assistant", content: "Heartbeat config: every 6h, target owner. HEARTBEAT_OK is the ack token." }],
  ["assistant heartbeat fix report", { role: "assistant", content: "I fixed the heartbeat target; you'll get alerts on Telegram now." }],
  ["assistant code identifier", { role: "assistant", content: "NO_REPLY_TOKEN is defined in tokens.ts." }],
  ["normal user fact", { role: "user", content: "Remember the cassowary feeding schedule is at 7am" }],
  ["trigger=user", { role: "assistant", content: "Done — moved the meeting to 3pm.", trigger: "user" }],
  ["trigger=cron (operator automation, clamped elsewhere)", { role: "assistant", content: "Morning brief: two meetings, one PR to review.", trigger: "cron" }],
  ["provenance internal_system/cron (isolated automation)", { role: "assistant", content: "Weekly report drafted.", inputProvenance: { kind: "internal_system", sourceTool: "cron" } }],
  ["provenance external_user", { role: "user", content: "Can you draft the newsletter?", inputProvenance: { kind: "external_user" } }],
  ["main session key", { role: "assistant", content: "Sure.", sessionKey: "agent:main:main" }],
];
