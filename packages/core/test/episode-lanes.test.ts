import { describe, it, expect } from "vitest";
import { classifyEpisodeLane, isForegroundLane } from "../src/episode-lanes.js";

// ─────────────────────────────────────────────────────────────────────────────
// Regression: 2026-07-30 "[BRAIN: last 24h activity]" lane pollution.
//
// The 24h dump in before_prompt_build pulls episodes from EVERY session and
// labels assistant rows "you:" with no timestamp and no lane tag. Background
// lanes out-produce the actual conversation: measured 34 heartbeat episodes vs
// 14 main-chat in one 24h window, and while the heartbeat was stuck re-running
// its rotation, 5 of the 8 injected lines were heartbeat inner monologue —
// e.g. "We are in a Heartbeat direct conversation. We need to execute the
// mandatory rotation in HEARTBEAT.md now."
//
// The model reads that as things IT just said, and anchors on it. Voice was
// exempted from this dump in 2026-05-20; chat was deliberately left unchanged.
// ─────────────────────────────────────────────────────────────────────────────

describe("episode lane classification", () => {
  it("treats the main chat session as foreground", () => {
    expect(classifyEpisodeLane("agent:main:main")).toBe("foreground");
    expect(isForegroundLane("agent:main:main")).toBe(true);
  });

  it("treats real conversation surfaces as foreground", () => {
    expect(classifyEpisodeLane("voice:inbound:+15555550123")).toBe("foreground");
    expect(classifyEpisodeLane("agent:main:discord:1234")).toBe("foreground");
  });

  // Slash traffic is user-INITIATED but it is control plane, not conversation.
  // Caught during live verification 2026-07-30: raising the short-user-message
  // floor to 0.3 made "/new" and "/models" clear the recap's >= 0.3 filter, so
  // the model would read bare commands as things the user said to it.
  it("classifies slash-command sessions as command traffic, not conversation", () => {
    expect(classifyEpisodeLane("agent:main:telegram:slash:8450246364")).toBe("command");
    expect(isForegroundLane("agent:main:telegram:slash:8450246364")).toBe(false);
  });

  it("classifies the heartbeat lane as background", () => {
    expect(classifyEpisodeLane("agent:main:main:heartbeat")).toBe("heartbeat");
    expect(isForegroundLane("agent:main:main:heartbeat")).toBe(false);
  });

  it("classifies cron run sessions as background", () => {
    const cron = "agent:main:cron:30e7c1a9-73c8-4b20-b599-7a59002b55d5:run:873b9bb7-9855-42c4-bfd2-690a6b2a2b61";
    expect(classifyEpisodeLane(cron)).toBe("cron");
    expect(isForegroundLane(cron)).toBe(false);
  });

  it("does not mistake a session merely containing the word heartbeat for the heartbeat lane", () => {
    // Only the :heartbeat SUFFIX marks the lane. A user session that happens to
    // mention it must not be silently dropped from the recap.
    expect(classifyEpisodeLane("agent:main:heartbeat-debugging")).toBe("foreground");
  });

  it("defaults unknown or empty session ids to foreground rather than dropping them", () => {
    expect(classifyEpisodeLane("")).toBe("foreground");
    expect(classifyEpisodeLane(undefined)).toBe("foreground");
    expect(classifyEpisodeLane(null)).toBe("foreground");
    expect(classifyEpisodeLane("something-unrecognised")).toBe("foreground");
  });

  it("filters a realistic mixed window down to conversation only", () => {
    const window = [
      "agent:main:main",
      "agent:main:main:heartbeat",
      "agent:main:main:heartbeat",
      "agent:main:cron:abc:run:def",
      "agent:main:main",
    ];
    expect(window.filter(isForegroundLane)).toEqual(["agent:main:main", "agent:main:main"]);
  });
});
