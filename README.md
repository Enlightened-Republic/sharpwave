# Sharpwave

**Long-term memory for OpenClaw agents.** An MCP server that remembers across
sessions, forgets what stops mattering, and consolidates the rest.

One server, every agent, a separate brain each. Sharpwave speaks standard MCP, so
it also drops into any other MCP client — but it's built for how OpenClaw runs
fleets of agents.

```bash
npx -y sharpwave
```

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

**Built for a fleet.** One Sharpwave process backs every agent in your OpenClaw
setup. Each agent's memories live in their own database — isolated, never
cross-contaminated — and a single config entry covers all of them.

## Install

### OpenClaw

Add it once, for every agent:

```bash
openclaw mcp add sharpwave --command npx --arg -y --arg sharpwave
openclaw mcp doctor sharpwave --probe
```

Or add it straight to `~/.openclaw/openclaw.json`:

```json
{
  "mcp": {
    "servers": {
      "sharpwave": {
        "command": "npx",
        "args": ["-y", "sharpwave"],
        "env": {
          "SHARPWAVE_NO_UPDATE_CHECK": "1"
        }
      }
    }
  }
}
```

With `SHARPWAVE_AGENT_ID` left **unset**, one Sharpwave process serves every
agent. Each `brain_*` call carries the calling agent's own `agent` id and is
routed to its own database at `~/.sharpwave/<agent>/brain.db`. Give each agent an
`AGENTS.md` block that tells it to pass `agent: "<its-id>"` on every brain call:

```markdown
## Your Sharpwave brain

You have a persistent memory. On every `brain_*` call, pass `agent: "marley"`.
Recall relevant memories with `brain_query` before answering; store durable
facts with `brain_write`.
```

Set `SHARPWAVE_AGENTS` to a comma-separated list to restrict which ids the server
will accept.

To pin one server to a single agent instead, set `SHARPWAVE_AGENT_ID=<id>` — the
`agent` argument then becomes optional, and if passed it must match.

### Other MCP clients

Sharpwave is a standard stdio MCP server. It runs anywhere MCP does.

**Claude Code**

```bash
claude mcp add sharpwave -- npx -y sharpwave
```

**Claude Desktop, Cursor, and others** — add to the client's MCP config
(`claude_desktop_config.json`, Cursor's `mcp.json`, etc.):

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
  "mcp": {
    "servers": {
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
