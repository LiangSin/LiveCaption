#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$PROJECT_ROOT/relay_service/.env"

if [ -f "$ENV_FILE" ]; then
  echo "[start_relay] Loading environment from $ENV_FILE"
  set -a
  # shellcheck source=/home/nasa/LiveCaption/.env
  source "$ENV_FILE"
  set +a
else
  echo "[start_relay] No .env found, using process environment"
fi

cd "$PROJECT_ROOT"

PYTHON_BIN="${PYTHON_BIN:-python}"
echo "[start_relay] Starting relay_service.relay_main with $PYTHON_BIN $*"
exec "$PYTHON_BIN" -m relay_service.relay_main "$@"

