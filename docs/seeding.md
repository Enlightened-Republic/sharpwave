# Seeding the brain service

How to load the reviewed **ER brain seed pack** (Markdown files `00-README.md` … `08-decisions-log.md`) into the
SharpWave brain service on Hailey's PC. Do this after `docs/windows-install-runbook.md` sections 0 to 6 have passed.
It uses the same session variables (`$Srv`, `$Cli`, `$Client`, `$SvcRoot`, `$Cfg`, `$TokDir`).

> **The pack's content never goes into this repo**, a PR, a ticket, or chat. This doc only names the files.

## Mapping

| file | target | why |
|---|---|---|
| `00-README.md` | **skip** | rules for humans/agents about the pack, not memories |
| `01-who-we-are.md` | shared | |
| `02-products-and-services.md` | shared | |
| `03-clients.md` | **private: Chief of Staff's brain only** | **SENSITIVE.** Never shared, never loaded into any other agent |
| `04-team-and-lanes.md` | shared | |
| `05-active-projects.md` | shared | |
| `06-infrastructure.md` | shared | |
| `07-preferences.md` | shared | |
| `08-decisions-log.md` | shared | |

"private" always means **the brain of the token doing the import**. The import must therefore run with **CoS's token**
(`chief-of-staff`, which has the `admin` scope that seeding needs). Then `03-clients.md` lands in `brains\chief-of-staff`
and nowhere else.

## How the importer works (`sharpwave-client seed`)

- Reads every `*.md` file in the folder. **Every file must be mapped explicitly** (`--map file=shared|private|skip`).
  An unmapped file is a hard error, so a new file can't land in shared by accident. Don't use `--target shared` as a catch-all.
- Splits each file at `#`, `##`, and `###` headings (headings inside code fences don't count). Each section becomes
  one memory node with the label `File title › Section › Subsection`. Sections longer than 1800 characters are split
  on paragraph or line boundaries into `(part i/n)`. Empty sections are dropped.
- Sends each file to the server's `brain_seed` tool (admin only, and hidden from non-admin agents' tool lists).
  Each node gets `source = seed:<file>#<16-hex sha256 of type+label+content>`, type `semantic`, importance 0.6, and
  the tags `seed, <file-stem>` (appended as a `Tags:` line). It's written by the token's agent and recorded in the audit log.
- **Idempotent:** a chunk whose hash already exists in that brain is skipped. Re-running creates nothing new.
  If a file is edited, changed sections become new nodes, and the old versions are reported as `stale=`.
  `--prune` deletes those stale ones.
- `--offline`: chunk only and print counts. No server or token needed.
  `--dry-run`: ask the server what *would* be created. Nothing is written.
  `--list`: count seeded nodes per file in the private and shared brains.
  `--remove`: delete every node seeded from the mapped (non-skip) files. This is the rollback by source tag.

Expected counts for the reviewed pack as of 2026-09-30. If they differ, the pack changed since review; ask before importing.

| target | files | chunks |
|---|---|---|
| shared | 01, 02, 04, 05, 06, 07, 08 | **40** (01: 7, 02: 8, 04: 5, 05: 10, 06: 4, 07: 4, 08: 2) |
| private (CoS) | 03 | **4** |
| skip | 00 | 0 |

## Step 1: get the pack onto Hailey's PC (privately, outside git)

