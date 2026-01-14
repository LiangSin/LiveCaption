import asyncio
import argparse
import json
import logging
import os
import signal
import ssl
import sys
import time
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from typing import Set

import uvicorn
import websockets
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from .config import load_config, RelayConfig

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | relay | %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("relay")


class NoAudioTimeout(Exception):
    """Raised when audio input stalls long enough to drop the ASR link."""


class SubtitleBroadcaster:
    """Tracks connected frontend clients and pushes caption/status messages."""

    def __init__(self) -> None:
        self._clients: Set[WebSocket] = set()
        self._lock = asyncio.Lock()

    async def register(self, ws: WebSocket):
        async with self._lock:
            self._clients.add(ws)
        logger.info("frontend connected (%d total)", len(self._clients))

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


class AudioQueue:
    """Bounded queue to avoid unbounded memory growth."""

    def __init__(self, max_chunks: int = 100):
        self.queue: asyncio.Queue[bytes] = asyncio.Queue(maxsize=max_chunks)
        self._dropped = 0

    async def put(self, chunk: bytes):
        try:
            self.queue.put_nowait(chunk)
        except asyncio.QueueFull:
            self._dropped += 1
            if self._dropped % 50 == 1:
                logger.warning("audio queue full; dropping chunks (dropped=%d)", self._dropped)

    async def get(self):
        return await self.queue.get()


class FormatController:
    """Coordinates audio format selection based on ASR config message."""

    def __init__(self, default_format: str) -> None:
        self._format = default_format
        self._event = asyncio.Event()
        self._event.set()

    @property
    def current(self) -> str:
        return self._format

    def set(self, fmt: str) -> None:
        self._format = fmt
        self._event.set()

    async def wait_for_format(self) -> str:
        await self._event.wait()
        return self._format


def build_ffmpeg_cmd(cfg: RelayConfig, fmt: str) -> tuple[list[str], int]:
    """
    Build ffmpeg command and suggested read size.

    - pcm: raw s16le to stdout; read size based on chunk_ms/sample_rate.
    - webm: opus-in-webm to stdout; use fixed chunk size (8KB) similar to MediaRecorder blobs.
    """
    if fmt == "pcm":
        chunk_bytes = int(cfg.sample_rate * 2 * (cfg.chunk_ms / 1000))
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            cfg.rtmp_url,
            "-vn",
            "-ac",
            "1",
            "-ar",
            str(cfg.sample_rate),
            "-f",
            "s16le",
            "pipe:1",
        ]
        return cmd, chunk_bytes

    # Default: webm (opus) to mimic example frontend MediaRecorder output.
    chunk_bytes = 8192
    # MediaRecorder typically runs at 48000Hz; match that to reduce transcoding quirks.
    opus_rate = 48000
    cmd = [
        "ffmpeg",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        cfg.rtmp_url,
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(opus_rate),
        "-c:a",
        "libopus",
        "-b:a",
        cfg.asr_audio_bitrate,
        "-f",
        "webm",
        "-",
    ]
    return cmd, chunk_bytes


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

def clear_audio_queue(audio_queue: AudioQueue):
    # Clear queue
    try:
        while True:
            audio_queue.queue.get_nowait()
    except asyncio.QueueEmpty:
        pass

