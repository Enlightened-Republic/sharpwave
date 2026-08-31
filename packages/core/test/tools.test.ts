import { expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import {
  BRAIN_TOOL_DEFS,
  MCP_TOOL_NAMES,
  OPENWAVE_TOOL_NAMES,
  dispatchBrainTool,
  DEFAULT_CONFIG,
} from "../src/index.js";
import { writeNode, getNode } from "../src/nodes.js";
import { closeDb } from "../src/db.js";

// The full 16-def union, sorted. Written out longhand on purpose: this list is
// the contract both hosts read from, so a rename or a dropped tool has to be a
// deliberate edit here, not a silent diff.
const ALL_TOOLS = [
  "brain_docs",
  "brain_edges",
  "brain_expand",
  "brain_forget",
  "brain_generate_skill",
  "brain_history",
  "brain_link",
  "brain_query",
  "brain_reflect",
  "brain_reset",
  "brain_review",
  "brain_stats",
  "brain_supersede",
  "brain_update_self_model",
  "brain_workspace",
  "brain_write",
];

test("union holds 16 tool defs", () => {
  expect(ALL_TOOLS).toHaveLength(16);
  expect(Object.keys(BRAIN_TOOL_DEFS).sort()).toEqual(ALL_TOOLS);
});

test("every def has a description and an object input schema", () => {
  for (const [name, def] of Object.entries(BRAIN_TOOL_DEFS)) {
    expect(def.description, name).toBeTruthy();
    expect(def.inputSchema.type, name).toBe("object");
  }
});

test("mcp subset is 11 and every name exists in the union", () => {
  expect(MCP_TOOL_NAMES).toHaveLength(11);
  for (const n of MCP_TOOL_NAMES) expect(BRAIN_TOOL_DEFS).toHaveProperty(n);
});

test("openwave subset is all 16", () => {
  expect([...OPENWAVE_TOOL_NAMES].sort()).toEqual(Object.keys(BRAIN_TOOL_DEFS).sort());
  expect(OPENWAVE_TOOL_NAMES).toHaveLength(16);
});

// No embedding provider is reachable in tests (setup.ts points Ollama at a dead
// port), so recall runs on FTS alone — the content has to actually share a term
// with the query. The brief's original fixture ("Production uses PostgreSQL
// 16." / "what database?") shares none, so it could never match.
test("dispatch write then query round-trips", async () => {
  const agent = "tools-test-" + Math.random().toString(36).slice(2);
  const w = await dispatchBrainTool(
    "brain_write",
    agent,
    { type: "semantic", label: "db", content: "The production database is PostgreSQL 16." },
    DEFAULT_CONFIG,
  );
  expect(w.isError).toBeFalsy();
  const q = await dispatchBrainTool("brain_query", agent, { query: "what database?" }, DEFAULT_CONFIG);
  expect(q.text.toLowerCase()).toContain("postgres");
});

test("unknown tool is an error result, not a throw", async () => {
  const r = await dispatchBrainTool("brain_nope", "x", {}, DEFAULT_CONFIG);
  expect(r.isError).toBe(true);
  expect(r.text).toBe("unknown tool: brain_nope");
});

// ─── brain_review dispatch wrapper (validate → getNode → touchNode → format) ───
// The clawbrain-v4 brain-review.test.ts was NOT ported (different result shape +
// SM-2-era output strings — a rewrite, not a port; see task-6g-report.md). These
// cases cover the sharpwave dispatch path. Assertions match the exact format the
// executor in src/tools.ts produces — read that before touching them.

function reviewAgent(): string { return "review-test-" + randomUUID().slice(0, 8); }

test("brain_review: happy path (quality 5) reports the perfect-recall outcome + R/S/σ lines", async () => {
  const agent = reviewAgent();
  const nodeId = writeNode(agent, "semantic", "fsrs review target", "the cache layer is Redis 7 on ElastiCache");

  const r = await dispatchBrainTool("brain_review", agent, { node_id: nodeId, quality: 5 }, DEFAULT_CONFIG);

  expect(r.isError).toBeFalsy();
  expect(r.text).toContain(`Reviewed: [${nodeId.slice(0, 8)}] "fsrs review target"`);
  expect(r.text).toContain("Quality: 5/5 — perfect — maximum reinforcement");
  expect(r.text).toContain("Retrievability:");
  expect(r.text).toContain("Stability:");
  expect(r.text).toContain("σ:");

  // The wrapper actually applied a review (review_count bumped via touchNode).
  const after = getNode(agent, nodeId)!;
  expect(after.review_count).toBe(1);
  closeDb(agent);
});

test("brain_review: unknown node id is an error result with a not-found message", async () => {
  const agent = reviewAgent();
  const r = await dispatchBrainTool(
    "brain_review",
    agent,
    { node_id: "00000000-0000-0000-0000-000000000000", quality: 4 },
    DEFAULT_CONFIG,
  );
  expect(r.isError).toBe(true);
  expect(r.text).toMatch(/not found/i);
  closeDb(agent);
});

test("brain_review: quality out of range is a validation error result", async () => {
  const agent = reviewAgent();
  const nodeId = writeNode(agent, "semantic", "range check node", "content for the quality-range validation check");

  const high = await dispatchBrainTool("brain_review", agent, { node_id: nodeId, quality: 7 }, DEFAULT_CONFIG);
  expect(high.isError).toBe(true);
  expect(high.text).toContain("Invalid arguments");
  expect(high.text).toContain("quality must be an integer between 0 and 5");

  const low = await dispatchBrainTool("brain_review", agent, { node_id: nodeId, quality: -1 }, DEFAULT_CONFIG);
  expect(low.isError).toBe(true);
  expect(low.text).toContain("quality must be an integer between 0 and 5");
  closeDb(agent);
});

test("brain_review: below-threshold vs at/above-threshold quality produce different outcome strings", async () => {
  const agent = reviewAgent();
  const lapseNode = writeNode(agent, "semantic", "lapse outcome node", "content reviewed at a failing quality grade");
  const okNode = writeNode(agent, "semantic", "borderline outcome node", "content reviewed at a borderline quality grade");

  const lapse = await dispatchBrainTool("brain_review", agent, { node_id: lapseNode, quality: 1 }, DEFAULT_CONFIG);
  expect(lapse.isError).toBeFalsy();
  expect(lapse.text).toContain("Quality: 1/5 — recall failed — stability reset");

  const borderline = await dispatchBrainTool("brain_review", agent, { node_id: okNode, quality: 3 }, DEFAULT_CONFIG);
  expect(borderline.isError).toBeFalsy();
  expect(borderline.text).toContain("Quality: 3/5 — borderline — minimal growth");
  closeDb(agent);
});
