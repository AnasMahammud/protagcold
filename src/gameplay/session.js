// Shared match-session machinery used by offline (LocalMatch), online (OnlineMatch) and the
// main-menu attract mode: fixed-step simulation, input mapping, movement feedback (audio,
// particles, trails), tag feedback, camera, spectating and HUD state.
import { audio, surfaceFor } from '../audio/audio.js';
import { bus } from '../core/events.js';
import { settings, describeCode } from '../core/settings.js';
import { MS } from '../movement/controller.js';
import { Player } from '../player/player.js';
import { formatTime } from '../core/mathUtil.js';
import { progression } from '../progression/progression.js';

export class MatchSession {
  constructor(game, opts) {
    this.game = game;
    this.cfg = game.cfg;
    this.opts = opts;
    this.mode = opts.mode;
    this.players = new Map();
    this.localId = null;
    this.spectateId = null;
    this.acc = 0;
    this.step = 1 / this.cfg.tick.simHz;
    this.paused = false; // offline only: freezes simulation
    this.inputBlocked = false; // menus open (online pause): local player stops but world runs
    this.ended = false;
    this.attract = !!opts.attract;
    this.pendingCmd = null;
    this.scoreboardHeld = false;
    this.disposed = false;
    this.lastHudEvents = [];
    this.wasSliding = new Map();
    this.edges = { jumpPressed: false, slidePressed: false, dodgePressed: false, vaultPressed: false };
    this.timeScale = 1; // set by the perfect-dodge cinematic
    this.allowSlowmo = false; // only offline matches may slow the world down
  }

  get world() {
    return this.game.map.world;
  }

  get local() {
    return this.players.get(this.localId) || null;
  }

  addPlayer({ id, name, kind, cosmetics }) {
    const p = new Player({ id, name, kind, cosmetics, world: this.world, moveCfg: this.cfg.movement, scene: this.game.scene });
    p.model.setCastShadows(this.game.characterShadows ?? true);
    this.players.set(id, p);
    this.game.effects.setTrail(id, p.cosmetics.trail === 'none' ? null : TRAIL_STYLE[p.cosmetics.trail], p.cosmetics.accent);
    p.model.onFootstep = (speed) => {
      if (!p.ctrl.grounded) return;
      const vol = p.kind === 'local' ? 0.85 : 1;
      audio.play('footstep', { pos: p.renderPos, speed, surface: surfaceFor(p.ctrl.groundCollider?.m), ownerId: p.id, volume: vol });
      if (p.cosmetics.trail === 'sparks' && speed > 8) this.game.effects.sparks(p.renderPos, p.cosmetics.accent);
    };
    return p;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (!p) return;
    audio.stopSlide(id);
    this.game.effects.removeTrail(id);
    p.dispose();
    this.players.delete(id);
  }

  /** Converts the raw input command into a world-space controller input for the local player. */
  mapInput(cmd) {
    const f = this.game.cameraRig.forward();
    const r = this.game.cameraRig.right();
    return {
      mx: r.x * cmd.mx + f.x * cmd.my,
      mz: r.z * cmd.mx + f.z * cmd.my,
      jumpPressed: cmd.jumpPressed,
      jumpHeld: cmd.jumpHeld,
      sprint: cmd.sprint,
      slidePressed: cmd.slidePressed,
      dodgePressed: cmd.dodgePressed,
      vaultPressed: cmd.vaultPressed,
    };
  }

