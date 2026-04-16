import asyncio
import json
import logging
import os
import ssl
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Set

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from .asr_link import asr_link
from .audio import AudioQueue, FormatController, IngestEpoch
from .config import RelayConfig
from .ffmpeg_ingest import ffmpeg_reader

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
    broadcaster = SubtitleBroadcaster()
    audio_queue = AudioQueue()
    fmt_controller = FormatController("webm")
    ingest_epoch = IngestEpoch()
    stop_event = asyncio.Event()
    stream_end_event = asyncio.Event()
    restart_ingest_event = asyncio.Event()
    ssl_context = build_ssl_context(cfg.cert)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # Initial ASR state: not connected until audio arrives and link is established.
        await broadcaster.broadcast_asr_status("disconnected", "initial")
        app.state.ffmpeg_task = asyncio.create_task(
            ffmpeg_reader(
                cfg,
                audio_queue,
                fmt_controller,
                ingest_epoch,
                stop_event,
                broadcaster,
                stream_end_event,
                restart_ingest_event,
                debug_mode,
            )
        )
        app.state.asr_task = asyncio.create_task(
            asr_link(
                cfg,
                audio_queue,
                fmt_controller,
                ingest_epoch,
                broadcaster,
                stop_event,
                stream_end_event,
                restart_ingest_event,
                debug_mode,
                ssl_context,
            )
        )
        logger.info("relay startup complete")
        try:
            yield
        finally:
            stop_event.set()
            await broadcaster.broadcast_asr_status("disconnected", "relay shutting down")
            tasks = [app.state.ffmpeg_task, app.state.asr_task]
            for t in tasks:
                t.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            logger.info("relay shutdown complete")

    app = FastAPI(title="LiveCaption Relay", lifespan=lifespan)

    @app.websocket("/subtitles")
    async def subtitles_ws(ws: WebSocket):
        await ws.accept()
        await broadcaster.register(ws)
        try:
            while True:
                # Keep reading to detect disconnects; ignore content.
                await ws.receive_text()
        except WebSocketDisconnect:
            pass
        finally:
            await broadcaster.unregister(ws)

    @app.get("/healthz")
    async def healthcheck():
        return {"status": "ok"}

    return app
