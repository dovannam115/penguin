# Render Penguin app icons from source PNG (penguin avatar with blue rounded bg).
# Source has a white margin around the blue rounded square; we detect the blue
# bounds, crop to it, then apply a rounded-rect alpha mask so the corners are
# transparent (no white halo on dark backgrounds like the splash / login).
# Outputs: public/icon-192.png, public/icon-512.png, public/app-icon.ico, app/favicon.ico
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File render-icons.ps1
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$publicDir = Join-Path $PSScriptRoot "public"

$srcPath = Join-Path $publicDir "source-icon.png"
if (-not (Test-Path $srcPath)) {
    throw "Source icon not found at $srcPath"
}
$srcRaw = [System.Drawing.Image]::FromFile($srcPath)

# ─── Auto-detect the blue rounded square bounds inside the white-padded source.
# Scan inward from each edge until we hit a non-white pixel (anything noticeably
# darker / more saturated than #FAFAFA). Works regardless of exact padding size.
function Find-NonWhiteBounds {
    param([System.Drawing.Bitmap]$Bmp)
    $w = $Bmp.Width
    $h = $Bmp.Height
    $isWhitish = {
        param($c)
        return ($c.R -ge 245 -and $c.G -ge 245 -and $c.B -ge 245)
    }

    # Sample along a few rows / cols to be robust to anti-aliased corner pixels.
    $top = 0
    :outerTop for ($y = 0; $y -lt [int]($h * 0.4); $y++) {
        for ($x = [int]($w * 0.2); $x -lt [int]($w * 0.8); $x += 8) {
            $c = $Bmp.GetPixel($x, $y)
            if (-not (& $isWhitish $c)) { $top = $y; break outerTop }
        }
    }
    $bot = $h - 1
    :outerBot for ($y = $h - 1; $y -gt [int]($h * 0.6); $y--) {
        for ($x = [int]($w * 0.2); $x -lt [int]($w * 0.8); $x += 8) {
            $c = $Bmp.GetPixel($x, $y)
            if (-not (& $isWhitish $c)) { $bot = $y; break outerBot }
        }
    }
    $left = 0
    :outerLeft for ($x = 0; $x -lt [int]($w * 0.4); $x++) {
        for ($y = [int]($h * 0.2); $y -lt [int]($h * 0.8); $y += 8) {
            $c = $Bmp.GetPixel($x, $y)
            if (-not (& $isWhitish $c)) { $left = $x; break outerLeft }
        }
    }
    $right = $w - 1
    :outerRight for ($x = $w - 1; $x -gt [int]($w * 0.6); $x--) {
        for ($y = [int]($h * 0.2); $y -lt [int]($h * 0.8); $y += 8) {
            $c = $Bmp.GetPixel($x, $y)
            if (-not (& $isWhitish $c)) { $right = $x; break outerRight }
        }
    }
    # Make it square (pick the larger extent so we don't cut into the blue).
    $cx = ($left + $right) / 2
    $cy = ($top + $bot) / 2
    $half = [Math]::Max(($right - $left), ($bot - $top)) / 2
    $half = [int]($half + 1)  # small safety pad to fully include the rounded corner
    $sx = [Math]::Max(0, [int]($cx - $half))
    $sy = [Math]::Max(0, [int]($cy - $half))
    $size = $half * 2
    if ($sx + $size -gt $w) { $size = $w - $sx }
    if ($sy + $size -gt $h) { $size = $h - $sy }
    return @{ X = $sx; Y = $sy; Size = $size }
}

$srcBmp = New-Object System.Drawing.Bitmap $srcRaw
$bounds = Find-NonWhiteBounds -Bmp $srcBmp
Write-Output "Detected blue square: $($bounds.X),$($bounds.Y) size=$($bounds.Size)"

