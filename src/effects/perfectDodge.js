// Perfect-dodge cinematic director.
//   hero   - YOU perfectly dodged: time slows (offline), the screen inverts into a neon negative,
//            shockwaves ripple out from you, afterimages trail your dodge, the camera sweeps
//            around you, then time snaps back with a flash and the tagger is left stunned.
//   victim - you were IT and got outplayed: a short glitch hit and "OUTPLAYED".
//   world  - someone else did it: rings, afterimages and stars so everyone sees what happened.
// All timings run on REAL time so the slow-motion itself never slows the effect down.
import * as THREE from 'three';
import { audio } from '../audio/audio.js';
import { bus } from '../core/events.js';
import { settings } from '../core/settings.js';
import { clamp, smoothstep } from '../core/mathUtil.js';

const CYAN = '#3df5ff';
const MAGENTA = '#ff3df0';

export class PerfectDodgeDirector {
  constructor(game) {
    this.game = game;
    this.cur = null; // the running hero/victim cinematic (only one at a time)
    this.ghosts = [];
    this.pulseState = null;
    // Afterimage materials are pooled and never disposed, so their shader is compiled exactly
    // once (in prewarm) instead of stalling the first frame of a perfect dodge.
    this.ghostPool = [];
    for (let i = 0; i < 12; i++) {
      const m = new THREE.MeshBasicMaterial({ color: CYAN, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
      m.toneMapped = false;
      this.ghostPool.push({ mat: m, busy: false });
    }
  }

  /**
   * Compile everything the cinematic needs BEFORE it is needed: the screen-effect composer and
   * shader and the afterimage material. Called while a match loads (fixes the first-use hitch).
   */
  prewarm() {
    const g = this.game;
    const u = g.screenFx.u;
    // an afterimage in view + the effect pass "active" for one real render
    const tmp = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), this.ghostPool[0].mat);
    tmp.position.copy(g.camera.position).add(new THREE.Vector3(0, 0, -2).applyQuaternion(g.camera.quaternion));
    tmp.frustumCulled = false;
    g.scene.add(tmp);
    u.uVignette.value = 0.01;
    g._render(0);
    g.screenFx.reset();
    g.renderer.compile(g.scene, g.camera);
    g.scene.remove(tmp);
    tmp.geometry.dispose();
  }

  /** Short screen punch for abilities (only when no cinematic is running). */
  pulse({ chroma = 0, zoom = 0, ms = 200 } = {}) {
    if (this.cur || settings.data.accessibility.reduceFlashing) return;
    this.pulseState = { t: 0, dur: ms / 1000, chroma, zoom };
  }

  get busy() {
    return !!this.cur;
  }

  /**
   * @param o { session, dodger: Player, tagger: Player, kind: 'hero'|'victim'|'world', slowmo: bool, duration }
   */
  play(o) {
    const fx = this.game.effects;
    const pos = o.dodger.renderPos;
    // every kind: shock rings, shards and a few afterimages at the dodger
    fx.ring(pos, CYAN, 4.5, 0.55);
    fx.ring(pos, MAGENTA, 3.0, 0.4);
    fx.burst({ x: pos.x, y: pos.y + 1, z: pos.z }, CYAN, { count: 30, speed: 7, size: 0.22, life: 0.7, up: 1.5 });
    fx.burst({ x: pos.x, y: pos.y + 1, z: pos.z }, MAGENTA, { count: 20, speed: 5, size: 0.18, life: 0.6, up: 1 });
    if (o.kind === 'world') {
      for (let i = 0; i < 3; i++) setTimeout(() => this._ghost(o.dodger, i % 2 ? MAGENTA : CYAN, 0.7), i * 70);
      audio.play('timeResume', { pos, volume: 0.6 });
      bus.emit('hud:feed', { kind: 'info', text: `${o.dodger.name} perfect-dodged ${o.tagger?.name ?? 'IT'}!` });
      return;
    }
    if (this.cur) this._finish(true);
    const reduce = settings.data.accessibility.reduceFlashing;
    this.cur = { ...o, t: 0, released: false, reduce, ghostT: 0, ghosts: 0, duration: o.duration };
    if (o.kind === 'hero') {
      audio.play('perfectDodge');
      bus.emit('hud:perfect', { title: 'PERFECT DODGE', sub: o.slowmo ? 'Time slows down…' : 'Untouchable!', kind: 'hero', ms: o.duration * 1000 });
      fx.burst({ x: pos.x, y: pos.y + 1.2, z: pos.z }, '#ffffff', { count: 40, speed: 2.5, size: 0.12, life: 2.2, up: 0.6, grav: -0.3, spread: 1.4 });
    } else {
      audio.play('outplayed');
      bus.emit('hud:perfect', { title: 'OUTPLAYED', sub: `${o.dodger.name} perfect-dodged you`, kind: 'victim', ms: o.duration * 1000 });
      this.game.cameraRig.shake(0.5);
    }
  }

