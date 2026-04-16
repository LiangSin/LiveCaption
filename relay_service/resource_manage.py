import asyncio
import logging
import re
import ssl
from enum import Enum

from .app import SubtitleBroadcaster
from .asr_link import asr_link
from .audio import AudioQueue, FormatController, IngestEpoch
from .config import RelayConfig
from .ffmpeg_ingest import ffmpeg_reader

logger = logging.getLogger("relay")

# Keys appear in RTMP paths, URLs, and log lines. Keep them URL-safe and bounded.
KEY_RE = re.compile(r"^[a-zA-Z0-9_-]{1,64}$")


class InvalidKeyError(ValueError):
    """Raised when the caller supplies a malformed session key."""


class DuplicateKeyError(Exception):
    """Raised when /register receives a key that already has a live session."""


def validate_key(key: str) -> None:
    if not isinstance(key, str) or not KEY_RE.match(key):
        raise InvalidKeyError(f"invalid key format: {key!r}")


class SessionState(Enum):
    CREATED = "created"
    RUNNING = "running"
    TERMINATING = "terminating"
    TERMINATED = "terminated"


class StreamSession:
    """One isolated caption pipeline for a single source key.

    Owns its own broadcaster, audio queue, coordination events, and three
    background tasks: ffmpeg ingest, ASR link, and an idle watchdog that
    self-destructs the session after IDLE_TERMINATION_SECONDS of no audio.
    """

    IDLE_TERMINATION_SECONDS: float = 60.0
    _IDLE_POLL_SECONDS: float = 0.5

    def __init__(
        self,
        key: str,
        cfg: RelayConfig,
        ssl_context: ssl.SSLContext | None,
        debug_mode: bool,
        manager: "SessionManager",
    ):
        self.key = key
        self.cfg = cfg
        self.ssl_context = ssl_context
        self.debug_mode = debug_mode
        self._manager = manager

        self.broadcaster = SubtitleBroadcaster()
        self.audio_queue = AudioQueue()
        self.fmt_controller = FormatController("webm")
        self.ingest_epoch = IngestEpoch()
        self.stop_event = asyncio.Event()
        self.stream_end_event = asyncio.Event()
        self.restart_ingest_event = asyncio.Event()

        self.ffmpeg_task: asyncio.Task | None = None
        self.asr_task: asyncio.Task | None = None
        self.watchdog_task: asyncio.Task | None = None

        self.state: SessionState = SessionState.CREATED

    @property
    def rtmp_url(self) -> str:
        return f"{self.cfg.rtmp_url}/{self.key}"

    async def start(self) -> None:
        if self.state is not SessionState.CREATED:
            raise RuntimeError(f"session {self.key} already started (state={self.state})")
        await self.broadcaster.broadcast_asr_status("disconnected", "initial")
        self.ffmpeg_task = asyncio.create_task(
            ffmpeg_reader(
                self.cfg,
                self.audio_queue,
                self.fmt_controller,
                self.ingest_epoch,
                self.stop_event,
                self.broadcaster,
                self.stream_end_event,
                self.restart_ingest_event,
                debug_mode=self.debug_mode,
                rtmp_url=self.rtmp_url,
            ),
            name=f"ffmpeg[{self.key}]",
        )
        self.asr_task = asyncio.create_task(
            asr_link(
                self.cfg,
                self.audio_queue,
                self.fmt_controller,
                self.ingest_epoch,
                self.broadcaster,
                self.stop_event,
                self.stream_end_event,
                self.restart_ingest_event,
                self.debug_mode,
                self.ssl_context,
            ),
            name=f"asr[{self.key}]",
        )
        self.watchdog_task = asyncio.create_task(
            self._watchdog(),
            name=f"watchdog[{self.key}]",
        )
        self.state = SessionState.RUNNING
        logger.info("session started: %s (rtmp=%s)", self.key, self.rtmp_url)

    async def terminate(self, reason: str = "terminated") -> None:
        """Idempotent shutdown: stop tasks, close WS clients, mark TERMINATED."""
        if self.state in (SessionState.TERMINATING, SessionState.TERMINATED):
            return
        self.state = SessionState.TERMINATING
        logger.info("session terminating: %s (%s)", self.key, reason)

        try:
            await self.broadcaster.broadcast_status("terminated", reason)
        except Exception as exc:  # noqa: BLE001
            logger.warning("final broadcast failed for %s: %s", self.key, exc)
        await self.broadcaster.close_all(code=1012)

        self.stop_event.set()
        tasks = [t for t in (self.ffmpeg_task, self.asr_task, self.watchdog_task) if t]
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self.state = SessionState.TERMINATED
        logger.info("session terminated: %s", self.key)

    async def _watchdog(self) -> None:
        """Kill the session after stream_end_event stays set for IDLE_TERMINATION_SECONDS.

        ffmpeg_reader sets stream_end_event on idle (stop_timeout_seconds, default 10s)
        and clears it the moment new audio arrives. We treat "event continuously set
        for 60s" as "the publisher is gone; reclaim resources".
        """
        try:
            while not self.stop_event.is_set():
                await self.stream_end_event.wait()
                logger.info(
                    "session %s: idle detected; terminate in %.0fs if audio does not resume",
                    self.key,
                    self.IDLE_TERMINATION_SECONDS,
                )
                elapsed = 0.0
                next_progress_log = 10.0
                while (
                    not self.stop_event.is_set()
                    and self.stream_end_event.is_set()
                    and elapsed < self.IDLE_TERMINATION_SECONDS
                ):
                    await asyncio.sleep(self._IDLE_POLL_SECONDS)
                    elapsed += self._IDLE_POLL_SECONDS
                    if elapsed >= next_progress_log:
                        logger.info(
                            "session %s: idle %.0fs / %.0fs",
                            self.key,
                            elapsed,
                            self.IDLE_TERMINATION_SECONDS,
                        )
                        next_progress_log += 10.0
                if self.stop_event.is_set():
                    return
                if self.stream_end_event.is_set():
                    logger.info(
                        "session %s idle for %.0fs; scheduling terminate",
                        self.key,
                        self.IDLE_TERMINATION_SECONDS,
                    )
                    # Delegate to manager so the registry entry is also removed.
                    asyncio.create_task(
                        self._manager.terminate(self.key, reason="idle timeout")
                    )
                    return
                # Event cleared: audio resumed. Outer loop resets elapsed to 0.
                logger.info(
                    "session %s: audio resumed after %.0fs; idle counter reset",
                    self.key,
                    elapsed,
                )
        except asyncio.CancelledError:
            raise


