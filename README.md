# Live Caption

LiveCaption is a small “relay + web UI” stack for **live captions on a live stream**.

This repository provides:

- **`nginx/`**: an RTMP + HLS server (nginx-rtmp) that
  - accepts **RTMP ingest** (`rtmp://<host>:1935/live/<stream_key>`)
  - serves **HLS playback** (`http://<host>:8888/hls/<stream_key>/index.m3u8`)
- **`relay_service/`**: a Python relay that
  - pulls audio from an **RTMP** stream via **FFmpeg**
  - forwards raw **PCM (s16le, mono)** to an external **ASR WebSocket**
  - relays caption/status messages to browsers via a **WebSocket** endpoint (`/subtitles`)
- **`frontend/`**: a static web UI that
  - plays a browser-compatible stream URL (typically **HLS `.m3u8`**)
  - connects to the relay’s `/subtitles` WebSocket and displays captions + status

Not included in this repository:

- The ASR backend itself
- The streaming source / encoder device


---

### Architecture (high level)

1. A publisher/device pushes a live stream to your streaming server (commonly RTMP ingest).
2. `relay_service` connects to that RTMP URL, extracts audio via FFmpeg, and streams PCM to your ASR service.
3. The ASR service returns caption JSON messages; `relay_service` broadcasts them to web clients.
4. `frontend` plays the live stream (HLS recommended) and overlays the captions received from the relay.

Important detail: **browsers cannot play RTMP directly**. Your `RTMP_URL` (relay ingest) and `STREAM_URL` (frontend playback) may point to different protocols/URLs produced by the same streaming stack.

---

### Prerequisites

- **Docker + Docker Compose v2**
- (Optional) **FFmpeg** if you want to publish a test stream from your machine
- An **ASR WebSocket** endpoint that accepts PCM audio and emits JSON caption messages

---

### Configuration

Docker Compose loads service configuration via `.env` files (`env_file:` in `docker-compose.yml`).

If you change any ports/URLs in `frontend/.env`, re-run `./scripts/set_frontend_config.sh` and rebuild via Docker Compose.

#### Frontend config file (`frontend/config.js`)

The static UI reads runtime settings from `frontend/config.js`:

- `streamUrl`: what the browser plays (HLS `.m3u8` recommended)
- `relayWsUrl`: where the browser connects for captions (`ws://.../subtitles` or `wss://.../subtitles`)

For Docker Compose, run `scripts/set_frontend_config.sh` to generate `frontend/config.js` and also sync the frontend port/bind settings across `frontend/Dockerfile` and `docker-compose.yml`.

#### Relay service (`relay_service/.env`)

Create `relay_service/.env`:

```bash
RTMP_URL=rtmp://localhost/live
ASR_WS_URL=ws://127.0.0.1:9001/asr

# Audio settings (must match your ASR expectations)
SAMPLE_RATE=16000
CHUNK_MS=500

# Reconnect behavior (caps exponential backoff)
MAX_BACKOFF_SECONDS=30

# Stream end / idle handling
STOP_TIMEOUT_SECONDS=10

# Audio encoding (used only when ASR backend requests WebM/Opus)
ASR_AUDIO_BITRATE=32k

# Where the relay listens (for browser clients)
RELAY_HOST=0.0.0.0
RELAY_PORT=9000

# Optional: trust material for wss:// ASR endpoints.
# Can be inline PEM content OR a filesystem path to a PEM file.
# CERT="-----BEGIN CERTIFICATE----- ... -----END CERTIFICATE-----"
# CERT=/path/to/ca.pem
```

What these mean:

**`RTMP_URL`**
- Source for FFmpeg ingest. Must be reachable from the relay host.
- If this stream never truly disconnects (e.g., RTMP keeps a silent stream open), STOP timeouts depend on whether FFmpeg output bytes actually stop.

**`ASR_WS_URL`**
- WebSocket endpoint for the ASR backend (`ws://` or `wss://`).
- The relay expects the ASR server to send a JSON config message first, then accept audio bytes, and eventually reply with JSON results and `ready_to_stop`.
- If using `wss://` with a private CA, set `CERT`. If the server uses a public CA, `CERT` is not required.
- A refused connection here will cause reconnect attempts with backoff (see `MAX_BACKOFF_SECONDS`).

