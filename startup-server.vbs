' Agent P — silent wrapper for startup-server.ps1.
' Used by the Windows Startup shortcut so the server boots without any window.
Option Explicit
Dim fso, sh, scriptDir, psScript, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
psScript = scriptDir & "\startup-server.ps1"
sh.CurrentDirectory = scriptDir
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & psScript & """"
sh.Run cmd, 0, False
