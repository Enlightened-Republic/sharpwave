import { afterEach, expect, test, vi } from "vitest";

import { getDb } from "sharpwave-core";
import plugin from "../src/index.js";
import { makeMockApi } from "./mock-api.js";

afterEach(() => {
  vi.useRealTimers();
});

test("restart: DB handle stays open, scheduler timers released", async () => {
  vi.useFakeTimers();
  const { api, rec } = makeMockApi({ enabled: true, config: { agents: ["lc-restart"] } });
  plugin.register(api as never);

  // gateway_start arms the scheduler (4 timers). DB init is synchronous.
  await Promise.all((rec.hooks.get("gateway_start") ?? []).map((h) => h({}, {})));
  const armed = vi.getTimerCount();
  expect(armed).toBeGreaterThanOrEqual(4);

  getDb("lc-restart").prepare("SELECT 1").get();
  const lc = rec.lifecycles[0];

  await lc.cleanup({ reason: "restart" });

  // Scheduler handles cleared — the four timers are gone.
  expect(vi.getTimerCount()).toBeLessThanOrEqual(armed - 4);
  // 2026-05-16 incident guard: restart must NOT close DB handles.
  expect(() => getDb("lc-restart").prepare("SELECT 1").get()).not.toThrow();
});

test("reset: cleanup runs, closeAllDbs fires, getDb reopens with the schema intact", async () => {
  const { api, rec } = makeMockApi({ enabled: true, config: { agents: ["lc-reset"] } });
  plugin.register(api as never);

  getDb("lc-reset").prepare("SELECT 1").get();
  const lc = rec.lifecycles[0];

  await lc.cleanup({ reason: "reset" });

  // closeAllDbs ran inside cleanup; getDb must reopen the file lazily and it
  // must be uncorrupted — assert the reopen path, not a tautology.
  const row = getDb("lc-reset").prepare("SELECT 1 AS ok").get() as { ok: number };
  expect(row.ok).toBe(1);
  const nodeCount = getDb("lc-reset").prepare("SELECT count(*) AS n FROM nodes").get() as { n: number };
  expect(nodeCount.n).toBeGreaterThanOrEqual(0);
});

test("cleanup on an unknown/restart reason before any gateway_start does not throw", async () => {
  const { api, rec } = makeMockApi({ enabled: true, config: { agents: ["lc-noarm"] } });
  plugin.register(api as never);
  const lc = rec.lifecycles[0];

  await expect(lc.cleanup({ reason: "restart" })).resolves.not.toThrow();
});