  update(dt) {
    this._updateGhosts(dt);
    const c = this.cur;
    if (!c && this.pulseState) {
      const ps = this.pulseState;
      ps.t += dt;
      const k = Math.max(0, 1 - ps.t / ps.dur);
      const u = this.game.screenFx.u;
      u.uCenter.value.set(0.5, 0.5);
      u.uChroma.value = ps.chroma * k;
      u.uZoom.value = ps.zoom * k;
      if (k <= 0) {
        this.pulseState = null;
        this.game.screenFx.reset();
      }
    }
    if (!c) return;
    c.t += dt;
    const T = c.duration;
    const t = c.t;
    const u = this.game.screenFx.u;
    const rig = this.game.cameraRig;
    const session = c.session;
    if (session?.disposed) {
      this._finish(true);
      return;
    }
    // keep the effects centred on the dodger's head on screen
    const p = c.dodger.renderPos;
    this.game.screenPoint({ x: p.x, y: p.y + 1.2, z: p.z }, u.uCenter.value);
    u.uCenter.value.x = clamp(u.uCenter.value.x, 0.05, 0.95);
    u.uCenter.value.y = clamp(u.uCenter.value.y, 0.05, 0.95);

    if (c.kind === 'hero') {
      const releaseAt = T - 0.38;
      const fIn = smoothstep(clamp(t / 0.1, 0, 1));
      const hold = t < releaseAt;
      const k = hold ? fIn : 1 - smoothstep(clamp((t - releaseAt) / 0.3, 0, 1));
      // time: ramp into slow motion, hold, snap back
      if (c.slowmo && session) session.timeScale = 1 - (1 - this.game.cfg.perfectDodge.slowmo) * (hold ? fIn : k);
      audio.setSlowmo(c.slowmo ? 0.85 * k : 0.4 * k);
      // screen: negative + chroma + zoom blur + vignette, two shockwaves (start and release)
      const inv = c.reduce ? 0.55 : 1;
      u.uInvert.value = inv * k;
      u.uTint.value = k;
      u.uChroma.value = (hold ? 1.4 - 0.7 * smoothstep(clamp(t / 0.6, 0, 1)) : 0.9) * k;
      u.uZoom.value = (hold ? 0.9 - 0.7 * smoothstep(clamp(t / 0.5, 0, 1)) : 0.6) * k;
      u.uVignette.value = 0.75 * k;
      u.uRippleR.value = t * 2.4;
      u.uRipple.value = Math.max(0, 1 - t / 0.75);
      u.uGlitch.value = c.reduce ? 0 : Math.max(0, 1 - t / 0.25) + (hold ? 0.12 : Math.max(0, 1 - (t - releaseAt) / 0.3));
      u.uFlash.value = c.reduce ? 0 : Math.max(0, 0.65 - t * 4);
      // camera: push in, slow orbital sweep, dutch tilt
      rig.cine.zoom = k;
      rig.cine.orbit = 0.85 * smoothstep(clamp(t / T, 0, 1)) * (hold ? 1 : k);
      rig.cine.roll = 0.1 * k;
      rig.cine.fov = -10 * k;
      rig.cine.lift = 0.12 * k;
      // afterimages along the dodge path
      c.ghostT -= dt;
      if (t < 0.6 && c.ghostT <= 0 && c.ghosts < 8) {
        c.ghostT = 0.07;
        this._ghost(c.dodger, c.ghosts % 2 ? MAGENTA : CYAN, 1.1);
        c.ghosts++;
      }
      // release: time snaps back with a flash and a second shockwave
      if (!c.released && t >= releaseAt) {
        c.released = true;
        audio.play('timeResume');
        if (!c.reduce) u.uFlash.value = 0.8;
        c.releaseT = 0;
        const tp = c.tagger?.renderPos;
        if (tp) this.game.effects.ring(tp, '#ffe066', 2.5, 0.5);
      }
      if (c.released) {
        c.releaseT += dt;
        u.uRippleR2.value = c.releaseT * 2.8;
        u.uRipple2.value = Math.max(0, 1 - c.releaseT / 0.5);
        if (!c.reduce) u.uFlash.value = Math.max(0, 0.8 - c.releaseT * 5);
      }
    } else {
      // victim: quick glitch hit
      const k = 1 - smoothstep(clamp(t / T, 0, 1));
      u.uGlitch.value = c.reduce ? 0 : k;
      u.uChroma.value = 1.2 * k;
      u.uInvert.value = (c.reduce ? 0.2 : 0.45) * Math.max(0, 1 - t / 0.25);
      u.uVignette.value = 0.6 * k;
      u.uDesat.value = 0.5 * k;
      u.uRippleR.value = t * 2;
      u.uRipple.value = 0.6 * k;
    }
    if (t >= T) this._finish(false);
  }

