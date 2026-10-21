// Kinematic character controller: the movement feel of PRO TAG lives here.
// Runs at a fixed timestep (config.tick.simHz) for consistent physics. Humans and bots use
// the exact same controller with the same limits; bots only differ in how they produce input.
//
// Input (world space, already camera-relative):
//   { mx, mz, jumpPressed, jumpHeld, sprint, slidePressed, dodgePressed, vaultPressed }
// (mx, mz) has length 0..1 (analogue sticks may be partial).

import { clamp, moveTowards2, smoothstep, wrapAngle } from '../core/mathUtil.js';

export const MS = Object.freeze({ GROUND: 0, AIR: 1, SLIDE: 2, VAULT: 3, MANTLE: 4, DODGE: 5, GRAPPLE: 6, RIDE: 7 });
export const MS_NAMES = ['ground', 'air', 'slide', 'vault', 'mantle', 'dodge', 'grapple', 'ride'];

const EMPTY_INPUT = Object.freeze({ mx: 0, mz: 0, jumpPressed: false, jumpHeld: false, sprint: false, slidePressed: false, dodgePressed: false, vaultPressed: false });

export class CharacterController {
  constructor(world, movementCfg) {
    this.world = world;
    this.cfg = movementCfg;
    this.pos = { x: 0, y: 0, z: 0 };
    this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = 0; // facing (radians); 0 looks toward -Z
    this.state = MS.AIR;
    this.grounded = false;
    this.height = movementCfg.height;
    this.stamina = movementCfg.staminaMax;
    this.sprinting = false;
    this.speedMultiplier = 1; // IT bonus etc. (set by gameplay)
    this.gravityScale = 1; // map events (low gravity)
    this.traction = 1; // map events (wet floors): < 1 = slippery
    this.frozen = false; // new-IT freeze: cannot move
    this.zone = null; // water / conveyor zone under the feet this step
    this.ride = null; // water slide in progress
    this.rideCooldown = 0;
    this.events = [];

    this.coyote = 0;
    this.jumpBuffer = 0;
    this.jumpCutAvailable = false;
    this.staminaDelay = 0;
    this.slideTimer = 0;
    this.slideCooldown = 0;
    this.dodgeTimer = 0;
    this.dodgeCooldown = 0;
    this.dodgeDir = { x: 0, z: 0 };
    this.dodgeExitSpeed = 0;
    this.dodgeAge = 1e9; // seconds since the last dodge started (perfect-dodge timing window)
    this.wallNormal = { x: 0, z: 0 };
    this.wallTimer = 0;
    this.wallJumps = 0;
    this.wallJumpCooldown = 0;
    this.padCooldown = 0;
    this.airTime = 0;
    this.lastLandSpeed = 0;
    this.script = null; // vault / mantle scripted motion
    this.groundCollider = null;
    this._n = { x: 0, z: 0 };
  }

  teleport(x, y, z, yaw = this.yaw) {
    this.pos.x = x; this.pos.y = y; this.pos.z = z;
    this.vel.x = this.vel.y = this.vel.z = 0;
    this.yaw = yaw;
    this.state = MS.GROUND;
    this.grounded = true;
    this.height = this.cfg.height;
    this.script = null;
    this.stamina = this.cfg.staminaMax;
    this.slideTimer = this.dodgeTimer = 0;
    this.dodgeAge = 1e9;
    this.grapple = null;
    this.ride = null;
    this.airTime = 0;
  }

