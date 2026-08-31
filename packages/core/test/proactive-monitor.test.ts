import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { writeNode } from "../src/nodes.js";
import { appendEpisode } from "../src/episodes.js";
import { runProactiveMonitor } from "../src/proactive-monitor.js";
import { getDb, closeDb } from "../src/db.js";
import { DEFAULT_CONFIG } from "../src/types.js";

function fresh(): string { return `proactive-${randomUUID().slice(0, 8)}`; }
const log = { info: () => {}, warn: () => {}, debug: () => {} };

function trace(db: ReturnType<typeof getDb>, id: string): number {
  return (db.prepare("SELECT eligibility_trace FROM nodes WHERE id = ?").get(id) as { eligibility_trace: number }).eligibility_trace;
}

describe("proactive-monitor", () => {
  it("runs without throwing on a fresh brain with no episodes", async () => {
    const id = fresh();
    await expect(
      runProactiveMonitor(id, "sess-" + randomUUID(), DEFAULT_CONFIG, log, null, "anything"),
    ).resolves.toBeUndefined();
    closeDb(id);
  });

  it("boosts eligibility_trace on keyword-matching nodes, not on unrelated ones", async () => {
    const id = fresh();
    const db = getDb(id);
    const session = "sess-" + randomUUID();

    // Recent conversation is about mitochondria / cellular respiration.
    appendEpisode(id, session, "user", "How does the mitochondria drive cellular respiration?");
    appendEpisode(id, session, "assistant", "Mitochondria oxidise pyruvate; respiration yields ATP for eukaryotic cells.");

    const matching = writeNode(
      id, "semantic", "Mitochondria and respiration",
      "The mitochondria is the site of cellular respiration and ATP synthesis.",
    );
    const unrelated = writeNode(
      id, "semantic", "Weekend grocery list",
      "Remember to buy milk, eggs, sourdough bread and ripe bananas.",
    );

    expect(trace(db, matching)).toBe(0);
    expect(trace(db, unrelated)).toBe(0);

    await runProactiveMonitor(
      id, session, DEFAULT_CONFIG, log, null,
      "tell me more about mitochondria and respiration",
    );

    // Keyword-matching node picked up the additive ELIGIBILITY_BOOST (0.3).
    expect(trace(db, matching)).toBeGreaterThan(0);
    // Unrelated node was untouched.
    expect(trace(db, unrelated)).toBe(0);

    closeDb(id);
  });
});
