# RuneType glyph-recognizer — full pipeline (download -> render -> pack -> train).
# One command for the 24h run. Every stage is resumable: re-run after a crash and
# it skips finished work (downloaded fonts, rendered faces, the best checkpoint).
#
#   powershell -ExecutionPolicy Bypass -File C:\Users\okana\fontmaker\ml\run_all.ps1
#
# Tune EPOCHS/BATCH below. Logs stream to E:\glyphset\run.log.

# 'Continue', NOT 'Stop': git/tqdm/joblib write normal progress to stderr, and PS 5.1
# under 'Stop' + 2>&1 turns that into a terminating error. Real failures are caught
# via $LASTEXITCODE in Stage instead.
$ErrorActionPreference = 'Continue'
$PY  = 'E:\glyphset\.venv\Scripts\python.exe'
$ML  = 'C:\Users\okana\fontmaker\ml'
$LOG = 'E:\glyphset\run.log'
$EPOCHS   = 35     # aimed at ~3-5h on the 3080
$BATCH    = 1024   # 3080 12GB has headroom; bigger batch saturates the GPU
$LR       = 0.006  # scaled up for the larger batch
$MAXHOURS = 5      # hard wall-clock cap (stops + exports if exceeded)
$env:UV_CACHE_DIR = 'E:\glyphset\uvcache'
$env:PYTHONUNBUFFERED = '1'   # flush python output immediately so the window never looks "frozen"

# Only one build at a time — if a run is already going (e.g. a double-click while
# one is running), report it and exit instead of racing on the same folders.
$me = $PID
$others = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
  Where-Object { $_.CommandLine -match 'run_all\.ps1' -and $_.ProcessId -ne $me })
if ($others.Count -gt 0) {
  Write-Host "A build is already running (PID $($others[0].ProcessId)). Watch $LOG. Exiting."
  exit 0
}

function Stage([string]$name, [scriptblock]$body) {
  $t = Get-Date
  "==== $name  $($t.ToString('u')) ====" | Tee-Object -FilePath $LOG -Append | Write-Host
  $global:LASTEXITCODE = 0
  & $body 2>&1 | Tee-Object -FilePath $LOG -Append
  if ($LASTEXITCODE -ne 0) {
    "**** $name FAILED (exit $LASTEXITCODE) — stopping ****" | Tee-Object -FilePath $LOG -Append | Write-Host
    throw "$name failed"
  }
  $mins = [math]::Round(((Get-Date) - $t).TotalMinutes, 1)
  "---- $name done in $mins min ----" | Tee-Object -FilePath $LOG -Append | Write-Host
}

# Keep the PC awake for the whole (overnight) run; restored in finally.
# 2147483649 = ES_CONTINUOUS|ES_SYSTEM_REQUIRED ; 2147483648 = ES_CONTINUOUS (allow sleep).
# Best-effort: a keep-awake failure must never abort the pipeline.
try {
  Add-Type -Namespace Win -Name Power -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint e);'
  [Win.Power]::SetThreadExecutionState([uint32]2147483649) | Out-Null
} catch { Write-Host "keep-awake unavailable: $($_.Exception.Message)" }

try {
  Stage 'verify-gpu' { & $PY -c "import torch;print('cuda',torch.cuda.is_available(),torch.cuda.get_device_name(0))" }
  Stage 'download'   { & $PY "$ML\download_fonts.py" --out E:/glyphset/fonts }
  Stage 'render'     { & $PY "$ML\render_dataset.py" --fonts E:/glyphset/fonts --classes E:/glyphset/classes.json --out E:/glyphset/data/renders --jobs 0 }
  Stage 'pack'       { & $PY "$ML\pack_dataset.py" --renders E:/glyphset/data/renders --out E:/glyphset/data/packed --classes E:/glyphset/classes.json }
  Stage 'train'      { & $PY "$ML\train.py" --packed E:/glyphset/data/packed --out E:/glyphset/out --epochs $EPOCHS --batch $BATCH --lr $LR --max-hours $MAXHOURS --fresh }
  Stage 'deploy'     {
    $src = 'E:\glyphset\out'
    $dests = @('C:\Users\okana\fontmaker\cep\js\lib\model',
               "$env:APPDATA\Adobe\CEP\extensions\com.fontmaker.illustrator\js\lib\model")
    if (Test-Path "$src\glyph_int8.onnx") {
      foreach ($d in $dests) {
        New-Item -ItemType Directory -Force -Path $d | Out-Null
        Copy-Item "$src\glyph_int8.onnx" $d -Force
        if (Test-Path "$src\labels.json")  { Copy-Item "$src\labels.json"  $d -Force }
        if (Test-Path "$src\metrics.json") { Copy-Item "$src\metrics.json" $d -Force }
        Write-Host "model + labels -> $d"
      }
    } else { Write-Host "no model yet (training did not finish); re-run to resume" }
  }
  "ALL DONE. Model in E:\glyphset\out and copied into the plugin (cep\js\lib\model)." | Tee-Object -FilePath $LOG -Append | Write-Host
} finally {
  try { [Win.Power]::SetThreadExecutionState([uint32]2147483648) | Out-Null } catch {}
}