class SessionManager:
    """Registry of active StreamSessions keyed by source name."""

    _SHUTDOWN_TIMEOUT_SECONDS: float = 15.0

    def __init__(
        self,
        cfg: RelayConfig,
        ssl_context: ssl.SSLContext | None,
        debug_mode: bool,
    ):
        self.cfg = cfg
        self.ssl_context = ssl_context
        self.debug_mode = debug_mode
        self._sessions: dict[str, StreamSession] = {}
        self._lock = asyncio.Lock()

    async def register(self, key: str) -> StreamSession:
        validate_key(key)
        async with self._lock:
            if key in self._sessions:
                raise DuplicateKeyError(f"session already registered: {key}")
            session = StreamSession(
                key=key,
                cfg=self.cfg,
                ssl_context=self.ssl_context,
                debug_mode=self.debug_mode,
                manager=self,
            )
            self._sessions[key] = session
        # Start outside the lock so task creation doesn't block other register calls.
        try:
            await session.start()
        except Exception:
            async with self._lock:
                self._sessions.pop(key, None)
            raise
        return session

    def get(self, key: str) -> StreamSession | None:
        return self._sessions.get(key)

    async def terminate(self, key: str, reason: str = "terminated") -> None:
        async with self._lock:
            session = self._sessions.pop(key, None)
        if session is not None:
            await session.terminate(reason)

    async def shutdown_all(self) -> None:
        async with self._lock:
            sessions = list(self._sessions.values())
            self._sessions.clear()
        if not sessions:
            return
        try:
            await asyncio.wait_for(
                asyncio.gather(
                    *(s.terminate(reason="relay shutting down") for s in sessions),
                    return_exceptions=True,
                ),
                timeout=self._SHUTDOWN_TIMEOUT_SECONDS,
            )
        except asyncio.TimeoutError:
            logger.warning(
                "shutdown_all exceeded %.0fs; some sessions may not have cleaned up cleanly",
                self._SHUTDOWN_TIMEOUT_SECONDS,
            )