  frame(dt, time) {
    if (this.disposed) return;
    const input = this.game.input;
    const cmd = input.sample(dt);
    const local = this.local;
    const canControl = !!local && !this.inputBlocked && !this.paused && !local.out && !this.attract;
    if (cmd.pausePressed && !this.attract) bus.emit('game:pauseToggle');
    this.scoreboardHeld = cmd.scoreboard && !this.attract;
    if (canControl || (local?.out && !this.paused)) this.game.cameraRig.applyLook(cmd.lookX, cmd.lookY);
    if (canControl && cmd.emote && local.ctrl.grounded && local.ctrl.horizontalSpeed < 1.5) {
      if (progression.emoteUnlocked(cmd.emote)) this.emote(local.id, cmd.emote);
      else bus.emit('hud:feed', { kind: 'info', text: 'That emote is still locked (see Customise)' });
    }
    if (canControl && cmd.swapItPressed) this.onSwapIt?.();
    if (local?.out && !this.inputBlocked && !this.paused && (cmd.jumpPressed || cmd.vaultPressed)) this.cycleSpectate(1);

    // fixed-step simulation. Edge-triggered presses accumulate until a sim step consumes them,
    // so taps are never lost on high-refresh displays where some frames run no step.
    if (!this.paused) {
      this.acc += dt * (this.allowSlowmo ? this.timeScale : 1);
      const mapped = canControl ? this.mapInput(cmd) : { ...ZERO_INPUT };
      const e = this.edges;
      for (const k of EDGE_KEYS) e[k] = e[k] || mapped[k];
      let steps = 0;
      while (this.acc >= this.step && steps < 6) {
        const inp = { ...mapped };
        for (const k of EDGE_KEYS) {
          inp[k] = e[k];
          e[k] = false;
        }
        this.simStep(this.step, inp);
        this.acc -= this.step;
        steps++;
      }
      if (steps === 6) this.acc = 0; // spiral-of-death guard
    }
    const alpha = this.paused ? 1 : this.acc / this.step;
    this.renderPlayers(dt, time, alpha);
    this.updateCamera(dt, time);
  }

  /** Implemented by subclasses: advance the simulation by one fixed step. */
  simStep() {}

  /** Process controller events (audio/particles) for a player after it stepped. */
  handleMoveEvents(p) {
    const fx = this.game.effects;
    const evs = p.ctrl.events;
    if (!evs.length) return;
    const pos = p.ctrl.pos;
    for (const e of evs) {
      switch (e.type) {
        case 'jump':
          audio.play('jump', { pos, ownerId: p.id });
          fx.dust(pos, 0.6);
          break;
        case 'walljump':
          audio.play('walljump', { pos, ownerId: p.id });
          fx.dust({ x: pos.x - p.ctrl.wallNormal.x * 0.4, y: pos.y + 1, z: pos.z - p.ctrl.wallNormal.z * 0.4 }, 0.8);
          break;
        case 'land':
          if (!e.scripted && e.speed > 4) {
            audio.play('land', { pos, speed: e.speed, ownerId: p.id });
            fx.dust(pos, Math.min(2, e.speed / 8));
            p.model.landed(e.speed);
            if (p.id === this.localId) this.game.cameraRig.onLand(e.speed);
          } else if (e.scripted) {
            audio.play('footstep', { pos, speed: 6, surface: surfaceFor(p.ctrl.groundCollider?.m), ownerId: p.id });
          }
          break;
        case 'vault':
          audio.play('vault', { pos, ownerId: p.id });
          break;
        case 'mantle':
          audio.play('mantle', { pos, ownerId: p.id });
          break;
        case 'dodge':
          audio.play('dodge', { pos, ownerId: p.id });
          fx.dust(pos, 0.7);
          break;
        case 'slide':
          audio.play('slide', { pos, ownerId: p.id });
          break;
        case 'pad':
          audio.play('pad', { pos, ownerId: p.id });
          fx.pad(pos, '#3df5ff');
          break;
        case 'fell':
          this.onFell?.(p);
          break;
        default:
          break;
      }
    }
    evs.length = 0;
  }