  get horizontalSpeed() {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  emit(type, data) {
    this.events.push(data ? { type, ...data } : { type });
  }

  step(input, dt) {
    const c = this.cfg;
    const inp = this.frozen ? { ...EMPTY_INPUT, jumpHeld: input.jumpHeld } : input || EMPTY_INPUT;

    // ---- timers
    this.slideCooldown = Math.max(0, this.slideCooldown - dt);
    this.dodgeCooldown = Math.max(0, this.dodgeCooldown - dt);
    this.dodgeAge += dt;
    this.wallJumpCooldown = Math.max(0, this.wallJumpCooldown - dt);
    this.padCooldown = Math.max(0, this.padCooldown - dt);
    this.rideCooldown = Math.max(0, this.rideCooldown - dt);
    this.wallTimer = Math.max(0, this.wallTimer - dt);
    this.coyote = this.grounded ? c.coyoteTime : Math.max(0, this.coyote - dt);
    this.jumpBuffer = inp.jumpPressed ? c.jumpBuffer : Math.max(0, this.jumpBuffer - dt);

    if (this.script) {
      this._stepScript(dt);
      return;
    }
    if (this.grapple) {
      this._stepGrapple(dt, inp);
      return;
    }
    if (this.ride) {
      this._stepRide(dt);
      return;
    }
    const zone = this.world.zones.length ? this.world.zoneAt(this.pos.x, this.pos.y + 0.05, this.pos.z) : null;
    this.zone = zone;
    const wade = zone && (zone.k === 'water' || zone.k === 'pit') ? zone.s : 1; // pools, ball pits

    let wishX = inp.mx || 0;
    let wishZ = inp.mz || 0;
    const wishLen = Math.hypot(wishX, wishZ);
    if (wishLen > 1) { wishX /= wishLen; wishZ /= wishLen; }
    const wishMag = Math.min(1, wishLen);
    const wishDirX = wishLen > 1e-3 ? wishX / wishLen : 0;
    const wishDirZ = wishLen > 1e-3 ? wishZ / wishLen : 0;

    // ---- stamina & sprint
    const wantsSprint = inp.sprint && wishMag > 0.3 && this.state !== MS.SLIDE;
    if (wantsSprint && (this.sprinting ? this.stamina > 0 : this.stamina >= c.staminaMinToSprint)) {
      this.sprinting = true;
    } else {
      this.sprinting = false;
    }
    if (this.sprinting && this.grounded && this.horizontalSpeed > c.runSpeed * 0.6) {
      this.stamina = Math.max(0, this.stamina - c.staminaDrain * dt);
      this.staminaDelay = c.staminaRegenDelay;
    } else if (this.staminaDelay > 0) {
      this.staminaDelay -= dt;
    } else {
      this.stamina = Math.min(c.staminaMax, this.stamina + c.staminaRegen * dt);
    }

    // ---- actions: dodge, slide, vault (in priority order)
    if (inp.dodgePressed && this.dodgeCooldown <= 0 && this.stamina >= c.dodgeStaminaCost * 0.5 && this.state !== MS.SLIDE) {
      let dx = wishDirX, dz = wishDirZ;
      if (wishLen < 0.2) { // no input: sidestep to the character's right
        dx = Math.cos(this.yaw); dz = -Math.sin(this.yaw);
      }
      this.dodgeDir.x = dx; this.dodgeDir.z = dz;
      this.dodgeExitSpeed = clamp(this.horizontalSpeed, c.runSpeed, c.sprintSpeed);
      this.dodgeTimer = c.dodgeDuration;
      this.dodgeCooldown = c.dodgeCooldown;
      this.dodgeAge = 0;
      this.stamina = Math.max(0, this.stamina - c.dodgeStaminaCost);
      this.staminaDelay = c.staminaRegenDelay;
      this.state = MS.DODGE;
      if (this.vel.y < 0 && !this.grounded) this.vel.y *= 0.3;
      this.emit('dodge');
    }

    if (inp.slidePressed && this.grounded && this.state === MS.GROUND && this.slideCooldown <= 0 && this.horizontalSpeed >= 3.0) {
      const sp = this.horizontalSpeed;
      const dirX = this.vel.x / sp, dirZ = this.vel.z / sp;
      const target = Math.min(c.slideMaxSpeed, Math.max(sp + c.slideBoost, c.runSpeed + 1.5) * (sp >= c.slideMinSpeed ? 1 : 0.85));
      this.vel.x = dirX * target;
      this.vel.z = dirZ * target;
      this.state = MS.SLIDE;
      this.slideTimer = c.slideDuration;
      this.height = c.slideHeight;
      this.stamina = Math.max(0, this.stamina - c.slideStaminaCost);
      this.staminaDelay = c.staminaRegenDelay;
      this.emit('slide');
    }

    // contextual vault / climb (explicit button, jump near a ledge, or auto when running into a low wall)
    if (this.state === MS.GROUND || this.state === MS.AIR) {
      const dirX = wishLen > 0.2 ? wishDirX : -Math.sin(this.yaw);
      const dirZ = wishLen > 0.2 ? wishDirZ : -Math.cos(this.yaw);
      const movingInto = wishLen > 0.2;
      const speed = this.horizontalSpeed;
      if (this.grounded && (inp.vaultPressed || (this.jumpBuffer > 0 && movingInto) || (movingInto && speed > 4.2))) {
        if (this._tryVault(dirX, dirZ, inp.vaultPressed || this.jumpBuffer > 0)) return;
      } else if (!this.grounded && (movingInto || inp.vaultPressed) && this.vel.y < 7) {
        if (this._tryMantleAir(dirX, dirZ)) return;
      }
    }

    // ---- horizontal velocity
    const hs = this.horizontalSpeed;
    if (this.state === MS.DODGE) {
      this.dodgeTimer -= dt;
      this.vel.x = this.dodgeDir.x * c.dodgeSpeed;
      this.vel.z = this.dodgeDir.z * c.dodgeSpeed;
      if (this.dodgeTimer <= 0) {
        this.vel.x = this.dodgeDir.x * this.dodgeExitSpeed;
        this.vel.z = this.dodgeDir.z * this.dodgeExitSpeed;
        this.state = this.grounded ? MS.GROUND : MS.AIR;
      }
    } else if (this.state === MS.SLIDE) {
      this.slideTimer -= dt;
      // friction + limited steering (water drags, wet floors barely do)
      let sp = Math.max(0, hs - (c.slideFriction * (wade < 1 ? 2.2 : 1) * (this.traction < 1 ? 0.35 : 1)) * dt);
      let dirX = hs > 1e-3 ? this.vel.x / hs : -Math.sin(this.yaw);
      let dirZ = hs > 1e-3 ? this.vel.z / hs : -Math.cos(this.yaw);
      if (wishLen > 0.2) {
        const cur = Math.atan2(dirX, dirZ);
        const want = Math.atan2(wishDirX, wishDirZ);
        const turned = cur + clamp(wrapAngle(want - cur), -1.6 * dt, 1.6 * dt);
        dirX = Math.sin(turned); dirZ = Math.cos(turned);
      }
      const canStand = this.world.isFree(this.pos.x, this.pos.y, this.pos.z, c.radius * 0.95, c.height);
      if (!canStand && sp < 3.2) sp = 3.2; // keep crawling out from under low obstacles
      this.vel.x = dirX * sp;
      this.vel.z = dirZ * sp;
      if (canStand && (this.slideTimer <= 0 || sp < c.walkSpeed * 0.8)) this._endSlide();
      else if (canStand && this.jumpBuffer > 0) {
        this._endSlide();
        this._jump(1.0);
      }
    } else {
      let maxSpeed = wishMag < 0.55 ? c.walkSpeed + (c.runSpeed - c.walkSpeed) * clamp((wishMag - 0.2) / 0.35, 0, 1) : c.runSpeed;
      if (this.sprinting) maxSpeed = c.sprintSpeed;
      maxSpeed *= this.speedMultiplier * wade;
      const tx = wishDirX * maxSpeed * (wishMag > 0 ? 1 : 0);
      const tz = wishDirZ * maxSpeed * (wishMag > 0 ? 1 : 0);
      if (this.grounded) {
        let accel = (wishMag > 0.05 ? c.groundAccel : c.groundDecel) * this.traction;
        if (wishMag > 0.05 && this.vel.x * wishDirX + this.vel.z * wishDirZ < 0) accel *= c.turnAccelBoost;
        [this.vel.x, this.vel.z] = moveTowards2(this.vel.x, this.vel.z, tx, tz, accel * dt);
      } else if (wishMag > 0.05) {
        // air control: steer freely but never brake momentum gained from pads/slides/dodges
        const before = hs;
        let [nx, nz] = moveTowards2(this.vel.x, this.vel.z, tx, tz, c.airAccel * dt);
        const after = Math.hypot(nx, nz);
        const cap = Math.max(before, maxSpeed * c.airMaxSpeedFactor);
        if (after > cap) { nx *= cap / after; nz *= cap / after; }
        this.vel.x = nx; this.vel.z = nz;
      }
    }

    // ---- jumping
    if (this.state !== MS.SLIDE && this.jumpBuffer > 0) {
      if (this.grounded || this.coyote > 0) {
        this._jump(1.0);
      } else if (this.wallTimer > 0 && this.wallJumps < c.maxWallJumps && this.wallJumpCooldown <= 0) {
        this.vel.x = this.wallNormal.x * c.wallJumpPush + this.vel.x * 0.35;
        this.vel.z = this.wallNormal.z * c.wallJumpPush + this.vel.z * 0.35;
        this.vel.y = c.wallJumpVelocity;
        this.wallJumps++;
        this.wallJumpCooldown = c.wallJumpCooldown;
        this.jumpBuffer = 0;
        this.jumpCutAvailable = false;
        this.wallTimer = 0;
        this.yaw = Math.atan2(-this.vel.x, -this.vel.z);
        if (this.state === MS.DODGE) this.state = MS.AIR;
        this.emit('walljump');
      }
    }
    if (this.jumpCutAvailable && !inp.jumpHeld && this.vel.y > 0) {
      this.vel.y *= c.jumpCutFactor;
      this.jumpCutAvailable = false;
    }
    if (this.vel.y <= 0) this.jumpCutAvailable = false;

    // ---- jump pads
    if (this.padCooldown <= 0) {
      for (const p of this.world.pads) {
        if (Math.abs(this.pos.y - p.y) < 0.35 && (this.pos.x - p.x) ** 2 + (this.pos.z - p.z) ** 2 < p.r * p.r) {
          this.vel.x = p.vx; this.vel.y = p.vy; this.vel.z = p.vz;
          this.grounded = false;
          this.coyote = 0;
          this.padCooldown = 0.5;
          if (this.state === MS.SLIDE) this._endSlide();
          this.state = MS.AIR;
          this.emit('pad');
          break;
        }
      }
    }

    // ---- rides: stepping onto a water slide's entry starts the ride
    if (this.rideCooldown <= 0) {
      for (const r of this.world.rides) {
        const e = r.pts[0];
        if (Math.abs(this.pos.y - e.y) < 1.2 && (this.pos.x - e.x) ** 2 + (this.pos.z - e.z) ** 2 < r.r * r.r) {
          this._startRide(r);
          return;
        }
      }
    }

    // ---- gravity
    if (!this.grounded || this.vel.y > 0) {
      const g = (this.state === MS.DODGE ? c.gravity * 0.35 : c.gravity) * this.gravityScale;
      this.vel.y = Math.max(-c.maxFallSpeed, this.vel.y - g * dt);
    }

    // ---- conveyor belts / escalators carry whoever stands on them
    if (zone && zone.k === 'conveyor' && this.grounded) {
      const k = this.world.conveyorScale;
      this.pos.x += zone.vx * k * dt;
      this.pos.z += zone.vz * k * dt;
    }

    this._integrate(dt);

    // ---- facing
    const fs = this.horizontalSpeed;
    if (this.state === MS.SLIDE || this.state === MS.DODGE) {
      if (this.state === MS.SLIDE && fs > 0.5) this.yaw = turnToward(this.yaw, Math.atan2(-this.vel.x, -this.vel.z), 14 * dt);
    } else if (fs > 0.6 && wishMag > 0.05) {
      this.yaw = turnToward(this.yaw, Math.atan2(-this.vel.x, -this.vel.z), (this.grounded ? 14 : 6) * dt);
    }
    if (this.grounded) this.airTime = 0;
    else this.airTime += dt;
  }

  // ------------------------------------------------------------------ abilities
  /**
   * Blink: short-range teleport. Marches forward in small steps and stops at the first point
   * that is not free, so it can never pass through a wall. Returns { from, to } or null.
   */
  blink(dirX, dirZ, range) {
    if (this.script || this.frozen || this.ride) return null;
    const c = this.cfg;
    const w = this.world;
    const len = Math.hypot(dirX, dirZ);
    if (len < 1e-3) return null;
    dirX /= len;
    dirZ /= len;
    const from = { x: this.pos.x, y: this.pos.y, z: this.pos.z };
    let best = null;
    let y = this.pos.y;
    for (let d = 0.25; d <= range + 1e-6; d += 0.25) {
      const x = from.x + dirX * d, z = from.z + dirZ * d;
      // follow the ground up small steps and down drops; keep height over gaps (lands later)
      const g = w.groundBelow(x, z, c.radius * 0.6, y + c.stepHeight);
      const ny = g && g.y >= y - 4 ? g.y : y;
      if (!w.isFree(x, ny + 0.02, z, c.radius, this.height)) break;
      y = ny;
      best = { x, y, z };
    }
    if (!best || Math.hypot(best.x - from.x, best.z - from.z) < 1.0) return null;
    this.pos.x = best.x; this.pos.y = best.y; this.pos.z = best.z;
    const keep = Math.max(this.horizontalSpeed, c.runSpeed);
    this.vel.x = dirX * keep;
    this.vel.z = dirZ * keep;
    this.vel.y = Math.max(0, this.vel.y);
    if (this.state === MS.SLIDE) this._endSlide();
    const landed = w.groundBelow(best.x, best.z, c.radius * 0.6, best.y + 0.05);
    this.grounded = !!landed && Math.abs(landed.y - best.y) < 0.05;
    this.state = this.grounded ? MS.GROUND : MS.AIR;
    this.yaw = Math.atan2(-dirX, -dirZ);
    const to = { ...best };
    this.emit('blink', { from, to });
    return { from, to };
  }

  /** Grapple hook: fly toward an anchor point (validated by the caller with a ray cast). */
  startGrapple(anchor, speed, maxTime) {
    if (this.script || this.frozen || this.ride) return false;
    if (this.state === MS.SLIDE) this._endSlide();
    this.grapple = { x: anchor.x, y: anchor.y, z: anchor.z, speed, t: 0, maxTime, lastD: Infinity, stuck: 0 };
    this.state = MS.GRAPPLE;
    this.grounded = false;
    this.emit('grapple', { anchor: { ...anchor } });
    return true;
  }

  _stepGrapple(dt, inp) {
    const g = this.grapple;
    g.t += dt;
    const cx = this.pos.x, cy = this.pos.y + 1.0, cz = this.pos.z;
    const dx = g.x - cx, dy = g.y - cy, dz = g.z - cz;
    const d = Math.hypot(dx, dy, dz);
    if (inp.jumpPressed) {
      // release early with a hop: keeps the momentum (skill tech)
      this.endGrapple(4);
      return;
    }
    if (d < 1.4 || g.t > g.maxTime) {
      this.endGrapple(3);
      return;
    }
    if (g.lastD - d < g.speed * dt * 0.15) g.stuck += dt; // blocked by geometry
    else g.stuck = 0;
    g.lastD = d;
    if (g.stuck > 0.2) {
      this.endGrapple(2);
      return;
    }
    this.vel.x = (dx / d) * g.speed;
    this.vel.y = (dy / d) * g.speed + 1.5;
    this.vel.z = (dz / d) * g.speed;
    this.yaw = Math.atan2(-dx, -dz);
    this._integrate(dt);
    this.state = MS.GRAPPLE;
  }

  endGrapple(hop = 0) {
    if (!this.grapple) return;
    this.grapple = null;
    this.vel.x *= 0.6;
    this.vel.z *= 0.6;
    this.vel.y = Math.max(this.vel.y * 0.4, hop);
    this.state = this.grounded ? MS.GROUND : MS.AIR;
    this.emit('grapple_end');
  }

  // ------------------------------------------------------------------ rides (water slides)
  _startRide(r) {
    if (this.state === MS.SLIDE) this._endSlide();
    this.grapple = null;
    this.ride = { r, s: 0, v: Math.max(6, this.horizontalSpeed * 0.7), p: {} };
    this.state = MS.RIDE;
    this.grounded = false;
    this.height = this.cfg.slideHeight;
    this.emit('ride', { id: r.id });
  }

  _stepRide(dt) {
    const rd = this.ride;
    const r = rd.r;
    const p = r.at(rd.s, rd.p);
    // gravity pulls you down the slope; a little drag keeps the top speed sane
    rd.v = clamp(rd.v + (-p.ty * this.cfg.gravity * this.gravityScale * 0.85 - 1.5) * dt, 5, r.vmax);
    const v = rd.v * (this.world.rideScale || 1); // Slide Rush event: everything on the slides runs 50% faster
    rd.s += v * dt;
    const q = r.at(rd.s, rd.p);
    this.pos.x = q.x; this.pos.y = q.y; this.pos.z = q.z;
    this.vel.x = q.tx * v; this.vel.y = q.ty * v; this.vel.z = q.tz * v;
    if (Math.abs(q.tx) + Math.abs(q.tz) > 0.05) this.yaw = Math.atan2(-q.tx, -q.tz);
    if (rd.s >= r.len) {
      // shot out of the end of the tube
      this.ride = null;
      this.rideCooldown = 1.5;
      this.height = this.cfg.height;
      this.vel.y = Math.max(this.vel.y, 2.5);
      this.state = MS.AIR;
      this.emit('ride_end', { id: r.id, speed: rd.v });
    }
  }

  /** Rocket jump: big upward launch with a little forward push. Works in the air too. */
  rocket(vy, forward) {
    if (this.script || this.frozen || this.ride) return false;
    if (this.grapple) this.endGrapple();
    if (this.state === MS.SLIDE) this._endSlide();
    const fx = -Math.sin(this.yaw), fz = -Math.cos(this.yaw);
    this.vel.y = Math.max(this.vel.y, vy);
    this.vel.x += fx * forward;
    this.vel.z += fz * forward;
    this.grounded = false;
    this.coyote = 0;
    this.state = MS.AIR;
    this.emit('rocket');
    return true;
  }

  /** External push (Shockwave). Ignored during scripted vault/mantle motion. */
  applyImpulse(vx, vy, vz) {
    if (this.script || this.ride) return;
    if (this.grapple) this.endGrapple();
    if (this.state === MS.SLIDE) this._endSlide();
    this.vel.x += vx;
    this.vel.y = Math.max(this.vel.y, 0) + vy;
    this.vel.z += vz;
    if (vy > 0) {
      this.grounded = false;
      this.state = MS.AIR;
    }
    this.emit('knocked');
  }

  _jump(scale) {
    this.vel.y = this.cfg.jumpVelocity * scale;
    this.grounded = false;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.jumpCutAvailable = true;
    this.state = MS.AIR;
    this.emit('jump');
  }

  _endSlide() {
    this.state = this.grounded ? MS.GROUND : MS.AIR;
    this.height = this.cfg.height;
    this.slideCooldown = this.cfg.slideCooldown;
  }

  _integrate(dt) {
    const c = this.cfg;
    const w = this.world;
    const speed = Math.hypot(this.vel.x, this.vel.y, this.vel.z);
    const steps = Math.max(1, Math.ceil((speed * dt) / 0.22));
    const sdt = dt / steps;
    const wasGrounded = this.grounded;
    let landedSpeed = 0;
    let touchedWall = false;

    for (let s = 0; s < steps; s++) {
      // horizontal
      this.pos.x += this.vel.x * sdt;
      this.pos.z += this.vel.z * sdt;
      const stepUp = this.grounded ? c.stepHeight : 0.3;
      const contacts = w.resolveHorizontal(this.pos, c.radius, this.height, stepUp, this._n);
      if (contacts > 0) {
        const nx = this._n.x, nz = this._n.z;
        const into = this.vel.x * nx + this.vel.z * nz;
        if (into < 0) {
          this.vel.x -= nx * into;
          this.vel.z -= nz * into;
        }
        if (!this.grounded && (nx !== 0 || nz !== 0)) {
          this.wallNormal.x = nx; this.wallNormal.z = nz;
          touchedWall = true;
        }
      }
      w.clampToBounds(this.pos, c.radius);

      // vertical
      const prevY = this.pos.y;
      let newY = prevY + this.vel.y * sdt;
      if (this.vel.y > 0) {
        const ceil = w.ceilingBetween(this.pos.x, this.pos.z, c.radius, prevY + this.height, newY + this.height);
        if (ceil !== null) {
          newY = Math.min(newY, ceil - this.height);
          this.vel.y = 0;
        }
      }
      const footR = c.radius * 0.65;
      const searchTop = Math.max(prevY, newY) + (this.grounded ? c.stepHeight : 0.3);
      const ground = w.groundBelow(this.pos.x, this.pos.z, footR, searchTop);
      if (this.vel.y <= 0 && ground) {
        const snapDown = this.grounded ? 0.45 : 0;
        if (ground.y >= newY - snapDown - 1e-4) {
          if (!this.grounded) landedSpeed = Math.max(landedSpeed, -this.vel.y);
          newY = ground.y;
          this.vel.y = 0;
          this.grounded = true;
          this.groundCollider = ground.collider;
        } else {
          this.grounded = false;
        }
      } else if (this.vel.y > 0) {
        this.grounded = false;
      } else if (!ground) {
        this.grounded = false;
      }
      this.pos.y = newY;
    }

    if (touchedWall) this.wallTimer = 0.18;
    if (this.grounded && !wasGrounded) {
      this.wallJumps = 0;
      this.lastLandSpeed = landedSpeed;
      if (this.state === MS.AIR) this.state = MS.GROUND;
      this.emit('land', { speed: landedSpeed, airTime: this.airTime });
    }
    if (!this.grounded && this.state === MS.GROUND) this.state = MS.AIR;
    if (this.state === MS.SLIDE && !this.grounded) this._endSlide();

    if (this.pos.y < w.killY) this.emit('fell');
  }

  // ------------------------------------------------------------------ vault / mantle
  _tryVault(dirX, dirZ, explicit) {
    const c = this.cfg;
    const w = this.world;
    const feet = this.pos.y;
    const probeDist = c.radius + (explicit ? 0.6 : 0.32);
    const px = this.pos.x + dirX * probeDist;
    const pz = this.pos.z + dirZ * probeDist;
    const top = w.obstacleTop(px, pz, 0.12, feet + 0.05, feet + 0.6);
    if (!isFinite(top)) return false;
    const h = top - feet;
    if (h < c.vaultMinHeight || h > c.vaultMaxHeight) return false;
    // the obstacle must not continue upward into a wall right above it
    if (!w.isFree(px + dirX * 0.15, top + 0.02, pz + dirZ * 0.15, 0.2, 1.0)) return false;

    // find the far edge of the obstacle
    let edge = -1;
    for (let s = 0.2; s <= c.vaultMaxDepth + 0.4; s += 0.15) {
      const qx = px + dirX * s, qz = pz + dirZ * s;
      const t2 = w.obstacleTop(qx, qz, 0.05, feet - 4, top + 0.05);
      if (!isFinite(t2) || t2 < top - 0.3) { edge = s; break; }
      if (t2 > top + 0.3) return false; // something taller behind it
    }
    if (edge > 0 && edge <= c.vaultMaxDepth) {
      // VAULT over
      const lx = px + dirX * (edge + c.radius + 0.25);
      const lz = pz + dirZ * (edge + c.radius + 0.25);
      const g = w.groundBelow(lx, lz, c.radius * 0.65, top + 0.4);
      const landY = g ? g.y : feet;
      if (landY < feet - 6) return false;
      if (!w.isFree(lx, landY + 0.02, lz, c.radius, c.height)) return false;
      if (!this._pathClear(this.pos.x, this.pos.z, lx, lz, top + 0.12, 0.95)) return false;
      const exit = Math.max(this.horizontalSpeed, c.runSpeed * 0.95);
      this._startScript(MS.VAULT, lx, landY, lz, top + 0.2, c.vaultDuration, dirX, dirZ, exit);
      this.emit('vault', { height: h });
      return true;
    }
    // CLIMB onto a deep obstacle (e.g. a platform edge)
    if (explicit || h > 0.9) return this._climbOnto(px, pz, dirX, dirZ, top, false);
    return false;
  }

  _tryMantleAir(dirX, dirZ) {
    const c = this.cfg;
    const w = this.world;
    const feet = this.pos.y;
    const px = this.pos.x + dirX * (c.radius + 0.28);
    const pz = this.pos.z + dirZ * (c.radius + 0.28);
    const top = w.obstacleTop(px, pz, 0.12, feet + 0.25, feet + 1.4);
    if (!isFinite(top)) return false;
    const h = top - feet;
    if (h < 0.3 || h > 1.3) return false;
    return this._climbOnto(px, pz, dirX, dirZ, top, true);
  }

  _climbOnto(px, pz, dirX, dirZ, top, fromAir) {
    const c = this.cfg;
    const w = this.world;
    const tx = px + dirX * (c.radius + 0.12);
    const tz = pz + dirZ * (c.radius + 0.12);
    const g = w.groundBelow(tx, tz, c.radius * 0.65, top + 0.05);
    if (!g || Math.abs(g.y - top) > 0.35) return false;
    if (!w.isFree(tx, g.y + 0.02, tz, c.radius, c.height)) return false;
    if (!this._pathClear(this.pos.x, this.pos.z, tx, tz, g.y + 0.05, 1.0)) return false;
    const rise = g.y - this.pos.y;
    const dur = this.cfg.mantleDuration * clamp(0.6 + rise / 2.5, 0.6, 1.2);
    this._startScript(MS.MANTLE, tx, g.y, tz, g.y + 0.1, dur, dirX, dirZ, c.runSpeed * 0.55);
    this.emit('mantle', { height: rise, fromAir });
    return true;
  }

  /** Clearance along the straight path at a given height (used before scripted motion). */
  _pathClear(x0, z0, x1, z1, feetY, h) {
    const n = 6;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      if (!this.world.isFree(x0 + (x1 - x0) * t, feetY, z0 + (z1 - z0) * t, this.cfg.radius * 0.8, h)) return false;
    }
    return true;
  }

