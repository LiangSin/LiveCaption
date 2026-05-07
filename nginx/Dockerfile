FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        libnginx-mod-rtmp \
        nginx \
        wget \
    && rm -rf /var/lib/apt/lists/*

EXPOSE 1935 8088

CMD ["nginx", "-g", "daemon off;"]
