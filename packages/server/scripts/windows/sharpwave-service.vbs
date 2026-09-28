' sharpwave-service.vbs - windowless launcher for the SharpWave brain service.
'
' Same pattern as OpenClaw's gateway.vbs: the Scheduled Task runs
'   wscript.exe //B //Nologo sharpwave-service.vbs "<node.exe>" "<dist\cli.js>" ["<config.json>"] ["<log file>"]
' and this script starts node through WScript.Shell.Run with window style 0
' (hidden), so no console window ever appears - at logon, on restart-on-failure,
' or on a manual "Run". It WAITS for node to exit and returns node's exit code,
' so Task Scheduler sees crashes as failures and its restart-on-failure policy
' applies. It never passes a secret on the command line.
Option Explicit

Dim sh, fso, args, nodeExe, cliJs, configPath, logFile, cmd, rc

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
rc = sh.Run(cmd, 0, True)
WScript.Quit rc

Function Q(s)
  Q = Chr(34) & s & Chr(34)
End Function
