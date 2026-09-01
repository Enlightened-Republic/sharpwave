# Sharpwave

**Long-term memory for AI agents** — one engine that remembers across sessions,
forgets what stops mattering, and consolidates the rest. It ships in **two forms**:

| | What it is | For |
|---|---|---|
| **`sharpwave`** | a stdio **MCP server** (`npx -y sharpwave`) | Claude Code, Cursor, Claude Desktop, any MCP client |
| **`openwave`** | an **OpenClaw plugin** — same engine, runs *in-process* | OpenClaw agents |

The MCP server answers when an agent calls a `brain_*` tool. **openwave** goes
further: it hooks OpenClaw's turn lifecycle and injects the relevant memories
into *every* turn automatically — no tool call — plus runs the sleep system
(consolidation, replay, extraction) on in-process timers. Full details:
[`packages/openwave/README.md`](packages/openwave/README.md).

Both are built from one shared engine (`packages/core`), so they can never drift.

```bash
npx -y sharpwave
```

---

## Repository layout

This repository is an npm-workspaces monorepo of three packages:

- **`packages/core`** — `sharpwave-core`, the shared memory engine (retrieval,
  consolidation, extraction, the FSRS forgetting curve, the graph). Private —
  never published to npm.
- **`packages/mcp`** — `sharpwave`, the stdio MCP server published to npm. This
  is the package `npm i sharpwave` / `npx -y sharpwave` installs, for Claude
  Code, Cursor, Claude Desktop, or any other MCP client.
- **`packages/openwave`** — the **OpenClaw plugin**: the same engine plus
  autonomic wake-up hooks that inject memory into every turn and run the sleep
  system in-process. This is what OpenClaw agents run instead of the MCP server.
  See [`packages/openwave/README.md`](packages/openwave/README.md).

`sharpwave-core` is bundled into each consumer at build time, so `sharpwave` and
`openwave` always ship the exact engine they were built against — there is no
version-skew path between them. It is a **devDependency** of both consumers, not
a runtime one — esbuild inlines it, and a runtime dep on an unpublished package
would break every `npm install sharpwave`.

`npm run test:pack` is the pre-publish gate: it packs `sharpwave`, installs the
tarball in a clean workspace-free directory (where a stray runtime dep on
`sharpwave-core` would 404), and drives the installed server over MCP. Run it
before every `npm publish`. It is not part of `npm run test:all` (slow, and the
`npm install` touches the network).

---

## The problem

Your agent forgets everything the moment a session ends. The usual fix is to dump conversation history into a vector store and retrieve the nearest chunks — which works until it doesn't:

- **It never forgets.** Every note lives forever at equal weight, so a throwaway remark from March competes with something that actually matters.
- **It has no structure.** A pile of embeddings can tell you what's *similar*. It can't tell you what *caused* what, or that one fact replaced another.
- **Recall degrades as it grows.** More memories means more near-matches, and precision falls off exactly when the memory becomes worth having.

Human memory doesn't work that way. It decays on a curve, strengthens what gets used, consolidates related things into concepts, and lets the rest fade. Sharpwave models that.

The name comes from **sharp-wave ripples** — the hippocampal events that replay and consolidate memories during rest. That's the mechanism this is built around, not a metaphor bolted on afterward.

## What makes it different

**A real forgetting curve.** Every memory carries FSRS-6 stability and retrievability. Unused memories decay on a power-law curve and drop out of recall; reviewed ones strengthen. Importance and emotional weight scale how durable a memory starts out.

**Consolidation, not just storage.** A background pass replays recent episodes, promotes recurring patterns into durable semantic nodes, synthesizes clusters into higher-level schemas, and downscales the noise — modeled on slow-wave and REM sleep.

**A graph, not a bag.** Memories connect through typed edges — `caused_by`, `supports`, `contradicts`, `supersedes`, `instance_of` and more. Retrieval spreads activation across those edges, so recalling one thing surfaces what's genuinely related, not merely similar.

**Memories can be replaced.** `brain_supersede` closes out a stale memory and links the replacement, so the graph keeps its temporal integrity instead of accumulating contradictions.

**Hybrid retrieval.** Full-text search fused with vector similarity via reciprocal rank fusion, then spread across the graph. Vector search is optional — full-text and graph retrieval work with no embedding provider at all.