  _finish(aborted) {
    const c = this.cur;
    this.cur = null;
    bus.emit('hud:perfectEnd');
    this.game.screenFx.reset();
    const rig = this.game.cameraRig;
    rig.cine.zoom = rig.cine.orbit = rig.cine.roll = rig.cine.fov = rig.cine.lift = 0;
    audio.setSlowmo(0);
    if (c?.session) c.session.timeScale = 1;
    if (!c || aborted) return;
    if (c.kind === 'hero') {
      const pd = this.game.cfg.perfectDodge;
      audio.play('boost');
      if (c.tagger) audio.play('stunned', { pos: c.tagger.renderPos });
      bus.emit('hud:banner', { text: `+${pd.boostTime}s SPEED`, sub: `${c.tagger?.name ?? 'IT'} is stunned — go go go!`, color: CYAN, ms: 1600 });
    } else {
      audio.play('stunned');
    }
  }

  _ghost(player, color, life) {
    this.spawnGhost(player, color, life);
  }

  /** Afterimage of a player's current pose (optionally left behind at another position). */
  spawnGhost(player, color, life, atPos = null) {
    if (!player?.model || player.model.ghost) return;
    const slot = this.ghostPool.find((s) => !s.busy);
    if (!slot) return; // plenty already on screen
    slot.busy = true;
    slot.mat.color.set(color);
    slot.mat.opacity = 0.55;
    const geo = player.model.bakePose();
    const mesh = new THREE.Mesh(geo, slot.mat);
    if (atPos) mesh.position.set(atPos.x - player.renderPos.x, atPos.y - player.renderPos.y, atPos.z - player.renderPos.z);
    mesh.frustumCulled = false;
    this.game.scene.add(mesh);
    this.ghosts.push({ obj: mesh, slot, t: 0, life });
  }

  _updateGhosts(dt) {
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      const gh = this.ghosts[i];
      gh.t += dt;
      const k = gh.t / gh.life;
      gh.slot.mat.opacity = 0.55 * (1 - k);
      if (k >= 1) this._dropGhost(i);
    }
  }

  _dropGhost(i) {
    const gh = this.ghosts[i];
    this.game.scene.remove(gh.obj);
    gh.obj.geometry.dispose();
    gh.slot.busy = false;
    this.ghosts.splice(i, 1);
  }

  stop() {
    if (this.cur) this._finish(true);
    this.pulseState = null;
    while (this.ghosts.length) this._dropGhost(this.ghosts.length - 1);
  }
}
