# sharpwave-server — the SharpWave brain service

One long-running process that **owns every brain** it serves and exposes the
brain tools over **MCP Streamable HTTP** (official `@modelcontextprotocol/sdk`
transport), with **per-agent bearer tokens**, a **shared brain** plus **one
private brain per agent**, in-process sleep/consolidation, an audit log, and
nightly `VACUUM INTO` backups.

> Private workspace package (`"private": true`) — not published to npm.

## Layout on disk

```
~/.sharpwave/service/            (root; configurable)
  config.json                    optional (see config.example.json)
  tokens.json                    sha256 hashes only -> agentId + scopes
  brains/shared/brain.db         the shared brain (created EMPTY)
  brains/<agentId>/brain.db      one private brain per agent
  backups/<brain>/<brain>-<UTC>.db   nightly VACUUM INTO snapshots (keep N)
  audit/audit.jsonl              one line per write
  logs/service.log               when started with --log-file
```

## Run it

```bash
npm run build --workspace sharpwave-server          # -> packages/server/dist/cli.js
node packages/server/dist/cli.js token mint --agent chief-of-staff --scopes read,write
node packages/server/dist/cli.js serve               # 127.0.0.1:18790 + 100.121.136.3:18790
curl http://127.0.0.1:18790/health                   # {"status":"ok","version":"0.1.0","addresses":[...]}
```

CLI (`sharpwave-server`):

| command | what it does |
|---|---|
| `serve [--config f] [--root d] [--port n] [--tailnet-ip ip\|none] [--log-file f] [--no-sleep] [--no-backup]` | run the service |
| `token mint --agent <id> [--scopes read,write,shared-write,admin] [--label txt] [--json]` | mint a token; prints it **once**, stores only its sha256 |
| `token list [--json]` / `token revoke <tokenId>` | manage tokens (takes effect without restart) |
| `backup now [--keep N] [--brain name ...]` | snapshot every brain now (safe next to a live service) |

## Design