  renderPlayers(rawDt, time, alpha) {
    const dt = rawDt * (this.allowSlowmo ? this.timeScale : 1); // limbs move in slow motion too
    const fx = this.game.effects;
    const local = this.local;
    for (const p of this.players.values()) {
      const s = p.render(dt, time, p.kind === 'remote' ? 1 : alpha);
      p.model.setIt(p.it && !p.out, this.mode === 'infection');
      p.model.setGhost(p.out || !p.connected);
      // perfect-dodge aftermath: dizzy stars on the stunned tagger, electric boost on the dodger
      if (!p.frozen) p.stunFx = false;
      p.model.setStunned(!!(p.frozen && p.stunFx));
      if (!!p.boosted !== !!p.boostTrail) {
        p.boostTrail = !!p.boosted;
        fx.setTrail(p.id, p.boosted ? 'rainbow' : (p.cosmetics.trail === 'none' ? null : TRAIL_STYLE[p.cosmetics.trail]), p.boosted ? '#3df5ff' : p.cosmetics.accent);
      }
      if (p.boosted && Math.random() < 0.3) fx.sparks(p.renderPos, Math.random() < 0.5 ? '#3df5ff' : '#ff3df0');
      p.model.root.visible = p.connected;
      // hide our own name tag; show others
      p.model.showName(p.id !== this.localId || this.attract);
      // continuous slide audio + dust
      const sliding = s.state === MS.SLIDE;
      if (sliding && !this.wasSliding.get(p.id)) audio.startSlide(p.id, s);
      if (!sliding && this.wasSliding.get(p.id)) audio.stopSlide(p.id);
      this.wasSliding.set(p.id, sliding);
      if (sliding && Math.random() < 0.5) fx.dust(s, 0.25);
      fx.updateTrail(p.id, s, Math.hypot(s.vx, s.vz), dt, time);
    }
    audio.setListener(this.game.camera.position, this.game.cameraRig.yaw);
    if (local) {
      // sprint cue for the local player (others are heard through their faster footsteps)
      const sprinting = local.ctrl.sprinting && local.ctrl.grounded && local.ctrl.horizontalSpeed > 8;
      if (sprinting && !this.wasSprinting) audio.play('sprint', { pos: local.renderPos, volume: 0.8 });
      this.wasSprinting = sprinting;
    }
  }

  updateCamera(dt, time) {
    const rig = this.game.cameraRig;
    if (this.attract) {
      const subject = this.attractSubject();
      if (subject) rig.updateCinematicFollow(dt, subject.renderPos, time);
      return;
    }
    const local = this.local;
    if (local && !local.out) {
      rig.updateFollow(dt, localView(local), time);
      return;
    }
    // spectating
    const target = this.spectateTarget();
    if (target) rig.updateSpectate(dt, localView(target), time);
    else if (local) rig.updateFollow(dt, localView(local), time);
  }

  attractSubject() {
    const it = [...this.players.values()].find((p) => p.it && !p.out);
    return it || this.players.values().next().value;
  }

  spectateTarget() {
    const alive = [...this.players.values()].filter((p) => !p.out && p.connected && p.id !== this.localId);
    if (!alive.length) return null;
    let t = alive.find((p) => p.id === this.spectateId);
    if (!t) {
      t = alive[0];
      this.spectateId = t.id;
    }
    return t;
  }

  cycleSpectate(dir = 1) {
    const alive = [...this.players.values()].filter((p) => !p.out && p.connected && p.id !== this.localId);
    if (!alive.length) return;
    const i = alive.findIndex((p) => p.id === this.spectateId);
    this.spectateId = alive[(i + dir + alive.length) % alive.length].id;
  }

  emote(id, emote) {
    const p = this.players.get(id);
    if (!p) return;
    p.model.playEmote(emote);
    this.onEmote?.(id, emote);
  }

