#!/usr/bin/env bash
set -euo pipefail

PORT=8008
HTTPS=0
ENABLE_OTP=0
OTP_CODE=""
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
    --otp)
      ENABLE_OTP=1
      shift
      ;;
    --otp-code)
      ENABLE_OTP=1
      OTP_CODE="${2:?missing otp code}"
      shift 2
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
      echo "Usage: ./run.sh [--port 8008] [--https] [--access-token 123456789012] [--lan-host 192.168.1.20]"
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
python -m pip install -r requirements.txt

if [[ "$ENABLE_OTP" == "1" ]]; then
  export CROSSSYNC_ENABLE_OTP=1
fi
if [[ -n "$OTP_CODE" ]]; then
  export CROSSSYNC_ACCESS_TOKEN="$OTP_CODE"
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
  if [[ -f certs/cert.pem && -f certs/key.pem ]]; then
    PROTO=https
    ARGS+=(--ssl-certfile certs/cert.pem --ssl-keyfile certs/key.pem)
  else
    echo "HTTPS requested but certs/cert.pem and certs/key.pem were not found. Falling back to HTTP." >&2
  fi
fi

if command -v open >/dev/null 2>&1; then
  open "${PROTO}://localhost:${PORT}/" >/dev/null 2>&1 || true
elif command -v xdg-open >/dev/null 2>&1; then
  xdg-open "${PROTO}://localhost:${PORT}/" >/dev/null 2>&1 || true
fi

python -m uvicorn "${ARGS[@]}"
