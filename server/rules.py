"""Authoritative tag rules for online matches.

This is a line-for-line port of src/gameplay/rules.js. Both implementations are executed
against tests/shared/rules_cases.json (Python: tests/test_rules.py, JS: tests/browser) so
offline and online matches follow identical rules.
"""
from __future__ import annotations

import math

MODES = ("classic", "infection", "elimination", "practice", "hotpotato", "zone")
KNOCKOUT = ("elimination", "hotpotato", "zone")
NEVER = -1e9


def create_match(mode, players, start_it, cfg, countdown=None, zone=None):
    if mode not in MODES:
        raise ValueError(f"Unknown mode {mode}")
    mode_cfg = cfg["modes"][mode]
    cd = cfg["match"]["countdown"] if countdown is None else countdown
    state = {
        "mode": mode,
        "phase": "setup",  # initial players must not be treated as late joiners
        "countdown": cd,
        "time": 0.0,
        "duration": mode_cfg["duration"],
        "tagCfg": cfg["tag"],
        "order": [],
        "players": {},
        "events": [],
        "result": None,
        "tagCount": 0,
    }
    if mode == "hotpotato":
        state["potato"] = {"fuse": mode_cfg["fuse"], "max": mode_cfg["fuse"], "min": mode_cfg["fuseMin"], "step": mode_cfg["fuseStep"], "round": 1}
    if mode == "zone":
        z = zone or {"x0": 0, "z0": 0, "x1": 0, "z1": 0, "r0": 60}
        state["zone"] = {"x0": z["x0"], "z0": z["z0"], "x1": z["x1"], "z1": z["z1"], "r0": z["r0"], "r1": mode_cfg["minRadius"],
                         "hold": mode_cfg["zoneHold"], "end": mode_cfg["zoneEnd"], "limit": mode_cfg["outsideLimit"]}
    for p in players:
        add_player(state, p["id"], p.get("name"))
    state["phase"] = "countdown" if cd > 0 else "playing"
    for pid in start_it:
        if pid in state["players"]:
            state["players"][pid]["it"] = True
            state["players"][pid]["wasIt"] = True
    if state["phase"] == "playing":
        state["events"].append({"type": "start"})
    return state


def add_player(state, pid, name=None):
    if pid in state["players"]:
        state["players"][pid]["connected"] = True
        return state["players"][pid]
    p = {
        "id": pid,
        "name": name or pid,
        "it": False,
        "wasIt": False,
        "out": False,
        "outAt": None,
        "connected": True,
        "tags": 0,
        "tagged": 0,
        "itTime": 0.0,
        "aliveTime": 0.0,
        "lastTagAt": NEVER,
        "frozenUntil": NEVER,
        "protectedUntil": NEVER,
        "noTagBackFrom": None,
        "noTagBackUntil": NEVER,
        "boostUntil": NEVER,
        "perfectDodges": 0,
        "lastPerfectAt": NEVER,
        "coinsPicked": 0,
        "stormTime": 0.0,
    }
    if state["phase"] == "playing":
        if state["mode"] == "infection":
            p["it"] = True
            p["wasIt"] = True
        if state["mode"] in KNOCKOUT:
            p["out"] = True
            p["outAt"] = state["time"]
        p["protectedUntil"] = state["time"] + state["tagCfg"]["spawnProtection"]
    state["players"][pid] = p
    state["order"].append(pid)
    return p


def _live(state):
    return [state["players"][i] for i in state["order"] if state["players"][i]["connected"]]


def it_players(state):
    return [p for p in _live(state) if p["it"] and not p["out"]]


def runners(state):
    return [p for p in _live(state) if not p["it"] and not p["out"]]


def tick(state, dt):
    out = []
    if state["phase"] == "countdown":
        state["countdown"] -= dt
        if state["countdown"] <= 0:
            state["countdown"] = 0
            state["phase"] = "playing"
            out.append({"type": "start"})
    elif state["phase"] == "playing":
        state["time"] += dt
        for p in _live(state):
            if p["out"]:
                continue
            if p["it"]:
                p["itTime"] += dt
            else:
                p["aliveTime"] += dt
        if state.get("potato"):
            state["potato"]["fuse"] -= dt
            if state["potato"]["fuse"] <= 0:
                out.extend(_explode(state))
        if state["phase"] == "playing" and state["duration"] > 0 and state["time"] >= state["duration"]:
            out.extend(end_match(state, "time"))
    state["events"].extend(out)
    return out


