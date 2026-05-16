# Monitor Service

Push-based service monitoring with a real-time dashboard served by nginx.

## Architecture

```
Your services  ──PUSH──►  /monitor/update  ──►  monitor_service (FastAPI :8080)
                                                        │
Browser  ──GET──►  /monitor           ◄── nginx serves monitor.html directly
Browser  ──GET──►  /monitor/api/status  ──►  monitor_service (FastAPI :8080)
```

State is kept in memory. The service list is read from `monitor_config.json` on every request, so you can add/remove services without restarting.

---

## Configuration

### 1. Secret Key — `monitor_service/.env`

```
MONITOR_SECRET_KEY=your_strong_secret_here
MONITOR_CONFIG_FILE=/app/monitor_config.json
```

Set `MONITOR_SECRET_KEY` to a strong random string and distribute the same value to every service you want to monitor. All push requests without a matching key are rejected with HTTP 401.

### 2. Service Name List — `monitor_service/monitor_config.json`

```json
{
  "services": [
    "LiveCaption",
    "relay_service"
  ]
}
```

- Only names listed here are accepted by `/monitor/update`. Unknown names return HTTP 400.
- Edit and save at any time — changes take effect on the next push/poll with **no restart required**.

---

## Push Format

```
POST https://<your-domain>/monitor/update
Content-Type: application/json
X-Monitor-Key: <MONITOR_SECRET_KEY>
```

Request body:

```json
{
  "name":   "LiveCaption",
  "source": "host-identifier-or-ip",
  "status": "up"
}
```

| Field    | Required | Description |
|----------|----------|-------------|
| `name`   | ✓ | Must match an entry in `monitor_config.json` |
| `source` | ✓ | Logged server-side for traceability; **never** exposed to the browser |
| `status` | ✓ | Recommended values: `up`, `degraded`, `down` |

The secret key can be passed as either:
- Header: `X-Monitor-Key: <key>`
- Header: `Authorization: Bearer <key>`

Rate limit: **60 requests/minute** per IP (burst 15).

### curl

```bash
curl -X POST https://<your-domain>/monitor/update \
  -H "Content-Type: application/json" \
  -H "X-Monitor-Key: your_strong_secret_here" \
  -d '{"name":"LiveCaption","source":"server-01","status":"up"}'
```

### Python

```python
import requests

requests.post(
    "https://<your-domain>/monitor/update",
    json={"name": "LiveCaption", "source": "server-01", "status": "up"},
    headers={"X-Monitor-Key": "your_strong_secret_here"},
    timeout=5,
)
```

Suggested pattern: call this from a **cron job**, **systemd timer**, or a background thread in your service every 30–60 seconds.

---

## Dashboard

Open `https://<your-domain>/monitor` in a browser.

| Feature | Behaviour |
|---------|-----------|
| Auto-refresh | Polls `/monitor/api/status` every **30 seconds** |
| Auto-down | Backend marks a service `down` if no push received in **2 minutes** |
| Relative timestamps | Updated locally every 15 seconds (no extra API call) |
| Backend unreachable | Warning banner shown; last known state preserved |
| `source` field | Only written to container logs — never returned by the status API |

Status colours:

| Status | Meaning |
|--------|---------|
| `up` | Service is healthy (green, pulsing indicator) |
| `degraded` | Service is running but impaired (amber) |
| `down` | Explicitly reported down, or no update for > 2 min (red) |
| `unknown` | Service has never pushed an update since last restart (grey) |

---

## Deployment

```bash
# First time or after code changes
docker compose up -d --build monitor_service nginx

# Config-only change (monitor_config.json or .env)
docker compose restart monitor_service
```
