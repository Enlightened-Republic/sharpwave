' sharpwave-service.vbs - windowless launcher for the SharpWave brain service.
'
' Same pattern as OpenClaw's gateway.vbs: the Scheduled Task runs
'   wscript.exe //B //Nologo sharpwave-service.vbs "<node.exe>" "<dist\cli.js>" ["<config.json>"] ["<log file>"]
' and this script starts node through WScript.Shell.Run with window style 0
' (hidden), so no console window ever appears - at logon, after a crash, or on
' a manual "Run". It WAITS for node to exit. It never passes a secret on the
' command line.
'
' Crash restart: Task Scheduler's "restart on failure" setting only fires when
' the task fails to START; it does not fire when an already-running action
' exits with a non-zero code. So this wrapper supervises node itself: if node
' exits non-zero (crash, port 18790 still taken, killed), it waits 30 s and
' starts it again, up to 1000 times. A clean exit (code 0, e.g. Ctrl+C or
' SIGBREAK) ends the wrapper. To stop the service for good, stop the TASK
' first (Stop-ScheduledTask ends this wrapper), then end node.exe if it is
' still running; see uninstall-task.ps1 / docs/windows-install-runbook.md.
Option Explicit

Dim sh, fso, args, nodeExe, cliJs, configPath, logFile, cmd, rc, restarts

Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
Set args = WScript.Arguments

If args.Count < 2 Then
  WScript.Quit 2
End If

nodeExe = args(0)
cliJs = args(1)
configPath = ""
logFile = ""
If args.Count >= 3 Then configPath = args(2)
If args.Count >= 4 Then logFile = args(3)

If Not fso.FileExists(nodeExe) Then WScript.Quit 3
If Not fso.FileExists(cliJs) Then WScript.Quit 4

cmd = Q(nodeExe) & " " & Q(cliJs) & " serve"
If Len(configPath) > 0 Then
  If fso.FileExists(configPath) Then cmd = cmd & " --config " & Q(configPath)
End If
If Len(logFile) > 0 Then cmd = cmd & " --log-file " & Q(logFile)

sh.CurrentDirectory = fso.GetParentFolderName(cliJs)
' 0 = hidden window, True = wait for exit (so the task tracks the process).
restarts = 0
Do
  rc = sh.Run(cmd, 0, True)
  If rc = 0 Then Exit Do
  restarts = restarts + 1
  If restarts > 1000 Then Exit Do
  WScript.Sleep 30000
Loop
WScript.Quit rc

Function Q(s)
  Q = Chr(34) & s & Chr(34)
End Function
