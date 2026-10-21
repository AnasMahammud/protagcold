// Game: owns the renderer, scene, camera, current map and the active match session.
// Sessions (offline LocalMatch, OnlineMatch, menu "attract" match) plug into one loop.
import * as THREE from 'three';
import { EffectComposer } from '../../vendor/three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from '../../vendor/three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from '../../vendor/three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from '../../vendor/three/addons/postprocessing/OutputPass.js';
import { settings } from '../core/settings.js';
import { bus } from '../core/events.js';
import { getConfig } from '../core/config.js';
import { CollisionWorld } from '../movement/collision.js';
import { buildMapVisuals } from '../maps/mapRenderer.js';
import { loadMap } from '../maps/mapLoader.js';
import { setMaxAnisotropy } from '../maps/textures.js';
import { NavGraph } from '../ai/navGraph.js';
import { CameraRig } from '../camera/cameraRig.js';
import { Effects } from '../effects/effects.js';
import { audio } from '../audio/audio.js';
import { createScreenFx } from '../effects/screenFx.js';
import { PerfectDodgeDirector } from '../effects/perfectDodge.js';

export class Game {
  constructor(canvas, input) {
    this.canvas = canvas;
    this.input = input;
    this.cfg = getConfig();
    this.quality = settings.quality();
    this._createRenderer();
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(settings.data.camera.fov, window.innerWidth / window.innerHeight, 0.1, 900);
    this.scene.add(this.camera);
    this.cameraRig = new CameraRig(this.camera, null);
    this.effects = new Effects(this.scene, this.quality);
    this.map = null; // { id, data, world, visuals, nav }
    this.session = null;
    this.time = 0;
    this.last = performance.now();
    this.lastRender = 0;
    this.fps = 0;
    this._fpsAcc = 0;
    this._fpsN = 0;
    this.onFrame = null; // UI hook (HUD)
    this.screenFx = createScreenFx();
    this.perfectFx = new PerfectDodgeDirector(this);
    this.fxComposer = null; // lightweight composer used for screen effects on presets without bloom
    this._setupComposer();
    window.addEventListener('resize', () => this.resize());
    bus.on('settings:changed', ({ path }) => {
      if (path.startsWith('graphics')) this.applyQuality();
      if (path === 'camera.fov') {
        this.camera.fov = settings.data.camera.fov;
        this.camera.updateProjectionMatrix();
      }
    });
    this.resize();
    requestAnimationFrame((t) => this._frame(t));
  }

