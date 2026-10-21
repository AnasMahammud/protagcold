// Full-screen post effect used by the perfect-dodge cinematic: colour inversion with a
// cyan/magenta "negative" tint, expanding shockwave ripple, radial chromatic aberration, zoom
// blur, scanline glitch, vignette and flash. It runs AFTER tone mapping (display colours), so
// the inversion looks the same on every graphics preset. Costs nothing while idle (disabled).
import * as THREE from 'three';
import { ShaderPass } from '../../vendor/three/addons/postprocessing/ShaderPass.js';

const ScreenFxShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTime: { value: 0 },
    uAspect: { value: 1 },
    uCenter: { value: new THREE.Vector2(0.5, 0.5) },
    uInvert: { value: 0 },
    uTint: { value: 0 },
    uChroma: { value: 0 },
    uZoom: { value: 0 },
    uRipple: { value: 0 },
    uRippleR: { value: 0 },
    uRipple2: { value: 0 },
    uRippleR2: { value: 0 },
    uGlitch: { value: 0 },
    uVignette: { value: 0 },
    uFlash: { value: 0 },
    uDesat: { value: 0 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime, uAspect, uInvert, uTint, uChroma, uZoom, uRipple, uRippleR, uRipple2, uRippleR2, uGlitch, uVignette, uFlash, uDesat;
    uniform vec2 uCenter;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
    float ringWave(float dist, float r, float strength) {
      float k = r - dist;
      return exp(-k * k * 380.0) * strength;
    }
    void main() {
      vec2 uv = vUv;
      // digital glitch: random horizontal slices jump sideways
      if (uGlitch > 0.001) {
        float band = floor(uv.y * 28.0);
        float frame = floor(uTime * 24.0);
        if (hash(vec2(band, frame)) > 1.0 - 0.22 * uGlitch) uv.x += (hash(vec2(band, frame + 7.0)) - 0.5) * 0.09 * uGlitch;
      }
      vec2 d = uv - uCenter;
      d.x *= uAspect;
      float dist = length(d);
      vec2 dir = dist > 1e-4 ? d / dist : vec2(0.0);
      float wave = ringWave(dist, uRippleR, uRipple) + ringWave(dist, uRippleR2, uRipple2);
      vec2 off = dir * wave * 0.04;
      off.x /= uAspect;
      uv -= off;
      // zoom blur towards the player + per-channel chromatic split
      vec2 toC = uCenter - uv;
      vec2 ca = (uv - uCenter) * uChroma * 0.035;
      vec3 col = vec3(0.0);
      for (int i = 0; i < 8; i++) {
        vec2 suv = uv + toC * (float(i) / 7.0) * uZoom * 0.14;
        col.r += texture2D(tDiffuse, suv + ca).r;
        col.g += texture2D(tDiffuse, suv).g;
        col.b += texture2D(tDiffuse, suv - ca).b;
      }
      col /= 8.0;
      float lum = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(lum), uDesat);
      // photographic negative with an electric cyan/magenta grade
      vec3 inv = vec3(1.0) - col;
      inv = mix(inv, inv * vec3(0.72, 1.06, 1.3) + vec3(0.05, 0.0, 0.08), uTint);
      col = mix(col, inv, uInvert);
      // glowing shock rings + scanlines + vignette + flash
      col += mix(vec3(0.35, 0.95, 1.0), vec3(1.0, 0.3, 0.9), uInvert) * wave * 0.7;
      col *= 1.0 - uGlitch * 0.1 * (0.5 + 0.5 * sin(vUv.y * 820.0 + uTime * 40.0));
      float v = smoothstep(0.32, 1.05, length((vUv - 0.5) * vec2(uAspect, 1.0)));
      col *= 1.0 - v * uVignette;
      col = mix(col, vec3(1.0), clamp(uFlash, 0.0, 1.0));
      gl_FragColor = vec4(col, 1.0);
    }`,
};

export function createScreenFx() {
  const pass = new ShaderPass(ScreenFxShader);
  pass.enabled = false;
  const u = pass.uniforms;
  return {
    pass,
    u,
    /** true while any effect parameter is non-zero */
    get active() {
      return u.uInvert.value > 0.001 || u.uChroma.value > 0.001 || u.uZoom.value > 0.001 || u.uRipple.value > 0.001 || u.uRipple2.value > 0.001 ||
        u.uGlitch.value > 0.001 || u.uVignette.value > 0.001 || u.uFlash.value > 0.001 || u.uDesat.value > 0.001;
    },
    reset() {
      for (const k of ['uInvert', 'uTint', 'uChroma', 'uZoom', 'uRipple', 'uRippleR', 'uRipple2', 'uRippleR2', 'uGlitch', 'uVignette', 'uFlash', 'uDesat']) u[k].value = 0;
    },
  };
}
