// Shrinking Zone visuals: a tall translucent energy wall and a glowing ground ring that follow
// the rules' ring (centre + radius). Turns red while the local runner is outside it.
import * as THREE from 'three';

export class ZoneVisual {
  constructor(scene) {
    this.scene = scene;
    this.uniforms = { uTime: { value: 0 }, uDanger: { value: 0 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
      vertexShader: `varying vec2 vUv; varying float vY;
        void main() { vUv = uv; vY = position.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `uniform float uTime; uniform float uDanger; varying vec2 vUv; varying float vY;
        void main() {
          float h = clamp((vY + 6.0) / 52.0, 0.0, 1.0);
          float stripes = smoothstep(0.42, 0.5, abs(fract(vUv.x * 90.0 + uTime * 0.35) - 0.5));
          float bands = smoothstep(0.85, 1.0, fract(vY * 0.22 - uTime * 0.6));
          float a = (0.16 + stripes * 0.18 + bands * 0.22) * (1.0 - h) * (1.0 - h * 0.4);
          vec3 safe = vec3(0.24, 0.96, 1.0);
          vec3 danger = vec3(1.0, 0.25, 0.2);
          gl_FragColor = vec4(mix(safe, danger, uDanger) * a, a);
        }`,
    });
    this.group = new THREE.Group();
    this.group.name = 'zone';
    this.wall = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 52, 160, 1, true), mat);
    this.wall.position.y = 20;
    this.wall.frustumCulled = false;
    this.wall.renderOrder = 3;
    const ringMat = new THREE.MeshBasicMaterial({ color: '#3df5ff', transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false });
    ringMat.toneMapped = false;
    this.ringMat = ringMat;
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.993, 1, 160), ringMat);
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.06;
    this.ring.frustumCulled = false;
    this.group.add(this.wall, this.ring);
    scene.add(this.group);
  }

  update(dt, zone, outside) {
    this.group.position.set(zone.x, 0, zone.z);
    this.wall.scale.set(zone.r, 1, zone.r);
    this.ring.scale.set(zone.r, zone.r, 1);
    this.uniforms.uTime.value += dt;
    const u = this.uniforms.uDanger;
    u.value += ((outside ? 1 : 0) - u.value) * Math.min(1, dt * 4);
    this.ringMat.color.setRGB(0.24 + 0.76 * u.value, 0.96 - 0.7 * u.value, 1 - 0.8 * u.value);
  }

  dispose() {
    this.scene.remove(this.group);
    this.wall.geometry.dispose();
    this.wall.material.dispose();
    this.ring.geometry.dispose();
    this.ringMat.dispose();
  }
}
