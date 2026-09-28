<#
.SYNOPSIS
  Registers the "SharpWave Brain Service" Scheduled Task (at logon, restart on
  failure, hidden via a .vbs WScript wrapper). Nothing is started unless you
  pass -StartNow.

.DESCRIPTION
  Mirrors how the OpenClaw gateway task runs on Windows: an ONLOGON task for the
  current user, limited (non-elevated) run level, whose action is
    wscript.exe //B //Nologo sharpwave-service.vbs "<node.exe>" "<cli.js>" "<config>" "<log>"
  so node.exe is launched with window style 0 and no console window flashes.

  Run from a normal (non-admin) PowerShell:
    powershell -ExecutionPolicy Bypass -File .\install-task.ps1            # register only
    powershell -ExecutionPolicy Bypass -File .\install-task.ps1 -StartNow  # register + start
    powershell -ExecutionPolicy Bypass -File .\install-task.ps1 -WhatIf    # show what would happen

  Uninstall: .\uninstall-task.ps1  (or: Unregister-ScheduledTask -TaskName "SharpWave Brain Service")
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$TaskName   = "SharpWave Brain Service",
  [string]$NodePath   = "",
  [string]$ServerCli  = "",
  [string]$ConfigPath = (Join-Path $env:USERPROFILE ".sharpwave\service\config.json"),
  [string]$LogFile    = (Join-Path $env:USERPROFILE ".sharpwave\service\logs\service.log"),
  [switch]$StartNow
)

$ErrorActionPreference = "Stop"

if (-not $NodePath) {
  $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
  if (-not $cmd) { throw "node.exe not found on PATH; pass -NodePath 'C:\Program Files\nodejs\node.exe'" }
  $NodePath = $cmd.Source
}
$NodePath = (Resolve-Path $NodePath).Path

$ver = (& $NodePath -p "process.versions.node").Trim()
if ([int]($ver.Split(".")[0]) -lt 22) { throw "sharpwave-server needs Node >= 22 (found $ver at $NodePath)" }

if (-not $ServerCli) { $ServerCli = Join-Path $PSScriptRoot "..\..\dist\cli.js" }
if (-not (Test-Path $ServerCli)) { throw "server CLI not found at $ServerCli - run 'npm run build' in packages/server first" }
$ServerCli = (Resolve-Path $ServerCli).Path

$Vbs = (Resolve-Path (Join-Path $PSScriptRoot "sharpwave-service.vbs")).Path
$Wscript = Join-Path $env:SystemRoot "System32\wscript.exe"
$UserId = "$env:USERDOMAIN\$env:USERNAME"

New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null

$argLine = '//B //Nologo "{0}" "{1}" "{2}" "{3}" "{4}"' -f $Vbs, $NodePath, $ServerCli, $ConfigPath, $LogFile

$action    = New-ScheduledTaskAction -Execute $Wscript -Argument $argLine -WorkingDirectory (Split-Path $ServerCli)
$trigger   = New-ScheduledTaskTrigger -AtLogOn -User $UserId
$settings  = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $UserId -LogonType Interactive -RunLevel Limited

Write-Host "Task      : $TaskName"
Write-Host "Action    : $Wscript $argLine"
Write-Host "Trigger   : at logon of $UserId"
Write-Host "Restart   : every 1 min on failure (up to 999x), no time limit"

if ($PSCmdlet.ShouldProcess($TaskName, "Register-ScheduledTask")) {
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description "SharpWave brain service (MCP over HTTP on 127.0.0.1:18790 + tailnet). Hidden via sharpwave-service.vbs." -Force | Out-Null
  Write-Host "Registered. Not started." -ForegroundColor Green
  if ($StartNow) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Started. Check: Invoke-RestMethod http://127.0.0.1:18790/health"
  } else {
    Write-Host "Start it with: Start-ScheduledTask -TaskName '$TaskName'  (or log off/on)"
  }
}
