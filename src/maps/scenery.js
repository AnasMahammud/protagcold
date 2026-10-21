// Sky, lighting and distant background for each map theme. Background geometry is cheap
// (instanced, unlit or simply lit) and never collides; it exists to make the world feel large.
import * as THREE from 'three';
import { texture } from './textures.js';
import { mulberry32 } from '../core/mathUtil.js';

export function buildScenery(map, quality, animated) {
  const g = new THREE.Group();
  g.name = 'scenery';
  const env = map.env || {};
  const rng = mulberry32(99);

  g.add(makeSky(env));
  const lights = makeLights(map, env, quality);
  g.add(lights);
  g.userData.sun = lights.userData.sun;

  if (map.theme === 'city') {
    g.add(makeSkyline(rng, quality, { inner: 70, outer: 260, count: 220, baseY: -60, night: true }));
    g.add(makeStars(rng));
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), cityGroundMaterial());
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -60;
    g.add(ground);
    const moon = new THREE.Mesh(new THREE.SphereGeometry(9, 24, 16), new THREE.MeshBasicMaterial({ color: '#fff4dd', fog: false }));
    moon.position.set(-180, 120, -260);
    g.add(moon);
    // slow-moving aircraft lights for life in the sky
    const plane = new THREE.Mesh(new THREE.SphereGeometry(0.8, 6, 4), new THREE.MeshBasicMaterial({ color: '#ff4040', fog: false }));
    g.add(plane);
    animated.push((dt, t) => {
      const a = t * 0.02;
      plane.position.set(Math.cos(a) * 240, 95, Math.sin(a) * 240);
      plane.visible = Math.sin(t * 5) > 0;
    });
  } else if (map.theme === 'docks') {
    g.add(makeSkyline(rng, quality, { inner: 150, outer: 320, count: 120, baseY: -2, night: false, silhouette: '#5a4a6a', arc: [-Math.PI, 0] }));
    g.add(makeHills(rng, '#6a5a6e', 260, 40));
    const sun = new THREE.Mesh(new THREE.CircleGeometry(16, 32), new THREE.MeshBasicMaterial({ color: '#ffe0a0', fog: false }));
    const sd = new THREE.Vector3(...env.sun).normalize();
    sun.position.copy(sd.multiplyScalar(380));
    sun.lookAt(0, 0, 0);
    g.add(sun);
  } else if (map.theme === 'training') {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ map: texture('grass'), roughness: 1 }));
    ground.material.map.repeat.set(150, 150);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    g.add(ground);
    g.add(makeHills(rng, '#6f9a6a', 200, 30));
    g.add(makeClouds(rng, animated));
  } else if (map.theme === 'arena') {
    // fully indoor: nothing visible outside the walls besides bleachers (decor)
  }
  return g;
}

