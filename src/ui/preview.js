// Live 3D character preview for the customisation screen (its own small renderer).
import * as THREE from 'three';
import { CharacterModel, EMOTE_TIME } from '../player/characterModel.js';
import { MS } from '../movement/controller.js';

export class CharacterPreview {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
    this.camera.position.set(0, 1.35, 5.2);
    this.camera.lookAt(0, 1.0, 0);
    this.scene.add(new THREE.HemisphereLight('#bcd2ff', '#2a2230', 1.4));
    const key = new THREE.DirectionalLight('#ffffff', 2.2);
    key.position.set(2, 4, 3);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight('#ff5a3d', 2.0);
    rim.position.set(-3, 2, -3);
    this.scene.add(rim);
    const floor = new THREE.Mesh(new THREE.CircleGeometry(1.3, 40), new THREE.MeshStandardMaterial({ color: '#1a2236', roughness: 0.6 }));
    floor.rotation.x = -Math.PI / 2;
    this.scene.add(floor);
    const ringMat = new THREE.MeshBasicMaterial({ color: '#3df5ff' });
    ringMat.toneMapped = false;
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.25, 1.3, 48), ringMat);
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.002;
    this.scene.add(ring);
    this.model = null;
    this.yaw = 0.4;
    this.dragging = false;
    this.running = false;
    this.mode = 'idle';
    this.time = 0;
    this.last = performance.now();
    canvas.addEventListener('pointerdown', (e) => {
      this.dragging = true;
      this.lx = e.clientX;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!this.dragging) return;
      this.yaw += (e.clientX - this.lx) * 0.01;
      this.lx = e.clientX;
    });
    canvas.addEventListener('pointerup', () => (this.dragging = false));
  }

  setCosmetics(c) {
    if (!this.model) {
      this.model = new CharacterModel(c);
      this.scene.add(this.model.root);
    } else {
      this.model.applyCosmetics(c);
    }
  }

  setMode(mode) {
    this.mode = mode;
    if (!this.model) return;
    if (EMOTE_TIME[mode]) this.model.playEmote(mode);
    else this.model.emote = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = (t) => {
      if (!this.running) return;
      requestAnimationFrame(loop);
      const dt = Math.min(0.05, (t - this.last) / 1000);
      this.last = t;
      this.time += dt;
      this._resize();
      if (!this.dragging) this.yaw += dt * 0.35;
      if (this.model) {
        const run = this.mode === 'run';
        const sp = run ? 7.5 : 0;
        this.model.update({ x: 0, y: 0, z: 0, yaw: this.yaw, vx: -Math.sin(this.yaw) * sp, vy: 0, vz: -Math.cos(this.yaw) * sp, state: MS.GROUND, grounded: true, sprinting: false, scriptProgress: 0, groundY: 0 }, dt, this.time);
        if (this.model.emote && this.model.emoteT > EMOTE_TIME[this.model.emote] - 0.1) this.model.emoteT = 0; // loop it
      }
      this.renderer.render(this.scene, this.camera);
    };
    requestAnimationFrame(loop);
  }

  _resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    if (this.canvas.width !== Math.round(w * this.renderer.getPixelRatio())) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
  }

  stop() {
    this.running = false;
  }

  dispose() {
    this.stop();
    if (this.model) this.model.dispose();
    this.renderer.dispose();
  }
}
