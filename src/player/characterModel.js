// Original stylised "runner" character built from primitives, with a joint hierarchy and
// procedural animation. Every joint blends toward a target pose each frame, so transitions
// between run / sprint / jump / slide / vault / mantle / dodge / emotes are always smooth.
import * as THREE from 'three';
import { clamp, damp, lerp } from '../core/mathUtil.js';
import { MS } from '../movement/controller.js';
import { HATS } from '../progression/cosmetics.js';

const capsule = (r, len, seg = 8) => new THREE.CapsuleGeometry(r, len, 4, seg);

const sharedGeo = {
  pelvis: capsule(0.17, 0.12, 10),
  torso: capsule(0.2, 0.32, 12),
  chestPlate: new THREE.BoxGeometry(0.3, 0.2, 0.06),
  head: new THREE.SphereGeometry(0.175, 20, 14),
  visor: new THREE.SphereGeometry(0.178, 20, 10, -1.2, 2.4, 1.15, 0.75),
  visorLine: new THREE.TorusGeometry(0.168, 0.012, 6, 24, 2.2),
  upperArm: capsule(0.065, 0.2),
  foreArm: capsule(0.058, 0.18),
  hand: new THREE.SphereGeometry(0.07, 10, 8),
  thigh: capsule(0.09, 0.28),
  shin: capsule(0.078, 0.3),
  shoe: new THREE.BoxGeometry(0.13, 0.09, 0.27),
  sole: new THREE.BoxGeometry(0.135, 0.03, 0.28),
  blob: new THREE.CircleGeometry(0.42, 20),
  itRing: new THREE.RingGeometry(0.55, 0.72, 32),
};
for (const g of [sharedGeo.upperArm, sharedGeo.foreArm, sharedGeo.thigh, sharedGeo.shin]) {
  // pivot at the top end so rotations swing the limb from its joint
  g.computeBoundingBox();
  g.translate(0, -(g.boundingBox.max.y), 0);
}

let blobTex = null;
function blobTexture() {
  if (blobTex) return blobTex;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const x = c.getContext('2d');
  const g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(0,0,0,0.55)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  x.fillStyle = g;
  x.fillRect(0, 0, 64, 64);
  blobTex = new THREE.CanvasTexture(c);
  return blobTex;
}

class Joint {
  constructor(name, parent, x, y, z) {
    // a Bone, so the whole body can be ONE skinned mesh (see _buildBody)
    this.obj = new THREE.Bone();
    this.obj.name = name;
    this.obj.position.set(x, y, z);
    this.rest = new THREE.Vector3(x, y, z);
    this.parentJoint = parent.isBone ? parent.userData.joint : null;
    this.obj.userData.joint = this;
    parent.add(this.obj);
    this.cur = new THREE.Vector3();
    this.tgt = new THREE.Vector3();
  }

  /** Rest-pose position relative to the character's body (all joints unrotated). */
  restWorld(out = new THREE.Vector3()) {
    out.copy(this.rest);
    for (let j = this.parentJoint; j; j = j.parentJoint) out.add(j.rest);
    return out;
  }

  set(x, y = 0, z = 0) {
    this.tgt.set(x, y, z);
  }

  blend(lambda, dt) {
    this.cur.x = damp(this.cur.x, this.tgt.x, lambda, dt);
    this.cur.y = damp(this.cur.y, this.tgt.y, lambda, dt);
    this.cur.z = damp(this.cur.z, this.tgt.z, lambda, dt);
    this.obj.rotation.set(this.cur.x, this.cur.y, this.cur.z);
  }
}

// Material groups of the merged body: 0 = suit (standard, vertex colours), 1 = visor (shiny),
// 2 = glowing accents (unlit). One draw call each instead of one per body part.
const GROUP = { primary: 0, secondary: 0, dark: 0, sole: 0, hat: 0, visor: 1, accent: 2, hatGlow: 2 };
const FIXED = { dark: '#15171c', sole: '#f2f2f2', visor: '#0b0d12' };
const stripeGeo = new THREE.BoxGeometry(0.42, 0.035, 0.02);

