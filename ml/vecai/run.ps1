# RuneType VecAI — train the differentiable vectorizer (refiner) on the font
# corpus, export ONNX, deploy into the plugin. One command; progress goes to a log
# that RuneType_VecAI_Track.bat reads. Edit $FONTS/$STEPS to scale the run.
$ErrorActionPreference = 'Continue'
$env:PYTHONUNBUFFERED = '1'

$py   = 'E:\glyphset\.venv\Scripts\python.exe'
$root = 'C:\Users\okana\fontmaker\ml\vecai'
$log  = Join-Path $root 'vecai_run.log'

# scale of the run (more = better AAA; defaults ≈ 30–60 min on the 3080)
$FONTS = 8000
$STEPS = 25000

# keep the machine awake during the long run
try { Add-Type -Name P -Namespace W -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint e);' -EA SilentlyContinue
      [W.P]::SetThreadExecutionState([uint32]2147483651) | Out-Null } catch {}

"=== VecAI training START $(Get-Date -f 'u')  fonts=$FONTS steps=$STEPS ===" | Out-File $log -Encoding utf8
Write-Host "Training VecAI — fonts=$FONTS steps=$STEPS, two models (jitter + quant).`n"

# train BOTH models with a LIVE progress bar in this same window. Raw step spam and
# harmless per-font warnings go to the log only; the screen shows just the bar.
foreach ($mode in @('jitter', 'quant')) {
  Add-Content $log "--- training MODE=$mode ---"
  Write-Host "`n=== Training '$mode' model ===" -ForegroundColor Cyan
  & $py "$root\train.py" $FONTS $STEPS $mode 2>&1 | ForEach-Object {
    $line = "$_"
    Add-Content -Path $log -Value $line
    if ($line -match 'step\s+(\d+)/(\d+)\s+loss\s+([\d.]+)\s+ema\s+([\d.]+)') {
      $cur = [int]$Matches[1]; $tot = [int]$Matches[2]
      $pct = if ($tot) { [math]::Round(100 * $cur / $tot, 1) } else { 0 }
      $bar = ('#' * [int]($pct / 2)).PadRight(50, '-')
      Write-Host -NoNewline ("`r[{0}] {1,5}%  step {2}/{3}  ema {4}    " -f $bar, $pct, $cur, $tot, $Matches[4])
    } elseif ($line -match 'exported|saved _train_eval') {
      Write-Host ("`n  " + $line) -ForegroundColor DarkGray
    }
  }
  Write-Host ""
  if ($LASTEXITCODE -ne 0) { "TRAIN FAILED ($mode, exit $LASTEXITCODE)" | Tee-Object -FilePath $log -Append; exit 1 }
}

# deploy BOTH exported ONNX models into the plugin (source + installed extension)
$dests = @('C:\Users\okana\fontmaker\cep\js\lib\model',
           (Join-Path $env:APPDATA 'Adobe\CEP\extensions\com.fontmaker.illustrator\js\lib\model'))
foreach ($d in $dests) {
  New-Item -ItemType Directory -Force -Path $d | Out-Null
  foreach ($m in @('jitter', 'quant')) {
    $o = Join-Path $root "ckpt\refiner_$m.onnx"
    if (Test-Path $o) { Copy-Item $o (Join-Path $d "refiner_$m.onnx") -Force; "deployed refiner_$m.onnx -> $d" | Tee-Object -FilePath $log -Append }
    else { "WARNING: refiner_$m.onnx missing" | Tee-Object -FilePath $log -Append }
  }
}

"=== VecAI DONE $(Get-Date -f 'u') ===  preview: $root\_train_eval.png" | Tee-Object -FilePath $log -Append
Write-Host "`nDone. Quality preview: $root\_train_eval.png"
