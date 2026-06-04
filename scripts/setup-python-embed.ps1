# setup-python-embed.ps1 - Tạo lại bản Python NHÚNG cho Agent P.
#
# Mục đích: nhúng sẵn Python + python-pptx vào app để máy người dùng (vd bạn
# bè nhận bản đóng gói) KHÔNG cần tự cài Python. Tool pptx_export gọi
# python-embed\python.exe; pack.ps1 đóng gói luôn thư mục python-embed vào zip.
#
# Khi nào chạy: chỉ khi thư mục python-embed CHƯA có (máy dev mới, hoặc đã xoá).
# Bản đã build sẵn nằm trong repo nên bình thường KHÔNG cần chạy lại.
#
# Chạy:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup-python-embed.ps1

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot          # thư mục app
$dest = Join-Path $root "python-embed"
$pyVer = "3.13.12"                                 # khớp wheel cp313 của python-pptx
$tmp = Join-Path $env:TEMP "agentp-pyembed"

if (Test-Path (Join-Path $dest "python.exe")) {
    Write-Output "python-embed da ton tai: $dest  (xoa thu muc neu muon tao lai)"
    & (Join-Path $dest "python.exe") -c "import pptx; print('python-pptx', pptx.__version__)"
    exit 0
}

New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$embedZip = Join-Path $tmp "py-embed.zip"
$getPip = Join-Path $tmp "get-pip.py"

Write-Output "1/5  Tai Python embeddable $pyVer ..."
Invoke-WebRequest -Uri "https://www.python.org/ftp/python/$pyVer/python-$pyVer-embed-amd64.zip" -OutFile $embedZip

Write-Output "2/5  Giai nen vao $dest ..."
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Expand-Archive -Path $embedZip -DestinationPath $dest -Force

Write-Output "3/5  Bat site-packages trong ._pth ..."
$pth = Get-ChildItem -Path $dest -Filter "python3*._pth" | Select-Object -First 1
@"
python313.zip
.
Lib\site-packages

import site
"@ | Set-Content -Path $pth.FullName -Encoding ascii

Write-Output "4/5  Bootstrap pip ..."
Invoke-WebRequest -Uri "https://bootstrap.pypa.io/get-pip.py" -OutFile $getPip
& (Join-Path $dest "python.exe") $getPip --no-warn-script-location

Write-Output "5/5  Cai python-pptx ..."
& (Join-Path $dest "python.exe") -m pip install --no-warn-script-location python-pptx

Write-Output ""
& (Join-Path $dest "python.exe") -c "import pptx; print('OK python-pptx', pptx.__version__)"
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Write-Output "Xong. python-embed san sang tai: $dest"
