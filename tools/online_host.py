"""Host PRO TAG for friends anywhere on the internet - no LAN, no port forwarding, no account.

    python tools/online_host.py          (or double-click start-online.bat)

How it works: the game server runs privately on this PC (127.0.0.1 only) and Cloudflare's free
"quick tunnel" (the `cloudflared` program) gives it a temporary public https address such as
https://wild-otter-example.trycloudflare.com. Friends open that address in their browser, add
each other / join lobbies exactly as normal, and invite links automatically use the public address.

Notes
- The address changes every time you start it; the server stops when you close this window.
- Quick tunnels are a free Cloudflare service with no uptime guarantee - great for playing with
  friends; for a permanent address deploy the server instead (README: "Permanent online server").
- Only the game is exposed (the same files and /ws endpoint as on localhost) - nothing else on your PC.
"""
from __future__ import annotations

import os
import platform
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
import webbrowser

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN_DIR = os.path.join(ROOT, "tools", "bin")
URL_RE = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")
DOWNLOADS = {
    # official release assets from https://github.com/cloudflare/cloudflared/releases
    ("Windows", "AMD64"): "cloudflared-windows-amd64.exe",
    ("Windows", "x86"): "cloudflared-windows-386.exe",
    ("Windows", "ARM64"): "cloudflared-windows-amd64.exe",
    ("Linux", "x86_64"): "cloudflared-linux-amd64",
    ("Linux", "aarch64"): "cloudflared-linux-arm64",
}
RELEASE = "https://github.com/cloudflare/cloudflared/releases/latest/download/"


def find_cloudflared() -> str | None:
    """cloudflared on PATH, in tools/bin, or where winget / the MSI installer put it."""
    exe = "cloudflared.exe" if os.name == "nt" else "cloudflared"
    candidates = [shutil.which("cloudflared"), os.path.join(BIN_DIR, exe)]
    if os.name == "nt":
        local = os.environ.get("LOCALAPPDATA", "")
        candidates += [
            os.path.join(local, "Microsoft", "WinGet", "Links", exe),
            os.path.join(os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"), "cloudflared", exe),
            os.path.join(os.environ.get("ProgramFiles", r"C:\Program Files"), "cloudflared", exe),
        ]
    for c in candidates:
        if c and os.path.isfile(c):
            return c
    return None


def download_cloudflared() -> str | None:
    asset = DOWNLOADS.get((platform.system(), platform.machine()))
    if not asset:
        print("  Please install cloudflared for your system: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/")
        return None
    print("\n  PRO TAG needs Cloudflare's free tunnel program (cloudflared) to give your game a public link.")
    print(f"  Download it now from the official GitHub release ({RELEASE}{asset}, about 60 MB)")
    print("  into tools/bin/ ?  (alternative: run  winget install --id Cloudflare.cloudflared  yourself)")
    if input("  Download? [Y/n] ").strip().lower() not in ("", "y", "yes"):
        return None
    os.makedirs(BIN_DIR, exist_ok=True)
    dest = os.path.join(BIN_DIR, "cloudflared.exe" if os.name == "nt" else "cloudflared")
    tmp = dest + ".part"

    def progress(blocks, block_size, total):
        if total > 0:
            pct = min(100, blocks * block_size * 100 // total)
            print(f"\r  Downloading... {pct:3d}%", end="", flush=True)

    try:
        urllib.request.urlretrieve(RELEASE + asset, tmp, progress)
        print()
        with open(tmp, "rb") as f:
            head = f.read(4)
        if os.path.getsize(tmp) < 5_000_000 or (os.name == "nt" and head[:2] != b"MZ") or (os.name != "nt" and head != b"\x7fELF"):
            raise RuntimeError("the downloaded file does not look like the cloudflared program")
        os.replace(tmp, dest)
        if os.name != "nt":
            os.chmod(dest, 0o755)
        return dest
    except Exception as e:  # noqa: BLE001
        print(f"\n  Download failed: {e}")
        if os.path.exists(tmp):
            os.remove(tmp)
        return None


def free_port(start=8080) -> int:
    for port in range(start, start + 50):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise SystemExit("No free port between 8080 and 8130.")


def parse_tunnel_url(line: str) -> str | None:
    m = URL_RE.search(line)
    return m.group(0) if m else None


def start_tunnel(cloudflared, port: int, timeout: float = 60.0):
    """Start the quick tunnel and return (process, public_url).
    `cloudflared` is the program path (or a command list, used by the tests)."""
    cmd = list(cloudflared) if isinstance(cloudflared, (list, tuple)) else [cloudflared]
    proc = subprocess.Popen(
        cmd + ["tunnel", "--no-autoupdate", "--url", f"http://127.0.0.1:{port}"],
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    found: dict[str, str] = {}
    log: list[str] = []

    def reader():
        for line in proc.stdout:
            log.append(line.rstrip())
            url = parse_tunnel_url(line)
            if url and "url" not in found:
                found["url"] = url
        found.setdefault("ended", "1")

    threading.Thread(target=reader, daemon=True).start()
    t0 = time.time()
    while time.time() - t0 < timeout and "url" not in found and proc.poll() is None:
        time.sleep(0.2)
    if "url" not in found:
        stop_tunnel(proc)
        tail = "\n    ".join(log[-8:])
        raise RuntimeError(f"Cloudflare did not hand out a public address.\n    {tail}")
    return proc, found["url"]


def stop_tunnel(proc):
    proc.terminate()
    try:
        proc.wait(timeout=5)
    except subprocess.TimeoutExpired:
        proc.kill()
    if proc.stdout:
        proc.stdout.close()


def copy_to_clipboard(text: str):
    try:
        if os.name == "nt":
            subprocess.run("clip", input=text, text=True, check=False, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except OSError:
        pass


def main():
    print("\n  PRO TAG - play online with friends anywhere\n")
    cloudflared = find_cloudflared() or download_cloudflared()
    if not cloudflared:
        print("\n  Without cloudflared you can still play on this PC or your network (start-game.bat / start-lan-server.bat).")
        return 1
    port = free_port()
    print("  Opening a public tunnel with Cloudflare (this takes a few seconds)...")
    try:
        tunnel, url = start_tunnel(cloudflared, port)
    except RuntimeError as e:
        print(f"\n  {e}\n  Check your internet connection and try again.")
        return 1
    bar = "=" * (len(url) + 8)
    print(f"\n  {bar}\n  Share this link with your friends:\n\n      {url}\n\n  {bar}")
    copy_to_clipboard(url)
    if os.name == "nt":
        print("  (copied to your clipboard)")
    print("  Friends open the link, then join your lobby with the invite link, lobby code or friend code.")
    print("  Keep this window open while you play. Close it (or press Ctrl+C) to stop.\n")
    # you play on this PC directly (lowest latency); invite links still use the public address
    threading.Timer(2.0, lambda: webbrowser.open(f"http://localhost:{port}")).start()
    sys.path.insert(0, ROOT)
    from server.main import main as server_main  # noqa: E402

    try:
        return server_main(["--host", "127.0.0.1", "--port", str(port), "--public-url", url])
    finally:
        stop_tunnel(tunnel)


if __name__ == "__main__":
    sys.exit(main())