export class CharacterModel {
  constructor(cosmetics) {
    this.root = new THREE.Group();
    this.root.name = 'character';
    this.body = new THREE.Group(); // gets yaw + bob
    this.root.add(this.body);

    this.mats = {
      body: new THREE.MeshStandardMaterial({ roughness: 0.58, metalness: 0.08, vertexColors: true }),
      visor: new THREE.MeshStandardMaterial({ roughness: 0.12, metalness: 0.85, vertexColors: true }),
      glow: new THREE.MeshBasicMaterial({ vertexColors: true }),
    };
    this.mats.glow.toneMapped = false;

    // --- skeleton
    this.hips = new Joint('hips', this.body, 0, 0.94, 0);
    this.spine = new Joint('spine', this.hips.obj, 0, 0.1, 0);
    this.neck = new Joint('neck', this.spine.obj, 0, 0.47, 0);
    this.head = new Joint('head', this.neck.obj, 0, 0.17, 0);
    this.shoulderL = new Joint('shoulderL', this.spine.obj, 0.255, 0.38, 0);
    this.shoulderR = new Joint('shoulderR', this.spine.obj, -0.255, 0.38, 0);
    this.elbowL = new Joint('elbowL', this.shoulderL.obj, 0, -0.33, 0);
    this.elbowR = new Joint('elbowR', this.shoulderR.obj, 0, -0.33, 0);
    this.hipL = new Joint('hipL', this.hips.obj, 0.11, -0.04, 0);
    this.hipR = new Joint('hipR', this.hips.obj, -0.11, -0.04, 0);
    this.kneeL = new Joint('kneeL', this.hipL.obj, 0, -0.44, 0);
    this.kneeR = new Joint('kneeR', this.hipR.obj, 0, -0.44, 0);
    this.ankleL = new Joint('ankleL', this.kneeL.obj, 0, -0.46, 0);
    this.ankleR = new Joint('ankleR', this.kneeR.obj, 0, -0.46, 0);
    this.joints = [this.hips, this.spine, this.neck, this.head, this.shoulderL, this.shoulderR, this.elbowL, this.elbowR, this.hipL, this.hipR, this.kneeL, this.kneeR, this.ankleL, this.ankleR];
    const bones = this.joints.map((j) => j.obj);
    const inverses = this.joints.map((j) => new THREE.Matrix4().makeTranslation(j.restWorld().negate()));
    this.skeleton = new THREE.Skeleton(bones, inverses);
    this.mesh = null; // the merged SkinnedMesh, (re)built by applyCosmetics
    this.castShadows = true;

    // blob shadow (always on: helps judge jumps even with shadows disabled)
    this.blob = new THREE.Mesh(sharedGeo.blob, new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false }));
    this.blob.rotation.x = -Math.PI / 2;
    this.blob.renderOrder = 1;
    this.root.add(this.blob);

    // IT indicators: floating crown-flame + ground ring (shape AND colour, colour-blind friendly)
    this.itGroup = new THREE.Group();
    this.itGroup.visible = false;
    const flameMat = new THREE.MeshBasicMaterial({ color: '#ff3b2f' });
    flameMat.toneMapped = false;
    const flame = new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), flameMat);
    flame.scale.set(1, 1.6, 1);
    this.itGroup.add(flame);
    for (let i = 0; i < 3; i++) {
      const spike = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.22, 6), flameMat);
      const a = (i / 3) * Math.PI * 2;
      spike.position.set(Math.cos(a) * 0.2, -0.05, Math.sin(a) * 0.2);
      this.itGroup.add(spike);
    }
    this.itGroup.position.y = 2.35;
    this.root.add(this.itGroup);
    const ringMat = new THREE.MeshBasicMaterial({ color: '#ff3b2f', transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false });
    ringMat.toneMapped = false;
    this.itRing = new THREE.Mesh(sharedGeo.itRing, ringMat);
    this.itRing.rotation.x = -Math.PI / 2;
    this.itRing.visible = false;
    this.itRing.renderOrder = 2;
    this.root.add(this.itRing);
    this.itGlow = null;

    // name tag
    this.nameSprite = null;
    this.nameText = '';

    this.phase = 0;
    this.landT = 0;
    this.tagLungeT = 0;
    this.emote = null;
    this.emoteT = 0;
    this.lean = 0;
    this.bob = 0;
    this.prevPhaseHalf = 0;
    this.onFootstep = null;
    this.itTime = 0;
    this.ghost = false;

    this.applyCosmetics(cosmetics || {});
  }

  /** Every body part: { joint, geometry, colour slot, local transform }. */
  _parts() {
    const P = [];
    const e = new THREE.Euler();
    const part = (j, geo, slot, pos = [0, 0, 0], rot = [0, 0, 0], scl = [1, 1, 1]) => P.push({
      j, geo, slot,
      matrix: new THREE.Matrix4().compose(new THREE.Vector3(...pos), new THREE.Quaternion().setFromEuler(e.set(...rot)), new THREE.Vector3(...scl)),
    });
    part(this.hips, sharedGeo.pelvis, 'secondary', [0, 0, 0], [0, 0, Math.PI / 2]);
    part(this.spine, sharedGeo.torso, 'primary', [0, 0.24, 0]);
    part(this.spine, sharedGeo.chestPlate, 'secondary', [0, 0.3, 0.18]);
    part(this.spine, stripeGeo, 'accent', [0, 0.3, 0.205], [0, 0, 0], [0.7, 1, 1]);
    part(this.head, sharedGeo.head, 'primary', [0, 0.02, 0]);
    part(this.head, sharedGeo.visor, 'visor', [0, 0.02, 0], [0, Math.PI / 2, 0]); // model faces +Z internally
    part(this.head, sharedGeo.visorLine, 'accent', [0, -0.005, 0], [Math.PI / 2, 0, Math.PI / 2 - 1.1]);
    for (const [sh, el] of [[this.shoulderL, this.elbowL], [this.shoulderR, this.elbowR]]) {
      part(sh, sharedGeo.upperArm, 'primary');
      part(el, sharedGeo.foreArm, 'secondary');
      part(el, sharedGeo.hand, 'dark', [0, -0.31, 0]);
    }
    for (const [hp, kn, an] of [[this.hipL, this.kneeL, this.ankleL], [this.hipR, this.kneeR, this.ankleR]]) {
      part(hp, sharedGeo.thigh, 'secondary');
      part(kn, sharedGeo.shin, 'primary');
      part(an, sharedGeo.shoe, 'dark', [0, 0.01, 0.05]);
      part(an, sharedGeo.sole, 'sole', [0, -0.04, 0.05]);
    }
    return P;
  }

  /**
   * Build the whole character (suit + hat) as ONE skinned mesh: every part is baked into the
   * rest pose and rigidly bound to its joint's bone, with its colour as a vertex colour.
   */
  _buildBody(c) {
    const colors = { primary: c.primary || '#ff5a3d', secondary: c.secondary || '#20242e', accent: c.accent || '#3df5ff', ...FIXED };
    const parts = this._parts();
    const temp = []; // hat geometries, disposed once merged
    // hat meshes become parts too (bound to the head), keeping each hat material's colour
    const hat = HATS[c.hat];
    if (hat && hat.build) {
      const slot = new THREE.Group();
      slot.position.y = 0.16;
      slot.add(hat.build(THREE, c));
      slot.updateMatrixWorld(true);
      slot.traverse((o) => {
        if (!o.isMesh) return;
        const m = Array.isArray(o.material) ? o.material[0] : o.material;
        parts.push({ j: this.head, geo: o.geometry, slot: m.isMeshBasicMaterial ? 'hatGlow' : 'hat', matrix: o.matrixWorld.clone(), color: `#${m.color.getHexString()}` });
        temp.push(o.geometry);
        m.dispose();
      });
    }
    const buckets = [[], [], []];
    for (const pt of parts) {
      const m = new THREE.Matrix4().makeTranslation(pt.j.restWorld()).multiply(pt.matrix);
      buckets[GROUP[pt.slot]].push({ geo: pt.geo, m, bone: this.joints.indexOf(pt.j), color: new THREE.Color(pt.color || colors[pt.slot]) });
    }
    const pos = [], nor = [], col = [], si = [], sw = [], idx = [];
    const groups = [];
    const v = new THREE.Vector3(), nm = new THREE.Matrix3();
    for (let gi = 0; gi < 3; gi++) {
      const start = idx.length;
      for (const b of buckets[gi]) {
        const base = pos.length / 3;
        const P = b.geo.attributes.position, N = b.geo.attributes.normal;
        nm.getNormalMatrix(b.m);
        for (let i = 0; i < P.count; i++) {
          v.fromBufferAttribute(P, i).applyMatrix4(b.m);
          pos.push(v.x, v.y, v.z);
          v.fromBufferAttribute(N, i).applyMatrix3(nm).normalize();
          nor.push(v.x, v.y, v.z);
          col.push(b.color.r, b.color.g, b.color.b);
          si.push(b.bone, 0, 0, 0);
          sw.push(1, 0, 0, 0);
        }
        if (b.geo.index) for (let i = 0; i < b.geo.index.count; i++) idx.push(base + b.geo.index.getX(i));
        else for (let i = 0; i < P.count; i++) idx.push(base + i);
      }
      groups.push([start, idx.length - start]);
    }
    for (const g of temp) g.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    g.setIndex(idx);
    groups.forEach(([s0, n], i) => g.addGroup(s0, n, i));
    const mesh = new THREE.SkinnedMesh(g, [this.mats.body, this.mats.visor, this.mats.glow]);
    mesh.name = 'body';
    mesh.bind(this.skeleton, new THREE.Matrix4()); // bound in the rest pose at the body's origin
    mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.0, 0), 1.7);
    mesh.castShadow = this.castShadows && !this.cloakOn;
    return mesh;
  }

  applyCosmetics(c) {
    this.cosmetics = c;
    if (this.mesh) {
      this.body.remove(this.mesh);
      this.mesh.geometry.dispose();
    }
    this.mesh = this._buildBody(c);
    this.body.add(this.mesh);
    this._matList = null;
  }

  /** Real shadow casting on/off (off on lower presets: the blob shadow is used instead). */
  setCastShadows(on) {
    this.castShadows = on;
    if (this.mesh && !this.cloakOn) this.mesh.castShadow = on;
  }

  setName(text, color = '#ffffff') {
    if (text === this.nameText && this.nameSprite) return;
    this.nameText = text;
    if (this.nameSprite) {
      this.root.remove(this.nameSprite);
      this.nameSprite.material.map.dispose();
      this.nameSprite.material.dispose();
    }
    const c = document.createElement('canvas');
    c.width = 256; c.height = 64;
    const x = c.getContext('2d');
    x.font = '700 30px "Segoe UI", system-ui, sans-serif';
    x.textAlign = 'center';
    x.textBaseline = 'middle';
    const w = Math.min(250, x.measureText(text).width + 24);
    x.fillStyle = 'rgba(8,10,18,0.55)';
    roundRect(x, 128 - w / 2, 12, w, 40, 12);
    x.fill();
    x.fillStyle = color;
    x.fillText(text, 128, 33);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mat = new THREE.SpriteMaterial({ map: tex, depthTest: true, transparent: true });
    this.nameSprite = new THREE.Sprite(mat);
    this.nameSprite.scale.set(1.3, 0.325, 1);
    this.nameSprite.position.y = 2.08;
    this.root.add(this.nameSprite);
  }

  showName(v) {
    if (this.nameSprite) this.nameSprite.visible = v;
  }

  /** kind: null (classic IT), 'infection' (green) or 'potato' (a lit bomb instead of the crown). */
  setIt(isIt, kind = null) {
    if (kind === true) kind = 'infection';
    this.isIt = isIt;
    this.itKind = kind;
    this._itVisibility();
    const col = kind === 'infection' ? '#7dff3d' : kind === 'potato' ? '#ff8a2f' : '#ff3b2f';
    this.itGroup.children.forEach((m) => m.material.color.set(col));
    this.itRing.material.color.set(col);
    this.mats.body.emissive.set(isIt ? col : '#000000');
    this.mats.body.emissiveIntensity = isIt ? 0.22 : 0;
  }

  _itVisibility() {
    const show = !!this.isIt && !this.cloakOn;
    const potato = this.itKind === 'potato';
    this.itGroup.visible = show && !potato;
    this.itRing.visible = show;
    if (potato || this.bomb) this._bomb().group.visible = show && potato;
  }

  /** Hot Potato: the bomb floating over the holder's head (built on first use). */
  _bomb() {
    if (this.bomb) return this.bomb;
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.SphereGeometry(0.24, 18, 12), new THREE.MeshStandardMaterial({ color: '#1c1c22', roughness: 0.35, metalness: 0.4, emissive: '#ff3b2f', emissiveIntensity: 0 }));
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.09, 10), new THREE.MeshStandardMaterial({ color: '#444a52', metalness: 0.7, roughness: 0.3 }));
    cap.position.y = 0.24;
    const wick = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.18, 6), new THREE.MeshStandardMaterial({ color: '#c9a227' }));
    wick.position.set(0.03, 0.34, 0);
    wick.rotation.z = -0.35;
    const sparkMat = new THREE.MeshBasicMaterial({ color: '#ffd23d' });
    sparkMat.toneMapped = false;
    const spark = new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), sparkMat);
    spark.position.set(0.07, 0.43, 0);
    g.add(body, cap, wick, spark);
    g.position.y = 2.42;
    g.visible = false;
    this.root.add(g);
    this.bomb = { group: g, body, spark };
    this.potatoHeat = 0;
    return this.bomb;
  }

  /** Dizzy stars orbiting the head (tagger stunned by a perfect dodge). */
  setStunned(on) {
    if (on === !!this.stunned) return;
    this.stunned = on;
    if (on && !this.stunStars) {
      const g = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ color: '#ffe066' });
      mat.toneMapped = false;
      const shape = new THREE.Shape();
      for (let i = 0; i < 10; i++) {
        const r = i % 2 ? 0.045 : 0.11;
        const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
        if (i === 0) shape.moveTo(Math.cos(a) * r, Math.sin(a) * r);
        else shape.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.03, bevelEnabled: false });
      for (let i = 0; i < 3; i++) {
        const star = new THREE.Mesh(geo, mat);
        star.userData.a = (i / 3) * Math.PI * 2;
        g.add(star);
      }
      g.position.y = 2.12;
      this.root.add(g);
      this.stunStars = g;
    }
    if (this.stunStars) this.stunStars.visible = on;
  }

  /** Every material on the body, hats included. */
  _allMats() {
    if (!this._matList) {
      const set = new Set();
      this.body.traverse((o) => {
        if (o.isMesh) for (const m of Array.isArray(o.material) ? o.material : [o.material]) set.add(m);
      });
      this._matList = [...set];
    }
    return this._matList;
  }

  setGhost(ghost) {
    // eliminated players / spectators render translucent
    if (ghost === this.ghost) return;
    this.ghost = ghost;
    for (const m of this._allMats()) {
      m.transparent = ghost || !!this.cloakOn;
      m.opacity = ghost ? 0.25 : 1;
      m.needsUpdate = true;
    }
    this.blob.visible = !ghost;
  }

  /** Cloak / hologram: alpha in 0..1, or null to turn it off. Hides name, IT marker and shadow. */
  setCloak(alpha) {
    const on = alpha != null;
    if (on !== !!this.cloakOn) {
      this.cloakOn = on;
      for (const m of this._allMats()) {
        m.transparent = on || this.ghost;
        m.depthWrite = !on;
        m.needsUpdate = true;
        if (!on) m.opacity = this.ghost ? 0.25 : 1;
      }
      this.blob.visible = !on && !this.ghost;
      this._itVisibility();
      if (this.nameSprite) this.nameSprite.material.opacity = on ? 0 : 1;
      this.mesh.castShadow = !on && this.castShadows;
    }
    if (on) for (const m of this._allMats()) m.opacity = alpha;
  }

  /**
   * The current pose baked into ONE world-space geometry (positions only). Afterimages use
   * this: one draw call per ghost instead of ~25 cloned meshes.
   */
  bakePose() {
    this.root.updateMatrixWorld(true);
    const m = this.mesh;
    const src = m.geometry;
    const count = src.attributes.position.count;
    const positions = new Float32Array(count * 3);
    const v = new THREE.Vector3();
    for (let i = 0; i < count; i++) {
      m.getVertexPosition(i, v).applyMatrix4(m.matrixWorld); // CPU skinning
      positions[i * 3] = v.x;
      positions[i * 3 + 1] = v.y;
      positions[i * 3 + 2] = v.z;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setIndex(new THREE.BufferAttribute(src.index.array.slice(), 1));
    geo.computeBoundingSphere();
    return geo;
  }

  playEmote(id) {
    this.emote = id;
    this.emoteT = 0;
  }

  lunge() {
    this.tagLungeT = 0.28;
  }

  /**
   * Update pose. `s` describes the simulated state:
   * { x, y, z, yaw, vx, vy, vz, state, grounded, sprinting, scriptProgress, frozen, groundY, dodgeSide }
   */
  update(s, dt, time) {
    this.root.position.set(s.x, s.y, s.z);
    this.body.rotation.y = s.yaw + Math.PI; // controller yaw 0 = -Z, model faces +Z
    const hs = Math.hypot(s.vx, s.vz);
    // local velocity (for dodge lean)
    const sin = Math.sin(s.yaw), cos = Math.cos(s.yaw);
    const fwd = -(s.vx * sin + s.vz * cos);
    const side = s.vx * cos - s.vz * sin;

    if (this.landT > 0) this.landT = Math.max(0, this.landT - dt);
    if (this.tagLungeT > 0) this.tagLungeT = Math.max(0, this.tagLungeT - dt);
    if (this.emote) {
      this.emoteT += dt;
      if (this.emoteT > 2.6 || hs > 1.5 || !s.grounded) this.emote = null;
    }

    let rootY = 0;
    let lambda = 16;
    const st = s.state;
    const J = this;

    if (st === MS.SLIDE) {
      rootY = -0.5;
      J.hips.set(-0.15, 0, 0);
      J.spine.set(-0.5, 0, 0.05);
      J.neck.set(0.4);
      J.head.set(-0.1);
      J.hipL.set(-1.35, 0, 0.05); J.kneeL.set(0.15);
      J.hipR.set(-0.6, 0, -0.1); J.kneeR.set(1.55);
      J.shoulderL.set(0.5, 0, 0.7); J.elbowL.set(-0.4);
      J.shoulderR.set(-1.1, 0, -0.25); J.elbowR.set(-0.2);
      J.ankleL.set(0.4); J.ankleR.set(0.2);
      lambda = 20;
    } else if (st === MS.VAULT) {
      const p = s.scriptProgress;
      rootY = Math.sin(p * Math.PI) * -0.15;
      J.hips.set(-0.2, 0, Math.sin(p * Math.PI) * 0.9);
      J.spine.set(0.5 * Math.sin(p * Math.PI), 0, 0);
      J.neck.set(0.3); J.head.set(0);
      J.hipL.set(-1.4, 0, 0.3); J.kneeL.set(1.9);
      J.hipR.set(-1.2, 0, 0.1); J.kneeR.set(1.7);
      J.shoulderL.set(-1.2 + p * 0.8, 0, 0.2); J.elbowL.set(-0.2);
      J.shoulderR.set(-2.4 + p * 1.6, 0, -0.3); J.elbowR.set(-0.2);
      J.ankleL.set(0); J.ankleR.set(0);
      lambda = 24;
    } else if (st === MS.MANTLE) {
      const p = s.scriptProgress;
      J.hips.set(-0.3 * (1 - p), 0, 0);
      J.spine.set(0.4 * (1 - p), 0, 0);
      J.neck.set(0.2); J.head.set(0);
      J.hipL.set(-1.6 * (1 - p) - 0.2, 0, 0); J.kneeL.set(2.0 * (1 - p) + 0.2);
      J.hipR.set(-0.9 * (1 - p), 0, 0); J.kneeR.set(1.4 * (1 - p));
      J.shoulderL.set(-2.8 + p * 2.6, 0, 0.25); J.elbowL.set(-0.3 - p * 0.5);
      J.shoulderR.set(-2.8 + p * 2.6, 0, -0.25); J.elbowR.set(-0.3 - p * 0.5);
      J.ankleL.set(0); J.ankleR.set(0);
      lambda = 22;
    } else if (st === MS.DODGE) {
      const dir = clamp(side / 8, -1, 1);
      rootY = -0.18;
      J.hips.set(-0.2, 0, -dir * 0.5);
      J.spine.set(0.35, 0, -dir * 0.3);
      J.neck.set(-0.1); J.head.set(0);
      J.hipL.set(-0.9, 0, 0.4); J.kneeL.set(1.3);
      J.hipR.set(-0.3, 0, -0.4); J.kneeR.set(0.9);
      J.shoulderL.set(-0.3, 0, 1.0); J.elbowL.set(-0.6);
      J.shoulderR.set(-0.3, 0, -1.0); J.elbowR.set(-0.6);
      J.ankleL.set(0.3); J.ankleR.set(0.3);
      lambda = 26;
    } else if (st === MS.RIDE) {
      // riding a water slide: lying back, feet first, arms up
      rootY = -0.55;
      J.hips.set(-0.35, 0, 0);
      J.spine.set(-0.75, 0, Math.sin(time * 3) * 0.08);
      J.neck.set(0.5); J.head.set(0.1);
      J.hipL.set(-1.45, 0, 0.12); J.kneeL.set(0.12);
      J.hipR.set(-1.45, 0, -0.12); J.kneeR.set(0.12);
      J.shoulderL.set(-2.7, 0, 0.35); J.elbowL.set(-0.25);
      J.shoulderR.set(-2.7, 0, -0.35); J.elbowR.set(-0.25);
      J.ankleL.set(0.5); J.ankleR.set(0.5);
      lambda = 14;
    } else if (st === MS.GRAPPLE) {
      // zipping along the rope: both arms reaching for the hook, legs trailing behind
      J.hips.set(0.35, 0, 0);
      J.spine.set(0.25, 0, 0);
      J.neck.set(-0.35); J.head.set(-0.1);
      J.hipL.set(0.3, 0, 0.1); J.kneeL.set(0.6);
      J.hipR.set(-0.4, 0, -0.1); J.kneeR.set(1.1);
      J.shoulderR.set(-2.9, 0, -0.15); J.elbowR.set(-0.1);
      J.shoulderL.set(-2.5, 0, 0.25); J.elbowL.set(-0.5);
      J.ankleL.set(0.5); J.ankleR.set(0.4);
      lambda = 18;
    } else if (!s.grounded) {
      const rising = s.vy > 1;
      const tuck = rising ? 1 : clamp(1 + s.vy / 10, 0, 1);
      J.hips.set(0.1, 0, 0);
      J.spine.set(0.15 + fwd * 0.012, 0, 0);
      J.neck.set(-0.1); J.head.set(0);
      J.hipL.set(-1.1 * tuck - 0.2, 0, 0.08); J.kneeL.set(1.6 * tuck + 0.2);
      J.hipR.set(-0.3 * tuck + 0.2, 0, -0.08); J.kneeR.set(0.7 * tuck + 0.3);
      J.shoulderL.set(-0.6 - (1 - tuck) * 1.2, 0, 0.5 + (1 - tuck) * 0.6); J.elbowL.set(-0.7);
      J.shoulderR.set(0.5 - (1 - tuck) * 1.6, 0, -0.5 - (1 - tuck) * 0.6); J.elbowR.set(-0.9);
      J.ankleL.set(0.3); J.ankleR.set(0.2);
      lambda = 10;
    } else if (this.emote && hs < 1.5) {
      this.poseEmote(time);
    } else if (hs > 0.4) {
      // locomotion: stride length grows with speed
      const sprint = clamp((hs - 7) / 3, 0, 1);
      const stride = lerp(1.1, 2.4, clamp(hs / 10, 0, 1));
      this.phase = (this.phase + (hs * dt) / stride) % 1;
      const a = this.phase * Math.PI * 2;
      const amp = clamp(hs / 7, 0.35, 1.0) * (0.75 + sprint * 0.25);
      const lean = clamp(hs / 10, 0, 1) * 0.32 + sprint * 0.08;
      J.hips.set(lean * 0.4, Math.sin(a) * 0.12 * amp, 0);
      J.spine.set(lean * 0.6, -Math.sin(a) * 0.22 * amp, 0);
      J.neck.set(-lean * 0.6); J.head.set(-lean * 0.2);
      const legA = 0.85 * amp, kneeA = 1.25 * amp;
      J.hipL.set(-Math.sin(a) * legA, 0, 0.03);
      J.hipR.set(Math.sin(a) * legA, 0, -0.03);
      J.kneeL.set(Math.max(0, Math.cos(a)) * kneeA + 0.15 + (Math.sin(a) < 0 ? 0.3 * amp : 0));
      J.kneeR.set(Math.max(0, -Math.cos(a)) * kneeA + 0.15 + (Math.sin(a) > 0 ? 0.3 * amp : 0));
      J.ankleL.set(Math.cos(a) * 0.3 * amp); J.ankleR.set(-Math.cos(a) * 0.3 * amp);
      const armA = 0.9 * amp + sprint * 0.3;
      J.shoulderL.set(Math.sin(a) * armA, 0, 0.12); J.elbowL.set(-1.2 - sprint * 0.3);
      J.shoulderR.set(-Math.sin(a) * armA, 0, -0.12); J.elbowR.set(-1.2 - sprint * 0.3);
      rootY = -Math.abs(Math.cos(a)) * 0.07 * amp + 0.03 * amp;
      // footsteps on each foot plant
      const half = this.phase < 0.5 ? 0 : 1;
      if (half !== this.prevPhaseHalf) {
        this.prevPhaseHalf = half;
        if (this.onFootstep) this.onFootstep(hs);
      }
      lambda = 18;
    } else {
      // idle: breathing + loose arms
      const b = Math.sin(time * 2.2);
      J.hips.set(0, 0, 0);
      J.spine.set(0.03 + b * 0.015, 0, 0);
      J.neck.set(0); J.head.set(0, Math.sin(time * 0.5) * 0.25, 0);
      J.hipL.set(0, 0, 0.05); J.kneeL.set(0.05);
      J.hipR.set(0, 0, -0.05); J.kneeR.set(0.05);
      J.ankleL.set(0); J.ankleR.set(0);
      J.shoulderL.set(0.05, 0, 0.12 + b * 0.02); J.elbowL.set(-0.2);
      J.shoulderR.set(0.05, 0, -0.12 - b * 0.02); J.elbowR.set(-0.2);
      rootY = b * 0.008;
      lambda = 8;
    }

    if (s.frozen) {
      // stunned new IT: wobble
      J.spine.tgt.z += Math.sin(time * 18) * 0.12;
      J.head.tgt.z += Math.sin(time * 14) * 0.25;
    }
    if (this.tagLungeT > 0) {
      const k = Math.sin((this.tagLungeT / 0.28) * Math.PI);
      J.shoulderR.tgt.set(-1.5 * k + J.shoulderR.tgt.x * (1 - k), 0, -0.1);
      J.elbowR.tgt.set(-0.1, 0, 0);
      J.spine.tgt.x += 0.25 * k;
    }
    if (this.landT > 0) {
      const k = this.landT / 0.22;
      rootY -= 0.22 * k * this.landImpact;
      J.kneeL.tgt.x += 0.7 * k * this.landImpact;
      J.kneeR.tgt.x += 0.7 * k * this.landImpact;
      J.hipL.tgt.x -= 0.45 * k * this.landImpact;
      J.hipR.tgt.x -= 0.45 * k * this.landImpact;
      J.spine.tgt.x += 0.25 * k * this.landImpact;
    }

    for (const j of this.joints) j.blend(lambda, dt);
    this.bob = damp(this.bob, rootY, 20, dt);
    this.hips.obj.position.y = 0.94 + this.bob;

    // blob shadow on the ground below
    const gy = s.groundY ?? s.y;
    const hAbove = Math.max(0, s.y - gy);
    this.blob.position.y = gy - s.y + 0.03;
    const bs = clamp(1 - hAbove / 8, 0.35, 1);
    this.blob.scale.setScalar(bs);
    this.blob.material.opacity = bs;
    this.itRing.position.y = gy - s.y + 0.04;

    if (this.stunned && this.stunStars) {
      this.stunT = (this.stunT || 0) + dt;
      for (const s of this.stunStars.children) {
        const a = s.userData.a + this.stunT * 5;
        s.position.set(Math.cos(a) * 0.32, Math.sin(this.stunT * 7 + s.userData.a) * 0.05, Math.sin(a) * 0.32);
        s.rotation.y = -a;
      }
    }
    if (this.itGroup.visible) {
      this.itTime += dt;
      this.itGroup.rotation.y = this.itTime * 3;
      this.itGroup.position.y = 2.38 + Math.sin(this.itTime * 4) * 0.06;
      const pulse = 1 + Math.sin(this.itTime * 6) * 0.08;
      this.itRing.scale.set(pulse, pulse, pulse);
    }
    if (this.bomb?.group.visible) {
      // the fuse burns: the spark flickers and the bomb glows faster as it runs out
      this.itTime += dt;
      const heat = this.potatoHeat || 0;
      const b = this.bomb;
      b.group.rotation.y = this.itTime * 1.5;
      b.group.position.y = 2.42 + Math.sin(this.itTime * 5) * 0.05;
      b.spark.scale.setScalar(0.7 + Math.random() * 0.8);
      b.body.material.emissiveIntensity = heat * (0.5 + 0.5 * Math.sin(this.itTime * (5 + heat * 22)));
      const pulse = 1 + Math.sin(this.itTime * (6 + heat * 14)) * 0.1;
      this.itRing.scale.set(pulse, pulse, pulse);
    }
  }

  poseEmote(time) {
    const J = this;
    const t = this.emoteT;
    J.hips.set(0, 0, 0); J.neck.set(0); J.head.set(0);
    J.kneeL.set(0.05); J.kneeR.set(0.05); J.ankleL.set(0); J.ankleR.set(0);
    J.hipL.set(0, 0, 0.05); J.hipR.set(0, 0, -0.05);
    if (this.emote === 'wave') {
      J.spine.set(0, 0, 0.05);
      J.shoulderL.set(0.05, 0, 0.12); J.elbowL.set(-0.2);
      J.shoulderR.set(-2.7, 0, -0.35 + Math.sin(t * 9) * 0.35); J.elbowR.set(-0.5);
      J.head.set(0, -0.2, 0.1);
    } else if (this.emote === 'dance') {
      const b = Math.sin(t * 8);
      J.hips.set(0, b * 0.3, b * 0.1);
      J.spine.set(0.1, -b * 0.4, -b * 0.15);
      J.shoulderL.set(-1.5 + b * 0.8, 0, 0.6); J.elbowL.set(-1.4);
      J.shoulderR.set(-1.5 - b * 0.8, 0, -0.6); J.elbowR.set(-1.4);
      J.kneeL.set(0.3 + Math.max(0, b) * 0.5); J.kneeR.set(0.3 + Math.max(0, -b) * 0.5);
      J.head.set(0.1, b * 0.3, 0);
    } else {
      // flex
      const k = Math.min(1, t * 4);
      J.spine.set(-0.1 * k, 0, 0);
      J.shoulderL.set(-0.2, 0, 1.5 * k); J.elbowL.set(-2.0 * k);
      J.shoulderR.set(-0.2, 0, -1.5 * k); J.elbowR.set(-2.0 * k);
      J.head.set(-0.15 * k, 0, 0);
      J.kneeL.set(0.25); J.kneeR.set(0.25); J.hipL.set(-0.1, 0, 0.25); J.hipR.set(-0.1, 0, -0.25);
    }
  }

  landed(speed) {
    this.landImpact = clamp(speed / 14, 0.25, 1);
    this.landT = 0.22;
  }

  dispose() {
    // free every per-character GPU resource (shared geometries are kept for the next model)
    if (this.nameSprite) this.nameSprite.material.map.dispose();
    this.skeleton.dispose();
    disposeTree(this.root);
  }
}

const SHARED_GEOS = new Set([...Object.values(sharedGeo), stripeGeo]);

function disposeTree(obj) {
  obj.traverse((o) => {
    if (o.geometry && !SHARED_GEOS.has(o.geometry)) o.geometry.dispose();
    if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