- **One owner, serialized writes.** Each brain has exactly one write connection
  (sharpwave-core's cached connection) and a `SerialQueue`: every mutation
  (write, link, supersede, review, forget, reset, recall reinforcement,
  consolidation) runs through it, one at a time, in order. Pure reads (expand,
  edges, history, stats) and backups use separate **read-only WAL connections**
  (`readonly` + `query_only`), so they never block the writer or wait on it.
- **Transport.** `POST /mcp` with the SDK's `StreamableHTTPServerTransport` in
  stateless mode with JSON responses; each request gets a fresh SDK `Server`
  bound to the authenticated principal (identity can't leak across requests).
  `GET`/`DELETE /mcp` -> 405. `GET /health` is unauthenticated and returns only
  `{status, version, addresses}`.
- **Tools.** `brain_query, brain_write, brain_link, brain_supersede, brain_stats,
  brain_history, brain_expand, brain_review, brain_forget, brain_edges,
  brain_reset` — same names/validators as the `sharpwave` MCP server, but
  agent scoping comes from the token (there is no `agent` argument):
  - `brain_query` searches the caller's private brain **and** shared, merges by
    activation score, and labels each hit `[private]` / `[shared]`
    (`scope: all|private|shared`, `format: text|json`). Recall reinforcement
    (FSRS touch + working memory) is applied to the caller's private brain only;
    reading shared memories never mutates them.
  - Writes go to the private brain; `visibility: "shared"` targets the shared
    brain and requires `shared-write`.
  - `brain_expand` / `brain_edges` look in private then shared; another agent's
    private brain is unreachable by any argument.
  - `brain_reset` is disabled unless `allowReset: true` **and** the token has `admin`.
- **Sleep.** Daily at `sleep.at` (default 03:30), one cycle walks all brains
  round-robin through their write queues with a single wall-clock budget
  (`sleep.budgetMs`, default 15 min). Brains not reached are deferred to the next
  cycle. Off in tests.
- **Audit.** `audit/audit.jsonl`: `{time, agentId, tool, brain, nodeId, edgeId?, outcome, detail?}`
  for every write, every refused shared write, and every consolidation run.
- **Backups.** Daily at `backup.at` (default 02:30): per brain, `VACUUM INTO` a
  `.tmp` on a read-only connection, `PRAGMA quick_check`, rename, rotate to
  `backup.keep` (default 7). `sharpwave-server backup now` does the same on demand.

## Security notes

- **Never 0.0.0.0 / ::.** The bind policy only accepts specific IP literals;
  wildcards (all spellings, incl. `::ffff:0.0.0.0`) and hostnames are refused and
  the service will not start. 127.0.0.1 is always bound; the tailnet IP
  (default `100.121.136.3`) is bound in addition. If the tailnet IP can't be bound
  at startup (Tailscale not up yet), the service retries with exponential backoff
  for `tailnetRetryWindowMs` (default 120 s), then keeps serving on 127.0.0.1 only,
  logs a warning, and retries in the background every `tailnetBackgroundRetryMs`
  (default 60 s; 0 disables).
- **Hashed tokens.** `tokens.json` stores only `sha256:<hex>` of each token
  (256-bit random `swt_...` tokens; a slow KDF adds nothing for full-entropy
  secrets). A file containing a plaintext `token` field is refused. Verification
  compares against every entry with `crypto.timingSafeEqual`, no early exit.
  Missing/invalid token -> `401` with `WWW-Authenticate: Bearer`.
- **Server-stamped writer.** `writer_agent_id` is always the token's agent; a
  client-supplied `writer_agent_id` is ignored (and not even advertised in the
  tool schema). Edges and supersedes are stamped the same way.
- Requests carrying a browser `Origin` header are refused (403) unless listed in
  `allowedOrigins` — a cheap DNS-rebinding / drive-by defence on top of the token.
- Windows Firewall: the first listen on the tailnet IP may raise a firewall
  prompt for node.exe. Pre-create an inbound rule limited to the Tailscale range if
  you want zero prompts, e.g. (admin PowerShell):
  `New-NetFirewallRule -DisplayName "SharpWave (tailnet)" -Direction Inbound -Protocol TCP -LocalPort 18790 -RemoteAddress 100.64.0.0/10 -Action Allow`

## Chief of Staff: `sharpwave-client`

Chief of Staff reaches the service only through the host PC on
`127.0.0.1:18790`. The client is one dependency-free file,
`bin/sharpwave-client.mjs` — plain `node` (>= 18), no build, no `npm install`;
it can be copied anywhere.

```powershell
$env:SHARPWAVE_TOKEN = "swt_..."          # or --token, or --token-file, or ~/.sharpwave/token
node sharpwave-client.mjs search "gateway scheduled task"
node sharpwave-client.mjs read 3f2a...-uuid
node sharpwave-client.mjs write "Weekly sync moved to Thursdays" --label "Weekly sync day"
node sharpwave-client.mjs write "..." --label "..." --shared      # needs shared-write
node sharpwave-client.mjs stats --json
node sharpwave-client.mjs health                                    # no token needed
node sharpwave-client.mjs forget 3f2a...-uuid [--shared]            # delete one node
node sharpwave-client.mjs seed <dir> --map a.md=shared --map b.md=private --dry-run   # admin token; see docs/seeding.md
```

`--url` defaults to `$SHARPWAVE_URL` or `http://127.0.0.1:18790`. `--json` prints
machine-readable output. Exit codes: 0 ok, 1 tool error (e.g. forbidden), 2 usage,
3 auth (401/403), 4 connection/HTTP.

## Windows: run at logon, hidden (scripts only — nothing is installed for you)

`scripts/windows/` ships:

- `sharpwave-service.vbs` — windowless launcher: `WScript.Shell.Run cmd, 0, True`
  (window style 0 = hidden, wait = true). Same pattern as OpenClaw's `gateway.vbs`
  hidden launcher for the gateway task. It also **supervises** node: Task
  Scheduler's restart-on-failure only fires when a task fails to *start*, so the
  wrapper itself restarts node 30 s after any non-zero exit (up to 1000x); exit 0 ends it.
- `install-task.ps1` — registers **"SharpWave Brain Service"**: at-logon trigger
  for the current user, limited run level, restart every 1 min on failure (999x),
  no execution time limit, `IgnoreNew` for multiple instances. Action:
  `wscript.exe //B //Nologo sharpwave-service.vbs "<node>" "<dist\cli.js>" "<config>" "<log>"`.
  Registers only; pass `-StartNow` to start, `-WhatIf` to preview.
- `sharpwave-service.task.xml` — the same task as importable XML (`schtasks /Create /XML`).
- `uninstall-task.ps1` — stops + unregisters the task, then ends any node.exe still
  running this checkout's `dist\cli.js serve` (`-KeepProcess` to skip); data is left in place.

**Step-by-step Windows install (untested on Windows): `docs/windows-install-runbook.md`.**
Seeding (idempotent `sharpwave-client seed` + admin-only `brain_seed` tool): `docs/seeding.md`.

Install steps (on the Windows host, normal PowerShell, NOT run by this PR):

```powershell
cd <repo>\packages\server
npm run build                                      # produces dist\cli.js (Node >= 22)
node dist\cli.js token mint --agent chief-of-staff --scopes read,write
# optional: copy config.example.json to $HOME\.sharpwave\service\config.json and edit
powershell -ExecutionPolicy Bypass -File scripts\windows\install-task.ps1 -WhatIf
powershell -ExecutionPolicy Bypass -File scripts\windows\install-task.ps1          # register
Start-ScheduledTask -TaskName "SharpWave Brain Service"                            # or log off/on
Invoke-RestMethod http://127.0.0.1:18790/health
```

Uninstall:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\windows\uninstall-task.ps1
# or: Unregister-ScheduledTask -TaskName "SharpWave Brain Service" -Confirm:$false
# brains/backups/tokens under $HOME\.sharpwave\service are untouched; delete manually if wanted
```

## Next steps / out of scope

- **Off-PC encrypted backup.** Snapshots are local only. Next: encrypt each
  snapshot (e.g. `age` to an offline recipient key) and upload to off-PC storage
  after the nightly `VACUUM INTO`, with restore drills.
- **openwave remote mode** (openwave talking to this service instead of opening
  brain.db in-process).
- **Seeding the shared brain** — the shared brain starts empty; see
  `docs/seed-candidates.md` for the curated candidate list (nothing is copied).
