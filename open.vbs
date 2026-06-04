' Penguin quick-open — used by the Desktop / Start Menu shortcut.
' Opens the browser straight away if the server is already running; otherwise
' falls through to launcher.vbs (which shows the splash and starts the server).
Option Explicit
Dim fso, sh, scriptDir, psScript, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
psScript = scriptDir & "\open.ps1"
sh.CurrentDirectory = scriptDir
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & psScript & """"
sh.Run cmd, 0, False
