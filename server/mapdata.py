"""Server-side map collision built from the SAME assets/maps/*.json the client renders.

Validation uses is_free / point_solid / line_of_sight / in_bounds. The character queries
(ground_below, resolve_horizontal, ceiling_between, obstacle_top, raycast, clamp_to_bounds)
are a line-for-line port of src/movement/collision.js so the server-side bot controller
(server/controller.py) collides exactly like the client. Broad-phase query ORDER matters for
resolve_horizontal (sequential push-outs), so query() visits colliders in the same order as
CollisionWorld.query(): big colliders first, then grid cells x-major. Parity is checked by
tests/shared/movement_cases.json in both test suites.
"""
from __future__ import annotations

import json
import math
import os

from .config import ROOT

CELL = 4.0
INF = math.inf


class Collider:
    __slots__ = ("x0", "y0", "z0", "x1", "y1", "z1", "ramp_axis", "ramp_sign", "lo", "invisible", "m")

    def __init__(self, s):
        b = s["b"]
        self.x0, self.y0, self.z0, self.x1, self.y1, self.z1 = b
        self.m = s.get("m")
        self.invisible = self.m == "invisible"
        r = s.get("ramp")
        if r:
            self.ramp_axis = "x" if r[1] == "x" else "z"
            self.ramp_sign = -1 if r[0] == "-" else 1
            self.lo = s.get("lo", self.y0)
        else:
            self.ramp_axis = None
            self.ramp_sign = 0
            self.lo = self.y1

    def top_at(self, x, z):
        if not self.ramp_axis:
            return self.y1
        if self.ramp_axis == "x":
            t = (x - self.x0) / (self.x1 - self.x0)
        else:
            t = (z - self.z0) / (self.z1 - self.z0)
        if self.ramp_sign < 0:
            t = 1 - t
        t = 0.0 if t < 0 else 1.0 if t > 1 else t
        return self.lo + (self.y1 - self.lo) * t


class _Zone:
    __slots__ = ("k", "s", "vx", "vz", "cx", "cz", "r2", "x0", "y0", "z0", "x1", "y1", "z1")

    def __init__(self, z):
        self.k = z.get("k")
        self.s = z.get("s", 1.0)
        v = z.get("v") or (0.0, 0.0)
        self.vx, self.vz = float(v[0]), float(v[1])
        if z.get("c"):
            self.cx, self.cz = z["c"]
            self.r2 = z["r"] * z["r"]
            self.y0, self.y1 = z["y"]
            self.x0 = None
        else:
            self.cx = None
            self.x0, self.y0, self.z0, self.x1, self.y1, self.z1 = z["b"]

    def contains(self, x, y, z):
        if y < self.y0 - 0.3 or y > self.y1 + 0.3:
            return False
        if self.cx is not None:
            return (x - self.cx) ** 2 + (z - self.cz) ** 2 <= self.r2
        return self.x0 <= x <= self.x1 and self.z0 <= z <= self.z1


class _Ride:
    """A water slide path (dense polyline) with a padded bounding box for quick rejects."""

    def __init__(self, r):
        self.pts = [tuple(p) for p in r["pts"]]
        self.vmax = float(r.get("vmax", 16))
        xs, ys, zs = zip(*self.pts)
        pad = 4.0
        self.bb = (min(xs) - pad, min(ys) - pad, min(zs) - pad, max(xs) + pad, max(ys) + pad, max(zs) + pad)

    def near(self, x, y, z, slack):
        b = self.bb
        if not (b[0] <= x <= b[3] and b[1] <= y <= b[4] and b[2] <= z <= b[5]):
            return False
        s2 = slack * slack
        pts = self.pts
        for i in range(len(pts) - 1):
            ax, ay, az = pts[i]
            bx, by, bz = pts[i + 1]
            dx, dy, dz = bx - ax, by - ay, bz - az
            ll = dx * dx + dy * dy + dz * dz or 1e-9
            t = ((x - ax) * dx + (y - ay) * dy + (z - az) * dz) / ll
            t = 0.0 if t < 0 else 1.0 if t > 1 else t
            px, py, pz = ax + dx * t - x, ay + dy * t - y, az + dz * t - z
            if px * px + py * py + pz * pz <= s2:
                return True
        return False


