# Tách con penguin (NÉT CAO) từ source-icon.png (1024x1024) -> penguin-mascot.png.
# B0: cắt bỏ viền trắng (về ô xanh). B1: chroma-key bỏ nền xanh.
# B2: giữ khối lớn nhất (penguin), bỏ bong bóng chat. B3: crop sát + lưu.
Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'

$pub = Join-Path $PSScriptRoot "..\public" | Resolve-Path
$src = Join-Path $pub "source-icon.png"
$dst = Join-Path $pub "penguin-mascot.png"

$raw = New-Object System.Drawing.Bitmap ([System.Drawing.Image]::FromFile($src))
$W = $raw.Width; $H = $raw.Height

# ── B0: tìm vùng không-trắng (ô xanh) bằng cách quét thưa từ mỗi mép ──
function White($c){ return ($c.R -ge 245 -and $c.G -ge 245 -and $c.B -ge 245) }
$top=0; $bot=$H-1; $left=0; $right=$W-1
:t for($y=0;$y -lt [int]($H*0.45);$y++){ for($x=[int]($W*0.2);$x -lt [int]($W*0.8);$x+=8){ if(-not (White $raw.GetPixel($x,$y))){$top=$y;break t} } }
:b for($y=$H-1;$y -gt [int]($H*0.55);$y--){ for($x=[int]($W*0.2);$x -lt [int]($W*0.8);$x+=8){ if(-not (White $raw.GetPixel($x,$y))){$bot=$y;break b} } }
:l for($x=0;$x -lt [int]($W*0.45);$x++){ for($y=[int]($H*0.2);$y -lt [int]($H*0.8);$y+=8){ if(-not (White $raw.GetPixel($x,$y))){$left=$x;break l} } }
:r for($x=$W-1;$x -gt [int]($W*0.55);$x--){ for($y=[int]($H*0.2);$y -lt [int]($H*0.8);$y+=8){ if(-not (White $raw.GetPixel($x,$y))){$right=$x;break r} } }

$cw=$right-$left+1; $ch=$bot-$top+1
$bmp=New-Object System.Drawing.Bitmap $cw,$ch
$g=[System.Drawing.Graphics]::FromImage($bmp)
$g.DrawImage($raw,(New-Object System.Drawing.Rectangle 0,0,$cw,$ch),(New-Object System.Drawing.Rectangle $left,$top,$cw,$ch),[System.Drawing.GraphicsUnit]::Pixel)
$g.Dispose(); $raw.Dispose()
Write-Host "B0 cat o xanh: $cw x $ch"

$w=$bmp.Width; $h=$bmp.Height
$rect=New-Object System.Drawing.Rectangle 0,0,$w,$h
$data=$bmp.LockBits($rect,[System.Drawing.Imaging.ImageLockMode]::ReadWrite,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$stride=$data.Stride
$bytes=New-Object byte[] ($stride*$h)
[System.Runtime.InteropServices.Marshal]::Copy($data.Scan0,$bytes,0,$bytes.Length)

# ── B1: bỏ nền xanh (B trội hơn R/G) ──
for($y=0;$y -lt $h;$y++){ $row=$y*$stride
  for($x=0;$x -lt $w;$x++){ $i=$row+$x*4
    $b=$bytes[$i];$gg=$bytes[$i+1];$r=$bytes[$i+2];$a=$bytes[$i+3]
    if($a -eq 0){continue}
    $maxRG=[Math]::Max($r,$gg); $blue=$b-$maxRG
    if($b -gt 110 -and $blue -gt 34){ $bytes[$i+3]=0 }
    elseif($b -gt 100 -and $blue -gt 14){ $t=($blue-14)/20.0; if($t -gt 1){$t=1}; $bytes[$i+3]=[byte]([Math]::Round($a*(1-$t))) }
  }
}

# ── B2: giữ khối lớn nhất ──
$n=$w*$h
$label=New-Object int[] $n
$opaque=New-Object bool[] $n
for($y=0;$y -lt $h;$y++){ $row=$y*$stride; for($x=0;$x -lt $w;$x++){ if($bytes[$row+$x*4+3] -gt 40){$opaque[$y*$w+$x]=$true} } }
$cur=0;$bestLabel=0;$bestSize=0
$stack=New-Object 'System.Collections.Generic.Stack[int]'
for($p=0;$p -lt $n;$p++){
  if($opaque[$p] -and $label[$p] -eq 0){
    $cur++;$size=0;$stack.Push($p);$label[$p]=$cur
    while($stack.Count -gt 0){
      $q=$stack.Pop();$size++; $qx=$q%$w;$qy=[int]($q/$w)
      if($qx -gt 0){$nb=$q-1; if($opaque[$nb] -and $label[$nb] -eq 0){$label[$nb]=$cur;$stack.Push($nb)}}
      if($qx -lt $w-1){$nb=$q+1; if($opaque[$nb] -and $label[$nb] -eq 0){$label[$nb]=$cur;$stack.Push($nb)}}
      if($qy -gt 0){$nb=$q-$w; if($opaque[$nb] -and $label[$nb] -eq 0){$label[$nb]=$cur;$stack.Push($nb)}}
      if($qy -lt $h-1){$nb=$q+$w; if($opaque[$nb] -and $label[$nb] -eq 0){$label[$nb]=$cur;$stack.Push($nb)}}
    }
    if($size -gt $bestSize){$bestSize=$size;$bestLabel=$cur}
  }
}
Write-Host "B2 penguin = $bestSize px (tong $cur khoi)"
for($y=0;$y -lt $h;$y++){ $row=$y*$stride; for($x=0;$x -lt $w;$x++){ if($label[$y*$w+$x] -ne $bestLabel){$bytes[$row+$x*4+3]=0} } }

[System.Runtime.InteropServices.Marshal]::Copy($bytes,0,$data.Scan0,$bytes.Length)
$bmp.UnlockBits($data)

# ── B3: crop sát + pad ──
$minX=$w;$minY=$h;$maxX=0;$maxY=0
for($y=0;$y -lt $h;$y++){ $row=$y*$stride; for($x=0;$x -lt $w;$x++){ if($bytes[$row+$x*4+3] -gt 20){
  if($x -lt $minX){$minX=$x}; if($x -gt $maxX){$maxX=$x}; if($y -lt $minY){$minY=$y}; if($y -gt $maxY){$maxY=$y} } } }
$pad=24
$minX=[Math]::Max(0,$minX-$pad);$minY=[Math]::Max(0,$minY-$pad)
$maxX=[Math]::Min($w-1,$maxX+$pad);$maxY=[Math]::Min($h-1,$maxY+$pad)
$ow=$maxX-$minX+1;$oh=$maxY-$minY+1
$crop=New-Object System.Drawing.Bitmap $ow,$oh
$g2=[System.Drawing.Graphics]::FromImage($crop)
$g2.DrawImage($bmp,(New-Object System.Drawing.Rectangle 0,0,$ow,$oh),(New-Object System.Drawing.Rectangle $minX,$minY,$ow,$oh),[System.Drawing.GraphicsUnit]::Pixel)
$g2.Dispose()
$crop.Save($dst,[System.Drawing.Imaging.ImageFormat]::Png)
$crop.Dispose();$bmp.Dispose()
Write-Host "Saved $dst ($ow x $oh)"
