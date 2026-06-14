# Builds the custom shaped RuneType installer exe (csc + embedded assets + payload).
# Full build:  .\build-installer.ps1
# Alpha later: .\build-installer.ps1 -PayloadDir <alpha-cep-folder> -OutName RuneType_Glyphmaker_Alpha_Setup
param(
  [string]$PayloadDir = "C:\Users\okana\fontmaker\cep",
  [string]$OutName    = "RuneType_Glyphmaker_Setup",
  [string]$Edition    = "full"
)
$inst  = "C:\Users\okana\fontmaker\installer"
$cep   = $PayloadDir
$assets= "$inst\psd-assets"
$build = "$inst\build"
$out   = "$inst\dist\$OutName.exe"
$csc   = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
$font  = "C:\Users\okana\AppData\Local\Microsoft\Windows\Fonts\Delight-ExtraBold.otf"
"edition=$Edition  payload=$cep  out=$OutName"
New-Item -ItemType Directory -Force $build,"$inst\dist" | Out-Null

# 1) zip the panel payload (entries relative to cep root)
$zip = "$build\payload.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($cep, $zip, [System.IO.Compression.CompressionLevel]::Optimal, $false)
"payload.zip: {0:N0} bytes" -f (Get-Item $zip).Length

# 2) gather embedded resources
$names = "mainbg install-bg layelogor_1 brst_logo bar folder x exit done loading install_black install_red activate shop_dim about uninstall uninstall_red".Split(" ")
$res = @()
foreach ($n in $names) {
  $p = "$assets\$n.png"
  if (-not (Test-Path $p)) { "MISSING asset: $p" }
  $res += "/resource:$p,$n.png"
}
$res += "/resource:$zip,payload.zip"
$res += "/resource:$inst\assets\setup.ico,setup.ico"
$res += "/resource:$font,delight.otf"

# 3) compile (free any locking installer first)
Get-Process | Where-Object { $_.Name -like 'RuneType_Glyphmaker_Setup*' } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 400
$cscArgs = @("/nologo","/target:winexe","/out:$out","/win32icon:$inst\assets\setup.ico",
  "/r:System.dll","/r:System.Drawing.dll","/r:System.Windows.Forms.dll","/r:System.IO.Compression.dll") +
  $res + @("$inst\RuneTypeInstaller.cs")
$log = & $csc $cscArgs 2>&1 | Out-String
$log
"EXIT: $LASTEXITCODE"
if (Test-Path $out) { "EXE: {0:N2} MB @ {1}" -f ((Get-Item $out).Length/1MB), (Get-Item $out).LastWriteTime }
