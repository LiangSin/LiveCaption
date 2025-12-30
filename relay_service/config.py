import os
from dataclasses import dataclass


def _env(key: str, default: str | None = None, cast=None):
    raw = os.getenv(key, default)
    if cast and raw is not None:
        try:
            return cast(raw)
        except Exception:
            return default
    return raw


@dataclass
class RelayConfig:
    rtmp_url: str = _env("RTMP_URL", "rtmp://localhost/live")
    asr_ws_url: str = _env("ASR_WS_URL", "ws://127.0.0.1:9001/asr")
    host: str = _env("RELAY_HOST", "0.0.0.0")
    port: int = _env("RELAY_PORT", cast=int, default=9000)
    chunk_ms: int = _env("CHUNK_MS", cast=int, default=500)
    sample_rate: int = _env("SAMPLE_RATE", cast=int, default=16000)
    max_backoff_seconds: int = _env("MAX_BACKOFF_SECONDS", cast=int, default=30)
    # How long we tolerate missing audio before signaling stream end and closing the ASR link.
    stop_timeout_seconds: int = _env("STOP_TIMEOUT_SECONDS", cast=int, default=10)
    # Bitrate for opus when using webm.
    asr_audio_bitrate: str = _env("ASR_AUDIO_BITRATE", default="32k")
    cert: str | None = _env("CERT")


def load_config() -> RelayConfig:
    return RelayConfig()
