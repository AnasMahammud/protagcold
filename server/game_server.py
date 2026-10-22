"""Authoritative PRO TAG game server: lobby, rooms and matches.

Every rule decision (who is IT, tags, eliminations, timers, results, XP awards) is made
here. Clients only send intents (ready, start, tag requests) and their predicted movement,
which is validated before being relayed to other players.
"""
from __future__ import annotations

import asyncio
import json
import logging
import math
import random
import re
import secrets
import time

from . import rules as R
from .mapdata import load_map, list_maps
from .progression import compute_award
from .validation import MoveValidator, PlayerMotion
from .websocket import WebSocket, WebSocketClosed

log = logging.getLogger("protag")

PROTOCOL_VERSION = 1
CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ"
NAME_RE = re.compile(r"[^\w\- ]")
HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
RECONNECT_GRACE = 30.0
ONLINE_MODES = ("classic", "infection", "elimination", "hotpotato", "zone")
TAG_RE = re.compile(r"^[A-Z0-9]{6}$")  # persistent friend code chosen by the client
TAG_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
CHAT_MAX = 140
CHAT_HISTORY = 40
KICK_BAN_SECONDS = 120.0
ROOM_NAME_RE = re.compile(r"[^\w\-' !?.]")
ABILITY_IDS = ("blink", "rocket", "decoy", "grapple", "cloak", "shockwave", "scramble")
EMOTE_IDS = ("wave", "dance", "flex", "griddy", "buggin", "robot", "salute", "chicken", "chill", "moonwalk")  # mirrors EMOTE_IDS in cosmetics.js
SCRAMBLE_MODES = ("invert", "mirror", "spin")  # mirrors SCRAMBLE_MODES in abilities.js


def _vec3(v):
    """A finite [x, y, z] list from client data, else None."""
    if isinstance(v, list) and len(v) == 3 and all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in v):
        return [float(x) for x in v]
    return None


def zone_plan(mapdata):
    """Shrinking Zone layout (mirrors zonePlan in localMatch.js): starts over the whole map and
    closes toward one of its ground-level spawns."""
    x0, z0, x1, z1 = mapdata.bounds
    ground = [s for s in mapdata.spawns if s[1] < 1] or mapdata.spawns
    end = random.choice(ground)
    return {"x0": (x0 + x1) / 2, "z0": (z0 + z1) / 2, "x1": end[0], "z1": end[2], "r0": math.hypot(x1 - x0, z1 - z0) / 2 + 2}


def clean_loadout(lo):
    """Two positional ability slots, no duplicates, unknown ids dropped (mirrors validLoadout)."""
    out = [None, None]
    if isinstance(lo, list):
        for i, aid in enumerate(lo[:2]):
            if aid in ABILITY_IDS and aid not in out:
                out[i] = aid
    return out


def clean_room_name(name, fallback) -> str:
    if not isinstance(name, str):
        return fallback
    name = ROOM_NAME_RE.sub("", name).strip()[:24]
    return name or fallback


def clean_chat(text):
    if not isinstance(text, str):
        return None
    text = " ".join(text.split())[:CHAT_MAX]  # collapse whitespace / newlines
    text = "".join(ch for ch in text if ch.isprintable())
    return text or None


def now() -> float:
    return time.monotonic()


def clean_name(name) -> str:
    if not isinstance(name, str):
        return "Runner"
    name = NAME_RE.sub("", name).strip()[:16]
    return name or "Runner"


def clean_cosmetics(c) -> dict:
    out = {}
    if not isinstance(c, dict):
        return out
    for k in ("primary", "secondary", "accent"):
        v = c.get(k)
        if isinstance(v, str) and HEX_RE.match(v):
            out[k] = v
    for k in ("hat", "trail", "tagEffect", "title"):
        v = c.get(k)
        if isinstance(v, str) and len(v) <= 24 and v.isidentifier():
            out[k] = v
    return out


class Client:
    def __init__(self, ws: WebSocket, cid: str, token: str, name: str, cosm: dict):
        self.ws = ws
        self.id = cid
        self.token = token
        self.name = name
        self.cosm = cosm
        self.room: Room | None = None
        self.connected = True
        self.disconnected_at = 0.0
        self.msg_window = now()
        self.msg_count = 0
        self.tag = "".join(random.choice(TAG_ALPHABET) for _ in range(6))  # friend code
        self.last_chat = 0.0
        self.chat_burst = 0
        self.last_invite = 0.0

    async def send(self, obj):
        if self.connected and self.ws and not self.ws.closed:
            await self.ws.send_json(obj)


