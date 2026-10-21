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
        for s in solids:
            b = s["b"]
            w, d, top = b[3] - b[0], b[5] - b[2], b[4]
            if w * d > 1500 or w < 1.2 or d < 1.2 or top > 8.5 or top < 0.5 or s.get("hide") or s.get("v") in ("post", "leg", "bar", "mast", "crane_leg", "wall", "pillar"):
                continue
            x, z = (b[0] + b[3]) / 2, (b[2] + b[5]) / 2
            if not blocked(x, top, z):
                cands.append((round(x, 2), round(top + 0.9, 2), round(z, 2), top))
        bx0, bz0, bx1, bz1 = self.data["bounds"]
        rng = random.Random(len(self.data["solids"]))
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
          ambientIntensity=1.35, hemiGround="#1d1530", exposure=1.15, music="night")

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
          ambientIntensity=1.1, hemiGround="#2a2f3a", exposure=1.05, indoor=True, music="arena")

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
          ambientIntensity=1.35, hemiGround="#6a5446", exposure=1.0, water=True, music="sunset")

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
          ambientIntensity=0.9, hemiGround="#6b7f6b", exposure=1.0, music="training")
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


MAPS = [build_rooftops, build_arena, build_docks, build_training]


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
