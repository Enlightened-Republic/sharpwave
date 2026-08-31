import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { detectSkillCandidates, generateSkill } from "../src/skill-evolution.js";
import { closeDb } from "../src/db.js";
import { DEFAULT_CONFIG } from "../src/types.js";

function fresh(): string { return `test-${randomUUID().slice(0, 8)}`; }

// NOTE (openwave/sharpwave-core split, Task 3):
// clawbrain-v4's skill-evolution.ts is a full implementation exporting
// `buildSkillContent`, `slugify`, a `SkillCandidate` interface, and a
// `detectSkillCandidates` that actually walks pattern → instance_of edges.
//
// sharpwave-core's skill-evolution.ts is a deliberate STUB (verified in
// src/skill-evolution.ts): skill evolution writes files into the host agent's
// workspace skills directory and hooks the prompt pipeline, which has no meaning
// in the engine / MCP-server context. It exports only:
//   - detectSkillCandidates(agentId, config): unknown[]  → always []
//   - generateSkill(agentId, candidate, config, log): null → always null
//
// skill-evolution is NOT on the plan's port list, so the stub is the intended
// core surface. The clawbrain-v4 cases covering buildSkillContent / slugify /
// real candidate detection (7 of 8) were removed. These cases pin the stub
// contract instead.

describe("skill-evolution (sharpwave-core stub)", () => {
  it("detectSkillCandidates returns [] when skillEvolution is disabled", () => {
    const id = fresh();
    const candidates = detectSkillCandidates(id, { ...DEFAULT_CONFIG, skillEvolution: false });
    expect(candidates).toEqual([]);
    closeDb(id);
  });

  it("detectSkillCandidates returns [] even when skillEvolution is enabled (stub)", () => {
    const id = fresh();
    const candidates = detectSkillCandidates(id, {
      ...DEFAULT_CONFIG,
      skillEvolution: true,
      skillEvolveMinPatternCount: 3,
    });
    expect(candidates).toEqual([]);
    closeDb(id);
  });

  it("generateSkill returns null (stub)", () => {
    const id = fresh();
    const log = { info: () => {}, warn: () => {} };
    expect(generateSkill(id, {}, DEFAULT_CONFIG, log)).toBeNull();
    closeDb(id);
  });
});
