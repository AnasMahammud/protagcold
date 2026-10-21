// Bot brain. Bots produce the same input commands a human produces and drive the same
// CharacterController - no speed cheats, no teleporting. Chasers only know where runners are
// through line of sight or hearing (no wall-hacks); runners always know where IT is, exactly
// like a human player who sees the IT marker on the HUD.
import { LINK } from './navGraph.js';
import { MS } from '../movement/controller.js';
import { clamp, mulberry32 } from '../core/mathUtil.js';
import { getConfig } from '../core/config.js';

const HEAR_RADIUS = 11;
const DECIDE_HZ = 10;

export class BotBrain {
  constructor(player, nav, difficultyCfg, seed) {
    this.player = player;
    this.nav = nav;
    this.d = difficultyCfg;
    this.rng = mulberry32(seed);
    this.known = new Map(); // id -> { x, y, z, vx, vz, t }
    this.path = null;
    this.pathIdx = 0;
    this.goalId = null;
    this.repathT = 0;
    this.decideT = this.rng() / DECIDE_HZ;
    this.perceiveT = 0;
    this.role = 'wander';
    this.targetId = null;
    this.stuckT = 0;
    this.lastPos = { x: player.ctrl.pos.x, z: player.ctrl.pos.z };
    this.progressT = 0;
    this.time = 0;
    this.hesitateT = 0;
    this.directSteer = null;
    this.wantSprint = false;
    this.pendingJump = false;
    this.pendingSlide = false;
    this.pendingDodge = null;
    this.dodgeCheckT = 0;
    this.input = { mx: 0, mz: 0, jumpPressed: false, jumpHeld: false, sprint: false, slidePressed: false, dodgePressed: false, vaultPressed: false };
  }

  /**
   * @param ctx { players: [{ id, pos, vel, it, out, protected, frozen }], world, phase }
   */
  update(dt, ctx) {
    this.time += dt;
    const me = this.player;
    const inp = this.input;
    inp.jumpPressed = inp.slidePressed = inp.dodgePressed = inp.vaultPressed = false;
    inp.jumpHeld = false;
    inp.mx = inp.mz = 0;
    inp.sprint = false;
    inp.ability = null;
    inp.aim = null;
    const self = ctx.players.find((p) => p.id === me.id);
    if (!self || self.out || ctx.phase !== 'playing' || self.frozen) {
      this.path = null;
      return inp;
    }

    this.perceiveT -= dt;
    if (this.perceiveT <= 0) {
      this.perceiveT = this.d.reaction * (0.7 + this.rng() * 0.6);
      this._perceive(ctx, self);
    }
    this.decideT -= dt;
    if (this.decideT <= 0) {
      this.decideT = 1 / DECIDE_HZ;
      this._decide(ctx, self);
    }
    if (this.hesitateT > 0) {
      this.hesitateT -= dt;
      return inp;
    }
    this._steer(dt, ctx, self);
    this._checkStuck(dt);
    return inp;
  }

  _perceive(ctx, self) {
    const w = ctx.world;
    const eye = { x: self.pos.x, y: self.pos.y + 1.6, z: self.pos.z };
    for (const p of ctx.players) {
      if (p.id === self.id || p.out) continue;
      const dx = p.pos.x - self.pos.x, dz = p.pos.z - self.pos.z, dy = p.pos.y - self.pos.y;
      const dist = Math.hypot(dx, dy, dz);
      // runners always track IT (the HUD shows IT to humans too); chasers need sight or sound
      if (p.cloaked && dist > 3) continue; // cloaked: invisible unless right next to you
      const knowsAlways = p.it && !self.it;
      // power outage: everyone is near-blind (IT's glowing crown still gives them away)
      const hear = ctx.dark ? 5 : HEAR_RADIUS;
      const sight = ctx.dark ? (p.it ? 30 : 12) : 60;
      let seen = knowsAlways || dist < hear;
      if (!seen && dist < sight) seen = w.lineOfSight(eye, { x: p.pos.x, y: p.pos.y + 1.4, z: p.pos.z });
      if (seen) this.known.set(p.id, { x: p.pos.x, y: p.pos.y, z: p.pos.z, vx: p.vel.x, vz: p.vel.z, t: this.time, it: p.it });
    }
  }

