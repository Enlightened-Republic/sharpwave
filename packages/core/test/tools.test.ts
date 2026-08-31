import { expect, test } from "vitest";
import {
  BRAIN_TOOL_DEFS,
  MCP_TOOL_NAMES,
  OPENWAVE_TOOL_NAMES,
  dispatchBrainTool,
  DEFAULT_CONFIG,
} from "../src/index.js";

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
