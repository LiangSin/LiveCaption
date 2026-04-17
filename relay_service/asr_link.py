from __future__ import annotations

import asyncio
import json
import logging
import ssl
import time
from datetime import datetime, timezone
from typing import TYPE_CHECKING

import websockets

from .audio import (
    AudioQueue,
    FormatController,
    IngestEpoch,
    NoAudioTimeout,
    clear_audio_queue,
)
from .config import RelayConfig

if TYPE_CHECKING:
    from .app import SubtitleBroadcaster

logger = logging.getLogger("relay")


async def asr_link(
    cfg: RelayConfig,
    audio_queue: AudioQueue,
    fmt_controller: FormatController,
    ingest_epoch: IngestEpoch,
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
    pending_item: tuple[int, bytes] | None = None
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

    async def reset_to_initial_state(reason: str, restart_ingest: bool) -> None:
        """
        Reset link state as if we never connected to ASR.

        - Drop any pending audio (mid-stream chunks are unsafe after reconnects).
        - Clear audio queue to force a clean start.
        - Optionally restart ffmpeg ingest so the next audio begins with fresh headers.
        """
        nonlocal pending_item
        if debug_mode:
            logger.info("asr-link reset: %s (restart_ingest=%s)", reason, restart_ingest)
        pending_item = None
        clear_audio_queue(audio_queue)
        # Return to initial controller state; ASR config will set it again on connect.
        fmt_controller.set("webm")
        # Make sure "stream ended" doesn't pin us into a closed state after a disconnect.
        if stream_end_event.is_set():
            stream_end_event.clear()
        if restart_ingest:
            restart_ingest_event.set()
    while not stop_event.is_set():
        ws = None
        stream_started = False
        ready_to_stop_seen = False
        # Wait for audio before attempting to open the ASR link. This avoids
        # connecting with an empty stream, which some ASR backends treat as an
        # error/timeout.
        if pending_item is None:
            pending_item = await audio_queue.get()
            if debug_mode:
                logger.info("asr-link: first audio chunk ready (%d bytes)", len(pending_item[1]))

        try:
            logger.info("connecting to ASR at %s", cfg.asr_ws_url)
            await broadcaster.broadcast_asr_status("connecting", "connecting to ASR backend")
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
                await broadcaster.broadcast_asr_status("connected", "ASR backend connected")
                backoff = 1
                # For WebM, force fresh container headers for every ASR connection.
                # Reconnecting with mid-stream WebM chunks (missing init headers) commonly fails.
                if fmt == "webm":
                    prev_epoch = await ingest_epoch.get()
                    restart_ingest_event.set()
                    try:
                        await ingest_epoch.wait_for_change(prev_epoch, timeout=5.0)
                    except asyncio.TimeoutError:
                        logger.warning("ffmpeg ingest restart did not complete within 5s; proceeding anyway")
                    clear_audio_queue(audio_queue)
                    pending_item = None

                if pending_item is None:
                    pending_item = await audio_queue.get()
                _, first_chunk = pending_item
                pending_item = None
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
                            _, chunk = audio_task.result()
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

                        if payload.get("type") == "status":
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

                        raw_lines = payload.get("lines") or []
                        normalized_lines = []
                        if isinstance(raw_lines, list):
                            for line in raw_lines:
                                if isinstance(line, str):
                                    original = line.strip()
                                    translation = ""
                                elif isinstance(line, dict):
                                    original = (
                                        line.get("original")
                                        or line.get("text")
                                        or line.get("caption")
                                        or line.get("source")
                                        or ""
                                    ).strip()
                                    translation = (
                                        line.get("translation")
                                        or line.get("text_translation")
                                        or line.get("translated")
                                        or ""
                                    ).strip()
                                else:
                                    continue
                                if not original and not translation:
                                    continue
                                normalized_lines.append(
                                    {
                                        "text": original,
                                        "translation": translation,
                                    }
                                )

                        buffer_text = (payload.get("buffer_transcription") or "").strip()
                        buffer_translation = (payload.get("buffer_translation") or "").strip()
                        if buffer_text or buffer_translation:
                            normalized_lines.append(
                                {
                                    "text": buffer_text,
                                    "translation": buffer_translation,
                                }
                            )

                        # Keep only latest 30 items for frontend rendering.
                        normalized_lines = normalized_lines[-30:]
                        if normalized_lines:
                            partial = bool(buffer_text or buffer_translation)
                            latest = normalized_lines[-1]
                            caption_key = (
                                json.dumps(normalized_lines, ensure_ascii=False, sort_keys=True),
                                partial,
                            )
                            if caption_key != last_caption:
                                await broadcaster.broadcast(
                                    {
                                        "type": "caption",
                                        "lines": normalized_lines,
                                        "text": latest.get("text", ""),
                                        "translation": latest.get("translation", ""),
                                        "partial": partial,
                                        "ts": payload["ts"],
                                    }
                                )
                                last_caption = caption_key

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
            await broadcaster.broadcast_asr_status("disconnected", "ASR link closed (no audio)")
            await reset_to_initial_state(str(exc), restart_ingest=False)
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
            await broadcaster.broadcast_asr_status("disconnected", f"ASR disconnected: {exc}")
            backoff = 1
            # Reset as if we never connected, and restart ingest so next audio begins
            # with fresh headers for the new ASR connection.
            await reset_to_initial_state(f"ASR disconnected: {exc}", restart_ingest=True)
            # Small delay to avoid a tight reconnect loop while ASR is down.
            await asyncio.sleep(1)
            continue
        except Exception as exc:  # noqa: BLE001
            logger.exception("ASR link failed: %s", exc)
            await broadcaster.broadcast_status("error", f"ASR link failed: {exc}")
            await broadcaster.broadcast_asr_status("error", f"ASR link error: {exc}")
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
