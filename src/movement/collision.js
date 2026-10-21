// Collision world built from map JSON.
// Characters are vertical cylinders (circle in XZ + vertical extent); the world is a set of
// axis-aligned boxes, some of which are ramps (sloped top surface). A uniform grid gives
// cheap broad-phase queries. No three.js dependency: used by the client, bots and tests.

const CELL = 4;

export class Collider {
  constructor(src, id) {
    const b = src.b;
    this.id = id;
    this.x0 = b[0]; this.y0 = b[1]; this.z0 = b[2];
    this.x1 = b[3]; this.y1 = b[4]; this.z1 = b[5];
    this.m = src.m;
    this.v = src.v || null;
    this.invisible = src.m === 'invisible';
    this.ramp = null;
    if (src.ramp) {
      const axis = src.ramp[1] === 'x' ? 'x' : 'z';
      const sign = src.ramp[0] === '-' ? -1 : 1;
      this.ramp = { axis, sign, lo: src.lo ?? this.y0 };
    }
    this.stamp = 0;
  }

  /** Height of the top surface at (x, z) (clamped into the footprint). */
  topAt(x, z) {
    if (!this.ramp) return this.y1;
    const { axis, sign, lo } = this.ramp;
    let t;
    if (axis === 'x') t = (x - this.x0) / (this.x1 - this.x0);
    else t = (z - this.z0) / (this.z1 - this.z0);
    if (sign < 0) t = 1 - t;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return lo + (this.y1 - lo) * t;
  }
}

export class CollisionWorld {
  constructor(map) {
    this.map = map;
    this.colliders = map.solids.map((s, i) => new Collider(s, i));
    this.bounds = map.bounds; // [x0, z0, x1, z1]
    this.killY = map.killY ?? -12;
    this.pads = (map.pads || []).map((p) => ({ x: p.p[0], y: p.p[1], z: p.p[2], vx: p.v[0], vy: p.v[1], vz: p.v[2], r: p.r || 0.9 }));
    // zones: water (slows you) and conveyors / escalators (carry you); rides: water slides
    this.zones = (map.zones || []).map(parseZone);
    this.rides = (map.rides || []).map((r, i) => makeRide(r, i));
    this.conveyorScale = 1; // map events can reverse / speed up every belt at once
    this._stamp = 1;
    this._buildGrid();
  }

  /** The zone containing a point (feet position), or null. */
  zoneAt(x, y, z) {
    for (const zn of this.zones) {
      if (y < zn.y0 || y > zn.y1) continue;
      if (zn.cx !== undefined) {
        const dx = x - zn.cx, dz = z - zn.cz;
        if (dx * dx + dz * dz > zn.r2) continue;
      } else if (x < zn.x0 || x > zn.x1 || z < zn.z0 || z > zn.z1) continue;
      return zn;
    }
    return null;
  }

  _buildGrid() {
    const [bx0, bz0, bx1, bz1] = this.bounds;
    this.gx0 = Math.floor(bx0 / CELL) - 2;
    this.gz0 = Math.floor(bz0 / CELL) - 2;
    this.gw = Math.ceil(bx1 / CELL) + 2 - this.gx0 + 1;
    this.gd = Math.ceil(bz1 / CELL) + 2 - this.gz0 + 1;
    this.cells = new Array(this.gw * this.gd);
    for (let i = 0; i < this.cells.length; i++) this.cells[i] = [];
    this.big = []; // colliders spanning many cells (floors) are tested directly
    for (const c of this.colliders) {
      const cx0 = Math.floor(c.x0 / CELL) - this.gx0;
      const cx1 = Math.floor(c.x1 / CELL) - this.gx0;
      const cz0 = Math.floor(c.z0 / CELL) - this.gz0;
      const cz1 = Math.floor(c.z1 / CELL) - this.gz0;
      if ((cx1 - cx0 + 1) * (cz1 - cz0 + 1) > 64) {
        this.big.push(c);
        continue;
      }
      for (let x = Math.max(0, cx0); x <= Math.min(this.gw - 1, cx1); x++) {
        for (let z = Math.max(0, cz0); z <= Math.min(this.gd - 1, cz1); z++) this.cells[x + z * this.gw].push(c);
      }
    }
  }

