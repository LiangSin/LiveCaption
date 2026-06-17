#!/bin/sh
# Periodically log per-backend UP/DOWN state and active session count.
INTERVAL="${ASR_PROXY_STATUS_INTERVAL:-15}"
SOCK="/tmp/haproxy.sock"

while [ ! -S "$SOCK" ]; do
    sleep 0.2
done

while true; do
    if [ -S "$SOCK" ]; then
        echo "show stat" | socat - "UNIX-CONNECT:${SOCK}" 2>/dev/null | awk -F, '
            $1 == "asr_backends" && $2 != "BACKEND" && $2 != "FRONTEND" {
                state = $18
                sub(/ .*/, "", state)
                printf "asr_proxy backend_status server=%s state=%s sessions=%s/%s\n", $2, state, $5, $7
            }'
    fi
    sleep "$INTERVAL"
done
