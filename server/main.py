"""PRO TAG server entry point.

One port serves BOTH the game files (HTTP) and the multiplayer WebSocket endpoint (/ws).
Only the Python standard library is used - no pip install needed.

    python server/main.py                 # http://localhost:8080
    python server/main.py --port 9000
    python server/main.py --host 0.0.0.0  # allow other computers on your LAN to join
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import mimetypes
import os
import posixpath
import socket
import sys
from urllib.parse import unquote, urlsplit

if __package__ in (None, ""):
    # allow "python server/main.py" as well as "python -m server.main"
    sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    __package__ = "server"  # noqa: A001

from server.config import CONFIG, ROOT  # noqa: E402
from server.game_server import GameServer  # noqa: E402
from server.websocket import WebSocket, handshake_response  # noqa: E402

log = logging.getLogger("protag")

# Only these top-level paths are served; server code, tools and VCS files never are.
PUBLIC = ("index.html", "src/", "vendor/", "assets/", "config/game.json", "tests/browser/", "tests/shared/")
TYPES = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".ogg": "audio/ogg",
    ".mp3": "audio/mpeg",
    ".wasm": "application/wasm",
    ".ico": "image/x-icon",
}


async def read_head(reader: asyncio.StreamReader):
    data = await reader.readuntil(b"\r\n\r\n")
    if len(data) > 16384:
        raise ValueError("header too large")
    lines = data.decode("latin-1").split("\r\n")
    method, target, _ = lines[0].split(" ", 2)
    headers = {}
    for line in lines[1:]:
        if ":" in line:
            k, v = line.split(":", 1)
            headers[k.strip().lower()] = v.strip()
    return method, target, headers


def resolve(path: str):
    raw = unquote(urlsplit(path).path)
    if "\\" in raw or chr(0) in raw:
        return None
    rel = raw.lstrip("/") or "index.html"
    if rel.endswith("/"):
        rel += "index.html"
    # normalise BEFORE the whitelist check so "src/../server/x.py" cannot sneak through
    rel = posixpath.normpath(rel)
    if rel.startswith("..") or rel.startswith("/"):
        return None
    if not any(rel == p or rel.startswith(p) for p in PUBLIC):
        return None
    full = os.path.realpath(os.path.join(ROOT, rel))
    if not full.startswith(os.path.realpath(ROOT) + os.sep) or not os.path.isfile(full):
        return None
    return full


async def respond(writer, status: str, body: bytes, ctype="text/plain; charset=utf-8", head=False, extra=""):
    hdr = (
        f"HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {len(body)}\r\n"
        f"Cache-Control: no-cache\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n{extra}\r\n"
    ).encode()
    writer.write(hdr if head else hdr + body)
    await writer.drain()


def make_handler(game: GameServer):
    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter):
        try:
            method, target, headers = await asyncio.wait_for(read_head(reader), timeout=10)
        except Exception:  # noqa: BLE001 - malformed / slow request
            writer.close()
            return
        try:
            if urlsplit(target).path == "/healthz":  # health check for cloud hosts
                await respond(writer, "200 OK", b"ok", head=method == "HEAD")
                return
            if urlsplit(target).path == "/ws":
                resp = handshake_response(headers)
                if not resp:
                    await respond(writer, "400 Bad Request", b"WebSocket upgrade required")
                    writer.close()
                    return
                writer.write(resp)
                await writer.drain()
                await game.handle(WebSocket(reader, writer))
                return
            if method not in ("GET", "HEAD"):
                await respond(writer, "405 Method Not Allowed", b"Method not allowed", extra="Allow: GET, HEAD\r\n")
            else:
                full = resolve(target)
                if not full:
                    await respond(writer, "404 Not Found", b"Not found", head=method == "HEAD")
                else:
                    ext = os.path.splitext(full)[1].lower()
                    ctype = TYPES.get(ext) or mimetypes.guess_type(full)[0] or "application/octet-stream"
                    with open(full, "rb") as f:
                        body = f.read()
                    await respond(writer, "200 OK", body, ctype, head=method == "HEAD")
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        except Exception:  # noqa: BLE001
            log.exception("request failed: %s %s", method, target)
        finally:
            try:
                writer.close()
            except Exception:  # noqa: BLE001
                pass

    return handle


def lan_addresses():
    addrs = set()
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ip = info[4][0]
            if not ip.startswith("127."):
                addrs.add(ip)
    except OSError:
        pass
    return sorted(addrs)


def detect_public_url(env=os.environ):
    """Public https address when running on a cloud host (or set explicitly)."""
    if env.get("PROTAG_PUBLIC_URL"):
        return env["PROTAG_PUBLIC_URL"]
    if env.get("RENDER_EXTERNAL_URL"):  # Render
        return env["RENDER_EXTERNAL_URL"]
    if env.get("RAILWAY_PUBLIC_DOMAIN"):  # Railway
        return f"https://{env['RAILWAY_PUBLIC_DOMAIN']}"
    if env.get("FLY_APP_NAME"):  # Fly.io
        return f"https://{env['FLY_APP_NAME']}.fly.dev"
    if env.get("KOYEB_PUBLIC_DOMAIN"):  # Koyeb
        return f"https://{env['KOYEB_PUBLIC_DOMAIN']}"
    return None


def share_addresses(host: str, port: int, public_url: str | None):
    """Addresses friends can use; the client turns these into invite links.
    A public (internet) address wins; LAN addresses are only offered when there is none."""
    if public_url:
        return [public_url.rstrip("/")]
    if host in ("0.0.0.0", "::"):
        return [f"http://{ip}:{port}" for ip in lan_addresses()]
    if host not in ("127.0.0.1", "localhost", "::1"):
        return [f"http://{host}:{port}"]
    return []


async def serve(host: str, port: int, public_url: str | None = None):
    share = share_addresses(host, port, public_url)
    game = GameServer(CONFIG, share_urls=share)
    loop = asyncio.get_running_loop()

    def quiet_resets(lp, ctx):
        # Windows logs a traceback whenever a browser tab closes its socket abruptly; that is normal
        if isinstance(ctx.get("exception"), (ConnectionResetError, ConnectionAbortedError)):
            return
        lp.default_exception_handler(ctx)

    loop.set_exception_handler(quiet_resets)
    server = await asyncio.start_server(make_handler(game), host, port)
    log.info("PRO TAG server running")
    print(f"\n  PRO TAG is running.  Open  http://localhost:{port}  in your browser.")
    if share:
        for url in share:
            print(f"  Friends can join at  {url}")
    else:
        print("  (Friends elsewhere? Use start-online.bat for a public link, or start-lan-server.bat on the same network)")
    print("  Press Ctrl+C to stop.\n", flush=True)
    async with server:
        await server.serve_forever()


def main(argv=None):
    ap = argparse.ArgumentParser(description="PRO TAG game + multiplayer server")
    # Cloud hosts (Render, Railway, Fly.io, Koyeb, Docker) pass the port in $PORT and must listen
    # on every interface; on a PC the default stays private to this computer.
    # Only listen on every interface when a cloud platform is detected or it is asked for
    # explicitly (PROTAG_HOST / --host): a stray $PORT on a home PC must not expose the server.
    cloud = any(k in os.environ for k in ("RENDER", "RAILWAY_ENVIRONMENT", "FLY_APP_NAME", "K_SERVICE", "KOYEB_APP_NAME", "DYNO"))
    default_host = os.environ.get("PROTAG_HOST") or ("0.0.0.0" if cloud else "127.0.0.1")
    ap.add_argument("--host", default=default_host, help="interface to bind (0.0.0.0 for LAN play)")
    ap.add_argument("--port", type=int, default=int(os.environ.get("PORT") or os.environ.get("PROTAG_PORT") or 8080))
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--public-url", default=detect_public_url(),
                    help="address friends use over the internet, e.g. https://tag.example.com (used for invite links)")
    args = ap.parse_args(argv)
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")
    try:
        asyncio.run(serve(args.host, args.port, args.public_url))
    except KeyboardInterrupt:
        print("\nServer stopped.")
    except OSError as e:
        print(f"\nCould not start the server on port {args.port}: {e}\nTry another port: python server/main.py --port 8090")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