The server runs on Hailey's PC, so the import has to run there and read the files there. Put them in
`C:\Users\wubbu\er-brain-seed\`. That's **not** inside the repo checkout (`C:\Users\wubbu\src\sharpwave`) and **not**
inside `.sharpwave`. Options, best first:

1. **CoS writes the files locally on the PC** from its own reviewed copy, one file at a time, with Hailey watching.
   Nothing leaves the PC.
2. **Direct private transfer** of the 9 files from the box where the pack was reviewed to the PC (an agent-to-machine
   file copy that Hailey approves, or a USB stick). **Not** through git, a public or shared cloud link, email, or a chat paste.

Then verify that every file arrived intact:

```powershell
$Pack = "C:\Users\wubbu\er-brain-seed"
Get-ChildItem $Pack -Filter *.md | Select-Object Name, Length
Get-ChildItem $Pack -Filter *.md | Get-FileHash -Algorithm SHA256 | Select-Object Hash, @{n="File";e={Split-Path $_.Path -Leaf}}
```

There should be 9 files, and the hashes should match the manifest Engram reported for the reviewed pack. (The manifest
isn't in this repo either.) If a file was retyped rather than copied, hashes won't match. Check the `--offline`
counts in step 3 instead.

## Step 2: pre-seed backup

```powershell
node $Cli backup now --config $Cfg
Get-ChildItem "$SvcRoot\backups\shared", "$SvcRoot\backups\chief-of-staff" | Sort-Object LastWriteTime | Select-Object -Last 2 FullName, Length
```

Note the two snapshot paths. They're the "restore" rollback below.

## Step 3: count, then dry-run

```powershell
$Cos  = Join-Path $TokDir "chief-of-staff.token"
$Pack = "C:\Users\wubbu\er-brain-seed"
$Map  = @("--map", "00-README.md=skip", "--map", "01-who-we-are.md=shared", "--map", "02-products-and-services.md=shared", "--map", "03-clients.md=private", "--map", "04-team-and-lanes.md=shared", "--map", "05-active-projects.md=shared", "--map", "06-infrastructure.md=shared", "--map", "07-preferences.md=shared", "--map", "08-decisions-log.md=shared")
node $Client seed $Pack @Map --offline
node $Client seed $Pack @Map --dry-run --token-file $Cos
```

Check: `03-clients.md` shows **`private`**, the totals are 40 shared and 4 private, and `wouldCreate` equals `chunks`
(nothing seeded yet).

## Step 4: import

```powershell
node $Client seed $Pack @Map --token-file $Cos
```

Expected: `created 44, already present 0`.

## Step 5: verify

```powershell
node $Client seed $Pack @Map --list --token-file $Cos
node $Client stats --token-file $Cos
node $Client seed $Pack @Map --token-file $Cos
```

- `--list`: `[private] 4 seeded nodes` with only `03-clients.md: 4`. `[shared] 40 seeded nodes` with 01, 02, and 04 to 08,
  and **no `03-clients.md`**.
- The second import prints `created 0, already present 44`. That proves it's idempotent.

The sensitive file must never touch the shared brain. Check the audit log. Both commands must print **nothing / 0**:

```powershell
Get-Content "$SvcRoot\audit\audit.jsonl" | ConvertFrom-Json | Where-Object { $_.detail -eq "seed:03-clients.md" -and $_.brain -ne "chief-of-staff" }
(Get-Content "$SvcRoot\audit\audit.jsonl" | ConvertFrom-Json | Where-Object { $_.tool -eq "brain_seed" -and $_.brain -eq "shared" -and $_.detail -like "*03-clients*" }).Count
```

Visibility check from another agent. Tripp should find shared seed memories but nothing from 03. Use a topic word you
know is in a shared file, and one you know is only in 03-clients; type these on the PC, don't put them in chat:

```powershell
$Tripp = Join-Path $TokDir "tripp.token"
node $Client search "PUT-A-SHARED-TOPIC-WORD-HERE" --token-file $Tripp
node $Client search "PUT-A-03-ONLY-WORD-HERE" --token-file $Tripp
node $Client search "PUT-A-03-ONLY-WORD-HERE" --token-file $Cos
```

Expected: the first shows `[shared] ... writer chief-of-staff`. The second shows **no** 03 content. The third shows
`[private]` hits, for CoS only.

## Rollback

**A. Remove by source tag** (surgical; the service keeps running). Removes exactly the nodes seeded from the listed
files and nothing hand-written. To roll back everything:

```powershell
node $Client seed $Pack @Map --remove --token-file $Cos
node $Client seed $Pack @Map --list --token-file $Cos
```

To roll back **one** file (example: `05-active-projects.md`), skip the rest:

```powershell
node $Client seed $Pack --target skip --map 05-active-projects.md=shared --remove --token-file $Cos
```

**B. Restore the pre-seed snapshot** (whole brain back to step 2; anything written after step 2 is lost):

```powershell
$Snap = "PASTE-THE-SHARED-SNAPSHOT-PATH-FROM-STEP-2"
Stop-ScheduledTask -TaskName "SharpWave Brain Service"
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*\packages\server\dist\cli.js*serve*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Copy-Item -Path "$SvcRoot\brains\shared\brain.db" -Destination "$SvcRoot\brains\shared\brain.db.before-restore" -Force
Remove-Item "$SvcRoot\brains\shared\brain.db-wal", "$SvcRoot\brains\shared\brain.db-shm" -ErrorAction SilentlyContinue
Copy-Item -Path $Snap -Destination "$SvcRoot\brains\shared\brain.db" -Force
Start-ScheduledTask -TaskName "SharpWave Brain Service"
Start-Sleep -Seconds 5
node $Client stats --token-file $Cos
```

For CoS's private brain, do the same with `brains\chief-of-staff` and the chief-of-staff snapshot.

## Updating the pack later

Edit the file on the PC, then run step 3 (`--dry-run`) and an import with `--prune`:

```powershell
node $Client seed $Pack @Map --dry-run --token-file $Cos
node $Client seed $Pack @Map --prune --token-file $Cos
```

`--prune` deletes only seeded nodes from the same file whose section text no longer exists. Keep the pack itself out of git.
