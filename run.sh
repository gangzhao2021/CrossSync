#!/usr/bin/env bash
set -euo pipefail

PORT=8008
HTTPS=0
REGENERATE_CERTIFICATE=0
ACCESS_TOKEN=""
LAN_HOST=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --port)
      PORT="${2:?missing port}"
      shift 2
      ;;
    --https)
      HTTPS=1
      shift
      ;;
    --regenerate-certificate)
      HTTPS=1
      REGENERATE_CERTIFICATE=1
      shift
      ;;
    --access-token)
      ACCESS_TOKEN="${2:?missing access token}"
      shift 2
      ;;
    --lan-host)
      LAN_HOST="${2:?missing LAN host or IP}"
      shift 2
      ;;
    -h|--help)
      echo "Usage: ./run.sh [--port 8008] [--https] [--regenerate-certificate] [--access-token 123456789012] [--lan-host 192.168.1.20]"
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

cd "$(dirname "$0")"

if [[ ! -d .venv ]]; then
  python3 -m venv .venv
fi

. .venv/bin/activate
# Reinstall dependencies only when requirements.txt changed since the last install.
REQUIREMENTS_HASH="$(python -c 'import hashlib; print(hashlib.sha256(open("requirements.txt", "rb").read()).hexdigest())')"
REQUIREMENTS_STAMP=.venv/.requirements.sha256
if [[ "$(cat "$REQUIREMENTS_STAMP" 2>/dev/null)" != "$REQUIREMENTS_HASH" ]]; then
  echo "Installing dependencies..."
  python -m pip install -r requirements.txt
  echo "$REQUIREMENTS_HASH" > "$REQUIREMENTS_STAMP"
else
  echo "Dependencies are up to date."
fi

if [[ -n "$ACCESS_TOKEN" ]]; then
  export CROSSSYNC_ACCESS_TOKEN="$ACCESS_TOKEN"
fi
if [[ -n "$LAN_HOST" ]]; then
  export CROSSSYNC_LAN_HOST="$LAN_HOST"
fi

CROSSSYNC_TOKEN="$(python -c 'from app.config import settings, load_env_overrides; load_env_overrides(); print(settings.access_token)')"
echo "CrossSync native app access token: $CROSSSYNC_TOKEN"

PROTO=http
ARGS=(app.main:app --host 0.0.0.0 --port "$PORT")
if [[ "$HTTPS" == "1" ]]; then
  CERT_HOST="$LAN_HOST"
  if [[ -z "$CERT_HOST" ]]; then
    CERT_HOST="$(python -c 'from app.utils import get_lan_ip; print(get_lan_ip())')"
    export CROSSSYNC_LAN_HOST="$CERT_HOST"
  fi
  CERT_ARGS=(--lan-host "$CERT_HOST" --port "$PORT")
  if [[ "$REGENERATE_CERTIFICATE" == "1" ]]; then
    CERT_ARGS+=(--force)
  fi
  bash scripts/setup-https.sh "${CERT_ARGS[@]}"
  if [[ ! -f certs/cert.pem || ! -f certs/key.pem || ! -f certs/ca.crt ]]; then
    echo "HTTPS certificate setup did not produce the required files." >&2
    exit 1
  fi
  PROTO=https
  ARGS+=(--ssl-certfile certs/cert.pem --ssl-keyfile certs/key.pem)
fi

if command -v open >/dev/null 2>&1; then
  open "${PROTO}://localhost:${PORT}/" >/dev/null 2>&1 || true
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "${PROTO}://localhost:${PORT}/" >/dev/null 2>&1 || true
fi

python -m uvicorn "${ARGS[@]}"