def _explode(state):
    """Hot potato fuse ran out. Mirrors explode() in rules.js."""
    evs = []
    for h in it_players(state):
        h["out"] = True
        h["outAt"] = state["time"]
        h["it"] = False
        evs.append({"type": "exploded", "id": h["id"], "time": state["time"]})
    alive = [p for p in _live(state) if not p["out"]]
    pt = state["potato"]
    if len(alive) >= 2:
        nxt = sorted(alive, key=lambda p: (p["itTime"], state["order"].index(p["id"])))[0]
        nxt["it"] = True
        nxt["wasIt"] = True
        nxt["frozenUntil"] = state["time"] + state["tagCfg"]["newItFreeze"]
        nxt["lastTagAt"] = state["time"]
        pt["round"] += 1
        pt["max"] = max(pt["min"], pt["max"] - pt["step"])
        evs.append({"type": "it", "id": nxt["id"], "from": None, "reason": "potato"})
    pt["fuse"] = pt["max"]
    evs.extend(check_end(state))
    return evs


def zone_tick(state, pid, dt, outside):
    """Shrinking zone: runners outside the ring too long are out. Mirrors zoneTick() in rules.js."""
    z = state.get("zone")
    p = state["players"].get(pid)
    if not z or state["phase"] != "playing" or not p or not p["connected"] or p["out"] or p["it"]:
        return []
    if not outside:
        p["stormTime"] = max(0.0, p["stormTime"] - dt * 0.5)
        return []
    p["stormTime"] += dt
    if p["stormTime"] < z["limit"]:
        return []
    p["out"] = True
    p["outAt"] = state["time"]
    ev = {"type": "eliminated", "id": pid, "by": None, "reason": "zone"}
    state["events"].append(ev)
    return [ev] + check_end(state)


def zone_at(state, t=None):
    z = state.get("zone")
    if not z:
        return None
    t = state["time"] if t is None else t
    k = max(0.0, min(1.0, (t - z["hold"]) / (z["end"] - z["hold"])))
    return {"x": z["x0"] + (z["x1"] - z["x0"]) * k, "z": z["z0"] + (z["z1"] - z["z0"]) * k, "r": z["r0"] + (z["r1"] - z["r0"]) * k, "k": k}


def can_tag(state, tagger_id, target_id):
    now = state["time"]
    if state["phase"] != "playing":
        return False, "phase"
    a = state["players"].get(tagger_id)
    b = state["players"].get(target_id)
    if not a or not b or not a["connected"] or not b["connected"]:
        return False, "invalid"
    if tagger_id == target_id:
        return False, "self"
    if not a["it"]:
        return False, "not_it"
    if a["out"]:
        return False, "out"
    if b["out"]:
        return False, "target_out"
    if b["it"]:
        return False, "target_it"
    if now < a["frozenUntil"]:
        return False, "frozen"
    if now < b["protectedUntil"]:
        return False, "protected"
    if now - a["lastTagAt"] < state["tagCfg"]["cooldown"]:
        return False, "cooldown"
    if a["noTagBackFrom"] == target_id and now < a["noTagBackUntil"]:
        return False, "no_tagback"
    return True, "ok"


def apply_tag(state, tagger_id, target_id):
    ok, reason = can_tag(state, tagger_id, target_id)
    if not ok:
        return {"ok": False, "reason": reason, "events": []}
    now = state["time"]
    t = state["tagCfg"]
    a = state["players"][tagger_id]
    b = state["players"][target_id]
    events = []
    a["tags"] += 1
    b["tagged"] += 1
    a["lastTagAt"] = now
    state["tagCount"] += 1
    events.append({"type": "tag", "tagger": tagger_id, "target": target_id, "time": now, "seq": state["tagCount"]})
    mode = state["mode"]
    if mode in ("classic", "practice", "hotpotato"):
        a["it"] = False
        b["it"] = True
        b["wasIt"] = True
        b["frozenUntil"] = now + t["newItFreeze"]
        b["lastTagAt"] = now
        b["noTagBackFrom"] = tagger_id
        b["noTagBackUntil"] = now + t["noTagBackTime"]
        events.append({"type": "it", "id": target_id, "from": tagger_id})
    elif mode == "infection":
        b["it"] = True
        b["wasIt"] = True
        b["frozenUntil"] = now + t["newItFreeze"]
        b["lastTagAt"] = now
        events.append({"type": "infected", "id": target_id, "by": tagger_id})
    elif mode in ("elimination", "zone"):
        b["out"] = True
        b["outAt"] = now
        events.append({"type": "eliminated", "id": target_id, "by": tagger_id})
    state["events"].extend(events)
    events.extend(check_end(state))
    return {"ok": True, "reason": "ok", "events": events}


