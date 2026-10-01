# SharpWave brain service: Windows install runbook

For **Chief of Staff (CoS)** to run step by step on Hailey's Windows PC, with Hailey watching.
Service: `sharpwave-server` 0.1.0 (`packages/server`), local-only on `127.0.0.1:18790`.

> **Nothing in `packages/server/scripts/windows/` has been run on Windows yet.** The scripts were written and
> parse-checked on Linux: PowerShell 7 parser, XML parser, and the server test suite on Linux. Every step marked
> **[UNTESTED ON WINDOWS]** is a first run. Run the checks after each step, and stop at the first surprise.
> Rollback is in section 8.

## Ground rules for tonight/tomorrow

- **PowerShell only.** Don't use `&&` (Windows PowerShell 5.1 doesn't have it). Run one command per line.
- There's **no `sqlite3`** on this PC. Nothing below needs it.
- **Don't touch** the existing brains in `C:\Users\wubbu\.sharpwave\main`, `\mila`, or `\algen`. Don't touch the
  OpenClaw gateway (port **18789**) or its scheduled task. The new service lives in its own folder,
  `C:\Users\wubbu\.sharpwave\service\`, on its own port, **18790**.
- **Never paste a token into chat**, a ticket, or a screenshot. Tokens go straight from the mint command into a
  file. Nothing below prints a token to the screen.
- Use `npm.cmd`, not `npm`. In PowerShell, `npm` can resolve to `npm.ps1`, which is blocked when script
  execution is disabled.
- Tailscale is **logged out** (Norton VPN conflict). This install is **127.0.0.1 only**. Adding the tailnet
  later is an optional section at the end.

## Session variables: paste these into every new PowerShell window first

```powershell
$Repo    = "C:\Users\wubbu\src\sharpwave"
$Srv     = "C:\Users\wubbu\src\sharpwave\packages\server"
$Cli     = "C:\Users\wubbu\src\sharpwave\packages\server\dist\cli.js"
$Client  = "C:\Users\wubbu\src\sharpwave\packages\server\bin\sharpwave-client.mjs"
$SvcRoot = "C:\Users\wubbu\.sharpwave\service"
$Cfg     = "C:\Users\wubbu\.sharpwave\service\config.json"
$TokDir  = "C:\Users\wubbu\.sharpwave-tokens"
$Url     = "http://127.0.0.1:18790"
$Task    = "SharpWave Brain Service"
```

Why the tokens live in `C:\Users\wubbu\.sharpwave-tokens` and not under `.sharpwave\service`: the service
folder gets backed up (and may later be copied off-PC). Plaintext tokens must not ride along. `.sharpwave`
itself holds one folder per legacy brain, so a token folder there would look like an agent named `tokens`.

---

## 0. Prerequisites check and backup

**0.1 Node ≥ 22.** The server needs Node 22 or newer. Node 24 also works on Linux; it hasn't been tried on Windows.

```powershell
node -v
where.exe node
```

If the version is below `v22`, **STOP**. Upgrading Node also affects OpenClaw, so that's Hailey's call and not
part of this runbook.

**0.2 Git.** Optional. If this fails, use the zip download in step 1B.

```powershell
git --version
```

**0.3 Paths.** Expected: `.sharpwave` exists and has `main`, `mila`, and `algen`. `service`, the repo folder,
and the token folder don't exist yet.

```powershell
Get-ChildItem C:\Users\wubbu\.sharpwave -Directory | Select-Object Name, LastWriteTime
Test-Path C:\Users\wubbu\.sharpwave\service
Test-Path $Repo
Test-Path $TokDir
```

If any of the last three print `True`, **STOP**. Somebody already started an install. Find out what's there first.

**0.4 Port 18790 is free; 18789 is the gateway.** Just look at 18789; don't touch it.

```powershell
Get-NetTCPConnection -LocalPort 18790 -ErrorAction SilentlyContinue
Get-NetTCPConnection -LocalPort 18789 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalAddress, LocalPort, OwningProcess
```

The first command must print **nothing**.

**0.5 Is anything holding the legacy brains open?** A file copy of a SQLite database is only consistent when
nothing is writing to it.

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match "sharpwave|openwave" } | Select-Object ProcessId, CommandLine
```

