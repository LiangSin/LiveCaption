from __future__ import annotations

import asyncio
import logging
import time
from typing import TYPE_CHECKING

from .audio import AudioQueue, FormatController, IngestEpoch
from .config import RelayConfig

if TYPE_CHECKING:
    from .app import SubtitleBroadcaster

logger = logging.getLogger("relay")


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


async def ffmpeg_reader(
    cfg: RelayConfig,
    audio_queue: AudioQueue,
    fmt_controller: FormatController,
    ingest_epoch: IngestEpoch,
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
        epoch = await ingest_epoch.bump()
        last_data_ts = time.monotonic()
        next_idle_log = last_data_ts + idle_log_interval
        await broadcaster.broadcast_status("running", "ffmpeg ingest active")
        logger.info("ffmpeg ingest epoch=%d", epoch)
        skip_sleep = False

        try:
            assert process.stdout is not None
            while not stop_event.is_set():
                if restart_ingest_event.is_set():
                    restart_ingest_event.clear()
                    logger.info("ffmpeg ingest restart requested; restarting to reset stream headers")
                    skip_sleep = True
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
                await audio_queue.put((epoch, chunk))
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
            if not skip_sleep:
                await asyncio.sleep(min(backoff, cfg.max_backoff_seconds))
                backoff = min(backoff * 2, cfg.max_backoff_seconds)
            else:
                backoff = 1
