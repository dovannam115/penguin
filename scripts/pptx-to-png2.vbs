' Export every slide of a .pptx to PNG via PowerPoint COM (mở CÓ cửa sổ).
' usage: cscript //nologo scripts\pptx-to-png2.vbs <in.pptx> <outDir>
Set args = WScript.Arguments
inPath = args(0)
outDir = args(1)

Set fso = CreateObject("Scripting.FileSystemObject")
inPath = fso.GetAbsolutePathName(inPath)
outDir = fso.GetAbsolutePathName(outDir)
If Not fso.FolderExists(outDir) Then fso.CreateFolder(outDir)

Set ppt = CreateObject("PowerPoint.Application")
ppt.Visible = True
' Open(FileName, ReadOnly, Untitled, WithWindow) — WithWindow = msoTrue (-1).
Set pres = ppt.Presentations.Open(inPath, True, False, True)

n = pres.Slides.Count
Dim i
For i = 1 To n
  pres.Slides(i).Export outDir & "\slide-" & Right("00" & i, 3) & ".png", "PNG", 1280, 720
Next
WScript.Echo "exported " & n & " slides"
pres.Close
ppt.Quit