  /** Collect colliders whose footprint may overlap the XZ rectangle. */
  query(x0, z0, x1, z1, out = []) {
    out.length = 0;
    const stamp = ++this._stamp;
    for (const c of this.big) {
      if (c.x1 >= x0 && c.x0 <= x1 && c.z1 >= z0 && c.z0 <= z1) out.push(c);
    }
    const cx0 = Math.max(0, Math.floor(x0 / CELL) - this.gx0);
    const cx1 = Math.min(this.gw - 1, Math.floor(x1 / CELL) - this.gx0);
    const cz0 = Math.max(0, Math.floor(z0 / CELL) - this.gz0);
    const cz1 = Math.min(this.gd - 1, Math.floor(z1 / CELL) - this.gz0);
    for (let x = cx0; x <= cx1; x++) {
      for (let z = cz0; z <= cz1; z++) {
        const list = this.cells[x + z * this.gw];
        for (let i = 0; i < list.length; i++) {
          const c = list[i];
          if (c.stamp === stamp) continue;
          c.stamp = stamp;
          if (c.x1 >= x0 && c.x0 <= x1 && c.z1 >= z0 && c.z0 <= z1) out.push(c);
        }
      }
    }
    return out;
  }

  /**
   * Highest walkable surface under a circle whose top is at or below `maxY`.
   * Returns { y, collider } or null.
   */
  groundBelow(x, z, r, maxY) {
    const list = this.query(x - r, z - r, x + r, z + r, this._tmp || (this._tmp = []));
    let best = -Infinity;
    let bestC = null;
    for (const c of list) {
      if (!circleOverlapsRect(x, z, r, c)) continue;
      const top = c.ramp ? c.topAt(x, z) : c.y1;
      if (top <= maxY + 1e-4 && top > best && c.y0 < top) {
        best = top;
        bestC = c;
      }
    }
    return bestC ? { y: best, collider: bestC } : null;
  }