  _decide(ctx, self) {
    const others = ctx.players.filter((p) => p.id !== self.id && !p.out);
    if (self.it) {
      this.role = 'chase';
      // pick a target among known runners: nearest, sticky
      let best = null;
      let bestCost = Infinity;
      for (const p of others) {
        if (p.it || p.protected) continue;
        const k = this.known.get(p.id);
        if (!k || this.time - k.t > 6) continue;
        let cost = Math.hypot(k.x - self.pos.x, k.z - self.pos.z) + Math.abs(k.y - self.pos.y) * 2.5;
        if (p.id === this.targetId) cost -= 4;
        if (cost < bestCost) {
          bestCost = cost;
          best = p;
        }
      }
      if (!best) {
        // nobody known: search - roam towards stale knowledge or random spots
        this.role = 'search';
        this.targetId = null;
      } else {
        this.targetId = best.id;
      }
    } else {
      // runner: flee from the nearest chaser if it is a threat
      let threat = null;
      let td = Infinity;
      for (const p of others) {
        if (!p.it) continue;
        const k = this.known.get(p.id);
        if (!k) continue;
        const d = Math.hypot(k.x - self.pos.x, k.z - self.pos.z) + Math.abs(k.y - self.pos.y);
        if (d < td) {
          td = d;
          threat = p;
        }
      }
      const panic = this.d.usesMoves ? 26 : 18;
      if (threat && td < panic) {
        if (this.role !== 'flee' || this.targetId !== threat.id) this.repathT = 0;
        this.role = 'flee';
        this.targetId = threat.id;
        this.threatDist = td;
      } else {
        if (this.role !== 'wander') this.repathT = 0;
        this.role = 'wander';
        this.targetId = threat?.id ?? null;
        this.threatDist = td;
      }
    }
    // occasional human-like hesitation
    if (this.rng() < this.d.mistakeRate * 0.08) this.hesitateT = 0.2 + this.rng() * 0.4;
  }

