import { expect, test } from "vitest";

import * as core from "sharpwave-core";
import plugin from "../src/index.js";
import { makeMockApi } from "./mock-api.js";

// Marker that only the BOOTSTRAP block carries (context-assembly.ts BRAIN_HEADER).
// The self-model header is "[SharpWave] Identity..." — a different string —
// so this distinguishes "bootstrap was injected into prependContext" from the
// always-on self-model header on appendSystemContext.
const BOOTSTRAP_MARKER = "[SharpWave active]";
const SELF_MODEL_MARKER = "[SharpWave]";

function seed(agentId: string): void {
  core.writeNode(agentId, "semantic", "db", "Production uses PostgreSQL 16.", { importance: 0.8 });
  core.writeNode(agentId, "semantic", "deploy", "Deploys run via GitHub Actions on tag push.", { importance: 0.7 });
  core.writeNode(agentId, "goal", "ship", "Ship the openwave split.", { importance: 0.9 });
}

function register() {
  const mock = makeMockApi({ enabled: true, config: { agents: ["main"] } });
  plugin.register(mock.api as never);
  return mock;
}

const prependOf = (out: unknown[]) =>
  (out.find((r) => (r as { prependContext?: string })?.prependContext) as { prependContext?: string })?.prependContext ?? "";
const sysOf = (out: unknown[]) =>
  (out.find((r) => (r as { appendSystemContext?: string })?.appendSystemContext) as { appendSystemContext?: string })?.appendSystemContext ?? "";

test("session_start queues exactly one bootstrap injection under an openwave key", async () => {
  const { rec, fire } = register();
  seed("main");
  const ctx = { agentId: "main", sessionKey: "agent:main:tg:inj1", sessionId: "inj-s1" };

  await fire("session_start", { ...ctx }, ctx);

  expect(rec.injections).toHaveLength(1);
  expect(rec.injections[0].idempotencyKey).toContain("openwave:bootstrap:");
  expect(rec.injections[0].idempotencyKey).not.toContain("clawbrain-v4");
  expect(rec.injections[0].text.length).toBeGreaterThan(0);
  expect(rec.injections[0].placement).toBe("prepend_context");
});

test("queue delivered: before_prompt_build does NOT re-inject the bootstrap", async () => {
  const { rec, fire } = register();
  seed("main");
  const ctx = { agentId: "main", sessionKey: "agent:main:tg:inj2", sessionId: "inj-s2" };

  await fire("session_start", { ...ctx }, ctx);
  const key = rec.injections[0].idempotencyKey;
  // Gateway hands our own injection back on agent_turn_prepare → "delivered".
  await fire("agent_turn_prepare", { queuedInjections: [{ idempotencyKey: key }] }, ctx);

  const out = await fire("before_prompt_build", { prompt: "what database do we use?", messages: [] }, ctx);

  expect(prependOf(out)).not.toContain(BOOTSTRAP_MARKER); // no double-injection
  expect(sysOf(out)).toContain(SELF_MODEL_MARKER); // header still emitted
});

test("queue dropped: before_prompt_build injects the cached bootstrap", async () => {
  const { fire } = register();
  seed("main");
  const ctx = { agentId: "main", sessionKey: "agent:main:tg:inj3", sessionId: "inj-s3" };

  await fire("session_start", { ...ctx }, ctx); // warms bootstrapCache[sessionId]
  // Gateway accepted the enqueue but drained nothing back → "release_guard".
  await fire("agent_turn_prepare", { queuedInjections: [] }, ctx);

  const out = await fire("before_prompt_build", { prompt: "hi", messages: [] }, ctx);

  const prepend = prependOf(out);
  expect(prepend.length).toBeGreaterThan(0);
  expect(prepend).toContain(BOOTSTRAP_MARKER); // cached bootstrap delivered
});

test("cache miss: before_prompt_build rebuilds the bootstrap from the db", async () => {
  const { fire } = register();
  seed("main");
  // No session_start → nothing in bootstrapCache, nothing queued, guard clear.
  const ctx = { agentId: "main", sessionKey: "agent:main:tg:inj4", sessionId: "inj-s4" };

  const out = await fire("before_prompt_build", { prompt: "how do deploys work?", messages: [] }, ctx);

  expect(prependOf(out)).toContain(BOOTSTRAP_MARKER); // rebuilt live from the graph
});

test("before_prompt_build always emits a self-model header and skips :heartbeat sessions", async () => {
  const { fire } = register();
  const ctx = { agentId: "main", sessionKey: "agent:main:tg:inj5", sessionId: "inj-s5" };

  const out = await fire("before_prompt_build", { prompt: "hello", messages: [] }, ctx);
  expect(sysOf(out)).toContain(SELF_MODEL_MARKER);

  const hb = { agentId: "main", sessionKey: "agent:main:tg:inj5:heartbeat", sessionId: "inj-s5-hb" };
  const hbOut = await fire("before_prompt_build", { prompt: "hello", messages: [] }, hb);
  expect(hbOut.every((r) => r === undefined)).toBe(true);
});
