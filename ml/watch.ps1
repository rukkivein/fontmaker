# Live status monitor with per-stage progress bars. Refreshes every 5s.
$ErrorActionPreference = 'SilentlyContinue'
$EPOCHS = 40

function Bar([double]$pct) {
  if ($pct -lt 0) { $pct = 0 }; if ($pct -gt 100) { $pct = 100 }
  $w = 30; $f = [int][math]::Round($pct / 100 * $w)
  return ("  [" + ("#" * $f) + ("." * ($w - $f)) + ("] {0,3}%" -f [int]$pct))
}
function LastMatch($log, $re) {
  $m = $log | Where-Object { $_ -match $re } | Select-Object -Last 1
  if ($m -and $m -match $re) { return $matches } else { return $null }
}
function ReadLog($path) {
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
  $r = ReadLog 'E:\glyphset\run.log'
  if ($r -and $r.Count -ge 2) { $lastlog = $r }
  $log = $lastlog
  Clear-Host
  $rp = Get-Content E:\glyphset\run_all.pid
  $alive = @(Get-Process -Id $rp).Count -gt 0
  $pyn = @(Get-Process python).Count
  $nz = @(Get-ChildItem E:\glyphset\data\renders\*.npz).Count
  $model = Test-Path E:\glyphset\out\glyph_int8.onnx
  $xexists = Test-Path E:\glyphset\data\packed\X.u8

  $lastStage = LastMatch $log '^==== (\S+)'
  $sn = if ($lastStage) { $lastStage[1] } else { 'starting' }

  Write-Host "==================================================================" -ForegroundColor Cyan
  Write-Host "  RuneType Glyph Recognizer  -  LIVE   $(Get-Date -Format 'HH:mm:ss')" -ForegroundColor Cyan
  Write-Host "==================================================================" -ForegroundColor Cyan
  if ($alive) { Write-Host "  Build: RUNNING   (PID $rp, $pyn python)" -ForegroundColor Green }
  else { Write-Host "  Build: NOT RUNNING - if not DONE, re-run RuneType_Build.bat" -ForegroundColor Yellow }

  $stage = $sn; $pct = -1; $detail = ""
  switch ($sn) {
    'verify-gpu' { $stage = "Starting up" }
    'download'   { $stage = "Downloading fonts" }
    'render' {
      $stage = "RENDERING fonts (incl. local)"
      $m = LastMatch $log 'Done\s+(\d+)\s+out of\s+(\d+)'
      $s = LastMatch $log 'scanning fonts (\d+)/(\d+)'
      if ($m) { $pct = 100 * [double]$m[1] / [double]$m[2]; $detail = "rendering $($m[1]) / $($m[2])" }
      elseif (LastMatch $log 'Done\s+(\d+)\s+tasks') { $d = LastMatch $log 'Done\s+(\d+)\s+tasks'; $detail = "$($d[1]) fonts done" }
      elseif ($s) { $pct = 100 * [double]$s[1] / [double]$s[2]; $detail = "checking fonts $($s[1])/$($s[2]) (a few min, normal)" }
      else { $detail = "re-checking ~16k fonts (silent for ~2-3 min, normal)" }
    }
    'pack' {
      $stage = "PACKING dataset"
      $w = LastMatch $log 'written\s+(\d+)/(\d+)'
      $sel = LastMatch $log 'selected ([\d,]+) of'
      $sc = LastMatch $log 'scanned\s+(\d+)/(\d+)'
      if ($w) { $pct = 50 + 50 * [double]$w[1] / [double]$w[2]; $detail = "writing $($w[1])/$($w[2])" }
      elseif ($sel) { $pct = 50; $detail = "building array…" }
      elseif ($sc) { $pct = 45 * [double]$sc[1] / [double]$sc[2]; $detail = "scanning $($sc[1])/$($sc[2])" }
      else { $detail = "counting samples (a few min, normal)" }
      if ($xexists) { $detail += "   X.u8 = $('{0:N1} GB' -f ((Get-Item E:\glyphset\data\packed\X.u8).Length / 1GB))" }
    }
    'train' {
      $stage = "TRAINING on GPU"
      $ov = LastMatch $log 'overall ([\d.]+)%'
      $epm = LastMatch $log '\[ep (\d+)/(\d+)'
      $bm = LastMatch $log '%\] (\d+)/(\d+) \|'
      $et = LastMatch $log 'ETA (\S+)'
      $pct = if ($ov) { [double]$ov[1] } else { 0 }
      if ($epm -and $bm) { $detail = "epoch $($epm[1])/$($epm[2])   batch $($bm[1])/$($bm[2])" } else { $detail = "starting…" }
      if ($et) { $detail += "   ETA ~$($et[1])" }
      $t = LastMatch $log 'epoch \d+: top1'
      if ($t) { $detail += "`n  " + ($t[0]).Trim() }
    }
    'deploy' { $stage = "Copying model to plugin"; $pct = 95 }
    default  { $stage = $sn }
  }
  if ($model) { $stage = "DONE"; $pct = 100 }

  Write-Host "  Stage: $stage" -ForegroundColor White
  if ($pct -ge 0) { Write-Host (Bar $pct) -ForegroundColor Green }
  if ($detail) { Write-Host "  $detail" -ForegroundColor White }
  Write-Host "  rendered=$nz   packed=$xexists   model=$model" -ForegroundColor DarkGray
  Write-Host ""
  Write-Host "  ---- recent log ----" -ForegroundColor DarkGray
  $log | Select-Object -Last 7 | ForEach-Object { $_.TrimEnd() } | Where-Object { $_ -ne "" } | ForEach-Object { Write-Host "  $_" }

  if ($model) {
    Write-Host ""
    Write-Host "  *** DONE! Model ready: E:\glyphset\out\glyph_int8.onnx (+ copied to plugin) ***" -ForegroundColor Green
    Write-Host "  Tell Claude 'model hazir' to wire it into the panel." -ForegroundColor Green
    break
  }
  Write-Host ""
  Write-Host "  (auto-refresh 5s - close anytime, the build keeps running)" -ForegroundColor DarkGray
  Start-Sleep -Seconds 5
}
Read-Host "`nPress Enter to close"
