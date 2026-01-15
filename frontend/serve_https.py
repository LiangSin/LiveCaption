#!/usr/bin/env python3
"""
Minimal HTTPS static server for the frontend.

- Serves the current directory (frontend/) over HTTPS.
- Uses provided cert/key files.
"""

from __future__ import annotations

import argparse
import os
import ssl
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any


def _default_cert_paths() -> tuple[str, str]:
    # Common locations:
    # - local run: <repo>/ssl-config/{cert,key}.pem
    # - docker:    mounted at /ssl-config/{cert,key}.pem
    here = Path(__file__).resolve()
    repo_root = here.parent.parent
    local_cert = repo_root / "ssl-config" / "cert.pem"
    local_key = repo_root / "ssl-config" / "key.pem"
    docker_cert = Path("/ssl-config/cert.pem")
    docker_key = Path("/ssl-config/key.pem")

    cert = os.getenv("SSL_CERT_FILE") or (str(docker_cert) if docker_cert.exists() else str(local_cert))
    key = os.getenv("SSL_KEY_FILE") or (str(docker_key) if docker_key.exists() else str(local_key))
    return cert, key


class _TLSRequestHandler(SimpleHTTPRequestHandler):
    """
    Do TLS handshake in the per-request thread, not the main accept loop.

    This avoids the whole server getting stuck if a client connects but never
    completes the TLS handshake (common with scanners / half-open connections
    on public IPs).
    """

    def setup(self) -> None:
        # StreamRequestHandler.setup(), inlined so we can handshake first.
        self.connection = self.request  # type: ignore[assignment]

        # Handshake can block forever on a bad client; bound it.
        timeout = getattr(self.server, "tls_handshake_timeout", 5.0)  # type: ignore[attr-defined]
        if isinstance(self.connection, ssl.SSLSocket):
            self.connection.settimeout(timeout)
            try:
                self.connection.do_handshake()
            finally:
                # After handshake, allow normal blocking IO for serving files.
                self.connection.settimeout(None)

        self.rfile = self.connection.makefile("rb", self.rbufsize)
        self.wfile = self.connection.makefile("wb", self.wbufsize)


class _TLSHTTPServer(ThreadingHTTPServer):
    # If a client stalls, don't keep the process alive at shutdown.
    daemon_threads = True

    def __init__(
        self,
        server_address: tuple[str, int],
        RequestHandlerClass: type[SimpleHTTPRequestHandler],
        ssl_context: ssl.SSLContext,
        tls_handshake_timeout: float,
    ) -> None:
        super().__init__(server_address, RequestHandlerClass)
        self.ssl_context = ssl_context
        self.tls_handshake_timeout = tls_handshake_timeout

    def get_request(self) -> tuple[Any, tuple[str, int]]:
        sock, addr = super().get_request()
        # Wrap without handshaking; handshake happens in the handler thread.
        tls_sock = self.ssl_context.wrap_socket(
            sock,
            server_side=True,
            do_handshake_on_connect=False,
        )
        return tls_sock, addr


def main() -> None:
    cert_default, key_default = _default_cert_paths()

    p = argparse.ArgumentParser(description="Serve static frontend over HTTPS")
    p.add_argument("--bind", default=os.getenv("FRONTEND_HOST", "0.0.0.0"))
    p.add_argument("--port", type=int, default=int(os.getenv("FRONTEND_PORT", "8088")))
    p.add_argument("--cert", default=cert_default)
    p.add_argument("--key", default=key_default)
    p.add_argument(
        "--tls-handshake-timeout",
        type=float,
        default=float(os.getenv("TLS_HANDSHAKE_TIMEOUT_SECONDS", "5")),
        help="Timeout (seconds) for TLS handshake per connection.",
    )
    args = p.parse_args()

    cert_path = Path(args.cert)
    key_path = Path(args.key)
    if not cert_path.exists():
        raise SystemExit(f"[frontend https] cert not found: {cert_path}")
    if not key_path.exists():
        raise SystemExit(f"[frontend https] key not found: {key_path}")

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=str(cert_path), keyfile=str(key_path))
    httpd = _TLSHTTPServer(
        (args.bind, args.port),
        _TLSRequestHandler,
        ssl_context=ctx,
        tls_handshake_timeout=args.tls_handshake_timeout,
    )

    print(
        f"[frontend https] serving on https://{args.bind}:{args.port} "
        f"(cert={cert_path}, tls_handshake_timeout={args.tls_handshake_timeout}s)",
        flush=True,
    )
    httpd.serve_forever()


if __name__ == "__main__":
    main()

