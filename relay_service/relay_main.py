import asyncio
import argparse
import logging
import os
import signal
import sys

import uvicorn

from .app import create_app
from .config import load_config

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | relay | %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger("relay")


def main():
    parser = argparse.ArgumentParser(description="LiveCaption relay service")
    parser.add_argument("--debug", action="store_true", help="Print ASR results to stdout and do not forward to frontend")
    args = parser.parse_args()

    cfg = load_config()
    app = create_app(cfg, debug_mode=args.debug)
    # Enable wss:// (secure RELAY_WS_URL) when cert/key are available.
    # - local run: ./ssl-config/{cert,key}.pem
    # - docker:    /app/ssl-config/{cert,key}.pem (copied in Dockerfile)
    cert_path = os.getenv("RELAY_TLS_CERTFILE") or "ssl-config/cert.pem"
    key_path = os.getenv("RELAY_TLS_KEYFILE") or "ssl-config/key.pem"
    use_tls = os.getenv("RELAY_ENABLE_TLS", "1").lower() in {"1", "true", "yes", "y"}
    ssl_kwargs = {}
    if use_tls and os.path.exists(cert_path) and os.path.exists(key_path):
        ssl_kwargs = {"ssl_certfile": cert_path, "ssl_keyfile": key_path}
        logger.info("relay TLS enabled (cert=%s, key=%s)", cert_path, key_path)
    elif use_tls:
        logger.warning("relay TLS requested but cert/key not found (cert=%s, key=%s); starting without TLS", cert_path, key_path)

    uvicorn.run(app, host=cfg.host, port=cfg.port, log_level="info", **ssl_kwargs)


if __name__ == "__main__":
    # Handle ctrl+c gracefully for local runs
    loop = asyncio.get_event_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, loop.stop)
    main()