  /**
   * Push a character circle out of every collider that overlaps its body between
   * (feetY + stepUp) and (feetY + height). Mutates pos. Returns number of contacts and
   * writes contact normals (averaged) into `outNormal`.
   */
  resolveHorizontal(pos, r, height, stepUp, outNormal) {
    let contacts = 0;
    let nx = 0;
    let nz = 0;
    const list = this.query(pos.x - r - 0.5, pos.z - r - 0.5, pos.x + r + 0.5, pos.z + r + 0.5, this._tmp2 || (this._tmp2 = []));
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (const c of list) {
        if (c.y0 >= pos.y + height - 0.02) continue; // entirely above head
        const cx = pos.x < c.x0 ? c.x0 : pos.x > c.x1 ? c.x1 : pos.x;
        const cz = pos.z < c.z0 ? c.z0 : pos.z > c.z1 ? c.z1 : pos.z;
        const top = c.ramp ? c.topAt(cx, cz) : c.y1;
        if (top <= pos.y + stepUp) continue; // walkable / step-able
        const dx = pos.x - cx;
        const dz = pos.z - cz;
        const d2 = dx * dx + dz * dz;
        if (d2 >= r * r) continue;
        let px, pz, depth;
        if (d2 > 1e-10) {
          const d = Math.sqrt(d2);
          px = dx / d;
          pz = dz / d;
          depth = r - d;
        } else {
          // centre inside the rectangle: push out along the axis of least penetration
          const left = pos.x - c.x0, right = c.x1 - pos.x, back = pos.z - c.z0, front = c.z1 - pos.z;
          const m = Math.min(left, right, back, front);
          if (m === left) { px = -1; pz = 0; depth = left + r; }
          else if (m === right) { px = 1; pz = 0; depth = right + r; }
          else if (m === back) { px = 0; pz = -1; depth = back + r; }
          else { px = 0; pz = 1; depth = front + r; }
        }
        pos.x += px * (depth + 1e-4);
        pos.z += pz * (depth + 1e-4);
        nx += px;
        nz += pz;
        contacts++;
        moved = true;
      }
      if (!moved) break;
    }
    if (outNormal) {
      const l = Math.hypot(nx, nz);
      outNormal.x = l > 0 ? nx / l : 0;
      outNormal.z = l > 0 ? nz / l : 0;
    }
    return contacts;
  }

  /** Lowest ceiling (collider bottom) above the head in (headFrom, headTo]. */
  ceilingBetween(x, z, r, headFrom, headTo) {
    const list = this.query(x - r, z - r, x + r, z + r, this._tmp || (this._tmp = []));
    let best = Infinity;
    for (const c of list) {
      if (c.y0 < headFrom - 0.05 || c.y0 > headTo) continue;
      if (!circleOverlapsRect(x, z, r * 0.9, c)) continue;
      if (c.y0 < best) best = c.y0;
    }
    return best === Infinity ? null : best;
  }

  /** True if a cylinder at (x, feetY, z) with radius r and height h touches no collider. */
  isFree(x, feetY, z, r, h) {
    const list = this.query(x - r, z - r, x + r, z + r, this._tmp || (this._tmp = []));
    for (const c of list) {
      if (!circleOverlapsRect(x, z, r, c)) continue;
      if (c.y0 >= feetY + h) continue;
      const top = c.ramp ? c.topAt(x, z) : c.y1;
      if (top <= feetY + 0.02) continue;
      return false;
    }
    return true;
  }

  /** Highest top of colliders touching a small probe circle, considering only those starting below `belowY`. */
  obstacleTop(x, z, r, minBottom, maxBottom) {
    const list = this.query(x - r, z - r, x + r, z + r, this._tmp || (this._tmp = []));
    let best = -Infinity;
    for (const c of list) {
      if (!circleOverlapsRect(x, z, r, c)) continue;
      if (c.y0 > maxBottom || c.y1 < minBottom) continue;
      const top = c.ramp ? c.topAt(x, z) : c.y1;
      if (top > best) best = top;
    }
    return best;
  }

  /**
   * Ray cast. Returns { t, nx, ny, nz, collider } for the nearest hit within maxDist, or null.
   * `ignoreInvisible` skips invisible boundary walls (useful for the camera).
   */
  raycast(ox, oy, oz, dx, dy, dz, maxDist, ignoreInvisible = false) {
    const ex = ox + dx * maxDist;
    const ez = oz + dz * maxDist;
    const list = this.query(Math.min(ox, ex), Math.min(oz, ez), Math.max(ox, ex), Math.max(oz, ez), this._tmp3 || (this._tmp3 = []));
    let bestT = maxDist;
    let hit = null;
    for (const c of list) {
      if (ignoreInvisible && c.invisible) continue;
      const r = rayBox(ox, oy, oz, dx, dy, dz, c.x0, c.y0, c.z0, c.x1, c.y1, c.z1, bestT);
      if (!r) continue;
      let t = r.t;
      if (c.ramp) {
        // march inside the box until we are under the sloped surface
        const tEnd = Math.min(r.tOut, bestT);
        let found = false;
        const steps = 10;
        for (let i = 0; i <= steps; i++) {
          const tt = t + ((tEnd - t) * i) / steps;
          const px = ox + dx * tt, py = oy + dy * tt, pz = oz + dz * tt;
          if (py <= c.topAt(px, pz) + 1e-3) {
            t = tt;
            found = true;
            break;
          }
        }
        if (!found) continue;
      }
      if (t < bestT) {
        bestT = t;
        hit = { t, nx: r.nx, ny: r.ny, nz: r.nz, collider: c };
      }
    }
    return hit;
  }

  /** Line of sight between two points (eye heights already applied). */
  lineOfSight(a, b) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const d = Math.hypot(dx, dy, dz);
    if (d < 1e-4) return true;
    return !this.raycast(a.x, a.y, a.z, dx / d, dy / d, dz / d, d - 0.05, true);
  }

  clampToBounds(pos, r) {
    const [x0, z0, x1, z1] = this.bounds;
    if (pos.x < x0 + r) pos.x = x0 + r;
    if (pos.x > x1 - r) pos.x = x1 - r;
    if (pos.z < z0 + r) pos.z = z0 + r;
    if (pos.z > z1 - r) pos.z = z1 - r;
  }
}

