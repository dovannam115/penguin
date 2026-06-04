# Agent P - silent server bootstrap for Windows auto-start.
# Runs `npm run dev` in the background only if port 3000 isn't already in use.
# No splash, no browser. The pinned/desktop shortcut opens the browser later.
$ErrorActionPreference = "Continue"
$projectDir = $PSScriptRoot
$logFile = "$env:TEMP\agent-p-startup.log"

function Log($msg) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Out-File $logFile -Append -Encoding utf8
}

function Test-Port {
    param([int]$Port)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $ar = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
        $ok = $ar.AsyncWaitHandle.WaitOne(300, $false)
        return ($ok -and $client.Connected)
    } catch { return $false } finally { $client.Close() }
}

Log "startup-server invoked (projectDir=$projectDir)"

if (Test-Port 3000) {
    Log "Port 3000 already in use - skipping boot."
    exit 0
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Log "Node.js not found on PATH - aborting."
    exit 1
}

if (-not (Test-Path (Join-Path $projectDir "node_modules"))) {
    Log "node_modules missing - running npm install first."
    Start-Process npm -ArgumentList "install" -WorkingDirectory $projectDir -WindowStyle Hidden -Wait
}

Log "Spawning: npm run dev"
Start-Process cmd -ArgumentList "/c","npm run dev" `
    -WorkingDirectory $projectDir -WindowStyle Hidden | Out-Null
Log "Server spawn requested. Done."
