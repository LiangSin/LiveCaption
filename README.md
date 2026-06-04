# Live Caption

LiveCaption is a small “relay + web UI” stack for **live captions on a live stream**.

This repository provides:

- **`nginx/`**: a reverse proxy that
  - accepts **RTMP ingest** from streaming sources
  - forwards internal services (OME playback, relay WebSocket, web UI) to external clients
- **`ome-server/`**: a media server (OvenMediaEngine) that
  - transcodes RTMP input to **LL-HLS** for browser playback
- **`relay_service/`**: a Python relay that
  - pulls audio from an **RTMP** stream via FFmpeg
  - forwards audio to the internal **ASR reverse proxy**
  - relays caption/status messages to browsers via a **WebSocket** endpoint (`/subtitles`)
- **`asr_proxy/`**: an Nginx reverse proxy that
  - load-balances relay ASR WebSocket sessions across configured ASR backends
  - passes WebSocket frames through without interpreting the ASR protocol
- **`frontend/`**: a static web UI that
  - plays the live stream and displays real-time captions
  - **`/`**: main viewer interface with stream playback and captions

Not included in this repository:

- The ASR backend itself
- The streaming source / encoder device


---

### Architecture (high level)

1. **Publisher** pushes RTMP stream to **nginx** reverse proxy
2. **nginx** forwards RTMP to **OvenMediaEngine**, which transcodes to **LL-HLS** for browser playback
3. **relay_service** pulls audio and sends it to **asr_proxy**
4. **asr_proxy** assigns each ASR WebSocket session to one configured ASR backend
5. **frontend** plays LL-HLS stream and displays live captions

**Key**: nginx routes all traffic (RTMP ingest, LL-HLS playback, WebSocket, web UI). Relay uses RTMP for audio extraction; browsers use LL-HLS for low-latency playback.

---

### Prerequisites

- **Docker + Docker Compose v2**
- (Optional) **FFmpeg** if you want to publish a test stream from your machine
- One or more **ASR WebSocket** endpoints that accept audio and emit JSON caption messages

---

### Configuration

Docker Compose loads service configuration via `.env` files (`env_file:` in `docker-compose.yml`).

If you change any ports/URLs in `frontend/.env`, re-run `./scripts/set_frontend_config.sh` and rebuild via Docker Compose.

#### Relay service (`relay_service/.env`)

Create `relay_service/.env`:

```bash
# Streaming Source
RTMP_URL=rtmp://.../live/stream1

# ASR Connection
ASR_WS_URL=wss://asr_proxy:9001/asr
STOP_TIMEOUT_SECONDS=3
CHUNK_MS=100
SAMPLE_RATE=16000
MAX_BACKOFF_SECONDS=30
SEND_BUDGET_SECONDS=0.1

# Caption output service
RELAY_HOST=0.0.0.0
RELAY_PORT=9000
```

What these mean:

- `RTMP_URL`: Source for FFmpeg ingest. Must be reachable from the relay host.
- `ASR_WS_URL`: WebSocket endpoint used by the relay. In Docker Compose this should normally be the internal ASR reverse proxy over TLS: `wss://asr_proxy:9001/asr`. TLS certificate verification is intentionally skipped for this internal ASR connection so self-signed backend certificates are accepted.
- `STOP_TIMEOUT_SECONDS`: Maximum idle time (in seconds) before closing the ASR connection when no audio data is received.
- `CHUNK_MS`: Duration of each audio chunk in milliseconds (used to calculate chunk size for PCM format).
- `SAMPLE_RATE`: Audio sample rate in Hz for PCM format conversion.
- `ASR_AUDIO_BITRATE`: Bitrate for Opus audio encoding when using WebM format (e.g., "24k", "32k").
- `MAX_BACKOFF_SECONDS`: Maximum backoff delay (in seconds) between reconnection attempts after FFmpeg or ASR failures.
- `SEND_BUDGET_SECONDS`: Time budget (in seconds) for sending audio chunks before yielding control to the event loop (prevents sender from blocking receiver).
- `RELAY_HOST`: Host address for the relay service to bind to (typically "0.0.0.0" to accept connections from any interface).
- `RELAY_PORT`: Port number for the relay service to listen on for WebSocket connections from frontend clients.

#### ASR reverse proxy (`asr_proxy/`)

Configure ASR backends directly in `asr_proxy/backends.conf`:

```nginx
server 10.0.0.11:8000 max_fails=3 fail_timeout=10s;
server 10.0.0.12:8000 max_fails=3 fail_timeout=10s;
```

`asr_proxy` is an internal Nginx WebSocket reverse proxy. It chooses one backend when the relay opens `/asr`, keeps that WebSocket pinned to the selected backend, and forwards frames in both directions until either side closes. It does not parse audio chunks, captions, empty stream-end frames, or `ready_to_stop` messages.

Backend selection uses Nginx `least_conn` with a shared upstream `zone`, so active WebSocket connection counts are shared across all Nginx worker processes. Without the shared zone, each worker would keep its own counters and low connection counts could cluster on the same backend.

Both connection legs are encrypted:

