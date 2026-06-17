#!/bin/sh
set -eu

CERT_FILE="${ASR_PROXY_CERT_FILE:-/etc/haproxy/ssl/cert.pem}"
KEY_FILE="${ASR_PROXY_KEY_FILE:-/etc/haproxy/ssl/key.pem}"
COMBINED_CERT_FILE="${ASR_PROXY_COMBINED_CERT_FILE:-/tmp/asr_proxy.pem}"

{
    cat "$CERT_FILE"
    printf '\n'
    cat "$KEY_FILE"
} > "$COMBINED_CERT_FILE"
chmod 600 "$COMBINED_CERT_FILE"
chown haproxy:haproxy "$COMBINED_CERT_FILE"

BACKENDS_CFG="/usr/local/etc/haproxy/backends.cfg"
HAPROXY_CFG="/usr/local/etc/haproxy/haproxy.cfg"
RUNTIME_CFG="/tmp/haproxy_runtime.cfg"
SERVER_COUNT=$(grep -cE '^[[:space:]]*server[[:space:]]' "$BACKENDS_CFG" || true)
# Worst case: every server is at maxconn except one, and selection hits the
# full ones first. retries must cover all backends (see option redispatch 1).
RETRIES=$SERVER_COUNT
if [ "$RETRIES" -lt 1 ]; then
    echo "asr_proxy: no server entries in $BACKENDS_CFG" >&2
    exit 1
fi
sed "s/__ASR_RETRIES__/$RETRIES/" "$HAPROXY_CFG" > "$RUNTIME_CFG"
echo "asr_proxy: retries=$RETRIES ($SERVER_COUNT backend server(s))"

/usr/local/bin/log-backend-status.sh &

exec haproxy \
    -f "$RUNTIME_CFG" \
    -f "$BACKENDS_CFG" \
    -db