  _startScript(kind, ex, ey, ez, apexY, duration, dirX, dirZ, exitSpeed) {
    if (this.state === MS.SLIDE) this._endSlide();
    this.script = {
      kind,
      t: 0,
      duration,
      sx: this.pos.x, sy: this.pos.y, sz: this.pos.z,
      ex, ey, ez,
      apex: Math.max(apexY, ey, this.pos.y),
      dirX, dirZ, exitSpeed,
    };
    this.state = kind;
    this.yaw = Math.atan2(-dirX, -dirZ);
    this.grounded = false;
    this.vel.y = 0;
    this.height = kind === MS.VAULT ? 1.1 : this.cfg.height;
    this.jumpBuffer = 0;
  }

  _stepScript(dt) {
    const s = this.script;
    s.t += dt / s.duration;
    const t = Math.min(1, s.t);
    // Horizontal travel starts slightly late so the body is already up before it moves over
    // the obstacle; vertical motion = quick rise -> hold over the top -> settle onto the end.
    const e = smoothstep(Math.max(0, (t - 0.15) / 0.85));
    this.pos.x = s.sx + (s.ex - s.sx) * e;
    this.pos.z = s.sz + (s.ez - s.sz) * e;
    if (t < 0.35) {
      const k = t / 0.35;
      this.pos.y = s.sy + (s.apex - s.sy) * (1 - (1 - k) * (1 - k));
    } else if (t < 0.65) {
      this.pos.y = s.apex;
    } else {
      const k = (t - 0.65) / 0.35;
      this.pos.y = s.apex + (s.ey - s.apex) * k * k;
    }
    this.vel.x = s.dirX * s.exitSpeed;
    this.vel.z = s.dirZ * s.exitSpeed;
    this.vel.y = 0;
    if (t >= 1) {
      this.pos.x = s.ex; this.pos.y = s.ey; this.pos.z = s.ez;
      this.script = null;
      this.height = this.cfg.height;
      this.grounded = true;
      this.state = MS.GROUND;
      this.coyote = this.cfg.coyoteTime;
      this.emit('land', { speed: 2, airTime: 0, scripted: true });
    }
  }

  /** Normalised progress of scripted motion (for animation). */
  get scriptProgress() {
    if (this.script) return Math.min(1, this.script.t);
    return this.ride ? this.ride.s / this.ride.r.len : 0;
  }
}

function turnToward(cur, target, maxStep) {
  const d = wrapAngle(target - cur);
  return cur + clamp(d, -maxStep, maxStep);
}
