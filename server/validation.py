"""Server-side movement validation for online matches.

Clients predict their own movement for responsiveness, then stream positions here. Every
update is checked for: malformed data, leaving the map, impossible speed / teleporting,
being inside solid geometry, and moving while frozen. Rejected updates are not applied and
the client is told to snap back to its last valid position. This blocks the common cheats
(speed hacks, teleports, wall clipping); it is not a claim that cheating is impossible.
"""
from __future__ import annotations

import math
from collections import deque


def _finite(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


class PlayerMotion:
    """Authoritative last-accepted motion state of one player."""

    def __init__(self, pos, yaw, now):
        self.pos = list(pos)
        self.vel = [0.0, 0.0, 0.0]
        self.yaw = yaw
        self.st = 0
        self.fl = 1
        self.sc = 0.0
        self.last_time = now
        self.history = deque(maxlen=40)  # (t, x, y, z) for lag-compensated tag checks
        self.history.append((now, *self.pos))
        self.violations = 0
        self.anchor = list(pos)  # position when frozen
        self.budget = 4.0  # metres of movement currently allowed (see MoveValidator)
        self.pending_budget = self.budget
        # Temporary movement allowance granted by a server-validated ability or knockback
        # (blink distance, grapple / knockback speed, rocket lift). Expires at grant_until.
        self.grant_until = 0.0
        self.grant_dist = 0.0
        self.grant_speed = 0.0
        self.grant_vy = 0.0

    def grant(self, now, duration, dist=0.0, speed=0.0, vy=0.0):
        active = now < self.grant_until
        self.grant_until = max(self.grant_until, now + duration)
        self.grant_dist = max(self.grant_dist if active else 0.0, dist)
        self.grant_speed = max(self.grant_speed if active else 0.0, speed)
        self.grant_vy = max(self.grant_vy if active else 0.0, vy)
        self.budget += dist

    def granted(self, now):
        return now < self.grant_until

    def at(self, t):
        """Position at server time t (nearest history sample)."""
        best = None
        bd = 1e9
        for h in self.history:
            d = abs(h[0] - t)
            if d < bd:
                bd = d
                best = h
        return best[1:] if best else self.pos


class MoveValidator:
    def __init__(self, cfg, mapdata):
        self.cfg = cfg
        self.nv = cfg["netValidation"]
        self.mv = cfg["movement"]
        self.map = mapdata

    def validate(self, motion: PlayerMotion, msg: dict, now: float, frozen: bool):
        p = msg.get("p")
        v = msg.get("v")
        if not (isinstance(p, list) and len(p) == 3 and all(_finite(x) for x in p)):
            return False, "malformed"
        if not (isinstance(v, list) and len(v) == 3 and all(_finite(x) for x in v)):
            return False, "malformed"
        x, y, z = p
        if not self.map.in_bounds(x, y, z):
            return False, "out_of_bounds"
        dt = max(0.0, now - motion.last_time)
        dx, dy, dz = x - motion.pos[0], y - motion.pos[1], z - motion.pos[2]
        horiz = math.hypot(dx, dz)
        max_h = self.nv["maxBurstSpeed"]
        # Token bucket: the distance budget refills at the fastest legitimate sustained speed
        # (a boosted slide) and is capped, so network jitter can bunch updates together but
        # the AVERAGE speed can never exceed what the movement system allows.
        refill = self.mv["slideMaxSpeed"] * self.nv["maxSpeedTolerance"]
        cap = self.nv["teleportDistance"]
        extra_v = extra_vy = 0.0
        if motion.granted(now):
            # an ability is in effect: allow its distance / speed on top of normal movement
            refill += motion.grant_speed * self.nv["maxSpeedTolerance"]
            cap += motion.grant_dist + motion.grant_speed * 0.3
            extra_v, extra_vy = motion.grant_speed, motion.grant_vy
        budget = min(cap, motion.budget + refill * dt)
        if horiz > budget + 0.05:
            return False, "too_fast"
        motion.pending_budget = budget - horiz
        allowed_v = (self.nv["maxVerticalSpeed"] + extra_vy) * (dt + 0.25) + 0.6
        if abs(dy) > allowed_v:
            return False, "too_fast_vertical"
        if math.hypot(v[0], v[2]) > (max_h + extra_v) * self.nv["maxSpeedTolerance"]:
            return False, "velocity"
        if frozen and math.hypot(x - motion.anchor[0], z - motion.anchor[2]) > 1.0:
            return False, "frozen"
        # body (shrunk a little for tolerance) must not be inside solid geometry
        r = self.mv["radius"] * 0.6
        if not self.map.is_free(x, y + 0.1, z, r, 0.8):
            return False, "inside_solid"
        return True, "ok"

    def accept(self, motion: PlayerMotion, msg: dict, now: float, frozen: bool):
        motion.pos = [float(c) for c in msg["p"]]
        motion.vel = [float(c) for c in msg["v"]]
        y = msg.get("y", motion.yaw)
        motion.yaw = float(y) if _finite(y) else motion.yaw
        st = msg.get("st", 0)
        motion.st = int(st) if isinstance(st, int) and 0 <= st <= 6 else 0  # 6 = grapple
        fl = msg.get("fl", 0)
        motion.fl = int(fl) & 3 if isinstance(fl, int) else 0
        sc = msg.get("sc", 0)
        motion.sc = float(sc) if _finite(sc) else 0.0
        motion.last_time = now
        motion.budget = motion.pending_budget
        motion.history.append((now, *motion.pos))
        if not frozen:
            motion.anchor = list(motion.pos)