- relay -> `asr_proxy`: `asr_proxy` terminates TLS using `ssl-config/cert.pem`; the relay intentionally skips certificate verification for this internal ASR connection.
- `asr_proxy` -> ASR backend: re-encrypted with `proxy_pass https://`, since the real ASR backend only accepts `wss`. Upstream cert verification is disabled (`proxy_ssl_verify off`) because backends are addressed by IP with a private self-signed cert, matching the other internal `proxy_pass` blocks in `nginx/nginx.conf`.

`asr_proxy` logs to Docker stdout/stderr:

- `asr_backend_probe ... backend=<host:port> status=ok|failed` is emitted every 30 seconds for each configured backend, so you can tell whether the proxy can complete a TLS connection to every backend.
- WebSocket access logs include `upstream="<host:port>"`, which shows which backend handled that relay connection. Nginx writes this access log when the WebSocket request finishes, so long-running ASR sessions appear after disconnect.

#### Frontend (`frontend/.env`)

Create `frontend/.env`:

```bash
# Streaming source
STREAM_URL=https://.../live/stream1/llhls.m3u8
RELAY_WS_URL=wss://.../subtitles

# Frontend
FRONTEND_HOST=0.0.0.0
FRONTEND_PORT=8088
```

What these mean:

- `STREAM_URL`: Source for LL-HLS ingest. Must be reachable by the browsers.
- `RELAY_WS_URL`: Source for subtitles . Must be reachable by the browser.
- `FRONTEND_HOST` and `FRONTEND_PORT`: Address and host for the frontend to listen on.

Run `scripts/set_frontend_config.sh` to generate `frontend/config.js` and also sync the frontend port/bind settings.

#### Idle/disconnect behavior

- With no input, the relay waits quietly and does not connect to ASR until audio arrives.
- When audio stops for `STOP_TIMEOUT_SECONDS`, `ffmpeg_reader` signals stream end and `asr_link` closes the ASR connection (after `ready_to_stop`).
- If RTMP keeps emitting silence frames, the relay treats it as ongoing audio and will not close until chunks actually stop.

---

### Run (Docker Compose)

This runs: **nginx (RTMP+HLS)**, **asr_proxy**, **relay_service**, and **frontend**.

Default RTMP ingest endpoint: `rtmp://<host>:1935/live`.
Publish a test stream to the built-in RTMP server (example using FFmpeg):

```bash
# Replace input.mp4 with your own media file
ffmpeg -re -stream_loop -1 -i input.mp4 -c copy -f flv rtmp://127.0.0.1:1935/live/stream1
```

1) Create env files:

- `relay_service/.env` (see above)
- `frontend/.env` (see above; for containers you usually want `FRONTEND_HOST=0.0.0.0`)

2) Configure ASR backend addresses in `asr_proxy/backends.conf`.

3) Sync frontend config + ports (important):

```bash
./scripts/set_frontend_config.sh
```

This will:

- generate `frontend/config.js` from `frontend/.env`
- update `frontend/Dockerfile` (`EXPOSE` + `http.server` bind/port)
- update `docker-compose.yml` frontend `ports:` mapping

Note: re-run this script after you update `frontend/.env`.

4) Build and run:

```bash
docker compose up --build
```

Then open:

- `http://<FRONTEND_HOST>:<FRONTEND_PORT>/`

Stop:

```bash
docker compose down
```

View logs:

```bash
docker compose logs -f nginx
docker compose logs -f asr_proxy
docker compose logs -f relay_service
docker compose logs -f frontend
```

---

### Runtime behavior & message format

The relay broadcasts JSON messages to all connected `/subtitles` clients:

- **Caption message**:
  - `{"type":"caption","text":"...","ts":"<iso8601>","partial":true|false}`
  - `{"type":"caption_translation","text":"...","ts":"<iso8601>","partial":true|false}`
- **Status message**:
  - `{"type":"status","state":"starting|running|waiting|error|stopped","detail":"...","ts":"<iso8601>"}`
- **ASR status message**:
  - `{"type":"asr_status","state":"connecting|connected|disconnected|error","detail":"...","ts":"<iso8601>"}`

The frontend automatically reconnects to the subtitle WebSocket and logs an idle message every 8 seconds when no messages are received from the relay.

---

### Troubleshooting

- **Frontend shows “no signal” / video won’t play**:
  - Ensure `STREAM_URL` is **browser-playable** (LL-HLS `.m3u8` recommended).
  - Ensure your streaming server sets correct **CORS** headers for the HLS URL.
- **Relay connects but no captions appear**:
  - Verify `ASR_WS_URL` points at `wss://asr_proxy:9001/asr` when running with Docker Compose.
  - Verify each backend in `asr_proxy/backends.conf` is reachable and speaks the expected protocol (config JSON -> audio bytes -> JSON results + `ready_to_stop`).
  - Check logs:

```bash
docker compose logs -f relay_service
docker compose logs -f asr_proxy
```
- **Need to debug ports / config changes**:
  - Re-run `./scripts/set_frontend_config.sh`, then rebuild:

```bash
docker compose up --build
```
- **Unstable network / frequent reconnects**:
  - Increase `MAX_BACKOFF_SECONDS` to reduce reconnect pressure.
  - Consider increasing `CHUNK_MS` to reduce WebSocket send frequency (higher latency, lower overhead).