def _circle_overlaps(x, z, r, c):
    cx = c.x0 if x < c.x0 else c.x1 if x > c.x1 else x
    cz = c.z0 if z < c.z0 else c.z1 if z > c.z1 else z
    dx, dz = x - cx, z - cz
    return dx * dx + dz * dz < r * r


class Pad:
    __slots__ = ("x", "y", "z", "vx", "vy", "vz", "r")

    def __init__(self, p):
        self.x, self.y, self.z = p["p"]
        self.vx, self.vy, self.vz = p["v"]
        self.r = p.get("r") or 0.9


class MapData:
    def __init__(self, data: dict):
        self.data = data
        self.id = data["id"]
        self.bounds = data["bounds"]
        self.kill_y = data.get("killY", -12)
        self.spawns = data["spawns"]
        self.pads = [Pad(p) for p in data.get("pads") or ()]
        self.coin_spots = [list(s) for s in data.get("coinSpots") or ()]
        # water / conveyor zones and water-slide rides (movement validation allowances)
        self.zones = [_Zone(z) for z in data.get("zones") or ()]
        self.conveyor_max = max((math.hypot(z.vx, z.vz) for z in self.zones if z.k == "conveyor"), default=0.0)
        self.rides = [_Ride(r) for r in data.get("rides") or ()]
        self.ride_vmax = max((r.vmax for r in self.rides), default=0.0)
        self.colliders = [Collider(s) for s in data["solids"]]
        self.grid: dict[tuple[int, int], list[Collider]] = {}
        self.big: list[Collider] = []
        for c in self.colliders:
            cx0, cx1 = int(c.x0 // CELL), int(c.x1 // CELL)
            cz0, cz1 = int(c.z0 // CELL), int(c.z1 // CELL)
            if (cx1 - cx0 + 1) * (cz1 - cz0 + 1) > 64:
                self.big.append(c)
                continue
            for gx in range(cx0, cx1 + 1):
                for gz in range(cz0, cz1 + 1):
                    self.grid.setdefault((gx, gz), []).append(c)

    def zone_at(self, x, y, z):
        for zn in self.zones:
            if zn.contains(x, y, z):
                return zn
        return None

    def near_ride(self, x, y, z, slack=3.0):
        """True if the point is within `slack` metres of any water-slide path."""
        return any(r.near(x, y, z, slack) for r in self.rides)

    def query(self, x0, z0, x1, z1):
        seen = set()
        out = [c for c in self.big if c.x1 >= x0 and c.x0 <= x1 and c.z1 >= z0 and c.z0 <= z1]
        for gx in range(int(x0 // CELL), int(x1 // CELL) + 1):
            for gz in range(int(z0 // CELL), int(z1 // CELL) + 1):
                for c in self.grid.get((gx, gz), ()):
                    if id(c) in seen:
                        continue
                    seen.add(id(c))
                    if c.x1 >= x0 and c.x0 <= x1 and c.z1 >= z0 and c.z0 <= z1:
                        out.append(c)
        return out

    def is_free(self, x, feet_y, z, r, h):
        for c in self.query(x - r, z - r, x + r, z + r):
            if not _circle_overlaps(x, z, r, c):
                continue
            if c.y0 >= feet_y + h:
                continue
            if c.top_at(x, z) <= feet_y + 0.02:
                continue
            return False
        return True

    def point_solid(self, x, y, z):
        for c in self.query(x, z, x, z):
            if c.invisible:
                continue
            if c.x0 < x < c.x1 and c.z0 < z < c.z1 and c.y0 < y < c.top_at(x, z):
                return True
        return False

    def line_of_sight(self, a, b, step=0.3):
        dx, dy, dz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
        dist = (dx * dx + dy * dy + dz * dz) ** 0.5
        n = max(1, int(dist / step))
        for i in range(1, n):
            t = i / n
            if self.point_solid(a[0] + dx * t, a[1] + dy * t, a[2] + dz * t):
                return False
        return True

    def in_bounds(self, x, y, z, margin=0.5):
        bx0, bz0, bx1, bz1 = self.bounds
        return bx0 - margin <= x <= bx1 + margin and bz0 - margin <= z <= bz1 + margin and y > self.kill_y - 2

    # ------------------------------------------------------------------ character queries
    # (port of CollisionWorld in src/movement/collision.js; keep the two in sync)

    def ground_below(self, x, z, r, max_y):
        """Highest walkable surface under a circle whose top is at or below max_y: (y, collider) or None."""
        best = -INF
        best_c = None
        r2 = r * r
        lim = max_y + 1e-4
        for c in self.query(x - r, z - r, x + r, z + r):
            cx = c.x0 if x < c.x0 else c.x1 if x > c.x1 else x
            cz = c.z0 if z < c.z0 else c.z1 if z > c.z1 else z
            dx, dz = x - cx, z - cz
            if dx * dx + dz * dz >= r2:
                continue
            top = c.top_at(x, z) if c.ramp_axis else c.y1
            if top <= lim and top > best and c.y0 < top:
                best = top
                best_c = c
        return (best, best_c) if best_c is not None else None

    def resolve_horizontal(self, pos, r, height, step_up):
        """Push a character circle out of every collider overlapping its body between
        (feet + step_up) and (feet + height). Mutates pos (.x/.z). Returns (contacts, nx, nz)
        with the averaged, normalised contact normal."""
        contacts = 0
        nx = nz = 0.0
        lst = self.query(pos.x - r - 0.5, pos.z - r - 0.5, pos.x + r + 0.5, pos.z + r + 0.5)
        r2 = r * r
        for _ in range(3):
            moved = False
            for c in lst:
                if c.y0 >= pos.y + height - 0.02:
                    continue  # entirely above head
                px0, pz0 = pos.x, pos.z
                cx = c.x0 if px0 < c.x0 else c.x1 if px0 > c.x1 else px0
                cz = c.z0 if pz0 < c.z0 else c.z1 if pz0 > c.z1 else pz0
                top = c.top_at(cx, cz) if c.ramp_axis else c.y1
                if top <= pos.y + step_up:
                    continue  # walkable / step-able
                dx = px0 - cx
                dz = pz0 - cz
                d2 = dx * dx + dz * dz
                if d2 >= r2:
                    continue
                if d2 > 1e-10:
                    d = math.sqrt(d2)
                    px = dx / d
                    pz = dz / d
                    depth = r - d
                else:
                    # centre inside the rectangle: push out along the axis of least penetration
                    left, right, back, front = px0 - c.x0, c.x1 - px0, pz0 - c.z0, c.z1 - pz0
                    m = min(left, right, back, front)
                    if m == left:
                        px, pz, depth = -1.0, 0.0, left + r
                    elif m == right:
                        px, pz, depth = 1.0, 0.0, right + r
                    elif m == back:
                        px, pz, depth = 0.0, -1.0, back + r
                    else:
                        px, pz, depth = 0.0, 1.0, front + r
                pos.x += px * (depth + 1e-4)
                pos.z += pz * (depth + 1e-4)
                nx += px
                nz += pz
                contacts += 1
                moved = True
            if not moved:
                break
        ln = js_hypot2(nx, nz)
        if ln > 0:
            return contacts, nx / ln, nz / ln
        return contacts, 0.0, 0.0

    def ceiling_between(self, x, z, r, head_from, head_to):
        """Lowest ceiling (collider bottom) above the head in (head_from, head_to], or None."""
        best = INF
        r9 = r * 0.9
        for c in self.query(x - r, z - r, x + r, z + r):
            if c.y0 < head_from - 0.05 or c.y0 > head_to:
                continue
            if not _circle_overlaps(x, z, r9, c):
                continue
            if c.y0 < best:
                best = c.y0
        return None if best == INF else best

    def obstacle_top(self, x, z, r, min_bottom, max_bottom):
        """Highest top of colliders touching a small probe circle whose extent overlaps
        [min_bottom, max_bottom]; -inf when there is none."""
        best = -INF
        for c in self.query(x - r, z - r, x + r, z + r):
            if not _circle_overlaps(x, z, r, c):
                continue
            if c.y0 > max_bottom or c.y1 < min_bottom:
                continue
            top = c.top_at(x, z) if c.ramp_axis else c.y1
            if top > best:
                best = top
        return best

    def clamp_to_bounds(self, pos, r):
        x0, z0, x1, z1 = self.bounds
        if pos.x < x0 + r:
            pos.x = x0 + r
        if pos.x > x1 - r:
            pos.x = x1 - r
        if pos.z < z0 + r:
            pos.z = z0 + r
        if pos.z > z1 - r:
            pos.z = z1 - r

    def raycast(self, ox, oy, oz, dx, dy, dz, max_dist, ignore_invisible=False):
        """Nearest hit distance along a normalised ray within max_dist, or None."""
        ex = ox + dx * max_dist
        ez = oz + dz * max_dist
        best_t = max_dist
        hit = None
        for c in self.query(min(ox, ex), min(oz, ez), max(ox, ex), max(oz, ez)):
            if ignore_invisible and c.invisible:
                continue
            r = _ray_box(ox, oy, oz, dx, dy, dz, c.x0, c.y0, c.z0, c.x1, c.y1, c.z1, best_t)
            if r is None:
                continue
            t, t_out = r
            if c.ramp_axis:
                # march inside the box until we are under the sloped surface
                t_end = min(t_out, best_t)
                found = False
                for i in range(11):
                    tt = t + (t_end - t) * i / 10
                    if oy + dy * tt <= c.top_at(ox + dx * tt, oz + dz * tt) + 1e-3:
                        t = tt
                        found = True
                        break
                if not found:
                    continue
            if t < best_t:
                best_t = t
                hit = t
        return hit

    def ray_los(self, ax, ay, az, bx, by, bz):
        """Ray-cast line of sight (same as CollisionWorld.lineOfSight; ignores invisible walls)."""
        dx, dy, dz = bx - ax, by - ay, bz - az
        d = math.sqrt(dx * dx + dy * dy + dz * dz)
        if d < 1e-4:
            return True
        return self.raycast(ax, ay, az, dx / d, dy / d, dz / d, d - 0.05, True) is None


def js_hypot2(a, b):
    """Math.hypot(a, b) exactly as V8 computes it (max-normalised sum of squares), so the
    controller port matches the browser bit for bit instead of differing in the last ulp."""
    a = -a if a < 0 else a
    b = -b if b < 0 else b
    m = a if a > b else b
    if m == 0:
        return 0.0
    if m == INF:
        return INF
    a /= m
    b /= m
    return math.sqrt(a * a + b * b) * m


def js_hypot3(a, b, c):
    """Math.hypot(a, b, c) as V8 computes it (normalised Kahan summation)."""
    a = -a if a < 0 else a
    b = -b if b < 0 else b
    c = -c if c < 0 else c
    m = a if a > b else b
    if c > m:
        m = c
    if m == 0:
        return 0.0
    if m == INF:
        return INF
    s = 0.0
    comp = 0.0
    for v in (a, b, c):
        n = v / m
        summand = n * n - comp
        pre = s + summand
        comp = (pre - s) - summand
        s = pre
    return math.sqrt(s) * m


def _ray_box(ox, oy, oz, dx, dy, dz, x0, y0, z0, x1, y1, z1, max_t):
    tmin = 0.0
    tmax = max_t
    for o, d, lo, hi in ((ox, dx, x0, x1), (oy, dy, y0, y1), (oz, dz, z0, z1)):
        if -1e-9 < d < 1e-9:
            if o < lo or o > hi:
                return None
        else:
            t1 = (lo - o) / d
            t2 = (hi - o) / d
            if t1 > t2:
                t1, t2 = t2, t1
            if t1 > tmin:
                tmin = t1
            if t2 < tmax:
                tmax = t2
            if tmin > tmax:
                return None
    return tmin, tmax


_cache: dict[str, MapData] = {}


def list_maps():
    with open(os.path.join(ROOT, "assets", "maps", "index.json"), "r", encoding="utf-8") as f:
        return [m["id"] for m in json.load(f)["maps"]]


def load_map(map_id: str) -> MapData:
    if map_id in _cache:
        return _cache[map_id]
    if map_id not in list_maps():
        raise ValueError(f"unknown map {map_id}")
    with open(os.path.join(ROOT, "assets", "maps", f"{map_id}.json"), "r", encoding="utf-8") as f:
        m = MapData(json.load(f))
    _cache[map_id] = m
    return m
