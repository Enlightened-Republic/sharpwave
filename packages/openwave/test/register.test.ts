import { expect, test } from "vitest";

import plugin from "../src/index.js";
import { makeMockApi } from "./mock-api.js";

test("register wires the expected hooks and 16 tools", () => {
  const { api, rec } = makeMockApi({ enabled: true, config: { agents: ["main"] } });
  plugin.register(api as never);

  for (const h of [
    "session_start", "before_prompt_build", "agent_turn_prepare", "session_end",
    "after_compaction", "message_received", "llm_output", "agent_end",
    "heartbeat_prompt_contribution", "gateway_start", "gateway_stop",
  ]) {
    expect(rec.hooks.has(h), `hook not registered: ${h}`).toBe(true);
  }

  expect(rec.tools).toHaveLength(16);
  expect(rec.lifecycles).toHaveLength(1);
});