function parseZone(z) {
  const out = { k: z.k, s: z.s ?? 1, vx: z.v?.[0] ?? 0, vz: z.v?.[1] ?? 0 };
  if (z.c) {
    out.cx = z.c[0];
    out.cz = z.c[1];
    out.r2 = z.r * z.r;
    out.y0 = z.y[0];
    out.y1 = z.y[1];
  } else {
    [out.x0, out.y0, out.z0, out.x1, out.y1, out.z1] = z.b;
  }
  return out;
}

/** A ride (water slide): a dense polyline with arc lengths, sampled by distance travelled. */
function makeRide(r, id) {
  const pts = r.pts.map(([x, y, z]) => ({ x, y, z }));
  const L = [0];
  for (let i = 1; i < pts.length; i++) L.push(L[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z));
  return {
    id,
    pts,
    L,
    len: L[L.length - 1],
    r: r.r || 1.1,
    vmax: r.vmax || 16,
    /** Position and unit tangent at arc length s. */
    at(s, out) {
      let lo = 0, hi = L.length - 1;
      s = Math.max(0, Math.min(this.len, s));
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (L[mid] <= s) lo = mid;
        else hi = mid;
      }
      const a = pts[lo], b = pts[hi];
      const seg = L[hi] - L[lo] || 1;
      const t = (s - L[lo]) / seg;
      out.x = a.x + (b.x - a.x) * t;
      out.y = a.y + (b.y - a.y) * t;
      out.z = a.z + (b.z - a.z) * t;
      out.tx = (b.x - a.x) / seg;
      out.ty = (b.y - a.y) / seg;
      out.tz = (b.z - a.z) / seg;
      return out;
    },
  };
}

export function circleOverlapsRect(x, z, r, c) {
  const cx = x < c.x0 ? c.x0 : x > c.x1 ? c.x1 : x;
  const cz = z < c.z0 ? c.z0 : z > c.z1 ? c.z1 : z;
  const dx = x - cx;
  const dz = z - cz;
  return dx * dx + dz * dz < r * r;
}

function rayBox(ox, oy, oz, dx, dy, dz, x0, y0, z0, x1, y1, z1, maxT) {
  let tmin = 0;
  let tmax = maxT;
  let nx = 0, ny = 0, nz = 0;
  // X slab
  if (Math.abs(dx) < 1e-9) {
    if (ox < x0 || ox > x1) return null;
  } else {
    let t1 = (x0 - ox) / dx, t2 = (x1 - ox) / dx, n = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; n = 1; }
    if (t1 > tmin) { tmin = t1; nx = n; ny = 0; nz = 0; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (Math.abs(dy) < 1e-9) {
    if (oy < y0 || oy > y1) return null;
  } else {
    let t1 = (y0 - oy) / dy, t2 = (y1 - oy) / dy, n = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; n = 1; }
    if (t1 > tmin) { tmin = t1; nx = 0; ny = n; nz = 0; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  if (Math.abs(dz) < 1e-9) {
    if (oz < z0 || oz > z1) return null;
  } else {
    let t1 = (z0 - oz) / dz, t2 = (z1 - oz) / dz, n = -1;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; n = 1; }
    if (t1 > tmin) { tmin = t1; nx = 0; ny = 0; nz = n; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return { t: tmin, tOut: tmax, nx, ny, nz };
}