class Match:
    def __init__(self, room: "Room", cfg: dict):
        self.room = room
        self.cfg = cfg
        self.id = secrets.token_hex(4)
        self.map = load_map(room.map)
        self.validator = MoveValidator(cfg, self.map)
        roster = [c for c in room.players.values() if c.connected]
        self.roster_ids = [c.id for c in roster]
        spawns = self.map.spawns[:]
        random.shuffle(spawns)
        bx0, bz0, bx1, bz1 = self.map.bounds
        cx, cz = (bx0 + bx1) / 2, (bz0 + bz1) / 2
        self.spawns = {}
        self.motion: dict[str, PlayerMotion] = {}
        t = now()
        for i, c in enumerate(roster):
            s = spawns[i % len(spawns)]
            yaw = math.atan2(-(cx - s[0]), -(cz - s[2]))
            self.spawns[c.id] = [s[0], s[1], s[2], round(yaw, 3)]
            self.motion[c.id] = PlayerMotion(s, yaw, t)
        start_it = [random.choice(self.roster_ids)]
        self.state = R.create_match(room.mode, [{"id": c.id, "name": c.name} for c in roster], start_it, cfg,
                                    countdown=cfg["match"]["countdown"], zone=zone_plan(self.map) if room.mode == "zone" else None)
        self.loaded: set[str] = set()
        self.task: asyncio.Task | None = None
        self.last_tag_req: dict[str, float] = {}
        # abilities: loadouts arrive with "loaded"; cooldowns are tracked here (server time)
        self.loadouts: dict[str, list] = {pid: [None, None] for pid in self.roster_ids}
        self.ability_t: dict[str, dict[str, float]] = {pid: {} for pid in self.roster_ids}
        # gold coins on the map (server-owned: spawn, validated pickup, respawn)
        self.coins: dict[str, list] = {}
        self.coin_seq = 0
        self.coin_respawns: list[float] = []
        self.bonus_coins: set[str] = set()  # coin rain: never respawn
        for _ in range(min(cfg["coins"]["mapCoins"], len(self.map.coin_spots))):
            self.spawn_coin()
        # map events (power outage, coin rain...): scheduled here, applied by every client
        self.event_kinds = list((self.map.data.get("env") or {}).get("events") or [])
        self.event = None
        self.event_fired = False
        self.last_event = None
        self.next_event_at = random.uniform(*cfg["mapEvents"]["firstAt"])

    def snapshot(self):
        snap = R.snapshot(self.state)
        if self.event:
            snap["ev"] = self.event
        return snap

    def spawn_coin(self, bonus=False):
        used = list(self.coins.values())
        options = [s for s in self.map.coin_spots if all(math.hypot(u[0] - s[0], u[2] - s[2]) >= 1 for u in used)]
        if not options:
            return None
        s = random.choice(options)
        self.coin_seq += 1
        cid = f"c{self.coin_seq}"
        self.coins[cid] = [s[0], s[1], s[2]]
        if bonus:
            self.bonus_coins.add(cid)
        return cid

    def start_message(self):
        return {
            "t": "match_start",
            "matchId": self.id,
            "map": self.room.map,
            "mode": self.room.mode,
            "players": [{"id": pid, "name": self.room.players[pid].name if pid in self.room.players else pid,
                         "cosm": self.room.players[pid].cosm if pid in self.room.players else {}}
                        for pid in self.roster_ids],
            "spawns": self.spawns,
            "rules": self.snapshot(),
            "coins": [[cid, *p] for cid, p in self.coins.items()],
        }

    def resync_message(self):
        msg = self.start_message()
        msg["spawns"] = {pid: [m.pos[0], m.pos[1], m.pos[2], m.yaw] for pid, m in self.motion.items()}
        return msg

    def is_frozen(self, pid):
        st = self.state
        p = st["players"].get(pid)
        if not p:
            return True
        return st["phase"] == "countdown" or (st["phase"] == "playing" and st["time"] < p["frozenUntil"])


class Room:
    def __init__(self, code: str, public: bool, mode: str, map_id: str, max_players: int):
        self.code = code
        self.public = public
        self.mode = mode
        self.map = map_id
        self.max = max_players
        self.players: dict[str, Client] = {}
        self.ready: dict[str, bool] = {}
        self.host: str | None = None
        self.phase = "lobby"  # lobby | starting | playing | results
        self.match: Match | None = None
        self.created = now()
        self.name = "Lobby"
        self.chat: list[dict] = []
        self.invited: set[str] = set()  # friend codes invited to this room (may see/join it while private)
        self.banned: dict[str, float] = {}  # token -> until (kicked players)

    def host_name(self):
        c = self.players.get(self.host)
        return c.name if c else "?"

    def summary(self):
        """Short public description used by the lobby browser and friend presence."""
        return {
            "code": self.code,
            "name": self.name,
            "host": self.host_name(),
            "public": self.public,
            "mode": self.mode,
            "map": self.map,
            "players": len(self.players),
            "max": self.max,
            "phase": self.phase,
        }

    def view(self):
        return {
            "code": self.code,
            "name": self.name,
            "public": self.public,
            "mode": self.mode,
            "map": self.map,
            "max": self.max,
            "host": self.host,
            "phase": self.phase,
            "players": [{"id": c.id, "name": c.name, "tag": c.tag, "ready": self.ready.get(c.id, False), "cosm": c.cosm,
                         "connected": c.connected} for c in self.players.values()],
        }


