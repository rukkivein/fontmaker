# RuneType VecAI — live training progress (reads vecai_run.log written by run.ps1)
$root = 'C:\Users\okana\fontmaker\ml\vecai'
$log  = Join-Path $root 'vecai_run.log'

function ReadLog($p) {
  for ($i = 0; $i -lt 6; $i++) {
    try { $fs = [System.IO.File]::Open($p, 'Open', 'Read', 'ReadWrite')
          $sr = New-Object IO.StreamReader($fs); $t = $sr.ReadToEnd(); $sr.Close(); $fs.Close(); return $t }
    catch { Start-Sleep -Milliseconds 150 } }
  return $null
}

$last = $null
while ($true) {
  Clear-Host
  Write-Host "RuneType VecAI — vectorizer training`n" -ForegroundColor Cyan
  if (-not (Test-Path $log)) { Write-Host 'waiting for training to start…'; Start-Sleep 2; continue }
  $t = ReadLog $log; if ($t) { $last = $t } elseif ($last) { $t = $last }
  $steps = ($t -split "`n") | Where-Object { $_ -match 'step\s+(\d+)/(\d+)\s+loss\s+([\d.]+)\s+ema\s+([\d.]+)' }
  if ($steps) {
    $m = [regex]::Match($steps[-1], 'step\s+(\d+)/(\d+)\s+loss\s+([\d.]+)\s+ema\s+([\d.]+)')
    $cur = [int]$m.Groups[1].Value; $tot = [int]$m.Groups[2].Value
    $pct = if ($tot) { [math]::Round(100 * $cur / $tot, 1) } else { 0 }
    $bar = ('#' * [int]($pct / 2)).PadRight(50, '-')
    Write-Host ("[{0}] {1}%" -f $bar, $pct)
    Write-Host ("step {0}/{1}   loss {2}   ema {3}" -f $cur, $tot, $m.Groups[3].Value, $m.Groups[4].Value)
  } else { Write-Host 'starting (loading fonts / first steps)…' }
  if ($t -match 'VecAI DONE') { Write-Host "`nDONE — refiner.onnx deployed. Preview: $root\_train_eval.png" -ForegroundColor Green; break }
  if ($t -match 'TRAIN FAILED') { Write-Host "`nFAILED — see $log" -ForegroundColor Red; break }
  Start-Sleep 3
}
Write-Host "`n(press a key to close)"; $null = $Host.UI.RawUI.ReadKey('NoEcho,IncludeKeyDown')
