/**
 * Tests for shared utility functions in src/utils.ts.
 * Covers: classifySentence (all node types), importanceForType, jaccardSim,
 *         agentIdFromKey (Code-1 P1-1 fix), BoundedTtlMap / BoundedTtlSet (T3.4)
 */

import { describe, it, expect } from "vitest";
import {
  classifySentence,
  importanceForType,
  jaccardSim,
  agentIdFromKey,
  BoundedTtlMap,
  BoundedTtlSet,
} from "../src/utils.js";

// NOTE (openwave/sharpwave-core split, Task 3): the clawbrain-v4 utils.ts also
// exported `resolveChatLlmRoute`, `resolveChatLlmChain`, `extractBalancedJson`
// and `stripControlDirectives`. sharpwave-core's utils.ts does not carry those
// (chat-LLM routing + control-directive stripping are host-agent concerns that
// live outside the engine and are not on the plan's port list). The three
// describe blocks covering them were removed here rather than left failing.

// ─── classifySentence ─────────────────────────────────────────────────────────

describe("classifySentence — existing types", () => {
  it("returns null for sentences under 25 chars", () => {
    expect(classifySentence("I am short")).toBeNull();
    expect(classifySentence("Short sentence here.")).toBeNull();
  });

  it("identity: i am / my name is / i value (no emotion words present)", () => {
    expect(classifySentence("I am a morning person who works best in quiet environments")).toBe("identity");
    expect(classifySentence("I am a developer at Enlightened Republic working on AI infrastructure")).toBe("identity");
    expect(classifySentence("My name is Marik and I work with distributed systems")).toBe("identity");
    expect(classifySentence("I value honesty above almost everything else in my work")).toBe("identity");
    expect(classifySentence("I prefer to communicate via text rather than voice calls")).toBe("identity");
  });

  it("skill: how to / procedure / technique", () => {
    expect(classifySentence("How to deploy a Node.js app to production using Docker containers")).toBe("skill");
    expect(classifySentence("The technique for optimizing SQLite queries with proper indexes")).toBe("skill");
    expect(classifySentence("To execute the migration, run npx tsx migrate.ts in the project root")).toBe("skill");
  });

  it("pattern: always / usually / habit", () => {
    expect(classifySentence("The user always asks follow-up questions after initial explanations")).toBe("pattern");
    expect(classifySentence("I usually start my sessions by reviewing the morning brief context")).toBe("pattern");
    expect(classifySentence("There is a recurring habit of opening with project status updates")).toBe("pattern");
  });

  it("semantic: factual definitions with length > 40", () => {
    expect(classifySentence("SQLite is an embedded relational database engine written in C")).toBe("semantic");
    expect(classifySentence("The Ebbinghaus forgetting curve refers to the exponential loss of memory over time")).toBe("semantic");
  });

  it("episodic: time-anchored event statements", () => {
    expect(classifySentence("Yesterday we finished the migration and everything went smoothly")).toBe("episodic");
    expect(classifySentence("During the last session we debugged the spreading activation logic")).toBe("episodic");
    expect(classifySentence("Today I completed the professional audit of the entire codebase")).toBe("episodic");
  });

  it("returns null when no pattern matches", () => {
    expect(classifySentence("Completely abstract sentence with no recognizable category markers")).toBeNull();
  });
});

