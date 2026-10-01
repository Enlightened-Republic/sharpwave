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
$Repo    = "C:\Users\wubbu\src\sharpwave"   # path can vary: Hailey's live checkouts are in C:\Users\wubbu\Desktop\Projects\{sharpwave,openwave}. Adjust $Repo/$Srv/$Cli/$Client (and $OwRepo in section 10) to match.
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

Which commit: pinned to the PR #12 merge commit on `main` (contains this runbook, `brain_seed`, `brain_episode_append` and `brain adopt`). To pin a newer main,
replace the SHA below. It must contain this runbook and `brain_seed`. 1.3 checks that.

```powershell
$Sha = "1fe8e6e17e78569e753037decdaeffcf3671955c"
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
  | `tripp` | `read,write` | smoke-test identity for section 6 only. **Tripp himself is OpenClaw agent `main`**; his token (`main`) is minted in section 10e after his brain is adopted |
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
2. OpenWave is **installed** in Hailey's OpenClaw. **It isn't installed today.** Section 10g installs it (for `main`,
   remote mode) with the method that works on OpenClaw 2026.9.7.
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
- **Don't switch an existing agent (`main`, `mila`, `algen`) to remote mode by just flipping `brainMode`.** Their
  memories live in the legacy `~/.sharpwave\<agent>\brain.db` files; in remote mode they'd start from a new, empty
  private brain in the service. **Adopt the legacy brain first:** for `main` (Tripp; `main` *is* Tripp's OpenClaw agent
  id) follow **section 10, "Adopting an existing agent brain (main/Tripp)"**, which also installs OpenWave. `mila` and
  `algen` stay local until someone decides otherwise.
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

## 10. Adopting an existing agent brain (main/Tripp)

**What this does.** "Tripp" is the identity name of OpenClaw agent **`main`**. It's the only agent, and Telegram routes
to it. His memories live in the legacy file `C:\Users\wubbu\.sharpwave\main\brain.db` (plus `-wal`/`-shm`): about
533 nodes, 1380 edges and 248 episodes, at a schema below 18. This section:

1. makes the brain service serve a **copy** of that file as `main`'s private brain (`brain adopt`), and
2. installs OpenWave into OpenClaw 2026.9.7 for `main` in **remote** mode, pointed at the service.

The legacy file is **copied, never moved**. It stays byte-identical, so switching OpenWave back to local mode is an
instant rollback (10h). **Don't touch `mila` or `algen`.** Nothing here opens them.

Do this only after sections 0 to 6 pass, with Hailey watching. The only time the OpenClaw gateway is touched is the
restart in 10g.8, and that needs Hailey's OK.

**Session variables.** Paste these after the ones at the top of this runbook:

```powershell
$Legacy  = "C:\Users\wubbu\.sharpwave\main"
$MainTok = "C:\Users\wubbu\.sharpwave\tokens\main.token"
$OwRepo  = "C:\Users\wubbu\src\openwave"                  # path can vary, e.g. C:\Users\wubbu\Desktop\Projects\openwave
$OwRoot  = Split-Path $OwRepo                               # folder the openwave tarball is packed into
$OwSha   = "bd9e45b4a9189ba616aa18b6294fb430854da7a6"   # openwave main: merge of PR #3 (0.1.3, tool results fix, sharpwave-core ^0.4.5)
$OcCfg   = "C:\Users\wubbu\.openclaw\openclaw.json"
$Stamp   = Get-Date -Format "yyyyMMdd-HHmmss"
```

`$MainTok` is OpenWave's default token location (`~/.sharpwave/tokens/{agentId}.token`). Section 5 used
`C:\Users\wubbu\.sharpwave-tokens` for the other agents. Either location works; what matters is that `brainTokenFile`
in 10g.4 matches. If section 5 already minted a `main` token, **don't mint a second one**. Instead, set
`$MainTok = Join-Path $TokDir "main.token"`, skip 10e, and use `C:/Users/wubbu/.sharpwave-tokens/{agentId}.token` in 10g.4.

> **About the `tripp` token from section 5:** it isn't Tripp. It's a separate service identity named `tripp`, with
> its own (empty) private brain `brains\tripp`. OpenWave looks tokens up by the **OpenClaw** agent id, which is `main`.
> After section 6, CoS can revoke the `tripp` token (section 9, last rows). Park `brains\tripp` with
> `Move-Item`; don't delete it.

**10.0 Does this build have `brain adopt`?**

```powershell
node $Cli help | Select-String "brain adopt"
```

If this prints nothing, the checkout predates sharpwave PR #12. Update it **after** stopping the service in 10c.1.
Windows locks the running service's native module, so `npm.cmd ci` fails while the service runs. Use the merge commit
of PR #12 (or the SHA Engram gives):

```powershell
Set-Location $Repo
git fetch origin
git checkout --detach 1fe8e6e17e78569e753037decdaeffcf3671955c
npm.cmd ci
npm.cmd run build
node $Cli help | Select-String "brain adopt"
```

### 10a. Is anything holding main's brain.db open?

OpenWave isn't installed, so OpenClaw itself shouldn't have the file open. In remote mode OpenWave never opens a local
brain; this was checked on 2026.9.7, where the gateway process held no brain file. Still, check for other holders,
especially an **old `sharpwave` MCP server** in `openclaw.json`. OpenClaw starts it as a child process, and it opens
`~\.sharpwave\<agent>\brain.db`.

```powershell
openclaw plugins inspect openwave
openclaw config get mcp.servers
Select-String -Path $OcCfg -Pattern "sharpwave" -SimpleMatch
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match "sharpwave|openwave" -and $_.CommandLine -notlike "*\packages\server\dist\cli.js*serve*" } | Select-Object ProcessId, ParentProcessId, CommandLine
```

(If `openclaw` says running scripts is disabled, use `openclaw.cmd`, just as with `npm.cmd`.)

Expected: `inspect` says openwave isn't found or installed. Note any `sharpwave` entry under `mcp.servers` for 10g.5.

**Exclusive-open test.** It opens the file read-only, asks for no sharing, and closes it again. It changes nothing:

```powershell
foreach ($f in @("$Legacy\brain.db", "$Legacy\brain.db-wal")) {
  if (-not (Test-Path $f)) { "$f : not present"; continue }
  try { $h = [System.IO.File]::Open($f, 'Open', 'Read', 'None'); $h.Close(); "$f : nobody has it open" }
  catch { "$f : OPEN in another process -> $($_.Exception.Message)" }
}
```

- **Nobody has it open:** carry on. Don't stop the gateway.
- **Open in another process:** find the holder (usually the `sharpwave` MCP child process listed above). Wait until
  Tripp is idle and test again. If it stays open, stopping the gateway for the duration of 10b and 10c is **Hailey's call**.
  Adopt only *reads* the source, and it aborts with `the source brain changed while it was being copied` if something
  writes to it mid-copy. An idle holder is therefore safe, but a busy writer isn't.

### 10b. Dated backup of `~\.sharpwave`

This is the same pattern as 0.6, taken right before the adoption. It goes **outside** `.sharpwave`:

```powershell
$Bak = "C:\Users\wubbu\sharpwave-backup-preadopt-$Stamp"
New-Item -ItemType Directory -Path $Bak | Out-Null
Get-ChildItem C:\Users\wubbu\.sharpwave -Force | Where-Object { $_.Name -ne "service" } | Copy-Item -Destination $Bak -Recurse
$src = Get-ChildItem C:\Users\wubbu\.sharpwave -Recurse -File | Where-Object { $_.FullName -notlike "*\.sharpwave\service\*" }
$dst = Get-ChildItem $Bak -Recurse -File
"source: {0} files, {1} bytes   backup: {2} files, {3} bytes" -f $src.Count, ($src | Measure-Object Length -Sum).Sum, $dst.Count, ($dst | Measure-Object Length -Sum).Sum
Get-ChildItem $Legacy -File | Get-FileHash -Algorithm SHA256 | Select-Object Hash, Path | Export-Csv "$Bak.main-hashes.csv" -NoTypeInformation
Import-Csv "$Bak.main-hashes.csv" | Format-Table -AutoSize
$Bak
```

The service folder is excluded because it has its own backups (2 and 6B). **Write down `$Bak`.**

**The 14 `_backup-pre-openwave-20260920-*` folders** in `.sharpwave` come from failed OpenWave installs. They're copied
along with everything else. **Leave them where they are.** Don't move, rename or delete them during this install.
Archiving them later is fine **with Hailey's OK**. To count them (read-only):

```powershell
Get-ChildItem C:\Users\wubbu\.sharpwave -Directory -Filter "_backup-pre-openwave-*" | Measure-Object | Select-Object Count
```

### 10c. Adopt: dry run first, then for real

**10c.1 Stop the brain service.** Adopt refuses to run while anything answers on port 18790.

```powershell
Stop-ScheduledTask -TaskName $Task
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*\packages\server\dist\cli.js*serve*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 2
Get-NetTCPConnection -LocalPort 18790 -State Listen -ErrorAction SilentlyContinue
```

The last line must print **nothing**. If you need the 10.0 update, do it now.

**10c.2 Dry run.** It writes nothing: the source is byte-copied to a temp folder and inspected there.

```powershell
node $Cli brain adopt --config $Cfg --agent main --from $Legacy --dry-run
```

Expected output:

```
DRY RUN — nothing written: agent "main" (mode copy)
  source   C:\Users\wubbu\.sharpwave\main\brain.db
           brain.db sha256 …
           brain.db-wal sha256 …            (only if a -wal exists)
           533 nodes, 1380 edges, 248 episodes, schema 17, … embedded
  target   C:\Users\wubbu\.sharpwave\service\brains\main\brain.db (absent)
  would:
    - pre-adopt backup (VACUUM INTO, WAL included) -> …\service\backups\main\pre-adopt\main-pre-adopt-<UTC>.db
    - copy backup -> …\service\brains\main\brain.db
    - open via sharpwave-core (migrate schema 17 -> 18)
    - leave writer_agent_id NULL on existing rows
    - verify integrity_check, counts, schema; checkpoint WAL
    - leave the source untouched (rollback = keep using it locally)
