# Builds the glassmorphic wizard assets for the RuneType Glyphmaker installer.
# Outputs (installer/assets): wizard-large.bmp, wizard-small.bmp, wordmark.bmp, setup.ico
Add-Type -AssemblyName System.Drawing

$root      = "C:\Users\okana\fontmaker\installer"
$assets    = Join-Path $root "assets"
$desktop   = "C:\Users\okana\Desktop"
$fontsDir  = "C:\Users\okana\fontmaker\cep\assets\fonts"
New-Item -ItemType Directory -Force -Path $assets | Out-Null

# ---- theme ----
$bgTop    = [System.Drawing.Color]::FromArgb(31,34,40)    # #1F2228
$bgBot    = [System.Drawing.Color]::FromArgb(15,16,20)    # #0F1014
$contentBg= [System.Drawing.Color]::FromArgb(27,29,34)    # #1B1D22
$red      = [System.Drawing.Color]::FromArgb(192,39,29)   # #C0271D
$ink      = [System.Drawing.Color]::FromArgb(220,219,218) # #DCDBDA
$muted    = [System.Drawing.Color]::FromArgb(150,150,150)

# ---- fonts (Delight if available, else Segoe UI) ----
$pfc = New-Object System.Drawing.Text.PrivateFontCollection
foreach($f in @("Delight-Bold.otf","Delight-Medium.otf","Delight-Black.otf","AdobeClean-Bold.otf")){
  $fp = Join-Path $fontsDir $f; if(Test-Path $fp){ try{ $pfc.AddFontFile($fp) }catch{} }
}
function Fam([string]$want,[string]$fallback){
  foreach($ff in $pfc.Families){ if($ff.Name -like "*$want*"){ return $ff } }
  return (New-Object System.Drawing.FontFamily($fallback))
}
$famDisplay = Fam "Delight" "Segoe UI"

function NewG([System.Drawing.Bitmap]$b){
  $g = [System.Drawing.Graphics]::FromImage($b)
  $g.SmoothingMode     = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode   = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAlias
  return $g
}
function VGradient($g,$rect,$c1,$c2){
  $br = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect,$c1,$c2,90)
  $g.FillRectangle($br,$rect); $br.Dispose()
}
# centered, letter-tracked caps
function TrackedCaps($g,[string]$text,$font,$brush,$cx,$y,$track){
  $total=0; $ws=@()
  foreach($ch in $text.ToCharArray()){ $s=[string]$ch; $sz=$g.MeasureString($s,$font); $ws+=,$sz.Width; $total+=$sz.Width+$track }
  $total-=$track
  $x=$cx-($total/2)
  $i=0
  foreach($ch in $text.ToCharArray()){ $s=[string]$ch; $g.DrawString($s,$font,$brush,$x,$y); $x+=$ws[$i]+$track; $i++ }
}

# ===== 1) wizard-large.bmp : left band glass panel with red portrait stamp =====
$LW=492; $LH=942
$big = New-Object System.Drawing.Bitmap($LW,$LH,[System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = NewG $big
VGradient $g (New-Object System.Drawing.Rectangle(0,0,$LW,$LH)) $bgTop $bgBot
# faint grid sheen
$pen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(8,255,255,255),1)
for($y=0;$y -lt $LH;$y+=48){ $g.DrawLine($pen,0,$y,$LW,$y) }
for($x=0;$x -lt $LW;$x+=48){ $g.DrawLine($pen,$x,0,$x,$LH) }
$pen.Dispose()
# red glow behind stamp
$glow = New-Object System.Drawing.Drawing2D.GraphicsPath
$glow.AddEllipse(($LW/2-260),140,520,520)
$pgb = New-Object System.Drawing.Drawing2D.PathGradientBrush($glow)
$pgb.CenterColor = [System.Drawing.Color]::FromArgb(120,192,39,29)
$pgb.SurroundColors = @([System.Drawing.Color]::FromArgb(0,192,39,29))
$g.FillPath($pgb,$glow); $pgb.Dispose(); $glow.Dispose()
# red portrait stamp
$stampP = Join-Path $desktop "rune logo stamp.png"
$sp = New-Object System.Drawing.Bitmap($stampP)
$tw=300; $th=[int]($sp.Height*$tw/$sp.Width)
$g.DrawImage($sp,[int](($LW-$tw)/2),190,$tw,$th)
$sp.Dispose()
# GLYPHMAKER
$fGly = New-Object System.Drawing.Font($famDisplay,30,[System.Drawing.FontStyle]::Bold,[System.Drawing.GraphicsUnit]::Pixel)
$brInk= New-Object System.Drawing.SolidBrush($ink)
TrackedCaps $g "GLYPHMAKER" $fGly $brInk ($LW/2) 720 6
# divider
$pen2 = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(40,255,255,255),1)
$g.DrawLine($pen2,($LW/2-120),775,($LW/2+120),775); $pen2.Dispose()
# by BRST STUDIO
$fBy = New-Object System.Drawing.Font($famDisplay,20,[System.Drawing.FontStyle]::Regular,[System.Drawing.GraphicsUnit]::Pixel)
$brMut= New-Object System.Drawing.SolidBrush($muted)
TrackedCaps $g "by BRST STUDIO" $fBy $brMut ($LW/2) 895 4
# right edge highlight
$penE = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(60,255,255,255),1)
$g.DrawLine($penE,$LW-1,0,$LW-1,$LH); $penE.Dispose()
$g.Dispose()
$big.Save((Join-Path $assets "wizard-large.bmp"),[System.Drawing.Imaging.ImageFormat]::Bmp)
$big.Dispose()
"wrote wizard-large.bmp ${LW}x${LH}"

