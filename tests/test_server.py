"""Server tests: WebSocket framing, map collision, movement validation, and an end-to-end
integration test that runs the real server and drives it with raw WebSocket clients.

    python -m unittest discover -s tests -v
"""
import asyncio
import base64
import json
import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from server import websocket as W  # noqa: E402
from server.config import CONFIG  # noqa: E402
from server.game_server import GameServer  # noqa: E402
from server.main import make_handler, resolve  # noqa: E402
from server.mapdata import load_map, list_maps  # noqa: E402
from server.validation import MoveValidator, PlayerMotion  # noqa: E402


class FrameTests(unittest.TestCase):
    def test_accept_key_rfc_example(self):
        # example from RFC 6455 section 1.3
        self.assertEqual(W.accept_key("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")

    def test_roundtrip_masked_frames(self):
        async def go():
            for size in (0, 5, 125, 126, 1000, 70000 - 10000):
                payload = os.urandom(size)
                frame = W.encode_frame(payload, W.OP_BIN, mask=b"\x01\x02\x03\x04")
                r = asyncio.StreamReader()
                r.feed_data(frame)
                r.feed_eof()
                fin, op, data = await W.read_frame(r)
                self.assertTrue(fin)
                self.assertEqual(op, W.OP_BIN)
                self.assertEqual(data, payload)
        asyncio.run(go())

    def test_unmasked_client_frame_rejected(self):
        async def go():
            r = asyncio.StreamReader()
            r.feed_data(W.encode_frame(b"hi"))
            r.feed_eof()
            with self.assertRaises(W.WebSocketClosed):
                await W.read_frame(r)
        asyncio.run(go())

    def test_oversized_frame_rejected(self):
        async def go():
            r = asyncio.StreamReader()
            r.feed_data(W.encode_frame(b"x" * (W.MAX_MESSAGE + 1), mask=b"abcd"))
            r.feed_eof()
            with self.assertRaises(W.WebSocketClosed):
                await W.read_frame(r)
        asyncio.run(go())


class MapDataTests(unittest.TestCase):
    def test_all_maps_load_and_spawns_are_free(self):
        maps = list_maps()
        self.assertGreaterEqual(len(maps), 3)
        r = CONFIG["movement"]["radius"]
        for mid in maps:
            m = load_map(mid)
            self.assertGreaterEqual(len(m.spawns), 10, mid)
            for s in m.spawns:
                self.assertTrue(m.is_free(s[0], s[1] + 0.02, s[2], r, CONFIG["movement"]["height"]), f"{mid} spawn {s} blocked")
                self.assertTrue(m.in_bounds(*s), f"{mid} spawn {s} out of bounds")

    def test_solid_detection_and_los(self):
        m = load_map("rooftops")
        # inside building A (x -36..-18, z -36..-18, h 4)
        self.assertFalse(m.is_free(-27, 1, -27, 0.3, 1))
        self.assertTrue(m.is_free(-27, 4.02, -27 + 6, 0.3, 1.0))  # on its roof, away from props
        self.assertFalse(m.line_of_sight((-40 + 2, 1, -27), (-10, 1, -27)))  # through the building
        self.assertTrue(m.line_of_sight((-10, 1, 10), (10, 1, 14)))

    def test_bounds(self):
        m = load_map("arena")
        self.assertFalse(m.in_bounds(100, 0, 0))
        self.assertTrue(m.in_bounds(0, 0, 0))


class ValidationTests(unittest.TestCase):
    def setUp(self):
        self.map = load_map("rooftops")
        self.v = MoveValidator(CONFIG, self.map)
        self.m = PlayerMotion([0, 0, 14], 0, 100.0)

    def msg(self, x, y, z, vx=0, vz=0):
        return {"p": [x, y, z], "v": [vx, 0, vz], "y": 0, "st": 0, "fl": 1}

    def test_normal_running_accepted(self):
        t = 100.0
        x = 0.0
        for _ in range(40):  # 2 s of sprinting at 9.6 m/s, 20 updates/s
            t += 0.05
            x += 9.6 * 0.05
            ok, why = self.v.validate(self.m, self.msg(x, 0, 14, 9.6), t, False)
            self.assertTrue(ok, why)
            self.v.accept(self.m, self.msg(x, 0, 14, 9.6), t, False)

    def test_teleport_rejected(self):
        ok, why = self.v.validate(self.m, self.msg(0, 0, 40 - 1), 100.05, False)
        self.assertFalse(ok)
        self.assertIn(why, ("too_fast", "out_of_bounds"))

    def test_sustained_speed_hack_rejected(self):
        t = 100.0
        x = 0.0
        rejected = 0
        for _ in range(60):  # 40 m/s
            t += 0.05
            x += 2.0
            ok, _ = self.v.validate(self.m, self.msg(x % 30, 0, 14), t, False)
            if ok:
                self.v.accept(self.m, self.msg(x % 30, 0, 14), t, False)
            else:
                rejected += 1
        self.assertGreater(rejected, 20)

    def test_inside_wall_rejected(self):
        m = PlayerMotion([-17.5, 0, -27], 0, 100.0)
        ok, why = self.v.validate(m, self.msg(-19.0, 0, -27), 100.2, False)  # 1 m into building A
        self.assertFalse(ok)
        self.assertEqual(why, "inside_solid")

    def test_frozen_player_cannot_move(self):
        ok, why = self.v.validate(self.m, self.msg(2.5, 0, 14), 100.5, True)
        self.assertFalse(ok)
        self.assertEqual(why, "frozen")

    def test_malformed_rejected(self):
        for bad in ({"p": [0, 0], "v": [0, 0, 0]}, {"p": [0, float("nan"), 0], "v": [0, 0, 0]}, {"p": "x", "v": [0, 0, 0]}, {"p": [0, 0, 14]}):
            ok, why = self.v.validate(self.m, bad, 100.1, False)
            self.assertFalse(ok)
            self.assertEqual(why, "malformed")


class StaticFileTests(unittest.TestCase):
    def test_public_and_private_paths(self):
        self.assertIsNotNone(resolve("/"))
        self.assertIsNotNone(resolve("/src/main.js"))
        self.assertIsNotNone(resolve("/config/game.json"))
        self.assertIsNone(resolve("/server/main.py"))
        self.assertIsNone(resolve("/tools/build_maps.py"))
        self.assertIsNone(resolve("/src/../server/main.py"))
        self.assertIsNone(resolve("/%2e%2e/%2e%2e/windows/win.ini"))
        self.assertIsNone(resolve("/src/does-not-exist.js"))


# ----------------------------------------------------------------------------- integration
class RawClient:
    """Minimal WebSocket client used to drive the real server in tests."""

    def __init__(self, port):
        self.port = port
        self.inbox = []

    async def connect(self):
        self.reader, self.writer = await asyncio.open_connection("127.0.0.1", self.port)
        key = base64.b64encode(os.urandom(16)).decode()
        self.writer.write((f"GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
                           f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n").encode())
        await self.writer.drain()
        head = await self.reader.readuntil(b"\r\n\r\n")
        assert b"101" in head.split(b"\r\n")[0], head
        assert W.accept_key(key).encode() in head

    async def send(self, obj):
        self.writer.write(W.encode_frame(json.dumps(obj).encode(), W.OP_TEXT, mask=os.urandom(4)))
        await self.writer.drain()

    async def recv(self, timeout=3.0):
        fin, op, data = await asyncio.wait_for(W.read_frame(self.reader, require_mask=False), timeout)
        if op == W.OP_CLOSE:
            raise ConnectionError("closed")
        msg = json.loads(data)
        self.inbox.append(msg)
        return msg

    async def wait_for(self, pred, timeout=4.0):
        """Return the first already-received or new message matching pred."""
        for m in self.inbox:
            if pred(m):
                self.inbox.remove(m)
                return m
        loop = asyncio.get_running_loop()
        end = loop.time() + timeout
        while True:
            left = end - loop.time()
            if left <= 0:
                raise AssertionError("timed out waiting for message")
            m = await self.recv(left)
            if pred(m):
                self.inbox.remove(m)
                return m

    async def close(self):
        try:
            self.writer.write(W.encode_frame(b"\x03\xe8", W.OP_CLOSE, mask=os.urandom(4)))
            await self.writer.drain()
        except ConnectionError:
            pass
        self.writer.close()


def t_is(t):
    return lambda m: m.get("t") == t


class IntegrationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        cfg = json.loads(json.dumps(CONFIG))
        cfg["match"]["countdown"] = 0.3  # keep the test fast
        cfg["match"]["resultsTime"] = 0.4
        self.game = GameServer(cfg)
        self.server = await asyncio.start_server(make_handler(self.game), "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        self.clients = []

    async def asyncTearDown(self):
        for c in self.clients:
            await c.close()
        self.server.close()
        await self.server.wait_closed()
        for room in list(self.game.rooms.values()):
            if room.match and room.match.task:
                room.match.task.cancel()

    async def client(self, name, tag=None):
        c = RawClient(self.port)
        await c.connect()
        hello = {"t": "hello", "v": 1, "name": name, "cosm": {"primary": "#ff0000", "hat": "cap", "evil": "<script>"}}
        if tag:
            hello["tag"] = tag
        await c.send(hello)
        w = await c.wait_for(t_is("welcome"))
        c.id = w["id"]
        c.token = w["token"]
        c.tag = w["tag"]
        self.clients.append(c)
        return c

    async def test_http_serves_index_and_blocks_server_code(self):
        r, w = await asyncio.open_connection("127.0.0.1", self.port)
        w.write(b"GET / HTTP/1.1\r\nHost: x\r\n\r\n")
        await w.drain()
        data = await r.read()
        self.assertIn(b"200 OK", data.split(b"\r\n")[0])
        self.assertIn(b"PRO TAG", data)
        w.close()
        r, w = await asyncio.open_connection("127.0.0.1", self.port)
        w.write(b"GET /server/game_server.py HTTP/1.1\r\nHost: x\r\n\r\n")
        await w.drain()
        data = await r.read()
        self.assertIn(b"404", data.split(b"\r\n")[0])
        w.close()

    async def test_version_mismatch_rejected(self):
        c = RawClient(self.port)
        await c.connect()
        await c.send({"t": "hello", "v": 999, "name": "x"})
        m = await c.wait_for(t_is("error"))
        self.assertEqual(m["code"], "version")
        self.clients.append(c)

    async def test_full_online_flow(self):
        a = await self.client("Alice<b>")
        b = await self.client("Bob")
        # names are sanitised server-side
        await a.send({"t": "create_room", "public": False, "mode": "classic", "map": "arena"})
        room = (await a.wait_for(t_is("room")))["room"]
        self.assertEqual(room["players"][0]["name"], "Aliceb")
        self.assertNotIn("evil", room["players"][0]["cosm"])
        code = room["code"]
        self.assertEqual(len(code), 5)

        # wrong code -> clear error
        await b.send({"t": "join_room", "code": "ZZZZZ"})
        self.assertEqual((await b.wait_for(t_is("error")))["code"], "no_room")
        await b.send({"t": "join_room", "code": code})
        room_b = (await b.wait_for(lambda m: m.get("t") == "room" and len(m["room"]["players"]) == 2))["room"]
        room_a = (await a.wait_for(lambda m: m.get("t") == "room" and len(m["room"]["players"]) == 2))["room"]
        self.assertEqual(room_a, room_b)  # lobby state is synchronised
        self.assertEqual(room_a["host"], a.id)

        # only the host may start; everyone must be ready
        await b.send({"t": "start_match"})
        self.assertEqual((await b.wait_for(t_is("error")))["code"], "not_host")
        await b.send({"t": "room_settings", "mode": "infection"})
        self.assertEqual((await b.wait_for(t_is("error")))["code"], "not_host")
        await a.send({"t": "start_match"})
        self.assertEqual((await a.wait_for(t_is("error")))["code"], "not_ready")
        await a.send({"t": "ready", "ready": True})
        await b.send({"t": "ready", "ready": True})
        await a.wait_for(lambda m: m.get("t") == "room" and all(p["ready"] for p in m["room"]["players"]))
        await a.send({"t": "start_match"})
        start_a = await a.wait_for(t_is("match_start"))
        start_b = await b.wait_for(t_is("match_start"))
        self.assertEqual(start_a["matchId"], start_b["matchId"])
        self.assertEqual(set(start_a["spawns"]), {a.id, b.id})
        for c in (a, b):
            await c.send({"t": "loaded", "matchId": start_a["matchId"]})
        rules = (await a.wait_for(lambda m: m.get("t") == "rules" and m["rules"]["phase"] == "playing", timeout=5))["rules"]
        it_id = next(p["id"] for p in rules["players"] if p["it"])
        it_c, run_c = (a, b) if it_id == a.id else (b, a)

        # a teleport is rejected and corrected
        sp = start_a["spawns"][it_c.id]
        tx = sp[0] - 15 if sp[0] > 0 else sp[0] + 15  # 15 m toward the centre (stays in bounds)
        await it_c.send({"t": "state", "s": 1, "p": [tx, sp[1], sp[2]], "v": [0, 0, 0], "y": 0, "st": 0, "fl": 1})
        corr = await it_c.wait_for(t_is("correct"))
        self.assertEqual(corr["reason"], "too_fast")

        # a far-away tag is not accepted
        await it_c.send({"t": "tag", "target": run_c.id})
        await asyncio.sleep(0.2)
        self.assertEqual(self.game.rooms[code].match.state["tagCount"], 0)

        # bring the players together (white-box: positions as if they had run there legitimately)
        m = self.game.rooms[code].match
        import time as _t
        now = _t.monotonic()
        m.motion[it_c.id].pos = [0.0, 0.0, -12.0]
        m.motion[run_c.id].pos = [0.9, 0.0, -12.0]
        m.motion[it_c.id].history.append((now, 0.0, 0.0, -12.0))
        m.motion[run_c.id].history.append((now, 0.9, 0.0, -12.0))
        await it_c.send({"t": "tag", "target": run_c.id})
        ev = await run_c.wait_for(lambda m_: m_.get("t") == "event" and m_["ev"]["type"] == "tag")
        self.assertEqual(ev["ev"]["tagger"], it_c.id)
        self.assertEqual(ev["ev"]["target"], run_c.id)
        await it_c.wait_for(lambda m_: m_.get("t") == "event" and m_["ev"]["type"] == "it" and m_["ev"]["id"] == run_c.id)
        # duplicate request: processed once only
        await it_c.send({"t": "tag", "target": run_c.id})
        await asyncio.sleep(0.25)
        self.assertEqual(m.state["tagCount"], 1)
        self.assertTrue(m.state["players"][run_c.id]["it"])
        self.assertFalse(m.state["players"][it_c.id]["it"])

        # snapshots are being streamed
        snap = await a.wait_for(t_is("snap"))
        self.assertEqual(len(snap["p"]), 2)

        # the new IT disconnects -> IT is handed over and the match ends (fewer than 2 players)
        await run_c.close()
        self.clients.remove(run_c)
        await it_c.wait_for(lambda m_: m_.get("t") == "player_left" and m_["id"] == run_c.id)
        end = await it_c.wait_for(t_is("match_end"), timeout=5)
        self.assertEqual(end["result"]["reason"], "players")
        self.assertIn(it_c.id, end["result"]["winners"])
        self.assertGreater(end["award"]["total"], 0)
        # room returns to the lobby with readiness reset (ignore lobby updates from before the match)
        it_c.inbox = [m_ for m_ in it_c.inbox if m_.get("t") != "room"]
        lobby = await it_c.wait_for(lambda m_: m_.get("t") == "room" and m_["room"]["phase"] == "lobby", timeout=5)
        self.assertFalse(any(p["ready"] for p in lobby["room"]["players"]))

    async def test_reconnect_with_token_resumes_identity(self):
        a = await self.client("Ann")
        await a.send({"t": "create_room", "public": True, "mode": "classic", "map": "rooftops"})
        await a.wait_for(t_is("room"))
        await a.close()
        self.clients.remove(a)
        await asyncio.sleep(0.1)
        c = RawClient(self.port)
        await c.connect()
        await c.send({"t": "hello", "v": 1, "name": "Ann", "token": a.token})
        w = await c.wait_for(t_is("welcome"))
        self.assertEqual(w["id"], a.id)
        self.assertTrue(w.get("resumed"))
        self.clients.append(c)

    async def test_quick_play_matches_players_and_room_capacity(self):
        a = await self.client("A")
        b = await self.client("B")
        await a.send({"t": "quick_play", "mode": "classic", "map": "rooftops"})
        ra = (await a.wait_for(t_is("room")))["room"]
        await b.send({"t": "quick_play"})
        rb = (await b.wait_for(t_is("room")))["room"]
        self.assertEqual(ra["code"], rb["code"])
        self.game.rooms[ra["code"]].max = 2
        c = await self.client("C")
        await c.send({"t": "join_room", "code": ra["code"]})
        self.assertEqual((await c.wait_for(t_is("error")))["code"], "full")

    async def test_host_migrates_when_host_leaves(self):
        a = await self.client("A")
        b = await self.client("B")
        await a.send({"t": "create_room", "public": True})
        code = (await a.wait_for(t_is("room")))["room"]["code"]
        await b.send({"t": "join_room", "code": code})
        await b.wait_for(lambda m: m.get("t") == "room" and len(m["room"]["players"]) == 2)
        await a.send({"t": "leave_room"})
        r = await b.wait_for(lambda m: m.get("t") == "room" and len(m["room"]["players"]) == 1)
        self.assertEqual(r["room"]["host"], b.id)

    async def test_flooding_is_rate_limited(self):
        a = await self.client("Spam")
        for i in range(120):
            await a.send({"t": "ping", "c": i})
        await asyncio.sleep(0.3)
        pongs = [m for m in a.inbox if m.get("t") == "pong"]
        # drain whatever arrived
        try:
            while True:
                m = await a.recv(timeout=0.3)
                if m.get("t") == "pong":
                    pongs.append(m)
        except (asyncio.TimeoutError, ConnectionError, asyncio.IncompleteReadError):
            pass
        self.assertLessEqual(len(pongs), CONFIG["netValidation"]["maxMessagesPerSecond"])


class PerfectDodgeServerTests(IntegrationTests):
    """Server-authoritative perfect dodge: dodge window, evasion instead of a tag, anti-spam."""

    test_http_serves_index_and_blocks_server_code = None
    test_version_mismatch_rejected = None
    test_full_online_flow = None
    test_reconnect_with_token_resumes_identity = None
    test_quick_play_matches_players_and_room_capacity = None
    test_host_migrates_when_host_leaves = None
    test_flooding_is_rate_limited = None

    async def _match(self):
        a = await self.client("Ann")
        b = await self.client("Bob")
        await a.send({"t": "create_room", "public": False, "map": "training"})
        code = (await a.wait_for(t_is("room")))["room"]["code"]
        await b.send({"t": "join_room", "code": code})
        await a.wait_for(lambda m: m.get("t") == "room" and len(m["room"]["players"]) == 2)
        for c in (a, b):
            await c.send({"t": "ready", "ready": True})
        await a.wait_for(lambda m: m.get("t") == "room" and all(p["ready"] for p in m["room"]["players"]))
        await a.send({"t": "start_match"})
        start = await a.wait_for(t_is("match_start"))
        for c in (a, b):
            await c.send({"t": "loaded", "matchId": start["matchId"]})
        rules = (await a.wait_for(lambda m: m.get("t") == "rules" and m["rules"]["phase"] == "playing", timeout=5))["rules"]
        it_id = next(p["id"] for p in rules["players"] if p["it"])
        it_c, run_c = (a, b) if it_id == a.id else (b, a)
        m = self.game.rooms[code].match
        self._place(m, it_c, [10.0, 0.0, 2.0], [0.0, 0.0, 0.0])  # 5 m apart to begin with
        self._place(m, run_c, [10.0, 0.0, -3.0], [0.0, 0.0, 0.0])
        return m, it_c, run_c

    def _place(self, m, c, pos, vel):
        """White-box: set a server-side position as if the player had run there legitimately."""
        import time as _t
        m.motion[c.id].pos, m.motion[c.id].vel = list(pos), list(vel)
        m.motion[c.id].history.append((_t.monotonic(), *pos))

    async def test_dodge_in_window_turns_the_tag_into_a_perfect_dodge(self):
        m, it_c, run_c = await self._match()
        await run_c.send({"t": "dodge"})
        await asyncio.sleep(0.03)
        self._place(m, it_c, [10.0, 0.0, -2.0], [0.0, 0.0, -9.0])  # IT lunges in during the window
        await it_c.send({"t": "tag", "target": run_c.id})
        ev = (await run_c.wait_for(lambda x: x.get("t") == "event" and x["ev"]["type"] == "perfect_dodge"))["ev"]
        self.assertEqual((ev["tagger"], ev["dodger"]), (it_c.id, run_c.id))
        rules = (await it_c.wait_for(lambda x: x.get("t") == "rules" and any(p.get("pd") for p in x["rules"]["players"])))["rules"]
        rp = {p["id"]: p for p in rules["players"]}
        self.assertTrue(rp[it_c.id]["it"])          # no tag happened
        self.assertGreater(rp[it_c.id]["fz"], 1.5)  # tagger stunned through the cinematic + 1 s
        self.assertGreater(rp[run_c.id]["bo"], 5.0)  # dodger boosted (starts after the cinematic)
        self.assertEqual(m.state["tagCount"], 0)

    async def test_dodge_spam_cannot_hold_the_window_open(self):
        m, it_c, run_c = await self._match()
        await run_c.send({"t": "dodge"})
        await asyncio.sleep(0.05)
        first = m.motion[run_c.id].dodge_at
        await run_c.send({"t": "dodge"})  # inside the dodge cooldown -> ignored
        await asyncio.sleep(0.05)
        self.assertEqual(m.motion[run_c.id].dodge_at, first)

    async def test_stale_dodge_is_tagged_normally(self):
        m, it_c, run_c = await self._match()
        await run_c.send({"t": "dodge"})  # dodged far too early: IT is still 5 m away
        await asyncio.sleep(0.5)  # window (0.24 s + 0.12 s grace) has passed
        self._place(m, it_c, [10.0, 0.0, -2.0], [0.0, 0.0, -9.0])
        await it_c.send({"t": "tag", "target": run_c.id})
        ev = (await run_c.wait_for(lambda x: x.get("t") == "event" and x["ev"]["type"] in ("tag", "perfect_dodge")))["ev"]
        self.assertEqual(ev["type"], "tag")


class SocialTests(IntegrationTests):
    """Lobbies with friends: friend codes, presence, invites, lobby browser, chat, host tools."""

    # the inherited IntegrationTests tests are not re-run here
    test_http_serves_index_and_blocks_server_code = None
    test_version_mismatch_rejected = None
    test_full_online_flow = None
    test_reconnect_with_token_resumes_identity = None
    test_quick_play_matches_players_and_room_capacity = None
    test_host_migrates_when_host_leaves = None
    test_flooding_is_rate_limited = None

    async def test_friend_code_is_persistent_and_validated(self):
        a = await self.client("Ann", tag="ANN234")
        self.assertEqual(a.tag, "ANN234")
        b = await self.client("Bob", tag="not a tag!")
        self.assertRegex(b.tag, r"^[A-Z0-9]{6}$")  # invalid codes are replaced by a fresh one

    async def test_lobby_browser_lists_public_lobbies_only(self):
        a = await self.client("Ann")
        b = await self.client("Bob")
        await a.send({"t": "create_room", "public": True, "mode": "infection", "map": "docks", "name": "Ann's <b>party</b>"})
        pub = (await a.wait_for(t_is("room")))["room"]
        self.assertEqual(pub["name"], "Ann's bpartyb")  # sanitised
        await b.send({"t": "create_room", "public": False})
        await b.wait_for(t_is("room"))
        c = await self.client("Cat")
        await c.send({"t": "list_rooms"})
        rooms = (await c.wait_for(t_is("rooms")))["rooms"]
        self.assertEqual([r["code"] for r in rooms], [pub["code"]])
        r = rooms[0]
        self.assertEqual((r["host"], r["players"], r["mode"], r["map"], r["phase"]), ("Ann", 1, "infection", "docks", "lobby"))

    async def test_presence_invite_and_join_private_lobby(self):
        host = await self.client("Host", tag="HOST22")
        pal = await self.client("Pal", tag="PAL333")
        await host.send({"t": "create_room", "public": False})
        room = (await host.wait_for(t_is("room")))["room"]
        # before an invite, a friend sees "in a private lobby" but not its code
        await pal.send({"t": "friends_status", "tags": ["HOST22", "NOBODY", "bad"]})
        lst = {f["tag"]: f for f in (await pal.wait_for(t_is("friends")))["list"]}
        self.assertTrue(lst["HOST22"]["online"])
        self.assertEqual(lst["HOST22"]["name"], "Host")
        self.assertIsNone(lst["HOST22"]["room"]["code"])
        self.assertFalse(lst["NOBODY"]["online"])
        self.assertNotIn("bad", lst)
        # invite: delivered to every connection of that friend code, and the lobby code is revealed
        await host.send({"t": "invite", "tag": "PAL333"})
        sent = await host.wait_for(t_is("invite_sent"))
        self.assertTrue(sent["delivered"])
        inv = await pal.wait_for(t_is("invited"))
        self.assertEqual(inv["from"], {"name": "Host", "tag": "HOST22"})
        self.assertEqual(inv["room"]["code"], room["code"])
        await pal.send({"t": "friends_status", "tags": ["HOST22"]})
        self.assertEqual((await pal.wait_for(t_is("friends")))["list"][0]["room"]["code"], room["code"])
        await pal.send({"t": "join_room", "code": inv["room"]["code"]})
        joined = await pal.wait_for(lambda m: m.get("t") == "room" and len(m["room"]["players"]) == 2)
        self.assertEqual({p["tag"] for p in joined["room"]["players"]}, {"HOST22", "PAL333"})
        # inviting an offline code is reported as not delivered
        await host.send({"t": "invite", "tag": "ZZZZZZ"})
        await asyncio.sleep(0.6)  # invite cooldown
        await host.send({"t": "invite", "tag": "ZZZZZZ"})
        self.assertFalse((await host.wait_for(t_is("invite_sent")))["delivered"])

    async def test_invite_requires_a_lobby(self):
        a = await self.client("Ann")
        await a.send({"t": "invite", "tag": "ABCDEF"})
        self.assertEqual((await a.wait_for(t_is("error")))["code"], "invite")

    async def test_lobby_chat_is_broadcast_sanitised_and_rate_limited(self):
        a = await self.client("Ann")
        b = await self.client("Bob")
        await a.send({"t": "create_room", "public": True})
        code = (await a.wait_for(t_is("room")))["room"]["code"]
        await a.send({"t": "chat", "text": "hi   there\nfriend " + "x" * 300})
        await asyncio.sleep(0.1)
        # b joins after the message: receives the history, including system lines
        await b.send({"t": "join_room", "code": code})
        hist = (await b.wait_for(t_is("chat_history")))["list"]
        said = [m for m in hist if not m.get("system")]
        self.assertEqual(said[0]["name"], "Ann")
        self.assertTrue(said[0]["text"].startswith("hi there friend xxx"))
        self.assertLessEqual(len(said[0]["text"]), 140)
        self.assertTrue(any(m.get("system") for m in hist))
        await b.send({"t": "chat", "text": "hello!"})
        got = await a.wait_for(lambda m: m.get("t") == "chat" and m["msg"].get("id") == b.id)
        self.assertEqual(got["msg"]["text"], "hello!")
        for i in range(8):  # spam -> slowed down
            await b.send({"t": "chat", "text": f"spam {i}"})
        self.assertEqual((await b.wait_for(t_is("error")))["code"], "chat_slow")

    async def test_host_settings_kick_and_temporary_ban(self):
        a = await self.client("Ann")
        b = await self.client("Bob")
        await a.send({"t": "create_room", "public": True})
        code = (await a.wait_for(t_is("room")))["room"]["code"]
        await b.send({"t": "join_room", "code": code})
        await a.wait_for(lambda m: m.get("t") == "room" and len(m["room"]["players"]) == 2)
        # only the host changes settings; size is clamped to [players, server max]
        await b.send({"t": "room_settings", "max": 2})
        self.assertEqual((await b.wait_for(t_is("error")))["code"], "not_host")
        await a.send({"t": "room_settings", "name": "Rooftop Crew", "max": 1, "public": False})
        r = (await a.wait_for(lambda m: m.get("t") == "room" and m["room"]["name"] == "Rooftop Crew"))["room"]
        self.assertEqual(r["max"], 2)
        self.assertFalse(r["public"])
        await a.send({"t": "room_settings", "max": 99})
        r = (await a.wait_for(lambda m: m.get("t") == "room" and m["room"]["max"] != 2))["room"]
        self.assertEqual(r["max"], CONFIG["match"]["maxPlayers"])
        # kick: removed, told why, and cannot rejoin straight away
        await b.send({"t": "kick", "id": a.id})
        self.assertEqual((await b.wait_for(t_is("error")))["code"], "not_host")
        await a.send({"t": "kick", "id": b.id})
        self.assertIn("removed", (await b.wait_for(t_is("kicked")))["msg"])
        await a.wait_for(lambda m: m.get("t") == "room" and len(m["room"]["players"]) == 1)
        await b.send({"t": "join_room", "code": code})
        self.assertEqual((await b.wait_for(t_is("error")))["code"], "kicked")


if __name__ == "__main__":
    unittest.main()
