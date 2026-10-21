// Navigation graph generated automatically from the collision world.
// Nodes are sampled on every walkable surface (floors, roofs, containers, ramps...). Links
// encode HOW to traverse: walk, drop, climb (vault/mantle), gap jump, slide-under, jump pad.
// Bots path-find with A* over this graph and execute links with the same controller players use.
import { CharacterController } from '../movement/controller.js';

export const LINK = Object.freeze({ WALK: 0, DROP: 1, CLIMB: 2, JUMP: 3, PAD: 4, RIDE: 5 });
const STEP = 1.25;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export class NavGraph {
  constructor(world, moveCfg) {
    this.world = world;
    this.cfg = moveCfg;
    this.nodes = [];
    this.columns = new Map();
    const t0 = performance.now();
    this._sample();
    this._link();
    this._gapJumps();
    this._pads();
    this._rides();
    this.maxExpand = this.nodes.length; // a full search is cheap now (typed arrays, weighted A*)
    this.buildMs = performance.now() - t0;
  }

  _key(ix, iz) {
    return ix * 100000 + iz;
  }

  _sample() {
    const w = this.world;
    const [bx0, bz0, bx1, bz1] = w.bounds;
    const r = this.cfg.radius;
    this.ox = bx0 + 0.7;
    this.oz = bz0 + 0.7;
    const nx = Math.floor((bx1 - 0.7 - this.ox) / STEP) + 1;
    const nz = Math.floor((bz1 - 0.7 - this.oz) / STEP) + 1;
    this.nx = nx;
    this.nz = nz;
    const tmp = [];
    for (let ix = 0; ix < nx; ix++) {
      for (let iz = 0; iz < nz; iz++) {
        const x = this.ox + ix * STEP;
        const z = this.oz + iz * STEP;
        const cols = w.query(x - 0.05, z - 0.05, x + 0.05, z + 0.05, tmp);
        const tops = [];
        for (const c of cols) {
          if (c.invisible) continue;
          if (x < c.x0 || x > c.x1 || z < c.z0 || z > c.z1) continue;
          tops.push(c.ramp ? c.topAt(x, z) : c.y1);
        }
        tops.sort((a, b) => a - b);
        const list = [];
        let last = -1e9;
        for (const y of tops) {
          if (y - last < 0.3) continue;
          last = y;
          const g = w.groundBelow(x, z, r * 0.6, y + 0.05);
          if (!g || Math.abs(g.y - y) > 0.06) continue; // something else is on top here
          let stair = g.collider.v === 'step' || !!g.collider.ramp;
          let full = w.isFree(x, y + 0.03, z, r * 0.9, this.cfg.height);
          if (!full) {
            // right next to a small step (the foot of a staircase, a curb): still a place to stand
            const lift = this.cfg.stepHeight * 0.9;
            if (w.isFree(x, y + lift, z, r * 0.9, this.cfg.height - lift + 0.03)) {
              full = true;
              stair = true;
            }
          }
          const low = !full && w.isFree(x, y + 0.03, z, r * 0.9, this.cfg.slideHeight + 0.05);
          if (!full && !low) continue;
          const node = { id: this.nodes.length, x, y, z, ix, iz, low, stair, links: [], surface: g.collider.m };
          this.nodes.push(node);
          list.push(node);
        }
        if (list.length) this.columns.set(this._key(ix, iz), list);
      }
    }
  }

  _walkable(a, b) {
    const w = this.world;
    const step = this.cfg.stepHeight;
    const hi = Math.max(a.y, b.y);
    const lo = Math.min(a.y, b.y);
    const low = a.low || b.low;
    const h = low ? this.cfg.slideHeight : this.cfg.height * 0.95;
    const stair = a.stair || b.stair;
    let prev = a.y;
    for (let i = 1; i <= 3; i++) {
      const t = i / 4;
      const x = a.x + (b.x - a.x) * t;
      const z = a.z + (b.z - a.z) * t;
      const g = w.groundBelow(x, z, 0.2, hi + step);
      if (!g || g.y < lo - step - 0.05) return false;
      // stairs and slopes: every quarter of the way may rise at most one step
      if (Math.abs(g.y - prev) > step + 0.05) return false;
      prev = g.y;
      const y = a.y + (b.y - a.y) * t;
      const lift = stair ? step * 0.9 : 0.05;
      if (!w.isFree(x, Math.max(g.y, y) + lift, z, this.cfg.radius * 0.8, h - (stair ? lift : 0))) return false;
    }
    return Math.abs(b.y - prev) <= step + 0.05;
  }

  _link() {
    const step = this.cfg.stepHeight;
    for (const a of this.nodes) {
      for (const [dx, dz] of DIRS) {
        const list = this.columns.get(this._key(a.ix + dx, a.iz + dz));
        if (!list) continue;
        const dist = Math.hypot(dx, dz) * STEP;
        for (const b of list) {
          const dy = b.y - a.y;
          // stairs and ramps rise up to ~0.9 m between neighbouring nodes and are still a walk
          if (Math.abs(dy) <= step + 0.05 || ((a.stair || b.stair) && Math.abs(dy) <= 0.95 && this._walkable(a, b))) {
            if (this._walkable(a, b)) a.links.push({ to: b.id, type: LINK.WALK, cost: dist * (b.low ? 1.6 : 1) + Math.abs(dy) * 0.3 });
            else if (dy < -step - 0.05 && dy > -9) a.links.push({ to: b.id, type: LINK.DROP, cost: dist + 0.4 - dy * 0.05 });
          } else if (dy < 0 && dy > -9) {
            // walking off a ledge: the space above b at a's height must be open
            const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
            if (this.world.isFree(mx, a.y + 0.1, mz, this.cfg.radius * 0.8, this.cfg.height) && this.world.isFree(b.x, b.y + 0.05, b.z, this.cfg.radius * 0.8, Math.min(this.cfg.height, a.y - b.y + this.cfg.height))) {
              a.links.push({ to: b.id, type: LINK.DROP, cost: dist + 0.4 - dy * 0.05 });
            }
          } else if (dy > 0 && dy <= 2.75) {
            // climb: vault/mantle from a onto b (needs headroom above a to jump)
            if (a.low) continue;
            const headroom = this.world.isFree(a.x, a.y + 0.05, a.z, this.cfg.radius * 0.8, this.cfg.height + Math.min(1.7, dy));
            if (headroom && this.world.isFree(b.x, b.y + 0.05, b.z, this.cfg.radius * 0.8, this.cfg.height)) {
              a.links.push({ to: b.id, type: LINK.CLIMB, cost: dist + 0.8 + dy * 1.2 });
            }
          }
        }
      }
    }
  }

  _gapJumps() {
    const w = this.world;
    for (const a of this.nodes) {
      if (a.low || a.links.length >= 8) continue; // only edge nodes
      for (const [dx, dz] of DIRS) {
        if (a.links.some((l) => { const b = this.nodes[l.to]; return b.ix === a.ix + dx && b.iz === a.iz + dz && l.type === LINK.WALK; })) continue;
        for (let k = 2; k <= 4; k++) {
          const list = this.columns.get(this._key(a.ix + dx * k, a.iz + dz * k));
          if (!list) continue;
          const dist = Math.hypot(dx, dz) * STEP * k;
          for (const b of list) {
            const dy = b.y - a.y;
            if (dy > 0.6 || dy < -3 || b.low) continue;
            if (dist > 5.2) continue;
            // there must be a real gap (no floor near a's height) in between, and open air
            let gap = false;
            let clear = true;
            for (let i = 1; i < k * 2; i++) {
              const t = i / (k * 2);
              const x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
              const g = w.groundBelow(x, z, 0.15, a.y + 0.3);
              if (!g || g.y < Math.min(a.y, b.y) - 1.0) gap = true;
              if (!w.isFree(x, Math.max(a.y, b.y) + 0.4, z, this.cfg.radius * 0.8, this.cfg.height)) clear = false;
            }
            if (gap && clear) a.links.push({ to: b.id, type: LINK.JUMP, cost: dist + 2.0 });
          }
          break;
        }
      }
    }
  }

  _pads() {
    // simulate a real launch with the real controller to find where each pad lands
    for (const p of this.world.pads) {
      const from = this.nearest(p.x, p.y, p.z, 2.5);
      if (!from) continue;
      const ctrl = new CharacterController(this.world, this.cfg);
      ctrl.teleport(p.x, p.y, p.z);
      const input = { mx: 0, mz: 0 };
      let landed = null;
      for (let i = 0; i < 300; i++) {
        ctrl.step(input, 1 / 60);
        if (i > 10 && ctrl.grounded) {
          landed = { ...ctrl.pos };
          break;
        }
      }
      if (!landed) continue;
      const to = this.nearest(landed.x, landed.y, landed.z, 2.5);
      if (!to || to.id === from.id) continue;
      from.links.push({ to: to.id, type: LINK.PAD, cost: 3 });
      from.pad = p;
    }
  }

  _rides() {
    // water slides: entry node -> wherever the real controller comes out after riding it
    for (const r of this.world.rides) {
      const e = r.pts[0];
      const from = this.nearest(e.x, e.y, e.z, 2.5);
      if (!from) continue;
      const ctrl = new CharacterController(this.world, this.cfg);
      ctrl.teleport(e.x, e.y, e.z);
      let landed = null;
      for (let i = 0; i < 1200; i++) {
        ctrl.step({ mx: 0, mz: 0 }, 1 / 60);
        if (i > 10 && !ctrl.ride && ctrl.grounded) {
          landed = { ...ctrl.pos };
          break;
        }
      }
      if (!landed) continue;
      const to = this.nearest(landed.x, landed.y, landed.z, 3);
      if (!to || to.id === from.id) continue;
      from.links.push({ to: to.id, type: LINK.RIDE, cost: 4 });
    }
  }

  nearest(x, y, z, maxDist = 4) {
    const ix = Math.round((x - this.ox) / STEP);
    const iz = Math.round((z - this.oz) / STEP);
    let best = null;
    let bd = Infinity;
    const R = Math.ceil(maxDist / STEP);
    for (let dx = -R; dx <= R; dx++) {
      for (let dz = -R; dz <= R; dz++) {
        const list = this.columns.get(this._key(ix + dx, iz + dz));
        if (!list) continue;
        for (const n of list) {
          const d = Math.hypot(n.x - x, n.z - z) + Math.abs(n.y - y) * 2.5 + (n.y > y + 0.6 ? 4 : 0);
          if (d < bd) {
            bd = d;
            best = n;
          }
        }
      }
    }
    return bd <= maxDist * 3 ? best : null;
  }

  /**
   * A* search (weighted 1.25: a few percent longer paths for far fewer expansions on big maps).
   * Returns array of { node, link } (link used to ENTER node) or null.
   */
  findPath(startId, goalId, maxExpand = this.maxExpand || 7000) {
    if (startId === goalId) return [{ node: this.nodes[goalId], link: null }];
    const nodes = this.nodes;
    const N = nodes.length;
    if (!this._g || this._g.length !== N) {
      this._g = new Float64Array(N);
      this._seen = new Uint32Array(N);
      this._done = new Uint32Array(N);
      this._from = new Int32Array(N);
      this._via = new Array(N);
      this._gen = 0;
    }
    const gen = (this._gen = (this._gen + 1) >>> 0 || 1);
    const g = this._g, seen = this._seen, done = this._done, from = this._from, via = this._via;
    const goal = nodes[goalId];
    const open = new MinHeap();
    g[startId] = 0;
    seen[startId] = gen;
    from[startId] = -1;
    open.push(startId, 0);
    let expanded = 0;
    let found = false;
    while (open.size) {
      const cur = open.pop();
      if (done[cur] === gen) continue;
      done[cur] = gen;
      if (cur === goalId) {
        found = true;
        break;
      }
      if (++expanded > maxExpand) return null;
      const gc = g[cur];
      for (const l of nodes[cur].links) {
        const to = l.to;
        if (done[to] === gen) continue;
        const ng = gc + l.cost;
        if (seen[to] !== gen || ng < g[to]) {
          seen[to] = gen;
          g[to] = ng;
          from[to] = cur;
          via[to] = l;
          const m = nodes[to];
          open.push(to, ng + 1.25 * Math.hypot(m.x - goal.x, m.z - goal.z, (m.y - goal.y) * 0.7));
        }
      }
    }
    if (!found) return null;
    const path = [];
    for (let c = goalId; c !== startId; c = from[c]) path.push({ node: nodes[c], link: via[c] });
    path.reverse();
    return path;
  }

  /** Random node (optionally within a radius of a point), useful for wandering/fleeing. */
  randomNode(rng, near = null, radius = 20) {
    for (let i = 0; i < 30; i++) {
      const n = this.nodes[Math.floor(rng() * this.nodes.length)];
      if (!near || Math.hypot(n.x - near.x, n.z - near.z) < radius) return n;
    }
    return this.nodes[Math.floor(rng() * this.nodes.length)];
  }

  /** Connected-component check (used by tests and map QA). */
  reachableFrom(startId) {
    const seen = new Set([startId]);
    const stack = [startId];
    while (stack.length) {
      const n = this.nodes[stack.pop()];
      for (const l of n.links) {
        if (!seen.has(l.to)) {
          seen.add(l.to);
          stack.push(l.to);
        }
      }
    }
    return seen;
  }
}

class MinHeap {
  constructor() {
    this.ids = [];
    this.pr = [];
  }

  get size() {
    return this.ids.length;
  }

  push(id, p) {
    const ids = this.ids, pr = this.pr;
    ids.push(id);
    pr.push(p);
    let i = ids.length - 1;
    while (i > 0) {
      const par = (i - 1) >> 1;
      if (pr[par] <= pr[i]) break;
      [ids[i], ids[par]] = [ids[par], ids[i]];
      [pr[i], pr[par]] = [pr[par], pr[i]];
      i = par;
    }
  }

  pop() {
    const ids = this.ids, pr = this.pr;
    const top = ids[0];
    const lastId = ids.pop();
    const lastP = pr.pop();
    if (ids.length) {
      ids[0] = lastId;
      pr[0] = lastP;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i;
        if (l < ids.length && pr[l] < pr[m]) m = l;
        if (r < ids.length && pr[r] < pr[m]) m = r;
        if (m === i) break;
        [ids[i], ids[m]] = [ids[m], ids[i]];
        [pr[i], pr[m]] = [pr[m], pr[i]];
        i = m;
      }
    }
    return top;
  }
}
