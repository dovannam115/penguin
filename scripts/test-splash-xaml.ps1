# Smoke-test: trích khối XAML splash trong launcher.ps1, nạp thử bằng XamlReader
# (không ShowDialog, không chạy server) để bắt lỗi cú pháp XAML / animation.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName WindowsBase

$root = Split-Path $PSScriptRoot -Parent
$content = Get-Content (Join-Path $root 'launcher.ps1') -Raw

$m = [regex]::Match($content, '(?s)\$xamlStr = @"\r?\n(.*?)\r?\n"@')
if (-not $m.Success) { throw "Không tìm thấy khối XAML." }
$xaml = $m.Groups[1].Value

$fontDirUri = ([System.Uri](Join-Path $root "public\fonts\")).AbsoluteUri
$penguinUri = ([System.Uri](Join-Path $root "public\penguin-mascot.png")).AbsoluteUri
$xaml = $xaml.Replace("__FONT_DIR__", $fontDirUri).Replace("__PENGUIN__", $penguinUri)

$reader = New-Object System.Xml.XmlTextReader (New-Object System.IO.StringReader $xaml)
$win = [Windows.Markup.XamlReader]::Load($reader)
if (-not $win) { throw "XamlReader trả về null." }

$need = @('dragBar','btnClose','brandPanel','penguinGroup','pTrans','pRot','pScale',
          'pShadow','pShadowScale','statusText','progressBar')
$missing = @()
foreach ($n in $need) { if ($null -eq $win.FindName($n)) { $missing += $n } }
if ($missing.Count) { throw "Thiếu element: $($missing -join ', ')" }

Write-Host "OK - XAML nap thanh cong, du $($need.Count) element co ten." -ForegroundColor Green
