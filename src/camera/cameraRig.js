// Third-person orbit camera with wall collision, sprint FOV, landing dip and optional shake.
// Also drives the spectator and main-menu "attract" cameras.
import * as THREE from 'three';
import { clamp, damp, dampAngle } from '../core/mathUtil.js';
import { settings } from '../core/settings.js';
import { MS } from '../movement/controller.js';

const PIVOT_HEIGHT = 1.55;
const SHOULDER = 0.42;

export class CameraRig {
  constructor(camera, world) {
    this.camera = camera;
    this.world = world;
    this.yaw = 0;
    this.pitch = -0.18;
    this.pivot = new THREE.Vector3();
    this.pivotInit = false;
    this.dist = settings.data.camera.distance;
    this.curDist = 1; // fraction of the full camera offset currently in use
    this.fovKick = 0;
    this.dip = 0;
    this.trauma = 0;
    // cinematic overrides driven by the perfect-dodge director (0 = normal gameplay camera)
    this.cine = { orbit: 0, zoom: 0, roll: 0, fov: 0, lift: 0 };
    this.mode = 'follow'; // follow | spectate | orbit
    this.orbitT = 0;
    this.tmp = new THREE.Vector3();
  }

  setWorld(world) {
    this.world = world;
    this.pivotInit = false;
  }

  /** Movement basis for camera-relative controls. */
  forward() {
    return { x: -Math.sin(this.yaw), z: -Math.cos(this.yaw) };
  }

  right() {
    return { x: Math.cos(this.yaw), z: -Math.sin(this.yaw) };
  }

  applyLook(dx, dy) {
    this.yaw -= dx;
    this.pitch = clamp(this.pitch - dy, -1.25, 0.85);
  }

  snapBehind(yaw) {
    this.yaw = yaw;
    this.pitch = -0.2;
    this.pivotInit = false;
  }

  onLand(speed) {
    if (!settings.data.camera.landingDip) return;
    this.dip = Math.min(0.28, Math.max(this.dip, (speed - 6) * 0.02));
  }

  shake(amount) {
    if (!settings.data.camera.shake || settings.data.accessibility.reduceFlashing) return;
    this.trauma = Math.min(1, this.trauma + amount);
  }

  /**
   * Follow a character. `ctrl` exposes pos, state, sprinting, horizontalSpeed.
   */
  updateFollow(dt, ctrl, time) {
    const cam = this.camera;
    const target = this.tmp.set(ctrl.pos.x, ctrl.pos.y + (ctrl.state === MS.SLIDE ? 1.0 : PIVOT_HEIGHT), ctrl.pos.z);
    if (!this.pivotInit) {
      this.pivot.copy(target);
      this.pivotInit = true;
    } else {
      // tight horizontal tracking, softer vertical tracking (smooths steps and jumps)
      this.pivot.x = damp(this.pivot.x, target.x, 30, dt);
      this.pivot.z = damp(this.pivot.z, target.z, 30, dt);
      this.pivot.y = damp(this.pivot.y, target.y, ctrl.grounded ? 14 : 9, dt);
    }
    this.dip = damp(this.dip, 0, 6, dt);

    const cs = settings.data.camera;
    this.dist = cs.distance;
    const speed = ctrl.horizontalSpeed;
    let kick = 0;
    if (cs.sprintFov) {
      if (ctrl.state === MS.SLIDE) kick = 9;
      else if (ctrl.sprinting && speed > 8) kick = 6;
      else if (speed > 12) kick = 7;
    }
    this.fovKick = damp(this.fovKick, kick, 5, dt);
    const fov = cs.fov + this.fovKick + this.cine.fov;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
    this._place(dt, time);
  }

  /** Spectator: smoothly follow another character without player look control over yaw drift. */
  updateSpectate(dt, ctrl, time) {
    this.updateFollow(dt, ctrl, time);
  }

  /** Cinematic orbit around a point (main menu background). */
  updateOrbit(dt, center, radius, height, time) {
    this.orbitT += dt * 0.05;
    const a = this.orbitT;
    const cam = this.camera;
    cam.position.set(center.x + Math.cos(a) * radius, center.y + height + Math.sin(a * 2.3) * 2, center.z + Math.sin(a) * radius);
    cam.lookAt(center.x, center.y + 2, center.z);
    if (cam.fov !== 60) {
      cam.fov = 60;
      cam.updateProjectionMatrix();
    }
  }

