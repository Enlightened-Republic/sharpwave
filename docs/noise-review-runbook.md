# Noise review: find and retire heartbeat/system-noise memories (reversible)

For CoS to run on Hailey's PC **with Hailey watching**. Nothing here deletes a
memory. Every write step takes a backup first, is audit-logged, and can be
undone with one command.

**Background.** Before openwave 0.1.4 and this sharpwave change, OpenClaw machinery
turns were stored as episodes, and sleep turned some of them into recallable nodes.
These were heartbeat polls, exec/cron wakes, and `NO_REPLY` / `HEARTBEAT_OK` triage
replies. Example: a semantic node starting `NO_REPLY — <time>, daytime but no …-blocked work…`
that ranks first for the owner's name. New turns are now filtered at the source
(openwave), at the service (`brain_episode_append`) and in core sleep. This
runbook cleans up what is already there.

**What "retire" does.**
- **Node:** `valid_until = now`. Recall already hides every node with a past
  `valid_until`: FTS, vector, spreading activation and bootstrap. `ripple_count`
  and `eligibility_trace` are set to 0.
- **Episode:** `importance = 0` and `llm_extracted = 1`, which puts it below every
  recap and sleep floor.
- **Undo record:** the prior values are stored in the brain's own `meta_kv`
  (`retired:node:<id>` / `retired:episode:<id>`). Core sleep never downscales or
  prunes a node that has such a row, so `noise unretire` restores it exactly.
  Content, edges, embeddings and row counts are untouched.

Session variables (same as the install runbook):

```powershell
$Cli     = "C:\Users\wubbu\src\sharpwave\packages\server\dist\cli.js"
$Client  = "C:\Users\wubbu\src\sharpwave\packages\server\bin\sharpwave-client.mjs"
$Cfg     = "C:\Users\wubbu\.sharpwave\service\config.json"
$Task    = "SharpWave Brain Service"
$Tripp   = "<path to main's token file used by openwave (brainTokenFile)>"
```

## 0. Preconditions

- The sharpwave build on the PC includes this change, so `node $Cli help` lists `noise`.
- Deploy openwave 0.1.4 first, or at the same time, so no new noise arrives.

## 1. Scan (service keeps running)

`scan` and `check` are read-only and safe next to the live service.

```powershell
node $Cli noise scan  --config $Cfg --agent main
node $Cli noise check --config $Cfg --agent main --query "Hailey"
```

`scan` prints the counts by category and the report paths:
`~\.sharpwave\service\noise-reports\main-<UTC>.csv` and `.json`. These files stay
on the PC. Do not commit or paste them anywhere; they contain memory previews.
`check` shows the FTS top hits for "Hailey" and marks the noise ones `[NOISE:…]`.

## 2. Review the CSV together

Open the CSV in Excel or Notepad. The columns are: `action, kind, id, type, category, confidence,
importance, retrievability, created_at, writer, source, session, preview`.

- `action=retire`: high confidence. These are silent replies (`NO_REPLY…`, `HEARTBEAT_OK`),
  OpenClaw wake markers, and nodes minted only from such episodes.
- `action=review`: lower confidence (triage phrasing, mixed sources). These are
  often **real** conversation *about* heartbeats. Leave them as `review`, or set them to `keep`.
- Only rows whose `action` is exactly `retire` are acted on. To spare a row, change it
  to `keep`. To retire a review row, change it to `retire`. Save as CSV.

## 3. Retire (service stopped for a minute)

`retire` writes the brain file directly, so it refuses while the service port answers.

```powershell
Stop-ScheduledTask -TaskName $Task
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*\packages\server\dist\cli.js*serve*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

node $Cli noise retire --config $Cfg --agent main --ids-file <reviewed.csv> --dry-run   # counts only
node $Cli noise retire --config $Cfg --agent main --ids-file <reviewed.csv>
```

The output shows the batch id (`noise-<UTC>`), the backup path
(`backups\main\noise-retire\noise-retire-<UTC>.db`), a manifest JSON, and the exact undo command.
Write the batch id down.

```powershell
node $Cli noise status --config $Cfg --agent main
node $Cli noise check  --config $Cfg --agent main --query "Hailey"     # noise gone from the top
Start-ScheduledTask -TaskName $Task
```

## 4. Verify through the live service (the real recall path)

```powershell
node $Client search "Hailey" --scope private --token-file $Tripp
node $Client stats --token-file $Tripp           # node/episode counts unchanged
```

None of the retired ids should appear. `node $Client read <id> --token-file $Tripp`
still opens a retired node by id, which shows nothing was deleted.

## 5. Undo (any time)

```powershell
Stop-ScheduledTask -TaskName $Task
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*\packages\server\dist\cli.js*serve*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
node $Cli noise unretire --config $Cfg --agent main --batch <noise-UTC>      # or --ids-file f / --all
Start-ScheduledTask -TaskName $Task
```

`unretire` takes its own backup first and restores the recorded values exactly.
As a last resort, the pre-retire backup `.db` is a full copy of the brain: stop the
service, copy it over `brains\main\brain.db`, and start the service again.

The audit trail is `~\.sharpwave\service\audit\audit.jsonl`, with `tool` set to
`noise.retire` or `noise.unretire`.
