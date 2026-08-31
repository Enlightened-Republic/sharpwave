import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { appendEpisode, getSessionSummaries } from "../src/episodes.js";
import { getDb, closeDb } from "../src/db.js";

function fresh(): string { return `test-${randomUUID().slice(0, 8)}`; }

/** Push every episode of a session back in time by `ms`. */
function backdate(agentId: string, sessionId: string, ms: number): void {
  getDb(agentId)
    .prepare("UPDATE episodes SET created_at = created_at - ? WHERE session_id = ?")
    .run(ms, sessionId);
}

const MIN = 60_000;
const HOUR = 3_600_000;

/**
 * CF-A — characterization coverage for `getSessionSummaries` (barrel export
 * added in Task 2, previously untested; not exercised by context-assembly).
 * Real rows via `appendEpisode`, then raw `created_at` back-dating.
 */
describe("getSessionSummaries", () => {
  /** Seed 4 distinct sessions with varied importance + age. */
  function seed(): string {
    const id = fresh();
    // A: newest-but-one, one user turn with messy whitespace, high importance
    appendEpisode(id, "tg:chat:alpha", "user", "alpha topic   with\n\nextra   whitespace", 0.9);
    appendEpisode(id, "tg:chat:alpha", "assistant", "sure, on it", 0.5);
    backdate(id, "tg:chat:alpha", 25 * MIN);

    // B: every episode below the default 0.3 importance floor
    appendEpisode(id, "tg:chat:beta", "user", "beta low signal one", 0.2);
    appendEpisode(id, "tg:chat:beta", "user", "beta low signal two", 0.2);
    appendEpisode(id, "tg:chat:beta", "assistant", "beta ack", 0.2);
    backdate(id, "tg:chat:beta", 90 * MIN);

    // G: two days old, importance above floor
    appendEpisode(id, "disc:guild:gamma", "user", "gamma question about deploys", 0.6);
    appendEpisode(id, "disc:guild:gamma", "user", "gamma follow-up", 0.6);
    backdate(id, "disc:guild:gamma", 50 * HOUR);

    // C: newest, 2-part session id (no 3rd colon segment)
    appendEpisode(id, "cron:nightly", "user", "cron nightly recap run", 0.9);
    backdate(id, "cron:nightly", 8 * MIN);

    return id;
  }

  const bySession = (
    rows: ReturnType<typeof getSessionSummaries>,
    sid: string,
  ) => rows.find((r) => r.sessionId === sid);

  it("groups episodes by session_id — one row per session", () => {
    const id = seed();
    const rows = getSessionSummaries(id, 0, 0.1, undefined, 10);
    const ids = rows.map((r) => r.sessionId);
    expect(ids.sort()).toEqual(
      ["cron:nightly", "disc:guild:gamma", "tg:chat:alpha", "tg:chat:beta"],
    );
    expect(new Set(ids).size).toBe(ids.length); // no session listed twice
    closeDb(id);
  });

  it("respects the minImportance floor (default 0.3 drops the all-low session)", () => {
    const id = seed();
    const dflt = getSessionSummaries(id, 0);
    expect(bySession(dflt, "tg:chat:beta")).toBeUndefined();
    expect(bySession(dflt, "tg:chat:alpha")).toBeDefined();

    const loose = getSessionSummaries(id, 0, 0.1, undefined, 10);
    expect(bySession(loose, "tg:chat:beta")).toBeDefined();
    closeDb(id);
  });

  it("excludeSessionId drops exactly that session", () => {
    const id = seed();
    const rows = getSessionSummaries(id, 0, 0.1, "tg:chat:beta", 10);
    expect(bySession(rows, "tg:chat:beta")).toBeUndefined();
    expect(rows.map((r) => r.sessionId).sort()).toEqual(
      ["cron:nightly", "disc:guild:gamma", "tg:chat:alpha"],
    );
    closeDb(id);
  });

  it("maxSessions caps the row count, newest latestAt first", () => {
    const id = seed();
    const rows = getSessionSummaries(id, 0, 0.3, undefined, 2);
    expect(rows).toHaveLength(2);
    expect(rows[0].sessionId).toBe("cron:nightly");   // 8m old
    expect(rows[1].sessionId).toBe("tg:chat:alpha");  // 25m old
    expect(rows[0].latestAt).toBeGreaterThanOrEqual(rows[1].latestAt);
    closeDb(id);
  });

  it("produces a relative-time field scaled to session age", () => {
    const id = seed();
    const rows = getSessionSummaries(id, 0, 0.3, undefined, 10);
    expect(bySession(rows, "cron:nightly")!.ago).toMatch(/^\d+m ago$/);
    expect(bySession(rows, "tg:chat:alpha")!.ago).toMatch(/^\d+m ago$/);
    expect(bySession(rows, "disc:guild:gamma")!.ago).toBe("2d ago");
    closeDb(id);
  });

  it("summary is the first user message, whitespace-collapsed and length-capped", () => {
    const id = seed();
    const rows = getSessionSummaries(id, 0, 0.3, undefined, 10);
    const alpha = bySession(rows, "tg:chat:alpha")!;
    expect(alpha.summary).toBe("alpha topic with extra whitespace");
    expect(alpha.summary.length).toBeLessThanOrEqual(120);
    closeDb(id);
  });

  it("derives channel from the session-id colon segments", () => {
    const id = seed();
    const rows = getSessionSummaries(id, 0, 0.1, undefined, 10);
    expect(bySession(rows, "tg:chat:alpha")!.channel).toBe("alpha");
    expect(bySession(rows, "disc:guild:gamma")!.channel).toBe("gamma");
    expect(bySession(rows, "cron:nightly")!.channel).toBe("nightly"); // 2-part id → parts[1]
    closeDb(id);
  });
});
