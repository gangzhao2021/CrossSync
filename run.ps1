param(
  [int]$Port = 8008,
  [switch]$Https,
  [switch]$EnableOtp,
  [string]$OtpCode
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
$venvPip = Join-Path .venv 'Scripts/pip.exe'

if (!(Test-Path $venvPython)) { Write-Error 'Virtual env python not found. Venv creation may have failed.'; exit 1 }

& $venvPip install -r requirements.txt

# Prepare environment for OTP
if ($EnableOtp) { $env:CROSSSYNC_ENABLE_OTP = '1' }
if ($OtpCode) { $env:CROSSSYNC_OTP_CODE = $OtpCode }

# Determine protocol and launch
$proto = 'http'
$uvicornArgs = @('app.main:app', '--host', '0.0.0.0', '--port', "$Port")
if ($Https) {
  $certDir = Join-Path $PSScriptRoot 'certs'
  $certFile = Join-Path $certDir 'cert.pem'
  $keyFile = Join-Path $certDir 'key.pem'
  if ((Test-Path $certFile) -and (Test-Path $keyFile)) {
    $proto = 'https'
    $uvicornArgs = @('app.main:app', '--host', '0.0.0.0', '--port', "$Port", '--ssl-certfile', $certFile, '--ssl-keyfile', $keyFile)
  } else {
    Write-Warning "Https requested but certs not found in $certDir. Falling back to http."
  }
}

# Open browser
Start-Process "${proto}://localhost:$Port/" | Out-Null

# Start server
& $venvPython -m uvicorn @uvicornArgs