describe("classifySentence — NEW types: goal, emotion, procedural", () => {
  // ── Goal ──────────────────────────────────────────────────────────────────
  it("goal: i want to", () => {
    expect(classifySentence("I want to build a distributed memory system for AI agents")).toBe("goal");
  });

  it("goal: i need to", () => {
    expect(classifySentence("I need to finish the authentication layer before the deadline")).toBe("goal");
  });

  it("goal: i'm trying to", () => {
    expect(classifySentence("I'm trying to make the consolidation phase run faster at scale")).toBe("goal");
  });

  it("goal: i am trying to", () => {
    expect(classifySentence("I am trying to understand why the FTS index was empty after migration")).toBe("goal");
  });

  it("goal: my goal is", () => {
    expect(classifySentence("My goal is to ship a working v3 plugin within the next two days")).toBe("goal");
  });

  it("goal: i plan to", () => {
    expect(classifySentence("I plan to refactor the extraction pipeline to use streaming responses")).toBe("goal");
  });

  it("goal: i aim to", () => {
    expect(classifySentence("I aim to reduce the consolidation time gate from 24 hours to 12 hours")).toBe("goal");
  });

  it("goal: working toward", () => {
    expect(classifySentence("I have been working toward a cleaner entity resolution algorithm")).toBe("goal");
  });

  it("goal: takes priority over skill when both patterns present", () => {
    // "I want to learn how to deploy" has both goal and skill patterns — goal wins
    expect(classifySentence("I want to learn how to deploy ClawBrain in production environments")).toBe("goal");
  });

  // ── Emotion ───────────────────────────────────────────────────────────────
  it("emotion: i feel [emotion word]", () => {
    expect(classifySentence("I feel really proud of how the consolidation system turned out")).toBe("emotion");
    expect(classifySentence("I feel frustrated when the tests take more than five minutes to run")).toBe("emotion");
  });

  it("emotion: i felt [emotion word]", () => {
    expect(classifySentence("I felt overwhelmed when I first looked at the full codebase scope")).toBe("emotion");
    expect(classifySentence("I felt grateful when the migration ran without losing any data")).toBe("emotion");
  });

  it("emotion: i'm [emotion word]", () => {
    expect(classifySentence("I'm excited about the Hebbian learning system and how it will work")).toBe("emotion");
    expect(classifySentence("I'm worried that the spreading activation threshold is too high")).toBe("emotion");
  });

  it("emotion: i am [emotion word] (full form, not contraction)", () => {
    // "I am excited" must be emotion, not identity — emotion is checked before identity
    expect(classifySentence("I am excited about the Hebbian learning system going live next week")).toBe("emotion");
    expect(classifySentence("I am proud of how far this codebase has come in just a few days")).toBe("emotion");
  });

  it("emotion: i was [emotion word]", () => {
    expect(classifySentence("I was nervous about running the stress tests on the live database")).toBe("emotion");
  });

  it("emotion: does NOT trigger on 'i feel that' (belief, not state)", () => {
    // "I feel that we should" doesn't have an emotion word
    expect(classifySentence("I feel that we should refactor the extraction module before adding features")).not.toBe("emotion");
  });

  it("emotion: does NOT trigger on 'it feels cold' (not first-person state)", () => {
    // no matching "i [feel/felt/am/was]" pattern
    expect(classifySentence("It feels cold in this office and the temperature affects productivity")).not.toBe("emotion");
  });

  // ── Procedural ────────────────────────────────────────────────────────────
  it("procedural: step N", () => {
    expect(classifySentence("Step 1: Create the database, step 2: run migrations, step 3: start the gateway")).toBe("procedural");
    expect(classifySentence("Step 3 is to configure the embedding model in the plugin config")).toBe("procedural");
  });

  it("procedural: first, then", () => {
    expect(classifySentence("First, run the migration script, then restart the OpenClaw gateway")).toBe("procedural");
  });

  it("procedural: do the following", () => {
    expect(classifySentence("Do the following: install the sqlite-vec extension and reload the plugin")).toBe("procedural");
  });

  it("procedural: following steps", () => {
    expect(classifySentence("The following steps will deploy ClawBrain v3 to your production environment")).toBe("procedural");
  });

  it("procedural: takes priority over skill", () => {
    // "Step 1: how to connect" has both procedural and skill patterns — procedural wins
    expect(classifySentence("Step 1: how to connect the database to the embedding service")).toBe("procedural");
  });
});

// ─── importanceForType ────────────────────────────────────────────────────────

