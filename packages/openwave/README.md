# openwave

The OpenClaw plugin that gives agents autonomic wake-up memory. On every session
start, every turn (`before_prompt_build`), heartbeat, and compaction, openwave
retrieves the memories relevant to what the agent is about to do from that
agent's SharpWave brain and injects them into context — identity and goals as a
never-compacted system header, plus query-relevant recall, always-on procedural
rules, and a last-24h activity digest — so the agent "wakes up knowing." It also
runs the sleep system (SWS/REM consolidation, awake replay, LLM fact extraction)
in-process on timers. openwave shares its engine, `sharpwave-core`, with the
`sharpwave` MCP server: same brain databases, same retrieval/consolidation/
extraction code, so the two can never drift. **openwave is what OpenClaw agents
run instead of the `sharpwave` MCP server** — the MCP server is for external
clients (Cursor, Claude Code, Claude Desktop).

---

## Install

Add the built plugin to `openclaw.json`:

```jsonc
"plugins": {
  "load": { "paths": ["C:/Users/wubbu/Desktop/Projects/sharpwave/packages/openwave/dist/index.js"] },
  "entries": { "openwave": { "enabled": true, "config": { "agents": ["main"] } } }
}
```

The plugin config lives under `entries.openwave.config` (the `register` handler
also accepts fields at the top level of the entry as a fallback, but `config` is
the documented location).

**Compatibility** (`package.json` → `openclaw` block): `pluginApi >=2026.5.0`,
`minGatewayVersion 2026.5.0`. Older gateways do not expose the hook and
session-workflow surface openwave needs.

---

## Configuration

openwave's config type is `sharpwave-core`'s `BrainConfig` plus two host-only
fields (`enabled`, `agents`). At `register` time the plugin merges
`DEFAULT_OPENWAVE_CONFIG` (`= { ...core.DEFAULT_CONFIG, enabled: true, agents:
["main"] }`) with whatever you supply, then passes the whole object into every
engine call. The fields the plugin logic reads directly:

| field | type | default | meaning |
|---|---|---|---|
| `agents` | `string[]` | `["main"]` | **REQUIRED — set explicitly.** Every hook and every tool call guards on `config.agents.includes(agentId)`. An agent not in this list gets **no** memory injection, no episode logging, no sleep system — nothing. There is no safe implicit default on a multi-agent gateway; the `["main"]` default only exists so a single-agent dev box works out of the box. |
| `enabled` | `boolean` | `true` | Set `false` (or `entries.openwave.enabled: false`) and `register` returns immediately — no tools, no hooks. |
| `llmExtractionEnabled` | `boolean` | `false` | When `true`, `message_received` / `llm_output` episodes at or above `llmExtractionMinImportance` are queued for LLM fact extraction into graph nodes. When `false`, only the heuristic extractor runs. |
| `llmExtractionMinImportance` | `number` | `0.4` | Importance floor for queueing an episode for extraction. |
| `ingestionModel` | `string` | `"openrouter/deepseek/deepseek-v4-flash"` | Model for LLM fact extraction and the generative half of REM consolidation. See caveat below. |
| `openRouterApiKey` | `string` | `process.env.OPENROUTER_API_KEY` ?? `process.env.SHARPWAVE_OPENROUTER_API_KEY` ?? `""` | OpenRouter key for all engine LLM calls. If empty, extraction and generative-REM degrade to keyword/heuristic mode (non-fatal). Prefer setting the `OPENROUTER_API_KEY` env var over putting the key in `openclaw.json`. |

Engine (`BrainConfig`) fields you can also override under `config` — passed
straight through to `sharpwave-core`, defaults from `core.DEFAULT_CONFIG`:

| field | type | default | meaning |
|---|---|---|---|
| `contextBudget` | `number` | `2000` | Token budget the context assembler targets for injected recall. |
| `workingMemorySlots` | `number` | `7` | Working-memory ring size. |
| `spreadingActivationHops` | `number` | `1` | Spreading-activation hop count during recall. |
| `activationThreshold` | `number` | `0.1` | Minimum activation for a node to be recalled. |
| `inhibitionStrength` | `number` | `0.6` | Lateral-inhibition strength in activation. |
| `recallTopK` | `number` | `10` | Max nodes in a per-turn recall block. |
| `bootstrapTopK` | `number` | `15` | Max nodes in the session-start bootstrap. |
| `efDefault` | `number` | `2.5` | Starting FSRS ease factor for new nodes. |
| `retrievabilityFloor` | `number` | `0.05` | Retrievability below which a node is treated as forgotten. |
| `consolidationTimeGateHours` | `number` | `4` | Hours since last consolidation before the gate opens. |
| `consolidationEpisodeGate` | `number` | `10` | New-episode count before the consolidation gate opens. |
| `pruneAfterDays` | `number` | `90` | Age after which low-value nodes are pruned. |
| `remModel` | `string?` | _(unset)_ | REM-consolidation model override; falls through to `ingestionModel` when unset. Same bare-form caveat applies. |
| `embeddingModel` | `string` | `process.env.SHARPWAVE_EMBEDDING_MODEL` ?? `"ollama/qwen3-embedding:0.6b"` | Embedding model (1024-dim). |
| `skillEvolution` | `boolean` | `false` | Enable pattern→skill generation. |
| `skillEvolveMinPatternCount` | `number` | `5` | Pattern occurrences before a skill is generated. |
| `workspaceSkillsDir` | `string` | `""` | Output dir for `brain_generate_skill` / `brain_workspace`. |
| `brainDocsDir` | `string` | `""` | Docs corpus dir for `brain_docs`. |

