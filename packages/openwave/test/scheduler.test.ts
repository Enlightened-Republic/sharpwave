import { afterEach, expect, test, vi } from "vitest";

import * as core from "sharpwave-core";
import { DEFAULT_CONFIG } from "sharpwave-core";
import { armSchedulers, disarmSchedulers } from "../src/scheduler.js";

const noop = { info() {}, warn() {}, error() {} };

afterEach(() => {
  vi.useRealTimers();
});

test("armSchedulers returns non-null handles; disarmSchedulers clears every one", () => {
  vi.useFakeTimers();
  const h = armSchedulers(["sched-a"], DEFAULT_CONFIG, noop);

  expect(h.replay).not.toBeNull();
  expect(h.consolidation).not.toBeNull();
  expect(h.sweep).not.toBeNull();
  expect(h.initialConsolidation).not.toBeNull();

  const armed = vi.getTimerCount();
  expect(armed).toBeGreaterThanOrEqual(4);

  disarmSchedulers(h);

  expect(h.replay).toBeNull();
  expect(h.consolidation).toBeNull();
  expect(h.sweep).toBeNull();
  expect(h.initialConsolidation).toBeNull();
  // The four scheduler timers are gone; nothing armed by this module remains.
  expect(vi.getTimerCount()).toBeLessThanOrEqual(armed - 4);
});

test("disarmSchedulers tolerates a null handle set (cleanup before gateway_start)", () => {
  expect(() => disarmSchedulers(null)).not.toThrow();
  expect(() => disarmSchedulers(undefined)).not.toThrow();
});

test("after disarm, advancing time triggers nothing", async () => {
  vi.useFakeTimers();
  const lines: string[] = [];
  const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error() {} };
  const h = armSchedulers(["sched-silent"], DEFAULT_CONFIG, log);
  disarmSchedulers(h);
  lines.length = 0;

  await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000); // 2h
  expect(lines).toHaveLength(0);
});

test("the post-boot consolidation kick fires and logs sleep_system.tick", async () => {
  vi.useFakeTimers();
  const lines: string[] = [];
  const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error() {} };
  // Real temp brain.db (SHARPWAVE_DATA_DIR from setup.ts). Fresh agent → the
  // consolidation gate evaluates false (0 episodes), so no LLM call is made.
  const h = armSchedulers(["sched-kick"], { ...DEFAULT_CONFIG }, log);

  await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1000); // past the +5m kick

  const tick = lines.find((l) => l.includes('"op":"sleep_system.tick"'));
  expect(tick, `no sleep_system.tick in:\n${lines.join("\n")}`).toBeTruthy();
  expect(tick).toContain('"trigger":"initial"');
  expect(tick).toContain('"consolidate":false');

  disarmSchedulers(h);
});

test("the hourly maintenance interval keeps firing sleep_system.tick", async () => {
  vi.useFakeTimers();
  const lines: string[] = [];
  const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error() {} };
  const h = armSchedulers(["sched-hourly"], { ...DEFAULT_CONFIG }, log);

  await vi.advanceTimersByTimeAsync(65 * 60 * 1000); // past +5m kick and the +60m tick

  const hourly = lines.filter((l) => l.includes('"op":"sleep_system.tick"') && l.includes('"trigger":"hourly"'));
  expect(hourly.length).toBeGreaterThanOrEqual(1);

  disarmSchedulers(h);
});

test("the awake-replay interval runs core.awakeReplayTick without throwing", async () => {
  vi.useFakeTimers();
  const lines: string[] = [];
  const log = { info: (m: string) => lines.push(m), warn: (m: string) => lines.push(m), error() {} };
  // Seed one node so awakeReplayTick has something to walk.
  core.writeNode("sched-replay", "semantic", "seed", "A durable fact.", { importance: 0.6 });
  const h = armSchedulers(["sched-replay"], { ...DEFAULT_CONFIG }, log);

  await vi.advanceTimersByTimeAsync(31 * 60 * 1000); // past the 30m replay tick

  // awakeReplayTick logs only on error; a clean run leaves no awake_replay.tick
  // error line.
  expect(lines.find((l) => l.includes('"op":"awake_replay.tick"') && l.includes('"outcome":"error"'))).toBeUndefined();

  disarmSchedulers(h);
});