class GameServer:
    def __init__(self, cfg: dict, share_urls: list[str] | None = None):
        self.cfg = cfg
        # addresses other computers can use to reach this server (empty = this computer only)
        self.share_urls = share_urls or []
        self.clients: dict[str, Client] = {}
        self.by_token: dict[str, Client] = {}
        self.rooms: dict[str, Room] = {}
        self.maps = list_maps()
        self._next_id = 1
        self.tick_hz = cfg["tick"]["serverTickHz"]
        self.snap_hz = cfg["tick"]["netSendHz"]

    # ------------------------------------------------------------------ connection
    async def handle(self, ws: WebSocket):
        client: Client | None = None
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=10)
            hello = json.loads(raw)
            if hello.get("t") != "hello":
                await ws.send_json({"t": "error", "code": "protocol", "msg": "Expected hello"})
                return
            if hello.get("v") != PROTOCOL_VERSION:
                await ws.send_json({"t": "error", "code": "version", "msg": "Client and server versions differ. Reload the page."})
                return
            client = await self._attach(ws, hello)
            while True:
                raw = await ws.recv()
                if not self._rate_ok(client):
                    continue
                try:
                    msg = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if not isinstance(msg, dict):
                    continue
                try:
                    await self.dispatch(client, msg)
                except Exception:  # noqa: BLE001 - never let one bad message kill the server
                    log.exception("error handling %s from %s", msg.get("t"), client.id)
                    await client.send({"t": "error", "code": "server", "msg": "Server error handling request"})
        except (WebSocketClosed, asyncio.TimeoutError, ConnectionError, json.JSONDecodeError):
            pass
        finally:
            if client and client.ws is ws:
                await self._on_disconnect(client)
            await ws.close()

    async def _attach(self, ws, hello) -> Client:
        token = hello.get("token")
        old = self.by_token.get(token) if isinstance(token, str) else None
        if old and not old.connected and now() - old.disconnected_at < RECONNECT_GRACE:
            # reconnection: same identity, same room, same match slot
            old.ws = ws
            old.connected = True
            log.info("client %s (%s) reconnected", old.id, old.name)
            await old.send({"t": "welcome", "id": old.id, "token": old.token, "tag": old.tag, "s": now(), "maps": self.maps,
                            "share": self.share_urls, "resumed": True})
            room = old.room
            if room and old.id in room.players:
                await self.broadcast_room(room)
                m = room.match
                if m and room.phase in ("starting", "playing") and old.id in m.state["players"]:
                    R.add_player(m.state, old.id, old.name)  # marks the slot connected again
                    await old.send(m.resync_message())
                    await self.broadcast(room, {"t": "player_back", "id": old.id}, exclude=old.id)
                    await self.broadcast(room, {"t": "rules", "rules": m.snapshot()})
            return old
        cid = f"p{self._next_id}"
        self._next_id += 1
        client = Client(ws, cid, secrets.token_urlsafe(16), clean_name(hello.get("name")), clean_cosmetics(hello.get("cosm")))
        tag = hello.get("tag")
        if isinstance(tag, str) and TAG_RE.match(tag):
            client.tag = tag  # keep the player's persistent friend code
        self.clients[cid] = client
        self.by_token[client.token] = client
        log.info("client %s connected as %s (#%s) from %s", cid, client.name, client.tag, ws.peer)
        await client.send({"t": "welcome", "id": cid, "token": client.token, "tag": client.tag, "s": now(),
                           "maps": self.maps, "share": self.share_urls})
        return client

    def _rate_ok(self, client: Client) -> bool:
        t = now()
        if t - client.msg_window >= 1.0:
            client.msg_window = t
            client.msg_count = 0
        client.msg_count += 1
        limit = self.cfg["netValidation"]["maxMessagesPerSecond"]
        if client.msg_count > limit * 3:
            log.warning("client %s flooding (%d msg/s) - disconnecting", client.id, client.msg_count)
            asyncio.ensure_future(client.ws.close(1008, "rate limit"))
            return False
        return client.msg_count <= limit

    async def _on_disconnect(self, client: Client):
        client.connected = False
        client.disconnected_at = now()
        log.info("client %s (%s) disconnected", client.id, client.name)
        room = client.room
        if not room:
            self._forget_later(client)
            return
        m = room.match
        if m and room.phase in ("starting", "playing") and client.id in m.state["players"]:
            # keep the slot for a while so the player can reconnect
            events = R.remove_player(m.state, client.id)
            await self.broadcast(room, {"t": "player_left", "id": client.id})
            for ev in events:
                await self.broadcast(room, {"t": "event", "ev": ev})
            await self.broadcast(room, {"t": "rules", "rules": m.snapshot()})
            asyncio.ensure_future(self._expire(client))
        else:
            await self.leave_room(client)
            self._forget_later(client)

    async def _expire(self, client: Client):
        await asyncio.sleep(RECONNECT_GRACE)
        if not client.connected:
            if client.room:
                await self.leave_room(client)
            self._forget(client)

    def _forget_later(self, client):
        async def later():
            await asyncio.sleep(RECONNECT_GRACE)
            if not client.connected:
                self._forget(client)
        asyncio.ensure_future(later())

    def _forget(self, client):
        self.clients.pop(client.id, None)
        if self.by_token.get(client.token) is client:
            self.by_token.pop(client.token, None)

    # ------------------------------------------------------------------ dispatch
    async def dispatch(self, c: Client, msg: dict):
        t = msg.get("t")
        handler = getattr(self, f"on_{t}", None) if isinstance(t, str) and t.isidentifier() else None
        if not handler:
            await c.send({"t": "error", "code": "unknown", "msg": f"Unknown message {t!r}"})
            return
        await handler(c, msg)

    async def on_ping(self, c, msg):
        cv = msg.get("c")
        await c.send({"t": "pong", "c": cv if isinstance(cv, (int, float)) else 0, "s": now()})

    async def on_list_rooms(self, c, msg):
        """Lobby browser: public lobbies only, open lobbies first, then the fullest."""
        rooms = [r.summary() for r in self.rooms.values() if r.public]
        rooms.sort(key=lambda r: (r["phase"] != "lobby", r["players"] >= r["max"], -r["players"]))
        await c.send({"t": "rooms", "rooms": rooms[:50]})

    def _valid_mode(self, m):
        return m if m in ONLINE_MODES else "classic"

    def _valid_map(self, m):
        return m if m in self.maps else self.maps[0]

    def _new_code(self):
        while True:
            code = "".join(random.choice(CODE_ALPHABET) for _ in range(5))
            if code not in self.rooms:
                return code

    async def on_create_room(self, c, msg):
        if c.room:
            await self.leave_room(c)
        room = Room(self._new_code(), bool(msg.get("public", True)), self._valid_mode(msg.get("mode")),
                    self._valid_map(msg.get("map")), self.cfg["match"]["maxPlayers"])
        room.name = clean_room_name(msg.get("name"), f"{c.name}'s lobby")
        self.rooms[room.code] = room
        log.info("room %s created by %s (%s, %s, %s)", room.code, c.id, "public" if room.public else "private", room.mode, room.map)
        await self.join(c, room)

    async def on_join_room(self, c, msg):
        code = msg.get("code")
        room = self.rooms.get(code.upper()) if isinstance(code, str) else None
        if not room:
            await c.send({"t": "error", "code": "no_room", "msg": "No room with that code."})
            return
        if room is c.room:
            await c.send({"t": "room", "room": room.view()})
            return
        if room.banned.get(c.token, 0) > now():
            await c.send({"t": "error", "code": "kicked", "msg": "The host removed you from that lobby. Try again later."})
            return
        if len(room.players) >= room.max:
            await c.send({"t": "error", "code": "full", "msg": "That room is full."})
            return
        if c.room:
            await self.leave_room(c)
        await self.join(c, room)

    async def on_rejoin(self, c, msg):
        if c.room:
            await c.send({"t": "room", "room": c.room.view()})
        else:
            await self.on_join_room(c, msg)

    async def on_quick_play(self, c, msg):
        if c.room:
            await self.leave_room(c)
        candidates = [r for r in self.rooms.values() if r.public and r.phase == "lobby" and len(r.players) < r.max]
        if candidates:
            candidates.sort(key=lambda r: -len(r.players))
            await self.join(c, candidates[0])
        else:
            await self.on_create_room(c, {"public": True, "mode": msg.get("mode"), "map": msg.get("map")})

    async def join(self, c: Client, room: Room):
        room.players[c.id] = c
        room.ready[c.id] = False
        c.room = room
        if room.host is None or room.host not in room.players:
            room.host = c.id
        log.info("%s joined room %s (%d players)", c.id, room.code, len(room.players))
        await c.send({"t": "chat_history", "code": room.code, "list": room.chat})
        await self.broadcast_room(room)
        await self.system_chat(room, f"{c.name} joined the lobby")

    async def leave_room(self, c: Client):
        room = c.room
        if not room:
            return
        room.players.pop(c.id, None)
        room.ready.pop(c.id, None)
        c.room = None
        if c.connected:
            await c.send({"t": "left_room"})
        m = room.match
        if m and c.id in m.state["players"] and m.state["players"][c.id]["connected"]:
            events = R.remove_player(m.state, c.id)
            await self.broadcast(room, {"t": "player_left", "id": c.id})
            for ev in events:
                await self.broadcast(room, {"t": "event", "ev": ev})
        if not room.players:
            if room.match and room.match.task:
                room.match.task.cancel()
            self.rooms.pop(room.code, None)
            log.info("room %s closed", room.code)
            return
        new_host = None
        if room.host == c.id:
            room.host = next(iter(room.players))
            new_host = room.players[room.host].name
        await self.broadcast_room(room)
        await self.system_chat(room, f"{c.name} left the lobby")
        if new_host:
            await self.system_chat(room, f"{new_host} is now the host")

    async def on_leave_room(self, c, msg):
        await self.leave_room(c)

    async def on_ready(self, c, msg):
        room = c.room
        if not room or room.phase not in ("lobby", "results"):
            return
        room.ready[c.id] = bool(msg.get("ready"))
        await self.broadcast_room(room)

    async def on_room_settings(self, c, msg):
        room = c.room
        if not room or room.host != c.id or room.phase != "lobby":
            await c.send({"t": "error", "code": "not_host", "msg": "Only the host can change room settings."})
            return
        if "mode" in msg:
            room.mode = self._valid_mode(msg["mode"])
        if "map" in msg:
            room.map = self._valid_map(msg["map"])
        if "name" in msg:
            room.name = clean_room_name(msg["name"], room.name)
        if "public" in msg:
            room.public = msg["public"] in (True, "true", 1)
        if "max" in msg:
            try:
                want = int(msg["max"])
            except (TypeError, ValueError):
                want = room.max
            # never below the players already inside, never above the server limit
            room.max = max(len(room.players), self.cfg["match"]["minPlayersOnline"], min(want, self.cfg["match"]["maxPlayers"]))
        await self.broadcast_room(room)

    async def on_profile(self, c, msg):
        """Name / outfit changed in the menus while connected."""
        if "name" in msg:
            c.name = clean_name(msg.get("name"))
        if "cosm" in msg:
            c.cosm = clean_cosmetics(msg.get("cosm"))
        room = c.room
        if room and room.phase in ("lobby", "results"):
            await self.broadcast_room(room)

    # ------------------------------------------------------------------ social: chat, friends, invites, kick
    async def system_chat(self, room: Room, text: str):
        await self._post_chat(room, {"id": None, "name": "", "text": text, "system": True})

    async def _post_chat(self, room: Room, entry: dict):
        entry["ts"] = int(time.time() * 1000)
        room.chat.append(entry)
        del room.chat[:-CHAT_HISTORY]
        await self.broadcast(room, {"t": "chat", "code": room.code, "msg": entry})

    async def on_chat(self, c, msg):
        room = c.room
        text = clean_chat(msg.get("text"))
        if not room or not text:
            return
        t = now()
        # at most ~1 message / 0.5 s with a burst of 4: friendly but spam-proof
        c.chat_burst = max(0, c.chat_burst - int((t - c.last_chat) / 0.5))
        if c.chat_burst >= 4:
            await c.send({"t": "error", "code": "chat_slow", "msg": "Slow down a little!"})
            return
        c.chat_burst += 1
        c.last_chat = t
        await self._post_chat(room, {"id": c.id, "name": c.name, "text": text})

    async def on_friends_status(self, c, msg):
        """Presence for the friend codes the client asks about. Private lobby codes are only
        revealed to players who were invited to that lobby."""
        tags = msg.get("tags")
        if not isinstance(tags, list):
            return
        wanted = {t for t in tags[:100] if isinstance(t, str) and TAG_RE.match(t)}
        found: dict[str, dict] = {}
        for other in self.clients.values():
            if not other.connected or other.tag not in wanted or other is c:
                continue
            entry = {"tag": other.tag, "online": True, "name": other.name, "room": None}
            room = other.room
            if room:
                s = room.summary()
                if not (room.public or c.tag in room.invited or room is c.room):
                    s["code"] = None  # private: visible as "in a private lobby" but not joinable
                entry["room"] = s
            # prefer the entry that is in a room (a player may have two tabs open)
            if other.tag not in found or (entry["room"] and not found[other.tag]["room"]):
                found[other.tag] = entry
        out = [found.get(t, {"tag": t, "online": False}) for t in sorted(wanted)]
        await c.send({"t": "friends", "list": out})

    async def on_invite(self, c, msg):
        room = c.room
        tag = msg.get("tag")
        if not room or not isinstance(tag, str) or not TAG_RE.match(tag):
            await c.send({"t": "error", "code": "invite", "msg": "Create or join a lobby before inviting friends."})
            return
        t = now()
        if t - c.last_invite < 0.5:
            return
        c.last_invite = t
        room.invited.add(tag)
        targets = [o for o in self.clients.values() if o.connected and o.tag == tag and o is not c]
        payload = {"t": "invited", "from": {"name": c.name, "tag": c.tag}, "room": room.summary()}
        for o in targets:
            await o.send(payload)
        await c.send({"t": "invite_sent", "tag": tag, "delivered": bool(targets)})
        if targets:
            await self.system_chat(room, f"{c.name} invited {targets[0].name}")

    async def on_kick(self, c, msg):
        room = c.room
        target_id = msg.get("id")
        if not room or room.host != c.id:
            await c.send({"t": "error", "code": "not_host", "msg": "Only the host can remove players."})
            return
        target = room.players.get(target_id) if isinstance(target_id, str) else None
        if not target or target is c:
            return
        room.banned[target.token] = now() + KICK_BAN_SECONDS
        room.invited.discard(target.tag)
        await target.send({"t": "kicked", "code": room.code, "msg": f"The host removed you from \"{room.name}\"."})
        await self.leave_room(target)

    async def on_start_match(self, c, msg):
        room = c.room
        if not room or room.host != c.id:
            await c.send({"t": "error", "code": "not_host", "msg": "Only the host can start the match."})
            return
        if room.phase != "lobby":
            return
        present = [p for p in room.players.values() if p.connected]
        if len(present) < self.cfg["match"]["minPlayersOnline"]:
            await c.send({"t": "error", "code": "players", "msg": f"Need at least {self.cfg['match']['minPlayersOnline']} players."})
            return
        if not all(room.ready.get(p.id) for p in present):
            await c.send({"t": "error", "code": "not_ready", "msg": "Everyone must be ready."})
            return
        room.phase = "starting"
        room.match = Match(room, self.cfg)
        for pid in room.ready:  # everyone must ready up again for the next match
            room.ready[pid] = False
        log.info("room %s starting %s on %s with %d players", room.code, room.mode, room.map, len(present))
        await self.broadcast_room(room)
        await self.broadcast(room, room.match.start_message())
        room.match.task = asyncio.ensure_future(self.run_match(room, room.match))

    async def on_loaded(self, c, msg):
        room = c.room
        if room and room.match and msg.get("matchId") == room.match.id:
            room.match.loaded.add(c.id)
            if c.id in room.match.loadouts:
                # NOTE: what a player owns lives in their browser profile (there are no accounts),
                # so the server can only enforce the loadout SHAPE, cooldowns and every effect.
                room.match.loadouts[c.id] = clean_loadout(msg.get("loadout"))

    # ------------------------------------------------------------------ abilities
    async def on_ability(self, c, msg):
        """Validate an ability use (equipped, off cooldown, legal target), grant the movement it
        needs so the movement validator accepts it, apply server-side effects (shockwave
        knockback) and relay it so everyone else sees it."""
        room = c.room
        m = room.match if room else None
        aid = msg.get("id")
        if not m or aid not in ABILITY_IDS or c.id not in m.motion:
            return
        st = m.state
        p = st["players"].get(c.id)
        deny = None
        if st["phase"] != "playing" or not p or p["out"] or m.is_frozen(c.id):
            deny = "unavailable"
        elif aid not in m.loadouts.get(c.id, ()):
            deny = "not_equipped"
        a = self.cfg["abilities"][aid]
        t = now()
        if not deny and t - m.ability_t[c.id].get(aid, -1e9) < a["cooldown"] * 0.9:
            deny = "cooldown"
        mo = m.motion[c.id]
        data = {}
        if not deny:
            if aid == "blink":
                to = _vec3(msg.get("to"))
                r = self.cfg["movement"]["radius"] * 0.6
                d = math.hypot(to[0] - mo.pos[0], to[2] - mo.pos[2]) if to else 1e9
                # tolerance: the client may be up to one send interval + latency ahead of us
                if not to or d > a["range"] + 3.0 or abs(to[1] - mo.pos[1]) > 3.0 or not m.map.in_bounds(*to) or not m.map.is_free(to[0], to[1] + 0.1, to[2], r, 0.8):
                    deny = "blocked"
                else:
                    mo.grant(t, 0.8, dist=d + 1.0, vy=4.0)
                    data = {"from": [round(x, 2) for x in mo.pos], "to": [round(x, 2) for x in to]}
            elif aid == "rocket":
                mo.grant(t, 1.8, speed=a["forward"] + 3.0, vy=a["velocity"] + 4.0)
            elif aid == "grapple":
                anchor = _vec3(msg.get("anchor"))
                if not anchor or math.dist(anchor, (mo.pos[0], mo.pos[1] + 1, mo.pos[2])) > a["range"] + 3.0 or not m.map.in_bounds(*anchor):
                    deny = "no_target"
                else:
                    mo.grant(t, a["maxTime"] + 0.6, speed=a["speed"], vy=a["speed"])
                    data = {"anchor": [round(x, 2) for x in anchor]}
            elif aid == "cloak":
                data = {"duration": a["duration"]}
            elif aid == "decoy":
                d = msg.get("dir")
                dx, dz = (d[0], d[1]) if isinstance(d, list) and len(d) == 2 and all(isinstance(x, (int, float)) and math.isfinite(x) for x in d) else (0.0, 1.0)
                n = math.hypot(dx, dz) or 1.0
                data = {"pos": [round(x, 2) for x in mo.pos], "dir": [round(dx / n, 3), round(dz / n, 3)]}
            elif aid == "shockwave":
                await self._shockwave(room, m, c.id, a)
        if deny:
            await c.send({"t": "ability_denied", "id": aid, "reason": deny})
            return
        m.ability_t[c.id][aid] = t
        await self.broadcast(room, {"t": "ability", "id": aid, "by": c.id, "data": data}, exclude=c.id)
        if aid == "scramble":
            await self._scramble(room, m, c.id, a)

    async def _scramble(self, room, m, src, a):
        """Scramble: the server picks who is hit (in range, roughly level, in line of sight) and how
        their controls are mixed up; every client shows it and each victim's client applies it to
        its own input. Movement validation needs no allowance: scrambled players move normally."""
        so = m.motion[src]
        hits = []
        for pid, mo in m.motion.items():
            p = m.state["players"].get(pid)
            if pid == src or not p or p["out"] or not p["connected"]:
                continue
            d = math.hypot(mo.pos[0] - so.pos[0], mo.pos[2] - so.pos[2])
            if d > a["radius"] + 0.5 or abs(mo.pos[1] - so.pos[1]) > 3.5:
                continue
            if not m.map.line_of_sight((so.pos[0], so.pos[1] + 1.0, so.pos[2]), (mo.pos[0], mo.pos[1] + 1.0, mo.pos[2])):
                continue
            hits.append([pid, random.choice(SCRAMBLE_MODES)])
        await self.broadcast(room, {"t": "scramble", "by": src, "hits": hits, "dur": a["duration"]})

    async def _shockwave(self, room, m, src, a):
        """Knock back everyone near the caster: the server decides who is hit and how hard, sends
        each victim an impulse and grants them the extra speed so their movement validates."""
        so = m.motion[src]
        t = now()
        for pid, mo in m.motion.items():
            p = m.state["players"].get(pid)
            if pid == src or not p or p["out"] or not p["connected"]:
                continue
            dx, dz, dy = mo.pos[0] - so.pos[0], mo.pos[2] - so.pos[2], mo.pos[1] - so.pos[1]
            d = math.hypot(dx, dz)
            if d > a["radius"] + 0.5 or abs(dy) > 3:
                continue
            k = 1 - min(1.0, d / a["radius"]) * 0.5
            nx, nz = (dx / d, dz / d) if d > 0.01 else (1.0, 0.0)
            v = [round(nx * a["force"] * k, 2), round(a["lift"] * k, 2), round(nz * a["force"] * k, 2)]
            mo.grant(t, 1.5, speed=a["force"] + 2.0, vy=a["lift"] + 4.0)
            target = room.players.get(pid)
            if target:
                await target.send({"t": "impulse", "v": v, "by": src})

    # ------------------------------------------------------------------ map coins
    async def on_pickup(self, c, msg):
        room = c.room
        m = room.match if room else None
        cid = msg.get("id")
        if not m or not isinstance(cid, str) or c.id not in m.motion:
            return
        coin = m.coins.get(cid)
        ok = False
        if coin and m.state["phase"] == "playing":
            cc = self.cfg["coins"]
            mo = m.motion[c.id]
            t = now()
            # lag tolerance: any accepted position from the last 0.4 s counts
            samples = [h[1:] for h in mo.history if t - h[0] <= 0.4] or [mo.pos]
            r = cc["pickupRadius"] + 0.8
            ok = any(math.hypot(s[0] - coin[0], s[2] - coin[2]) <= r and abs(s[1] + 0.9 - coin[1]) <= 1.9 for s in samples)
            ok = ok and R.collect_coin(m.state, c.id)
        if not ok:
            await c.send({"t": "coin_denied", "id": cid})
            return
        del m.coins[cid]
        if cid in m.bonus_coins:
            m.bonus_coins.discard(cid)
        else:
            m.coin_respawns.append(now() + self.cfg["coins"]["respawn"])
        await self.broadcast(room, {"t": "coin_taken", "id": cid, "by": c.id})

    async def _coin_respawns(self, room, m):
        t = now()
        due = [x for x in m.coin_respawns if x <= t]
        if not due:
            return
        m.coin_respawns = [x for x in m.coin_respawns if x > t]
        for _ in due:
            cid = m.spawn_coin()
            if cid:
                await self.broadcast(room, {"t": "coin_spawn", "id": cid, "p": m.coins[cid]})

    async def on_state(self, c, msg):
        room = c.room
        m = room.match if room else None
        if not m or room.phase not in ("starting", "playing") or c.id not in m.motion:
            return
        if m.state["players"][c.id]["out"]:
            return
        motion = m.motion[c.id]
        t = now()
        frozen = m.is_frozen(c.id)
        ok, reason = m.validator.validate(motion, msg, t, frozen)
        if ok:
            m.validator.accept(motion, msg, t, frozen)
        else:
            motion.violations += 1
            motion.last_time = t
            if motion.violations % 10 == 1:
                log.warning("movement rejected for %s: %s (violations=%d)", c.id, reason, motion.violations)
            await c.send({"t": "correct", "p": motion.pos, "reason": reason})

    async def on_respawn(self, c, msg):
        room = c.room
        m = room.match if room else None
        if not m or c.id not in m.motion:
            return
        motion = m.motion[c.id]
        if motion.pos[1] > m.map.kill_y + 6:
            return  # not actually fallen
        s = random.choice(m.map.spawns)
        motion.pos = list(s)
        motion.anchor = list(s)
        motion.history.append((now(), *s))
        R.protect(m.state, c.id)
        await c.send({"t": "correct", "p": list(s), "reason": "respawn"})

    async def on_tag(self, c, msg):
        room = c.room
        m = room.match if room else None
        if not m or m.state["phase"] != "playing":
            return
        target = msg.get("target")
        if not isinstance(target, str) or target not in m.motion:
            return
        t = now()
        if t - m.last_tag_req.get(c.id, 0) < 0.08:
            return  # duplicate / spammed request
        m.last_tag_req[c.id] = t
        if not self._in_tag_range(m, c.id, target, lag_comp=True):
            return
        await self._apply_tag(room, m, c.id, target)

    def _in_tag_range(self, m: Match, a: str, b: str, lag_comp: bool) -> bool:
        tag = self.cfg["tag"]
        ma, mb = m.motion[a], m.motion[b]
        rng = tag["range"] + (tag["serverRangeTolerance"] if lag_comp else 0.15)
        grace = tag["latencyGraceMs"] / 1000.0
        t = now()
        samples_a = [h for h in ma.history if t - h[0] <= grace] or [(t, *ma.pos)]
        samples_b = [h for h in mb.history if t - h[0] <= grace] or [(t, *mb.pos)]
        if not lag_comp:
            samples_a, samples_b = [(t, *ma.pos)], [(t, *mb.pos)]
        for ha in samples_a:
            for hb in samples_b:
                if abs(ha[0] - hb[0]) > 0.15 and lag_comp:
                    continue
                dx, dy, dz = hb[1] - ha[1], hb[2] - ha[2], hb[3] - ha[3]
                if dx * dx + dz * dz <= rng * rng and abs(dy) <= 1.9:
                    if m.map.line_of_sight((ha[1], ha[2] + 1.0, ha[3]), (hb[1], hb[2] + 1.0, hb[3])):
                        return True
        return False

    # ------------------------------------------------------------------ perfect dodge
    async def on_dodge(self, c, msg):
        """The client started a dodge: open the perfect-dodge window (server-side cooldown so a
        client cannot spam dodges to stay permanently inside the window)."""
        room = c.room
        m = room.match if room else None
        if not m or m.state["phase"] != "playing" or c.id not in m.motion:
            return
        motion = m.motion[c.id]
        t = now()
        if t - getattr(motion, "last_dodge", -1e9) < self.cfg["movement"]["dodgeCooldown"] * 0.9:
            return
        motion.last_dodge = t
        motion.dodge_at = t

    def _in_dodge_window(self, m, pid):
        pd = self.cfg["perfectDodge"]
        at = getattr(m.motion[pid], "dodge_at", None)
        return at is not None and now() - at <= pd["window"] + pd["netGrace"]

    async def _perfect_dodges(self, room, m):
        """Near-miss check: an IT lunging at a runner inside the runner's dodge window."""
        pd = self.cfg["perfectDodge"]
        rng = self.cfg["tag"]["range"]
        st = m.state
        for b in list(st["order"]):
            if b not in m.motion or not self._in_dodge_window(m, b):
                continue
            pb = st["players"][b]
            if pb["it"] or pb["out"] or not pb["connected"]:
                continue
            mb = m.motion[b]
            for a in st["order"]:
                pa = st["players"][a]
                if a == b or not pa["it"] or pa["out"] or not pa["connected"] or a not in m.motion:
                    continue
                ma = m.motion[a]
                dx, dz = mb.pos[0] - ma.pos[0], mb.pos[2] - ma.pos[2]
                d = math.hypot(dx, dz)
                if d > rng + pd["nearMiss"] + self.cfg["tag"]["serverRangeTolerance"] or abs(mb.pos[1] - ma.pos[1]) > 1.8:
                    continue
                closing = (ma.vel[0] * dx + ma.vel[2] * dz) / d if d > 1e-3 else 99.0
                if d > rng and closing < pd["closingSpeed"]:
                    continue
                if not m.map.line_of_sight((ma.pos[0], ma.pos[1] + 1.0, ma.pos[2]), (mb.pos[0], mb.pos[1] + 1.0, mb.pos[2])):
                    continue
                if await self._apply_perfect_dodge(room, m, a, b):
                    break

    async def _apply_perfect_dodge(self, room, m, a, b):
        pd = self.cfg["perfectDodge"]
        res = R.perfect_dodge(m.state, a, b, delay=pd["onlineAnimTime"], stun=pd["stunTime"], boost=pd["boostTime"], protect=pd["protectTime"], cooldown=pd["cooldown"])
        if not res["ok"]:
            return False
        m.motion[b].dodge_at = None  # one perfect dodge per dodge
        log.info("room %s: %s PERFECT-DODGED %s", room.code, b, a)
        for ev in res["events"]:
            await self.broadcast(room, {"t": "event", "ev": ev})
        await self.broadcast(room, {"t": "rules", "rules": m.snapshot()})
        return True

    async def _apply_tag(self, room, m, a, b):
        # a touch during the target's perfect-dodge window is evaded instead of tagged
        if b in m.motion and self._in_dodge_window(m, b) and await self._apply_perfect_dodge(room, m, a, b):
            return False
        res = R.apply_tag(m.state, a, b)
        if not res["ok"]:
            return False
        log.info("room %s: %s tagged %s", room.code, a, b)
        for ev in res["events"]:
            await self.broadcast(room, {"t": "event", "ev": ev})
        await self.broadcast(room, {"t": "rules", "rules": m.snapshot()})
        return True

    async def on_emote(self, c, msg):
        e = msg.get("e")
        if c.room and e in EMOTE_IDS:
            await self.broadcast(c.room, {"t": "emote", "id": c.id, "e": e}, exclude=c.id)

    # ------------------------------------------------------------------ match loop
    async def run_match(self, room: Room, m: Match):
        try:
            # wait (up to 10 s) for every client to load the map before the countdown runs
            t0 = now()
            # up to 16 s: loading + shader warm-up + the map intro cutscene (players can skip it)
            while now() - t0 < 16 and not set(m.roster_ids).issubset(m.loaded | {pid for pid in m.roster_ids if not m.state["players"][pid]["connected"]}):
                await asyncio.sleep(0.05)
            room.phase = "playing"
            await self.broadcast_room(room)
            await self.broadcast(room, {"t": "rules", "rules": m.snapshot()})
            last = now()
            snap_t = 0.0
            rules_t = 0.0
            dt_target = 1.0 / self.tick_hz
            while m.state["phase"] != "ended" and room.code in self.rooms:
                await asyncio.sleep(dt_target)
                t = now()
                dt = min(0.1, t - last)
                last = t
                prev_phase = m.state["phase"]
                events = R.tick(m.state, dt)
                for ev in events:
                    await self.broadcast(room, {"t": "event", "ev": ev})
                if m.state["phase"] == "playing":
                    await self._perfect_dodges(room, m)
                    await self._auto_tags(room, m)
                    await self._coin_respawns(room, m)
                    if m.state.get("zone"):
                        await self._zone_check(room, m, dt)
                    await self._map_events(room, m)
                rules_t += dt
                if events or rules_t >= 0.25 or prev_phase != m.state["phase"]:
                    rules_t = 0.0
                    await self.broadcast(room, {"t": "rules", "rules": m.snapshot()})
                snap_t += dt
                if snap_t >= 1.0 / self.snap_hz:
                    snap_t = 0.0
                    await self._send_snapshot(room, m)
            if room.code not in self.rooms:
                return
            await self._finish(room, m)
        except asyncio.CancelledError:
            pass
        except Exception:  # noqa: BLE001
            log.exception("match loop crashed in room %s", room.code)
            room.phase = "lobby"
            room.match = None
            await self.broadcast(room, {"t": "error", "code": "match", "msg": "The match ended because of a server error."})
            await self.broadcast_room(room)

    async def _map_events(self, room, m):
        """Schedule map events (mirrors EventScheduler in mapEvents.js) and run coin rain."""
        me = self.cfg["mapEvents"]
        if not m.event_kinds:
            return
        t = m.state["time"]
        changed = False
        if m.event and t >= m.event["end"]:
            m.event = None
            m.next_event_at = t + random.uniform(*me["gap"])
            changed = True
        if not m.event and t >= m.next_event_at - me["warn"]:
            dur = m.state["duration"]
            if dur > 0 and m.next_event_at + 12 > dur:
                m.next_event_at = math.inf  # too close to the end of the match
            else:
                pool = [k for k in m.event_kinds if k != m.last_event] or m.event_kinds
                kind = random.choice(pool)
                m.last_event = kind
                m.event = {"kind": kind, "start": round(m.next_event_at, 2), "end": round(m.next_event_at + me["events"][kind]["duration"], 2)}
                m.event_fired = False
                changed = True
        if m.event and not m.event_fired and t >= m.event["start"]:
            m.event_fired = True
            if m.event["kind"] == "coinrain":
                for _ in range(me["rainCoins"]):
                    cid = m.spawn_coin(bonus=True)
                    if not cid:
                        break
                    await self.broadcast(room, {"t": "coin_spawn", "id": cid, "p": m.coins[cid], "drop": True})
        if changed:
            await self.broadcast(room, {"t": "rules", "rules": m.snapshot()})

    async def _zone_check(self, room, m, dt):
        """Shrinking Zone: runners outside the ring (server-side positions) are knocked out."""
        z = R.zone_at(m.state)
        events = []
        for pid, mo in m.motion.items():
            outside = math.hypot(mo.pos[0] - z["x"], mo.pos[2] - z["z"]) > z["r"]
            events.extend(R.zone_tick(m.state, pid, dt, outside))
        for ev in events:
            await self.broadcast(room, {"t": "event", "ev": ev})
        if events:
            await self.broadcast(room, {"t": "rules", "rules": m.snapshot()})

    async def _auto_tags(self, room, m):
        """Strict server-side contact detection (no lag compensation) as a backstop."""
        st = m.state
        for a in list(st["order"]):
            pa = st["players"][a]
            if not pa["it"] or pa["out"] or not pa["connected"]:
                continue
            for b in st["order"]:
                pb = st["players"][b]
                if a == b or pb["it"] or pb["out"] or not pb["connected"]:
                    continue
                if R.can_tag(st, a, b)[0] and self._in_tag_range(m, a, b, lag_comp=False):
                    await self._apply_tag(room, m, a, b)
                    break

    async def _send_snapshot(self, room, m):
        rows = []
        for pid, mo in m.motion.items():
            p = m.state["players"].get(pid)
            if not p or not p["connected"]:
                continue
            # last field: when the server received this movement (not when the snapshot goes out),
            # so clients interpolate on the real timing and can use a much smaller delay
            rows.append([pid, round(mo.pos[0], 3), round(mo.pos[1], 3), round(mo.pos[2], 3),
                         round(mo.vel[0], 2), round(mo.vel[1], 2), round(mo.vel[2], 2),
                         round(mo.yaw, 2), mo.st, mo.fl, round(mo.sc, 2), round(mo.last_time, 3)])
        await self.broadcast(room, {"t": "snap", "ts": now(), "p": rows})

    async def _finish(self, room, m):
        result = m.state["result"]
        log.info("room %s match over: %s, winners=%s", room.code, result["reason"], result["winners"])
        room.phase = "results"
        for pid in m.roster_ids:
            c = room.players.get(pid)
            if c and c.connected:
                award = compute_award(result, pid, self.cfg)
                await c.send({"t": "match_end", "result": result, "award": award})
        await self.broadcast_room(room)
        await asyncio.sleep(self.cfg["match"]["resultsTime"] * 0.5)
        if room.code not in self.rooms:
            return
        room.phase = "lobby"
        room.match = None
        await self.broadcast_room(room)

    # ------------------------------------------------------------------ broadcast
    async def broadcast(self, room: Room, obj: dict, exclude: str | None = None):
        data = json.dumps(obj, separators=(",", ":"))
        for c in list(room.players.values()):
            if c.id != exclude and c.connected and c.ws and not c.ws.closed:
                await c.ws.send_text(data)

    async def broadcast_room(self, room: Room):
        await self.broadcast(room, {"t": "room", "room": room.view()})
