' Export every slide of a .pptx to PNG via PowerPoint COM.
' usage: cscript //nologo scripts\pptx-to-png.vbs <in.pptx> <outDir>
Set args = WScript.Arguments
inPath = args(0)
outDir = args(1)

Set fso = CreateObject("Scripting.FileSystemObject")
inPath = fso.GetAbsolutePathName(inPath)
outDir = fso.GetAbsolutePathName(outDir)
If Not fso.FolderExists(outDir) Then fso.CreateFolder(outDir)

Set ppt = CreateObject("PowerPoint.Application")
' PowerPoint requires a window to render; keep it minimized-ish.
On Error Resume Next
ppt.Visible = True
On Error Goto 0

Set pres = ppt.Presentations.Open(inPath, True, False, False)
' Export at 1280x720 so it lines up with the source viewport.
Dim i
For i = 1 To pres.Slides.Count
  pres.Slides(i).Export outDir & "\slide-" & Right("00" & i, 3) & ".png", "PNG", 1280, 720
Next
pres.Close
ppt.Quit
WScript.Echo "exported " & pres.Slides.Count & " slides"
