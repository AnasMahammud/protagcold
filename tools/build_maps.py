"""
PRO TAG map builder.

Maps are authored here in Python (so we can use loops and helpers) and exported to
assets/maps/<id>.json. The SAME JSON is loaded by the browser client (rendering,
collision, bot navigation) and the Python server (movement validation), so the
collision geometry can never drift between client and server.

Run:  python tools/build_maps.py

Coordinate system: Y is up, units are metres. Every collider is an axis-aligned box
"b": [x0, y0, z0, x1, y1, z1]. A ramp collider additionally has "ramp": "+x"|"-x"|"+z"|"-z"
(the direction in which its surface rises) and "lo" (surface height at the low end);
its surface reaches y1 at the high end and the solid fills down to y0.
"""
from __future__ import annotations

import json
import math
import os
import random
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "assets", "maps")


def rect_minus(x0, z0, x1, z1, holes):
    """Split a rectangle minus rectangular holes into as few rectangles as practical."""
    hs = [(max(x0, h[0]), max(z0, h[1]), min(x1, h[2]), min(z1, h[3])) for h in holes]
    hs = [h for h in hs if h[0] < h[2] and h[1] < h[3]]
    xs = sorted(set([x0, x1] + [h[0] for h in hs] + [h[2] for h in hs]))
    strips = []
    for i in range(len(xs) - 1):
        a, b = xs[i], xs[i + 1]
        cuts = sorted((h[1], h[3]) for h in hs if h[0] <= a and h[2] >= b)
        z = z0
        for (c0, c1) in cuts:
            if c0 > z:
                strips.append((a, z, b, c0))
            z = max(z, c1)
        if z < z1:
            strips.append((a, z, b, z1))
    merged = []
    for r in strips:  # merge neighbouring strips that share the same z-range
        for k, q in enumerate(merged):
            if q[2] == r[0] and q[1] == r[1] and q[3] == r[3]:
                merged[k] = (q[0], q[1], r[2], q[3])
                break
        else:
            merged.append(r)
    return merged


def catmull_rom(ctrl, spacing=0.5):
    """Dense, smooth polyline through control points (uniform Catmull-Rom)."""
    P = [ctrl[0]] + list(ctrl) + [ctrl[-1]]
    out = []
    for i in range(1, len(P) - 2):
        p0, p1, p2, p3 = P[i - 1], P[i], P[i + 1], P[i + 2]
        n = max(2, int(math.ceil(math.dist(p1, p2) / spacing)))
        for k in range(n):
            t = k / n
            t2, t3 = t * t, t * t * t
            out.append(tuple(0.5 * ((2 * p1[j]) + (-p0[j] + p2[j]) * t + (2 * p0[j] - 5 * p1[j] + 4 * p2[j] - p3[j]) * t2
                                    + (-p0[j] + 3 * p1[j] - 3 * p2[j] + p3[j]) * t3) for j in range(3)))
    out.append(tuple(ctrl[-1]))
    return out