**Multi-agent by design.** One Sharpwave process can back any number of agents at
once. Each agent's memories live in their own database — isolated, never
cross-contaminated — under a single config entry.

## Install

Sharpwave is a standard stdio MCP server. Point any MCP client at `npx -y sharpwave`.

### Any MCP client

Add to the client's MCP config (`claude_desktop_config.json`, Cursor's `mcp.json`,
or equivalent):

```json
{
  "mcpServers": {
    "sharpwave": {
      "command": "npx",
      "args": ["-y", "sharpwave"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add sharpwave -- npx -y sharpwave
```

### OpenClaw

```bash
openclaw mcp add sharpwave --command npx --arg -y --arg sharpwave
openclaw mcp doctor sharpwave --probe
```

### Multi-agent

Leave `SHARPWAVE_AGENT_ID` unset and one Sharpwave process serves any number of
agents: every `brain_*` call carries the calling agent's own `agent` id and is
routed to its own database at `~/.sharpwave/<agent>/brain.db`. `SHARPWAVE_AGENTS`
(comma-separated) restricts which ids are accepted. To pin one server to a single
agent, set `SHARPWAVE_AGENT_ID=<id>` — the `agent` argument then becomes optional,
and if passed it must match.

Memory lands in `~/.sharpwave/` as a SQLite database. Nothing leaves your machine unless you configure a remote embedding provider.

## Tools

| Tool | What it does |
|---|---|
| `brain_query` | Search and recall memories using hybrid FTS + vector + spreading activation. Returns ranked nodes with retrievability and salience scores. |
| `brain_write` | Store a new memory node. Automatically queues for embedding and PRISM/NEXUS auto-linking. |
| `brain_link` | Create a typed edge between two existing nodes. |
| `brain_supersede` | Replace an outdated node with updated content. Closes old edges, writes a supersedes edge, preserving the memory graph's temporal integrity. |
| `brain_stats` | Return brain statistics: node/edge/episode counts, neuromodulator state, consolidation status, embedding coverage, observability counters. |
| `brain_history` | Search episode history (raw conversation turns) by keyword. |
| `brain_expand` | Get full detail for a specific node: content, FSRS metrics, encoding context, and source episodes. |
| `brain_review` | Apply an FSRS-6 spaced-repetition review to a node. Updates stability, retrievability, and SIGMA calibration. |
| `brain_forget` | Physically delete a node from the brain. Refuses to delete nodes with active edges unless `force=true`. |
| `brain_edges` | Get all active incoming and outgoing edges for a node. |
| `brain_reset` | Wipe an agent's brain back to empty (a `.db` backup is taken first). `confirm` must equal the agent id. |

In multi-agent mode every tool above also takes a required `agent` argument.

## Memory types

Every node is typed, and the type affects how it's consolidated and retrieved:

`identity` · `semantic` · `episodic` · `pattern` · `skill` · `goal` · `emotion` · `procedural` · `schema`

## Configuration

All optional. Sharpwave runs with zero configuration.

| Variable | Default | Purpose |
|---|---|---|
| `SHARPWAVE_DATA_DIR` | `~/.sharpwave` | Where the databases live |
| `SHARPWAVE_DB_PATH` | — | Full path to a specific database file, overriding `DATA_DIR` |
| `SHARPWAVE_AGENT_ID` | — | Pin the server to one agent. **Leave unset for multi-agent mode** — one server for the whole fleet, each `brain_*` call then requires an `agent` argument routing it to `<DATA_DIR>/<agent>/brain.db`. |
| `SHARPWAVE_AGENTS` | — | Multi-agent mode only: comma-separated allowlist of accepted `agent` ids |
| `SHARPWAVE_EMBEDDING_MODEL` | — | e.g. `ollama/qwen3-embedding:0.6b` |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Local embedding endpoint |
| `OPENROUTER_API_KEY` | — | Enables remote embeddings and generative consolidation |
| `SHARPWAVE_NO_UPDATE_CHECK` | — | Set to disable the update check entirely |
| `SHARPWAVE_OBSERVABILITY` | — | Set to `1` to enable JSONL event log at `${SHARPWAVE_DATA_DIR}/brain_events.jsonl`. Default OFF — zero overhead when unset. |
| `SHARPWAVE_EMBEDDING_CACHE_MAXSIZE` | `1024` | Max entries in the embedding LRU cache. |
| `SHARPWAVE_FTS_OPTIMIZE_EVERY` | `100` | Number of writes between automatic FTS5 `optimize` runs. Set to `0` to disable. |

