' Penguin silent launcher — invokes launcher.ps1 with no cmd flash.
Option Explicit
Dim fso, sh, scriptDir, psScript, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
psScript = scriptDir & "\launcher.ps1"
sh.CurrentDirectory = scriptDir
cmd = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & psScript & """"
sh.Run cmd, 0, False
