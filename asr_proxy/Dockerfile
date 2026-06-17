FROM haproxy:lts-alpine

USER root

RUN apk add --no-cache openssl socat

COPY asr_proxy/haproxy.cfg /usr/local/etc/haproxy/haproxy.cfg
COPY asr_proxy/backends.conf /usr/local/etc/haproxy/backends.cfg
COPY asr_proxy/start-asr-proxy.sh /usr/local/bin/start-asr-proxy.sh
COPY asr_proxy/log-backend-status.sh /usr/local/bin/log-backend-status.sh

RUN chmod +x /usr/local/bin/start-asr-proxy.sh /usr/local/bin/log-backend-status.sh

EXPOSE 9001

CMD ["/usr/local/bin/start-asr-proxy.sh"]
