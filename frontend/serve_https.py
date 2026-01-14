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


def main() -> None:
    cert_default, key_default = _default_cert_paths()

    p = argparse.ArgumentParser(description="Serve static frontend over HTTPS")
    p.add_argument("--bind", default=os.getenv("FRONTEND_HOST", "0.0.0.0"))
    p.add_argument("--port", type=int, default=int(os.getenv("FRONTEND_PORT", "8088")))
    p.add_argument("--cert", default=cert_default)
    p.add_argument("--key", default=key_default)
    args = p.parse_args()

    cert_path = Path(args.cert)
    key_path = Path(args.key)
    if not cert_path.exists():
        raise SystemExit(f"[frontend https] cert not found: {cert_path}")
    if not key_path.exists():
        raise SystemExit(f"[frontend https] key not found: {key_path}")

    httpd = ThreadingHTTPServer((args.bind, args.port), SimpleHTTPRequestHandler)

    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(certfile=str(cert_path), keyfile=str(key_path))
    httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)

    print(f"[frontend https] serving on https://{args.bind}:{args.port} (cert={cert_path})", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()

