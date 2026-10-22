// Subtle camera motion blur: a smear along how the view turned this frame (mouse / stick look,
// camera swings) plus a soft radial streak at the screen edges at high speed. The middle of the
// screen, where your character is, stays sharp. It runs after tone mapping (display colours) and
// only on frames that actually move, so a still camera costs nothing.
import * as THREE from 'three';
import { ShaderPass } from '../../vendor/three/addons/postprocessing/ShaderPass.js';

const TAPS = 8;

const MotionBlurShader = {
  uniforms: {
    tDiffuse: { value: null },
    uVel: { value: new THREE.Vector2() },
    uRadial: { value: 0 },
    uAspect: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 uVel;
    uniform float uRadial, uAspect;
    varying vec2 vUv;
    void main() {
      vec2 c = vUv - 0.5;
      vec2 ca = vec2(c.x * uAspect, c.y);
      float r = length(ca);
      // the player character lives in the middle of the screen: keep it crisp
      vec2 v = uVel * smoothstep(0.06, 0.34, r) + c * uRadial * smoothstep(0.18, 0.62, r);
      vec4 col = texture2D(tDiffuse, vUv);
      if (dot(v, v) < 1.0e-8) { gl_FragColor = col; return; }
      vec4 acc = vec4(0.0);
      for (int i = 0; i < ${TAPS}; i++) {
        float t = float(i) / ${TAPS - 1}.0 - 0.5; // taps centred on the pixel
        acc += texture2D(tDiffuse, clamp(vUv + v * t, 0.001, 0.999));
      }
      gl_FragColor = acc / ${TAPS}.0;
    }`,
};

export class MotionBlur {
  constructor() {
    this.pass = new ShaderPass(MotionBlurShader);
    this.pass.enabled = false;
    this.u = this.pass.uniforms;
    this.prevQ = new THREE.Quaternion();
    this.has = false;
    this.radial = 0;
    this._q = new THREE.Quaternion();
    this._d = new THREE.Vector3();
  }

  /**
   * Work out this frame's blur from the camera's rotation since the last frame and the player's
   * speed. Returns true when the pass needs to run.
   */
  update(camera, dt, speed, on) {
    const q = camera.getWorldQuaternion(this._q);
    const u = this.u;
    let active = false;
    if (on && this.has && dt > 0) {
      // where the current view centre was on the previous frame's screen
      const d = this._d.set(0, 0, -1).applyQuaternion(q).applyQuaternion(this.prevQ.clone().invert());
      const tv = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
      const nx = d.z < -1e-3 ? d.x / -d.z / (tv * camera.aspect) : 0;
      const ny = d.z < -1e-3 ? d.y / -d.z / tv : 0;
      // a fixed "shutter" of 1/150 s whatever the frame rate, kept slight
      const k = (1 / 150 / dt) * 0.5;
      let vx = -nx * k, vy = -ny * k;
      const len = Math.hypot(vx, vy);
      if (len > 0.2) vx = vy = 0; // a camera cut, not motion
      else if (len > 0.028) { vx *= 0.028 / len; vy *= 0.028 / len; }
      u.uVel.value.set(vx, vy);
      // radial streak once you're really moving (sprint 9.6 m/s, slides and pads go faster)
      const want = THREE.MathUtils.smoothstep(speed, 9, 17) * 0.045;
      this.radial += (want - this.radial) * Math.min(1, dt * 6);
      u.uRadial.value = this.radial;
      u.uAspect.value = camera.aspect;
      active = Math.hypot(vx, vy) > 0.0015 || this.radial > 0.002;
    } else {
      this.radial = 0;
    }
    this.prevQ.copy(q);
    this.has = true;
    this.pass.enabled = active;
    return active;
  }

  reset() {
    this.has = false;
    this.radial = 0;
    this.pass.enabled = false;
  }
}
