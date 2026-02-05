# Live Caption

LiveCaption is a small “relay + web UI” stack for **live captions on a live stream**.

This repository provides:

- **`nginx/`**: a reverse proxy that
  - accepts **RTMP ingest** from streaming sources
  - forwards internal services (OME playback, relay WebSocket, web UI) to external clients
- **ome-server**: a media server (OvenMediaEngine) that
  - transcodes RTMP input to **LL-HLS** for browser playback
- **`relay_service/`**: a Python relay that
  - pulls audio from an **RTMP** stream via FFmpeg
  - forwards audio to an external **ASR WebSocket**
  - relays caption/status messages to browsers via a **WebSocket** endpoint (`/subtitles`)
- **`frontend/`**: a static web UI that
  - plays the live stream and displays real-time captions
  - **`/`**: main viewer interface with stream playback and captions
  - **`/translate`**: viewer interface with translated captions
  - **`/dev`**: developer view with detailed status information

Not included in this repository:

- The ASR backend itself
- The streaming source / encoder device


---

### Architecture (high level)

1. **Publisher** pushes RTMP stream to **nginx** reverse proxy
2. **nginx** forwards RTMP to **OvenMediaEngine**, which transcodes to **LL-HLS** for browser playback
3. **relay_service** pulls audio, sends to **ASR WebSocket** and broadcasts the returned captions to web clients via `/subtitles` WebSocket
4. **frontend** plays LL-HLS stream and displays live captions

**Key**: nginx routes all traffic (RTMP ingest, LL-HLS playback, WebSocket, web UI). Relay uses RTMP for audio extraction; browsers use LL-HLS for low-latency playback.

---

### Prerequisites

- **Docker + Docker Compose v2**
- (Optional) **FFmpeg** if you want to publish a test stream from your machine
- An **ASR WebSocket** endpoint that accepts PCM audio and emits JSON caption messages

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
ASR_WS_URL=wss://.../asr
STOP_TIMEOUT_SECONDS=3
CERT=ssl-config/cert.pem
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
- `ASR_WS_URL`: WebSocket endpoint of the ASR service that receives audio and returns transcriptions.
- `STOP_TIMEOUT_SECONDS`: Maximum idle time (in seconds) before closing the ASR connection when no audio data is received.
- `CERT`: Path to a PEM certificate file or inline PEM content for SSL/TLS verification when connecting to the ASR service over `wss://`.
- `CHUNK_MS`: Duration of each audio chunk in milliseconds (used to calculate chunk size for PCM format).
- `SAMPLE_RATE`: Audio sample rate in Hz for PCM format conversion.
- `ASR_AUDIO_BITRATE`: Bitrate for Opus audio encoding when using WebM format (e.g., "24k", "32k").
- `MAX_BACKOFF_SECONDS`: Maximum backoff delay (in seconds) between reconnection attempts after FFmpeg or ASR failures.
- `SEND_BUDGET_SECONDS`: Time budget (in seconds) for sending audio chunks before yielding control to the event loop (prevents sender from blocking receiver).
- `RELAY_HOST`: Host address for the relay service to bind to (typically "0.0.0.0" to accept connections from any interface).
- `RELAY_PORT`: Port number for the relay service to listen on for WebSocket connections from frontend clients.

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

This runs: **nginx (RTMP+HLS)**, **relay_service**, and **frontend**.

Default RTMP ingest endpoint: `rtmp://<host>:1935/live`.
Publish a test stream to the built-in RTMP server (example using FFmpeg):

```bash
# Replace input.mp4 with your own media file
ffmpeg -re -stream_loop -1 -i input.mp4 -c copy -f flv rtmp://127.0.0.1:1935/live/stream1
```

1) Create env files:

- `relay_service/.env` (see above)
- `frontend/.env` (see above; for containers you usually want `FRONTEND_HOST=0.0.0.0`)

2) Sync frontend config + ports (important):

```bash
./scripts/set_frontend_config.sh
```

This will:

- generate `frontend/config.js` from `frontend/.env`
- update `frontend/Dockerfile` (`EXPOSE` + `http.server` bind/port)
- update `docker-compose.yml` frontend `ports:` mapping

Note: re-run this script after you update `frontend/.env`.

3) Build and run:

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
  - Verify `ASR_WS_URL` is reachable and speaks the expected protocol (config JSON -> audio bytes -> JSON results + `ready_to_stop`).
  - Check logs:

```bash
docker compose logs -f relay_service
```
- **Need to debug ports / config changes**:
  - Re-run `./scripts/set_frontend_config.sh`, then rebuild:

```bash
docker compose up --build
```
- **Unstable network / frequent reconnects**:
  - Increase `MAX_BACKOFF_SECONDS` to reduce reconnect pressure.
  - Consider increasing `CHUNK_MS` to reduce WebSocket send frequency (higher latency, lower overhead).
