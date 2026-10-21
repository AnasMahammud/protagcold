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
    this.obj = new THREE.Group();
    this.obj.name = name;
    this.obj.position.set(x, y, z);
    parent.add(this.obj);
    this.cur = new THREE.Vector3();
    this.tgt = new THREE.Vector3();
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

export class CharacterModel {
  constructor(cosmetics) {
    this.root = new THREE.Group();
    this.root.name = 'character';
    this.body = new THREE.Group(); // gets yaw + bob
    this.root.add(this.body);

    this.mats = {
      primary: new THREE.MeshStandardMaterial({ color: '#ff5a3d', roughness: 0.55, metalness: 0.05 }),
      secondary: new THREE.MeshStandardMaterial({ color: '#20242e', roughness: 0.65, metalness: 0.1 }),
      dark: new THREE.MeshStandardMaterial({ color: '#15171c', roughness: 0.5, metalness: 0.2 }),
      visor: new THREE.MeshStandardMaterial({ color: '#0b0d12', roughness: 0.12, metalness: 0.85 }),
      accent: new THREE.MeshBasicMaterial({ color: '#3df5ff' }),
      sole: new THREE.MeshStandardMaterial({ color: '#f2f2f2', roughness: 0.7 }),
    };
    this.mats.accent.toneMapped = false;

    const add = (parent, geo, mat, x = 0, y = 0, z = 0, cast = true) => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = cast;
      parent.add(m);
      return m;
    };

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

    // --- meshes
    add(this.hips.obj, sharedGeo.pelvis, this.mats.secondary, 0, 0, 0).rotation.z = Math.PI / 2;
    add(this.spine.obj, sharedGeo.torso, this.mats.primary, 0, 0.24, 0);
    this.chest = add(this.spine.obj, sharedGeo.chestPlate, this.mats.secondary, 0, 0.3, 0.18);
    const stripe = add(this.spine.obj, new THREE.BoxGeometry(0.42, 0.035, 0.02), this.mats.accent, 0, 0.3, 0.205, false);
    stripe.scale.x = 0.7;
    this.headMesh = add(this.head.obj, sharedGeo.head, this.mats.primary, 0, 0.02, 0);
    const visor = add(this.head.obj, sharedGeo.visor, this.mats.visor, 0, 0.02, 0, false);
    visor.rotation.y = Math.PI / 2; // model faces +Z internally
    const vline = add(this.head.obj, sharedGeo.visorLine, this.mats.accent, 0, -0.005, 0, false);
    vline.rotation.x = Math.PI / 2;
    vline.rotation.z = Math.PI / 2 - 1.1;
    for (const [sh, el] of [[this.shoulderL, this.elbowL], [this.shoulderR, this.elbowR]]) {
      add(sh.obj, sharedGeo.upperArm, this.mats.primary);
      add(el.obj, sharedGeo.foreArm, this.mats.secondary);
      add(el.obj, sharedGeo.hand, this.mats.dark, 0, -0.31, 0);
    }
    for (const [hp, kn, an] of [[this.hipL, this.kneeL, this.ankleL], [this.hipR, this.kneeR, this.ankleR]]) {
      add(hp.obj, sharedGeo.thigh, this.mats.secondary);
      add(kn.obj, sharedGeo.shin, this.mats.primary);
      add(an.obj, sharedGeo.shoe, this.mats.dark, 0, 0.01, 0.05);
      add(an.obj, sharedGeo.sole, this.mats.sole, 0, -0.04, 0.05, false);
    }

    this.hatSlot = new THREE.Group();
    this.hatSlot.position.y = 0.16;
    this.head.obj.add(this.hatSlot);

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

  applyCosmetics(c) {
    this.cosmetics = c;
    if (c.primary) this.mats.primary.color.set(c.primary);
    if (c.secondary) this.mats.secondary.color.set(c.secondary);
    if (c.accent) this.mats.accent.color.set(c.accent);
    for (const child of [...this.hatSlot.children]) disposeTree(child);
    this.hatSlot.clear();
    this._matList = null; // material list changes with the hat
    const hat = HATS[c.hat];
    if (hat && hat.build) {
      const obj = hat.build(THREE, c);
      obj.traverse((o) => {
        if (o.isMesh) o.castShadow = true;
      });
      this.hatSlot.add(obj);
    }
  }

  /** Real shadow casting on/off (off on lower presets: the blob shadow is used instead). */
  setCastShadows(on) {
    this.body.traverse((o) => {
      if (o.isMesh) o.castShadow = on && o.geometry !== sharedGeo.hand && o.geometry !== sharedGeo.sole;
    });
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

  setIt(isIt, infected = false) {
    this.isIt = isIt;
    this.itGroup.visible = isIt && !this.cloakOn;
    this.itRing.visible = isIt && !this.cloakOn;
    const col = infected ? '#7dff3d' : '#ff3b2f';
    this.itGroup.children.forEach((m) => m.material.color.set(col));
    this.itRing.material.color.set(col);
    this.mats.primary.emissive.set(isIt ? col : '#000000');
    this.mats.primary.emissiveIntensity = isIt ? 0.35 : 0;
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
      this.itGroup.visible = !!this.isIt && !on;
      this.itRing.visible = !!this.isIt && !on;
      if (this.nameSprite) this.nameSprite.material.opacity = on ? 0 : 1;
      this.body.traverse((o) => {
        if (o.isMesh) {
          if (on) {
            o.userData.castSaved = o.castShadow;
            o.castShadow = false;
          } else if (o.userData.castSaved !== undefined) {
            o.castShadow = o.userData.castSaved;
          }
        }
      });
    }
    if (on) for (const m of this._allMats()) m.opacity = alpha;
  }

  /**
   * The current pose baked into ONE world-space geometry (positions only). Afterimages use
   * this: one draw call per ghost instead of ~25 cloned meshes.
   */
  bakePose() {
    this.root.updateMatrixWorld(true);
    const positions = [];
    const indices = [];
    const v = new THREE.Vector3();
    let base = 0;
    this.body.traverse((o) => {
      if (!o.isMesh || !o.visible) return;
      const g = o.geometry;
      const pos = g.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(o.matrixWorld);
        positions.push(v.x, v.y, v.z);
      }
      if (g.index) for (let i = 0; i < g.index.count; i++) indices.push(base + g.index.getX(i));
      else for (let i = 0; i < pos.count; i++) indices.push(base + i);
      base += pos.count;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geo.setIndex(indices);
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
    disposeTree(this.root);
  }
}

const SHARED_GEOS = new Set(Object.values(sharedGeo));

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
