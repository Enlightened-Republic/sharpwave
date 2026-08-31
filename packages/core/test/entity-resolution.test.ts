import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { writeNode, computePsHash, psHashHamming } from "../src/nodes.js";
import {
  jaccardShingles,
  findNearDuplicates,
  deduplicateExisting,
  mergeCoreferentNodes,
} from "../src/entity-resolution.js";
import { getDb, closeDb } from "../src/db.js";

function fresh(): string { return `test-${randomUUID().slice(0, 8)}`; }
const log = { info: () => {}, warn: () => {} };

// NOTE (openwave/sharpwave-core split, Task 3):
// clawbrain-v4's entity-resolution.ts and sharpwave-core's have DIVERGED. The
// clawbrain-v4 test covered `recordAlias` / `resolveEntity` / `getSessionAliases`
// / `clearSessionAliases` / `linkCoreference` (session alias cache + FTS-Jaccard
// entity linking) and a `psHashCompatible` / `PS_HASH_HAMMING_GATE` pair — none
// of which exist in sharpwave-core. sharpwave-core's entity-resolution.ts is the
// v0.4.0 character-trigram MinHash implementation exporting `jaccardShingles`,
// `findNearDuplicates`, `deduplicateExisting`, `mergeCoreferentNodes` (verified
// in src/entity-resolution.ts). `mergeCoreferentNodes` also has different
// semantics: it derives duplicate groups from content Jaccard (>= 0.8) and wires
// `coreference_of` edges — it does NOT soft-delete, merge content, or repoint
// edges the way clawbrain-v4's did.
//
// All 14 clawbrain-v4 cases were replaced with the ones below, which cover the
// actual sharpwave-core surface. The ps-hash gating helper is not ported;
// `computePsHash` / `psHashHamming` (from nodes.ts) are still covered here as a
// sanity companion since the clawbrain test paired them with this file.

describe("entity-resolution — trigram Jaccard", () => {
  it("jaccardShingles: identical text scores 1.0", () => {
    expect(jaccardShingles("the quick brown fox", "the quick brown fox")).toBeCloseTo(1.0, 5);
  });

  it("jaccardShingles: disjoint text scores low", () => {
    expect(jaccardShingles("aaaaaaaa", "zzzzzzzz")).toBeLessThan(0.1);
  });

  it("jaccardShingles: returns 0 when either side is empty", () => {
    expect(jaccardShingles("", "something")).toBe(0);
    expect(jaccardShingles("something", "")).toBe(0);
  });

  it("jaccardShingles: near-duplicate phrasing scores high", () => {
    const s = jaccardShingles(
      "Hailey prefers tests before shipping production code",
      "Hailey prefers tests before shipping production code.",
    );
    expect(s).toBeGreaterThan(0.8);
  });
});

describe("entity-resolution — findNearDuplicates", () => {
  it("surfaces a stored node whose content nearly matches the query", () => {
    const id = fresh();
    writeNode(id, "semantic", "fact", "The gateway restart is required after every openwave bundle change");
    const dups = findNearDuplicates(
      id,
      "The gateway restart is required after every openwave bundle change!",
      null,
      0.7,
    );
    expect(dups.length).toBeGreaterThan(0);
    expect(dups[0].similarity).toBeGreaterThanOrEqual(0.7);
    expect(dups[0].reason).toBe("minhash_jaccard");
    closeDb(id);
  });

  it("returns nothing when no stored node is similar enough", () => {
    const id = fresh();
    writeNode(id, "semantic", "unrelated", "completely different subject matter about gardening");
    const dups = findNearDuplicates(id, "quantum chromodynamics lattice simulation", null, 0.7);
    expect(dups).toEqual([]);
    closeDb(id);
  });

  it("returns [] for empty content", () => {
    const id = fresh();
    expect(findNearDuplicates(id, "")).toEqual([]);
    closeDb(id);
  });
});

describe("entity-resolution — deduplicateExisting + mergeCoreferentNodes", () => {
  it("deduplicateExisting groups near-identical nodes", () => {
    const id = fresh();
    // deduplicate:false so both rows land (writeNode's own write-time dedupe
    // would otherwise collapse them).
    writeNode(id, "semantic", "a", "OpenClaw agents wake up with memory auto-injected again", { deduplicate: false });
    writeNode(id, "semantic", "b", "OpenClaw agents wake up with memory auto-injected again.", { deduplicate: false });
    writeNode(id, "semantic", "c", "an entirely unrelated statement about the weather today", { deduplicate: false });

    const groups = deduplicateExisting(id, 0.8);
    expect(groups.length).toBe(1);
    expect(groups[0].length).toBe(2);
    closeDb(id);
  });

  it("mergeCoreferentNodes wires a coreference_of edge and is idempotent", () => {
    const id = fresh();
    writeNode(id, "semantic", "dup-a", "the subconscious tick runs on a heartbeat and drains the embedding queue", { deduplicate: false });
    writeNode(id, "semantic", "dup-b", "the subconscious tick runs on a heartbeat and drains the embedding queue!", { deduplicate: false });

    const merged = mergeCoreferentNodes(id, log);
    expect(merged).toBe(1);

    const db = getDb(id);
    const edgeCount = (db.prepare(
      "SELECT COUNT(*) as n FROM edges WHERE type = 'coreference_of' AND valid_until IS NULL",
    ).get() as { n: number }).n;
    expect(edgeCount).toBe(1);

    // Second run must not re-merge (edgeExists gate).
    expect(mergeCoreferentNodes(id, log)).toBe(0);
    closeDb(id);
  });

  it("mergeCoreferentNodes is a no-op when nothing is duplicated", () => {
    const id = fresh();
    writeNode(id, "semantic", "x", "first distinct memory about deployment", { deduplicate: false });
    writeNode(id, "semantic", "y", "second distinct memory about migrations", { deduplicate: false });
    expect(mergeCoreferentNodes(id, log)).toBe(0);
    closeDb(id);
  });
});

// ── Pattern separation hash companion (computePsHash / psHashHamming) ─────────
describe("pattern separation hash", () => {
  it("identical embeddings hash identically (Hamming 0)", () => {
    const v = new Float32Array(768);
    for (let i = 0; i < 768; i++) v[i] = Math.cos(i * 0.3);
    expect(psHashHamming(computePsHash(v), computePsHash(v))).toBe(0);
  });

  it("hand-crafted hashes: popcount of XOR is the Hamming distance", () => {
    const allOnes = Buffer.from([0xff, 0xff, 0xff, 0xff]);
    const allZero = Buffer.from([0x00, 0x00, 0x00, 0x00]);
    expect(psHashHamming(allOnes, allZero)).toBe(32);
    expect(psHashHamming(allOnes, allOnes)).toBe(0);
  });

  it("missing hash data reads as max distance", () => {
    const v = new Float32Array(10);
    expect(psHashHamming(null, computePsHash(v))).toBe(32);
  });
});
