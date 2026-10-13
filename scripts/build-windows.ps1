# Build dist\CrossSync\CrossSync.exe (no Python needed on the target PC) and dist\CrossSync-windows.zip.
param(
  [string]$Python = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
Set-Location -Path $repo

if (-not $Python) {
  $Python = Join-Path $repo '.venv\Scripts\python.exe'
  if (-not (Test-Path -LiteralPath $Python)) { $Python = 'python' }
}

# pip and PyInstaller report progress on stderr. Windows PowerShell 5.1 turns that
# into errors when output is redirected, so judge native commands by exit code only.
function Invoke-Native([string]$Failure, [scriptblock]$Command) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $Command } finally { $ErrorActionPreference = $previous }
  if ($LASTEXITCODE -ne 0) { throw $Failure }
}

Invoke-Native 'Installing build requirements failed.' {
  & $Python -m pip install --disable-pip-version-check -q -r requirements-build.txt
}

# Windows wants a multi-size .ico for the program and tray icons.
Invoke-Native 'Creating the icon failed.' {
  & $Python -c "from PIL import Image; Image.open('app/static/app-icon-512.png').save('packaging/crosssync.ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])"
}

Invoke-Native 'PyInstaller failed.' {
  & $Python -m PyInstaller --noconfirm --clean --log-level WARN --distpath dist --workpath build packaging\crosssync.spec
}

$zip = Join-Path $repo 'dist\CrossSync-windows.zip'
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
# Antivirus scanners often hold the new files briefly; retry instead of failing.
for ($attempt = 1; $attempt -le 5 -and -not (Test-Path -LiteralPath $zip); $attempt++) {
  try {
    Compress-Archive -Path (Join-Path $repo 'dist\CrossSync') -DestinationPath $zip -ErrorAction Stop
  } catch {
    if ($attempt -eq 5) { throw }
    Start-Sleep -Seconds 3
  }
}
if (-not (Test-Path -LiteralPath $zip)) { throw "The zip was not created: $zip" }
Write-Host "Built $repo\dist\CrossSync\CrossSync.exe and $zip" -ForegroundColor Green
