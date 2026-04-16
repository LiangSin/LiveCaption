import asyncio
import json
import logging
import os
import ssl
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Set

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect

from .config import RelayConfig

logger = logging.getLogger("relay")


class SubtitleBroadcaster:
    """Tracks connected frontend clients and pushes caption/status messages."""

    def __init__(self) -> None:
        self._clients: Set[WebSocket] = set()
        self._lock = asyncio.Lock()
        self._last_asr_status: dict | None = None

    async def register(self, ws: WebSocket):
        async with self._lock:
            self._clients.add(ws)
        logger.info("frontend connected (%d total)", len(self._clients))
        # Immediately send the latest ASR connection state to the newly connected client.
        if self._last_asr_status is not None:
            try:
                await ws.send_text(json.dumps(self._last_asr_status))
            except Exception as exc:  # noqa: BLE001
                logger.warning("failed to send initial asr_status to %s: %s", ws.client, exc)

    async def unregister(self, ws: WebSocket):
        async with self._lock:
            self._clients.discard(ws)
        logger.info("frontend disconnected (%d total)", len(self._clients))

    async def broadcast(self, payload: dict):
        """Send JSON payload to every client, dropping closed sockets."""
        if not self._clients:
            return
        data = json.dumps(payload)
        dead = []
        for ws in list(self._clients):
            try:
                await ws.send_text(data)
            except Exception as exc:  # noqa: BLE001
                logger.warning("broadcast drop (%s): %s", ws.client, exc)
                dead.append(ws)
        if dead:
            async with self._lock:
                for ws in dead:
                    self._clients.discard(ws)

    async def broadcast_status(self, state: str, detail: str = ""):
        await self.broadcast(
            {
                "type": "status",
                "state": state,
                "detail": detail,
                "ts": datetime.now(timezone.utc).isoformat(),
            }
        )

    async def broadcast_asr_status(self, state: str, detail: str = ""):
        # Dedupe identical updates to avoid spamming clients.
        if (
            self._last_asr_status is not None
            and self._last_asr_status.get("state") == state
            and self._last_asr_status.get("detail") == detail
        ):
            return
        payload = {
            "type": "asr_status",
            "state": state,
            "detail": detail,
            "ts": datetime.now(timezone.utc).isoformat(),
        }
        self._last_asr_status = payload
        await self.broadcast(payload)

    async def close_all(self, code: int = 1012) -> None:
        """Close every connected client socket; used when the session is terminating."""
        async with self._lock:
            clients = list(self._clients)
            self._clients.clear()
        for ws in clients:
            try:
                await ws.close(code=code)
            except Exception:
                pass


def build_ssl_context(cert: str | None) -> ssl.SSLContext | None:
    """Create an SSL context that trusts the provided CERT env content/path."""
    if not cert:
        return None

    try:
        ctx = ssl.create_default_context()
        ctx.load_verify_locations(cadata=cert)
        ctx.check_hostname = False
        logger.info("loaded CERT from inline PEM")
        return ctx
    except ssl.SSLError:
        # Fall back to treating CERT as a file path.
        if os.path.exists(cert):
            ctx = ssl.create_default_context()
            ctx.load_verify_locations(cafile=cert)
            ctx.check_hostname = False
            logger.info("loaded CERT from path: %s", cert)
            return ctx

    logger.error("CERT is set but could not be loaded as PEM content or file path")
    raise ssl.SSLError("invalid CERT value; provide PEM content or path to a PEM file")


def create_app(cfg: RelayConfig, debug_mode: bool = False) -> FastAPI:
    # Lazy import to break circular dependency (resource_manage imports from this module).
    from .resource_manage import (
        DuplicateKeyError,
        InvalidKeyError,
        SessionManager,
        SessionState,
        validate_key,
    )

    ssl_context = build_ssl_context(cfg.cert)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.manager = SessionManager(cfg, ssl_context, debug_mode)
        logger.info("relay startup complete")
        try:
            yield
        finally:
            await app.state.manager.shutdown_all()
            logger.info("relay shutdown complete")

    app = FastAPI(title="LiveCaption Relay", lifespan=lifespan)

    @app.post("/register")
    async def register(src: str = Query(..., min_length=1)):
        try:
            validate_key(src)
        except InvalidKeyError as exc:
            raise HTTPException(status_code=400, detail=str(exc))
        try:
            session = await app.state.manager.register(src)
        except DuplicateKeyError:
            raise HTTPException(status_code=409, detail=f"session already registered: {src}")
        return {"key": session.key, "subtitles_url": f"/subtitles/{session.key}"}

    @app.websocket("/subtitles/{key}")
    async def subtitles_ws(ws: WebSocket, key: str):
        # Starlette requires accept() before close() with a custom code.
        try:
            validate_key(key)
        except InvalidKeyError:
            await ws.accept()
            await ws.close(code=4000)
            return
        session = app.state.manager.get(key)
        if session is None or session.state in (
            SessionState.TERMINATING,
            SessionState.TERMINATED,
        ):
            await ws.accept()
            await ws.close(code=4004)
            return
        await ws.accept()
        await session.broadcaster.register(ws)
        try:
            while True:
                # Keep reading to detect disconnects; ignore content.
                await ws.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            await session.broadcaster.unregister(ws)

    @app.get("/healthz")
    async def healthcheck():
        return {"status": "ok"}

    return app
