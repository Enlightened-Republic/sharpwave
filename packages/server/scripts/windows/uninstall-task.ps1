<#
.SYNOPSIS
  Stops and removes the "SharpWave Brain Service" Scheduled Task. Brains,
  backups, tokens and logs under ~/.sharpwave/service are NOT touched.
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param([string]$TaskName = "SharpWave Brain Service")

$ErrorActionPreference = "Stop"
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) { Write-Host "No task named '$TaskName'."; exit 0 }

if ($PSCmdlet.ShouldProcess($TaskName, "Stop + Unregister-ScheduledTask")) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Removed task '$TaskName'. Data under $env:USERPROFILE\.sharpwave\service was left in place."
  Write-Host "If node.exe is still running the service: Get-CimInstance Win32_Process -Filter ""Name='node.exe'"" | ? CommandLine -like '*sharpwave*serve*' | % { Stop-Process -Id `$_.ProcessId }"
}
