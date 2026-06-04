# Agent P - apply staged update + relaunch.
# Invoked detached by POST /api/update/apply after the Node server exits.
# Args:
#   -InstallDir : Agent P install root (will receive staged files)
#   -StagedDir  : .update-staging/extracted/ (source of new files)
param(
    [Parameter(Mandatory=$true)][string]$InstallDir,
    [Parameter(Mandatory=$true)][string]$StagedDir
)

$ErrorActionPreference = 'Continue'
$logFile = Join-Path $env:TEMP 'agent-p-apply-staged.log'
function Log($msg) {
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $msg" | Out-File $logFile -Append -Encoding utf8
}

Log "apply-staged invoked InstallDir=$InstallDir StagedDir=$StagedDir"

# Wait for port 3000 to free (= server has exited). Up to 20s.
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
    $conn = netstat -ano | Select-String ":3000\s.*LISTENING"
    if (-not $conn) { break }
    Start-Sleep -Milliseconds 400
}
# Last-resort kill anything still squatting on 3000.
$conns = netstat -ano | Select-String ":3000\s.*LISTENING"
foreach ($line in $conns) {
    $cols = ($line.ToString() -split '\s+') | Where-Object { $_ }
    $existingPid = $cols[-1]
    if ($existingPid -match '^\d+$') {
        try { Stop-Process -Id ([int]$existingPid) -Force -ErrorAction Stop; Log "killed pid $existingPid on 3000" } catch { }
    }
}
Start-Sleep -Milliseconds 600

# Wipe stale .next BEFORE robocopy: the previous build's compiled server bundles
# bake their build-time constants (eg. package.json version → /api/update/check)
# at "npm run build" time. Robocopy /E overwrites changed files but leaves
# orphan chunks behind, and a corrupted or partial bundle can mix old + new
# code, leaving the post-update server reporting the previous version forever.
# Clearing .next here guarantees the new build is the ONLY thing serving after
# restart. The staged zip always contains a fresh .next/ (pack.ps1 runs
# `next build` before zipping), so the install dir gets a clean refresh.
$nextDir = Join-Path $InstallDir '.next'
if (Test-Path $nextDir) {
    try {
        Remove-Item $nextDir -Recurse -Force -ErrorAction Stop
        Log "wiped stale .next bundle"
    } catch {
        Log "wipe .next failed (continuing - robocopy will overwrite what it can): $($_.Exception.Message)"
    }
}

# Copy staged contents over install dir. /IS /IT forces overwrite even when
# size + timestamp match. Excludes user data and the staging dir itself.
# Fast path: if stage step detected package-lock unchanged, the marker file
# at .update-staging/.skip-node-modules tells us to leave the existing
# node_modules in place (saves 10-30s on a 500MB copy + matches what's
# already installed since deps didn't change).
$skipNodeModules = Test-Path (Join-Path $InstallDir '.update-staging\.skip-node-modules')
$excludeDirs = @("$InstallDir\.data", "$InstallDir\.update-staging")
if ($skipNodeModules) {
    $excludeDirs += "$InstallDir\node_modules"
    Log "fast path: package-lock unchanged, skipping node_modules copy"
}
# Default robocopy behaviour: skip files where size + timestamp already match.
# /IS /IT previously forced overwrite on every file, which dominated swap time
# on large node_modules trees. Files that actually changed (source, .next,
# updated deps) still copy because their mtime differs.
Log "robocopy starting (skipNodeModules=$skipNodeModules)"
$null = robocopy $StagedDir $InstallDir /E /MT:16 /R:1 /W:1 /NFL /NDL /NP `
    /XD $excludeDirs `
    /XF password-backup.txt *.log .last-update-source-list.txt
Log "robocopy exit code: $LASTEXITCODE"

# Log the post-swap version so a stuck-on-old-version bug is visible in the log
# without needing to dig through the new server's responses.
$pkgPath = Join-Path $InstallDir 'package.json'
if (Test-Path $pkgPath) {
    try {
        $newVer = (Get-Content $pkgPath -Raw | ConvertFrom-Json).version
        Log "post-swap package.json version=$newVer"
    } catch {
        Log "could not parse post-swap package.json: $($_.Exception.Message)"
    }
}

# Cleanup staging
$staging = Join-Path $InstallDir '.update-staging'
if (Test-Path $staging) {
    try { Remove-Item $staging -Recurse -Force -ErrorAction Stop } catch {
        Log "staging cleanup err: $($_.Exception.Message)"
    }
}

# Restart the server directly - bypass launcher.vbs. The launcher splash adds
# ~5s minimum, warms up routes (~5-10s), then opens a SECOND Edge window on
# top of the one the browser is already polling from. For an in-app update,
# none of that is wanted: just bring the server back so the polling tab
# reconnects.
$buildIdFile = Join-Path $InstallDir '.next\BUILD_ID'
$cmdLine = if (Test-Path $buildIdFile) { 'npm start' } else { 'npm run dev' }
Log "starting server hidden: $cmdLine"
Start-Process cmd -ArgumentList "/c",$cmdLine -WorkingDirectory $InstallDir -WindowStyle Hidden
Log "done"
