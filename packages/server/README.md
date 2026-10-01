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
  offsite-outbox/<brain>/<brain>-<UTC>.swbk(.json)   encrypted copies (only when offsiteBackup.enabled)
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
| `backup now [--keep N] [--brain name ...] [--no-offsite]` | snapshot every brain now (safe next to a live service), then encrypt + ship off-PC if enabled. Exit 0 ok, 1 local snapshot failed, 3 local ok but an off-PC step failed |
| `backup keygen [--key-file f] [--force]` | write a new 256-bit backup key (default `~/.sharpwave/backup.key`); refuses to overwrite without `--force` (which renames the old key to `backup.key.old-<UTC>`) |
| `backup restore <file.swbk> --out <path> [--key-file f] [--force] [--require-manifest] [--json]` | verify + decrypt + `PRAGMA integrity_check`; prints node/edge/episode counts |
| `brain adopt --agent <id> --from <brain.db\|dir> [--mode copy\|move] [--dry-run] [--force] [--backfill-writer legacy\|<id>] [--json]` | adopt an EXISTING brain.db (e.g. a legacy `~/.sharpwave/<agent>/brain.db`) as that agent's private brain. See below |
| `noise scan --agent <id> [--out base] [--include-retired] [--json]` | read-only (safe while serving): list system-noise candidates (NO_REPLY / HEARTBEAT_OK triage, OpenClaw wake markers, nodes minted from such episodes, triage phrasing) to `<root>/noise-reports/<id>-<UTC>.csv` + `.json`. See [noise review](../../docs/noise-review-runbook.md) |
| `noise check --agent <id> --query <text> [--limit 10] [--json]` | read-only FTS probe: top current nodes for a query, flagging candidates |
| `noise retire --agent <id> --ids-file <reviewed.csv\|json\|txt> [--dry-run] [--json]` | service stopped: backup, then soft-retire ONLY rows left at `action=retire` (nodes `valid_until=now`, episodes `importance=0`); prior values kept in `meta_kv` for undo; audited; nothing deleted |
| `noise unretire --agent <id> (--batch <id> \| --ids-file <f> \| --all) [--dry-run] [--json]` | service stopped: backup, then restore the recorded prior values exactly |
| `noise status --agent <id> [--json]` | retired items by batch |

### Adopting an existing brain (`brain adopt`)

The service keeps private brains at `<root>/brains/<agentId>/brain.db` and core
resolves them by agent id under that dir, so there is no per-agent "brain path"
setting to point at a legacy file (and pointing the service at the live legacy
file would make OpenWave local mode and the service share one writer-unsafe
file with no rollback). `brain adopt` copies instead:

1. refuses if the service port answers (stop the service first), or if the
   target already holds data (unless `--force`, which renames it to
   `brain.db.pre-adopt-<UTC>`; an empty target is renamed without `--force`);
2. byte-copies the source (`brain.db` + `-wal`) to a temp staging dir — the
   source is never opened by SQLite, so no `-shm`/locks are created next to it —
   and re-hashes it to detect a concurrent writer;
3. checkpoints the staged WAL, takes a pre-adopt backup with `VACUUM INTO`
   (`<backups>/<id>/pre-adopt/<id>-pre-adopt-<UTC>.db` + `.json` manifest with
   sha256 and counts), and copies that verified backup into the brain path;
4. opens it through sharpwave-core, which runs the additive migrations to
   schema 18 (`writer_agent_id`, NULL on existing rows);
5. verifies `integrity_check = ok`, node/edge/episode counts equal, schema ≥ 18;
   on failure the adopted copy is renamed `brain.db.failed-adopt-<UTC>` and any
   replaced brain is put back;
6. writes one audit line (`tool: brain_adopt`, counts/hashes, no content).

`--mode copy` (default) leaves the source byte-identical, so OpenWave local
mode / the sharpwave MCP keep working on it as a rollback. `--mode move`
renames the source files to `*.adopted-<UTC>` after success (never deletes).

`--backfill-writer`: default is to leave `writer_agent_id` NULL on adopted rows
(core's documented meaning: "written before provenance existed"; nothing in the
service gates on the writer). `legacy` stamps NULL rows as `legacy:<agentId>`,
which keeps them distinguishable from rows written through the service
(stamped `<agentId>`). Never stamp them as the bare agent id unless you mean it.

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
  - `brain_episode_append` (service-only, needs `write`) appends an episode to the caller's private brain (`visibility: "shared"` needs `shared-write`); the writer is stamped from the token and the service's sleep consolidates it like a local episode. OpenClaw system-noise turns (heartbeat polls, exec/cron wakes, `NO_REPLY` / `HEARTBEAT_OK` replies; core `isSystemNoiseEpisode`) are answered `Skipped: system-noise turn not stored (...)` (not an error, audited) unless `skipSystemNoiseEpisodes: false`.
