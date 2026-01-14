#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

FRONTEND_DIR="$PROJECT_ROOT/frontend"
ENV_FILE="$FRONTEND_DIR/.env"
ENV_EXAMPLE="$FRONTEND_DIR/.env.example"

if [ ! -f "$ENV_FILE" ]; then
  echo "[set_frontend_config] Missing $ENV_FILE" >&2
  echo "[set_frontend_config] Please create it from $ENV_EXAMPLE, then re-run this script." >&2
  exit 1
fi

echo "[set_frontend_config] Loading environment from $ENV_FILE"
set -a
# shellcheck disable=SC1090
source <(sed -e 's/\r$//' -e '/^[[:space:]]*#/d' -e '/^[[:space:]]*$/d' "$ENV_FILE")
set +a

require_var() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "[set_frontend_config] Required env var '$name' is missing or empty in $ENV_FILE" >&2
    exit 1
  fi
}

require_var STREAM_URL
require_var RELAY_WS_URL
require_var FRONTEND_HOST
require_var FRONTEND_PORT

CONFIG_JS="$FRONTEND_DIR/config.js"
echo "[set_frontend_config] Writing $CONFIG_JS"

# If the UI is served over HTTPS, browsers block http:// and ws:// as mixed content.
# Auto-upgrade config to secure schemes.
STREAM_URL_SECURE="${STREAM_URL/http:\/\//https:\/\/}"
RELAY_WS_URL_SECURE="${RELAY_WS_URL/ws:\/\//wss:\/\/}"
cat >"$CONFIG_JS" <<EOF

window.FRONTEND_CONFIG = {
  streamUrl: "$STREAM_URL_SECURE",
  relayWsUrl: "$RELAY_WS_URL_SECURE"
};

EOF

DOCKERFILE="$FRONTEND_DIR/Dockerfile"
if [ ! -f "$DOCKERFILE" ]; then
  echo "[set_frontend_config] Missing $DOCKERFILE" >&2
  exit 1
fi

echo "[set_frontend_config] Patching $DOCKERFILE (EXPOSE/CMD)"
sed -i -E \
  -e "s/^([[:space:]]*EXPOSE[[:space:]]+)[0-9]+([[:space:]]*)$/\1${FRONTEND_PORT}\2/" \
  -e "s/(--port\", \")[0-9]+(\")/\1${FRONTEND_PORT}\2/" \
  -e "s/(--bind\", \")[^\"]+(\")/\1${FRONTEND_HOST}\2/" \
  "$DOCKERFILE"

COMPOSE_YML="$PROJECT_ROOT/docker-compose.yml"
if [ ! -f "$COMPOSE_YML" ]; then
  echo "[set_frontend_config] Missing $COMPOSE_YML" >&2
  exit 1
fi

echo "[set_frontend_config] Patching $COMPOSE_YML (frontend ports)"
tmp="$(mktemp)"
awk -v p="$FRONTEND_PORT" '
  /^  frontend:[[:space:]]*$/ { in_frontend=1 }
  in_frontend && /^  [A-Za-z0-9_.-]+:[[:space:]]*$/ && $0 !~ /^  frontend:[[:space:]]*$/ { in_frontend=0 }
  in_frontend && $0 ~ /^[[:space:]]*-[[:space:]]*"[0-9]+:[0-9]+"/ {
    sub(/"[0-9]+:[0-9]+"/, "\"" p ":" p "\"")
  }
  in_frontend && $0 ~ /^[[:space:]]*-[[:space:]]*[0-9]+:[0-9]+/ {
    sub(/[0-9]+:[0-9]+/, p ":" p)
  }
  { print }
' "$COMPOSE_YML" >"$tmp"
mv "$tmp" "$COMPOSE_YML"

echo "[set_frontend_config] Done."


