#!/usr/bin/env bash
set -euo pipefail

LAN_HOST=""
PORT=8008
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --lan-host)
      LAN_HOST="${2:?missing LAN host or IP}"
      shift 2
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --port)
      PORT="${2:?missing port}"
      shift 2
      ;;
    -h|--help)
      echo "Usage: bash scripts/setup-https.sh --lan-host 192.168.1.20 [--port 8008] [--force]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$LAN_HOST" ]]; then
  echo "--lan-host is required" >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "OpenSSL was not found. Install OpenSSL, then run again." >&2
  exit 1
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CERT_DIR="${CROSSSYNC_CERT_DIR:-$REPO_ROOT/certs}"
CA_KEY="$CERT_DIR/ca-key.pem"
CA_CERT="$CERT_DIR/ca.crt"
CA_SERIAL="$CERT_DIR/ca.srl"
SERVER_KEY="$CERT_DIR/key.pem"
SERVER_CERT="$CERT_DIR/cert.pem"
SERVER_CSR="$CERT_DIR/server.csr"
HOST_MARKER="$CERT_DIR/lan-host.txt"
CA_CONFIG="$CERT_DIR/ca-openssl.cnf"
SERVER_CONFIG="$CERT_DIR/server-openssl.cnf"

mkdir -p "$CERT_DIR"
cleanup() {
  rm -f "$SERVER_CSR" "$CA_CONFIG" "$SERVER_CONFIG"
}
trap cleanup EXIT

if [[ "$FORCE" == "1" ]]; then
  rm -f "$CA_KEY" "$CA_CERT" "$CA_SERIAL" "$SERVER_KEY" "$SERVER_CERT" "$HOST_MARKER"
fi

if [[ ! -f "$CA_KEY" || ! -f "$CA_CERT" ]]; then
  cat > "$CA_CONFIG" <<'EOF'
[req]
prompt = no
distinguished_name = dn
x509_extensions = v3_ca

[dn]
CN = CrossSync Local CA

[v3_ca]
basicConstraints = critical,CA:TRUE
keyUsage = critical,keyCertSign,cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
EOF
  openssl genrsa -out "$CA_KEY" 3072
  openssl req -x509 -new -sha256 -key "$CA_KEY" -out "$CA_CERT" -days 3650 -config "$CA_CONFIG" -extensions v3_ca
fi

CURRENT_HOST=""
if [[ -f "$HOST_MARKER" ]]; then
  CURRENT_HOST="$(tr -d '\r\n' < "$HOST_MARKER")"
fi

if [[ "$CURRENT_HOST" != "$LAN_HOST" || ! -f "$SERVER_KEY" || ! -f "$SERVER_CERT" ]]; then
  if [[ "$LAN_HOST" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ || "$LAN_HOST" == *:* ]]; then
    HOST_SAN="IP.2 = $LAN_HOST"
  else
    HOST_SAN="DNS.2 = $LAN_HOST"
  fi

  cat > "$SERVER_CONFIG" <<EOF
[req]
prompt = no
default_md = sha256
distinguished_name = dn
req_extensions = v3_req

[dn]
CN = $LAN_HOST

[v3_req]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = @alt_names

[alt_names]
DNS.1 = localhost
IP.1 = 127.0.0.1
$HOST_SAN
EOF
  openssl genrsa -out "$SERVER_KEY" 2048
  openssl req -new -key "$SERVER_KEY" -out "$SERVER_CSR" -config "$SERVER_CONFIG"
  openssl x509 -req -in "$SERVER_CSR" -CA "$CA_CERT" -CAkey "$CA_KEY" -CAcreateserial -out "$SERVER_CERT" -days 825 -sha256 -extfile "$SERVER_CONFIG" -extensions v3_req
  printf '%s\n' "$LAN_HOST" > "$HOST_MARKER"
fi

chmod 600 "$CA_KEY" "$SERVER_KEY" 2>/dev/null || true
echo "CrossSync HTTPS certificates are ready in $CERT_DIR"
echo "iPhone CA download: https://$LAN_HOST:$PORT/ca.crt"