async def ffmpeg_reader(
    cfg: RelayConfig,
    audio_queue: AudioQueue,
    fmt_controller: FormatController,
    stop_event: asyncio.Event,
    broadcaster: SubtitleBroadcaster,
    stream_end_event: asyncio.Event,
    restart_ingest_event: asyncio.Event,
    debug_mode: bool = False,
):
    """Continuously pull PCM audio from RTMP using FFmpeg; restart on failure."""
    backoff = 1
    await broadcaster.broadcast_status("starting", "launching ffmpeg ingest")
    chunk_counter = 0
    current_fmt: str | None = None
    stop_timeout = max(1.0, float(cfg.stop_timeout_seconds))
    read_poll_seconds = 1.0
    idle_log_interval = 10.0
    idle_signaled = False
    while not stop_event.is_set():
        fmt = await fmt_controller.wait_for_format()
        if current_fmt != fmt:
            logger.info("ffmpeg ingest format set to: %s", fmt)
            current_fmt = fmt
        chunk_counter = 0
        cmd, chunk_bytes = build_ffmpeg_cmd(cfg, fmt)
        logger.info("starting ffmpeg: %s", " ".join(cmd))
        try:
            process = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError:
            logger.exception("ffmpeg not found; ensure it is installed")
            await broadcaster.broadcast_status("error", "ffmpeg not found on PATH")
            await asyncio.sleep(min(backoff, cfg.max_backoff_seconds))
            backoff = min(backoff * 2, cfg.max_backoff_seconds)
            continue

        backoff = 1
        last_data_ts = time.monotonic()
        next_idle_log = last_data_ts + idle_log_interval
        await broadcaster.broadcast_status("running", "ffmpeg ingest active")

        try:
            assert process.stdout is not None
            while not stop_event.is_set():
                if restart_ingest_event.is_set():
                    restart_ingest_event.clear()
                    logger.info("ffmpeg ingest restart requested; restarting to reset stream headers")
                    break
                if fmt_controller.current != current_fmt:
                    logger.info("ffmpeg format change detected; restarting ingest")
                    raise RuntimeError("format change")
                try:
                    chunk = await asyncio.wait_for(
                        process.stdout.read(chunk_bytes),
                        timeout=read_poll_seconds,
                    )
                except asyncio.TimeoutError:
                    if stop_event.is_set():
                        break
                    now = time.monotonic()
                    if debug_mode and now >= next_idle_log:
                        logger.info("ffmpeg ingest idle; waiting for input")
                        next_idle_log = now + idle_log_interval
                    if now - last_data_ts >= stop_timeout and not idle_signaled:
                        stream_end_event.set()
                        idle_signaled = True
                        logger.info(
                            "ffmpeg ingest idle for %.1fs; restarting ingest to reset stream headers",
                            stop_timeout,
                        )
                        break
                    continue
                if not chunk:
                    if stop_event.is_set():
                        break
                    stream_end_event.set()
                    logger.info("ffmpeg stdout ended; restarting ingest")
                    break
                last_data_ts = time.monotonic()
                next_idle_log = last_data_ts + idle_log_interval
                if stream_end_event.is_set():
                    stream_end_event.clear()
                idle_signaled = False
                await audio_queue.put(chunk)
                if debug_mode:
                    chunk_counter += 1
                    logger.info("ffmpeg->queue: chunk #%d (%d bytes)", chunk_counter, len(chunk))
        except asyncio.CancelledError:
            logger.info("ffmpeg ingest task cancelled")
            raise
        except Exception as exc:  # noqa: BLE001
            if stop_event.is_set():
                logger.info("ffmpeg ingest stopping: %s", exc)
            else:
                logger.exception("ffmpeg ingest failed: %s", exc)
                await broadcaster.broadcast_status("error", f"ffmpeg ingest failed: {exc}")
        finally:
            if process.returncode is None:
                process.kill()
                await process.wait()
            await asyncio.sleep(min(backoff, cfg.max_backoff_seconds))
            backoff = min(backoff * 2, cfg.max_backoff_seconds)