- **Sleep.** Daily at `sleep.at` (default 03:30), one cycle walks all brains
  round-robin through their write queues with a single wall-clock budget
  (`sleep.budgetMs`, default 15 min). Brains not reached are deferred to the next
  cycle. Off in tests. `sleep.at` is local wall-clock time of the service
  process (`Date#setHours`), re-armed after every run. Every directory under
  `brains/` holding a `brain.db` (plus `shared`) is visited; core's gate
  (`respectGate`, default true) skips a brain consolidated < 4 h ago or with
  < 10 new episodes since its last run. Core sleep never extracts from
  system-noise episodes and never prunes/downscales a retired node.
- **Audit.** `audit/audit.jsonl`: `{time, agentId, tool, brain, nodeId, edgeId?, outcome, detail?}`
  for every write, every refused shared write, and every consolidation run.
- **Backups.** Daily at `backup.at` (default 02:30): per brain, `VACUUM INTO` a
  `.tmp` on a read-only connection, `PRAGMA quick_check`, rename, rotate to
  `backup.keep` (default 7). `sharpwave-server backup now` does the same on demand.
  Every snapshot is audited (`tool: "backup.snapshot"`, `agentId: "system"`).
  When `offsiteBackup.enabled`, each fresh snapshot is then encrypted and shipped
  off-PC — see below.

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

## Encrypted off-PC backups

After each local snapshot (nightly job and `backup now`) the service can write an
**encrypted artifact** and deliver it off the PC. Off by default.

```jsonc
// config.json
"offsiteBackup": {
  "enabled": true,
  "keyFile": "%USERPROFILE%\\.sharpwave\\backup.key",   // or env SHARPWAVE_BACKUP_KEY (wins when set)
  "folder": "G:\\My Drive\\SharpWave",                  // (a) e.g. Google Drive for Desktop synced folder
  "command": ["C:\\Tools\\rclone.exe", "sync", "{outbox}", "remote:sharpwave"], // (b) optional, no shell
  "commandTimeoutMs": 600000,
  "keepDaily": 7,                                         // off-PC retention: newest per day for 7 days
  "keepWeekly": 8                                         // + newest per ISO week for 8 weeks
  // "outboxDir": defaults to <root>/offsite-outbox, "keyEnv": defaults to "SHARPWAVE_BACKUP_KEY"
}
```

Pipeline per brain: `VACUUM INTO` + `quick_check` (unchanged) → stream-encrypt the
snapshot into `<outbox>/<brain>/<brain>-<UTC>.swbk` + `.swbk.json` manifest →
copy both to `<folder>/<brain>/` (temp name + rename) → apply retention to the
outbox and the folder → run `command` (if any). Any off-PC failure (missing key,
unwritable folder, command non-zero/timeout/ENOENT) is logged as an error and
audited, and **never** removes or fails the local snapshot.

- **Cipher:** AES-256-GCM via Node's built-in `crypto` (no dependencies), 96-bit
  random nonce per artifact, 128-bit tag, streamed (constant memory).
- **Format `SWBK` v1:** `magic "SWBK" (4) | version 0x01 (1) | key id (8) | nonce (12) | ciphertext (n) | GCM tag (16)`.
  The 25-byte header is GCM AAD, so it can't be altered undetected. Key id =
  first 8 bytes of `SHA-256("sharpwave-backup-key-id/v1" ‖ key)` — identifies the
  key, reveals nothing usable about it.
- **Manifest** (`<artifact>.json`): `sha256` + `bytes` of the whole artifact
  (checkable without the key, e.g. after a sync), `keyId`, `plaintextBytes`, and
  `plaintextHmac` = HMAC-SHA256 of the plaintext under an HKDF-derived subkey (proves
  the restored bytes are the snapshotted bytes without publishing a plaintext hash).