function makeSky(env) {
  const [top, mid, bottom] = env.sky || ['#1a2a4a', '#5a7ab0', '#c0d8f0'];
  const sunDir = new THREE.Vector3(...(env.sun || [0, 1, 0])).normalize();
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color(top) },
      mid: { value: new THREE.Color(mid) },
      bottom: { value: new THREE.Color(bottom) },
      sunDir: { value: sunDir },
      sunColor: { value: new THREE.Color(env.sunColor || '#ffffff') },
    },
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position.z = gl_Position.w; }`,
    fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; uniform vec3 sunDir; uniform vec3 sunColor; varying vec3 vDir;
      void main(){
        float h = vDir.y;
        vec3 c = h > 0.0 ? mix(mid, top, smoothstep(0.0, 0.55, h)) : mix(mid, bottom, smoothstep(0.0, -0.25, h));
        c = mix(bottom, c, smoothstep(-0.05, 0.18, h + 0.05));
        float s = max(dot(normalize(vDir), sunDir), 0.0);
        c += sunColor * (pow(s, 64.0) * 0.6 + pow(s, 8.0) * 0.12);
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  });
  const sky = new THREE.Mesh(new THREE.SphereGeometry(500, 32, 16), mat);
  sky.name = 'sky';
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  return sky;
}

function makeLights(map, env, quality) {
  const g = new THREE.Group();
  const hemi = new THREE.HemisphereLight(env.ambient || '#8090b0', env.hemiGround || '#303030', env.ambientIntensity ?? 0.9);
  g.add(hemi);
  const sun = new THREE.DirectionalLight(env.sunColor || '#ffffff', env.sunIntensity ?? 2);
  const dir = new THREE.Vector3(...(env.sun || [0.3, 1, 0.2])).normalize();
  const [x0, z0, x1, z1] = map.bounds;
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const half = Math.max(x1 - x0, z1 - z0) / 2 + 6;
  sun.position.set(cx + dir.x * 120, dir.y * 120, cz + dir.z * 120);
  sun.target.position.set(cx, 0, cz);
  sun.castShadow = !!quality.shadows;
  if (quality.shadows) {
    sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
    const cam = sun.shadow.camera;
    cam.left = -half * 1.2; cam.right = half * 1.2; cam.top = half * 1.2; cam.bottom = -half * 1.2;
    cam.near = 10; cam.far = 300;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
  }
  g.add(sun, sun.target);
  g.userData.sun = sun;
  return g;
}

function makeSkyline(rng, quality, { inner, outer, count, baseY, night, silhouette, arc }) {
  const n = Math.round(count * Math.min(1, quality.decorDensity + 0.2));
  const geo = new THREE.BoxGeometry(1, 1, 1);
  geo.translate(0, 0.5, 0);
  let mat;
  if (night) {
    const tex = texture('windows', { base: '#151a28', lit: 0.35, size: 256 });
    tex.repeat.set(1, 1);
    mat = new THREE.MeshStandardMaterial({ color: '#7a86a8', map: tex, emissiveMap: tex, emissive: new THREE.Color('#ffffff'), emissiveIntensity: 0.65, roughness: 0.8 });
  } else {
    mat = new THREE.MeshBasicMaterial({ color: silhouette });
  }
  const inst = new THREE.InstancedMesh(geo, mat, n);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  for (let i = 0; i < n; i++) {
    const a = arc ? arc[0] + rng() * (arc[1] - arc[0]) : rng() * Math.PI * 2;
    const r = inner + Math.pow(rng(), 0.7) * (outer - inner);
    const w = 8 + rng() * 18;
    const d = 8 + rng() * 18;
    const h = (night ? 40 : 10) + rng() * (night ? 120 : 45) * (1 - (r - inner) / (outer - inner) * 0.4);
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * Math.PI);
    m.compose(new THREE.Vector3(Math.cos(a) * r, baseY, Math.sin(a) * r), q, new THREE.Vector3(w, h, d));
    inst.setMatrixAt(i, m);
  }
  inst.frustumCulled = false;
  const g = new THREE.Group();
  g.add(inst);
  if (night) {
    // red aviation lights on the tallest towers
    const beacon = new THREE.InstancedMesh(new THREE.SphereGeometry(0.9, 6, 4), new THREE.MeshBasicMaterial({ color: '#ff2a2a', fog: false }), 30);
    for (let i = 0; i < 30; i++) {
      const a = rng() * Math.PI * 2, r = inner + rng() * (outer - inner);
      m.makeTranslation(Math.cos(a) * r, baseY + 130 + rng() * 40, Math.sin(a) * r);
      beacon.setMatrixAt(i, m);
    }
    g.add(beacon);
  }
  return g;
}

function makeStars(rng) {
  const n = 900;
  const pos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = rng() * Math.PI * 2;
    const v = Math.acos(rng() * 0.9 + 0.1 - 0.0);
    pos[i * 3] = Math.sin(v) * Math.cos(u) * 450;
    pos[i * 3 + 1] = Math.cos(v) * 450;
    pos[i * 3 + 2] = Math.sin(v) * Math.sin(u) * 450;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const pts = new THREE.Points(geo, new THREE.PointsMaterial({ color: '#cfd8ff', size: 1.4, sizeAttenuation: false, fog: false }));
  pts.frustumCulled = false;
  return pts;
}

function makeHills(rng, color, radius, count) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true });
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rng() * 0.1;
    const r = radius + rng() * 80;
    const h = 20 + rng() * 50;
    const hill = new THREE.Mesh(new THREE.ConeGeometry(30 + rng() * 40, h, 6), mat);
    hill.position.set(Math.cos(a) * r, h / 2 - 6, Math.sin(a) * r);
    g.add(hill);
  }
  return g;
}

function makeClouds(rng, animated) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 1, flatShading: true, transparent: true, opacity: 0.92 });
  const geo = new THREE.IcosahedronGeometry(6, 0);
  for (let i = 0; i < 18; i++) {
    const c = new THREE.Group();
    for (let k = 0; k < 4; k++) {
      const p = new THREE.Mesh(geo, mat);
      p.position.set(k * 7 - 10, rng() * 3, rng() * 5);
      p.scale.set(1 + rng(), 0.6 + rng() * 0.4, 1 + rng() * 0.5);
      c.add(p);
    }
    const a = rng() * Math.PI * 2, r = 120 + rng() * 150;
    c.position.set(Math.cos(a) * r, 55 + rng() * 40, Math.sin(a) * r);
    g.add(c);
  }
  animated.push((dt) => {
    g.rotation.y += dt * 0.004;
  });
  return g;
}

let _cityGround = null;
function cityGroundMaterial() {
  if (_cityGround) return _cityGround;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const x = c.getContext('2d');
  x.fillStyle = '#07080f';
  x.fillRect(0, 0, 256, 256);
  x.fillStyle = '#ffb35a';
  for (let i = 0; i < 256; i += 64) {
    x.fillRect(i, 0, 3, 256);
    x.fillRect(0, i, 256, 3);
  }
  x.fillStyle = '#ff5ad0';
  for (let i = 0; i < 40; i++) x.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(24, 24);
  t.colorSpace = THREE.SRGBColorSpace;
  _cityGround = new THREE.MeshBasicMaterial({ map: t });
  return _cityGround;
}
