# Sharpwave

**Long-term memory for AI agents.** An MCP server that remembers across sessions, forgets what stops mattering, and consolidates the rest.

```bash
npx -y sharpwave
```

Works with Claude Code, Claude Desktop, Cursor, and any other MCP client.

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

## Install

### Claude Code

```bash
claude mcp add sharpwave -- npx -y sharpwave
```

### Claude Desktop / Cursor

Add to your MCP config (`claude_desktop_config.json`, or Cursor's `mcp.json`):

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

That's the whole setup. Memory lands in `~/.sharpwave/` as a SQLite database. Nothing leaves your machine unless you configure a remote embedding provider.

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
| `brain_health` | Liveness + observability diagnostics: counters, embedding cache, FTS state, last consolidation timestamp. Zero side effects. |

## Memory types

Every node is typed, and the type affects how it's consolidated and retrieved:

`identity` · `semantic` · `episodic` · `pattern` · `skill` · `goal` · `emotion` · `procedural` · `schema`

## Configuration

All optional. Sharpwave runs with zero configuration.

| Variable | Default | Purpose |
|---|---|---|
| `SHARPWAVE_DATA_DIR` | `~/.sharpwave` | Where the database lives |
| `SHARPWAVE_DB_PATH` | — | Full path to a specific database file, overriding `DATA_DIR` |
| `SHARPWAVE_AGENT_ID` | `default` | Namespace for separate, isolated memories. **Leave unset for multi-agent mode** — one server for many agents, each `brain_*` call then requires an `agent` argument routing it to `<DATA_DIR>/<agent>/brain.db`. |
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
        "SHARPWAVE_EMBEDDING_MODEL": "ollama/qwen3-embedding:0.6b"
      }
    }
  }
}
```

Multiple isolated memories — one per project, say — are just separate `SHARPWAVE_AGENT_ID` values.

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
- **Single-writer.** SQLite with WAL. One server process per database; pointing two at the same file is not supported.
- **Consolidation is time-based.** Memory quality improves as passes accumulate. A brand-new database is a plain store until it has history to work with.


## Recent updates (v0.3.0)

Ports the ClawBrain v0.4.0 audit fixes into the TypeScript codebase.
All changes are additive — the existing API is preserved.

- **WAL retry** — every critical write path (nodes, edges, episodes,
  meta, self-model, forget) now retries on `SQLITE_BUSY` /
  `SQLITE_LOCKED` with exponential backoff (100ms → 200ms → 400ms +
  0–50ms jitter, 3 attempts). Async + sync variants.
- **Embedding LRU cache** — `Map`-based, default 1024 entries,
  `SHARPWAVE_EMBEDDING_CACHE_MAXSIZE` override. Re-entrancy guard
  via a busy-key flag. Exposes `embeddingCacheStats()`.
- **MinHash entity resolution** — `findNearDuplicates` with embedding
  cosine fast path + character-trigram Jaccard fallback;
  `deduplicateExisting` union-find grouping for offline maintenance;
  `mergeCoreferentNodes` wires `coreference_of` edges.
- **FTS5 maintenance** — `maintenance()` runs rebuild + optimize;
  `bumpWriteCounter()` auto-triggers optimize every 100 writes
  (`SHARPWAVE_FTS_OPTIMIZE_EVERY` override). Graceful no-op when FTS
  tables are absent.
- **Observability** — diagnostic counters (always on) + optional
  JSONL event log when `SHARPWAVE_OBSERVABILITY=1` (default off).
  Counters surface via the new `brain_health` tool and an extended
  `brain_stats` section.
- **Input validation** — new `src/validation.ts`. All tool handlers
  that take user-provided IDs/strings now reject empty inputs and clamp
  numeric ranges; enum-style fields validate against allowlists with
  safe defaults.

## Companion tools

The companion tools ecosystem extends Sharpwave with utility scripts for memory management, consolidation, and meta-reasoning. All tools are in the 	ools/ directory and work with any Sharpwave-compatible brain.

### Available tools

| Tool | Purpose |
|------|---------|
| ractal-reason.mjs | 4-level fractal carry closure (L0 fix → L1 pattern → L2 flaw → L3 meta-rule) |
| memory-tiers.mjs | 5-tier compression lifecycle (full → summary → essence → ghost → metadata) for MEMORY.md sections |
| engram-sleep.mjs | Consolidation digest — extracts carry closures + lessons + milestones from daily logs |
| context-size.mjs | Byte-budget dashboard — tracks file sizes across memory/ |
| silent-failure-audit.mjs | Lint for silent catch blocks (LRN-20260819-001 trio) |
| rain-link-bridge.mjs | Bridge fractal-reason carry closures to brain_write + brain_link calls |
| pply-fork-patch.mjs | Patch-function architecture demo (find/replace atomic edits) |

### New patterns (2026-08-19)

- **Fractal reasoning**: Every carry closure produces a 4-level breakdown (L0 fix → L1 pattern → L2 flaw → L3 meta-rule) with explicit edge types (CAUSED_BY, LEADS_TO, CONTRADICTS, RESOLVED_BY) that link to a marley-self-corrections-sentinel node.
- **Memory tiers**: MEMORY.md sections auto-degrade through 5 tiers based on age + access count. Full → summary → essence → ghost → metadata.
- **Silent-failure trio**: surface_error must throw (not fall through to continue_normal), credential files checked before store-expiry, runtime asset copier must include .md/.txt/.yaml/.yml.

See LRN-20260819-001 for the universal pattern documentation.


## License

MIT — see [LICENSE](LICENSE).

Built by [Enlightened Republic](https://github.com/EnlightenedRepublic).
