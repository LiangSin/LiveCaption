import asyncio
import logging

logger = logging.getLogger("relay")


class NoAudioTimeout(Exception):
    """Raised when audio input stalls long enough to drop the ASR link."""


class AudioQueue:
    """Bounded queue to avoid unbounded memory growth."""

    def __init__(self, max_chunks: int = 100):
        # Each item is (ingest_epoch, chunk). Epoch increments every time ffmpeg restarts,
        # so downstream can reliably detect fresh container headers after reconnects.
        self.queue: asyncio.Queue[tuple[int, bytes]] = asyncio.Queue(maxsize=max_chunks)
        self._dropped = 0

    async def put(self, item: tuple[int, bytes]):
        try:
            self.queue.put_nowait(item)
        except asyncio.QueueFull:
            self._dropped += 1
            if self._dropped % 50 == 1:
                logger.warning("audio queue full; dropping chunks (dropped=%d)", self._dropped)

    async def get(self):
        return await self.queue.get()


class IngestEpoch:
    """Monotonically increasing epoch; bumps whenever ffmpeg (re)starts."""

    def __init__(self) -> None:
        self._value = 0
        self._cond = asyncio.Condition()

    async def get(self) -> int:
        async with self._cond:
            return self._value

    async def bump(self) -> int:
        async with self._cond:
            self._value += 1
            self._cond.notify_all()
            return self._value

    async def wait_for_change(self, prev: int, timeout: float | None = None) -> int:
        async def _wait() -> int:
            async with self._cond:
                await self._cond.wait_for(lambda: self._value != prev)
                return self._value

        if timeout is None:
            return await _wait()
        return await asyncio.wait_for(_wait(), timeout=timeout)


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


def clear_audio_queue(audio_queue: AudioQueue):
    # Clear queue
    try:
        while True:
            audio_queue.queue.get_nowait()
    except asyncio.QueueEmpty:
        pass