# ===== 2) wizard-small.bmp : red square stamp on dark =====
$SW=110
$sm = New-Object System.Drawing.Bitmap($SW,$SW,[System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = NewG $sm
VGradient $g (New-Object System.Drawing.Rectangle(0,0,$SW,$SW)) $bgTop $bgBot
$sq = New-Object System.Drawing.Bitmap((Join-Path $assets "..\..\cep\assets\stamp.png"))
$pad=10; $g.DrawImage($sq,$pad,$pad,$SW-2*$pad,$SW-2*$pad)
$sq.Dispose(); $g.Dispose()
$sm.Save((Join-Path $assets "wizard-small.bmp"),[System.Drawing.Imaging.ImageFormat]::Bmp)
$sm.Dispose()
"wrote wizard-small.bmp ${SW}x${SW}"

# ===== 3) wordmark.bmp : white brush wordmark composited on content bg (contain) =====
$WW=560; $WH=384
$wm = New-Object System.Drawing.Bitmap($WW,$WH,[System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$g = NewG $wm
$g.Clear($contentBg)
$word = New-Object System.Drawing.Bitmap((Join-Path $desktop "runebeyaz.png"))
# crop transparent margins (known bbox: 58,40 1282x854) then contain within padding
$cropX=58;$cropY=40;$cropW=1282;$cropH=854
$pad=28; $availW=$WW-2*$pad; $availH=$WH-2*$pad
$scale=[Math]::Min($availW/$cropW,$availH/$cropH)
$tw=[int]($cropW*$scale); $th=[int]($cropH*$scale)
$dx=[int](($WW-$tw)/2); $dy=[int](($WH-$th)/2)
$g.DrawImage($word,(New-Object System.Drawing.Rectangle($dx,$dy,$tw,$th)),(New-Object System.Drawing.Rectangle($cropX,$cropY,$cropW,$cropH)),[System.Drawing.GraphicsUnit]::Pixel)
$word.Dispose(); $g.Dispose()
$wm.Save((Join-Path $assets "wordmark.bmp"),[System.Drawing.Imaging.ImageFormat]::Bmp)
$wm.Dispose()
"wrote wordmark.bmp ${WW}x${WH}"

# ===== 4) setup.ico : red square stamp (multi-size, classic 32bpp DIB) =====
function DibBytes([System.Drawing.Bitmap]$bmp){
  $w=$bmp.Width; $h=$bmp.Height
  $rect=New-Object System.Drawing.Rectangle(0,0,$w,$h)
  $d=$bmp.LockBits($rect,[System.Drawing.Imaging.ImageLockMode]::ReadOnly,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $buf=New-Object byte[] ($d.Stride*$h)
  [System.Runtime.InteropServices.Marshal]::Copy($d.Scan0,$buf,0,$buf.Length)
  $stride=$d.Stride; $bmp.UnlockBits($d)
  $ms=New-Object System.IO.MemoryStream; $bw2=New-Object System.IO.BinaryWriter($ms)
  $bw2.Write([uint32]40); $bw2.Write([int32]$w); $bw2.Write([int32]($h*2))     # BITMAPINFOHEADER, height doubled (XOR+AND)
  $bw2.Write([uint16]1); $bw2.Write([uint16]32); $bw2.Write([uint32]0)
  $bw2.Write([uint32]0); $bw2.Write([int32]0); $bw2.Write([int32]0); $bw2.Write([uint32]0); $bw2.Write([uint32]0)
  for($y=$h-1;$y -ge 0;$y--){ $bw2.Write($buf,$y*$stride,$w*4) }              # XOR (BGRA, bottom-up)
  $maskRow=[int]([Math]::Floor(($w+31)/32)*4)
  $bw2.Write((New-Object byte[] ($maskRow*$h)))                               # AND mask, all opaque
  $bw2.Flush(); return ,$ms.ToArray()                                         # leading comma: keep byte[] intact
}
$srcSq = New-Object System.Drawing.Bitmap((Join-Path $assets "..\..\cep\assets\stamp.png"))
$base = New-Object System.Drawing.Bitmap(256,256,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$g = NewG $base; $g.DrawImage($srcSq,0,0,256,256); $g.Dispose(); $srcSq.Dispose()
$sizes = @(256,64,48,32,16)
$imgs=@()
foreach($s in $sizes){
  $bm = New-Object System.Drawing.Bitmap($s,$s,[System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $gg = NewG $bm; $gg.DrawImage($base,0,0,$s,$s); $gg.Dispose()
  $imgs += ,@{ size=$s; dib=(DibBytes $bm) }; $bm.Dispose()
}
$base.Dispose()
$icoPath = Join-Path $assets "setup.ico"
$fs = [System.IO.File]::Create($icoPath)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$imgs.Count)
$offset = 6 + 16*$imgs.Count
foreach($im in $imgs){
  $s=$im.size; $len=$im.dib.Length
  $bw.Write([byte]($(if($s -ge 256){0}else{$s}))); $bw.Write([byte]($(if($s -ge 256){0}else{$s})))
  $bw.Write([byte]0); $bw.Write([byte]0); $bw.Write([uint16]1); $bw.Write([uint16]32)
  $bw.Write([uint32]$len); $bw.Write([uint32]$offset); $offset += $len
}
foreach($im in $imgs){ $bw.Write([byte[]]$im.dib) }
$bw.Flush(); $fs.Close()
"wrote setup.ico ($($imgs.Count) sizes, DIB)"
"DONE. fonts loaded: $($pfc.Families.Count)  display family: $($famDisplay.Name)"