class MapBuilder:
    def __init__(self, map_id, name, theme, description, half_x, half_z):
        self.data = {
            "id": map_id,
            "name": name,
            "theme": theme,
            "description": description,
            "bounds": [-half_x, -half_z, half_x, half_z],
            "killY": -12.0,
            "solids": [],
            "pads": [],
            "spawns": [],
            "decor": [],
            "env": {},
        }

    # ------------------------------------------------------------------ colliders
    def box(self, x0, y0, z0, x1, y1, z1, m="concrete", **kw):
        lo = [min(x0, x1), min(y0, y1), min(z0, z1)]
        hi = [max(x0, x1), max(y0, y1), max(z0, z1)]
        s = {"b": [round(v, 3) for v in lo + hi], "m": m}
        s.update({k: v for k, v in kw.items() if v is not None})
        self.data["solids"].append(s)
        return s

    def boxc(self, cx, cz, w, d, y0, y1, m="concrete", **kw):
        """Box from centre (x, z), width (x), depth (z) and vertical extent."""
        return self.box(cx - w / 2, y0, cz - d / 2, cx + w / 2, y1, cz + d / 2, m, **kw)

    def ramp(self, x0, y0, z0, x1, y1, z1, direction, lo=None, m="metal", **kw):
        s = self.box(x0, y0, z0, x1, y1, z1, m, **kw)
        s["ramp"] = direction
        s["lo"] = round(y0 if lo is None else lo, 3)
        return s

    def stairs(self, x0, x1, z0, z1, y_base, y_top, direction, steps, m="concrete"):
        """Solid staircase inside the rectangle, rising toward `direction`."""
        rise = (y_top - y_base) / steps
        for i in range(steps):
            h = y_base + rise * (i + 1)
            t0, t1 = i / steps, (i + 1) / steps
            if direction == "+z":
                self.box(x0, y_base, z0 + (z1 - z0) * t0, x1, h, z1, m, v="step")
            elif direction == "-z":
                self.box(x0, y_base, z0, x1, h, z1 - (z1 - z0) * t0, m, v="step")
            elif direction == "+x":
                self.box(x0 + (x1 - x0) * t0, y_base, z0, x1, h, z1, m, v="step")
            elif direction == "-x":
                self.box(x0, y_base, z0, x1 - (x1 - x0) * t0, h, z1, m, v="step")
            # Each step is a full-height box that overlaps the next. This keeps the
            # underside closed (no gaps to snag on) and costs nothing extra.

    def bar(self, x0, z0, x1, z1, y_bottom=1.05, y_top=1.4, thickness=0.36, m="pipe", posts=True, base_y=0.0):
        """A horizontal bar you can slide under (or mantle over), with end posts."""
        if abs(x1 - x0) >= abs(z1 - z0):
            zc = (z0 + z1) / 2
            self.box(x0, base_y + y_bottom, zc - thickness / 2, x1, base_y + y_top, zc + thickness / 2, m, v="bar")
            if posts:
                for x in (x0, x1 - 0.2):
                    self.box(x, base_y, zc - 0.1, x + 0.2, base_y + y_bottom, zc + 0.1, "metal", v="post")
        else:
            xc = (x0 + x1) / 2
            self.box(xc - thickness / 2, base_y + y_bottom, z0, xc + thickness / 2, base_y + y_top, z1, m, v="bar")
            if posts:
                for z in (z0, z1 - 0.2):
                    self.box(xc - 0.1, base_y, z, xc + 0.1, base_y + y_bottom, z + 0.2, "metal", v="post")

    # ------------------------------------------------------------------ v1.02 building blocks
    def slab(self, x0, z0, x1, z1, y, holes=(), m="concrete", mt=None, thick=0.5, **kw):
        """Floor slab with its top at y, minus rectangular holes (atriums, stairwells...)."""
        for (a0, b0, a1, b1) in rect_minus(x0, z0, x1, z1, holes):
            self.box(a0, y - thick, b0, a1, y, b1, m, mt=mt, **kw)

    def railing(self, x0, z0, x1, z1, y, h=1.05, t=0.18, m="glass", gaps=()):
        """Low wall along an axis-aligned line, leaving gaps [(a, b), ...] along its length."""
        horiz = abs(x1 - x0) >= abs(z1 - z0)
        lo, hi = (min(x0, x1), max(x0, x1)) if horiz else (min(z0, z1), max(z0, z1))
        cur = lo
        segs = []
        for (a, b) in sorted(gaps):
            if a > cur:
                segs.append((cur, min(a, hi)))
            cur = max(cur, b)
        if cur < hi:
            segs.append((cur, hi))
        for (a, b) in segs:
            if b - a < 0.3:
                continue
            if horiz:
                self.box(a, y, z0 - t / 2, b, y + h, z0 + t / 2, m, v="rail")
            else:
                self.box(x0 - t / 2, y, a, x0 + t / 2, y + h, b, m, v="rail")

    def zone(self, **z):
        self.data.setdefault("zones", []).append(z)

    def water_circle(self, cx, cz, r, floor=0.0, surf=0.4, s=0.72):
        self.zone(k="water", c=[cx, cz], r=r, y=[floor - 0.3, floor + 0.9], surf=round(floor + surf, 3), s=s)

    def water_box(self, x0, z0, x1, z1, floor=0.0, surf=0.4, s=0.6):
        self.zone(k="water", b=[x0, floor - 0.3, z0, x1, floor + 0.9, z1], surf=round(floor + surf, 3), s=s)

    def conveyor(self, x0, y0, z0, x1, y1, z1, vx, vz):
        self.zone(k="conveyor", b=[round(v, 3) for v in (x0, y0, z0, x1, y1, z1)], v=[vx, vz])

    def belt(self, x0, z0, x1, z1, top, direction, speed=3.0, m="machine"):
        """Raised conveyor belt that carries anyone standing on it toward `direction`."""
        self.box(x0, 0, z0, x1, top, z1, m, mt=f"belt_{'p' if direction[0] == '+' else 'n'}{direction[1]}", v="belt")
        sign = 1 if direction[0] == "+" else -1
        vx, vz = (sign * speed, 0) if direction[1] == "x" else (0, sign * speed)
        self.conveyor(x0, top - 0.1, z0, x1, top + 0.4, z1, vx, vz)

    def escalator(self, x0, z0, x1, z1, y_lo, y_hi, rising, up=True, speed=2.6, segments=1, rails=True):
        """A ramp rising toward `rising` that carries riders up (or down, up=False)."""
        axis, sign = rising[1], (1 if rising[0] == "+" else -1)
        push = sign if up else -sign
        mt = f"escalator_{'p' if push > 0 else 'n'}{axis}"
        a0, a1 = (x0, x1) if axis == "x" else (z0, z1)
        low_end, high_end = (a0, a1) if sign > 0 else (a1, a0)
        for i in range(segments):
            t0, t1 = i / segments, (i + 1) / segments
            ea, eb = low_end + (high_end - low_end) * t0, low_end + (high_end - low_end) * t1
            lo, hi = y_lo + (y_hi - y_lo) * t0, y_lo + (y_hi - y_lo) * t1
            base = y_lo if (segments == 1 and y_lo <= 0.01) else lo - 0.5
            seg = (min(ea, eb), max(ea, eb))
            if axis == "x":
                self.ramp(seg[0], base, z0, seg[1], hi, z1, rising, lo=lo, m="metal", mt=mt, v="escalator")
                if rails:
                    for (za, zb) in ((z0 - 0.16, z0), (z1, z1 + 0.16)):
                        self.ramp(seg[0], lo - 0.2, za, seg[1], hi + 1.0, zb, rising, lo=lo + 1.0, m="glass", v="rail")
            else:
                self.ramp(x0, base, seg[0], x1, hi, seg[1], rising, lo=lo, m="metal", mt=mt, v="escalator")
                if rails:
                    for (xa, xb) in ((x0 - 0.16, x0), (x1, x1 + 0.16)):
                        self.ramp(xa, lo - 0.2, seg[0], xb, hi + 1.0, seg[1], rising, lo=lo + 1.0, m="glass", v="rail")
        vx, vz = (push * speed, 0) if axis == "x" else (0, push * speed)
        self.conveyor(x0, y_lo - 0.2, z0, x1, y_hi + 0.5, z1, vx, vz)

    def spiral_tower(self, cx, cz, top, m="stucco", step_m="tile_teal", deck_m="deck", rail_gaps=()):
        """Square spiral staircase (4 flights per lap round a central column) up to a top deck.
        rail_gaps: [(side, a, b)] gaps in the deck railing ('n','s','e','w', along-axis range)."""
        n = int(math.ceil(top / 1.9))
        rise = top / n
        c, e = 1.5, 4.0  # column half-size, outer half-size
        corners = [(cx - e, cz - e, cx - c, cz - c), (cx + c, cz - e, cx + e, cz - c), (cx + c, cz + c, cx + e, cz + e), (cx - e, cz + c, cx - c, cz + e)]
        sides = [((cx - c, cz - e, cx + c, cz - c), "+x"), ((cx + c, cz - c, cx + e, cz + c), "+z"),
                 ((cx - c, cz + c, cx + c, cz + e), "-x"), ((cx - e, cz - c, cx - c, cz + c), "-z")]
        self.box(cx - c, 0, cz - c, cx + c, top - 0.5, cz + c, m, v="tower")
        steps = max(4, int(round(rise / 0.3)))
        for k in range(n):
            (sx0, sz0, sx1, sz1), d = sides[k % 4]
            # collide as a smooth slope from landing to landing (easy to run, no lips for the
            # bots' navigation to trip on); the "steps" prop draws treads the slope cuts through the middle of
            self.ramp(sx0, k * rise, sz0, sx1, (k + 1) * rise, sz1, d, m=step_m, hide=True, v="flight")
            self.decor("steps", b=[sx0, k * rise, sz0, sx1, (k + 1) * rise, sz1], dir=d, n=steps, m=step_m)
            if k < n - 1:
                h = (k + 1) * rise
                lx0, lz0, lx1, lz1 = corners[(k + 1) % 4]
                self.box(lx0, 0 if h < 3 else h - 0.5, lz0, lx1, h, lz1, step_m, v="landing")
        last_side = sides[(n - 1) % 4][0]
        last_corner = corners[(n - 1) % 4]
        deck = (cx - e, cz - e, cx + e, cz + e)
        self.slab(*deck, top, holes=(last_side, last_corner), m=m, mt=deck_m, v="deck")
        gaps = {"n": [], "s": [], "e": [], "w": []}
        for (side, a, b) in rail_gaps:
            gaps[side].append((a, b))
        # the opening the last flight comes up through stays open (no rail across it)
        self.railing(cx - e, cz - e, cx + e, cz - e, top, m="metal", gaps=gaps["n"])
        self.railing(cx - e, cz + e, cx + e, cz + e, top, m="metal", gaps=gaps["s"])
        self.railing(cx - e, cz - e, cx - e, cz + e, top, m="metal", gaps=gaps["w"])
        self.railing(cx + e, cz - e, cx + e, cz + e, top, m="metal", gaps=gaps["e"])
        return deck

    def ride(self, ctrl, r=1.1, vmax=17.0, col=("#ff3db0", "#2fd8e8"), posts=True):
        """A water slide along smoothed control points (feet height). Players ride it by stepping
        onto its entry; the client renders the striped channel from the same points."""
        pts = catmull_rom(ctrl, 0.5)
        self.data.setdefault("rides", []).append({"pts": [[round(v, 2) for v in p] for p in pts], "r": r, "vmax": vmax, "col": list(col)})
        if posts:
            # support posts every ~9 m where the slide is high enough to need them (collide)
            acc = 0.0
            for i in range(1, len(pts)):
                acc += math.dist(pts[i - 1], pts[i])
                x, y, z = pts[i]
                if acc > 9 and y > 2.6 and i < len(pts) - 6:
                    acc = 0.0
                    self.box(x - 0.18, 0, z - 0.18, x + 0.18, y - 0.25, z + 0.18, "pad_white", v="post")

    def invisible_bounds(self, height=40.0):
        x0, z0, x1, z1 = self.data["bounds"]
        t = 2.0
        self.box(x0 - t, -5, z0 - t, x1 + t, height, z0, "invisible")
        self.box(x0 - t, -5, z1, x1 + t, height, z1 + t, "invisible")
        self.box(x0 - t, -5, z0, x0, height, z1, "invisible")
        self.box(x1, -5, z0, x1 + t, height, z1, "invisible")

    # ------------------------------------------------------------------ gameplay
    def pad(self, x, y, z, vx, vy, vz, color="#3df5ff"):
        self.data["pads"].append({"p": [x, y, z], "v": [vx, vy, vz], "r": 0.9, "c": color})

    def spawn(self, x, y, z):
        self.data["spawns"].append([x, y, z])

    def decor(self, kind, **props):
        d = {"t": kind}
        d.update(props)
        self.data["decor"].append(d)

    def env(self, **props):
        self.data["env"].update(props)

    # ------------------------------------------------------------------ validation
    def validate(self):
        problems = []
        solids = self.data["solids"]
        r = 0.36
        for i, (x, y, z) in enumerate(self.data["spawns"]):
            for s in solids:
                b = s["b"]
                if s.get("ramp"):
                    continue
                inside_xz = (b[0] - r < x < b[3] + r) and (b[2] - r < z < b[5] + r)
                if inside_xz and b[1] < y + 1.8 and b[4] > y + 0.05:
                    problems.append(f"spawn {i} at {(x, y, z)} overlaps solid {b} ({s['m']})")
            # must have ground under it
            ground = any(
                (s["b"][0] <= x <= s["b"][3]) and (s["b"][2] <= z <= s["b"][5]) and abs(s["b"][4] - y) < 0.01
                for s in solids
            )
            if not ground:
                problems.append(f"spawn {i} at {(x, y, z)} has no ground directly below")
        bx0, bz0, bx1, bz1 = self.data["bounds"]
        for i, (x, y, z) in enumerate(self.data["spawns"]):
            if not (bx0 < x < bx1 and bz0 < z < bz1):
                problems.append(f"spawn {i} outside bounds")
        for s in solids:
            b = s["b"]
            if b[3] - b[0] <= 0 or b[4] - b[1] <= 0 or b[5] - b[2] <= 0:
                problems.append(f"degenerate solid {s}")
        if len(self.data["spawns"]) < 10:
            problems.append(f"only {len(self.data['spawns'])} spawns (need 10)")
        # water slides must not pass through anything solid (after leaving their entry deck)
        for ri, r in enumerate(self.data.get("rides", [])):
            travelled = 0.0
            for i, (x, y, z) in enumerate(r["pts"]):
                if i:
                    travelled += math.dist(r["pts"][i - 1], (x, y, z))
                if travelled < 2.5:
                    continue
                for s in solids:
                    b = s["b"]
                    if s["m"] == "invisible" or s.get("v") == "post":
                        continue
                    if b[0] < x < b[3] and b[2] < z < b[5] and b[1] < y + 0.5 < b[4]:
                        problems.append(f"ride {ri} point {i} {(x, y, z)} inside solid {b} ({s['m']} {s.get('v')})")
                        break
        return problems

    def coin_spots(self, max_spots=36, min_gap=4.5):
        """Places for gold coins: tops of reachable platforms (rewarding parkour) plus open
        ground. A spot needs headroom and must not be inside or under another solid."""
        solids = [s for s in self.data["solids"] if s["m"] != "invisible" and not s.get("ramp")]
        blockers = [s for s in self.data["solids"] if s["m"] != "invisible"]  # ramps block too

        def blocked(x, y, z):
            for s in blockers:
                b = s["b"]
                if b[0] - 0.4 < x < b[3] + 0.4 and b[2] - 0.4 < z < b[5] + 0.4 and b[1] < y + 2.0 and b[4] > y + 0.05:
                    return True
            return False

        cands = []
        rng = random.Random(len(self.data["solids"]))
        for s in solids:
            b = s["b"]
            w, d, top = b[3] - b[0], b[5] - b[2], b[4]
            if w < 1.2 or d < 1.2 or top > 12.5 or top < 0.5 or s.get("hide") or s.get("v") in ("post", "leg", "bar", "mast", "crane_leg", "wall", "pillar", "rail", "escalator", "belt", "step", "tower"):
                continue
            if w * d > 300:
                # big upper floors: a few random spots on top
                for _ in range(int(min(40, w * d / 60))):
                    x, z = rng.uniform(b[0] + 1, b[3] - 1), rng.uniform(b[2] + 1, b[5] - 1)
                    if not blocked(x, top, z):
                        cands.append((round(x, 2), round(top + 0.9, 2), round(z, 2), top - 6))
                continue
            x, z = (b[0] + b[3]) / 2, (b[2] + b[5]) / 2
            if not blocked(x, top, z):
                cands.append((round(x, 2), round(top + 0.9, 2), round(z, 2), top))
        bx0, bz0, bx1, bz1 = self.data["bounds"]
        ground = []
        for _ in range(400):
            x, z = rng.uniform(bx0 + 3, bx1 - 3), rng.uniform(bz0 + 3, bz1 - 3)
            if not blocked(x, 0.0, z):
                ground.append((round(x, 2), 0.9, round(z, 2), 0.0))
        # high spots first (they are the fun ones), then fill with ground spots, keeping a gap
        cands.sort(key=lambda c: -c[3])
        spots = []
        for c in cands + ground:
            if len(spots) >= max_spots:
                break
            if all((c[0] - s[0]) ** 2 + (c[2] - s[2]) ** 2 >= min_gap * min_gap for s in spots):
                spots.append(c)
        return [[s[0], s[1], s[2]] for s in spots]

    def write(self):
        self.data["coinSpots"] = self.coin_spots()
        problems = self.validate()
        if problems:
            for p in problems:
                print("  !!", p)
            raise SystemExit(f"Map {self.data['id']} failed validation")
        os.makedirs(OUT_DIR, exist_ok=True)
        path = os.path.join(OUT_DIR, f"{self.data['id']}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.data, f, separators=(",", ":"))
        print(f"  wrote {os.path.relpath(path, ROOT)}  solids={len(self.data['solids'])} "
              f"pads={len(self.data['pads'])} decor={len(self.data['decor'])}")
        return self.data


# =============================================================================
# MAP 1 - NEON ROOFTOPS: a night-time rooftop complex high above a neon city.
# =============================================================================
def build_rooftops():
    m = MapBuilder("rooftops", "Neon Rooftops", "city",
                   "A rooftop playground high above a neon city. Low alleys, high bridges, and a central water tower.",
                   40, 40)
    m.env(sky=["#060814", "#1a1240", "#ff4f9a"], fog="#160f33", fogNear=55, fogFar=170,
          sun=[-0.45, 0.8, 0.35], sunColor="#a9bcff", sunIntensity=1.7, ambient="#6a5cb0",
          ambientIntensity=1.35, hemiGround="#1d1530", exposure=1.15, music="night",
          events=["blackout", "coinrain", "lowgrav", "fog"])

    # Base deck + parapet + invisible walls
    m.box(-40, -1, -40, 40, 0, 40, "roof")
    m.box(-40, 0, -40, 40, 1.1, -39.5, "concrete", v="parapet")
    m.box(-40, 0, 39.5, 40, 1.1, 40, "concrete", v="parapet")
    m.box(-40, 0, -39.5, -39.5, 1.1, 39.5, "concrete", v="parapet")
    m.box(39.5, 0, -39.5, 40, 1.1, 39.5, "concrete", v="parapet")
    m.invisible_bounds()

    # --- Building A (NW, greenhouse roof, h=4)
    m.box(-36, 0, -36, -18, 4, -18, "brick", mt="roof", v="building")
    m.stairs(-18, -15.4, -26, -17, 0, 4, "-z", 10)
    m.box(-18, 0, -30, -15.4, 4, -26, "concrete", v="landing")
    m.box(-29, 0, -18, -27, 1.5, -16, "wood", v="crate")
    m.box(-33, 4, -33, -25, 6.8, -27, "glass", v="greenhouse")
    m.box(-22, 4, -34, -20.4, 5.1, -32.6, "metal", v="ac")
    m.box(-34, 4, -23, -32.6, 5.1, -21.4, "metal", v="ac")
    m.box(-24.2, 4, -24, -22.6, 5.0, -22.4, "metal", v="ac")

    # --- Building N (north middle, h=4) + bridge from A + ramp up to B
    m.box(-6, 0, -34, 6, 4, -26, "concrete", mt="roof", v="building")
    m.box(-18, 3.7, -31, -6, 4, -29, "wood", v="plank")
    m.box(-1, 0, -26, 1, 1.4, -24.4, "wood", v="crate")
    m.ramp(6, 3.6, -31, 18, 7, -29, "+x", lo=4, m="metal", v="catwalk")
    m.box(11.8, 0, -30.3, 12.2, 3.6, -29.7, "metal", v="post")
    m.box(-2, 4, -32.5, 0.5, 5.2, -31.5, "metal", v="ac")
    m.bar(-5, -28, 2, -28, base_y=4.0)

    # --- Building B (NE, tallest, h=7) + long ramp from the east side
    m.box(18, 0, -36, 36, 7, -18, "brick", mt="roof", v="building")
    m.ramp(30, 0, -18, 33, 7, 3, "-z", lo=0, m="metal", v="catwalk")
    m.box(22, 7, -26, 23.6, 8.1, -24.4, "metal", v="ac")
    m.box(28, 7, -32, 29.6, 8.1, -30.4, "metal", v="ac")
    m.bar(21.5, -21, 26.5, -21, base_y=7.0)
    m.box(20, 7, -35.5, 34, 7.5, -35, "concrete", v="parapet")
    m.pad(11, 0, -11, 9.0, 22.6, -9.0, "#ff3df0")

    # --- Building C (SW, low, h=2.6 - climbable directly) + bridge to containers
    m.box(-36, 0, 18, -18, 2.6, 36, "brick", mt="roof", v="building")
    for z in (22.0, 26.5, 31.0):
        m.box(-33, 2.6, z, -22, 3.5, z + 1.2, "metal", v="solar")
    m.box(-25.5, 2.6, 33, -24, 5.2, 34.5, "brick", v="chimney")
    m.box(-18, 2.3, 26.6, -6, 2.6, 28, "wood", v="plank")
    m.box(-19.5, 0, 14, -17.5, 0.5, 16.5, "wood", v="bench")

    # --- South middle: container stack
    m.box(-6, 0, 26, 6, 2.6, 28.44, "container_red", v="container")
    m.box(8, 0, 22, 10.44, 2.6, 34, "container_blue", v="container")
    m.box(-6, 2.6, 26, 0, 5.2, 28.44, "container_yellow", v="container")
    m.box(-12, 0, 30, -9, 1.0, 31.2, "planter", v="planter")
    m.box(12.5, 0, 28, 15.5, 1.0, 29.2, "planter", v="planter")
    m.bar(-4, 34, 4, 34)
    m.box(1.5, 0, 24.3, 3.5, 1.3, 26, "wood", v="crate")

    # --- Building D (SE, two tiers, h=3.2 and 6.2)
    m.box(18, 0, 18, 36, 3.2, 36, "concrete", mt="roof", v="building")
    m.box(27, 3.2, 27, 36, 6.2, 36, "brick", mt="roof", v="building")
    m.stairs(15.4, 18, 19, 27, 0, 3.2, "+z", 8)
    m.stairs(24.6, 27, 27.8, 35, 3.2, 6.2, "+z", 8)
    m.box(23, 0, 16.2, 25, 1.6, 18, "wood", v="crate")
    m.box(20, 3.2, 21, 21.6, 4.3, 22.6, "metal", v="ac")
    m.bar(29, 22, 34, 22, base_y=3.2)

    # --- West middle: pipe run, vent stack, shed
    for z in (-8.0, 6.0):
        m.bar(-38, z, -20, z, y_bottom=1.05, y_top=1.5, thickness=0.5)
    m.box(-30, 0, -2, -27, 2.2, 1, "metal", v="vent")
    m.box(-38, 0, 10, -32, 3.1, 15, "metal", v="shed")
    m.box(-24, 0, 11, -22.4, 1.1, 12.6, "metal", v="ac")

    # --- East middle: helipad + mast
    m.box(20, 0, -8, 28, 1.2, 4, "concrete", mt="helipad", v="helipad")
    m.box(36, 0, 8, 37, 12, 9, "metal", v="mast")
    m.box(22, 0, 9, 23.6, 1.1, 10.6, "metal", v="ac")

    # --- Plaza: water tower, planters, slide bars
    m.box(-3, 0, -3, 3, 3.4, 3, "concrete", v="tower")
    m.stairs(-1.2, 1.2, 3, 11, 0, 3.4, "-z", 10)
    for (lx, lz) in ((-2.6, -2.6), (2.3, -2.6), (-2.6, 2.3), (2.3, 2.3)):
        m.box(lx, 3.4, lz, lx + 0.3, 6.2, lz + 0.3, "metal", v="leg")
    m.box(-2.2, 6.2, -2.2, 2.2, 9.4, 2.2, "wood", v="tank", hide=True)  # drawn by the water_tank decor
    for (px, pz, rot) in ((-9, -9, 0), (9, -9, 1), (-9, 9, 1), (9, 9, 0)):
        if rot:
            m.box(px - 0.6, 0, pz - 1.5, px + 0.6, 1.0, pz + 1.5, "planter", v="planter")
        else:
            m.box(px - 1.5, 0, pz - 0.6, px + 1.5, 1.0, pz + 0.6, "planter", v="planter")
    m.bar(-7, -3, -7, 3, y_bottom=1.05, y_top=1.4)
    m.bar(7, -3, 7, 3, y_bottom=1.05, y_top=1.4)
    m.box(-13, 0, 0, -11.5, 0.5, 3, "wood", v="bench")
    m.box(11.5, 0, -3, 13, 0.5, 0, "wood", v="bench")

    # Spawns
    for p in ((-10, 0, 14), (10, 0, 14), (-14, 0, -10), (14, 0, -4), (0, 0, -16),
              (-24, 0, 4), (25, 0, 12), (0, 0, 20), (-11, 0, -21), (12, 0, 6), (-31, 0, -12), (34, 0, 14)):
        m.spawn(*p)

    # Decor (visual only)
    m.decor("water_tank", p=[0, 6.2, 0], r=2.2, h=3.2)
    m.decor("neon_sign", p=[27, 4.6, -17.85], rot=0, w=7, h=1.6, text="PRO TAG", color="#ff3df0")
    m.decor("neon_sign", p=[-17.85, 2.4, -24], rot=90, w=4, h=1.0, text="ROOF 4", color="#3df5ff")
    m.decor("neon_sign", p=[22, 2.0, 17.85], rot=180, w=5, h=1.1, text="NOODLES", color="#ffd23d")
    m.decor("neon_sign", p=[-26, 1.6, 17.85], rot=180, w=4.5, h=1.0, text="ARCADE", color="#7dff6b")
    m.decor("billboard", p=[27, 7, -35.4], w=12, h=5, text="RUN FAST", color="#3df5ff")
    m.decor("string_lights", a=[0, 9.6, 0], b=[-13, 3.5, -13], color="#ffcf6b")
    m.decor("string_lights", a=[0, 9.6, 0], b=[13, 3.5, -13], color="#ff6bd6")
    m.decor("string_lights", a=[0, 9.6, 0], b=[-13, 3.5, 13], color="#6bd6ff")
    m.decor("string_lights", a=[0, 9.6, 0], b=[13, 3.5, 13], color="#ffcf6b")
    for (x, z) in ((-13, -13), (13, -13), (-13, 13), (13, 13)):
        m.decor("lamp", p=[x, 0, z], h=3.5, color="#ffc27a")
    for (x, z, c) in ((-37, -37, "#ff3df0"), (37, 37, "#3df5ff"), (37, -14, "#ffd23d"), (-37, 30, "#7dff6b")):
        m.decor("lamp", p=[x, 0, z], h=3.2, color=c)
    m.decor("antenna", p=[34, 7, -34], h=6)
    m.decor("antenna", p=[-34, 4, -35], h=4)
    m.decor("dish", p=[-20, 4, -20.5], r=0.9)
    m.decor("dish", p=[33, 6.2, 34], r=1.1)
    m.decor("steam", p=[-28.5, 2.2, -0.5])
    m.decor("steam", p=[-24.7, 5.2, 33.7])
    m.decor("helipad_mark", p=[24, 1.21, -2], r=3.4)
    m.decor("plants", p=[-29, 4, -30], w=6, d=4)
    return m.write()


# =============================================================================
# MAP 2 - PULSE ARENA: an indoor chase-tag sports facility (the reference vibe).
# =============================================================================
def build_arena():
    m = MapBuilder("arena", "Pulse Arena", "arena",
                   "An indoor chase-tag stadium. A dense obstacle quad in the middle, catwalks above, wall-jump chimneys.",
                   22, 22)
    m.env(sky=["#0b0f1a", "#141c2e", "#1c2a44"], fog="#0f1626", fogNear=60, fogFar=140,
          sun=[0.2, 1.0, 0.15], sunColor="#ffffff", sunIntensity=1.6, ambient="#8fa6d6",
          ambientIntensity=1.1, hemiGround="#2a2f3a", exposure=1.05, indoor=True, music="arena",
          events=["blackout", "coinrain", "surge"])

    m.box(-22, -1, -22, 22, 0, 22, "pad_floor")
    m.invisible_bounds(height=13)
    # visible padded boards (the crowd watches over them; invisible bounds go up to the ceiling)
    m.box(-22.5, 0, -22.5, 22.5, 3.2, -22, "wall_pad", v="wall")
    m.box(-22.5, 0, 22, 22.5, 3.2, 22.5, "wall_pad", v="wall")
    m.box(-22.5, 0, -22, -22, 3.2, 22, "wall_pad", v="wall")
    m.box(22, 0, -22, 22.5, 3.2, 22, "wall_pad", v="wall")
    m.box(-22, 12, -22, 22, 13, 22, "invisible")  # ceiling

    # --- Central quad
    m.box(-1.5, 0, -1.5, 1.5, 2.8, 1.5, "pad_blue", v="block")
    m.box(1.5, 0, -1.0, 3.0, 1.3, 1.0, "pad_orange", v="block")
    m.box(-3.0, 0, -1.0, -1.5, 1.3, 1.0, "pad_orange", v="block")
    m.ramp(-6, 0, -7.2, -3, 1.6, -5, "+x", m="pad_white", v="aframe")
    m.ramp(-3, 0, -7.2, 0, 1.6, -5, "-x", m="pad_white", v="aframe")
    m.ramp(0, 0, 5, 3, 1.6, 7.2, "+x", m="pad_white", v="aframe")
    m.ramp(3, 0, 5, 6, 1.6, 7.2, "-x", m="pad_white", v="aframe")
    for (x0, z0, x1, z1) in ((4, -6, 5.2, -4), (-5.2, 4, -4, 6), (-7.6, -1, -6.4, 1), (6.4, -1, 7.6, 1)):
        m.box(x0, 0, z0, x1, 1.0, z1, "pad_orange", v="block")
    m.bar(1, -6, 4, -6, base_y=0)
    m.bar(-4, 6, -1, 6, base_y=0)
    m.bar(-9, -4, -9, 4)
    m.bar(9, -4, 9, 4)
    m.box(-8, 0, -8, -6.6, 0.6, -6.6, "pad_blue", v="block")
    m.box(6.6, 0, 6.6, 8, 0.6, 8, "pad_blue", v="block")

    # --- Corner towers (2 tiers) + catwalks along north & south walls
    for sx in (-1, 1):
        for sz in (-1, 1):
            xa, xb = sorted((sx * 22, sx * 16))
            za, zb = sorted((sz * 22, sz * 16))
            m.box(xa, 0, za, xb, 2.2, zb, "pad_blue", v="block")
            xa2, xb2 = sorted((sx * 22, sx * 19))
            za2, zb2 = sorted((sz * 22, sz * 19))
            m.box(xa2, 2.2, za2, xb2, 4.2, zb2, "pad_white", v="block")
    m.box(-19, 3.9, -22, 19, 4.2, -20, "grate", v="catwalk")
    m.box(-19, 3.9, 20, 19, 4.2, 22, "grate", v="catwalk")
    for x in (-10, 0, 10):
        m.box(x - 0.15, 0, -21.15, x + 0.15, 3.9, -20.85, "metal", v="post")
        m.box(x - 0.15, 0, 20.85, x + 0.15, 3.9, 21.15, "metal", v="post")

    # --- Wall-jump chimneys (east and west walls)
    for sx in (-1, 1):
        xa, xb = sorted((sx * 22, sx * 18))
        m.box(xa, 0, -1.6, xb, 5.0, -1.2, "pad_white", v="wall")
        m.box(xa, 0, 1.2, xb, 5.0, 1.6, "pad_white", v="wall")
        xc, xd = sorted((sx * 22, sx * 20))
        m.box(xc, 0, -1.2, xd, 4.0, 1.2, "pad_blue", v="block")

    # --- Side lanes: alternating vault walls and slide bars
    for sx in (-1, 1):
        x0, x1 = sorted((sx * 15, sx * 11.5))
        for i, z in enumerate((-12.5, -8.0, 8.0, 12.5)):
            if i % 2 == 0:
                m.box(x0, 0, z - 0.3, x1, 0.95, z + 0.3, "pad_orange", v="block")
            else:
                m.bar(x0, z, x1, z)
    # Mid-ring pillars (cover / juke points)
    for (x, z) in ((-11, -15), (11, -15), (-11, 15), (11, 15)):
        m.boxc(x, z, 1.4, 1.4, 0, 3.4, "pad_white", v="pillar")
    m.boxc(0, -14, 5, 1.2, 0, 1.2, "pad_blue", v="block")
    m.boxc(0, 14, 5, 1.2, 0, 1.2, "pad_blue", v="block")

    # Jump pads onto catwalks
    m.pad(-12, 0, -16, 0, 17.5, -6.0)
    m.pad(12, 0, 16, 0, 17.5, 6.0)

    for p in ((-6, 0, -12), (6, 0, 12), (-12, 0, 6), (12, 0, -6), (0, 0, -18), (0, 0, 18),
              (-17, 0, -6), (17, 0, 6), (-6, 0, 11), (6, 0, -11), (-14, 0, 0.5), (14, 0, -0.5)):
        m.spawn(*p)

    m.decor("scoreboard", p=[0, 9.5, 0], w=6, h=3)
    m.decor("arena_lights", h=11.6)
    m.decor("bleachers", inner=22.5)
    m.decor("banner", p=[0, 1.7, -21.95], rot=0, w=14, h=2.2, text="PULSE ARENA", color="#ff5a3d")
    m.decor("banner", p=[0, 1.7, 21.95], rot=180, w=14, h=2.2, text="CHASE  ·  EVADE  ·  TAG", color="#3d9bff")
    m.decor("floor_lines", r=8.5)
    return m.write()


# =============================================================================
# MAP 3 - DOCKYARD: a sunset container port with stacks, a warehouse and cranes.
# =============================================================================
def build_docks():
    m = MapBuilder("docks", "Sunset Dockyard", "docks",
                   "A container port at golden hour. Stack-hop the containers, cut through the warehouse, ride the cargo launchers.",
                   44, 34)
    m.env(sky=["#2b3a6b", "#e8875a", "#ffcf8a"], fog="#d8916a", fogNear=60, fogFar=190,
          sun=[-0.7, 0.42, 0.25], sunColor="#ffc48a", sunIntensity=2.4, ambient="#a495c8",
          ambientIntensity=1.35, hemiGround="#6a5446", exposure=1.0, water=True, music="sunset",
          events=["fog", "coinrain", "surge", "lowgrav"])

    m.box(-44, -1, -34, 44, 0, 34, "asphalt")
    m.invisible_bounds()
    # Quay edge bollards (south edge faces the water)
    for x in range(-40, 44, 8):
        m.boxc(x, 32.6, 0.6, 0.6, 0, 0.7, "metal", v="bollard")

    rng = random.Random(7)
    colors = ["container_red", "container_blue", "container_green", "container_orange", "container_yellow", "container_teal"]
    L, W, H = 12.2, 2.44, 2.6

    def container(x0, z0, along_x=True, level=0, col=None):
        col = col or rng.choice(colors)
        y0 = level * H
        if along_x:
            return m.box(x0, y0, z0, x0 + L, y0 + H, z0 + W, col, v="container")
        return m.box(x0, y0, z0, x0 + W, y0 + H, z0 + L, col, v="container")

    # Row block west (containers along x), with stacking for climbing routes
    rows = [(-40, -28), (-40, -22), (-40, -16)]
    for (x, z) in rows:
        container(x, z)
        container(x + L + 1.2, z)
    container(-40, -28, level=1)          # 2-high
    container(-27.8, -22, level=1)
    container(-27.8, -22 + 0.0, level=2, col="container_red")  # 3-high tower
    m.stairs(-15.6, -13.6, -22, -16, 0, 2.6, "-z", 6, m="metal")  # steel steps up to the stacks

    # East block: containers along z forming alleys
    for i, x in enumerate((20, 25, 30, 35)):
        container(x, -30, along_x=False)
        if i % 2 == 0:
            container(x, -30, along_x=False, level=1)
        container(x, -14, along_x=False)
    m.box(22.44, 2.6, -24, 25, 2.9, -22.5, "wood", v="plank")      # plank between stacks
    m.box(32.44, 2.6, -24, 35, 2.9, -22.5, "wood", v="plank")

    # Warehouse (centre-north): hollow shell with doors, internal catwalk
    wx0, wx1, wz0, wz1, wh = -10, 12, -32, -12, 8.0
    t = 0.5
    m.box(wx0, 0, wz0, wx1, wh, wz0 + t, "corrugated", v="wall")          # back wall
    m.box(wx0, 0, wz0, wx0 + t, wh, wz1, "corrugated", v="wall")          # west wall
    m.box(wx1 - t, 0, wz0, wx1, wh, -24, "corrugated", v="wall")         # east wall (door gap -24..-18)
    m.box(wx1 - t, 0, -18, wx1, wh, wz1, "corrugated", v="wall")
    m.box(wx1 - t, 3.6, -24, wx1, wh, -18, "corrugated", v="wall")      # lintel over east door
    m.box(wx0, 0, wz1 - t, -4, wh, wz1, "corrugated", v="wall")          # front wall left
    m.box(4, 0, wz1 - t, wx1, wh, wz1, "corrugated", v="wall")           # front wall right
    m.box(-4, 4.2, wz1 - t, 4, wh, wz1, "corrugated", v="wall")          # lintel over front door
    m.box(wx0, wh, wz0, wx1, wh + 0.4, wz1, "corrugated", mt="roof_metal", v="roof")
    # inside: catwalk along back wall + stairs, pallets, a forklift-height shelf
    m.box(wx0 + t, 3.8, wz0 + t, wx1 - t, 4.1, wz0 + 3, "grate", v="catwalk")
    m.stairs(wx0 + t, wx0 + 3, -26, wz0 + 3, 0, 4.1, "-z", 10, m="metal")
    m.box(-2, 0, -22, 4, 1.0, -20.8, "wood", v="pallet")
    m.box(5, 0, -27, 6.4, 2.2, -21, "metal", v="shelf")
    m.bar(-6, -16, 0, -16, base_y=0)
    # skylight exit: crate stack inside reaches the catwalk; ladder-ish blocks outside to the roof
    m.box(12, 0, -31, 14.44, 2.6, -18.8, "container_blue", v="container")
    m.box(12, 2.6, -31, 14.44, 5.2, -25, "container_teal", v="container")
    m.pad(16, 0, -10, -3.2, 18.5, -4.6, "#ffb43d")                     # launcher to warehouse roof

    # Cranes: tall legs (solid) with decorative beams
    for cx in (-24, 6, 30):
        for cz in (12, 24):
            m.boxc(cx - 4, cz, 1.0, 1.0, 0, 16, "crane", v="crane_leg")
            m.boxc(cx + 4, cz, 1.0, 1.0, 0, 16, "crane", v="crane_leg")
        m.decor("crane", p=[cx, 0, 18], span=8, h=16, depth=12)

    # Quay yard (south): scattered containers + crate clusters
    container(-34, 6, along_x=True)
    container(-34, 6, along_x=True, level=1)
    m.ramp(-21.8, 0, 6, -18, 2.6, 8.44, "-x", m="metal", v="catwalk")  # ramp onto the stack
    container(-8, 4, along_x=False)
    container(-4, 4, along_x=False)
    m.box(-5.56, 2.3, 9, -4, 2.6, 11, "wood", v="plank")
    container(14, 2, along_x=True)
    container(18, 2, along_x=True, level=1)
    container(30, 6, along_x=False)
    for (x, z) in ((-14, 0), (2, -4), (10, 12), (24, -4), (-30, 20), (38, 20), (-40, 0), (0, 26)):
        m.boxc(x, z, 1.6, 1.6, 0, 1.2, "wood", v="crate")
        m.boxc(x + 1.7, z + 0.2, 1.4, 1.4, 0, 0.9, "wood", v="crate")
    m.bar(-30, -6, -22, -6)
    m.bar(26, 28, 34, 28)
    m.pad(-12, 0, 18, 7.0, 16.0, -3.0, "#ffb43d")

    for p in ((-20, 0, 0), (0, 0, 0), (20, 0, 10), (-36, 0, -6), (40, 0, -4), (-6, 0, 20),
              (10, 0, 26), (-30, 0, 28), (2, 0, -24), (28.6, 0, -24), (-26, 0, -10), (40, 0, 30)):
        m.spawn(*p)

    m.decor("water", y=-1.2)
    m.decor("lamp", p=[-20, 0, 30], h=6, color="#ffd9a0")
    m.decor("lamp", p=[10, 0, 30], h=6, color="#ffd9a0")
    m.decor("lamp", p=[38, 0, -30], h=6, color="#ffd9a0")
    m.decor("neon_sign", p=[1, 5.6, -11.7], rot=0, w=8, h=1.4, text="WAREHOUSE 7", color="#ffb43d")
    m.decor("ship", p=[0, 0, 60], len=110)
    m.decor("gulls", p=[0, 22, 10])
    return m.write()


# =============================================================================
# MAP 4 - TRAINING GROUND: labelled stations for practising every move.
# =============================================================================
def build_training():
    m = MapBuilder("training", "Training Ground", "training",
                   "A clean practice facility with a labelled station for every movement skill.",
                   30, 22)
    m.env(sky=["#3a7bd5", "#9ad0ff", "#e8f6ff"], fog="#cfe6ff", fogNear=70, fogFar=200,
          sun=[-0.4, 0.85, 0.3], sunColor="#fff4e0", sunIntensity=2.6, ambient="#a6c8ff",
          ambientIntensity=0.9, hemiGround="#6b7f6b", exposure=1.0, music="training",
          events=["coinrain", "lowgrav", "surge"])
    m.box(-30, -1, -22, 30, 0, 22, "grid")
    m.invisible_bounds()
    m.box(-30.5, 0, -22.5, 30.5, 1.2, -22, "concrete", v="parapet")
    m.box(-30.5, 0, 22, 30.5, 1.2, 22.5, "concrete", v="parapet")
    m.box(-30.5, 0, -22, -30, 1.2, 22, "concrete", v="parapet")
    m.box(30, 0, -22, 30.5, 1.2, 22, "concrete", v="parapet")

    # Station 1: VAULT row
    for i, h in enumerate((0.6, 0.9, 1.2)):
        m.box(-24 + i * 3.5, 0, -18, -22.8 + i * 3.5, h, -14, "pad_orange", v="block")
    m.decor("station_sign", p=[-20.5, 0, -12.6], text="VAULT", sub="Run into low walls (or press E)")
    # Station 2: SLIDE tunnel
    m.box(-9, 1.0, -18, -3, 1.4, -14, "pad_white", v="tunnel")
    m.box(-9, 0, -18.4, -3, 1.4, -18, "pad_blue", v="wall")
    m.box(-9, 0, -14, -3, 1.4, -13.6, "pad_blue", v="wall")
    m.decor("station_sign", p=[-6, 0, -12.6], text="SLIDE", sub="Run, then press C to slide under")
    # Station 3: MANTLE steps
    for i, h in enumerate((1.6, 2.4, 3.2)):
        m.box(2 + i * 3, 0, -18, 5 + i * 3, h, -14, "pad_blue", v="block")
    m.decor("station_sign", p=[6.5, 0, -12.6], text="CLIMB", sub="Jump at a ledge to mantle up")
    # Station 4: WALL JUMP chimney
    m.box(16, 0, -20, 16.4, 6, -12, "pad_white", v="wall")
    m.box(19, 0, -20, 19.4, 6, -12, "pad_white", v="wall")
    m.box(16.4, 0, -20, 19, 5.0, -18, "pad_blue", v="block")
    m.decor("station_sign", p=[17.7, 0, -10.6], text="WALL JUMP", sub="Jump again while touching a wall")
    # Station 5: GAP jumps (platforms at 2.0 with growing gaps)
    xs = [-26, -21.5, -16.5, -11]
    for i, x in enumerate(xs):
        m.box(x, 0, 6, x + 3, 2.0, 10, "pad_white", v="block")
    m.stairs(-29.5, -26, 6, 10, 0, 2.0, "+x", 5, m="pad_blue")
    m.decor("station_sign", p=[-18, 0, 11.4], text="GAP JUMP", sub="Sprint and jump between platforms")
    # Station 6: JUMP PAD to a high deck
    m.box(4, 0, 12, 14, 5.0, 20, "pad_blue", v="block")
    m.stairs(14, 17, 12, 20, 0, 5.0, "-x", 12, m="pad_white")
    m.pad(9, 0, 8, 0, 18.5, 6.0)
    m.decor("station_sign", p=[9, 0, 6.2], text="JUMP PAD", sub="Step on the glowing pad")
    # Station 7: DODGE lane with slalom pillars + a ramp
    for i, x in enumerate(range(20, 29, 3)):
        m.boxc(x, 4 + (1.2 if i % 2 else -1.2), 0.8, 0.8, 0, 2.2, "pad_white", v="pillar")
    m.ramp(20, 0, 12, 28, 2.0, 16, "+x", m="pad_orange", v="aframe")
    m.box(28, 0, 12, 30, 2.0, 16, "pad_orange", v="block")
    m.decor("station_sign", p=[24, 0, 1.0], text="DODGE", sub="Dodge right as IT reaches you = PERFECT")
    # Open centre for tag practice
    m.boxc(-2, 0, 2, 2, 0, 1.0, "pad_orange", v="block")
    m.bar(2.5, -2, 2.5, 2)

    for p in ((-2, 0, -6), (2, 0, -6), (-6, 0, 4), (6, 0, 4), (0, 0, 8), (-12, 0, 0), (12, 0, 0),
              (-24, 0, 0), (24, 0, -8), (-8, 0, 16), (18, 0, 8), (0, 0, -10)):
        m.spawn(*p)
    m.decor("trees", ring=36, count=40)
    return m.write()


# =============================================================================
# MAP 5 - OVERGROWN MALL (v1.02): an abandoned three-storey mall reclaimed by plants.
# =============================================================================
SHOP_NAMES = [("SNEAKERS", "#ff5a3d"), ("BOOKS", "#ffd23d"), ("TOYS", "#7dff6b"), ("TECH", "#3df5ff"), ("CAFE", "#ffb36b"),
              ("FASHION", "#ff6bd6"), ("MUSIC", "#b48cff"), ("SPORTS", "#5aa0ff"), ("BEAUTY", "#ff8fb0"), ("GAMES", "#7dff6b"),
              ("JEWEL", "#fff3a8"), ("PHONES", "#3df5ff"), ("DONUTS", "#ff9f6b"), ("PETS", "#9fe06b"), ("TOOLS", "#ffd23d")]


def build_mall():
    m = MapBuilder("mall", "Overgrown Mall", "mall",
                   "A huge abandoned three-storey mall reclaimed by plants. Ride the escalators, cross the sky bridge, drop into the fountain.",
                   60, 44)
    m.env(sky=["#6fa8dc", "#cfe3f2", "#eef4f0"], fog="#c3d1c8", fogNear=45, fogFar=150,
          sun=[0.22, 0.93, 0.28], sunColor="#fff2d6", sunIntensity=2.3, ambient="#d4e4dc",
          ambientIntensity=1.3, hemiGround="#5a5f4c", exposure=1.05, indoor=True, music="mall", beltSpeed=2.6,
          events=["blackout", "slick", "coinrain", "surge"])
    L0, L1, L2, TOP = 0.0, 5.5, 11.0, 16.5
    X, Z = 60, 44
    m.box(-X, -1, -Z, X, 0, Z, "mossy")
    m.invisible_bounds(height=TOP + 2)
    m.box(-X, TOP, -Z, X, TOP + 1, Z, "invisible")  # roof: nobody climbs out of the skylight
    for (x0, z0, x1, z1) in ((-X - 1, -Z - 1, X + 1, -Z), (-X - 1, Z, X + 1, Z + 1), (-X - 1, -Z, -X, Z), (X, -Z, X + 1, Z)):
        m.box(x0, 0, z0, x1, TOP, z1, "plaster", v="wall")

    ATR = (-24, -12, 24, 12)
    ST_NW = (-58, -42, -51, -32)
    ST_SE = (51, 32, 58, 42)
    CAVE = (-40, 5, -30, 11)
    m.slab(-X, -Z, X, Z, L1, holes=(ATR, ST_NW, ST_SE, CAVE), m="plaster", mt="marble", v="floor")
    m.slab(-X, -Z, X, Z, L2, holes=((-24, -12, X, 12), ST_NW, ST_SE), m="plaster", mt="marble", v="floor")

    # --- atrium edges: glass balustrades with gaps (escalator tops, drop-downs, the jump pad)
    m.railing(-24, -12, 24, -12, L1, gaps=[(-10, -5.8), (14, 16), (18, 21)])
    m.railing(-24, 12, 24, 12, L1, gaps=[(5.8, 10), (-16, -14), (-21, -18)])
    m.railing(-24, -12, -24, 12, L1, gaps=[(0, 4), (-6, -3)])
    m.railing(24, -12, 24, 12, L1, gaps=[(-2, 2)])
    m.railing(-24, -12, X, -12, L2, gaps=[(-16, -14), (-1.5, 1.5), (30, 33)])
    m.railing(-24, 12, X, 12, L2, gaps=[(14, 16), (-1.5, 1.5), (40, 43)])
    m.railing(-24, -12, -24, 12, L2, gaps=[(-2, 2)])
    # caved-in floor: rusty railings, partly torn away
    m.railing(-40, 5, -30, 5, L1, m="metal", gaps=[(-37, -35)])
    m.railing(-40, 11, -30, 11, L1, m="metal", gaps=[(-33, -31)])
    m.railing(-30, 5, -30, 11, L1, m="metal")
    m.ramp(-40, 0, 5.2, -30, L1, 10.8, "-x", lo=0, m="concrete", mt="mossy", v="rubble")

    # --- escalators: ground <-> first floor (up + down pairs) and two long ones to the top floor
    m.escalator(-10, -12, -8, -1, L0, L1, "-z", up=True)
    m.escalator(-7.8, -12, -5.8, -1, L0, L1, "-z", up=False)
    m.escalator(8, 1, 10, 12, L0, L1, "+z", up=True)
    m.escalator(5.8, 1, 7.8, 12, L0, L1, "+z", up=False)
    m.escalator(14, -12, 16, 12, L1, L2, "+z", up=True, segments=4)
    m.escalator(-16, -12, -14, 12, L1, L2, "-z", up=True, segments=4)
    # sky bridge across the atrium (top floor), open in the middle for a fountain dive
    m.box(-1.5, L2 - 0.5, -12, 1.5, L2, 12, "plaster", mt="marble", v="bridge")
    m.railing(-1.5, -12, -1.5, 12, L2, gaps=[(-3, 3)])
    m.railing(1.5, -12, 1.5, 12, L2, gaps=[(-3, 3)])

    # --- stairwells (ground -> first -> top), NW and SE corners
    m.stairs(-58, -54.5, -42, -32, L0, L1, "-z", 14, m="concrete")
    m.stairs(-54.5, -51, -42, -32, L1, L2, "+z", 14, m="concrete")
    m.stairs(54.5, 58, 32, 42, L0, L1, "+z", 14, m="concrete")
    m.stairs(51, 54.5, 32, 42, L1, L2, "-z", 14, m="concrete")

    # --- the atrium floor: fountain, planters with trees, a launch pad up to the west wing
    m.water_circle(0, 0, 4.3, surf=0.42, s=0.7)
    m.boxc(0, 0, 1.1, 1.1, 0, 2.4, "marble", v="fountain")
    for sx in (-1, 1):
        for sz in (-1, 1):
            m.boxc(sx * 20, sz * 8.5, 4, 4, 0, 0.9, "planter", v="planter")
            m.decor("tree_big", p=[sx * 20, 0.9, sz * 8.5], s=1.15)
            m.decor("grass", p=[sx * 20, 0.9, sz * 8.5], w=3.6, d=3.6, n=10)
    m.pad(-21, 0, 2, -6.0, 20.5, 0.0, "#7dff6b")
    for (x, z) in ((-4, -9), (4, 9), (11, -6), (-11, 6)):
        m.boxc(x, z, 2.4, 0.7, 0, 0.5, "wood", v="bench")

    # --- shops along the north and south walls on every floor
    names = iter(SHOP_NAMES * 4)
    for level in (L0, L1, L2):
        for side in (-1, 1):
            xs = list(range(-48, 61, 12)) if side < 0 else list(range(-60, 49, 12))
            zf = side * 35  # shopfront line
            zb = side * Z   # back wall
            for i in range(len(xs) - 1):
                x0, x1 = xs[i], xs[i + 1]
                xm = (x0 + x1) / 2
                za, zz = sorted((zf, zb))
                m.box(x0 - 0.15, level, za, x0 + 0.15, level + 4.9, zz, "plaster", v="wall")  # partition
                fz0, fz1 = zf - 0.1, zf + 0.1
                m.box(x0 + 0.15, level, fz0, xm - 2, level + 4.3, fz1, "shopfront", v="glass")
                m.box(xm + 2, level, fz0, x1 - 0.15, level + 4.3, fz1, "shopfront", v="glass")
                m.box(x0 + 0.15, level + 4.3, fz0, x1 - 0.15, level + 4.9, fz1, "plaster", v="lintel")
                # inside: a counter you can vault, a tall shelf you can climb
                cz = zf + side * 3.5
                m.box(x0 + 1.5, level, cz - 0.4, x0 + 4.5, level + 1.0, cz + 0.4, "wood", v="counter")
                sz0, sz1 = sorted((zb - side * 0.7, zb - side * 0.05))
                m.box(x0 + 1.0, level, sz0, x1 - 1.0, level + 2.2, sz1, "metal", v="shelf")
                name, col = next(names)
                m.decor("shop_sign", p=[xm, level + 4.6, zf + side * -0.18], rot=0 if side < 0 else 180, w=4.2, text=name, color=col)
            last = xs[-1]
            za, zz = sorted((zf, zb))
            m.box(last - 0.15, level, za, last + 0.15, level + 4.9, zz, "plaster", v="wall")

    # --- ground floor wings: department store (west), supermarket aisles (east)
    m.bar(-56, -6, -46, -6, y_bottom=1.05, y_top=1.35, thickness=0.12, m="metal")
    m.bar(-56, 2, -46, 2, y_bottom=1.05, y_top=1.35, thickness=0.12, m="metal")
    for (x, z, r) in ((-52, -9, 0), (-48, -9, 30), (-56, -2, -20), (-50, 6, 90), (-46, -2, 180)):
        m.boxc(x, z, 1.2, 1.2, 0, 0.35, "wood", v="plinth")
        m.decor("mannequin", p=[x, 0.35, z], rot=r)
    for z in (-9.5, -5.5, -1.5, 2.5, 6.5):
        m.box(30, 0, z, 40, 1.5, z + 0.8, "metal", v="shelf")
        m.box(42, 0, z, 54, 1.5, z + 0.8, "metal", v="shelf")
    m.box(26, 0, 9.5, 29, 1.1, 11.5, "wood", v="counter")
    # --- first floor: food court (east), indoor garden (west)
    for x in (31, 37, 43, 49, 55):
        for z in (-9, -4, 4, 9):
            m.boxc(x, z, 1.4, 1.4, L1, L1 + 0.75, "wood", v="table")
    m.boxc(45, 0, 3, 3, L1, L1 + 2.8, "wood", v="kiosk")
    for (x, z) in ((-50, -6), (-34, -6), (-52, 4)):
        m.boxc(x, z, 4, 4, L1, L1 + 0.9, "planter", v="planter")
        m.decor("tree_big", p=[x, L1 + 0.9, z], s=1.0)
        m.decor("grass", p=[x, L1 + 0.9, z], w=3.6, d=3.6, n=8)
    # --- top floor: arcade cabinets (west)
    for z in (-8, -3, 3, 8):
        for x in (-54, -50, -46, -42, -38):
            m.boxc(x, z, 1.0, 0.8, L2, L2 + 1.9, "metal", v="cabinet")

    # --- corridors: kiosks, benches, planters
    for level, z in ((L0, -24), (L0, 24), (L1, -24), (L1, 24), (L2, -24), (L2, 24)):
        for x in (-36, 36):
            m.boxc(x, z, 3, 3, level, level + 2.6, "wood", v="kiosk")
        for x in (-20, 0, 20):
            m.boxc(x, z, 3, 1.2, level, level + 0.9, "planter", v="planter")
            m.decor("shrubs", p=[x, level + 0.9, z], w=2.6, d=0.9, n=6)

    # Spawns (ground, first floor, top floor)
    for p in ((-40, L0, -18), (40, L0, -18), (-40, L0, 18), (40, L0, 18), (0, L0, -20), (0, L0, 20), (-50, L0, -14.5),
              (20, L0, 0), (-45, L1, -20), (45, L1, 22), (-44, L1, 1), (40, L1, 0), (-40, L2, -20), (40, L2, 20), (-28, L2, 0)):
        m.spawn(*p)

    # --- decor: the overgrowth, the light, the landmark
    m.decor("skylight", x0=-24, z0=-12, x1=24, z1=12, y=TOP + 0.05)
    m.decor("ceiling", y=TOP, x0=-X, z0=-Z, x1=X, z1=Z, holes=[list(ATR)], color="#8d918a", emissive="#2c2e2a")
    m.decor("chandelier", p=[0, TOP - 1.5, 0], r=6)
    m.decor("light_shafts", pts=[[-8, TOP, -4], [6, TOP, 5], [14, TOP, -6], [-16, TOP, 7]], r=3.2, h=TOP)
    for level in (L1, L2):
        m.decor("vines", a=[-24, level - 0.5, -12.1], b=[24, level - 0.5, -12.1], len=3.8)
        m.decor("vines", a=[-24, level - 0.5, 12.1], b=[24, level - 0.5, 12.1], len=3.8)
        m.decor("vines", a=[-24.1, level - 0.5, -12], b=[-24.1, level - 0.5, 12], len=3.8)
    m.decor("vines", a=[24.1, L1 - 0.5, -12], b=[24.1, L1 - 0.5, 12], len=3.8)
    m.decor("vines", a=[24, L2 - 0.5, -12.1], b=[X, L2 - 0.5, -12.1], len=4.5)
    m.decor("vines", a=[24, L2 - 0.5, 12.1], b=[X, L2 - 0.5, 12.1], len=4.5)
    for (y, holes) in ((L1 - 0.52, [list(ATR), list(ST_NW), list(ST_SE), list(CAVE)]), (L2 - 0.52, [[-24, -12, X, 12], list(ST_NW), list(ST_SE)]), (TOP - 0.02, [list(ATR)])):
        m.decor("ceiling_lights", y=y, x0=-X, z0=-Z, x1=X, z1=Z, step=8, holes=holes, broken=0.3)
    em = []
    for level in (L0, L1, L2):
        for x in range(-56, 57, 14):
            em.append([x, level + 3.6, -Z + 0.2])
            em.append([x, level + 3.6, Z - 0.2])
        for z in range(-40, 41, 14):
            em.append([-X + 0.2, level + 3.6, z])
            em.append([X - 0.2, level + 3.6, z])
    m.decor("emergency_lights", pts=em)
    m.decor("fountain", p=[0, 0, 0], r=4.6)
    m.decor("rubble", p=[-35, 0, 8], w=8, d=5, n=16)
    m.decor("rubble", p=[-36, 0, 3], w=4, d=2, n=8)
    m.decor("shrubs", p=[-35, 0.3, 8], w=8, d=5, n=10)
    for (x, z) in ((-44, -24), (44, 24), (-12, -28), (12, 28), (-50, 20), (50, -20), (30, -30), (-30, 30)):
        m.decor("grass", p=[x, 0, z], w=6, d=4, n=14)
        m.decor("shrubs", p=[x, 0, z], w=5, d=3, n=6)
    m.decor("banner", p=[0, L2 + 3.2, -12.15], rot=0, w=12, h=1.8, text="GRAND MALL", color="#3a5a3a")
    return m.write()


# =============================================================================
# MAP 6 - TOY FACTORY (v1.02): conveyor belts, giant toys, catwalks and a ball pit.
# =============================================================================
def build_factory():
    m = MapBuilder("factory", "Toy Factory", "factory",
                   "A giant toy factory. Ride the conveyor belts, climb the toy blocks, run the catwalks and take the chute into the ball pit.",
                   64, 50)
    m.env(sky=["#7fb6e8", "#cfe6ff", "#eef6ff"], fog="#d3dae4", fogNear=55, fogFar=165,
          sun=[-0.3, 0.9, 0.25], sunColor="#fff6e8", sunIntensity=2.1, ambient="#e2e8f4",
          ambientIntensity=1.4, hemiGround="#6b6f78", exposure=1.0, indoor=True, music="factory", beltSpeed=3.0,
          events=["blackout", "overdrive", "lowgrav", "coinrain"])
    X, Z, TOP, CW = 64, 50, 18.0, 6.0
    m.box(-X, -1, -Z, X, 0, Z, "factory_floor")
    m.invisible_bounds(height=TOP + 1)
    m.box(-X, TOP, -Z, X, TOP + 1, Z, "invisible")
    for (x0, z0, x1, z1) in ((-X - 1, -Z - 1, X + 1, -Z), (-X - 1, Z, X + 1, Z + 1), (-X - 1, -Z, -X, Z), (X, -Z, X + 1, Z)):
        m.box(x0, 0, z0, x1, TOP, z1, "plaster_green", v="wall")

    # --- catwalk ring at 6 m + two cross bridges (grates), with railings and posts
    m.box(-X, CW - 0.3, -Z, X, CW, -Z + 4, "grate", v="catwalk")
    m.box(-X, CW - 0.3, Z - 4, X, CW, Z, "grate", v="catwalk")
    m.box(-X, CW - 0.3, -Z + 4, -X + 4, CW, Z - 4, "grate", v="catwalk")
    m.box(X - 4, CW - 0.3, -Z + 4, X, CW, Z - 4, "grate", v="catwalk")
    m.box(-2, CW - 0.3, -Z + 4, 2, CW, Z - 4, "grate", v="catwalk")
    m.box(-X + 4, CW - 0.3, -2, X - 4, CW, 2, "grate", v="catwalk")
    m.railing(-X + 4, -Z + 4, X - 4, -Z + 4, CW, m="metal", gaps=[(-40, -37), (-2, 2), (20, 24)])
    m.railing(-X + 4, Z - 4, X - 4, Z - 4, CW, m="metal", gaps=[(37, 40), (-2, 2), (5, 9), (-26, -22)])
    m.railing(-X + 4, -Z + 4, -X + 4, Z - 4, CW, m="metal", gaps=[(-24, -20), (6, 10), (-2, 2)])
    m.railing(X - 4, -Z + 4, X - 4, Z - 4, CW, m="metal", gaps=[(22, 26), (-2, 2), (-30, -26)])
    for z in (-36, -24, -12, 12, 24, 36):
        m.boxc(-1.8, z, 0.3, 0.3, 0, CW - 0.3, "metal", v="post")
        m.boxc(1.8, z, 0.3, 0.3, 0, CW - 0.3, "metal", v="post")
    for x in (-48, -36, -24, -12, 12, 24, 36, 48):
        m.boxc(x, -1.8, 0.3, 0.3, 0, CW - 0.3, "metal", v="post")
        m.boxc(x, 1.8, 0.3, 0.3, 0, CW - 0.3, "metal", v="post")
    # stairs up to the catwalk (north-west and south-east)
    m.stairs(-40, -37, -46, -34, 0, CW, "-z", 16, m="metal")
    m.stairs(37, 40, 34, 46, 0, CW, "+z", 16, m="metal")

    # --- the production line: belts snake through the hall, a belt ramp feeds the packager
    m.belt(-52, -34, -12, -31.5, 1.1, "+x")
    m.belt(-12, -34, -9.5, -6, 1.1, "+z")
    m.belt(-9.5, -8.5, 30, -6, 1.1, "+x")
    m.ramp(30, 0, -8.5, 42, 4.0, -6, "+x", lo=1.1, m="machine", mt="belt_px", v="belt")
    m.conveyor(30, 1.0, -8.5, 42, 4.5, -6, 3.0, 0)
    m.box(42, 0, -12, 52, 4.0, -2, "machine_orange", v="machine")      # packager
    m.belt(20, 8, 22.5, 20, 1.1, "+z")
    m.belt(-40, 20, 22.5, 22.5, 1.1, "-x")
    m.belt(-42.5, 8, -40, 22.5, 1.1, "-z")
    # paint booth: the south belt runs straight through it (walk or ride through, climb its roof)
    m.box(-20, 4.2, 16, -8, 4.7, 26, "machine_cream", v="booth")
    m.box(-20, 0, 16, -8, 4.2, 16.4, "machine_cream", v="wall")
    m.box(-20, 0, 25.6, -8, 4.2, 26, "machine_cream", v="wall")
    m.stairs(-24, -20, 23, 26, 0, 4.7, "+x", 12, m="metal")

    # --- big machines
    m.box(-58, 0, -14, -50, 7.0, -4, "machine", v="machine")            # moulding press
    m.box(28, 0, 26, 36, 9.0, 34, "machine_cream", v="machine")         # gearbox tower
    m.box(-30, 0, -24, -16, 0.6, -16, "rubber", v="platform")           # robot cell floor
    # stamping press: slide under its mouth
    m.box(-36, 0, 30, -34, 5.0, 36, "machine_orange", v="machine")
    m.box(-26, 0, 30, -24, 5.0, 36, "machine_orange", v="machine")
    m.box(-34, 1.0, 30, -26, 5.0, 36, "machine", v="machine")
    m.decor("hazard", p=[-30, 0, 29], w=10, d=1.2)
    m.decor("hazard", p=[-30, 0, 37], w=10, d=1.2)

    # --- giant toy blocks: stairs of blocks up to the catwalk (east and west), plus loose stacks
    m.box(52, 0, 14, 56, 2, 18, "toy_red", v="block")
    m.box(52, 0, 18, 56, 4, 22, "toy_blue", v="block")
    m.box(56, 0, 22, 60, 6, 26, "toy_yellow", v="block")
    m.box(-52, 0, -24, -48, 2, -20, "toy_purple", v="block")
    m.box(-56, 0, -24, -52, 4, -20, "toy_yellow", v="block")
    m.box(-60, 0, -24, -56, 6, -20, "toy_green", v="block")
    blocks = [(10, -24, 2, "toy_red"), (12, -24, 2, "toy_blue"), (10, -22, 2, "toy_yellow"), (10, -24, 4, "toy_green"),
              (-20, 4, 2, "toy_blue"), (-18, 4, 2, "toy_red"), (-20, 4, 4, "toy_yellow"), (40, 12, 2, "toy_purple"),
              (42, 12, 2, "toy_green"), (40, 12, 4, "toy_red"), (-6, -40, 2, "toy_yellow"), (-4, -40, 2, "toy_blue")]
    for (x, z, top, mat) in blocks:
        m.box(x, top - 2, z, x + 2, top, z + 2, mat, v="block")

    # --- toy bins (vault onto them) and cardboard stacks
    for (x, z) in ((-46, -10), (-40, -10), (-46, 0), (-40, 0), (8, -18), (14, -18), (26, -30), (32, -30)):
        m.boxc(x, z, 4, 3, 0, 1.3, "crate", v="bin")
        m.decor("toy_pile", x0=x - 1.9, z0=z - 1.4, x1=x + 1.9, z1=z + 1.4, y=1.3, heap=0.5)
    for (x, z, h) in ((48, 30, 2.4), (50, 30, 1.2), (48, 32, 1.2), (-54, 36, 2.4), (-52, 36, 1.2), (24, 40, 1.2), (-10, 40, 2.4), (-8, 40, 1.2)):
        m.boxc(x, z, 2, 2, 0, h, "crate", v="crate")

    # --- ball pit + the toy chute down from the south catwalk
    m.box(0, 0, 28, 14, 1.0, 28.3, "pad_white", v="wall")
    m.box(0, 0, 41.7, 14, 1.0, 42, "pad_white", v="wall")
    m.box(0, 0, 28.3, 0.3, 1.0, 41.7, "pad_white", v="wall")
    m.box(13.7, 0, 28.3, 14, 1.0, 41.7, "pad_white", v="wall")
    m.zone(k="pit", b=[0.3, -0.3, 28.3, 13.7, 0.9, 41.7], s=0.55)
    m.decor("ball_pit", x0=0.4, z0=28.4, x1=13.6, z1=41.6, y=0.75)
    m.ride([(7, CW, 47.6), (7, 5.75, 44.6), (10.5, 5.0, 43.2), (12.8, 4.1, 40), (12.8, 3.1, 36), (10.5, 2.3, 32.4),
            (6.5, 1.6, 31.4), (3.6, 1.1, 34), (4.6, 0.8, 37.2), (7.5, 0.6, 37.5)], vmax=14, col=("#ffd23d", "#e23b3b"))

    # --- trampolines in the test area
    m.pad(4, 0, -20, -2.6, 20.0, 0.0, "#ff6bd6")
    m.pad(-56, 0, 8, -5.0, 21.0, 0.0, "#ff6bd6")

    for p in ((-40, 0, -20), (40, 0, -20), (-30, 0, 12), (40, 0, 4), (-20, 0, -42), (20, 0, -42), (-20, 0, 40),
              (24, 0, 34), (0, 0, 12), (-12, 0, 0), (-30, CW, -48), (30, CW, 48), (-62, CW, 30), (62, CW, -30), (0, CW, -20)):
        m.spawn(*p)

    # --- decor: windows, lights, the arms that build the toys, giant toys
    m.decor("ceiling", y=TOP, x0=-X, z0=-Z, x1=X, z1=Z, color="#9aa3ad", emissive="#30353c")
    m.decor("ceiling_lights", y=TOP - 0.05, x0=-X, z0=-Z, x1=X, z1=Z, step=10)
    m.decor("wall_windows", axis="x", at=-Z + 0.05, from_=-X, to=X, count=12, y=11, w=5, h=4, facing=0)
    m.decor("wall_windows", axis="x", at=Z - 0.05, from_=-X, to=X, count=12, y=11, w=5, h=4, facing=3.14159)
    em = [[x, CW + 2.5, -Z + 0.2] for x in range(-56, 57, 16)] + [[x, CW + 2.5, Z - 0.2] for x in range(-56, 57, 16)]
    em += [[-X + 0.2, 3, z] for z in range(-40, 41, 16)] + [[X - 0.2, 3, z] for z in range(-40, 41, 16)]
    m.decor("emergency_lights", pts=em)
    for (x, z, r, c) in ((-30, -36, 0, "#f08a3c"), (-20, -36, 0, "#3d9bff"), (10, -3.5, 180, "#f08a3c"), (20, -3.5, 180, "#7dff6b"), (-26, -20, 90, "#ff6bd6"), (-20, -20, 270, "#f08a3c")):
        m.decor("robot_arm", p=[x, 0.6 if -30 <= x <= -16 and -24 <= z <= -16 else 0, z], rot=r, color=c)
    for (x, y, z, r, rot) in ((-X + 0.4, 10, -20, 3, 90), (-X + 0.4, 12.5, -15, 2, 90), (X - 0.4, 10, 20, 3, 90), (X - 0.4, 13, 14, 2.2, 90), (0, 12, -Z + 0.4, 3.5, 0)):
        m.decor("gear", p=[x, y, z], r=r, rot=rot, color="#c9a227" if r > 2.5 else "#9aa6b8", speed=0.4 if r > 2.5 else -0.6)
    m.decor("duck", p=[20, 0, 36], s=1.4, rot=200)
    m.decor("teddy", p=[32, 9.0, 30], s=1.2, rot=180)
    m.decor("teddy", p=[-54, 7.0, -9], s=1.0, rot=90)
    m.decor("pipes", pts=[[-62, 14, -40], [-30, 14, -40], [-10, 15, -30], [10, 15, -30], [40, 14, -40], [62, 14, -40]], r=0.5, color="#9aa6b8")
    m.decor("pipes", pts=[[-62, 12.5, 40], [-20, 12.5, 40], [0, 13.5, 30], [30, 12.5, 40], [62, 12.5, 40]], r=0.4, color="#e23b3b")
    m.decor("banner", p=[0, 9.5, -Z + 0.1], rot=0, w=16, h=2.4, text="TOY FACTORY", color="#e23b3b")
    m.decor("banner", p=[-30, 4.4, 30], rot=0, w=6, h=0.8, text="STAMPING PRESS", color="#1a1a1a")
    m.decor("hazard", p=[4, 0, -20], w=3, d=3)
    return m.write()


# =============================================================================
# MAP 7 - SPLASH KINGDOM (v1.02): a sunny mega waterpark with rideable slides.
# =============================================================================
def build_waterpark():
    m = MapBuilder("waterpark", "Splash Kingdom", "waterpark",
                   "A sunny mega waterpark. Climb the spiral towers, ride the slides into the pools, weave through the loungers.",
                   66, 56)
    m.env(sky=["#2f7fd8", "#8fd0ff", "#e6f7ff"], fog="#cfeaff", fogNear=85, fogFar=240,
          sun=[0.45, 0.82, 0.35], sunColor="#fff6e0", sunIntensity=2.8, ambient="#c2e2ff",
          ambientIntensity=1.05, hemiGround="#c9bfa5", exposure=1.0, music="waterpark",
          events=["slick", "sliderush", "coinrain", "surge"])
    X, Z = 66, 56
    m.box(-X, -1, -Z, X, 0, Z, "tile_white")
    m.invisible_bounds()
    for (x0, z0, x1, z1) in ((-X, -Z, X, -Z + 1.2), (-X, Z - 1.2, X, Z), (-X, -Z + 1.2, -X + 1.2, Z - 1.2), (X - 1.2, -Z + 1.2, X, Z - 1.2)):
        m.box(x0, 0, z0, x1, 1.0, z1, "planter", v="hedge")

    # --- pools (wade through slowly; slides end in them)
    POOLS = [(-34, 20, 14), (26, 26, 10), (-26, -26, 9), (30, -24, 11), (40, 44, 6)]
    for (cx, cz, r) in POOLS:
        m.water_circle(cx, cz, r - 0.35, surf=0.38)
        m.decor("pool", c=[cx, cz], r=r)

    # --- spiral slide towers
    m.spiral_tower(0, -8, 15, rail_gaps=[("s", 2, 4), ("s", -1.6, 0.6), ("n", 2, 4)])
    m.spiral_tower(-52, -40, 12, rail_gaps=[("e", -43.8, -41.8), ("s", -55.8, -53.8)])
    m.spiral_tower(52, 4, 10, rail_gaps=[("s", 48.2, 50.2), ("n", 48.2, 50.2)])

    # --- the slides
    m.ride([(3, 15, -4.6), (3.5, 14.6, -1.5), (6, 13.4, 2.5), (11, 11.8, 5.5), (17, 10.2, 5.5), (21, 8.6, 8.5),
            (22, 6.8, 13), (21, 4.9, 17.5), (22, 3.0, 21.5), (23, 1.4, 23), (23.5, 0.6, 23.5)], vmax=18, col=("#ff3db0", "#2fd8e8"))
    m.ride([(3, 15, -11.4), (3.5, 14.6, -14.5), (7, 13.3, -18), (13, 11.6, -19), (18, 9.8, -16), (22, 8, -13),
            (26, 6.2, -15), (27.5, 4.4, -19), (27.5, 2.6, -22), (27, 1.3, -25), (27.5, 0.6, -27)], vmax=18, col=("#ff8a2f", "#ffd23d"))
    m.ride([(-0.5, 15, -4.6), (-1.5, 14.6, -1.6), (-5, 13.6, 1.5), (-10, 12.2, 4), (-16, 10.6, 5), (-20, 9, 9),
            (-22, 7.2, 13), (-24.5, 5.3, 17), (-27, 3.4, 19.5), (-30, 1.7, 20.5), (-33, 0.6, 20.5)], vmax=18, col=("#8a4fd8", "#2fd8e8"))
    m.ride([(-49.2, 12, -42.8), (-46, 11.6, -43), (-42, 10.6, -41.5), (-39.5, 9.3, -38), (-38.5, 7.8, -34), (-35, 6.3, -32),
            (-31.5, 4.8, -34), (-29.5, 3.3, -30.5), (-28.5, 1.8, -27.5), (-27, 0.6, -26.5)], vmax=16, col=("#2fd8e8", "#ffffff"))
    m.ride([(-54.8, 12, -37.2), (-55, 11.6, -34), (-54, 10.8, -28), (-50, 9.8, -20), (-47, 8.6, -12), (-48, 7.4, -4),
            (-46, 6.2, 3), (-43, 4.8, 9), (-40, 3.4, 13), (-38.5, 2, 16.5), (-39.2, 0.9, 19.5), (-40, 0.6, 21.5)], vmax=17, col=("#3cb54a", "#ffd23d"))
    m.ride([(48.8, 10, 7.2), (48, 9.6, 10.5), (45, 8.8, 14), (41, 7.6, 16), (37.5, 6.4, 19.5), (36, 5, 24),
            (33, 3.5, 27.5), (30, 2, 28.5), (27.5, 0.9, 27.5), (26.5, 0.6, 26.8)], vmax=16, col=("#ff3db0", "#ffffff"))
    m.ride([(48.8, 10, 0.8), (48, 9.6, -2.5), (46, 8.8, -6), (43.5, 7.6, -9), (41, 6.3, -12.5), (39, 5, -16),
            (36.5, 3.6, -19.5), (34, 2.3, -22), (32, 1.2, -23.5), (30.5, 0.6, -24)], vmax=16, col=("#2f7ae0", "#ffd23d"))

    # --- geyser pad: blasts you onto the big tower's deck
    m.pad(-8, 0, -14, 3.5, 31.0, 2.5, "#2fd8e8")

    # --- buildings with climbable roofs
    m.box(-12, 0, 46, 12, 4.2, 54, "stucco_pink", mt="roof", v="building")       # snack bar
    m.stairs(12, 14.5, 46, 54, 0, 4.2, "+z", 12, m="tile_teal")
    m.box(-62, 0, 44, -50, 3.5, 54, "stucco_blue", mt="roof", v="building")      # changing rooms
    m.boxc(-48.4, 49, 1.4, 1.4, 0, 1.8, "crate", v="crate")
    m.box(50, 0, -54, 62, 3.2, -46, "stucco", mt="roof", v="building")           # first aid
    m.boxc(48.5, -50, 1.4, 1.4, 0, 1.7, "crate", v="crate")
    # lifeguard chairs
    for (x, z) in ((-18, 8), (14, 34), (-14, -18), (44, -30), (34, 38)):
        m.boxc(x, z, 1.6, 1.6, 0, 2.2, "deck", v="lifeguard")
    # palm islands (raised planters)
    m.box(-6, 0, 18, 6, 0.9, 26, "planter", v="planter")
    for (x, z) in ((-50, 8), (52, 30), (-8, 40), (16, -40), (-40, -48), (58, -14), (-58, -12), (8, 12)):
        m.boxc(x, z, 2.4, 2.4, 0, 0.7, "planter", v="planter")
        m.decor("palm", p=[x, 0.7, z], h=6.5)
    for (x, z) in ((-4, 20), (3, 23), (0, 25)):
        m.decor("palm", p=[x, 0.9, z], h=7)
    m.decor("shrubs", p=[0, 0.9, 22], w=11, d=7, n=12)
    # loungers in rows by the pools (low: you can hop over them)
    lounger = 0
    for (cx, cz, r) in POOLS[:4]:
        for k in range(-3, 4):
            a = math.atan2(-cz, -cx) + k * 0.16
            x, z = cx + math.cos(a) * (r + 3.2), cz + math.sin(a) * (r + 3.2)
            mat = "toy_purple" if lounger % 2 else "toy_green"
            lounger += 1
            if abs(math.cos(a)) > abs(math.sin(a)):
                m.boxc(round(x, 2), round(z, 2), 2.0, 0.8, 0, 0.45, mat, v="lounger")
            else:
                m.boxc(round(x, 2), round(z, 2), 0.8, 2.0, 0, 0.45, mat, v="lounger")
            if k in (-2, 2):
                m.decor("umbrella", p=[round(x, 2), 0, round(z, 2)], color="#ffffff" if k < 0 else "#ff6b9a")
    # the funnel ride and the mushroom fountain
    m.boxc(48, -38, 2.2, 2.2, 0, 3.2, "stucco_blue", v="funnel")
    m.decor("funnel", p=[48, 0, -38], r=7, h=6, base=3.2)
    m.boxc(40, 44, 0.9, 0.9, 0, 2.2, "stucco", v="mushroom")
    m.decor("mushroom", p=[40, 0, 44], r=2.2, h=2.3)

    for p in ((-50, 0, -10), (50, 0, -30), (0, 0, 30), (-15, 0, -45), (15, 0, -45), (-55, 0, 32), (56, 0, 22),
              (-10, 0, 5), (12, 0, 5), (-40, 0, -5), (40, 0, -6), (-20, 0, 42), (20, 0, 42), (0, 15, -10), (-52, 12, -42), (0, 4.2, 50)):
        m.spawn(*p)

    m.decor("banner", p=[0, 3.2, 45.9], rot=180, w=10, h=1.5, text="SNACK SHACK", color="#ff3db0")
    m.decor("banner", p=[-56, 2.6, 43.9], rot=180, w=8, h=1.2, text="CHANGING ROOMS", color="#2f7ae0")
    m.decor("neon_sign", p=[0, 16.4, -12.1], rot=180, w=7, h=1.4, text="SPLASH KINGDOM", color="#2fd8e8")
    m.decor("bunting", a=[-12, 4.3, 46], b=[0, 15.2, -4.2])
    m.decor("bunting", a=[12, 4.3, 46], b=[3.9, 15.2, -4.2], colors=["#ffd23d", "#ff3db0", "#ffffff"])
    m.decor("bunting", a=[-52, 12.2, -36], b=[-34, 4, 6])
    return m.write()


MAPS = [build_rooftops, build_arena, build_docks, build_training, build_mall, build_waterpark, build_factory]


def main():
    print("Building PRO TAG maps...")
    index = []
    for fn in MAPS:
        data = fn()
        index.append({"id": data["id"], "name": data["name"], "theme": data["theme"],
                      "description": data["description"],
                      "size": [data["bounds"][2] - data["bounds"][0], data["bounds"][3] - data["bounds"][1]]})
    with open(os.path.join(OUT_DIR, "index.json"), "w", encoding="utf-8") as f:
        json.dump({"maps": index}, f, indent=2)
    print(f"  wrote assets/maps/index.json ({len(index)} maps)")


if __name__ == "__main__":
    sys.exit(main())