  /** Cinematic chase: slowly drifting camera following a subject. */
  updateCinematicFollow(dt, pos, time) {
    const cam = this.camera;
    this.orbitT += dt * 0.12;
    const a = this.orbitT;
    const desired = this.tmp.set(pos.x + Math.cos(a) * 7, pos.y + 3.2 + Math.sin(a * 0.7) * 0.8, pos.z + Math.sin(a) * 7);
    if (!this.pivotInit) {
      cam.position.copy(desired);
      this.pivot.set(pos.x, pos.y + 1.2, pos.z);
      this.pivotInit = true;
    }
    cam.position.x = damp(cam.position.x, desired.x, 2, dt);
    cam.position.y = damp(cam.position.y, desired.y, 2, dt);
    cam.position.z = damp(cam.position.z, desired.z, 2, dt);
    this.pivot.x = damp(this.pivot.x, pos.x, 4, dt);
    this.pivot.y = damp(this.pivot.y, pos.y + 1.2, 4, dt);
    this.pivot.z = damp(this.pivot.z, pos.z, 4, dt);
    // keep the camera out of walls
    if (this.world) {
      const d = cam.position.clone().sub(this.pivot);
      const len = d.length();
      d.normalize();
      const hit = this.world.raycast(this.pivot.x, this.pivot.y, this.pivot.z, d.x, d.y, d.z, len, true);
      if (hit) cam.position.copy(this.pivot).addScaledVector(d, Math.max(0.8, hit.t - 0.3));
    }
    cam.lookAt(this.pivot);
    if (cam.fov !== 55) {
      cam.fov = 55;
      cam.updateProjectionMatrix();
    }
  }

  _place(dt, time) {
    const cam = this.camera;
    const cine = this.cine;
    const yaw = this.yaw + cine.orbit;
    const pitch = this.pitch - cine.lift;
    const cp = Math.cos(pitch);
    const dir = { x: Math.sin(yaw) * cp, y: -Math.sin(pitch), z: Math.cos(yaw) * cp }; // pivot -> camera
    const right = { x: Math.cos(yaw), z: -Math.sin(yaw) };
    const savedDist = this.dist;
    this.dist = savedDist * (1 - cine.zoom * 0.5);
    const py = this.pivot.y - this.dip;
    // full offset from the pivot (inside the character) to the ideal camera spot
    const ox = right.x * SHOULDER + dir.x * this.dist;
    const oy = dir.y * this.dist;
    const oz = right.z * SHOULDER + dir.z * this.dist;
    const L = Math.hypot(ox, oy, oz);
    let frac = 1;
    if (this.world) {
      const hit = this.world.raycast(this.pivot.x, py, this.pivot.z, ox / L, oy / L, oz / L, L, true);
      if (hit) frac = Math.max(0.6 / L, (hit.t - 0.28) / L);
    }
    // snap in instantly (never clip), ease back out smoothly
    this.curDist = frac < this.curDist ? frac : damp(this.curDist, frac, 5, dt);
    if (this.curDist > 1) this.curDist = 1;
    const f = this.curDist;
    cam.position.set(this.pivot.x + ox * f, py + oy * f, this.pivot.z + oz * f);
    cam.lookAt(this.pivot.x + right.x * SHOULDER * f, py + 0.05, this.pivot.z + right.z * SHOULDER * f);
    this.dist = savedDist;
    if (cine.roll) cam.rotateZ(cine.roll);

    if (this.trauma > 0) {
      const s = this.trauma * this.trauma;
      cam.rotation.z += Math.sin(time * 61) * 0.02 * s;
      cam.position.x += Math.sin(time * 47) * 0.08 * s;
      cam.position.y += Math.sin(time * 53) * 0.08 * s;
      this.trauma = Math.max(0, this.trauma - dt * 1.8);
    }
  }

  get yawSmooth() {
    return this.yaw;
  }
}

export { dampAngle };
