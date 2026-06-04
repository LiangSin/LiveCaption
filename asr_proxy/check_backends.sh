#!/bin/sh
set -eu

BACKENDS_FILE="${ASR_BACKENDS_FILE:-/etc/nginx/asr_backends.conf}"
INTERVAL_SECONDS="${ASR_BACKEND_CHECK_INTERVAL_SECONDS:-30}"
TIMEOUT_SECONDS="${ASR_BACKEND_CHECK_TIMEOUT_SECONDS:-5}"

if [ "${ASR_BACKEND_PROBE_CHILD:-0}" != "1" ]; then
    ASR_BACKEND_PROBE_CHILD=1 "$0" &
    exit 0
fi

log() {
    printf '%s asr_backend_probe %s\n' "$(date -Iseconds)" "$*"
}

list_backends() {
    sed -n 's/^[[:space:]]*server[[:space:]]\+\([^[:space:];]\+\).*$/\1/p' "$BACKENDS_FILE"
}

check_backend() {
    backend="$1"
    host="${backend%:*}"
    port="${backend##*:}"

    if [ "$host" = "$backend" ] || [ -z "$host" ] || [ -z "$port" ]; then
        log "backend=$backend status=invalid reason=expected_host_port"
        return
    fi

    if timeout "$TIMEOUT_SECONDS" openssl s_client \
        -connect "$host:$port" \
        -servername "$host" \
        -brief \
        </dev/null >/dev/null 2>&1; then
        log "backend=$backend status=ok protocol=wss"
    else
        log "backend=$backend status=failed protocol=wss timeout=${TIMEOUT_SECONDS}s"
    fi
}

log "starting file=$BACKENDS_FILE interval=${INTERVAL_SECONDS}s timeout=${TIMEOUT_SECONDS}s"

while true; do
    if [ ! -r "$BACKENDS_FILE" ]; then
        log "status=failed reason=backends_file_not_readable file=$BACKENDS_FILE"
    else
        backends="$(list_backends || true)"
        if [ -z "$backends" ]; then
            log "status=failed reason=no_backends_configured file=$BACKENDS_FILE"
        else
            for backend in $backends; do
                check_backend "$backend"
            done
        fi
    fi
    sleep "$INTERVAL_SECONDS"
done