```

The counts are the live file's, including anything still in the `-wal`, so they may be a little higher than 533/1380/248
if Tripp has learned things since. What the target line can mean:

- `(absent)`: normal.
- `(empty: 0 nodes, 0 edges, 0 episodes)`: something opened `main` in the service before (for example a `main` token
  used in a smoke test). Adopt moves the empty file aside as `brain.db.pre-adopt-<UTC>` without `--force`.
- Refused with **`already exists with data`**: **STOP.** Something has written to `main`'s service brain. Find out what
  before deciding on `--force`. `--force` renames the existing brain aside and never deletes it.
- Refused with **`brain service port is in use`**: go back to 10c.1.

**10c.3 For real:**

```powershell
node $Cli brain adopt --config $Cfg --agent main --from $Legacy
$LASTEXITCODE
```

Expected: `ADOPTED`, `counts MATCH`, `after … schema 18, integrity ok`, `writer existing rows left NULL (no backfill)`,
`source unchanged (sha256 re-checked)`, exit code `0`. It takes about 1 s for a brain this size. **[UNTESTED ON WINDOWS]**
It was tested on Linux on a copy of this brain: 533/1380/248, schema 17 to 18, integrity ok, snapshot sha256 unchanged.

*Writer provenance (optional, CoS decides):* the default leaves `writer_agent_id` empty (NULL) on the old rows. That's
the honest answer, "written before provenance existed", and `brain_stats` shows them as `(none)`. Nothing in the service
depends on it. To tag them as `legacy:main` instead, add `--backfill-writer legacy`. Do that only at adoption time;
there's no separate backfill command. Don't stamp them as plain `main`, which would make them look as if they were
written through the service.

### 10d. Verify the counts

```powershell
Get-Content "$SvcRoot\audit\audit.jsonl" -Tail 1 | ConvertFrom-Json | Format-List time, agentId, tool, brain, outcome, detail
$pre = Get-ChildItem "$SvcRoot\backups\main\pre-adopt" -Filter *.db | Sort-Object Name | Select-Object -Last 1
(Get-FileHash $pre.FullName -Algorithm SHA256).Hash.ToLower()
(Get-Content "$($pre.FullName).json" -Raw | ConvertFrom-Json) | Format-List backup, sha256, counts, schema
$now = Get-ChildItem $Legacy -File | Get-FileHash -Algorithm SHA256 | Select-Object Hash, Path
Compare-Object (Import-Csv "$Bak.main-hashes.csv") $now -Property Hash, Path
```

Expected:

- the audit line reads `admin:cli brain_adopt main ok`, with `nodes=… edges=… episodes=… schema=17->18 integrity=ok`
  (counts and hashes only, no memory text);
- the backup's hash equals the manifest's `sha256`;
- `Compare-Object` prints **nothing**, meaning the legacy files weren't modified. A `brain.db-shm` difference alone
  is harmless; `-shm` is a SQLite index file, not data.

**10d.2 Start the service again:**

```powershell
Start-ScheduledTask -TaskName $Task
Start-Sleep -Seconds 5
Invoke-RestMethod "$Url/health"
```

### 10e. Mint the `main` token

Scopes are `read,write`. Add `shared-write` **only if CoS decides** Tripp may write to the shared brain. The token goes
straight into the file and is never shown:

```powershell
$MainTokDir = Split-Path $MainTok
New-Item -ItemType Directory -Force -Path $MainTokDir | Out-Null
icacls $MainTokDir /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" "SYSTEM:(OI)(CI)F"
if (Test-Path $MainTok) { throw "$MainTok already exists - revoke the old token first (section 9)" }
$j = node $Cli token mint --config $Cfg --agent main --scopes read,write --label "main (Tripp) via OpenWave" --json | ConvertFrom-Json
Set-Content -Path $MainTok -Value $j.token -NoNewline -Encoding ascii
"{0}  agent={1}  scopes={2}  file={3}" -f $j.id, $j.agentId, ($j.scopes -join ","), $MainTok
$j = $null
(Get-Item $MainTok).Length
```

The file should be 47 bytes. `.sharpwave\tokens` has no `brain.db` in it, so neither the legacy tools nor the service
treat it as a brain. Dated copies of `.sharpwave` made from now on contain this token file, so keep them local.

### 10f. Smoke test with the client CLI (counts only, no memory text on screen)

```powershell
node $Client health
node $Client stats --scope private --token-file $MainTok
(node $Client search "openclaw" --scope private --token-file $MainTok --json | ConvertFrom-Json).results.Count
node $Client stats --scope shared --token-file $MainTok
```

Expected: `[private] 533 nodes, 1380 edges, 248 episodes` (or the counts from 10c.3), a search count **greater than 0**,
and the shared brain's stats (0 nodes before seeding is fine).

**Shared read and isolation, using CoS's token from section 5:**

```powershell
$Cos = Join-Path $TokDir "chief-of-staff.token"
$s = node $Client write "Adoption smoke shared note" --label "adopt-smoke-shared" --shared --token-file $Cos --json | ConvertFrom-Json
(node $Client search "adoption smoke shared note" --scope shared --token-file $MainTok --json | ConvertFrom-Json).results.Count
(node $Client search "openclaw" --scope private --token-file $Cos --json | ConvertFrom-Json).results.Count
node $Client forget $s.id --shared --token-file $Cos
```

Expected: `main` finds the shared note (count ≥ 1); CoS finds **0** of main's private memories; the note is then removed.

### 10g. Install OpenWave into OpenClaw 2026.9.7 for `main`, remote mode

**Why this particular install method.** openwave isn't published to npm, so build it from the pinned commit and install
the tarball. Since openwave 0.1.3 (PR #3), `sharpwave-core` ^0.4.5 comes from npm, so plain `npm ci` works and the old
`npm install --no-save ..\sharpwave\packages\core` workaround is gone. Still install via **`npm pack`** + `npm-pack:`:
OpenClaw 2026.9.7's install safety scan is strict about what's inside a plugin folder, and the tarball path installs into
OpenClaw's own managed project like a registry plugin. Verified on Hailey's PC on 2026-10-01: 0.1.3 built from `bd9e45b`
with plain `npm ci`, gateway restarted, `remote.auth_check` ok with `serviceAgentId: main`, no errors.

**10g.1 Node.** OpenClaw 2026.9.7 requires Node **≥ 24.16** (`>=24.16.0 <25 || >=26.1.0`). The openwave build also
installs `openclaw` as a dev dependency, which enforces the same requirement.

```powershell
node -v
openclaw --version
```

**10g.2 Build openwave at the pinned commit.**

```powershell
Set-Location $OwRoot
if (-not (Test-Path $OwRepo)) { git clone https://github.com/Enlightened-Republic/openwave.git $OwRepo }
Set-Location $OwRepo
git fetch origin
git checkout --detach $OwSha
git rev-parse HEAD
npm.cmd ci --no-audit --no-fund
npm.cmd run build
Test-Path "$OwRepo\dist\index.js"
npm.cmd pack --pack-destination $OwRoot
Get-Item "$OwRoot\openwave-0.1.3.tgz" | Select-Object Name, Length
git status --short
```

Expected: the pinned SHA, `True`, an `openwave-0.1.3.tgz`, and a clean `git status`. If `$OwRepo` is an existing checkout
with uncommitted work (Hailey's Desktop checkout may have some), **don't** discard it: clone a fresh copy into another
folder instead and point `$OwRepo` there. `npm ci` downloads the `openclaw` dev dependency, which is large; give it a few
minutes.

**10g.3 Look at the current OpenClaw config, and back it up:**

```powershell
Copy-Item $OcCfg "$OcCfg.pre-openwave-$Stamp"
openclaw config get plugins.allow
openclaw config get plugins.entries.openwave
openclaw config get mcp.servers
openclaw plugins list
```

Write down: the `plugins.allow` list (or "unset"), whether `memory-core` shows as enabled (it's OpenClaw's bundled
memory plugin and is on by default), and whether `mcp.servers` has a `sharpwave` entry.

**10g.4 Config FIRST, then install.** OpenWave's default is local mode for `agents: ["main"]`. If it were installed
before its config exists, it would start in **local** mode on main's legacy `brain.db`. The install applies straight to
the running gateway, and with no allowlist a new plugin is enabled by default. Writing the config first prevents that.
Before the install, OpenClaw warns `plugin not found: openwave (stale config entry ignored ...)`. That's expected; the
entry is kept and used once the plugin is installed.

Build the patch. **If `plugins.allow` was unset**, leave the `allow` line out completely: adding it would turn on an
exclusive allowlist and switch off every other plugin. **If it was set**, the list *replaces* the old one, so it must
contain **every id it already had, plus `"openwave"`**:

```powershell
$Patch = "C:\Users\wubbu\src\openwave.patch.json5"
$json = @'
{
  plugins: {
    // allow: ["memory-core", "telegram", "...every id already in plugins.allow...", "openwave"],
    entries: {
      openwave: {
        enabled: true,
        hooks: { allowConversationAccess: true },
        config: {
          agents: ["main"],
          brainMode: "remote",
          brainUrl: "http://127.0.0.1:18790",
          brainTokenFile: "~/.sharpwave/tokens/{agentId}.token",
          sharedRecall: true,
          remoteTimeoutMs: 2500,
          curatedTierDedupe: true,
        },
      },
    },
  },
}
'@
Set-Content -Path $Patch -Value $json -Encoding ascii
notepad $Patch
openclaw config patch --file $Patch --dry-run
openclaw config patch --file $Patch
```

In Notepad, either delete the commented `allow` line or uncomment it and fill in the real list. Then save and close.
The dry run must say `Dry run successful`.

Notes on the snippet:

- `hooks.allowConversationAccess: true` is **required**. Without it OpenClaw blocks OpenWave's conversation hooks:
  no recall and no episodes. It belongs under `hooks`, not `config`.
- `brainTokenFile` is expanded per agent (`{agentId}` → `main`) to `C:\Users\wubbu\.sharpwave\tokens\main.token`. Never
  use the inline `brainToken` key.
- **Graft A / no double injection:** `memory-core` is active by default. When main's workspace has a non-empty
  `MEMORY.md`/`USER.md`, `curatedTierDedupe: true` (the default, stated explicitly here) makes OpenWave pass
  `externalMemoryActive` and drop identity/goal memories from its `[BRAIN: …]` recall block. memory-core already injects
  those, so this stops Tripp getting identity and goals twice. **Don't set it to `false`.** It only removes
  identity/goal nodes, so ordinary facts from memory-core's search and OpenWave's recall can still overlap. Watch the
  first few turns.
- Remote mode turns off OpenWave's local sleep timers and its `openwave:consolidation` cron; the service owns sleep.

**10g.5 Old `sharpwave` MCP server (only if 10g.3 showed one).** Once OpenWave is on, Tripp would see two sets of
`brain_*` tools. The MCP set keeps writing to the **legacy** file, which the service no longer reads. With Hailey's OK,
save the entry, then remove it:

```powershell
openclaw config get mcp.servers.sharpwave --json | Set-Content "C:\Users\wubbu\src\mcp-sharpwave-entry-$Stamp.json" -Encoding ascii
openclaw config unset mcp.servers.sharpwave
```

(The full config backup from 10g.3 also has it.)

**10g.6 Install from the tarball, then build the native module:**

```powershell
Set-Location $OwRoot
openclaw plugins install "npm-pack:.\openwave-0.1.3.tgz" --force --accept-capabilities --no-enable
Set-Location "C:\Users\wubbu\.openclaw\npm\projects\openwave"
npm.cmd rebuild better-sqlite3
```

- `--force` confirms a non-ClawHub source (it's our own tarball). `--accept-capabilities` records consent.
  `--no-enable` leaves `plugins.allow`/`deny` exactly as 10g.4 set them, and the entry from 10g.4 stays as written.
- OpenClaw installs plugin dependencies with `--ignore-scripts`, so `better-sqlite3`'s native binary isn't fetched.
  Remote mode never opens SQLite, but **local-mode rollback (10h) needs it**, so rebuild now. If the rebuild fails
  because the GitHub download is blocked (Norton/VPN), remote mode still works; note it and continue.

**10g.7 Check before restarting:**

```powershell
openclaw config validate
openclaw plugins inspect openwave
openclaw config get plugins.entries.openwave.config.brainMode
```

Expected: `Config valid`; `Status: enabled`, `Source: …\.openclaw\npm\projects\openwave\node_modules\openwave\dist\index.js`,
`Version: 0.1.3`; `remote`.

**10g.8 Restart the gateway (Hailey's OK).** **Hot-reload caveat:** in 2026.9.7, changes under `plugins.*` hot-reload,
the install applies through the running gateway, and entry config changes swap the plugin instance in place. Even so,
OpenWave's `gateway_start` work (health check, token check, episode-append detection, cleanup of a stale cron) is only
reliable after a **full restart**, and OpenWave's README requires one. Use the safe restart, which waits up to 5 minutes
for active work to finish:

```powershell
openclaw gateway restart --safe
```

**10g.9 Check the gateway logs:**

```powershell
openclaw logs --plain --limit 500 | Select-String "openwave|BAD BRAIN"
```

If `openclaw logs` can't connect, read the newest log file directly. On Windows it's under `%TEMP%`:

```powershell
$log = Get-ChildItem $env:TEMP -Recurse -Filter "openclaw-*.log" -ErrorAction SilentlyContinue | Sort-Object LastWriteTime | Select-Object -Last 1
Select-String -Path $log.FullName -Pattern "openwave|BAD BRAIN" | Select-Object -Last 20
```

Expected, in this order (these lines are from the 2026.9.7 test run):

```
[openwave] {"op":"register","outcome":"ok","brainMode":"remote","url":"http://127.0.0.1:18790","agents":1,"tools":11,"sharedRecall":true,"timeoutMs":2500,"tokenSources":"main:file",...}
[openwave] {"op":"gateway_start","outcome":"ready","brainMode":"remote","localSleep":false,"consolidationCron":false}
[openwave] {"op":"remote.health","outcome":"ok","url":"http://127.0.0.1:18790","version":"0.1.0","attempt":1}
[openwave] {"agentId":"main","op":"remote.episode_append","outcome":"enabled"}
[openwave] {"agentId":"main","op":"remote.auth_check","outcome":"ok","serviceAgentId":"main"}
```

**There must be no `BAD BRAIN TOKEN`, `unauthorized`, `misconfigured` or `brainMode":"local"`.** If you see a bad token,
the file or path is wrong: re-check 10e and `brainTokenFile`. If `remote.health` keeps retrying, the service is down
(10d.2). Then run the 10a exclusive-open test once more. The legacy `brain.db` must say **nobody has it open**, which
proves OpenWave isn't in local mode.

**10g.10 Talk to Tripp.** Hailey sends Tripp a normal Telegram message about something he already knows, with one unusual
word in it so it's easy to find (for example "*Quick check, pineapple: what do you remember about how the OpenClaw gateway
is set up?*"). Then:

```powershell
node $Client history "pineapple" --token-file $MainTok
node $Client stats --scope private --token-file $MainTok
Get-Content "$SvcRoot\audit\audit.jsonl" -Tail 5 | ConvertFrom-Json | Format-Table time, agentId, tool, brain, outcome -AutoSize
```

Expected:

- Tripp's reply draws on his old memories. That's the recall, coming from the adopted brain through the service.
- `history` shows the `user:` turn (and soon the `assistant:` turn) with `writer=main`.
- `episodes` is higher than in 10f.
- The audit log has `main brain_episode_append main ok` lines.

If episodes don't show up, check the log for `remote.episode_append … unsupported`. That would mean the service
build lacks `brain_episode_append` (sharpwave PR #11).

### 10h. Rollback

**Turn OpenWave off** (back to how things were before 10g):

```powershell
openclaw plugins disable openwave
openclaw gateway restart --safe
```

**Back to local mode on the legacy file:** the source was *copied*, not moved, so this works immediately:

```powershell
openclaw config set plugins.entries.openwave.config.brainMode local
openclaw gateway restart --safe
```

OpenWave then opens `C:\Users\wubbu\.sharpwave\main\brain.db` exactly as adoption left it. Its first open runs core's
additive migration on that file. Local mode needs the native module from 10g.6. To also restore the old MCP entry and
everything else, copy back the 10g.3 backup, then restart:

```powershell
$cfgBak = Get-ChildItem "$OcCfg.pre-openwave-*" | Sort-Object Name | Select-Object -Last 1
Copy-Item $cfgBak.FullName $OcCfg -Force
openclaw gateway restart --safe
```

**Divergence.** Everything Tripp learns in remote mode (episodes, `brain_write`, extracted facts) goes **only** to the
service brain `…\service\brains\main\brain.db`. None of it reaches the legacy file, and nothing merges it back
automatically. If that matters when going back to local mode:

- *Small amounts:* accept the loss, or re-write the few important facts with `brain_write` once in local mode.
- *Everything:* after adoption nothing writes to the legacy file (provided the old MCP entry was removed), so the service
  brain is a superset of it. Use the service brain *as* the local brain. Stop the gateway (Hailey's OK) and stop the
  service (10c.1), then run:

  ```powershell
  node $Cli backup now --config $Cfg --brain main --no-offsite
  $snap = Get-ChildItem "$SvcRoot\backups\main" -Filter "main-*.db" | Sort-Object Name | Select-Object -Last 1
  Get-ChildItem $Legacy -File | ForEach-Object { Rename-Item $_.FullName "$($_.Name).pre-rollback-$Stamp" }
  Copy-Item $snap.FullName "$Legacy\brain.db"
  ```

  Then set `brainMode local`, start the service again, and restart the gateway. The renamed legacy files stay as a
  further fallback. Never delete them.

**Undo the adoption on the service side** (rarely needed): stop the service (10c.1), then
`Rename-Item "$SvcRoot\brains\main\brain.db" "brain.db.parked-$Stamp"` (also rename any `-wal`/`-shm`), and start it
again. The pre-adopt backup in `…\service\backups\main\pre-adopt\` is a verified copy of the legacy brain as it was at
adoption time.

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