**`SAMPLE_RATE`**
- Used only when the ASR config message indicates PCM input (`useAudioWorklet=true`).
- Must match what the ASR backend expects for PCM input (s16le at this sample rate).

**`CHUNK_MS`**
- Used only when the ASR config message indicates PCM input. Controls the read size from FFmpeg and thus the size of each PCM packet.
- Smaller values reduce latency but increase overhead.

**`MAX_BACKOFF_SECONDS`**
- Caps exponential backoff for retries after ASR connection failures or FFmpeg errors.
- Larger values reduce reconnect spam but may delay recovery.

**`STOP_TIMEOUT_SECONDS`**
- If FFmpeg output yields no bytes for this long, the relay signals end-of-stream and the ASR connection is closed (after `ready_to_stop`).
- This is also the timeout used by the ASR sender while connected; if no new chunks arrive for this long, the link is closed.
- Note: if RTMP continues to output silence frames, this timeout will not trigger because bytes are still flowing.

**`ASR_AUDIO_BITRATE`**
- Only used when the ASR config message indicates WebM/Opus input (`useAudioWorklet=false`). Passed to FFmpeg (`-b:a`).
- Example frontend does not set an explicit bitrate; it uses the browser MediaRecorder default.
- Too high wastes bandwidth; too low can degrade transcription quality.

**`CERT`**
- Optional certificate trust material used only when `ASR_WS_URL` starts with `wss://`.
- Can be inline PEM or a path to a PEM file. Omit for standard public CA certificates.

#### Frontend (`frontend/.env`)

Create `frontend/.env`:

```bash
# Where to serve the static UI
FRONTEND_HOST=0.0.0.0
FRONTEND_PORT=8000

# What the browser plays (HLS recommended)
STREAM_URL=https://127.0.0.1:8888/hls/stream1/index.m3u8

# Where the browser connects for captions
RELAY_WS_URL=ws://127.0.0.1:9000/subtitles
```

Notes:

- If you have `frontend/.env.example`, you can start from it:

```bash
cp frontend/.env.example frontend/.env
```

- **`scripts/set_frontend_config.sh`** can be used to generate the same `frontend/config.js` and also update Docker port settings to match `.env` (recommended before running Docker Compose).
- `STREAM_URL` must be reachable by the browser (not just the relay host).
- `RELAY_WS_URL` must be reachable by the browser; use `wss://` if you are serving the UI over HTTPS.
- The UI loads **Hls.js** from a CDN (`https://cdn.jsdelivr.net/...`). If your deployment cannot access external CDNs, you will need to vendor/serve that script yourself.

#### Idle/disconnect behavior

- With no input, the relay waits quietly and does not connect to ASR until audio arrives.
- When audio stops for `STOP_TIMEOUT_SECONDS`, `ffmpeg_reader` signals stream end and `asr_link` closes the ASR connection (after `ready_to_stop`).
- If RTMP keeps emitting silence frames, the relay treats it as ongoing audio and will not close until chunks actually stop.

---

### Run (Docker Compose)

This runs: **nginx (RTMP+HLS)**, **relay_service**, and **frontend**.

Default endpoints exposed by `nginx` in `docker-compose.yml`:

- RTMP ingest: `rtmp://<host>:1935/live`
- HLS playback: `https://<host>:8888/hls/<stream_key>/index.m3u8`

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

Note: re-run this script after you change `FRONTEND_HOST` / `FRONTEND_PORT` / `STREAM_URL` / `RELAY_WS_URL`.

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
- **Status message**:
  - `{"type":"status","state":"starting|running|waiting|error|stopped","detail":"...","ts":"<iso8601>"}`

The frontend automatically reconnects to the subtitle WebSocket and periodically displays an idle “waiting for signal” state when no messages arrive.

---

### Troubleshooting

- **Frontend shows “no signal” / video won’t play**:
  - Ensure `STREAM_URL` is **browser-playable** (HLS `.m3u8` recommended).
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
