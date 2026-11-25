# Updates RAY Notch on this PC to the latest version from GitHub.
# Keeps settings, to-dos, models and the room link (they live outside the app folder).
# Run in PowerShell:  irm https://raw.githubusercontent.com/revanthshankars-dotcom/ray-agent/main/apps/ray-notch/update.ps1 | iex
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$Notch = Join-Path $env:USERPROFILE '.ray-notch\app'
$Tmp = Join-Path $env:USERPROFILE '.ray-notch\_update'

function Step($msg) { Write-Host "-> $msg" -ForegroundColor Cyan }

try {
  if (-not (Test-Path $Notch)) { throw "RAY Notch isn't installed at $Notch. Install it from RAY first." }

  Step 'Closing RAY Notch'
  Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1

  Step 'Removing folders left by the old updater'
  foreach ($d in 'lib\lib', 'renderer\renderer', 'test\test') {
    $p = Join-Path $Notch $d
    if (Test-Path $p) { Remove-Item -Recurse -Force $p; Write-Host "   removed $d" }
  }

  Step 'Downloading the latest RAY Notch'
  if (Test-Path $Tmp) { Remove-Item -Recurse -Force $Tmp }
  New-Item -ItemType Directory -Force -Path $Tmp | Out-Null
  $zip = Join-Path $Tmp 'ray.zip'
  Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/revanthshankars-dotcom/ray-agent/archive/refs/heads/main.zip' -OutFile $zip
  Write-Host ("   {0:N1} MB" -f ((Get-Item $zip).Length / 1MB))

  Step 'Unpacking'
  Expand-Archive -Force -Path $zip -DestinationPath $Tmp
  $src = Get-ChildItem $Tmp -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'apps\ray-notch\main.js') } | Select-Object -First 1
  if (-not $src) { throw 'The download did not contain apps\ray-notch.' }
  $src = Join-Path $src.FullName 'apps\ray-notch'

  Step 'Copying new files'
  $n = 0
  Get-ChildItem $src -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($src.Length + 1)
    $dest = Join-Path $Notch $rel
    New-Item -ItemType Directory -Force -Path (Split-Path $dest) | Out-Null
    Copy-Item -Force $_.FullName $dest
    $n++
  }
  Write-Host "   $n files updated"

  foreach ($f in 'main.js', 'preload.js', 'lib\files.js', 'lib\system.js', 'renderer\notch.js') {
    if (-not (Test-Path (Join-Path $Notch $f))) { throw "Missing $f after copying." }
  }
  Remove-Item -Recurse -Force $Tmp

  $electron = Join-Path $Notch 'node_modules\.bin\electron.cmd'
  if (-not (Test-Path $electron)) {
    Step 'Installing parts RAY Notch needs (one time)'
    Push-Location $Notch; npm install --omit=dev --no-audit --no-fund; Pop-Location
  }

  Step 'Starting RAY Notch'
  Start-Process -FilePath $electron -ArgumentList '.' -WorkingDirectory $Notch -WindowStyle Hidden
  Write-Host ''
  Write-Host 'RAY Notch is updated and running.' -ForegroundColor Green
} catch {
  Write-Host ''
  Write-Host "Update failed: $($_.Exception.Message)" -ForegroundColor Red
}
