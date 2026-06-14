# Builds BOTH installers (Alpha = limited, Full = pro) into one folder.
# Each stages a patched copy of cep/ with the right features.js EDITION, then
# reuses build-installer.ps1 to package it.
param(
  [string]$OutDir = "C:\Users\okana\Desktop\RuneType Installers"
)
$ErrorActionPreference = "Stop"
$cep   = "C:\Users\okana\fontmaker\cep"
$build = "C:\Users\okana\fontmaker\installer\build"
$dist  = "C:\Users\okana\fontmaker\installer\dist"
$here  = "C:\Users\okana\fontmaker\installer"
New-Item -ItemType Directory -Force $OutDir, $build | Out-Null

function Stage([string]$edition) {
  $dst = "$build\payload-$edition"
  if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
  Copy-Item $cep $dst -Recurse
  $f = "$dst\js\features.js"
  $c = Get-Content $f -Raw
  $c = $c -replace "var EDITION = '[^']*';", "var EDITION = '$edition';"
  [System.IO.File]::WriteAllText($f, $c, (New-Object System.Text.UTF8Encoding($false)))  # no BOM
  $line = (Get-Content $f | Where-Object { $_ -match "^var EDITION" })
  Write-Host "  staged $edition -> $line"
  return $dst
}

$jobs = @(
  @{ edition = 'alpha'; name = 'RuneType_Glyphmaker_Alpha_Setup' },
  @{ edition = 'pro';   name = 'RuneType_Glyphmaker_Full_Setup'  }
)
foreach ($j in $jobs) {
  "=== building $($j.name) ($($j.edition)) ==="
  $payload = Stage $j.edition
  & "$here\build-installer.ps1" -PayloadDir $payload -OutName $j.name -Edition $j.edition |
    Select-String -Pattern "payload.zip|EXIT|EXE|MISSING|error CS"
  Copy-Item "$dist\$($j.name).exe" $OutDir -Force
}
"=== OUTPUT FOLDER: $OutDir ==="
Get-ChildItem $OutDir -Filter *.exe | Select-Object Name, @{n='MB';e={[math]::Round($_.Length/1MB,2)}}, LastWriteTime | Format-Table -Auto
