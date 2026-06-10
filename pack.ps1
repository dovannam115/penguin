# Package Penguin for sharing - strips runtime/cache dirs and writes a versioned
# zip to Desktop. Run via `npm run pack` (PowerShell required).
# Version is read from package.json; bump it there before packing a new release.
$src = $PSScriptRoot
$stamp = Get-Date -Format "yyyyMMdd-HHmm"
$stage = "$env:TEMP\penguin-stage-$stamp"
$pkgJson = Get-Content "$src\package.json" -Raw | ConvertFrom-Json
# Strip trailing .0 patch so "1.7.0" → "1.7" matches the Penguin_vX.Y naming convention.
$ver = $pkgJson.version -replace '\.0$',''
$zip = "$env:USERPROFILE\Desktop\Penguin_v$ver.zip"

# Production build is shipped so launcher uses `next start` (all routes
# pre-compiled), not turbopack `next dev` which lazily compiles routes and
# silently drops them from app-paths-manifest after a server restart - that
# caused the "files panel goes empty after stop/start" bug.
Write-Output "Building production bundle..."
Push-Location $src
& npm run build
$buildExit = $LASTEXITCODE
Pop-Location
if ($buildExit -ne 0) {
    Write-Error "next build failed (exit $buildExit). Aborting pack."
    exit 1
}

Write-Output "Staging to $stage..."
# /XD excludes directories; /XF excludes file patterns. Use full paths for
# .next subdirs so we keep the production server bundle while dropping cache.
# .data         - user data (chat history, DB, password), keep on user machine
# node_modules  - installed by launcher.ps1 on first run (with progress UI)
# .next\dev     - turbopack dev cache (~400MB, unused by `next start`)
# .next\cache   - build cache for incremental rebuilds (not needed at runtime)
# .git          - version control
# *.log / Screenshot* / a.png / b.png - dev cruft
# Penguin_v*.zip / AGENT-P_v*.zip / mas-ai-office-*.zip / *update*.zip - leftover update packs.
#   (Do NOT exclude a bare *.zip - that would also drop python-embed\python313.zip,
#    the embedded Python stdlib, breaking pptx/preview on installed copies.)
$null = robocopy $src $stage /E `
  /XD node_modules .data .git test-output .claude .update-staging "$src\.next\dev" "$src\.next\cache" `
  /XF *.tsbuildinfo next-env.d.ts password-backup.txt *.log "Screenshot *.png" a.png b.png c.png "Penguin_v*.zip" "AGENT-P_v*.zip" "mas-ai-office-*.zip" "agentp-update-*.zip" "update-*.zip" ".dev-server.log" cloudflared.exe current-url.txt run-server.ps1 run-penguin-web.ps1 start-server.bat start-penguin-web.bat screen-off.bat startup-server.ps1 startup-server.vbs
# robocopy exits 0-7 = success (with various levels of "files copied"), 8+ = error
if ($LASTEXITCODE -ge 8) {
    Write-Error "robocopy failed (exit $LASTEXITCODE)"
    exit 1
}

Write-Output "Compressing to $zip..."
if (Test-Path $zip) { Remove-Item $zip -Force }
# Compress-Archive uses Write-Progress internally which crashes in non-interactive
# hosts (no console buffer), and also struggles with large trees (~500MB+ node_modules).
# .NET's ZipFile.CreateFromDirectory is faster, has no progress dependency, and
# handles big folders fine.
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory(
    $stage, $zip,
    [System.IO.Compression.CompressionLevel]::Optimal,
    $false  # don't include base dir
)

Remove-Item $stage -Recurse -Force

$size = [Math]::Round((Get-Item $zip).Length / 1KB, 1)
Write-Output ""
Write-Output "ZIP_PATH: $zip"
Write-Output "SIZE: $size KB"