describe("importanceForType", () => {
  it("returns correct importance for all node types", () => {
    expect(importanceForType("identity")).toBe(0.85);
    expect(importanceForType("goal")).toBe(0.80);
    expect(importanceForType("schema")).toBe(0.80);
    expect(importanceForType("skill")).toBe(0.75);
    expect(importanceForType("procedural")).toBe(0.75);
    expect(importanceForType("pattern")).toBe(0.70);
    expect(importanceForType("emotion")).toBe(0.65);
    expect(importanceForType("semantic")).toBe(0.60);
    expect(importanceForType("episodic")).toBe(0.45);
  });

  it("returns 0.5 for unknown types", () => {
    expect(importanceForType("unknown_type")).toBe(0.5);
    expect(importanceForType("")).toBe(0.5);
  });

  it("goal importance is higher than skill (goals drive norepinephrine)", () => {
    expect(importanceForType("goal")).toBeGreaterThan(importanceForType("skill"));
  });

  it("identity importance is highest — core self-model nodes are most stable", () => {
    const all = ["identity", "goal", "schema", "skill", "procedural", "pattern", "emotion", "semantic", "episodic"];
    const maxImportance = Math.max(...all.map(importanceForType));
    expect(importanceForType("identity")).toBe(maxImportance);
  });

  it("episodic importance is lowest — specific events fade fastest", () => {
    const all = ["identity", "goal", "schema", "skill", "procedural", "pattern", "emotion", "semantic", "episodic"];
    const minImportance = Math.min(...all.map(importanceForType));
    expect(importanceForType("episodic")).toBe(minImportance);
  });
});

// ─── jaccardSim ───────────────────────────────────────────────────────────────

describe("jaccardSim", () => {
  it("returns 1.0 for identical strings", () => {
    expect(jaccardSim("hello world", "hello world")).toBe(1.0);
  });

  it("returns 0 for completely disjoint strings", () => {
    expect(jaccardSim("apple orange banana", "dog cat fish")).toBe(0);
  });

  it("returns 0 for empty strings", () => {
    expect(jaccardSim("", "")).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(jaccardSim("Hello World", "hello world")).toBe(1.0);
  });

  it("returns partial overlap correctly", () => {
    // "the brain" vs "the mind" — "the" is shared
    // setA = {the, brain}, setB = {the, mind}, intersection = {the} = 1, union = {the, brain, mind} = 3
    expect(jaccardSim("the brain", "the mind")).toBeCloseTo(1 / 3);
  });

  it("threshold 0.8 catches near-duplicates", () => {
    expect(jaccardSim("Pattern: recurring debug sessions", "Pattern: recurring debug sessions")).toBeGreaterThan(0.8);
    expect(jaccardSim("totally unrelated phrase", "completely different content")).toBeLessThan(0.3);
  });
});

// ─── agentIdFromKey — Code-1 P1-1 fix ──────────────────────────────────────────

describe("agentIdFromKey — session-key parsing", () => {
  const agents = ["main", "marik", "cael"];

  it("returns configAgents[0] for empty session key", () => {
    expect(agentIdFromKey("", agents)).toBe("main");
  });

  it("returns 'main' as fallback when no agents configured", () => {
    expect(agentIdFromKey("", [])).toBe("main");
  });

  it("extracts agent from agent:<id> prefix", () => {
    expect(agentIdFromKey("agent:main:foo:bar", agents)).toBe("main");
    expect(agentIdFromKey("agent:marik", agents)).toBe("marik");
  });

  it("non-agent-prefixed keys: returns matching segment if it exists in configAgents", () => {
    // Telegram key format: "telegram:<contact>:<chat-id>"
    expect(agentIdFromKey("telegram:hailey:chat-12345", agents)).toBe("main"); // no match in agents → fallback
    expect(agentIdFromKey("telegram:marik:chat-99", agents)).toBe("marik");    // "marik" is in agents
    expect(agentIdFromKey("discord:cael:channel-2", agents)).toBe("cael");
  });

  it("does NOT return the channel name as agent (P1-1 regression)", () => {
    // Prior bug: split(":")[0] returned "telegram" → not in agents → entire
    // channel silently lost brain functionality.
    expect(agentIdFromKey("telegram:foo:bar", agents)).not.toBe("telegram");
    expect(agentIdFromKey("discord:foo:bar", agents)).not.toBe("discord");
  });

  it("multi-segment key with no agent match falls back to configAgents[0]", () => {
    expect(agentIdFromKey("slack:randomuser:DMID", agents)).toBe("main");
  });
});

