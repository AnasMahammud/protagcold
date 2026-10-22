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
import { AbilitySystem, scrambleStick, SCRAMBLE_HINT } from './abilities.js';
import * as AFX from '../effects/abilityFx.js';
import { ZoneVisual } from '../effects/zoneFx.js';
import { MapEventDirector, EVENT_INFO, eventMods } from './mapEvents.js';
import { MatchIntro } from './intro.js';

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
    this.online = false;
    this.abilities = new AbilitySystem(this);
    this.coins = null; // MapCoins, created by the subclass once the map is known
    this.grappleTarget = null;
    this.intro = null; // pre-match cutscene while it plays
  }

  /** Play the pre-match map cutscene; resolves when it ends (or is skipped). */
  playIntro(opts = {}) {
    return new Promise((resolve) => {
      if (this.disposed || this.attract) return resolve();
      this.intro = new MatchIntro(this, {
        ...opts,
        onDone: () => {
          this.intro = null;
          resolve();
        },
      });
    });
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
    let mx = cmd.mx, my = cmd.my;
    const local = this.local;
    // Scramble: the stick is remapped in the frame the player steers in (the camera)
    const mode = local && this.abilities.isScrambled(local) ? local.scrambleMode : null;
    if (mode) [mx, my] = scrambleStick(mx, my, mode);
    const swap = mode === 'mirror';
    return {
      mx: r.x * mx + f.x * my,
      mz: r.z * mx + f.z * my,
      jumpPressed: swap ? cmd.slidePressed : cmd.jumpPressed,
      jumpHeld: swap ? true : cmd.jumpHeld,
      sprint: cmd.sprint,
      slidePressed: swap ? cmd.jumpPressed : cmd.slidePressed,
      dodgePressed: cmd.dodgePressed,
      vaultPressed: cmd.vaultPressed,
    };
  }

  frame(dt, time) {
    if (this.disposed) return;
    const input = this.game.input;
    const cmd = input.sample(dt);
    const local = this.local;
    const canControl = !!local && !this.inputBlocked && !this.paused && !local.out && !this.attract && !this.intro;
    if (this.intro) {
      if (cmd.pausePressed || cmd.jumpPressed || cmd.vaultPressed) this.intro.skip(); // keyboard, mouse and pad
    } else if (cmd.pausePressed && !this.attract) bus.emit('game:pauseToggle');
    this.scoreboardHeld = cmd.scoreboard && !this.attract;
    if (canControl || (local?.out && !this.paused)) this.game.cameraRig.applyLook(cmd.lookX, cmd.lookY);
    if (canControl && cmd.emote && local.ctrl.grounded && local.ctrl.horizontalSpeed < 1.5) {
      if (progression.emoteUnlocked(cmd.emote)) this.emote(local.id, cmd.emote);
      else bus.emit('hud:feed', { kind: 'info', text: 'That emote is still locked (see Customise)' });
    }
    if (canControl && cmd.swapItPressed) this.onSwapIt?.();
    // abilities: aim with the camera (grapple uses the crosshair ray)
    if (local && local.loadout?.some(Boolean)) {
      this.grappleTarget = local.loadout.includes('grapple') && canControl ? this.findGrappleTarget(local) : null;
      if (canControl && (cmd.ability1Pressed || cmd.ability2Pressed) && this.rulesView().phase === 'playing') {
        const slot = cmd.ability1Pressed ? 0 : 1;
        const f = this.game.cameraRig.forward();
        const mv = this.mapInput(cmd);
        const look = this.game.camera.getWorldDirection(this._lookV || (this._lookV = this.game.camera.position.clone()));
        this.abilities.use(local, slot, { move: { x: mv.mx, z: mv.mz }, look: { x: look.x, y: look.y, z: look.z, fx: f.x, fz: f.z }, anchor: this.grappleTarget });
      }
    }
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
    this.abilities.render(dt, time);
    AFX.update(dt);
    AFX.tickTrails(this, dt);
    this.coins?.render(dt, time);
    this.updateModeVisuals(dt);
    if (!this.attract) {
      const rv = this.rulesView();
      if (!this.events) this.events = new MapEventDirector(this);
      this.events.update(dt, rv.mapEvent || null, rv.time ?? 0);
    }
    this.updateCamera(dt, time);
  }

  /** Movement modifiers from the active map event (low gravity, wet floors, speed surge). */
  eventMods() {
    const rv = this.rulesView();
    return eventMods(rv.mapEvent || null, rv.time ?? 0);
  }

  /** Hot Potato ticking + bomb heat, Shrinking Zone wall + warnings. */
  updateModeVisuals(dt) {
    if (this.attract) return;
    const rv = this.rulesView();
    const local = this.local;
    if (rv.zone) {
      if (!this.zoneFx) this.zoneFx = new ZoneVisual(this.game.scene);
      const outside = !!local && !local.out && !local.it && Math.hypot(local.renderPos.x - rv.zone.x, local.renderPos.z - rv.zone.z) > rv.zone.r;
      this.zoneFx.update(dt, rv.zone, outside);
      if (rv.phase === 'playing' && rv.zone.k > 0 && !this._zoneClosing) {
        this._zoneClosing = true;
        audio.play('zoneClosing');
        bus.emit('hud:banner', { text: 'THE RING IS CLOSING', sub: 'Stay inside it — 4 s outside and you are out', color: '#3df5ff', ms: 2200 });
      }
      this._warnT = (this._warnT || 0) - dt;
      if (outside && rv.phase === 'playing' && this._warnT <= 0) {
        this._warnT = 0.55;
        audio.play('zoneWarn');
      }
    }
    if (rv.fuse != null && rv.phase === 'playing') {
      const holder = [...this.players.values()].find((p) => p.it && !p.out);
      if (holder) {
        holder.model.potatoHeat = 1 - rv.fuse / (rv.fuseMax || 25);
        this._tickT = (this._tickT || 0) - dt;
        if (this._tickT <= 0) {
          this._tickT = Math.max(0.11, Math.min(1, rv.fuse / 12));
          audio.play('fuseTick', { pos: holder.renderPos, volume: holder.id === this.localId ? 1 : 0.75 });
        }
      }
    }
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
        case 'knocked':
          audio.play('knocked', { pos, ownerId: p.id });
          fx.burst({ x: pos.x, y: pos.y + 1, z: pos.z }, '#ff3df0', { count: 12, speed: 3, size: 0.16, life: 0.35, up: 1 });
          if (p.id === this.localId) this.game.cameraRig.shake(0.3);
          break;
        case 'grapple_end':
          if (p.id === this.localId) fx.dust(pos, 0.5);
          break;
        case 'ride':
          audio.play('rideStart', { pos, ownerId: p.id });
          if (p.id === this.localId) bus.emit('hud:feed', { kind: 'info', text: 'Wheee! Riding the slide' });
          break;
        case 'ride_end':
          audio.play('splash', { pos, ownerId: p.id, volume: 1 });
          fx.burst({ x: pos.x, y: pos.y + 0.3, z: pos.z }, '#9fe8ff', { count: 30, speed: 5, size: 0.22, life: 0.6, up: 3, grav: 9 });
          fx.ring(pos, '#bff3ff', 2.4, 0.45);
          if (p.id === this.localId) this.game.cameraRig.shake(0.2);
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
      p.model.setIt(p.it && !p.out, this.mode === 'infection' ? 'infection' : this.mode === 'hotpotato' ? 'potato' : null);
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
      // hide our own name tag; show others (not in a power outage: you only see glowing outlines)
      p.model.showName((p.id !== this.localId || this.attract) && !(this.events && this.events.active === 'blackout'));
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
    if (this.intro) {
      this.intro.update(dt, time);
      return;
    }
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
    } else if ((ev.type === 'it' || ev.type === 'infected') && this.mode === 'hotpotato') {
      const p = this.players.get(ev.id);
      if (!p) return;
      fx.becomeIt(p.renderPos, '#ff8a2f');
      if (ev.id === this.localId) {
        audio.play('becomeIt');
        bus.emit('hud:banner', { text: 'HOT POTATO!', sub: 'Tag someone before it blows!', color: '#ff8a2f' });
      } else if (ev.from === this.localId) {
        audio.play('escaped');
        bus.emit('hud:banner', { text: 'PASSED IT!', sub: `${p.name} has the potato — keep away`, color: '#3df5ff' });
      } else {
        bus.emit('hud:feed', { kind: 'info', text: `${p.name} has the potato` });
      }
    } else if (ev.type === 'exploded') {
      const p = this.players.get(ev.id);
      if (!p) return;
      const pos = p.renderPos;
      fx.burst({ x: pos.x, y: pos.y + 1.2, z: pos.z }, '#ff8a2f', { count: 60, speed: 11, size: 0.4, life: 0.8, up: 3 });
      fx.burst({ x: pos.x, y: pos.y + 1.2, z: pos.z }, '#ffd23d', { count: 40, speed: 7, size: 0.3, life: 0.6, up: 2 });
      fx.burst({ x: pos.x, y: pos.y + 0.6, z: pos.z }, '#3a3a40', { count: 26, speed: 3, size: 0.9, life: 1.4, up: 1.5, grav: -0.6 });
      fx.ring(pos, '#ff8a2f', 6, 0.5);
      audio.play('explode', { pos });
      const near = local && Math.hypot(local.renderPos.x - pos.x, local.renderPos.z - pos.z) < 14;
      this.game.cameraRig.shake(ev.id === this.localId ? 0.8 : near ? 0.45 : 0.15);
      if (ev.id === this.localId) {
        fx.flash('rgba(255,140,40,0.55)', 300);
        bus.emit('hud:banner', { text: 'BOOM!', sub: 'You held the potato too long — spectating', color: '#ff8a2f', big: true });
      } else {
        bus.emit('hud:banner', { text: 'BOOM!', sub: `${p.name} exploded`, color: '#ff8a2f' });
      }
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
        bus.emit('hud:banner', { text: ev.reason === 'zone' ? 'CAUGHT BY THE RING' : 'ELIMINATED', sub: 'Spectating — click / press Jump to switch player', color: '#9aa6b8' });
      } else if (ev.reason === 'zone') {
        bus.emit('hud:feed', { kind: 'info', text: `${p.name} was caught outside the ring` });
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
      case 'hotpotato':
        return local.out ? 'Spectating' : local.it ? 'You have the potato — tag someone NOW!' : 'Keep away from the potato';
      case 'zone':
        return local.out ? 'Spectating' : local.it ? 'Hunt the runners — the ring can\'t hurt you' : 'Stay inside the ring and away from IT';
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
    const ev = rv.mapEvent || null;
    const evActive = ev && (rv.time ?? 0) < ev.end ? ev : null;
    if (local && !local.out && rv.phase === 'playing' && !(evActive && evActive.kind === 'blackout' && rv.time >= evActive.start)) {
      // directional indicator (offline during a power outage: "radar down"): runners see the nearest IT; IT sees the nearest runner within 30m
      // cloaked players don't show up on the arrow (that's what the cloak is for)
      const pool = (local.it ? runners : its).filter((p) => !this.abilities.isCloaked(p));
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
      alive: [...this.players.values()].filter((p) => p.connected && !p.out).length,
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
      abilities: (local?.loadout || []).map((id, i) => (id ? {
        id,
        key: describeCode(settings.data.controls.bindings[i ? 'ability2' : 'ability1']?.[0]),
        cd: this.abilities.cooldown(local, id),
        max: this.cfg.abilities[id].cooldown,
      } : null)),
      dodgeAssist: !!settings.data.accessibility.dodgeAssist,
      mapEvent: evActive ? { name: this.cfg.mapEvents.events[evActive.kind].name, icon: EVENT_INFO[evActive.kind].icon, warning: rv.time < evActive.start, left: evActive.end - rv.time } : null,
      fuse: rv.fuse ?? null,
      fuseMax: rv.fuseMax ?? null,
      potatoRound: rv.potatoRound ?? null,
      zone: rv.zone && local ? {
        r: rv.zone.r,
        k: rv.zone.k,
        closingIn: Math.max(0, rv.zone.hold - (rv.time ?? 0)),
        dist: Math.max(0, Math.hypot(local.renderPos.x - rv.zone.x, local.renderPos.z - rv.zone.z) - rv.zone.r),
        outside: !local.out && !local.it && Math.hypot(local.renderPos.x - rv.zone.x, local.renderPos.z - rv.zone.z) > rv.zone.r,
        storm: rv.localStorm || 0,
        limit: rv.zone.limit,
        angle: Math.atan2(rv.zone.x - local.renderPos.x, -(rv.zone.z - local.renderPos.z)) + this.game.cameraRig.yaw,
      } : null,
      grappleOk: !!this.grappleTarget,
      scrambled: local && this.abilities.isScrambled(local) ? { left: this.abilities.scrambleLeft(local), hint: SCRAMBLE_HINT[local.scrambleMode] } : null,
      cloaked: !!local && this.abilities.isCloaked(local),
      coinsGrabbed: this.coins?.collected || 0,
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

  /** Crosshair ray for the grapple hook: a surface within range, or null. */
  findGrappleTarget(local) {
    const cam = this.game.camera;
    const dir = cam.getWorldDirection(this._gV || (this._gV = cam.position.clone()));
    const range = this.cfg.abilities.grapple.range;
    const hit = this.world.raycast(cam.position.x, cam.position.y, cam.position.z, dir.x, dir.y, dir.z, range + this.game.cameraRig.dist + 2, true);
    if (!hit) return null;
    const p = { x: cam.position.x + dir.x * hit.t, y: cam.position.y + dir.y * hit.t, z: cam.position.z + dir.z * hit.t };
    const c = local.ctrl.pos;
    const d = Math.hypot(p.x - c.x, p.y - (c.y + 1), p.z - c.z);
    if (d > range || d < 2.5) return null;
    // back off the surface a little so we hang just in front of it
    p.x -= dir.x * 0.4;
    p.y -= dir.y * 0.4;
    p.z -= dir.z * 0.4;
    return p;
  }

  dispose() {
    this.intro?.dispose();
    this.events?.dispose();
    this.zoneFx?.dispose();
    this.abilities.dispose();
    this.coins?.dispose();
    AFX.clear();
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