def perfect_dodge(state, tagger_id, dodger_id, delay=0.0, stun=1.0, boost=5.0, protect=1.5, cooldown=0.0):
    """The dodger evaded a tag that would have been legal. Mirrors perfectDodge() in rules.js."""
    ok, reason = can_tag(state, tagger_id, dodger_id)
    if not ok:
        return {"ok": False, "reason": reason, "events": []}
    now = state["time"]
    if now - state["players"][dodger_id]["lastPerfectAt"] < cooldown:
        return {"ok": False, "reason": "dodge_cooldown", "events": []}
    a = state["players"][tagger_id]
    b = state["players"][dodger_id]
    a["frozenUntil"] = max(a["frozenUntil"], now + delay + stun)
    a["lastTagAt"] = now
    b["boostUntil"] = now + delay + boost
    b["protectedUntil"] = max(b["protectedUntil"], now + delay + protect)
    b["perfectDodges"] += 1
    b["lastPerfectAt"] = now
    ev = {"type": "perfect_dodge", "tagger": tagger_id, "dodger": dodger_id, "time": now, "delay": delay, "stun": stun, "boost": boost}
    state["events"].append(ev)
    return {"ok": True, "reason": "ok", "events": [ev]}


def collect_coin(state, pid):
    """A player grabbed a gold coin on the map. Mirrors collectCoin() in rules.js."""
    p = state["players"].get(pid)
    if state["phase"] != "playing" or not p or not p["connected"] or p["out"]:
        return False
    p["coinsPicked"] += 1
    return True


def force_it(state, pid):
    if state["mode"] != "practice" or pid not in state["players"]:
        return False
    for p in state["players"].values():
        p["it"] = False
    p = state["players"][pid]
    p["it"] = True
    p["wasIt"] = True
    p["lastTagAt"] = state["time"]
    state["events"].append({"type": "it", "id": pid, "from": None})
    return True


def protect(state, pid, seconds=None):
    p = state["players"].get(pid)
    if p:
        p["protectedUntil"] = state["time"] + (state["tagCfg"]["spawnProtection"] if seconds is None else seconds)


def remove_player(state, pid):
    p = state["players"].get(pid)
    if not p or not p["connected"]:
        return []
    p["connected"] = False
    out = []
    if state["phase"] == "ended":
        return out
    if p["it"] and not p["out"] and len(it_players(state)) == 0:
        idx = state["order"].index(pid)
        n = len(state["order"])
        for k in range(1, n + 1):
            q = state["players"][state["order"][(idx + k) % n]]
            if q["connected"] and not q["out"] and not q["it"]:
                q["it"] = True
                q["wasIt"] = True
                q["frozenUntil"] = state["time"] + state["tagCfg"]["newItFreeze"]
                q["lastTagAt"] = state["time"]
                out.append({"type": "it", "id": q["id"], "from": None, "reason": "disconnect"})
                break
    state["events"].extend(out)
    out.extend(check_end(state))
    return out


def check_end(state):
    if state["phase"] not in ("playing", "countdown"):
        return []
    players = _live(state)
    if state["mode"] == "practice":
        return []
    if len(players) < 2:
        return end_match(state, "players")
    if state["phase"] != "playing":
        return []
    if state["mode"] == "infection" and len(runners(state)) == 0:
        return end_match(state, "all_infected")
    if state["mode"] in ("elimination", "zone"):
        alive = runners(state)
        if len(alive) <= 1:
            return end_match(state, "last_runner" if len(alive) == 1 else "all_out")
    if state["mode"] == "hotpotato":
        alive = [p for p in players if not p["out"]]
        if len(alive) <= 1:
            return end_match(state, "last_runner" if len(alive) == 1 else "all_out")
    return []


