FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        libnginx-mod-rtmp \
        libnginx-mod-stream \
        nginx \
        wget \
    && rm -rf /var/lib/apt/lists/*

EXPOSE 1936 443

CMD ["nginx", "-g", "daemon off;"]
