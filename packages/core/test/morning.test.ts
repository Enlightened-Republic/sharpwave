import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { getMorningBrief, formatMorningBlock, type MorningBrief } from "../src/morning.js";
import { appendEpisode } from "../src/episodes.js";
import { getDb, closeDb } from "../src/db.js";
import { DEFAULT_CONFIG } from "../src/types.js";

function fresh(): string { return `morning-${randomUUID().slice(0, 8)}`; }

describe("morning brief", () => {
  it("returns null on a fresh brain with no episodes", () => {
    const id = fresh();
    expect(getMorningBrief(id, DEFAULT_CONFIG)).toBeNull();
    closeDb(id);
  });

  it("returns null when the last session was recent (gap <= 4h)", () => {
    const id = fresh();
    appendEpisode(id, "agent:main:main", "user", "hey, still here working on the thing");
    expect(getMorningBrief(id, DEFAULT_CONFIG)).toBeNull();
    closeDb(id);
  });

  it("returns a well-formed brief when the gap since last session exceeds 4h", () => {
    const id = fresh();
    appendEpisode(id, "agent:main:main", "user", "what's the plan for the release");
    appendEpisode(id, "agent:main:main", "assistant", "cut the branch, run the smoke suite, then tag");
    // Backdate every episode ~9h so the wake-up gate (gapHours > 4) fires.
    const nineHoursAgo = Date.now() - 9 * 60 * 60 * 1000;
    getDb(id).prepare("UPDATE episodes SET created_at = ?").run(nineHoursAgo);

    const brief = getMorningBrief(id, DEFAULT_CONFIG);
    expect(brief).not.toBeNull();
    expect(brief!.isMorning).toBe(true);
    expect(brief!.gapHours).toBeGreaterThan(4);
    expect(brief!.leftOff).toContain("cut the branch");
    expect(Array.isArray(brief!.overnightInsights)).toBe(true);
    expect(Array.isArray(brief!.todayGoals)).toBe(true);
    closeDb(id);
  });

  it("formatMorningBlock renders a non-empty multi-section block", () => {
    const brief: MorningBrief = {
      isMorning: true,
      gapHours: 30,
      leftOff: "them: where did we leave the parser → you: half-done, tests failing",
      overnightInsights: ["Pattern emerged: user prefers terse status updates"],
      todayGoals: ["ship openwave", "write the migration note"],
    };
    const out = formatMorningBlock(brief);
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
    expect(out).toContain("[waking up — 1d gap]");
    expect(out).toContain("left off:");
    expect(out).toContain("today:");
    expect(out).toContain("overnight:");
  });
});