def end_match(state, reason):
    if state["phase"] == "ended":
        return []
    state["phase"] = "ended"
    state["result"] = compute_result(state, reason)
    ev = {"type": "end", "reason": reason, "winners": state["result"]["winners"], "team": state["result"]["team"]}
    state["events"].append(ev)
    return [ev]


def compute_result(state, reason):
    allp = [state["players"][i] for i in state["order"]]
    winners = []
    team = None
    mode = state["mode"]
    if mode in ("classic", "practice"):
        ranked = sorted(allp, key=lambda p: (_gone(p), p["itTime"], -p["tags"], p["id"]))
        pool = [p for p in ranked if p["connected"]]
        if pool:
            best = pool[0]["itTime"]
            winners = [p["id"] for p in pool if abs(p["itTime"] - best) < 1e-6 and p["tags"] == pool[0]["tags"]]
    elif mode == "infection":
        survivors = [p for p in allp if not p["it"] and p["connected"]]
        if survivors:
            team = "runners"
            winners = [p["id"] for p in survivors]
        else:
            team = "infected"
            winners = [p["id"] for p in allp if p["it"] and p["connected"]]
        ranked = sorted(allp, key=lambda p: (_gone(p), int(p["it"]), -p["aliveTime"], -p["tags"], p["id"]))
    elif mode == "hotpotato":
        winners = [p["id"] for p in allp if not p["out"] and p["connected"]]
        ranked = sorted(allp, key=lambda p: (0 if p["id"] in winners else 1, _gone(p), -(p["outAt"] if p["out"] else math.inf), p["itTime"], p["id"]))
    else:
        alive = [p for p in allp if not p["it"] and not p["out"] and p["connected"]]
        if alive:
            team = "runners"
            winners = [p["id"] for p in alive]
        else:
            team = "hunters"
            winners = [p["id"] for p in allp if p["it"] and p["connected"]]
        ranked = sorted(allp, key=lambda p: (0 if p["id"] in winners else 1, _gone(p), -p["aliveTime"], -p["tags"], p["id"]))
    return {
        "reason": reason,
        "mode": mode,
        "duration": state["time"],
        "team": team,
        "winners": winners,
        "ranking": [
            {
                "id": p["id"],
                "name": p["name"],
                "place": i + 1,
                "tags": p["tags"],
                "tagged": p["tagged"],
                "itTime": _r2(p["itTime"]),
                "survival": _r2(p["aliveTime"]),
                "out": p["out"],
                "it": p["it"],
                "connected": p["connected"],
                "dodges": p["perfectDodges"],
                "coins": p["coinsPicked"],
                "winner": p["id"] in winners,
            }
            for i, p in enumerate(ranked)
        ],
    }


def _gone(p):
    """Players who left the match are always ranked below everyone still connected."""
    return 0 if p["connected"] else 1


def snapshot(state):
    t = state["time"]
    snap = {
        "mode": state["mode"],
        "phase": state["phase"],
        "countdown": _r2(state["countdown"]),
        "time": _r2(t),
        "duration": state["duration"],
        "players": [
            {
                "id": pid,
                "it": p["it"],
                "out": p["out"],
                "tags": p["tags"],
                "itTime": _r2(p["itTime"]),
                "alive": _r2(p["aliveTime"]),
                "c": p["connected"],
                "fz": _r2(max(0.0, p["frozenUntil"] - t)),
                "pr": _r2(max(0.0, p["protectedUntil"] - t)),
                "bo": _r2(max(0.0, p["boostUntil"] - t)),
                "pd": p["perfectDodges"],
                "co": p["coinsPicked"],
                "st": _r2(p["stormTime"]),
            }
            for pid, p in ((i, state["players"][i]) for i in state["order"])
        ],
    }
    if state.get("potato"):
        pt = state["potato"]
        snap["potato"] = {"fuse": _r2(pt["fuse"]), "max": pt["max"], "round": pt["round"]}
    if state.get("zone"):
        snap["zone"] = dict(state["zone"])
    return snap


def time_left(state):
    return max(0.0, state["duration"] - state["time"]) if state["duration"] > 0 else float("inf")


def _r2(v):
    # match JavaScript's Math.round(v * 100) / 100 (round half up, not banker's rounding)
    return math.floor(v * 100 + 0.5) / 100
