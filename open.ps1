# Penguin quick-open - invoked by the Desktop / Start Menu shortcut.
# If the dev server is already listening on :3000, opens the browser directly
# (no splash). Otherwise hands off to launcher.vbs for the full splash + server
# startup so the first click after a reboot still works.
$ErrorActionPreference = "Stop"
$projectDir = $PSScriptRoot

function Test-Port {
    param([int]$Port)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $ar = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
        $ok = $ar.AsyncWaitHandle.WaitOne(150, $false)
        return ($ok -and $client.Connected)
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Get-AgentPBrowser {
    $candidates = @(
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe"
    )
    foreach ($p in $candidates) { if (Test-Path $p) { return $p } }
    return $null
}

function Get-AgentPEdgeArgs {
    $profileDir = Join-Path $env:LOCALAPPDATA "AgentP\EdgeProfile"
    if (-not (Test-Path $profileDir)) { New-Item -ItemType Directory -Path $profileDir -Force | Out-Null }
    return @(
        "--app=http://localhost:3000",
        "--user-data-dir=$profileDir",
        "--no-first-run",
        "--no-default-browser-check"
    )
}

if (Test-Port 3000) {
    $browser = Get-AgentPBrowser
    $edgeArgs = Get-AgentPEdgeArgs
    if ($browser) {
        Start-Process $browser -ArgumentList $edgeArgs
    } else {
        Start-Process "http://localhost:3000"
    }
} else {
    $vbs = Join-Path $projectDir "launcher.vbs"
    $sh = New-Object -ComObject WScript.Shell
    $sh.Run("wscript """ + $vbs + """", 0, $false)
}
