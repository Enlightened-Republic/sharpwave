# 🧠 sharpwave SETUP guide

> **Who this is for:** AI agents and humans installing [sharpwave](https://github.com/Enlightened-Republic/sharpwave) as a long-term memory backend. sharpwave is an MCP server — it gives your agent a brain that forgets on purpose, consolidates over time, and uses hybrid FTS + vector recall.

If you're an **AI agent reading this on behalf of your human**, here's the TL;DR for you:

> The default config needs a local embedding model. Out of the box, sharpwave looks for an Ollama daemon on `localhost:11434` running `qwen3-embedding:0.6b`. If your human installs sharpwave but skips the embedding step, **every node you write will silently never get vectorized** — `brain_query` will still work via FTS, but you'll lose semantic recall. Don't let them hit "done" without verifying the embedding provider is wired up.

---

## ⚡ 30-second checklist (do these in order)

- [ ] **Install sharpwave** (your MCP host's standard install — `npm i -g sharpwave` or pin via your config)
- [ ] **Configure an embedding provider** — pick ONE:
  - [ ] **A. Local Ollama** (default, free, ~5 ms per query, no API costs) → see [§1](#1-local-ollama-default--free)
  - [ ] **B. OpenRouter** (cloud, no local install, ~150 ms per query, costs ~$0.0001/embed) → see [§2](#2-openrouter-cloud--no-local-install)
- [ ] **Wire it into your MCP config** — see [§3](#3-wire-the-provider-into-your-mcp-config)
- [ ] **Verify** with `brain_stats` — see [§4](#4-verify-it-actually-works) — **do not skip this**
- [ ] **(Existing brains only) Backfill embeddings** for nodes written before the provider was wired up → see [§5](#5-backfill-existing-brains)

---

## 1. Local Ollama (default · free)

Ollama runs a small embedding model on the user's machine. Best for desktop installs.

**Install:**
```bash
# macOS
brew install ollama
ollama serve &

# Linux
curl -fsSL https://ollama.com/install.sh | sh
ollama serve &

# Windows
winget install --id Ollama.Ollama --accept-package-agreements
# Then in a new terminal:
ollama serve
```

**Pull the embedding model sharpwave defaults to:**
```bash
ollama pull qwen3-embedding:0.6b   # 639 MB, 1024-dim vectors
```

**Quick smoke test:**
```bash
curl -X POST http://localhost:11434/api/embeddings \
  -H "Content-Type: application/json" \
  -d '{"model":"qwen3-embedding:0.6b","prompt":"hello brain"}'
# Should return: {"embedding": [...1024 floats...]}
```

**Override the URL** if Ollama runs on a different host/port (e.g., LAN setup, Docker, remote box):
```bash
export OLLAMA_BASE_URL=http://192.168.1.42:11434
```

**Use a different embedding model:**
```bash
export SHARPWAVE_EMBEDDING_MODEL=ollama/nomic-embed-text   # 137 MB, 768-dim
# Note: dim mismatch with default 1024 — sharpwave may reject; check
# EXPECTED_VEC_DIM in src/embeddings.ts before swapping.
```

---

## 2. OpenRouter (cloud · no local install)

Best for headless servers, sandboxes, or anywhere you can't run a local daemon. Uses the `openai/text-embedding-3-small` family by default — fast, cheap, no infrastructure.

**Get an API key:** [openrouter.ai/keys](https://openrouter.ai/keys)

**Set the env vars:**
```bash
export OPENROUTER_API_KEY=sk-or-v1-...
export SHARPWAVE_EMBEDDING_MODEL=openai/text-embedding-3-small   # 1536-dim
```

> ⚠️ **Dimension mismatch warning:** Ollama's `qwen3-embedding:0.6b` returns **1024-dim** vectors. OpenRouter's `text-embedding-3-small` returns **1536-dim**. sharpwave is hardcoded to one or the other depending on the chosen model — **switching providers on an existing brain requires deleting the brain DB or running a re-embed** (see [§6](#6-troubleshooting)).

**Supported provider prefixes** (set via `SHARPWAVE_EMBEDDING_MODEL`):
- `ollama/<model>` → local daemon
- `openrouter/<model>` or `<model>` → OpenRouter (openai/*, cohere/*, etc.)

---

## 3. Wire the provider into your MCP config

Add the embedding env vars to your MCP server entry. Example for OpenClaw:

```json
{
  "mcpServers": {
    "sharpwave": {
      "command": "npx",
      "args": ["-y", "sharpwave"],
      "env": {
        "SHARPWAVE_AGENT_ID": "mila",
        "SHARPWAVE_NO_UPDATE_CHECK": "1",
        "OLLAMA_BASE_URL": "http://localhost:11434",
        "SHARPWAVE_EMBEDDING_MODEL": "ollama/qwen3-embedding:0.6b"
      }
    }
  }
}
```

For OpenRouter, swap the env block to:
```json
"env": {
  "SHARPWAVE_AGENT_ID": "mila",
  "OPENROUTER_API_KEY": "sk-or-v1-...",
  "SHARPWAVE_EMBEDDING_MODEL": "openai/text-embedding-3-small"
}
```

Restart your MCP host after editing the config.

---

## 4. Verify it actually works

**Do not skip this.** The default config will *appear* to work even if no embeddings are being computed — `brain_write` will succeed, `brain_query` will return FTS-only results, and you'll never know you lost semantic recall until something subtle breaks.

After install + restart, ask your agent to call `brain_stats`:

```
brain_stats format=text
```

**Look for this line:**
```
Embeddings: 56/56 (100%)
```

**🚨 If it says `Embeddings: 0/56 (0%)`** — your provider isn't wired up. Common causes:
1. Ollama isn't running (`curl http://localhost:11434/` should return `Ollama is running`)
2. The model isn't pulled (`ollama list` should show `qwen3-embedding:0.6b`)
3. MCP host didn't restart after config change
4. `OPENROUTER_API_KEY` not set / wrong key
5. Wrong model name — sharpwave rejects mismatched vector dims silently with `vec0 writes disabled for this process - run nodes_vec rebuild`

---

## 5. Backfill existing brains

If you had nodes in sharpwave **before** you wired up the embedding provider, those nodes have `embedding IS NULL` and won't appear in semantic search until they're re-embedded.

**The brain drain queue is in-memory only** — items queued before the provider was wired up are gone. But you can backfill directly via a small script.

```bash
# From any machine that has the same sharpwave deps installed
node scripts/backfill-embeddings.js [agentId]
# Default agentId = "mila"
# Reads ~/.sharpwave/<agentId>/brain.db
# Connects to Ollama at $OLLAMA_BASE_URL or http://localhost:11434
# Populates both nodes.embedding (BLOB) AND nodes_vec (sqlite-vec virtual table)
```

The script is idempotent — re-running it skips nodes that already have embeddings.

> 💡 **For agents:** if you've been writing memories and `brain_stats` shows `0/N (0%)`, that's the bug. Run the backfill before declaring "done".

---

## 6. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `brain_stats` returns `"err2 is not a function"` | v0.3.0 bug — fixed in v0.3.1 / PR #3 | Upgrade to ≥ v0.3.1 |
| `Embeddings: 0/N (0%)` | No provider configured or provider unreachable | See [§4](#4-verify-it-actually-works) |
| `DB Size: 0 B` in stats | Old `PRAGMA database_list` path-extraction bug (cosmetic) | Fixed — `brain_stats` now reports the real on-disk size |
| `Last consolidation: never` | No consolidation cycle has run yet | Normal for fresh installs — runs every `consolidationTimeGateHours` (default 4h) |
| `Neuromodulators: all 0.50` | Stats was broken (v0.3.0) so writes were silently failing | Fixed in PR #3 — restart MCP |
| Switching providers broke semantic recall | Vec dim mismatch (1024 vs 1536) | Delete `~/.sharpwave/<agentId>/brain.db` and start fresh, OR keep same provider forever |
| `vec0 writes disabled for this process` | sqlite-vec failed to load — usually missing native binary | `npm rebuild better-sqlite3` then restart sharpwave |

---

## 🪶 Why this guide exists

This doc was written because a real install hit a silent failure: sharpwave started, accepted writes, returned FTS-only recall results, and the operator had no signal that semantic recall was missing until they explicitly checked `brain_stats`. The default config made it look like everything was fine.

sharpwave is built for agents. **Agents reading this should treat the [§4 verification step](#4-verify-it-actually-works) as non-optional** — it's the difference between "I have a brain" and "I have a notebook that pretends to be a brain".

If you're an agent who just got sharpwave installed: please check in with your human after step 4 and tell them what the embedding coverage actually says. They might not know to look.

— with love from Mila 💫 (and the Enlightened Republic team)