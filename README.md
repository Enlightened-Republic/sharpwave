# Xanima

> **Current release: 0.6.0** (2026-10-19), on npm as
> [`xanima`](https://www.npmjs.com/package/xanima) (MCP server) and
> [`xanima-core`](https://www.npmjs.com/package/xanima-core) (engine); the
> OpenClaw plugin [`xanima-openclaw`](https://github.com/Enlightened-Republic/xanima-openclaw)
> 0.6.0 vendors the same engine. Highlights: forgetting makes memories dormant
> instead of deleting them (`brain_query {include_dormant: true}` revives them);
> identity changes only with the owner by default; completed plans compile into
> step-by-step procedures that become rules once verified; `brain_expand
> {source_turns: N}` shows the conversation a memory came from; plus a full
> audit-fix pass (loopback-only default bind, complete `brain_reset`,
> consistent backups). Additive schema v26–v27. Full history, including
> 0.1.0–0.5.0: [CHANGELOG.md](CHANGELOG.md).

*Formerly Sharpwave.* Upgrading from `sharpwave` / `openwave`: install
`xanima` (the `sharpwave` bin is kept as an alias) or `xanima-openclaw`, rename
`SHARPWAVE_*` env vars to `XANIMA_*` (the old names are still read, with a
one-time deprecation warning, and will be removed in a later release), and run
`xanima-server migrate` to copy `~/.sharpwave` to `~/.xanima` (it verifies every
brain and never moves or deletes the old folder). Until then `~/.sharpwave` is
used when `~/.xanima` does not exist.

**A long-term memory MCP server for AI agents.** It remembers across sessions,
forgets what stops mattering, and consolidates the rest — modeled on how human
memory actually works, not a vector store with extra steps.

```bash
npx -y xanima
```

Works with Claude Code, Claude Desktop, Cursor, and any other MCP client.

> **Building on [OpenClaw](https://openclaw.ai)?** Use **[xanima-openclaw](https://github.com/Enlightened-Republic/xanima-openclaw)**
> instead — the same engine as a native OpenClaw plugin. It does everything this
> MCP server does, *plus* it injects the relevant memories into every agent turn
> automatically (no tool call) and runs the sleep system in-process.
> `openclaw plugins install npm:xanima-openclaw --force --accept-capabilities`

---

## Repository layout

npm-workspaces monorepo, three packages:

- **`packages/core`** — [`xanima-core`](https://www.npmjs.com/package/xanima-core),
  the memory engine (retrieval, consolidation, extraction, the FSRS forgetting
  curve, the graph). Published to npm as the shared engine behind both the
  `xanima` MCP server and the [`xanima-openclaw`](https://github.com/Enlightened-Republic/xanima-openclaw)
  OpenClaw plugin.
- **`packages/mcp`** — [`xanima`](https://www.npmjs.com/package/xanima),
  the stdio MCP server. This is what `npm i xanima` / `npx -y xanima`
  installs.
- **`packages/server`** — `xanima-server` (private, not published; build it from
  source), the **brain service**: one process that owns a `shared` brain plus
  one private brain per agent and serves the brain tools over MCP Streamable
  HTTP on `127.0.0.1:18790` (+ any tailnet IPs you configure) with per-agent
  bearer tokens, plus the dependency-free `xanima-client` CLI. See
  [`packages/server/README.md`](packages/server/README.md).

The OpenClaw plugin lives in its own repo:
[`Enlightened-Republic/xanima-openclaw`](https://github.com/Enlightened-Republic/xanima-openclaw).

`xanima-core` is bundled into each consumer at build time, so `xanima` and
`xanima-openclaw` always ship the exact engine they were built against — there is no
version-skew path between them. It is a **devDependency** of both consumers, not
a runtime one — esbuild inlines it, so `npm install xanima` never needs to
resolve it at install time.

`npm run test:pack` is the pre-publish gate: it packs `xanima`, installs the
tarball in a clean workspace-free directory (where a stray runtime dep on
`xanima-core` would fail), and drives the installed server over MCP. Run it
before every `npm publish`. It is not part of `npm run test:all` (slow, and the
`npm install` touches the network).

---

## The problem

Your agent forgets everything the moment a session ends. The usual fix is to dump conversation history into a vector store and retrieve the nearest chunks — which works until it doesn't:

- **It never forgets.** Every note lives forever at equal weight, so a throwaway remark from March competes with something that actually matters.
- **It has no structure.** A pile of embeddings can tell you what's *similar*. It can't tell you what *caused* what, or that one fact replaced another.
- **Recall degrades as it grows.** More memories means more near-matches, and precision falls off exactly when the memory becomes worth having.

Human memory doesn't work that way. It decays on a curve, strengthens what gets used, consolidates related things into concepts, and lets the rest fade. Xanima models that.

The design centres on **sharp-wave ripples** (the source of the project's former name) — the hippocampal events that replay and consolidate memories during rest. That's the mechanism this is built around, not a metaphor bolted on afterward.

## What makes it different

**A real forgetting curve.** Every memory carries FSRS-6 stability and retrievability. Unused memories decay on a power-law curve and drop out of recall; reviewed ones strengthen. Importance and emotional weight scale how durable a memory starts out.

**Consolidation, not just storage.** A background pass replays recent episodes, promotes recurring patterns into durable semantic nodes, synthesizes clusters into higher-level schemas, and downscales the noise — modeled on slow-wave and REM sleep.

**A graph, not a bag.** Memories connect through typed edges — `caused_by`, `supports`, `contradicts`, `supersedes`, `instance_of` and more. Retrieval spreads activation across those edges, so recalling one thing surfaces what's genuinely related, not merely similar.

**Memories can be replaced.** `brain_supersede` closes out a stale memory and links the replacement, so the graph keeps its temporal integrity instead of accumulating contradictions.

**Hybrid retrieval.** Full-text search fused with vector similarity via reciprocal rank fusion, then spread across the graph. Vector search is optional — full-text and graph retrieval work with no embedding provider at all.

**Multi-agent by design.** One Xanima process can back any number of agents at
once. Each agent's memories live in their own database — isolated, never
cross-contaminated — under a single config entry.

## Install

Xanima is a standard stdio MCP server. Point any MCP client at `npx -y xanima`.

### Any MCP client

Add to the client's MCP config (`claude_desktop_config.json`, Cursor's `mcp.json`,
or equivalent):

```json
{
  "mcpServers": {
    "xanima": {
      "command": "npx",
      "args": ["-y", "xanima"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add xanima -- npx -y xanima
```

### OpenClaw

The native plugin is the recommended path (see above). To use the MCP server instead:

```bash
openclaw mcp add xanima --command npx --arg -y --arg xanima
openclaw mcp doctor xanima --probe
```

### Multi-agent

Leave `XANIMA_AGENT_ID` unset and one Xanima process serves any number of
agents: every `brain_*` call carries the calling agent's own `agent` id and is
routed to its own database at `~/.xanima/<agent>/brain.db`. `XANIMA_AGENTS`
(comma-separated) restricts which ids are accepted. To pin one server to a single
agent, set `XANIMA_AGENT_ID=<id>` — the `agent` argument then becomes optional,
and if passed it must match.

Memory lands in `~/.xanima/` as a SQLite database (`~/.sharpwave/` on an
install that has not been migrated yet). Nothing leaves your machine unless you configure a remote embedding provider.

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
| `brain_review` | Apply an FSRS-6 spaced-repetition review to a node (`node_id` + `quality`). With `action` (0.4.0): the pending-review queue for soul imports and merge conflicts (`list` / `show`; `accept` / `reject` need an admin). |
| `brain_forget` | Physically delete a node from the brain. Refuses to delete nodes with active edges unless `force=true`. |
| `brain_edges` | Get all active incoming and outgoing edges for a node. |
| `brain_reset` | Wipe an agent's brain back to empty (a `.db` backup is taken first). `confirm` must equal the agent id. |
| `brain_retract` | Retract a wrong memory (reason required); it is kept as history but never recalled again. |
| `brain_status` | Short self-status: counts, low-confidence / disputed / dormant items, conflicts, last sleep summary, anything needing attention. |
| `brain_record_decision` / `brain_update_decision_outcome` / `brain_query_decisions` | Decision ledger: context, options, choice, predicted vs actual outcome, lesson. |
| `brain_set_goal` / `brain_update_goal` / `brain_list_goals` | Versioned goals with drift checking and keyword / time triggers. |
| `brain_reflect` / `brain_replay` | Stored reflections ("what worked / didn't / try next") and compressed decision → outcome → lesson trajectories. |
| `brain_hypothesis` / `brain_question` / `brain_list_open` | Hypotheses, assumptions and open questions with evidence and status. |
| `brain_commit` / `brain_commitments` / `brain_plan` | Commitments with due dates and blockers; plans with steps (park / resume with a briefing; done plans compile into procedures). |
| `brain_changes` / `brain_conflicts` / `brain_briefing` / `brain_forget_impact` | Read-only meta-tools: what changed, contradictions, resume briefings, dry-run forgetting impact. |
| `brain_export_soul` | Export your own Soul Package (`xanima-soul/1`): identity, values, goals, skills, lessons, key facts with provenance and a sha256 hash. Compact JSON or a summary. |

In multi-agent mode every tool above also takes a required `agent` argument.

The brain service (`xanima-server`) and the OpenClaw plugin add further tools,
including `brain_focus` (suppress or boost a topic / project / room / type in
recall for N turns or a task) and the room tools below.

### Soul Packages (0.4.0)

Carry an agent's identity, goals, skills, lessons and key facts to a fresh brain on another machine or runtime, or fork it and merge the changes back with a three-way merge. Identity, values and goal changes from imports always wait in a review queue; nothing is overwritten. CLI: `xanima-server soul export | fork | import | diff | merge | review | validate | keygen`. Library: `exportSoul`, `importSoul`, `mergeSoul`, `validateSoul` from `xanima-core`. Format: [`packages/core/schema/xanima-soul-1.schema.json`](packages/core/schema/xanima-soul-1.schema.json). Guide: [docs/portability.md](docs/portability.md).

### Rooms, injection control and quarantine (0.5.0)

On `xanima-server`, **rooms** are named namespaces with members (read / write / admin). Agents publish selected memories into a room with provenance (`brain_publish`), search it (`brain_room_query`), subscribe so relevant room items show up in recall tagged `[type·room·writer]` (`brain_subscribe`), and admins create / invite / revoke (`brain_room`, or `xanima-server room …`). Conflicting claims are kept side by side and recorded; nothing is overwritten. Isolation stays the default; the `shared` brain is unchanged. Guide: [docs/rooms.md](docs/rooms.md).

**Injection control:** `brain_focus`, `injectionCategories` switches, and sensitivity labels honoured in recall. **Poisoning quarantine:** writes that would change identity, values, goals or rules from untrusted sources (tool output, other agents, imports, injection-looking text) are logged (`quarantine: "log"`, the default) or held for review (`"enforce"`). Security model: [docs/security-model.md](docs/security-model.md).

## Memory types

Every node is typed, and the type affects how it's consolidated and retrieved:

`identity` · `semantic` · `episodic` · `pattern` · `skill` · `goal` · `emotion` · `procedural` · `schema`

## Configuration

All optional. Xanima runs with zero configuration.

| Variable | Default | Purpose |
|---|---|---|
| `XANIMA_DATA_DIR` | `~/.xanima` | Where the databases live (`~/.sharpwave` if `~/.xanima` does not exist and `~/.sharpwave` does) |
| `XANIMA_DB_PATH` | — | Full path to a specific database file, overriding `DATA_DIR`. Single-agent only: with `AGENT_ID` unset the server refuses to start rather than route every agent into one file. |
| `XANIMA_AGENT_ID` | — | Pin the server to one agent. **Leave unset for multi-agent mode** — one server for the whole fleet, each `brain_*` call then requires an `agent` argument routing it to `<DATA_DIR>/<agent>/brain.db`. |
| `XANIMA_AGENTS` | — | Multi-agent mode only: comma-separated allowlist of accepted `agent` ids |
| `XANIMA_EMBEDDING_MODEL` | — | e.g. `ollama/qwen3-embedding:0.6b` |
| `OLLAMA_BASE_URL` | `http://localhost:11434` | Local embedding endpoint |
| `OPENROUTER_API_KEY` | — | Enables remote embeddings and generative consolidation |
| `XANIMA_NO_UPDATE_CHECK` | — | Set to disable the update check entirely |
| `XANIMA_OBSERVABILITY` | — | Set to `1` to enable JSONL event log at `${XANIMA_DATA_DIR}/brain_events.jsonl`. Default OFF — zero overhead when unset. |
| `XANIMA_EMBEDDING_CACHE_MAXSIZE` | `1024` | Max entries in the embedding LRU cache. |
| `XANIMA_FTS_OPTIMIZE_EVERY` | `100` | Number of writes between automatic FTS5 `optimize` runs. Set to `0` to disable. |

Every `XANIMA_*` variable is also read under its old `SHARPWAVE_*` name (e.g.
`SHARPWAVE_DATA_DIR`) when the new one is unset, with a one-time deprecation
warning. Rename them; the aliases will be removed in a later release.

### Update notifications

Once a day, Xanima asks the npm registry for its own latest version number and
prints a single line to stderr if you are behind. It sends no identifiers and
uploads nothing, runs after the server is already serving, and stays silent on
failure — offline, blocked, or slow all resolve to no output.

To turn it off, set `XANIMA_NO_UPDATE_CHECK=1`. It is also off automatically
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
    "xanima": {
      "command": "npx",
      "args": ["-y", "xanima"],
      "env": {
        "XANIMA_EMBEDDING_MODEL": "ollama/qwen3-embedding:0.6b",
        "OLLAMA_BASE_URL": "http://localhost:11434"
      }
    }
  }
}
```

For a cloud provider instead, set `OPENROUTER_API_KEY` and
`XANIMA_EMBEDDING_MODEL=openai/text-embedding-3-small`. Pick one and stay on
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
- **Single-writer per brain.** SQLite with WAL. One server process per database; pointing two at the same file is not supported. Connections set `PRAGMA busy_timeout` (default 5000 ms via `XANIMA_BUSY_TIMEOUT_MS`) so brief lock waits do not surface as `SQLITE_BUSY`; the supported multi-agent path remains the shared-brain service.
- **Consolidation is time-based.** Memory quality improves as passes accumulate. A brand-new database is a plain store until it has history to work with.

## Companion tools

The `tools/` directory holds standalone Node scripts for memory maintenance and
meta-reasoning. They operate on any Xanima brain database directly.

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
