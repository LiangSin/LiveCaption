import os
import json
import time
import logging
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Header
from pydantic import BaseModel

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
logger = logging.getLogger("monitor")

app = FastAPI()

CONFIG_FILE = Path(os.getenv("MONITOR_CONFIG_FILE", "/app/monitor_config.json"))
SECRET_KEY = os.getenv("MONITOR_SECRET_KEY", "")
DOWN_THRESHOLD = 120  # seconds before a service is considered down

# In-memory state: name → {status, last_updated}
_states: dict[str, dict] = {}


class UpdateRequest(BaseModel):
    name: str
    source: str
    status: str


def _load_allowed() -> list[str]:
    try:
        return json.loads(CONFIG_FILE.read_text()).get("services", [])
    except Exception as exc:
        logger.error("Failed to read config %s: %s", CONFIG_FILE, exc)
        return []


def _check_key(x_monitor_key: Optional[str], authorization: Optional[str]) -> bool:
    if not SECRET_KEY:
        logger.warning("MONITOR_SECRET_KEY is not set – all push requests will be rejected")
        return False
    candidate = x_monitor_key
    if not candidate and authorization and authorization.startswith("Bearer "):
        candidate = authorization[7:]
    return candidate == SECRET_KEY


@app.post("/update")
async def update(
    payload: UpdateRequest,
    x_monitor_key: Optional[str] = Header(None),
    authorization: Optional[str] = Header(None),
):
    if not _check_key(x_monitor_key, authorization):
        raise HTTPException(status_code=401, detail="Invalid or missing key")

    allowed = _load_allowed()
    if payload.name not in allowed:
        raise HTTPException(status_code=400, detail=f"Unknown service name: {payload.name!r}")

    # Log source for traceability but never expose it in the status API
    logger.info(
        "Update: name=%r  source=%r  status=%r",
        payload.name, payload.source, payload.status,
    )

    _states[payload.name] = {
        "status": payload.status,
        "last_updated": time.time(),
    }
    return {"ok": True}


@app.get("/status")
async def status():
    allowed = _load_allowed()
    now = time.time()
    services = []
    for name in allowed:
        if name in _states:
            s = _states[name]
            last_updated = s["last_updated"]
            effective_status = s["status"]
            # Auto-downgrade if no update within threshold
            if effective_status != "down" and now - last_updated > DOWN_THRESHOLD:
                effective_status = "down"
            services.append({
                "name": name,
                "status": effective_status,
                "last_updated": last_updated,
            })
        else:
            services.append({
                "name": name,
                "status": "unknown",
                "last_updated": None,
            })
    return {"services": services}
