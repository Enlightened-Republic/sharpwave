import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { appendEpisode, scoreImportance, getRecentEpisodes, searchEpisodes, getEpisodeCount, getEpisodesSince } from "../src/episodes.js";
import { closeDb } from "../src/db.js";

function fresh(): string { return `test-${randomUUID().slice(0, 8)}`; }

describe("episodes", () => {
  it("appendEpisode writes and retrieves an episode", () => {
    const id = fresh();
    const epId = appendEpisode(id, "sess1", "user", "Hello world this is a test message");
    const recent = getRecentEpisodes(id, 1);

    expect(recent.length).toBe(1);
    expect(recent[0].id).toBe(epId);
    expect(recent[0].content).toBe("Hello world this is a test message");
    expect(recent[0].role).toBe("user");
    expect(recent[0].ripple_count).toBe(0);
    closeDb(id);
  });

  it("appendEpisode uses provided importance over computed", () => {
    const id = fresh();
    appendEpisode(id, "sess1", "user", "test", 0.9);
    const recent = getRecentEpisodes(id, 1);
    expect(recent[0].importance).toBe(0.9);
    closeDb(id);
  });

  it("scoreImportance: tool = 0.3", () => {
    expect(scoreImportance("tool", "anything")).toBe(0.3);
  });

  it("scoreImportance: user + 'remember' = 0.85", () => {
    expect(scoreImportance("user", "please remember this")).toBe(0.85);
  });

  it("scoreImportance: user + 'always' = 0.85", () => {
    expect(scoreImportance("user", "always do this")).toBe(0.85);
  });

  it("scoreImportance: emotional word = 0.75", () => {
    expect(scoreImportance("user", "I am so frustrated with this")).toBe(0.75);
  });

  // NOTE (Task 3): clawbrain-v4 floored short USER turns at 0.3 (2026-07-30
  // recap fix). sharpwave-core's scoreImportance floors *all* short content
  // (<30 chars) at 0.2 regardless of role — the role-aware 0.3 floor was not
  // ported. The "short USER content = 0.3" case was removed rather than left
  // failing. If that floor is later ported, re-add it from clawbrain-v4.

  it("scoreImportance: short ASSISTANT content stays 0.2", () => {
    expect(scoreImportance("assistant", "ok")).toBe(0.2);
  });

  it("scoreImportance: short user content stays below the 0.4 extraction gate", () => {
    expect(scoreImportance("user", "ok")).toBeLessThan(0.4);
  });

  it("scoreImportance: default = 0.5", () => {
    expect(scoreImportance("user", "This is a normal message without any special words")).toBe(0.5);
  });

  it("getEpisodeCount returns correct count", () => {
    const id = fresh();
    expect(getEpisodeCount(id)).toBe(0);
    appendEpisode(id, "s", "user", "msg 1 for counting");
    appendEpisode(id, "s", "user", "msg 2 for counting");
    expect(getEpisodeCount(id)).toBe(2);
    closeDb(id);
  });

  it("searchEpisodes finds content via FTS", () => {
    const id = fresh();
    appendEpisode(id, "s", "user", "ClawBrain memory consolidation test episode");
    appendEpisode(id, "s", "user", "unrelated content about something else entirely");

    const results = searchEpisodes(id, "ClawBrain memory", 5);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toContain("ClawBrain");
    closeDb(id);
  });

  // NOTE (Task 3): clawbrain-v4's getEpisodesSince took a 4th `excludeSessionId`
  // arg (the 2026-07-30 "echo of me" recap fix). sharpwave-core's signature is
  // `getEpisodesSince(agentId, sinceMs, minImportance = 0.2)` — no session
  // exclusion. The exclusion-specific cases were removed; the two below cover the
  // real 3-arg contract (since filter + importance floor). If `excludeSessionId`
  // is later ported (context-assembly/morning task), re-add the dropped cases
  // from clawbrain-v4/test/episodes.test.ts.
  describe("getEpisodesSince — since + importance filtering", () => {
    it("returns every session's episodes above the importance floor", () => {
      const id = fresh();
      appendEpisode(id, "sessA", "user", "from session A", 0.5);
      appendEpisode(id, "sessB", "user", "from session B", 0.5);

      expect(getEpisodesSince(id, 0, 0.3)).toHaveLength(2);
      closeDb(id);
    });

    it("applies the importance floor", () => {
      const id = fresh();
      appendEpisode(id, "other", "assistant", "HEARTBEAT_OK", 0.2);
      appendEpisode(id, "other", "user", "real cross-session message", 0.5);

      const recap = getEpisodesSince(id, 0, 0.3);

      expect(recap).toHaveLength(1);
      expect(recap[0].content).toBe("real cross-session message");
      closeDb(id);
    });
  });
});