# Flood-fill the white background from each corner via inline C# (PowerShell
# loops would take minutes on 1024². Plain whitewash-by-threshold kills the
# penguin's white belly and the chat bubble - only pixels REACHABLE from a
# corner without crossing a non-white pixel are background.)
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class BgKey {
    public static void Run(Bitmap bmp, int threshold, int softMargin) {
        int w = bmp.Width;
        int h = bmp.Height;
        var rect = new Rectangle(0, 0, w, h);
        var data = bmp.LockBits(rect, ImageLockMode.ReadWrite, PixelFormat.Format32bppArgb);
        int stride = data.Stride;
        int len = stride * h;
        byte[] bytes = new byte[len];
        Marshal.Copy(data.Scan0, bytes, 0, len);

        // marks: 0 = untouched, 1 = background (flood-fill hit)
        byte[] marks = new byte[w * h];

        Func<int, int, bool> isWhitish = (x, y) => {
            int i = y * stride + x * 4;
            int b = bytes[i];
            int g = bytes[i+1];
            int r = bytes[i+2];
            int min = Math.Min(r, Math.Min(g, b));
            return min >= threshold;
        };

        var queue = new Queue<int>();
        int[][] seeds = new int[][] {
            new int[]{0,0}, new int[]{w-1,0}, new int[]{w-1,h-1}, new int[]{0,h-1}
        };
        foreach (var s in seeds) {
            int sx = s[0], sy = s[1];
            if (isWhitish(sx, sy)) {
                marks[sy * w + sx] = 1;
                queue.Enqueue(sy * w + sx);
            }
        }
        int[] dx = new int[]{-1, 1, 0, 0};
        int[] dy = new int[]{0, 0, -1, 1};
        while (queue.Count > 0) {
            int pos = queue.Dequeue();
            int y = pos / w;
            int x = pos - y * w;
            for (int k = 0; k < 4; k++) {
                int nx = x + dx[k];
                int ny = y + dy[k];
                if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
                int np = ny * w + nx;
                if (marks[np] != 0) continue;
                if (isWhitish(nx, ny)) {
                    marks[np] = 1;
                    queue.Enqueue(np);
                }
            }
        }

        // First pass: zero alpha for marked background pixels.
        for (int y = 0; y < h; y++) {
            for (int x = 0; x < w; x++) {
                if (marks[y * w + x] == 1) {
                    int i = y * stride + x * 4;
                    bytes[i+3] = 0;
                }
            }
        }
        // Second pass: anti-alias the edge - for each opaque pixel touching a
        // background pixel that's also light-coloured, ramp its alpha based on
        // how close to white it is. Keeps the blue rounded edge from looking
        // jagged where the flood-fill stopped.
        if (softMargin > 0) {
            for (int y = 0; y < h; y++) {
                for (int x = 0; x < w; x++) {
                    if (marks[y * w + x] == 1) continue;
                    bool touchesBg = false;
                    for (int k = 0; k < 4; k++) {
                        int nx = x + dx[k];
                        int ny = y + dy[k];
                        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
                        if (marks[ny * w + nx] == 1) { touchesBg = true; break; }
                    }
                    if (!touchesBg) continue;
                    int i = y * stride + x * 4;
                    int b = bytes[i], g = bytes[i+1], r = bytes[i+2];
                    int min = Math.Min(r, Math.Min(g, b));
                    if (min >= threshold - softMargin) {
                        // Ramp: min=threshold-softMargin → alpha 255; min=threshold → alpha 0
                        int a = (int)(255.0 * (threshold - min) / softMargin);
                        if (a < 0) a = 0;
                        if (a > 255) a = 255;
                        bytes[i+3] = (byte)a;
                    }
                }
            }
        }

        Marshal.Copy(bytes, 0, data.Scan0, len);
        bmp.UnlockBits(data);
    }
}
"@ -ReferencedAssemblies "System.Drawing"

Write-Output "Flood-filling background from corners..."
[BgKey]::Run($srcBmp, 235, 25)
Write-Output "Done."

function Render-Masked {
    # Source is already alpha-keyed (whites → transparent) by Invoke-AlphaKey.
    # We just crop to the blue square bounds and resize. No additional mask
    # needed - the source's own rounded shape becomes the icon's shape.
    param([System.Drawing.Bitmap]$Src, [hashtable]$Bounds, [int]$Size)

    $out = New-Object System.Drawing.Bitmap $Size, $Size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($out)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

    $destRect = New-Object System.Drawing.Rectangle 0, 0, $Size, $Size
    $g.DrawImage(
        $Src,
        $destRect,
        $Bounds.X, $Bounds.Y, $Bounds.Size, $Bounds.Size,
        [System.Drawing.GraphicsUnit]::Pixel
    )

    $g.Dispose()
    return $out
}

$b512 = Render-Masked -Src $srcBmp -Bounds $bounds -Size 512
$b512.Save("$publicDir\icon-512.png", [System.Drawing.Imaging.ImageFormat]::Png)
$b512.Dispose()
Write-Output "Wrote icon-512.png"

$b192 = Render-Masked -Src $srcBmp -Bounds $bounds -Size 192
$b192.Save("$publicDir\icon-192.png", [System.Drawing.Imaging.ImageFormat]::Png)
$b192.Dispose()
Write-Output "Wrote icon-192.png"

$sizes = @(16, 32, 48, 64, 128, 256)
$pngBytes = @{}
foreach ($s in $sizes) {
    $b = Render-Masked -Src $srcBmp -Bounds $bounds -Size $s
    $ms = New-Object System.IO.MemoryStream
    $b.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $pngBytes[$s] = $ms.ToArray()
    $b.Dispose()
    $ms.Dispose()
}

$srcBmp.Dispose()
$srcRaw.Dispose()

$icoPath = "$publicDir\app-icon.ico"
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter $fs

$bw.Write([uint16]0)
$bw.Write([uint16]1)
$bw.Write([uint16]$sizes.Count)

$dataOffset = 6 + 16 * $sizes.Count
foreach ($s in $sizes) {
    $data = $pngBytes[$s]
    $w = if ($s -eq 256) { 0 } else { $s }
    $bw.Write([byte]$w)
    $bw.Write([byte]$w)
    $bw.Write([byte]0)
    $bw.Write([byte]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]32)
    $bw.Write([uint32]$data.Length)
    $bw.Write([uint32]$dataOffset)
    $dataOffset += $data.Length
}
foreach ($s in $sizes) {
    $bw.Write($pngBytes[$s])
}

$bw.Close()
$fs.Close()
Write-Output "Wrote app-icon.ico ($($sizes -join ', ') sizes)"

$faviconPath = Join-Path $PSScriptRoot "app\favicon.ico"
Copy-Item $icoPath $faviconPath -Force
Write-Output "Wrote app/favicon.ico"