  /** Feedback for rule events (shared by offline and online). */
  feedback(ev) {
    const fx = this.game.effects;
    const local = this.local;
    if (ev.type === 'tag') {
      const a = this.players.get(ev.tagger);
      const b = this.players.get(ev.target);
      if (!a || !b) return;
      a.model.lunge();
      fx.tag(b.renderPos, a.cosmetics.tagEffect, a.cosmetics.accent);
      audio.play('tag', { pos: b.renderPos });
      audio.crowdCheer(1);
      if (ev.target === this.localId || ev.tagger === this.localId) {
        this.game.cameraRig.shake(0.35);
        fx.flash(ev.target === this.localId ? 'rgba(255,59,47,0.35)' : 'rgba(255,255,255,0.25)');
      }
      bus.emit('hud:feed', { kind: 'tag', a: a.name, b: b.name, mine: ev.tagger === this.localId, me: ev.target === this.localId });
    } else if (ev.type === 'it' || ev.type === 'infected') {
      const p = this.players.get(ev.id);
      if (!p) return;
      fx.becomeIt(p.renderPos, this.mode === 'infection' ? '#7dff3d' : '#ff3b2f');
      if (ev.id === this.localId) {
        audio.play('becomeIt');
        bus.emit('hud:banner', { text: this.mode === 'infection' ? 'INFECTED!' : "YOU'RE IT!", sub: this.mode === 'infection' ? 'Tag the remaining runners' : 'Tag someone to pass it on', color: this.mode === 'infection' ? '#7dff3d' : '#ff3b2f' });
      } else if (ev.from === this.localId) {
        audio.play('escaped');
        bus.emit('hud:banner', { text: 'TAGGED!', sub: `${p.name} is IT — run!`, color: '#3df5ff' });
      } else if (ev.reason === 'disconnect') {
        bus.emit('hud:feed', { kind: 'info', text: `${p.name} is now IT` });
      }
    } else if (ev.type === 'eliminated') {
      const p = this.players.get(ev.id);
      if (!p) return;
      fx.eliminated(p.renderPos);
      audio.play('eliminated', { pos: p.renderPos });
      if (ev.id === this.localId) {
        bus.emit('hud:banner', { text: 'ELIMINATED', sub: 'Spectating — click / press Jump to switch player', color: '#9aa6b8' });
      }
    } else if (ev.type === 'perfect_dodge') {
      const dodger = this.players.get(ev.dodger);
      const tagger = this.players.get(ev.tagger);
      if (!dodger) return;
      if (tagger) {
        tagger.stunFx = true;
        tagger.model.lunge(); // the swing that missed
      }
      if (dodger.kind !== 'remote') dodger.ctrl.stamina = this.cfg.movement.staminaMax;
      const kind = this.attract ? 'world' : ev.dodger === this.localId ? 'hero' : ev.tagger === this.localId ? 'victim' : 'world';
      const pd = this.cfg.perfectDodge;
      const slowmo = kind === 'hero' && this.allowSlowmo;
      const duration = kind === 'hero' ? (slowmo ? pd.animTime : pd.onlineAnimTime) : 0.9;
      this.game.perfectFx?.play({ session: this, dodger, tagger, kind, slowmo, duration });
    } else if (ev.type === 'start') {
      audio.play('go');
      bus.emit('hud:banner', { text: 'GO!', sub: this.objectiveText(), color: '#ffd23d', ms: 1400 });
      fx.flash('rgba(255,210,61,0.18)', 120);
    }
  }

  objectiveText() {
    const local = this.local;
    if (!local) return '';
    switch (this.mode) {
      case 'classic':
        return local.it ? 'You are IT — tag someone!' : 'Avoid whoever is IT';
      case 'infection':
        return local.it ? 'Infect every runner' : 'Survive until the clock runs out';
      case 'elimination':
        return local.out ? 'Spectating' : local.it ? 'Hunt down every runner' : 'Be the last runner standing';
      default:
        return local.it ? 'You are IT (T to swap)' : 'Practice — press T to become IT';
    }
  }