// ─── BoundedTtlMap / BoundedTtlSet — Tier 3 T3.4 ───────────────────────────────

describe("BoundedTtlMap — LRU + TTL bounded cache", () => {
  it("keeps size below capacity even after many sets", () => {
    const m = new BoundedTtlMap<string>(256, 60_000);
    for (let i = 0; i < 300; i++) {
      m.set(`session-${i}`, `value-${i}`);
    }
    expect(m.size).toBeLessThanOrEqual(256);
  });

  it("evicts the oldest entry first when over capacity", () => {
    const m = new BoundedTtlMap<string>(3, 60_000);
    m.set("a", "1");
    m.set("b", "2");
    m.set("c", "3");
    m.set("d", "4"); // forces eviction of "a"
    expect(m.has("a")).toBe(false);
    expect(m.has("b")).toBe(true);
    expect(m.has("c")).toBe(true);
    expect(m.has("d")).toBe(true);
    expect(m.size).toBe(3);
  });

  it("returns undefined for expired entries (TTL gate)", async () => {
    const m = new BoundedTtlMap<string>(10, 5); // 5ms TTL
    m.set("k", "v");
    expect(m.get("k")).toBe("v");
    await new Promise((r) => setTimeout(r, 20));
    expect(m.get("k")).toBeUndefined();
    expect(m.has("k")).toBe(false);
  });

  it("clear() empties the map", () => {
    const m = new BoundedTtlMap<string>(10, 60_000);
    m.set("a", "1");
    m.set("b", "2");
    m.clear();
    expect(m.size).toBe(0);
  });

  it("delete() removes a specific key", () => {
    const m = new BoundedTtlMap<string>(10, 60_000);
    m.set("a", "1");
    m.set("b", "2");
    m.delete("a");
    expect(m.has("a")).toBe(false);
    expect(m.has("b")).toBe(true);
  });

  it("re-setting an existing key refreshes its LRU position", () => {
    const m = new BoundedTtlMap<string>(3, 60_000);
    m.set("a", "1");
    m.set("b", "2");
    m.set("c", "3");
    m.set("a", "1-refreshed"); // "a" now most-recent
    m.set("d", "4");           // evicts "b" (now oldest), not "a"
    expect(m.has("a")).toBe(true);
    expect(m.has("b")).toBe(false);
    expect(m.has("c")).toBe(true);
    expect(m.has("d")).toBe(true);
  });
});

describe("BoundedTtlSet — sibling for sessionId tracking", () => {
  it("size is bounded under heavy add()", () => {
    const s = new BoundedTtlSet(256, 60_000);
    for (let i = 0; i < 300; i++) s.add(`session-${i}`);
    expect(s.size).toBeLessThanOrEqual(256);
  });

  it("has() honors TTL", async () => {
    const s = new BoundedTtlSet(10, 5);
    s.add("k");
    expect(s.has("k")).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(s.has("k")).toBe(false);
  });

  it("clear() empties the set", () => {
    const s = new BoundedTtlSet(10, 60_000);
    s.add("a");
    s.add("b");
    s.clear();
    expect(s.size).toBe(0);
  });
});

// NOTE (Task 3): the clawbrain-v4 `stripControlDirectives` regression block was
// removed — that helper is not part of sharpwave-core's utils.ts (see the import
// note at the top of this file).