async def asr_link(
    cfg: RelayConfig,
    audio_queue: AudioQueue,
    fmt_controller: FormatController,
    broadcaster: SubtitleBroadcaster,
    stop_event: asyncio.Event,
    stream_end_event: asyncio.Event,
    restart_ingest_event: asyncio.Event,
    debug_mode: bool = False,
    ssl_context: ssl.SSLContext | None = None,
):
    """Send PCM to ASR service and forward captions to frontends.

    The link is opened only when audio is flowing, and is closed when the audio
    signal disappears for a sustained period. This mirrors the example
    frontend's start/stop behavior, but is driven by the incoming stream
    instead of a user action.
    """
    backoff = 1
    pending_chunk: bytes | None = None
    stop_timeout = max(1.0, float(cfg.stop_timeout_seconds))
    sent_chunks = 0
    last_status: str | None = None
    last_caption: tuple[str, bool] | None = None

    async def graceful_stop(ws) -> None:
        """Signal stream end with empty bytes, then wait for ready_to_stop."""
        try:
            await ws.send(b"")
        except Exception:
            return

        # Wait up to 5s for ready_to_stop; consume and ignore other messages.
        deadline = asyncio.get_event_loop().time() + 5
        while True:
            remaining = deadline - asyncio.get_event_loop().time()
            if remaining <= 0:
                break
            try:
                msg = await asyncio.wait_for(ws.recv(), timeout=remaining)
            except Exception:
                break
            try:
                payload = json.loads(msg)
            except Exception:
                continue
            if payload.get("type") == "ready_to_stop":
                break
    while not stop_event.is_set():
        ws = None
        stream_started = False
        ready_to_stop_seen = False
        # Wait for audio before attempting to open the ASR link. This avoids
        # connecting with an empty stream, which some ASR backends treat as an
        # error/timeout.
        if pending_chunk is None:
            pending_chunk = await audio_queue.get()
            if debug_mode:
                logger.info("asr-link: first audio chunk ready (%d bytes)", len(pending_chunk))

        try:
            logger.info("connecting to ASR at %s", cfg.asr_ws_url)
            ssl_ctx = ssl_context if cfg.asr_ws_url.startswith("wss://") else None
            async with websockets.connect(
                cfg.asr_ws_url,
                max_size=None,
                ping_interval=20,
                ping_timeout=20,
                compression=None,  # avoid permessage-deflate framing surprises
                ssl=ssl_ctx,
            ) as ws:
                stream_started = False
                ready_to_stop_seen = False
                # Reset per-connection dedupe state.
                last_caption = None
                last_status = None
                # Expect config message first to learn format.
                try:
                    config_raw = await asyncio.wait_for(ws.recv(), timeout=5)
                    config_payload = json.loads(config_raw)
                except Exception as exc:  # noqa: BLE001
                    raise RuntimeError(f"failed to receive config message: {exc}") from exc

                use_worklet = bool(config_payload.get("useAudioWorklet"))
                fmt = "pcm" if use_worklet else "webm"
                fmt_controller.set(fmt)

                if debug_mode:
                    logger.info(
                        "asr-link: config received useAudioWorklet=%s => format=%s", use_worklet, fmt
                    )
                await broadcaster.broadcast_status("running", "ASR connected")
                backoff = 1
                first_chunk = pending_chunk
                pending_chunk = None
                sent_chunks = 0

                async def sender(initial_chunk: bytes | None):
                    nonlocal sent_chunks
                    nonlocal stream_started

                    send_budget = max(0.0, float(cfg.send_budget_seconds))
                    budget_start_ts = time.monotonic()

                    chunk = initial_chunk
                    while not stop_event.is_set():
                        if chunk is None:
                            if stream_end_event.is_set():
                                raise NoAudioTimeout("audio stream ended; closing ASR link")
                            audio_task = asyncio.create_task(audio_queue.get())
                            end_task = asyncio.create_task(stream_end_event.wait())
                            done, pending = await asyncio.wait(
                                {audio_task, end_task},
                                timeout=stop_timeout,
                                return_when=asyncio.FIRST_COMPLETED,
                            )
                            for task in pending:
                                task.cancel()
                            await asyncio.gather(*pending, return_exceptions=True)
                            if not done:
                                raise NoAudioTimeout("audio signal stopped; closing ASR link")
                            if end_task in done:
                                raise NoAudioTimeout("audio stream ended; closing ASR link")
                            chunk = audio_task.result()
                        await ws.send(chunk)
                        stream_started = True
                        sent_chunks += 1
                        if debug_mode:
                            logger.info("asr-link: sent chunk #%d (%d bytes)", sent_chunks, len(chunk))
                        chunk = None
                        # ---- budget check & yield ----
                        now = time.monotonic()
                        if now - budget_start_ts >= send_budget:
                            # 強制讓出 event loop，讓 receiver / other tasks 跑
                            await asyncio.sleep(0)
                            budget_start_ts = time.monotonic()

                async def receiver():
                    nonlocal ready_to_stop_seen, last_status, last_caption
                    last_translation = None
                    async for message in ws:
                        try:
                            payload = json.loads(message)
                        except json.JSONDecodeError:
                            logger.warning("non-json message from ASR dropped")
                            continue
                        payload.setdefault("ts", datetime.now(timezone.utc).isoformat())
                        if payload.get("type") == "ready_to_stop":
                            ready_to_stop_seen = True
                            if debug_mode:
                                logger.info("ASR ready_to_stop received")
                            else:
                                await broadcaster.broadcast(payload)
                            break
                        if debug_mode:
                            logger.info("ASR result: %s", payload)
                            continue

                        if payload.get("type") in {"caption", "status"}:
                            await broadcaster.broadcast(payload)
                            continue

                        status = payload.get("status")
                        if status and status != last_status:
                            await broadcaster.broadcast(
                                {
                                    "type": "status",
                                    "state": status,
                                    "detail": status,
                                    "ts": payload["ts"],
                                }
                            )
                            last_status = status

                        lines = payload.get("lines") or []
                        line_text = ""
                        line_translation = ""
                        if isinstance(lines, list):
                            for line in reversed(lines):
                                if not isinstance(line, dict):
                                    continue
                                candidate = (line.get("text") or "").strip()
                                if candidate and not line_text:
                                    line_text = candidate
                                candidate_tr = (line.get("translation") or line.get("text_translation") or "").strip()
                                if candidate_tr and not line_translation:
                                    line_translation = candidate_tr
                                if line_text and line_translation:
                                    break
                        buffer_text = (payload.get("buffer_transcription") or "").strip()
                        text = " ".join(part for part in (line_text, buffer_text) if part).strip()
                        if text:
                            partial = bool(buffer_text)
                            caption_key = (text, partial)
                            if caption_key != last_caption:
                                await broadcaster.broadcast(
                                    {
                                        "type": "caption",
                                        "text": text,
                                        "partial": partial,
                                        "ts": payload["ts"],
                                    }
                                )
                                last_caption = caption_key

                        buffer_tr = (payload.get("buffer_translation") or "").strip()
                        tr_text = " ".join(part for part in (line_translation, buffer_tr) if part).strip()
                        if tr_text:
                            tr_partial = bool(buffer_tr)
                            tr_key = (tr_text, tr_partial)
                            if tr_key != last_translation:
                                await broadcaster.broadcast(
                                    {
                                        "type": "caption_translation",
                                        "text": tr_text,
                                        "partial": tr_partial,
                                        "ts": payload["ts"],
                                    }
                                )
                                last_translation = tr_key

                sender_task = asyncio.create_task(sender(first_chunk))
                receiver_task = asyncio.create_task(receiver())
                done, pending = await asyncio.wait(
                    {sender_task, receiver_task},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for task in pending:
                    task.cancel()
                await asyncio.gather(*pending, return_exceptions=True)
                for task in done:
                    if task.exception():
                        raise task.exception()
        except asyncio.CancelledError:
            # Shutdown path; let outer finally close the websocket if still open.
            raise
        except NoAudioTimeout as exc:
            if debug_mode:
                logger.info("asr-link: %s", exc)
            backoff = 1
            pending_chunk = None
            clear_audio_queue(audio_queue)
            continue
        except (
            websockets.exceptions.ConnectionClosedError,
            ConnectionRefusedError,
        ) as exc:
            # Treat "ASR went away" as a normal session end:
            # clear buffered audio and return to the "waiting for audio" state.
            #
            # This is especially important when streaming WebM/Opus: reconnecting
            # with a mid-stream chunk (missing container headers) commonly fails.
            logger.exception("ASR disconnected: %s", exc)
            await broadcaster.broadcast_status("waiting", f"ASR disconnected: {exc}")
            backoff = 1
            pending_chunk = None
            clear_audio_queue(audio_queue)
            # Restart ffmpeg so the next chunk begins with fresh container headers.
            restart_ingest_event.set()
            # Small delay to avoid a tight reconnect loop while ASR is down.
            await asyncio.sleep(1)
            continue
        except Exception as exc:  # noqa: BLE001
            logger.exception("ASR link failed: %s", exc)
            await broadcaster.broadcast_status("error", f"ASR link failed: {exc}")
            await asyncio.sleep(min(backoff, cfg.max_backoff_seconds))
            backoff = min(backoff * 2, cfg.max_backoff_seconds)
        finally:
            try:
                if ws is not None and not ws.closed:
                    if (stop_event.is_set() or stream_started) and not ready_to_stop_seen:
                        await graceful_stop(ws)
                    await ws.close()
            except Exception:
                pass
        if stop_event.is_set():
            break


def create_app(cfg: RelayConfig, debug_mode: bool = False) -> FastAPI:
    broadcaster = SubtitleBroadcaster()
    audio_queue = AudioQueue()
    fmt_controller = FormatController("webm")
    stop_event = asyncio.Event()
    stream_end_event = asyncio.Event()
    restart_ingest_event = asyncio.Event()
    ssl_context = build_ssl_context(cfg.cert)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.ffmpeg_task = asyncio.create_task(
            ffmpeg_reader(
                cfg,
                audio_queue,
                fmt_controller,
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


def main():
    parser = argparse.ArgumentParser(description="LiveCaption relay service")
    parser.add_argument("--debug", action="store_true", help="Print ASR results to stdout and do not forward to frontend")
    args = parser.parse_args()

    cfg = load_config()
    app = create_app(cfg, debug_mode=args.debug)
    uvicorn.run(app, host=cfg.host, port=cfg.port, log_level="info")


if __name__ == "__main__":
    # Handle ctrl+c gracefully for local runs
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, loop.stop)
    main()