  /** HUD data consumed by ui/hud.js. Subclasses provide `rulesView()`. */
  hudState() {
    const rv = this.rulesView();
    const local = this.local;
    const its = [...this.players.values()].filter((p) => p.it && !p.out && p.connected);
    const runners = [...this.players.values()].filter((p) => !p.it && !p.out && p.connected);
    const c = local?.ctrl;
    const mv = this.cfg.movement;
    let arrow = null;
    if (local && !local.out && rv.phase === 'playing') {
      // directional indicator: runners see the nearest IT; IT sees the nearest runner within 30m
      const pool = local.it ? runners : its;
      let best = null;
      let bd = local.it ? 30 : Infinity;
      for (const p of pool) {
        if (p.id === local.id) continue;
        const d = Math.hypot(p.ctrl.pos.x - c.pos.x, p.ctrl.pos.z - c.pos.z);
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
      if (best) {
        const dx = best.ctrl.pos.x - c.pos.x, dz = best.ctrl.pos.z - c.pos.z;
        const ang = Math.atan2(dx, -dz) + this.game.cameraRig.yaw; // relative to view
        arrow = { angle: ang, dist: bd, threat: !local.it, name: best.name };
      }
    }
    return {
      mode: this.mode,
      phase: rv.phase,
      countdown: rv.countdown,
      timeLeft: rv.timeLeft,
      clock: rv.timeLeft === Infinity ? '∞' : formatTime(rv.timeLeft),
      its: its.map((p) => p.name),
      localIt: !!local?.it,
      localOut: !!local?.out,
      runners: runners.length,
      total: [...this.players.values()].filter((p) => p.connected).length,
      tags: rv.localTags ?? 0,
      stamina: c ? c.stamina / mv.staminaMax : 1,
      sprinting: !!c?.sprinting,
      dodge: c ? 1 - c.dodgeCooldown / mv.dodgeCooldown : 1,
      dodgeKey: describeCode(settings.data.controls.bindings.dodge?.[0]),
      dodgeCue: this.dodgeCue(local, its, rv.phase),
      boostLeft: local?.boostLeft || 0,
      boostTime: this.cfg.perfectDodge.boostTime,
      stunned: !!(local?.frozen && local?.stunFx),
      slide: c ? 1 - c.slideCooldown / mv.slideCooldown : 1,
      frozen: !!local?.frozen,
      protected: !!local?.protected,
      objective: this.objectiveText(),
      spectating: local?.out ? this.spectateTarget()?.name ?? null : null,
      arrow,
      scoreboard: this.scoreboardHeld ? rv.scoreboard : null,
      net: this.netStatus?.() ?? null,
    };
  }

  /**
   * Timing cue for the local runner: how soon the nearest closing-in IT reaches tag range.
   * Returns { ttc, perfect } when a perfect dodge is possible right now-ish, else null.
   */
  dodgeCue(local, its, phase) {
    if (!local || local.it || local.out || phase !== 'playing' || local.ctrl.dodgeCooldown > 0) return null;
    const range = this.cfg.tag.range;
    const pd = this.cfg.perfectDodge;
    const me = local.ctrl.pos;
    let best = null;
    for (const p of its) {
      if (p.frozen) continue;
      const dx = me.x - p.ctrl.pos.x, dz = me.z - p.ctrl.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 0.01 || d > 6 || Math.abs(me.y - p.ctrl.pos.y) > 1.7) continue;
      const closing = (p.ctrl.vel.x * dx + p.ctrl.vel.z * dz) / d - (local.ctrl.vel.x * dx + local.ctrl.vel.z * dz) / d;
      if (closing < pd.closingSpeed) continue;
      const ttc = Math.max(0, d - range) / closing; // seconds until IT is in tag range
      if (ttc > 0.6) continue;
      if (!best || ttc < best.ttc) best = { ttc, perfect: ttc <= pd.window, d };
    }
    return best;
  }

  scoreboardInfo() {
    const rv = this.rulesView();
    const it = [...this.players.values()].find((p) => p.it && !p.out);
    return { clock: rv.timeLeft === Infinity ? 'PRACTICE' : formatTime(rv.timeLeft), itName: it?.name };
  }

  rulesView() {
    return { phase: 'playing', countdown: 0, timeLeft: Infinity, scoreboard: [] };
  }

  dispose() {
    this.disposed = true;
    audio.stopAllLoops();
    for (const id of [...this.players.keys()]) this.removePlayer(id);
  }
}

const TRAIL_STYLE = { streak: 'ribbon', rainbow: 'rainbow', ember: 'ember', sparks: 'sparks' };
const EDGE_KEYS = ['jumpPressed', 'slidePressed', 'dodgePressed', 'vaultPressed'];
const ZERO_INPUT = Object.freeze({ mx: 0, mz: 0, jumpPressed: false, jumpHeld: false, sprint: false, slidePressed: false, dodgePressed: false, vaultPressed: false });

function localView(p) {
  return p.ctrl;
}

export { TRAIL_STYLE, settings };