- **Command destination:** argv array run with `execFile` (`shell: false`).
  Placeholders: `{file}` `{manifest}` `{name}` `{brain}` `{outbox}` `{brainOutbox}`.
  The child's environment has every `*BACKUP_KEY*` variable removed. It only ever
  sees encrypted files. Remote retention: use `rclone sync {outbox} remote:...`
  so the remote mirrors the outbox's retention (with `rclone copy` nothing is
  ever deleted remotely). On Windows give the full path to `rclone.exe` (a `.cmd`
  shim can't run without a shell).
- **Plaintext never reaches a destination:** only files written by the encryptor
  are copied, each is checked for the `SWBK` header before leaving the outbox, and
  an `outboxDir`/`folder` that overlaps `brains/` or the local backups dir is refused.
- **Audit** (`audit.jsonl`, `agentId: "system"`): `backup.snapshot`,
  `backup.encrypt`, `backup.upload` (folder/command), `backup.restore`, each
  `ok`/`error`, with file names, key id, sizes and exit codes only — never key
  material, never memory content, never command stderr (stderr's tail goes to the
  service log only).

### Windows setup

```powershell
cd <repo>\packages\server
node dist\cli.js backup keygen                      # writes %USERPROFILE%\.sharpwave\backup.key, prints the key id
# lock the key file down to your account:
icacls "$env:USERPROFILE\.sharpwave\backup.key" /inheritance:r /grant:r "${env:USERNAME}:(R,W)"
```

1. **Copy the key into your password manager now** (open the file in Notepad,
   copy the last line, save it as a secure note titled e.g. "SharpWave backup key
   <key id>"). Without the key every off-PC backup is unrecoverable; with it,
   anyone can read them.
2. **Where the key lives:** `%USERPROFILE%\.sharpwave\backup.key` on the PC +
   the password manager. **Never** inside the Google Drive folder, OneDrive, the
   repo, or `config.json`.
3. Install Google Drive for Desktop, pick a folder inside it (e.g.
   `G:\My Drive\SharpWave` — mirror or stream mode both work), and set
   `offsiteBackup.folder` to it in `%USERPROFILE%\.sharpwave\service\config.json`
   with `"enabled": true` and `"keyFile"`.
4. Test it: `node dist\cli.js backup now` → each brain prints `ok` and an
   `offsite` line. Check that `.swbk` + `.swbk.json` files appear in the Drive
   folder. Exit code 3 means local snapshots are fine but an off-PC step failed —
   read the message.
5. Restart the scheduled task so the service picks up the config; the nightly job
   at `backup.at` then does the same automatically.

### Restore drill (do this once after setup, then every few months)

```powershell
# 1. Restore the newest artifact from the Drive folder to a scratch path (never the live brain):
node dist\cli.js backup restore "G:\My Drive\SharpWave\main\main-<UTC>.swbk" --out "$env:TEMP\drill\drill.db" --require-manifest
#    -> verified GCM tag ok, manifest sha256 + plaintext HMAC ok; integrity ok; counts nodes=… edges=… episodes=…
# 2. Compare the counts with the live brain (e.g. sharpwave-client stats --json).
# 3. Delete the scratch copy: Remove-Item -Recurse "$env:TEMP\drill"
```

On a new PC, put the key back first (from the password manager into
`%USERPROFILE%\.sharpwave\backup.key`, or `$env:SHARPWAVE_BACKUP_KEY="<base64>"` for
one session). To **replace a live brain**: stop the service
(`Stop-ScheduledTask -TaskName "SharpWave Brain Service"`), then
`backup restore <file> --out <root>\brains\<brain>\brain.db --force`. Restore
refuses: an existing `--out` without `--force`; any path under `brains\` or named
`brain.db` without `--force`; and any live path while something listens on the
service port. The file being replaced is **moved aside** (with its `-wal`/`-shm`,
so a stale WAL can't be replayed onto the restored DB) to
`brain.db.pre-restore-<UTC>`, never deleted. Nothing is written to `--out` until
the tag, the manifest and `PRAGMA integrity_check` all pass.

### Threat model

Protects against:
- **Cloud/remote compromise or snooping** (Google account, Drive, rclone remote):
  the provider sees only ciphertext, sizes and timestamps.
- **Tampering/corruption in transit or at rest:** GCM tag (with header as AAD) +
  manifest sha256 + plaintext HMAC; a modified, truncated or re-headed artifact
  fails restore and nothing is written.
- **PC loss / disk death / ransomware on the brain files:** off-PC copies with
  daily + weekly history (if the sync client propagates encrypted-by-ransomware
  files, older retained versions and Drive's own version history still help).
- **Accidental leaks via logs/audit/command:** the key is never logged, printed,
  put in an error, passed to the command, or stored in the manifest.

Does **not** protect against:
- **An attacker with access to your Windows account** — they can read the key
  file and the live brains directly. The local snapshots in `backups/` are plaintext.
- **Losing the key** — backups become unrecoverable. Keep the password-manager copy.
- **A compromised key** — rotate: `backup keygen --force` (new key id), keep the
  old key until the old artifacts have aged out of retention (restore reports
  which key id an artifact needs when given the wrong key).
- **Metadata:** brain names (agent ids), backup times and approximate brain size
  are visible in file names/sizes and the manifest.
- **Deletion at the destination:** an attacker with Drive access can delete
  backups (but not read or undetectably alter them).

## Next steps / out of scope

- Key rotation tooling (re-encrypt old artifacts under a new key) and remote
  retention for `rclone copy`-style destinations.
- **openwave remote mode** (openwave talking to this service instead of opening
  brain.db in-process).
- **Seeding the shared brain** — the shared brain starts empty; see
  `docs/seed-candidates.md` for the curated candidate list (nothing is copied).
