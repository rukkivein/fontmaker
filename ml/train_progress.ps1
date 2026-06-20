# Focused TRAINING progress: overall %, epoch, batch, accuracy, elapsed + ETA.
$ErrorActionPreference = 'SilentlyContinue'
$EPOCHS = 40
$LOG = 'E:\glyphset\run.log'

function BigBar([double]$pct) {
  if ($pct -lt 0) { $pct = 0 }; if ($pct -gt 100) { $pct = 100 }
  $w = 44; $f = [int][math]::Round($pct / 100 * $w)
  return ("   [" + ("#" * $f) + ("." * ($w - $f)) + "]")
}
function HM([double]$sec) {
  if ($sec -lt 0 -or [double]::IsNaN($sec) -or [double]::IsInfinity($sec)) { return "?" }
  return ("{0}h {1:00}m" -f [int]($sec / 3600), [int](($sec % 3600) / 60))
}
function Last($log, $re) { $m = $log | Where-Object { $_ -match $re } | Select-Object -Last 1; if ($m -and $m -match $re) { $matches } else { $null } }
function ReadLog($path) {
  # shared read (won't collide with the writer); retry a few times on a transient lock
  for ($t = 0; $t -lt 6; $t++) {
    try {
      $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
      $sr = New-Object System.IO.StreamReader($fs)
      $txt = $sr.ReadToEnd(); $sr.Dispose(); $fs.Dispose()
      return ($txt -replace "`0", "") -split "`r?`n"
    } catch { Start-Sleep -Milliseconds 150 }
  }
  return @()
}

$lastlog = @()
while ($true) {
  $r = ReadLog $LOG
  if ($r -and $r.Count -ge 2) { $lastlog = $r }   # keep last good read; never blank out
  $log = $lastlog
  Clear-Host
  $model = Test-Path E:\glyphset\out\glyph_int8.onnx
  $sn = (Last $log '^==== (\S+)')
  $stage = if ($sn) { $sn[1] } else { 'starting' }

  Write-Host ""
  Write-Host "==================================================================" -ForegroundColor Cyan
  Write-Host "     RuneType  -  TRAINING PROGRESS         $(Get-Date -Format 'HH:mm:ss')" -ForegroundColor Cyan
  Write-Host "==================================================================" -ForegroundColor Cyan
  Write-Host ""

  if ($model) {
    Write-Host "        EGITIM TAMAMLANDI" -ForegroundColor Green
    Write-Host (BigBar 100) -ForegroundColor Green
    Write-Host "        100 %" -ForegroundColor Green
    $f = Last $log 'FINAL: top1 ([\d.]+).*ECE=([\d.]+)'
    if ($f) { Write-Host "`n        Final dogruluk (top1): $([math]::Round([double]$f[1]*100,1)) %" -ForegroundColor Green }
    Write-Host "`n        Model hazir: E:\glyphset\out\glyph_int8.onnx (+ plugin'e kopyalandi)" -ForegroundColor Green
    Write-Host "        Claude'a 'model hazir' de." -ForegroundColor Green
    break
  }

  if ($stage -ne 'train') {
    $pre = switch ($stage) { 'render' { 'render (fontlar isleniyor)' } 'pack' { 'pack (veri paketleniyor)' } 'download' { 'indirme' } default { $stage } }
    Write-Host "        Egitim henuz baslamadi." -ForegroundColor Yellow
    Write-Host "        Su anki asama: $pre" -ForegroundColor Yellow
    Write-Host "        (egitim, paketleme bitince otomatik baslar)" -ForegroundColor DarkGray
  }
  else {
    # read the trainer's own authoritative progress line:
    #   [ep 3/35  37%] 1640/4460 | loss 2.13 | 3200 img/s | overall 9.1% | ETA 3h42m
    $ov = Last $log 'overall ([\d.]+)%'
    $et = Last $log 'ETA (\S+)'
    $epm = Last $log '\[ep (\d+)/(\d+)'
    $bm = Last $log '%\] (\d+)/(\d+) \|'
    $tacc = Last $log 'epoch \d+: top1 ([\d.]+)'
    if (-not $ov) {
      Write-Host "        Egitim basliyor... (ilk batch'ler isleniyor, ~1 dk)" -ForegroundColor Yellow
      Write-Host (BigBar 0) -ForegroundColor Green
    }
    else {
      $pct = [double]$ov[1]
      Write-Host ("        Overall:   {0} %" -f [int]$pct) -ForegroundColor White
      Write-Host (BigBar $pct) -ForegroundColor Green
      Write-Host ""
      if ($epm) { Write-Host ("        Epoch:     {0} / {1}" -f $epm[1], $epm[2]) -ForegroundColor White }
      if ($bm) { Write-Host ("        Batch:     {0} / {1}   (bu epoch)" -f $bm[1], $bm[2]) -ForegroundColor White }
      if ($tacc) { Write-Host ("        Dogruluk:  {0} %   (son tamamlanan epoch)" -f [math]::Round([double]$tacc[1] * 100, 1)) -ForegroundColor White }
      Write-Host ""
      if ($et) { Write-Host ("        Kalan (tahmini): ~{0}" -f $et[1]) -ForegroundColor Gray }
    }
  }

  Write-Host ""
  Write-Host "------------------------------------------------------------------" -ForegroundColor DarkGray
  Write-Host "   (5sn'de bir yenilenir - kapatsan da egitim devam eder)" -ForegroundColor DarkGray
  Start-Sleep -Seconds 5
}
Read-Host "`n   Kapatmak icin Enter"
