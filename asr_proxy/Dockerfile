FROM nginx:stable-alpine

RUN apk add --no-cache openssl

COPY asr_proxy/asr_proxy.conf /etc/nginx/nginx.conf
COPY asr_proxy/backends.conf /etc/nginx/asr_backends.conf
COPY asr_proxy/check_backends.sh /docker-entrypoint.d/40-check-asr-backends.sh

RUN chmod +x /docker-entrypoint.d/40-check-asr-backends.sh

EXPOSE 9001
