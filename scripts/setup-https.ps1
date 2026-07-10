param(
  [Parameter(Mandatory = $true)]
  [string]$LanHost,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$opensslCommand = Get-Command openssl.exe -ErrorAction SilentlyContinue
if (-not $opensslCommand) { $opensslCommand = Get-Command openssl -ErrorAction SilentlyContinue }
$openssl = if ($opensslCommand) { $opensslCommand.Source } else { $null }
if (-not $openssl) {
  $gitOpenSsl = 'C:\Program Files\Git\usr\bin\openssl.exe'
  if (Test-Path -LiteralPath $gitOpenSsl) { $openssl = $gitOpenSsl }
}
if (-not $openssl) {
  throw 'OpenSSL was not found. Install Git for Windows or OpenSSL, then run again.'
}

# Some Windows software leaves OPENSSL_CONF pointing at an uninstalled copy
# of OpenSSL. Keep the process-local value isolated from that global setting.
$gitOpenSslConfig = 'C:\Program Files\Git\mingw64\ssl\openssl.cnf'
if (Test-Path -LiteralPath $gitOpenSslConfig) {
  $env:OPENSSL_CONF = $gitOpenSslConfig
} elseif (Test-Path Env:OPENSSL_CONF) {
  Remove-Item Env:OPENSSL_CONF
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$certDir = Join-Path $repoRoot 'certs'
New-Item -ItemType Directory -Force -Path $certDir | Out-Null

$caKey = Join-Path $certDir 'ca-key.pem'
$caCert = Join-Path $certDir 'ca.crt'
$serverKey = Join-Path $certDir 'key.pem'
$serverCert = Join-Path $certDir 'cert.pem'
$serverCsr = Join-Path $certDir 'server.csr'
$configFile = Join-Path $certDir 'server-openssl.cnf'
$hostMarker = Join-Path $certDir 'lan-host.txt'

if ($Force) {
  foreach ($path in @($caKey, $caCert, $serverKey, $serverCert, $serverCsr, $hostMarker)) {
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
  }
}

if (-not (Test-Path -LiteralPath $caKey) -or -not (Test-Path -LiteralPath $caCert)) {
  & $openssl genrsa -out $caKey 3072
  if ($LASTEXITCODE -ne 0) { throw 'Failed to generate the CrossSync CA key.' }
  & $openssl req -x509 -new -sha256 -key $caKey -out $caCert -days 3650 -subj '/CN=CrossSync Local CA' -addext 'basicConstraints=critical,CA:TRUE' -addext 'keyUsage=critical,keyCertSign,cRLSign' -addext 'subjectKeyIdentifier=hash'
  if ($LASTEXITCODE -ne 0) { throw 'Failed to generate the CrossSync CA certificate.' }
}

$currentHost = if (Test-Path -LiteralPath $hostMarker) { (Get-Content -Raw -LiteralPath $hostMarker).Trim() } else { '' }
$needsServerCertificate = $currentHost -ne $LanHost -or -not (Test-Path -LiteralPath $serverKey) -or -not (Test-Path -LiteralPath $serverCert)

if ($needsServerCertificate) {
  $address = $null
  $isIp = [System.Net.IPAddress]::TryParse($LanHost, [ref]$address)
  $hostSan = if ($isIp) { "IP.2 = $LanHost" } else { "DNS.2 = $LanHost" }
  $config = @"
[req]
default_bits = 2048
prompt = no
default_md = sha256
distinguished_name = dn
req_extensions = v3_req

[dn]
CN = $LanHost

[v3_req]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
$hostSan
"@
  Set-Content -LiteralPath $configFile -Value $config -Encoding ASCII

  & $openssl genrsa -out $serverKey 2048
  if ($LASTEXITCODE -ne 0) { throw 'Failed to generate the HTTPS server key.' }
  & $openssl req -new -key $serverKey -out $serverCsr -config $configFile
  if ($LASTEXITCODE -ne 0) { throw 'Failed to generate the HTTPS certificate request.' }
  & $openssl x509 -req -in $serverCsr -CA $caCert -CAkey $caKey -CAcreateserial -out $serverCert -days 825 -sha256 -extfile $configFile -extensions v3_req
  if ($LASTEXITCODE -ne 0) { throw 'Failed to sign the HTTPS server certificate.' }
  Set-Content -LiteralPath $hostMarker -Value $LanHost -Encoding ASCII
}

foreach ($path in @($serverCsr, $configFile)) {
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
}

Write-Host "CrossSync HTTPS certificates are ready in $certDir"
Write-Host "iPhone CA download: https://${LanHost}:8008/ca.crt"