If this lists a running `sharpwave` MCP server, ask Hailey to close whatever started it (or wait until it's idle) before 0.6.

**0.6 Back up `~/.sharpwave` to a dated copy *outside* `.sharpwave`.**

```powershell
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$Bak = "C:\Users\wubbu\sharpwave-backup-$Stamp"
Copy-Item -Path C:\Users\wubbu\.sharpwave -Destination $Bak -Recurse
$src = Get-ChildItem C:\Users\wubbu\.sharpwave -Recurse -File
$dst = Get-ChildItem $Bak -Recurse -File
"source: {0} files, {1} bytes   backup: {2} files, {3} bytes" -f $src.Count, ($src | Measure-Object Length -Sum).Sum, $dst.Count, ($dst | Measure-Object Length -Sum).Sum
Get-ChildItem C:\Users\wubbu\.sharpwave -Recurse -Filter brain.db | Get-FileHash -Algorithm SHA256 | Select-Object Hash, Path | Export-Csv "$Bak.brain-hashes.csv" -NoTypeInformation
$Bak
```

The file counts and byte totals must match. **Write down the `$Bak` path** for rollback.
`$Bak.brain-hashes.csv` lets you prove later that `main`, `mila`, and `algen` were never modified by this install (section 8.3).

---

## 1. Get the code (not published to npm)

`sharpwave-server` is a private workspace package. It's **not on npm**, so `npm install sharpwave-server` won't work.
Install it from the public GitHub repo at a **pinned commit**.

Which commit: the SHA Engram gave in PR #10's description ("Pinned commit for install"). Once PR #10 is merged,
use the merge commit on `main` instead. It must contain this runbook and `brain_seed`. 1.3 checks that.

```powershell
$Sha = "PASTE-THE-40-CHARACTER-SHA-HERE"
New-Item -ItemType Directory -Force -Path C:\Users\wubbu\src | Out-Null
```

**1A. With git (preferred):**

```powershell
git clone https://github.com/Enlightened-Republic/sharpwave.git $Repo
Set-Location $Repo
git checkout --detach $Sha
git rev-parse HEAD
```

**1B. Without git (zip from GitHub):**

```powershell
Invoke-WebRequest -Uri "https://codeload.github.com/Enlightened-Republic/sharpwave/zip/$Sha" -OutFile "C:\Users\wubbu\src\sharpwave-$Sha.zip" -UseBasicParsing
Expand-Archive -Path "C:\Users\wubbu\src\sharpwave-$Sha.zip" -DestinationPath C:\Users\wubbu\src
Rename-Item -Path "C:\Users\wubbu\src\sharpwave-$Sha" -NewName "sharpwave"
Set-Location $Repo
```

**1.3 Check that this is the right commit:**

```powershell
Test-Path "$Repo\docs\windows-install-runbook.md"
Select-String -Path "$Srv\src\tools.ts" -Pattern '"brain_seed"' -SimpleMatch | Select-Object -First 1
```

You should see `True` and one match.

**1.4 Install and build.** **[UNTESTED ON WINDOWS]** `better-sqlite3` downloads a prebuilt Windows binary from
GitHub during `npm ci`. Norton or a VPN can block that download (see section 9).

```powershell
Set-Location $Repo
npm.cmd ci
npm.cmd run build
Test-Path $Cli
node $Cli version
```

You should see `True` and `0.1.0`.

**1.5 (Recommended, about 10 s) Run the server test suite on this PC.** It's hermetic: temp folders only, no
network, and it doesn't touch `~/.sharpwave`. It's the quickest proof that the native SQLite modules work on Windows.

```powershell
npm.cmd run test:server
```

Expected: all test files pass; the real-snapshot smoke test reports skipped. If anything fails, copy the failing test
name and error text (no tokens are involved) and decide with Hailey whether to continue.

---

## 2. Config file: data dir, local-only bind, backups

What the settings do:

- `root`: the service's own data folder. Brains go in `brains\shared` and `brains\<agentId>`, plus `backups\`,
  `audit\`, and `tokens.json` (hashes only).
- `tailnetHosts: []`: **no tailnet bind**. The service always binds `127.0.0.1` and refuses `0.0.0.0`.
  Without a config file the defaults *also* try `100.121.136.3`, so this file matters.
- `tailnetBackgroundRetryMs: 0`: no background retries of a tailnet bind.
- `backup`: nightly `VACUUM INTO` snapshot of every service brain at 02:30, keeping 7.
  This only runs while Hailey is logged on, because the task is an at-logon task.
- `sleep`: nightly consolidation at 03:30, 15-minute budget, same logged-on caveat.

```powershell
New-Item -ItemType Directory -Force -Path $SvcRoot | Out-Null
$json = @'
{
  "root": "~/.sharpwave/service",
  "port": 18790,
  "tailnetHosts": [],
  "tailnetBackgroundRetryMs": 0,
  "allowReset": false,
  "sleep":  { "enabled": true, "at": "03:30", "budgetMs": 900000, "respectGate": true },
  "backup": { "enabled": true, "at": "02:30", "keep": 7 }
}
'@
Set-Content -Path $Cfg -Value $json -Encoding ascii
Get-Content $Cfg | ConvertFrom-Json | Format-List
```

Use `-Encoding ascii`. `-Encoding UTF8` in Windows PowerShell 5.1 writes a BOM. The PR #10 build tolerates it,
but older builds fail with `Unexpected token`.

---

## 3. First run in the foreground and a /health check

**3.1 Window A:** start the service in the foreground. Leave sleep and backup off for this test run.

```powershell
node $Cli serve --config $Cfg --no-sleep --no-backup
```

Expected log lines: `listening on http://127.0.0.1:18790` with **no** `tailnet` lines, plus a warning `no tokens in ... tokensFile` (tokens are minted in section 5; that's expected for now). No Windows Firewall prompt should
appear, because loopback binds don't trigger one. **If a firewall prompt does appear, click Cancel / don't allow**.
It means something is binding a non-loopback address. Stop with Ctrl+C and recheck section 2.

**3.2 Window B** (paste the session variables first):

```powershell
Invoke-RestMethod "$Url/health"
node $Client health
Get-NetTCPConnection -LocalPort 18790 -State Listen | Select-Object LocalAddress, LocalPort, OwningProcess
```

Expected: `status ok`, `version 0.1.0`, and addresses = `127.0.0.1:18790` **only**.
`Get-NetTCPConnection` shows only `127.0.0.1`. If it shows `0.0.0.0`, `::`, or a `100.x` address, **STOP**.

**3.3 Firewall: confirm there's NO inbound rule for this service.** Look only; don't change anything.

```powershell
Get-NetFirewallRule -DisplayName "*SharpWave*" -ErrorAction SilentlyContinue | Select-Object DisplayName, Direction, Action, Enabled
Get-NetFirewallPortFilter -Protocol TCP | Where-Object { $_.LocalPort -contains "18790" } | Get-NetFirewallRule | Select-Object DisplayName, Direction, Action, Enabled
```

Both must print **nothing**. The second one walks every rule and can take 10 to 30 s.
(Blanket "node.js" app rules from other installs may exist. Leave them alone. They don't matter while the service binds only 127.0.0.1.)

**3.4** In Window A, press **Ctrl+C**. Expected: `SIGINT — shutting down`, and the prompt comes back.

---

## 4. Install the scheduled task (hidden .vbs) and verify it

**[UNTESTED ON WINDOWS]** These are first runs of `install-task.ps1`, `sharpwave-service.vbs`, and `uninstall-task.ps1`.

Task details: name **"SharpWave Brain Service"**, at logon of `wubbu`, limited (non-admin) run level, no time limit.
The action is `wscript.exe //B //Nologo sharpwave-service.vbs "<node.exe>" "<dist\cli.js>" "<config>" "<log>"`,
which runs node with **no window**. If node exits non-zero, the .vbs restarts it after 30 s.
(Task Scheduler's own "restart on failure" doesn't cover that case.)

**4.1 Preview, then register** (normal, non-admin PowerShell):

```powershell
Set-Location $Srv
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\install-task.ps1 -ConfigPath $Cfg -WhatIf
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\install-task.ps1 -ConfigPath $Cfg
Get-ScheduledTask -TaskName $Task | Select-Object TaskName, State
(Get-ScheduledTask -TaskName $Task).Actions | Select-Object Execute, Arguments
```

Check that `Arguments` holds four quoted paths: the .vbs, `node.exe`, `dist\cli.js`, and `config.json`, then the log
path `C:\Users\wubbu\.sharpwave\service\logs\service.log`.

**4.2 Start it manually and check:**

```powershell
Start-ScheduledTask -TaskName $Task
Start-Sleep -Seconds 5
Get-ScheduledTaskInfo -TaskName $Task | Select-Object LastRunTime, LastTaskResult
Invoke-RestMethod "$Url/health"
Get-Content "$SvcRoot\logs\service.log" -Tail 20
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*\packages\server\dist\cli.js*serve*" } | Select-Object ProcessId, CommandLine
```

Expected: `LastTaskResult` = **267009** (0x41301, "currently running"), health is OK, the log shows `listening on http://127.0.0.1:18790`,
there's exactly one node process, and **no console window appeared**.

**4.3 Crash-restart check (tests the .vbs supervisor loop):**

```powershell
$p = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*\packages\server\dist\cli.js*serve*" }
Stop-Process -Id $p.ProcessId -Force
Start-Sleep -Seconds 40
Invoke-RestMethod "$Url/health"
```

Health must answer again within about 30 s. If it doesn't, see section 9 ("task running but no health").

**4.4 Logon check.** Only if Hailey OKs it: signing out also restarts her OpenClaw gateway and sessions.
Sign out, sign back in, wait 30 s, then run:

```powershell
Invoke-RestMethod "http://127.0.0.1:18790/health"
Get-ScheduledTaskInfo -TaskName "SharpWave Brain Service" | Select-Object LastRunTime, LastTaskResult
```

If she'd rather not sign out now, 4.2 and 4.3 are enough for today. Her next normal sign-in will cover the at-logon trigger.
Check health once after that.

---

## 5. Mint one token per agent

Rules:

- **One token per agent.** The token's agent id *is* the agent's identity: every write is stamped with it, and it
  names the private brain (`brains\<agentId>`).
- **Use the OpenClaw agent id exactly** (the `id` in `openclaw.json`) for OpenClaw agents. OpenWave remote mode
  (step 7) finds token files by `{agentId}`. Allowed characters: letters, digits, `.`, `_`, and `-`, up to 64 characters.
  `shared` is reserved.
- Scopes:

  | agent | scopes | notes |
  |---|---|---|
  | `chief-of-staff` | `read,write,shared-write,admin` | `admin` is needed for seeding (`brain_seed`) and implies every other scope |
  | `tripp` | `read,write` | add `shared-write` **only if CoS agrees** |
  | writing team agents (one each) | `read,write` | same |
  | game dev team agents (one each) | `read,write` | same |

- The token is written **straight into** `C:\Users\wubbu\.sharpwave-tokens\<agentId>.token` and never shown.
  The folder is locked to `wubbu` and `SYSTEM`. Note: every OpenClaw agent runs as the same Windows user, `wubbu`, so
  file permissions keep *other Windows users* out, not other agents. Agents are kept apart by each one getting
  only its own file path.

**5.1 Token folder, locked down:**

```powershell
New-Item -ItemType Directory -Force -Path $TokDir | Out-Null
icacls $TokDir /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" "SYSTEM:(OI)(CI)F"
icacls $TokDir
```

**5.2 Mint helper** (paste once per window). It refuses to overwrite an existing file:

```powershell
function New-BrainToken([string]$Agent, [string]$Scopes, [string]$Label) {
  $out = Join-Path $TokDir "$Agent.token"
  if (Test-Path $out) { throw "$out already exists - revoke the old token first (section 9) or choose another agent id" }
  $j = node $Cli token mint --config $Cfg --agent $Agent --scopes $Scopes --label $Label --json | ConvertFrom-Json
  if (-not $j.token) { throw "mint failed for $Agent" }
  Set-Content -Path $out -Value $j.token -NoNewline -Encoding ascii
  "{0}  agent={1}  scopes={2}  file={3}" -f $j.id, $j.agentId, ($j.scopes -join ","), $out
  $j = $null
}
```

**5.3 Mint.** Replace the `REPLACE-...` ids with the real OpenClaw agent ids once Hailey has created the agents:

```powershell
New-BrainToken -Agent "chief-of-staff" -Scopes "read,write,shared-write,admin" -Label "Chief of Staff"
New-BrainToken -Agent "tripp" -Scopes "read,write" -Label "Tripp"
$TeamAgents = @("REPLACE-writing-agent-1", "REPLACE-writing-agent-2", "REPLACE-gamedev-agent-1", "REPLACE-gamedev-agent-2")
foreach ($a in $TeamAgents) { New-BrainToken -Agent $a -Scopes "read,write" -Label "team agent $a" }
```

New tokens work right away. The service reloads `tokens.json` on change, with no restart.

**5.4 Verify (doesn't show any secret):**

```powershell
node $Cli token list --config $Cfg
Get-ChildItem $TokDir | Select-Object Name, Length, LastWriteTime
Select-String -Path "$SvcRoot\tokens.json" -Pattern "swt_" -SimpleMatch
```

Each `.token` file is 47 bytes (`swt_` + 43 characters). The `Select-String` line must print **nothing**:
`tokens.json` holds only `sha256:` hashes.

---

## 6. Smoke test with the client CLI

Uses CoS's token and Tripp's token. It cleans up after itself.

```powershell
$Cos   = Join-Path $TokDir "chief-of-staff.token"
$Tripp = Join-Path $TokDir "tripp.token"
```

**6.1 Private write by CoS, read back:**

```powershell
$w = node $Client write "Smoke test private note from CoS" --label "smoke-private" --token-file $Cos --json | ConvertFrom-Json
$w | Format-List id, brain, writer
node $Client read $w.id --token-file $Cos
```

Expected: `brain : private`, `writer : chief-of-staff`. `read` shows `writer chief-of-staff`.

**6.2 Tripp can't see it:**

```powershell
node $Client read $w.id --token-file $Tripp
$LASTEXITCODE
node $Client search "smoke private note" --token-file $Tripp
```

Expected: `read` fails with `node ... not found` and exit code `1`. `search` lists **no** `smoke-private`.
(PowerShell 5.1 may print the client's error in red as `NativeCommandError`. That's cosmetic.)

**6.3 Shared write by CoS, read by Tripp:**

```powershell
$s = node $Client write "Smoke test shared note from CoS" --label "smoke-shared" --shared --token-file $Cos --json | ConvertFrom-Json
$s | Format-List id, brain, writer
node $Client search "smoke shared note" --token-file $Tripp
```

Expected: `brain : shared`, `writer : chief-of-staff`. Tripp's search shows `[shared] smoke-shared ... writer chief-of-staff`.

**6.4 Tripp can't write to shared** (skip this if Tripp was given `shared-write`):

```powershell
node $Client write "should be refused" --label "smoke-denied" --shared --token-file $Tripp
$LASTEXITCODE
```

Expected: `forbidden — writing to the shared brain needs the shared-write scope`, exit code `1`.

**6.5 Audit log entries:**

```powershell
Get-Content "$SvcRoot\audit\audit.jsonl" -Tail 5 | ConvertFrom-Json | Format-Table time, agentId, tool, brain, nodeId, outcome, detail -AutoSize
```

Expected: `chief-of-staff brain_write chief-of-staff ok` (private), `chief-of-staff brain_write shared ok`, and
`tripp brain_write shared denied missing shared-write scope`.

**6.6 Clean up the smoke nodes:**

```powershell
node $Client forget $w.id --token-file $Cos
node $Client forget $s.id --shared --token-file $Cos
node $Client stats --token-file $Cos
```

The shared brain should be back to 0 nodes, before seeding. Tripp's and CoS's private brain folders now exist
(empty or nearly so). That's expected.

**Next: seeding.** Follow `docs/seeding.md`. Take the pre-seed backup there first.
**Optional:** encrypted off-PC backups, section 6B (only if sharpwave PR #9 is merged).

---

## 6B. OPTIONAL: encrypted off-PC backup. CONDITIONAL on sharpwave PR #9

**Do this only if sharpwave PR #9** (`engram/encrypted-offsite-backup`, "encrypted off-PC backups (AES-256-GCM) +
restore drill") **is merged *and* the commit pinned in step 1 includes it.** As of this writing it's a draft.
Without it, `backup keygen` / `backup restore` don't exist and the `offsiteBackup` config key is ignored.
Commands follow PR #9's README; re-check them against the merged version. **[UNTESTED ON WINDOWS]**

Check that the installed build has the feature:

```powershell
node $Cli help
```

The help text must list `backup keygen` and `backup restore`. If not, skip this section.

**6B.1 Make the key and lock it to Hailey's account.** It prints a key **id**, which isn't secret; the key itself isn't printed.

```powershell
node $Cli backup keygen
icacls "C:\Users\wubbu\.sharpwave\backup.key" /inheritance:r /grant:r "${env:USERNAME}:(R,W)"
icacls "C:\Users\wubbu\.sharpwave\backup.key"
```

**Hailey** (not CoS, and never in chat) opens `C:\Users\wubbu\.sharpwave\backup.key` in Notepad and copies the last line into
her password manager as a secure note, for example "SharpWave backup key <key id>". Without that key no off-PC backup can be
restored; with it, anyone can read them. The key lives **only** at that path and in the password manager. It never goes
in the Drive folder, the repo, or `config.json`.

**6B.2 Destination: Google Drive for Desktop synced folder.** Use the drive letter and folder Drive for Desktop shows.
`G:\My Drive` is typical:

```powershell
Test-Path "G:\My Drive"
New-Item -ItemType Directory -Force -Path "G:\My Drive\SharpWave" | Out-Null
```

**6B.3 Add `offsiteBackup` to the config** (keeps the file ASCII, no BOM):

```powershell
$c = Get-Content $Cfg -Raw | ConvertFrom-Json
$off = [ordered]@{ enabled = $true; keyFile = "C:/Users/wubbu/.sharpwave/backup.key"; folder = "G:/My Drive/SharpWave"; keepDaily = 7; keepWeekly = 8 }
$c | Add-Member -NotePropertyName offsiteBackup -NotePropertyValue $off -Force
$c | ConvertTo-Json -Depth 5 | Set-Content -Path $Cfg -Encoding ascii
Get-Content $Cfg
```

*Optional rclone destination, instead of or in addition to the folder.* Use the **full path to `rclone.exe`**: the command
runs without a shell, so a `.cmd` shim or a bare `rclone` won't start. Use **`rclone sync`** if the remote should follow
the same retention (`rclone copy` never deletes anything remotely). Replace the path and remote name with the real ones:

```powershell
$c = Get-Content $Cfg -Raw | ConvertFrom-Json
$c.offsiteBackup | Add-Member -NotePropertyName command -NotePropertyValue @("C:\Tools\rclone\rclone.exe", "sync", "{outbox}", "remote:sharpwave") -Force
$c | ConvertTo-Json -Depth 5 | Set-Content -Path $Cfg -Encoding ascii
Get-Content $Cfg
```

**6B.4 Run a backup now:**

```powershell
node $Cli backup now --config $Cfg
$LASTEXITCODE
Get-ChildItem "G:\My Drive\SharpWave" -Recurse -File | Select-Object FullName, Length
```

Expected: every brain prints `ok` plus an `offsite` line, and the exit code is `0`. Exit code `3` means the local snapshots are
fine but an off-PC step failed; read the message. Only `.swbk` and `.swbk.json` files should appear in the Drive folder,
never `.db`.

**6B.5 Restore drill** to a temp `--out` path, never the live brain:

```powershell
$art = Get-ChildItem "G:\My Drive\SharpWave\shared" -Filter *.swbk | Sort-Object Name | Select-Object -Last 1
node $Cli backup restore $art.FullName --out "$env:TEMP\sw-drill\drill.db" --require-manifest
node $Client stats --scope shared --token-file (Join-Path $TokDir "chief-of-staff.token")
Remove-Item -Recurse -Force "$env:TEMP\sw-drill"
```

Expected: the restore reports GCM tag, manifest, and integrity OK, plus node/edge/episode counts that match the live
`[shared]` stats (allowing for writes since the backup).

**6B.6 Restart the service** so the nightly job (02:30, while logged on) uses the new config:

```powershell
Stop-ScheduledTask -TaskName $Task
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*\packages\server\dist\cli.js*serve*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-ScheduledTask -TaskName $Task
Start-Sleep -Seconds 5
Invoke-RestMethod "$Url/health"
```

To replace a live brain from an off-PC artifact (disaster case), follow PR #9's README ("To replace a live brain"):
stop the service first. Restore then moves the old file aside instead of deleting it.

---

## 7. Point the OpenWave plugin at the service (remote mode). CONDITIONAL

**Do this step only when all three are true:**

1. openwave PR **Enlightened-Republic/openwave#2** (branch `engram/remote-brain-mode`) is **merged**.
   As of this writing it's a **draft**.
2. OpenWave is **installed** in Hailey's OpenClaw. **It isn't installed today.** Installing it is out of scope for
   this runbook; follow the install notes in that PR once it's merged.
3. Steps 1 to 6 above passed.

Config keys, from the draft PR. Re-check them against the merged PR: the key is `brainTokenFile`, not `tokenFile`.
They go under `plugins.entries.openwave.config` in `openclaw.json`:

```json
{
  "brainMode": "remote",
  "brainUrl": "http://127.0.0.1:18790",
  "brainTokenFile": "C:/Users/wubbu/.sharpwave-tokens/{agentId}.token"
}
```

- `{agentId}` is replaced per OpenClaw agent. That's why section 5 names token files after the exact OpenClaw agent id.
- Don't use the inline `brainToken` key. It would put a token in `openclaw.json`.
- **Don't switch the existing agents (`main`, `mila`, `algen`) to remote mode.** Their memories live in the legacy
  `~/.sharpwave\<agent>\brain.db` files. In remote mode they'd start from a new, empty private brain in the service.
  Remote mode is for the **new** agents (Tripp and the teams). Migrating the legacy brains is a separate, later task.
- After changing `openclaw.json`, restart the gateway the way Hailey normally does. Don't touch the gateway task
  definition. Then check the service's audit log for writes from the new agents' ids.

---

## 8. Rollback / uninstall

**8.1 Stop and remove the task.** `uninstall-task.ps1` stops the task (which ends the .vbs supervisor), unregisters it,
then ends any `node.exe` running this checkout's `dist\cli.js serve`. **[UNTESTED ON WINDOWS]**

```powershell
Set-Location $Srv
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\windows\uninstall-task.ps1
Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
Get-NetTCPConnection -LocalPort 18790 -ErrorAction SilentlyContinue
```

The last two must print nothing. If node is still listening, run:

```powershell
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*\packages\server\dist\cli.js*serve*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

**8.2 Park the service data and tokens. Move, don't delete:**

```powershell
$Stamp = Get-Date -Format "yyyyMMdd-HHmmss"
Move-Item -Path $SvcRoot -Destination "C:\Users\wubbu\sharpwave-service-removed-$Stamp"
Move-Item -Path $TokDir -Destination "C:\Users\wubbu\sharpwave-tokens-removed-$Stamp"
```

**8.3 Prove the legacy brains weren't touched:**

```powershell
$hashFile = Get-ChildItem C:\Users\wubbu\sharpwave-backup-*.brain-hashes.csv | Sort-Object Name | Select-Object -First 1
$before = Import-Csv $hashFile.FullName
$after  = Get-ChildItem C:\Users\wubbu\.sharpwave -Recurse -Filter brain.db | Get-FileHash -Algorithm SHA256 | Select-Object Hash, Path
Compare-Object $before $after -Property Hash, Path
```

No output means the files are identical. A difference only means something wrote to those brains since step 0,
for example Hailey's own sharpwave MCP use. Nothing in this runbook opens them.
Only if a legacy brain is actually damaged, restore it from the step-0 copy. Example for `main` (adjust the folder name):

```powershell
$Bak = (Get-ChildItem C:\Users\wubbu\sharpwave-backup-* -Directory | Sort-Object Name | Select-Object -First 1).FullName
Copy-Item -Path "$Bak\main\*" -Destination C:\Users\wubbu\.sharpwave\main -Recurse -Force
```

**8.4 Code (optional):** `Remove-Item -Recurse -Force $Repo` deletes only the checkout.

---

## 9. Troubleshooting

| symptom | check / fix |
|---|---|
| `npm.ps1 cannot be loaded because running scripts is disabled` | Use `npm.cmd` (as written above). |
| `npm.cmd ci` fails in `better-sqlite3` / `prebuild-install` | The prebuilt binary download from GitHub was blocked. Check `Invoke-WebRequest https://github.com -UseBasicParsing \| Select-Object StatusCode`. Retry with Norton's VPN/web shield paused if Hailey agrees. Building from source needs Visual Studio Build Tools. **Don't install those tonight; stop and report.** |
| `node $Cli` → `Cannot find module` | Build didn't run or failed: `Set-Location $Repo` then `npm.cmd run build`. |
| Foreground start: `EADDRINUSE 127.0.0.1:18790` | Something already listens there: `Get-NetTCPConnection -LocalPort 18790 \| Select-Object OwningProcess` then `Get-Process -Id <pid>`. Usually the task's own node (stop it with section 8.1, or leave it running). |
| `config ...: Unexpected token` | config.json isn't valid JSON. Rewrite it with section 2 (`-Encoding ascii`). |
| Task `LastTaskResult` = 2 / 3 / 4 | The .vbs exited early: 2 = missing arguments, 3 = node.exe path wrong, 4 = `dist\cli.js` missing. Re-run 4.1 after fixing (pass `-NodePath "C:\Program Files\nodejs\node.exe"` if `node` isn't on PATH). |
| Task "Running" but `/health` doesn't answer | node keeps exiting and the .vbs retries every 30 s. Read `Get-Content "$SvcRoot\logs\service.log" -Tail 30` (fatal startup errors are logged there). Or stop the task (8.1) and run section 3's foreground command to see the error directly. |
| `.vbs` blocked, quarantined, or task fails with access denied | Norton may flag a hidden-window VBScript launcher. Check Norton's quarantine/history. An exclusion is **Hailey's decision**. Fallback: run section 3's foreground command in a minimized window. |
| Client exit code 3 (`401 unauthorized`) | Wrong or revoked token file. `node $Cli token list --config $Cfg`. The file must hold exactly one line, `swt_...`. Re-mint if needed (below). |
| Client exit code 4 (`cannot reach`) | Service is down: `Invoke-RestMethod "$Url/health"`, then section 4.2. |
| `403 Forbidden origin` | A browser-style `Origin` header was sent. Agents and the CLI don't send one. Only `allowedOrigins` in config can permit it; leave that empty. |
| `stats` shows `embedded 0/N` | No local embedding model (Ollama on `localhost:11434`). Search still works through full-text search plus spreading activation. Optional to set up later. |
| Firewall prompt for node.exe | Something tried to bind a non-loopback address. Click Cancel, then check `tailnetHosts` is `[]` in config.json. |
| Need to change a token's scopes, or a token leaked | `node $Cli token list --config $Cfg`, then `node $Cli token revoke <tok_id> --config $Cfg`, then `Remove-Item (Join-Path $TokDir "<agent>.token")`, then re-run `New-BrainToken`. Revocation applies right away. |
| On-demand backup | `node $Cli backup now --config $Cfg`. Snapshots land in `$SvcRoot\backups\<brain>\`. Safe while the service runs. |

---

## Optional, later: add the tailnet bind (after Hailey fixes Tailscale)

Only once `tailscale status` shows this PC logged in as `100.121.136.3`.

**T.1 Find the Tailscale adapter name:**

```powershell
Get-NetAdapter | Where-Object { $_.InterfaceDescription -like "*Tailscale*" } | Select-Object Name, InterfaceDescription, Status
Get-NetIPAddress -IPAddress 100.121.136.3 -ErrorAction SilentlyContinue | Select-Object InterfaceAlias, IPAddress
```

**T.2 Firewall rule** (**admin** PowerShell). It's scoped to the tailnet address, the Tailscale CGNAT range, and the Tailscale interface.
Replace `Tailscale` with the adapter name from T.1 if it's different:

```powershell
New-NetFirewallRule -DisplayName "SharpWave brain service (tailnet only)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 18790 -LocalAddress 100.121.136.3 -RemoteAddress 100.64.0.0/10 -InterfaceAlias "Tailscale" -Profile Any
Get-NetFirewallRule -DisplayName "SharpWave brain service (tailnet only)" | Get-NetFirewallAddressFilter
```

**T.3 Config:** set `"tailnetHosts": ["100.121.136.3"]` and `"tailnetBackgroundRetryMs": 60000` in `$Cfg`
(edit, then check with `Get-Content $Cfg | ConvertFrom-Json`). Then restart the service:

```powershell
Stop-ScheduledTask -TaskName $Task
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*\packages\server\dist\cli.js*serve*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-ScheduledTask -TaskName $Task
Start-Sleep -Seconds 10
Invoke-RestMethod "$Url/health"
Get-NetTCPConnection -LocalPort 18790 -State Listen | Select-Object LocalAddress, LocalPort
```

Expected: listening on `127.0.0.1` **and** `100.121.136.3`, and nothing else. From another tailnet device, `/health`
at `http://100.121.136.3:18790/health` answers. Tokens are still required for `/mcp`.

**T.4 Undo:** set `"tailnetHosts": []` again, restart as in T.3, then run (admin):
`Remove-NetFirewallRule -DisplayName "SharpWave brain service (tailnet only)"`.
