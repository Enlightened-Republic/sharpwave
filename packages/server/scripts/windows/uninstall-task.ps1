<#
.SYNOPSIS
  Stops and removes the "SharpWave Brain Service" Scheduled Task, then ends any
  node.exe still running this checkout's sharpwave-server "serve". Brains,
  backups, tokens and logs under ~/.sharpwave/service are NOT touched.

.PARAMETER KeepProcess
  Only unregister the task; leave a running node.exe alone.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$TaskName = "SharpWave Brain Service",
  [switch]$KeepProcess
)

$ErrorActionPreference = "Stop"
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Host "No task named '$TaskName'."
} elseif ($PSCmdlet.ShouldProcess($TaskName, "Stop + Unregister-ScheduledTask")) {
  # Stopping the task ends the .vbs wrapper first, so it cannot restart node.
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed task '$TaskName'. Data under $env:USERPROFILE\.sharpwave\service was left in place."
}

if (-not $KeepProcess) {
  # Match only node.exe processes running THIS checkout's dist\cli.js with "serve".
  $cli = (Resolve-Path (Join-Path $PSScriptRoot "..\..\dist") -ErrorAction SilentlyContinue)
  $pattern = if ($cli) { "*" + $cli.Path + "\cli.js*serve*" } else { "*\packages\server\dist\cli.js*serve*" }
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like $pattern })
  foreach ($p in $procs) {
    if ($PSCmdlet.ShouldProcess("node.exe pid $($p.ProcessId)", "Stop-Process")) {
      Stop-Process -Id $p.ProcessId -Force
      Write-Host "Stopped node.exe pid $($p.ProcessId) ($pattern)."
    }
  }
  if ($procs.Count -eq 0) { Write-Host "No running sharpwave-server process matched $pattern." }
}