  _createRenderer() {
    const r = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: this.quality.antialias, powerPreference: 'high-performance', stencil: false });
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    setMaxAnisotropy(Math.min(8, r.capabilities.getMaxAnisotropy()));
    this.renderer = r;
    this.glInfo = r.getContext().getParameter(r.getContext().VERSION);
  }

  _setupComposer() {
    this.composer = null;
    if (!this.quality.bloom) return;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const composer = new EffectComposer(this.renderer);
    composer.addPass(new RenderPass(this.scene, this.camera));
    const k = this.quality.bloomRes || 0.5;
    this.bloom = new UnrealBloomPass(new THREE.Vector2(Math.round(size.x * k), Math.round(size.y * k)), 0.55, 0.45, 0.82);
    composer.addPass(this.bloom);
    composer.addPass(new OutputPass());
    composer.addPass(this.screenFx.pass);
    this.composer = composer;
  }

  applyQuality() {
    const prevShadows = this.quality.shadows;
    this.quality = settings.quality();
    this.resize();
    this.renderer.shadowMap.enabled = this.quality.shadows;
    if (this.map?.visuals) {
      const sun = this.map.visuals.group.getObjectByName('scenery')?.userData.sun;
      if (sun) {
        sun.castShadow = this.quality.shadows;
        if (this.quality.shadows) {
          sun.shadow.mapSize.set(this.quality.shadowMapSize, this.quality.shadowMapSize);
          sun.shadow.map?.dispose();
          sun.shadow.map = null;
        }
      }
    }
    this._applyShadowMode();
    for (const p of this.session?.players?.values() || []) p.model.setCastShadows(this.characterShadows);
    if (prevShadows !== this.quality.shadows) {
      this.scene.traverse((o) => {
        if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => (m.needsUpdate = true));
      });
    }
    if (this.composer) {
      this.composer.passes = this.composer.passes.filter((p) => p !== this.screenFx.pass); // shared pass survives
      this.composer.dispose?.();
    }
    this._setupComposer();
    this.effects.budget = this.quality.particles;
  }

  /** Static (baked once) vs dynamic shadows, per quality preset. */
  _applyShadowMode() {
    const sm = this.renderer.shadowMap;
    sm.autoUpdate = !!this.quality.dynamicShadows;
    sm.needsUpdate = true;
    // re-bake shortly after load too, once every map mesh has been added
    if (!this.quality.dynamicShadows) setTimeout(() => (sm.needsUpdate = true), 100);
  }

  /** Characters only cast real shadows when shadows are dynamic (otherwise: blob shadows). */
  get characterShadows() {
    return !!(this.quality.shadows && this.quality.dynamicShadows);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const scale = settings.data.graphics.renderScale;
    const pr = Math.min((window.devicePixelRatio || 1) * scale, this.quality.maxPixelRatio * Math.max(1, scale));
    this.renderer.setPixelRatio(Math.max(0.4, pr));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    for (const c of [this.composer, this.fxComposer]) {
      if (!c) continue;
      c.setPixelRatio(this.renderer.getPixelRatio());
      c.setSize(w, h);
    }
  }

  /** Load (or reuse) a map. Returns the map record. */
  async loadMap(id) {
    if (this.map?.id === id) return this.map;
    // the running session (e.g. the menu background match) belongs to the old map: stop it first
    this.setSession(null);
    this.unloadMap();
    const data = await loadMap(id);
    const world = new CollisionWorld(data);
    const visuals = buildMapVisuals(data, this.scene, this.quality);
    this.map = { id, data, world, visuals, nav: null };
    this.cameraRig.setWorld(world);
    const env = data.env || {};
    this.scene.fog = new THREE.Fog(env.fog || '#000000', (env.fogNear || 60) * this.quality.drawDistance, (env.fogFar || 200) * this.quality.drawDistance);
    this.renderer.toneMappingExposure = env.exposure || 1;
    this._applyShadowMode();
    return this.map;
  }

  /** Navigation graph is built lazily (only offline/bot sessions need it). */
  getNav() {
    if (!this.map) return null;
    if (!this.map.nav) {
      this.map.nav = new NavGraph(this.map.world, this.cfg.movement);
      console.info(`[nav] ${this.map.id}: ${this.map.nav.nodes.length} nodes built in ${this.map.nav.buildMs.toFixed(0)} ms`);
    }
    return this.map.nav;
  }

  unloadMap() {
    if (!this.map) return;
    this.map.visuals.dispose();
    this.map = null;
  }

  setSession(session) {
    this.perfectFx?.stop();
    if (this.session && this.session !== session) this.session.dispose();
    this.session = session;
    this.effects.clear();
  }

  _frame(now) {
    requestAnimationFrame((t) => this._frame(t));
    const limit = settings.data.graphics.fpsLimit;
    if (limit > 0 && now - this.lastRender < 1000 / limit - 1.5) return;
    this.lastRender = now;
    let dt = (now - this.last) / 1000;
    this.last = now;
    if (dt > 0.1) dt = 0.1;
    if (dt <= 0) return;
    this.time += dt;
    this._fpsAcc += dt;
    this._fpsN++;
    if (this._fpsAcc >= 0.5) {
      this.fps = this._fpsN / this._fpsAcc;
      this._fpsAcc = 0;
      this._fpsN = 0;
    }

    try {
      if (this.session && this.map) this.session.frame(dt, this.time);
      else this.input.pollMenuNav(dt);
      this.perfectFx.update(dt);
      this.effects.update(dt);
      if (this.map) this.map.visuals.update(dt, this.time, this.session?.scoreboardInfo?.());
      audio.update(dt);
      if (this.onFrame) this.onFrame(dt);
    } catch (err) {
      console.error('[game] frame error', err);
      bus.emit('game:error', err);
    }
    this._render(dt);
  }

  _render(dt) {
    const fx = this.screenFx;
    const fxOn = fx.active;
    if (fxOn) {
      fx.u.uTime.value = this.time;
      fx.u.uAspect.value = this.camera.aspect;
    }
    if (this.composer) {
      fx.pass.enabled = fxOn;
      this.composer.render(dt);
    } else if (fxOn) {
      if (!this.fxComposer) {
        const c = new EffectComposer(this.renderer);
        c.addPass(new RenderPass(this.scene, this.camera));
        c.addPass(new OutputPass());
        c.setPixelRatio(this.renderer.getPixelRatio());
        c.setSize(window.innerWidth, window.innerHeight);
        this.fxComposer = c;
      }
      if (!this.fxComposer.passes.includes(fx.pass)) this.fxComposer.addPass(fx.pass);
      fx.pass.enabled = true;
      this.fxComposer.render(dt);
    } else {
      this.renderer.render(this.scene, this.camera);
    }
  }

  /** Screen position (0..1, origin bottom-left) of a world point, for centring screen effects. */
  screenPoint(pos, out = new THREE.Vector2()) {
    const v = new THREE.Vector3(pos.x, pos.y, pos.z).project(this.camera);
    return out.set(v.x * 0.5 + 0.5, v.y * 0.5 + 0.5);
  }

  stats() {
    const i = this.renderer.info;
    return { fps: this.fps, calls: i.render.calls, tris: i.render.triangles, geos: i.memory.geometries, tex: i.memory.textures };
  }
}