Env vars read directly: `OPENROUTER_API_KEY` / `SHARPWAVE_OPENROUTER_API_KEY`
(key fallback), `SHARPWAVE_EMBEDDING_MODEL`, `SHARPWAVE_DB_PATH` /
`SHARPWAVE_DATA_DIR` (brain-db location, see below). `NVIDIA_API_KEY` is read
only for a boolean presence line in the `register` diagnostic log — the engine
is single-provider OpenRouter and does not use it.

### `ingestionModel` caveat

Use the **bare** `provider/model` form — e.g. `deepseek/deepseek-v4-flash` —
**not** `openrouter/deepseek/deepseek-v4-flash`. The engine passes this string
verbatim as the `model` field of the OpenRouter chat-completions request, and
OpenRouter rejects the `openrouter/` prefix. With the prefix, LLM fact
extraction and generative-REM consolidation silently fall back to keyword mode.
Note that `core.DEFAULT_CONFIG.ingestionModel` currently ships the prefixed
string; override it explicitly in your `openclaw.json` until the engine-side
fix lands (tracked separately).

---

## Tools

openwave registers all **16** `brain_*` tools (the 15 from ClawBrain v4 plus
`brain_reset`):

`brain_query`, `brain_write`, `brain_link`, `brain_supersede`, `brain_stats`,
`brain_history`, `brain_expand`, `brain_review`, `brain_forget`, `brain_edges`,
`brain_reset`, `brain_update_self_model`, `brain_reflect`,
`brain_generate_skill`, `brain_workspace`, `brain_docs`.

Definitions and executors both come from `sharpwave-core`'s unified tool module,
so openwave and the MCP server can never expose a drifted schema. (The MCP
server publishes a narrower 11-tool subset.)

**`brain_reset` is agent-callable.** An agent can wipe its own brain by calling
`brain_reset` with `confirm` set to exactly its own agent id. This is
intentional — it lets the Airheart Hub drive a reset by messaging the agent. It
is guarded: the `confirm` string must match the agent id exactly, and a
timestamped `.db` backup is taken (via `sharpwave-core`'s `createBackup`) before
anything is wiped. The wipe is `DELETE FROM` on every learned-state table plus a
re-seed of an empty self-model — never `DROP` — so embedding config and the
vector-table dimension are preserved. Operators driving a fleet should be aware
this tool is on the agent's tool surface.

---

## Deploy

```bash
npm run build --workspace openwave     # -> packages/openwave/dist/index.js
openclaw gateway restart               # FULL restart, not a soft plugin reload
```

The build is a single-file esbuild bundle. A soft plugin reload does **not**
bust Node's ESM module cache, so a bundled ESM plugin will keep running the old
code until a full gateway process restart. The gateway runs as the Windows
Scheduled Task "OpenClaw Gateway"; `openclaw gateway restart` restarts it.

After restart, confirm from the gateway log
(`%LOCALAPPDATA%\Temp\openclaw\openclaw-YYYY-MM-DD.log`): a
`[openwave] {"op":"register","outcome":"ok",...}` line with the expected
`agents` count and `tools:16`, followed by
`[openwave] {"op":"gateway_start","outcome":"ready",...}`.

---

## Brain databases

Brain dbs live at `~/.sharpwave/<agentId>/brain.db` (plus the SQLite `-wal` and
`-shm` sidecars). Location can be redirected with `SHARPWAVE_DATA_DIR` (parent
dir) or `SHARPWAVE_DB_PATH` (exact file) env vars.

openwave and the `sharpwave` MCP server read and write the **same files** with
the **same engine code**, so an agent can be moved between them freely with no
data migration. openwave never moves, renames, or re-locates a brain db.

The first time this build opens a db it runs the schema migration to **v17**
(from v16). v17 is **additive only**: it adds two columns to `nodes` —
`inject_count` and `inject_hits`, both `INTEGER NOT NULL DEFAULT 0` — for the
VALOR injection-utility feature, and backfills existing rows to `0`. No
destructive change, no data loss.

---

## Rollback

To move an agent back to the `sharpwave` MCP server:

1. Remove `openwave` from `plugins.load.paths` (or set
   `entries.openwave.enabled = false`).
2. Ensure the `mcp.servers.sharpwave` entry is present in `openclaw.json`.
3. `openclaw gateway restart`.

The agent is now back on the MCP server against the same brain db. There is no
data migration in either direction — the schema and files are identical. (Back
up `openclaw.json` to the scratchpad before editing, as standing practice.)
