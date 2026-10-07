param(
  [int]$Port = 8008,
  [switch]$Https,
  [switch]$Http,
  [switch]$RegenerateCertificate,
  [string]$AccessToken,
  [string]$LanHost
)

$ErrorActionPreference = 'Stop'
Set-Location -Path "$PSScriptRoot"

# Choose Python launcher (supports both `py -3` and `python`)
$pythonExe = $null
$pythonArgs = @()
if (Get-Command py -ErrorAction SilentlyContinue) { $pythonExe = 'py'; $pythonArgs = @('-3') }
elseif (Get-Command python -ErrorAction SilentlyContinue) { $pythonExe = 'python'; $pythonArgs = @() }
else { Write-Error 'Python 3 is not installed or not on PATH. Install from https://www.python.org/downloads/windows/'; exit 1 }

if (!(Test-Path .venv)) {
  Write-Host 'Creating venv...'
  & $pythonExe @pythonArgs -m venv .venv
}

$venvPython = Join-Path .venv 'Scripts/python.exe'

if (!(Test-Path $venvPython)) { Write-Error 'Virtual env python not found. Venv creation may have failed.'; exit 1 }

# Reinstall dependencies only when requirements.txt changed since the last install.
$requirementsHash = (Get-FileHash -Algorithm SHA256 -LiteralPath 'requirements.txt').Hash
$requirementsStamp = Join-Path .venv '.requirements.sha256'
$installedHash = if (Test-Path -LiteralPath $requirementsStamp) { (Get-Content -LiteralPath $requirementsStamp -Raw).Trim() } else { '' }
if ($installedHash -ne $requirementsHash) {
  Write-Host 'Installing dependencies...'
  & $venvPython -m pip install -r requirements.txt
  if ($LASTEXITCODE -ne 0) { Write-Error 'Dependency installation failed.'; exit 1 }
  Set-Content -LiteralPath $requirementsStamp -Value $requirementsHash -Encoding ascii
} else {
  Write-Host 'Dependencies are up to date.'
}

# Access token and LAN host overrides
if ($AccessToken) { $env:CROSSSYNC_ACCESS_TOKEN = $AccessToken }
if ($LanHost) { $env:CROSSSYNC_LAN_HOST = $LanHost }

$crossSyncToken = (& $venvPython -c "from app.config import settings, load_env_overrides; load_env_overrides(); print(settings.access_token)").Trim()
Write-Host "CrossSync native app access token: $crossSyncToken" -ForegroundColor Cyan

# HTTPS is the default because iPhone Screen Wake Lock and PWA installation
# require a secure context. Use -Http only as an explicit compatibility mode.
if ($Https -and $Http) { Write-Error 'Use either -Https or -Http, not both.'; exit 1 }
$useHttps = -not $Http
if ($Https) { $useHttps = $true }

$proto = 'http'
$uvicornArgs = @('app.main:app', '--host', '0.0.0.0', '--port', "$Port")
if ($useHttps) {
  $certDir = Join-Path $PSScriptRoot 'certs'
  $certFile = Join-Path $certDir 'cert.pem'
  $keyFile = Join-Path $certDir 'key.pem'
  $certHost = $LanHost
  if (-not $certHost) {
    $certHost = (& $venvPython -c "from app.utils import get_lan_ip; print(get_lan_ip())").Trim()
  }
  $setupHttps = Join-Path $PSScriptRoot 'scripts/setup-https.ps1'
  if (Test-Path -LiteralPath $setupHttps) {
    & $setupHttps -LanHost $certHost -Force:$RegenerateCertificate
  }
  if ((Test-Path $certFile) -and (Test-Path $keyFile)) {
    $proto = 'https'
    $uvicornArgs = @('app.main:app', '--host', '0.0.0.0', '--port', "$Port", '--ssl-certfile', $certFile, '--ssl-keyfile', $keyFile)
    Write-Host "HTTPS enabled for $certHost."
    Write-Host "First iPhone setup: open the QR link, install /ca.crt, then enable full trust for 'CrossSync Local CA'."
  } else {
    Write-Warning "HTTPS certificate setup failed. Falling back to HTTP; iPhone native wake lock may be unavailable."
  }
}

# Open browser
Start-Process "${proto}://localhost:$Port/" | Out-Null

# Start server
& $venvPython -m uvicorn @uvicornArgs
