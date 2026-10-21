"""Internet play without LAN: cloud-host detection, invite addresses, health check, and the
start-online tunnel launcher (driven by a fake cloudflared so no real tunnel is opened).

    python -m unittest discover -s tests -v
"""
import asyncio
import os
import sys
import tempfile
import textwrap
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.join(ROOT, "tools"))

from server.config import CONFIG  # noqa: E402
from server.game_server import GameServer  # noqa: E402
from server.main import detect_public_url, make_handler, share_addresses  # noqa: E402
import online_host  # noqa: E402
import publish_website  # noqa: E402

SAMPLE_LOG = textwrap.dedent("""\
    2026-10-20T19:00:00Z INF Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment
    2026-10-20T19:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...
    2026-10-20T19:00:01Z INF +--------------------------------------------------------------------------------------------+
    2026-10-20T19:00:01Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
    2026-10-20T19:00:01Z INF |  https://wild-otter-sample-run.trycloudflare.com                                           |
    2026-10-20T19:00:01Z INF +--------------------------------------------------------------------------------------------+
""")


class CloudConfigTests(unittest.TestCase):
    def test_public_url_detection(self):
        self.assertIsNone(detect_public_url({}))
        self.assertEqual(detect_public_url({"PROTAG_PUBLIC_URL": "https://tag.example.com"}), "https://tag.example.com")
        self.assertEqual(detect_public_url({"RENDER_EXTERNAL_URL": "https://pro-tag.onrender.com"}), "https://pro-tag.onrender.com")
        self.assertEqual(detect_public_url({"RAILWAY_PUBLIC_DOMAIN": "pro-tag.up.railway.app"}), "https://pro-tag.up.railway.app")
        self.assertEqual(detect_public_url({"FLY_APP_NAME": "pro-tag"}), "https://pro-tag.fly.dev")
        # an explicit setting always wins
        self.assertEqual(detect_public_url({"PROTAG_PUBLIC_URL": "https://a.b", "FLY_APP_NAME": "x"}), "https://a.b")

    def test_share_addresses_prefer_public_url(self):
        self.assertEqual(share_addresses("0.0.0.0", 8080, "https://x.trycloudflare.com/"), ["https://x.trycloudflare.com"])
        self.assertEqual(share_addresses("127.0.0.1", 8080, "https://x.trycloudflare.com"), ["https://x.trycloudflare.com"])
        self.assertEqual(share_addresses("127.0.0.1", 8080, None), [])  # private to this PC
        self.assertEqual(share_addresses("192.168.1.5", 9000, None), ["http://192.168.1.5:9000"])

    def test_welcome_advertises_public_address(self):
        game = GameServer(CONFIG, share_urls=["https://x.trycloudflare.com"])
        self.assertEqual(game.share_urls, ["https://x.trycloudflare.com"])


class HealthCheckTests(unittest.IsolatedAsyncioTestCase):
    async def test_healthz(self):
        server = await asyncio.start_server(make_handler(GameServer(CONFIG)), "127.0.0.1", 0)
        port = server.sockets[0].getsockname()[1]
        try:
            r, w = await asyncio.open_connection("127.0.0.1", port)
            w.write(b"GET /healthz HTTP/1.1\r\nHost: x\r\n\r\n")
            await w.drain()
            data = await r.read()
            w.close()
            self.assertIn(b"200 OK", data.split(b"\r\n")[0])
            self.assertTrue(data.endswith(b"ok"))
        finally:
            server.close()
            await server.wait_closed()


class TunnelLauncherTests(unittest.TestCase):
    def test_parse_tunnel_url(self):
        urls = [online_host.parse_tunnel_url(line) for line in SAMPLE_LOG.splitlines()]
        self.assertEqual([u for u in urls if u], ["https://wild-otter-sample-run.trycloudflare.com"])
        self.assertIsNone(online_host.parse_tunnel_url("Requesting new quick Tunnel on trycloudflare.com..."))

    def test_start_tunnel_with_fake_cloudflared(self):
        with tempfile.TemporaryDirectory() as d:
            fake = os.path.join(d, "fake_cloudflared.py")
            with open(fake, "w", encoding="utf-8") as f:
                f.write("import sys, time\n")
                f.write("assert sys.argv[1:4] == ['tunnel', '--no-autoupdate', '--url'], sys.argv\n")
                f.write(f"print({SAMPLE_LOG!r}, flush=True)\n")
                f.write("time.sleep(30)\n")
            proc, url = online_host.start_tunnel([sys.executable, fake], 8123, timeout=15)
            try:
                self.assertEqual(url, "https://wild-otter-sample-run.trycloudflare.com")
                self.assertIsNone(proc.poll())  # tunnel keeps running while we host
            finally:
                online_host.stop_tunnel(proc)

    def test_start_tunnel_reports_failure(self):
        with tempfile.TemporaryDirectory() as d:
            fake = os.path.join(d, "broken_cloudflared.py")
            with open(fake, "w", encoding="utf-8") as f:
                f.write("print('ERR failed to request quick Tunnel: no internet', flush=True)\n")
            with self.assertRaises(RuntimeError) as ctx:
                online_host.start_tunnel([sys.executable, fake], 8124, timeout=10)
            self.assertIn("no internet", str(ctx.exception))

    def test_free_port_is_bindable(self):
        port = online_host.free_port(8090)
        self.assertTrue(8090 <= port < 8140)


class PublishWebsiteTests(unittest.TestCase):
    def test_username_and_name_cleanup(self):
        self.assertEqual(publish_website.clean_username(" @AnasStudios "), "AnasStudios")
        self.assertEqual(publish_website.clean_username("https://github.com/anas-dev"), "anas-dev")
        self.assertEqual(publish_website.clean_username(""), "")
        self.assertEqual(publish_website.clean_repo_name("My Tag Game!"), "My-Tag-Game")
        self.assertEqual(publish_website.clean_repo_name(""), "pro-tag")

    def test_links(self):
        new = publish_website.github_new_repo_url("pro-tag")
        self.assertTrue(new.startswith("https://github.com/new?"))
        self.assertIn("name=pro-tag", new)
        self.assertIn("visibility=public", new)
        deploy = publish_website.render_deploy_url("https://github.com/anas/pro-tag")
        self.assertEqual(deploy, "https://render.com/deploy?repo=https%3A%2F%2Fgithub.com%2Fanas%2Fpro-tag")

    def test_render_blueprint_matches_the_server(self):
        with open(os.path.join(ROOT, "render.yaml"), encoding="utf-8") as f:
            text = f.read()
        self.assertIn("startCommand: python server/main.py --host 0.0.0.0", text)
        self.assertIn("healthCheckPath: /healthz", text)
        self.assertIn("plan: free", text)


if __name__ == "__main__":
    unittest.main()
