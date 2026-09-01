# openwave

**Autonomic long-term memory for [OpenClaw](https://openclaw.ai) agents.**

openwave hooks OpenClaw's turn lifecycle. On every session start, every turn,
every heartbeat, and every compaction it pulls the memories relevant to what the
agent is about to do out of that agent's brain and **injects them into context
automatically — no tool call**. Identity and goals ride in as a never-compacted
system header; query-relevant recall, always-on procedural rules, and a last-24h
activity digest ride in as prepended context. The agent wakes up already knowing.

It also runs the sleep system in-process on timers — slow-wave/REM consolidation,
awake replay, and LLM fact extraction — so the graph keeps improving between
sessions without anything calling it.

The engine is [`sharpwave-core`](https://www.npmjs.com/package/sharpwave-core),
the same memory engine behind the [`sharpwave`](https://www.npmjs.com/package/sharpwave)
MCP server. **Use `sharpwave` (the MCP server) for Claude Code / Cursor / Claude
Desktop. Use openwave for OpenClaw** — it does everything the MCP server does,
plus the automatic per-turn injection and the in-process sleep system that an
MCP server structurally cannot.

---

## Install

### From ClawHub (recommended)

```bash
openclaw plugins install clawhub:openwave --accept-capabilities
```

### From npm

```bash
openclaw plugins install npm:openwave --accept-capabilities
```

### From source (development)

```bash
git clone https://github.com/Enlightened-Republic/openwave
cd openwave && npm install && npm run build
```

Then point `plugins.load.paths` at the checkout directory (not `dist/index.js` —
OpenClaw reads `openclaw.plugin.json` next to it):

```jsonc
"plugins": {
  "load": { "paths": ["/abs/path/to/openwave"] }
}
```

### Configure (all install methods)

Add the entry to `openclaw.json`:

```jsonc
"plugins": {
  // If plugins.allow is set (it's an exclusive allowlist), openwave MUST be in it.
  "allow": ["...your other plugin ids...", "openwave"],
  "entries": {
    "openwave": {
      "enabled": true,
      "hooks": { "allowConversationAccess": true },
      "config": { "agents": ["main"] }
    }
  }
}
```

Then restart the gateway (`openclaw gateway restart` — a full restart, not a soft
reload) and confirm from the log:

```
[openwave] {"op":"register","outcome":"ok","agents":<N>,"tools":16,...}
[openwave] {"op":"gateway_start","outcome":"ready",...}
```

**`hooks.allowConversationAccess: true` is required** — openwave is a non-bundled
plugin and its `before_prompt_build` / `agent_turn_prepare` / `llm_output` /
`agent_end` hooks read conversation content.

**`config.agents` is required and has no safe default on a multi-agent gateway.**
Every hook and tool call guards on `config.agents.includes(agentId)`; an agent
not listed gets no injection, no episode logging, no sleep system. List every
agent you want openwave to serve.

**Compatibility:** `pluginApi >= 2026.5.0`, `minGatewayVersion 2026.5.0`. Older
gateways don't expose the hook and session-workflow surface openwave needs.

---

## Configuration

openwave's config is `sharpwave-core`'s `BrainConfig` plus two host-only fields
(`enabled`, `agents`). Everything under `plugins.entries.openwave.config` is
merged over the defaults and passed straight into the engine.

| field | type | default | meaning |
|---|---|---|---|
| `agents` | `string[]` | `["main"]` | **Required.** OpenClaw agent ids openwave serves. Each routes to `~/.sharpwave/<id>/brain.db`. |
| `enabled` | `boolean` | `true` | `false` (or `entries.openwave.enabled: false`) → `register` returns immediately, no tools, no hooks. |
| `llmExtractionEnabled` | `boolean` | `false` | `true` → `message_received` / `llm_output` episodes at or above `llmExtractionMinImportance` are queued for LLM fact extraction into graph nodes. `false` → heuristic extractor only. |
| `llmExtractionMinImportance` | `number` | `0.4` | Importance floor for queueing an episode for extraction. |
| `ingestionModel` | `string` | `"openrouter/deepseek/deepseek-v4-flash"` | Model for LLM fact extraction and generative REM. `openrouter/provider/model` or bare `provider/model` both work. |
| `openRouterApiKey` | `string` | `$OPENROUTER_API_KEY` / `$SHARPWAVE_OPENROUTER_API_KEY` / `""` | OpenRouter key for engine LLM calls. Empty → extraction and generative-REM degrade to heuristic mode (non-fatal). Prefer the env var over putting the key in `openclaw.json`. |

Engine (`BrainConfig`) fields you can also override, passed through to
`sharpwave-core` (defaults from `core.DEFAULT_CONFIG`):

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
| `remModel` | `string?` | _(unset)_ | REM-consolidation model override; falls through to `ingestionModel`. |
| `embeddingModel` | `string` | `$SHARPWAVE_EMBEDDING_MODEL` / `"ollama/qwen3-embedding:0.6b"` | Embedding model (1024-dim). |
| `skillEvolution` | `boolean` | `false` | Enable pattern→skill generation. |
| `skillEvolveMinPatternCount` | `number` | `5` | Pattern occurrences before a skill is generated. |
| `workspaceSkillsDir` | `string` | `""` | Output dir for `brain_generate_skill` / `brain_workspace`. |
| `brainDocsDir` | `string` | `""` | Docs corpus dir for `brain_docs`. |

Env vars read directly: `OPENROUTER_API_KEY` / `SHARPWAVE_OPENROUTER_API_KEY`,
`SHARPWAVE_EMBEDDING_MODEL`, `SHARPWAVE_DATA_DIR` (brain-db parent dir) /
`SHARPWAVE_DB_PATH` (exact file).

---

## Tools

openwave registers all **16** `brain_*` tools:

`brain_query`, `brain_write`, `brain_link`, `brain_supersede`, `brain_stats`,
`brain_history`, `brain_expand`, `brain_review`, `brain_forget`, `brain_edges`,
`brain_reset`, `brain_update_self_model`, `brain_reflect`, `brain_generate_skill`,
`brain_workspace`, `brain_docs`.

Definitions and executors come from `sharpwave-core`'s unified tool module, so
openwave and the `sharpwave` MCP server can never expose a drifted schema. (The
MCP server publishes a narrower 11-tool subset.)

Most memory work needs **no** tool call — openwave injects and logs
automatically. The tools are for deliberate deep recall (`brain_query`),
deliberate writes (`brain_write`), and introspection.

**`brain_reset` is agent-callable** — an agent can wipe its own brain by calling
it with `confirm` set to exactly its own agent id. Guarded: `confirm` must match
the agent id, and a timestamped `.db` backup is taken first. The wipe is
`DELETE FROM` on learned-state tables plus a re-seed of an empty self-model —
never `DROP` — so embedding config and vector-table dimension are preserved.

---

## Brain databases

Brain dbs live at `~/.sharpwave/<agentId>/brain.db` (plus SQLite `-wal` / `-shm`
sidecars). Redirect with `SHARPWAVE_DATA_DIR` (parent dir) or `SHARPWAVE_DB_PATH`
(exact file).

openwave and the `sharpwave` MCP server read and write the **same files** with
the **same engine code**, so an agent can be moved between them with no data
migration. First open runs the additive-only schema migration to **v17** (adds
`nodes.inject_count` / `nodes.inject_hits`, backfills `0` — no data loss).

---

## Rollback (to the sharpwave MCP server)

1. `openclaw plugins disable openwave` (or `entries.openwave.enabled: false`).
2. Add the `mcp.servers.sharpwave` entry back to `openclaw.json`.
3. `openclaw gateway restart`.

Same brain db, same schema, no migration in either direction.

---

## Development

```bash
npm install
npm run build          # esbuild → dist/index.js (single file, sharpwave-core inlined)
npm test               # vitest — mock-api hook harness
```

The engine (`sharpwave-core`) is a normal npm dependency, bundled into
`dist/index.js` at build time. Bump the `sharpwave-core` version in `package.json`
to pick up engine changes.

## License

MIT