### Update notifications

Once a day, Sharpwave asks the npm registry for its own latest version number and
prints a single line to stderr if you are behind. It sends no identifiers and
uploads nothing, runs after the server is already serving, and stays silent on
failure — offline, blocked, or slow all resolve to no output.

To turn it off, set `SHARPWAVE_NO_UPDATE_CHECK=1`. It is also off automatically
when `CI` or `NO_UPDATE_NOTIFIER` is set. With any of those, no request is made
at all.

### Enabling vector search

Full-text and graph retrieval work out of the box. Semantic similarity needs an embedding provider — the local option keeps everything on your machine:

```bash
ollama pull qwen3-embedding:0.6b
```

```json
{
  "mcpServers": {
    "sharpwave": {
      "command": "npx",
      "args": ["-y", "sharpwave"],
      "env": {
        "SHARPWAVE_EMBEDDING_MODEL": "ollama/qwen3-embedding:0.6b",
        "OLLAMA_BASE_URL": "http://localhost:11434"
      }
    }
  }
}
```

For a cloud provider instead, set `OPENROUTER_API_KEY` and
`SHARPWAVE_EMBEDDING_MODEL=openai/text-embedding-3-small`. Pick one and stay on
it — switching embedding providers on an existing brain changes the vector
dimension and needs a re-embed. See [SETUP.md](SETUP.md) for the full walkthrough
and verification steps.

## Requirements

- Node.js 22 or newer
- macOS, Linux, or Windows (x64 and arm64; prebuilt native binaries, no compiler needed)

## How retrieval works

1. **Seed** — full-text search over labels and content. Exact phrase first, then prefix-matched terms.
2. **Fuse** — if embeddings are available, vector search runs in parallel and the two rankings merge via reciprocal rank fusion. A 2-second cap means a slow or missing embedding provider degrades to full-text instead of hanging.
3. **Spread** — activation propagates across graph edges with lateral inhibition, so strongly-related memories surface and weak associations don't crowd the results.
4. **Rank** — final ordering weighs activation, salience, and FSRS retrievability, so a memory that's decayed past usefulness stays out of the way.
5. **Touch** — retrieved memories are marked as accessed, which strengthens them. Recall is itself a form of review.

## Limitations

Worth knowing before you install:

- **Generative consolidation needs an LLM.** REM-style schema synthesis and contradiction detection call OpenRouter. Without `OPENROUTER_API_KEY` the deterministic consolidation passes still run, but the generative ones are skipped.
- **Semantic similarity needs embeddings.** Without a provider you get full-text plus graph retrieval — good, but not synonym-aware.
- **Single-writer per brain.** SQLite with WAL. One server process per database; pointing two at the same file is not supported.
- **Consolidation is time-based.** Memory quality improves as passes accumulate. A brand-new database is a plain store until it has history to work with.

## Companion tools

The `tools/` directory holds standalone Node scripts for memory maintenance and
meta-reasoning. They operate on any Sharpwave brain database directly.

| Script | Purpose |
|---|---|
| `tools/fractal-reason.mjs` | 4-level reasoning closure (fix → pattern → flaw → meta-rule) over a correction |
| `tools/brain-link-bridge.mjs` | Turn a reasoning closure into `brain_write` + `brain_link` calls |
| `tools/memory-tiers.mjs` | 5-tier compression lifecycle (full → summary → essence → ghost → metadata) for long-lived notes |
| `tools/engram-sleep.mjs` | Consolidation digest — pulls carry-closures, lessons and milestones out of daily logs |
| `tools/context-size.mjs` | Byte-budget dashboard across a memory directory |
| `tools/silent-failure-audit.mjs` | Lint for silent `catch` blocks |
| `tools/apply-fork-patch.mjs` | Atomic find/replace patch helper |

## License

MIT — see [LICENSE](LICENSE).

Built by [Enlightened Republic](https://github.com/Enlightened-Republic).