  _steer(dt, ctx, self) {
    const me = this.player;
    const pos = me.ctrl.pos;
    this.repathT -= dt;
    this.directSteer = null;
    this.zone = ctx.zone || null;
    // Shrinking Zone: runners get back inside the ring before anything else
    let zoneRun = false;
    if (this.zone && !self.it) {
      const z = this.zone;
      if (Math.hypot(pos.x - z.x, pos.z - z.z) > z.r - 2.5) {
        zoneRun = true;
        if (!this.zoneRun || this.repathT <= 0 || !this.path) {
          const a = this.rng() * Math.PI * 2, rr = this.rng() * z.r * 0.45;
          const n = this.nav.nearest(z.x + Math.cos(a) * rr, pos.y, z.z + Math.sin(a) * rr, 12) || this.nav.nearest(z.x, 0, z.z, 24);
          if (n) this._pathToNode(n);
          this.repathT = 0.8;
        }
        this.wantSprint = true;
      }
    }
    this.zoneRun = zoneRun;

    if (zoneRun) {
      // (path set above)
    } else if (this.role === 'chase' && this.targetId) {
      const k = this.known.get(this.targetId);
      const tgt = ctx.players.find((p) => p.id === this.targetId);
      if (k && tgt) {
        const dist = Math.hypot(k.x - pos.x, k.z - pos.z);
        const lead = this.d.predict * clamp(dist / 9, 0, 1) * 0.8;
        const px = k.x + k.vx * lead, pz = k.z + k.vz * lead;
        const sameLevel = Math.abs(k.y - pos.y) < 0.9;
        if (dist < 8 && sameLevel && ctx.world.lineOfSight({ x: pos.x, y: pos.y + 0.8, z: pos.z }, { x: px, y: k.y + 0.8, z: pz })) {
          this.directSteer = { x: px, z: pz };
          this.path = null;
        } else if (this.repathT <= 0 || !this.path) {
          this._pathTo(px, k.y, pz);
          this.repathT = this.d.repath * (0.8 + this.rng() * 0.4);
        }
        this.wantSprint = dist < 22 && me.ctrl.stamina > 5 && this.rng() < this.d.sprintUse + 0.3;
        // hot potato: the fuse is burning down, run flat out
        if (ctx.fuse != null && ctx.fuse < 8) this.wantSprint = me.ctrl.stamina > 2;
      }
    } else if (this.role === 'search') {
      if (!this.path || this.repathT <= 0) {
        const stale = [...this.known.values()].filter((k) => !k.it).sort((a, b) => b.t - a.t)[0];
        const n = stale && this.rng() < 0.7 ? this.nav.nearest(stale.x, stale.y, stale.z, 4) : this.nav.randomNode(this.rng, pos, 30);
        if (n) this._pathToNode(n);
        this.repathT = 2.5;
      }
      this.wantSprint = false;
    } else if (this.role === 'flee') {
      const k = this.known.get(this.targetId);
      if (this.repathT <= 0 || !this.path || this._pathTowardThreat(k)) {
        this._chooseFleeGoal(k);
        this.repathT = this.d.repath * 1.4 * (0.8 + this.rng() * 0.4);
      }
      this.wantSprint = this.threatDist < 15 && (me.ctrl.stamina > 25 || this.threatDist < 6) && this.rng() < this.d.sprintUse + 0.4;
      // close-quarters evasion. Runners can always see IT, so this uses live positions.
      // Skilled bots wait for the last moment (a PERFECT dodge); others dodge early or not at all.
      const live = ctx.players.find((q) => q.id === this.targetId);
      if (live && this.d.usesMoves && me.ctrl.dodgeCooldown <= 0) {
        const dx = pos.x - live.pos.x, dz = pos.z - live.pos.z;
        const d = Math.hypot(dx, dz) || 1;
        const closing = (live.vel.x * dx + live.vel.z * dz) / d;
        if (closing > 1.5 && d < 6 && !live.frozen) {
          if (this.perfectRoll == null) {
            // Decide ONCE per approach when to dodge, as "time until IT reaches tag range".
            // The perfect window is roughly ttc 0 .. 0.2 s. A bot going for it still misjudges
            // the moment by up to ±0.15 s; the rest flinch early (a plain sidestep well before
            // the window) or hold their nerve and just run.
            this.perfectRoll = this.rng() < (this.d.perfectDodge || 0);
            if (this.perfectRoll) this.dodgeAt = 0.1 + (this.rng() - 0.5) * 0.3;
            else this.dodgeAt = this.rng() < 0.45 + this.d.predict * 0.3 ? 0.34 + this.rng() * 0.25 : -1;
          }
          const ttc = (d - getConfig().tag.range) / closing;
          const go = this.dodgeAt >= 0 && ttc <= this.dodgeAt;
          if (go) {
            // sidestep perpendicular to the chaser's approach
            const side = this.rng() < 0.5 ? 1 : -1;
            this.pendingDodge = { x: (-dz / d) * side, z: (dx / d) * side };
            this.perfectRoll = null;
          }
        } else {
          this.perfectRoll = null;
        }
      }
    } else {
      // wander: stroll between interesting spots, conserve stamina
      if (!this.path || this.repathT <= 0) {
        const coin = ctx.coins?.length && this.rng() < 0.6 ? nearestOf(ctx.coins, pos, 30) : null;
        const area = this.zone ? { x: this.zone.x, z: this.zone.z } : pos;
        const radius = this.zone ? Math.max(6, this.zone.r * 0.75) : 25;
        const n = coin && !this.zone ? this.nav.nearest(coin.x, coin.y - 0.9, coin.z, 3) || this.nav.randomNode(this.rng, area, radius) : this.nav.randomNode(this.rng, area, radius);
        if (n) this._pathToNode(n);
        this.repathT = 4 + this.rng() * 4;
      }
      this.wantSprint = false;
    }

    // ---- produce movement input
    let tx = null, tz = null;
    let link = null;
    if (this.directSteer) {
      tx = this.directSteer.x;
      tz = this.directSteer.z;
    } else if (this.path && this.pathIdx < this.path.length) {
      this._advancePath(pos);
      if (this.pathIdx < this.path.length) {
        const step = this.path[this.pathIdx];
        tx = step.node.x;
        tz = step.node.z;
        link = step.link;
        // look ahead: aim further along straight walkable stretches for smoother running
        const nxt = this.path[this.pathIdx + 1];
        if (nxt && nxt.link?.type === LINK.WALK && link?.type === LINK.WALK && Math.abs(nxt.node.y - pos.y) < 0.3) {
          tx = (tx + nxt.node.x) / 2;
          tz = (tz + nxt.node.z) / 2;
        }
      } else {
        this.path = null;
      }
    }
    const inp = this.input;
    if (tx !== null) {
      const dx = tx - pos.x, dz = tz - pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.05) {
        // easy bots run at a slightly reduced input magnitude (a handicap, never a bonus)
        const mag = clamp(this.d.speedFactor, 0.5, 1);
        inp.mx = (dx / d) * mag;
        inp.mz = (dz / d) * mag;
      }
      inp.sprint = this.wantSprint;
      if (link && this.pathIdx < this.path?.length) {
        const nodeDist = d;
        const fromNode = this.pathIdx > 0 ? this.path[this.pathIdx - 1].node : null;
        if (link.type === LINK.CLIMB && nodeDist < 2.2) {
          inp.jumpPressed = me.ctrl.grounded && this.rng() < 0.5;
          inp.jumpHeld = true;
          inp.vaultPressed = nodeDist < 1.6;
        } else if (link.type === LINK.JUMP && fromNode && Math.hypot(pos.x - fromNode.x, pos.z - fromNode.z) < 0.8 && me.ctrl.grounded) {
          inp.jumpPressed = true;
          inp.jumpHeld = true;
          inp.sprint = true;
        } else if (link.type === LINK.JUMP && !me.ctrl.grounded) {
          inp.jumpHeld = true;
        } else if (this.path[this.pathIdx].node.low && me.ctrl.state !== MS.SLIDE && nodeDist < 3) {
          inp.slidePressed = true;
          inp.sprint = true;
        }
      }
    }
    if (this.pendingDodge) {
      inp.mx = this.pendingDodge.x;
      inp.mz = this.pendingDodge.z;
      inp.dodgePressed = true;
      this.pendingDodge = null;
    }
    this._maybeUseAbility(dt, ctx, self);
    if (this.pendingJump) {
      inp.jumpPressed = true;
      inp.jumpHeld = true;
      this.pendingJump = false;
    }
    // hard bots slide-boost when fleeing in a straight line, normal bots occasionally
    if (this.role === 'flee' && this.d.usesMoves && me.ctrl.grounded && me.ctrl.horizontalSpeed > 8.5 && this.threatDist < 6 && this.rng() < 0.02 * (1 + this.d.predict)) {
      inp.slidePressed = true;
    }
  }

  _pathTowardThreat(k) {
    if (!k || !this.path) return false;
    const n = this.path[Math.min(this.pathIdx + 2, this.path.length - 1)]?.node;
    if (!n) return false;
    const me = this.player.ctrl.pos;
    const toThreat = { x: k.x - me.x, z: k.z - me.z };
    const toNode = { x: n.x - me.x, z: n.z - me.z };
    const dt = Math.hypot(toThreat.x, toThreat.z) || 1;
    const dn = Math.hypot(toNode.x, toNode.z) || 1;
    return (toThreat.x * toNode.x + toThreat.z * toNode.z) / (dt * dn) > 0.6 && dt < 10;
  }

  _chooseFleeGoal(k) {
    const me = this.player.ctrl.pos;
    if (!k) return;
    let best = null;
    let bestScore = -Infinity;
    const samples = 22;
    for (let i = 0; i < samples; i++) {
      const n = this.nav.randomNode(this.rng, me, 26);
      const dSelf = Math.hypot(n.x - me.x, n.z - me.z);
      if (dSelf < 5) continue;
      const dThreat = Math.hypot(n.x - k.x, n.z - k.z) + Math.abs(n.y - k.y) * 0.8;
      const tx = k.x - me.x, tz = k.z - me.z;
      const tl = Math.hypot(tx, tz) || 1;
      const dot = ((n.x - me.x) * tx + (n.z - me.z) * tz) / (dSelf * tl);
      let score = dThreat - dSelf * 0.45 - (dot > 0.2 ? 25 * dot : 0);
      if (this.d.usesMoves) score += Math.min(8, n.links.length) * 0.5 + (n.y - me.y) * 0.4; // escape options & high ground
      if (this.rng() < this.d.mistakeRate) score += (this.rng() - 0.5) * 30; // imperfect decisions
      if (this.zone && Math.hypot(n.x - this.zone.x, n.z - this.zone.z) > this.zone.r - 3) score -= 80; // never flee out of the ring
      if (score > bestScore) {
        bestScore = score;
        best = n;
      }
    }
    if (best) this._pathToNode(best);
  }

  _pathTo(x, y, z) {
    const n = this.nav.nearest(x, y, z, 4);
    if (n) this._pathToNode(n);
  }

  _pathToNode(goal) {
    const me = this.player.ctrl.pos;
    const start = this.nav.nearest(me.x, me.y, me.z, 4);
    if (!start) {
      // off the graph: walk straight at the goal and hope to re-acquire
      this.path = [{ node: goal, link: null }];
      this.pathIdx = 0;
      return;
    }
    const path = this.nav.findPath(start.id, goal.id);
    if (path) {
      this.path = path;
      this.pathIdx = 0;
      this.goalId = goal.id;
    } else {
      this.repathT = Math.max(this.repathT, 1.5); // unreachable from here: don't search again every tick
    }
  }

  _advancePath(pos) {
    while (this.pathIdx < this.path.length) {
      const n = this.path[this.pathIdx].node;
      const d = Math.hypot(n.x - pos.x, n.z - pos.z);
      const dy = pos.y - n.y;
      if (d < 0.75 && dy > -0.6 && dy < 1.8) {
        this.pathIdx++;
        this.progressT = 0;
      } else break;
    }
  }

  /** Tactical ability use: escape tools when IT is on you, gap-closers when chasing. */
  _maybeUseAbility(dt, ctx, self) {
    const me = this.player;
    const lo = me.loadout;
    if (!lo?.some(Boolean) || !(this.d.abilityUse > 0)) return;
    this.abilityT = (this.abilityT || 0) - dt;
    if (this.abilityT > 0) return;
    this.abilityT = 0.25;
    const pos = me.ctrl.pos;
    const ready = (id) => lo.includes(id) && !(me.abilityCd?.[id] > 0);
    const slotOf = (id) => lo.indexOf(id);
    const k = this.targetId ? ctx.players.find((q) => q.id === this.targetId) : null;
    if (!k || (k.cloaked && this.role === 'chase')) return; // no aimbot on cloaked runners
    const dx = k.pos.x - pos.x, dz = k.pos.z - pos.z, dy = k.pos.y - pos.y;
    const d = Math.hypot(dx, dz) || 1;
    let pick = null;
    let aim = null;
    if (this.role === 'flee') {
      const closing = -(k.vel.x * dx + k.vel.z * dz) / d;
      if (d > 4.5 || closing < 1.5 || this.rng() > this.d.abilityUse) return;
      const away = { x: -dx / d, z: -dz / d };
      const options = [];
      if (ready('blink')) options.push(['blink', { move: rotate(away, (this.rng() - 0.5) * 1.2) }]);
      if (ready('cloak')) options.push(['cloak', {}]);
      if (ready('decoy')) options.push(['decoy', { dir: rotate(away, this.rng() < 0.5 ? 1.4 : -1.4) }]);
      if (ready('shockwave') && d < 3.5) options.push(['shockwave', {}]);
      if (ready('rocket')) options.push(['rocket', {}]);
      if (!options.length) return;
      [pick, aim] = options[Math.floor(this.rng() * options.length)];
    } else if (this.role === 'chase') {
      if (this.rng() > this.d.abilityUse * 0.5) return;
      if (ready('rocket') && dy > 2.2 && d < 7) {
        pick = 'rocket';
        aim = {};
      } else if (ready('blink') && d > 4.5 && d < 9.5 && Math.abs(dy) < 1 && ctx.world.lineOfSight({ x: pos.x, y: pos.y + 1, z: pos.z }, { x: k.pos.x, y: k.pos.y + 1, z: k.pos.z })) {
        pick = 'blink';
        aim = { move: { x: dx / d, z: dz / d } };
      }
    }
    if (pick) {
      this.input.ability = slotOf(pick);
      this.input.aim = aim;
    }
  }

  _checkStuck(dt) {
    const pos = this.player.ctrl.pos;
    const moving = Math.hypot(this.input.mx, this.input.mz) > 0.3;
    this.progressT += dt;
    if (this.progressT > 0.6) {
      const moved = Math.hypot(pos.x - this.lastPos.x, pos.z - this.lastPos.z);
      this.lastPos.x = pos.x;
      this.lastPos.z = pos.z;
      this.progressT = 0;
      if (moving && moved < 0.6 && this.player.ctrl.state !== MS.VAULT && this.player.ctrl.state !== MS.MANTLE) {
        this.stuckT += 0.6;
        if (this.stuckT >= 0.6) this.pendingJump = true;
        if (this.stuckT >= 1.8) {
          // re-plan from scratch (blocked route / bad node)
          this.path = null;
          this.repathT = 0;
          const n = this.nav.randomNode(this.rng, pos, 8);
          if (n) this._pathToNode(n);
        }
        if (this.stuckT >= 4) this.stuckT = 0;
      } else {
        this.stuckT = 0;
      }
    }
  }
}

function rotate(v, a) {
  const c = Math.cos(a), s = Math.sin(a);
  return { x: v.x * c - v.z * s, z: v.x * s + v.z * c };
}

function nearestOf(list, pos, maxDist) {
  let best = null;
  let bd = maxDist;
  for (const c of list) {
    const d = Math.hypot(c.x - pos.x, c.z - pos.z) + Math.abs(c.y - pos.y) * 0.5;
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}
