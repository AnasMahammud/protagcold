// Unified input: keyboard + mouse (pointer lock), gamepad (standard mapping) and touch.
// Gameplay reads one merged command per frame; menus get navigation events for controller use.
import { settings } from './settings.js';
import { bus } from './events.js';

const DEADZONE = 0.18;
// key binding -> emote id (bindings emote1..emote6, see settings.js)
const EMOTE_KEYS = [['emote1', 'wave'], ['emote2', 'dance'], ['emote3', 'flex'], ['emote4', 'griddy'], ['emote5', 'buggin'], ['emote6', 'robot']];

export class InputManager {
  constructor(canvas) {
    this.canvas = canvas;
    this.down = new Set();
    this.pressed = new Set();
    this.lookDX = 0;
    this.lookDY = 0;
    this.gameplayActive = false; // true while a match is being played (not paused)
    this.touch = null; // TouchControls instance (optional)
    this.gamepadIndex = null;
    this.prevPad = [];
    this.padSprintToggle = false;
    this.lastDevice = 'keyboard';
    this.capture = null; // key-rebinding capture callback
    this.navRepeat = 0;
    this.navDir = null;
    this._bind();
  }

  _bind() {
    window.addEventListener('keydown', (e) => {
      if (this.capture) {
        e.preventDefault();
        const cb = this.capture;
        this.capture = null;
        cb(e.code === 'Escape' ? null : e.code);
        return;
      }
      if (isTyping(e)) return;
      this.lastDevice = 'keyboard';
      if (!this.down.has(e.code)) this.pressed.add(e.code);
      this.down.add(e.code);
      if (this.gameplayActive && (e.code === 'Tab' || e.code === 'Space' || e.code.startsWith('Arrow') || e.ctrlKey)) e.preventDefault();
      if (this.gameplayActive && e.code === 'KeyW' && e.ctrlKey) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => {
      this.down.delete(e.code);
    });
    window.addEventListener('blur', () => {
      this.down.clear();
    });
    window.addEventListener('mousedown', (e) => {
      if (this.capture) {
        e.preventDefault();
        const cb = this.capture;
        this.capture = null;
        cb(`Mouse${e.button}`);
        return;
      }
      const code = `Mouse${e.button}`;
      if (this.gameplayActive && document.pointerLockElement === this.canvas) {
        this.pressed.add(code);
        this.down.add(code);
      }
    });
    window.addEventListener('mouseup', (e) => this.down.delete(`Mouse${e.button}`));
    window.addEventListener('contextmenu', (e) => {
      if (this.gameplayActive) e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === this.canvas) {
        this.lastDevice = 'keyboard';
        // ignore absurd spikes some browsers emit when (re)locking the pointer
        if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
        this.lookDX += e.movementX;
        this.lookDY += e.movementY;
      }
    });
    window.addEventListener('gamepadconnected', (e) => {
      this.gamepadIndex = e.gamepad.index;
      bus.emit('input:gamepad', { connected: true, id: e.gamepad.id });
    });
    window.addEventListener('gamepaddisconnected', (e) => {
      if (this.gamepadIndex === e.gamepad.index) this.gamepadIndex = null;
      bus.emit('input:gamepad', { connected: false });
    });
    document.addEventListener('pointerlockchange', () => {
      bus.emit('input:pointerlock', { locked: document.pointerLockElement === this.canvas });
    });
  }

  requestPointerLock() {
    if (this.touch?.enabled) return;
    if (document.pointerLockElement !== this.canvas) {
      // Pointer lock can legitimately fail (no user gesture yet, embedded frames, unsupported
      // raw input): the HUD then shows "Click to control the camera" and a click retries.
      const plain = () => {
        try {
          const q = this.canvas.requestPointerLock();
          if (q && q.catch) q.catch(() => {});
        } catch { /* not available */ }
      };
      try {
        const p = this.canvas.requestPointerLock({ unadjustedMovement: true });
        if (p && p.catch) p.catch(plain);
      } catch {
        plain();
      }
    }
  }

  exitPointerLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  get pointerLocked() {
    return document.pointerLockElement === this.canvas;
  }

  /** Capture the next key/mouse button (for rebinding). cb(code|null). */
  captureNext(cb) {
    this.capture = cb;
  }

  _action(name, set) {
    const codes = settings.data.controls.bindings[name] || [];
    for (const c of codes) if (set.has(c)) return true;
    return false;
  }

  _pad() {
    if (this.gamepadIndex == null || !navigator.getGamepads) return null;
    const pad = navigator.getGamepads()[this.gamepadIndex];
    return pad && pad.connected ? pad : null;
  }

  /**
   * Sample this frame's merged gameplay command. Edge-triggered flags are cleared afterwards.
   * Returns { mx, my, lookX, lookY, jumpPressed, jumpHeld, sprint, slidePressed, dodgePressed,
   *           vaultPressed, pausePressed, scoreboard, emote, swapItPressed }
   */
  sample(dt) {
    const d = this.down;
    const p = this.pressed;
    let mx = (this._action('right', d) ? 1 : 0) - (this._action('left', d) ? 1 : 0);
    let my = (this._action('forward', d) ? 1 : 0) - (this._action('back', d) ? 1 : 0);
    const len = Math.hypot(mx, my);
    if (len > 1) { mx /= len; my /= len; }
    const sens = settings.data.controls;
    let lookX = this.lookDX * 0.0022 * sens.mouseSensX;
    let lookY = this.lookDY * 0.0022 * sens.mouseSensY * (sens.invertY ? -1 : 1);
    this.lookDX = 0;
    this.lookDY = 0;

    const cmd = {
      mx, my, lookX, lookY,
      jumpPressed: this._action('jump', p),
      jumpHeld: this._action('jump', d),
      sprint: this._action('sprint', d) || sens.autoSprint,
      slidePressed: this._action('slide', p),
      dodgePressed: this._action('dodge', p),
      vaultPressed: this._action('vault', p),
      pausePressed: this._action('pause', p),
      scoreboard: this._action('scoreboard', d),
      swapItPressed: this._action('swapIt', p),
      ability1Pressed: this._action('ability1', p),
      ability2Pressed: this._action('ability2', p),
      emote: EMOTE_KEYS.find(([action]) => this._action(action, p))?.[1] ?? null,
    };

    // ---- gamepad
    const pad = this._pad();
    if (pad) {
      const b = (i) => !!pad.buttons[i]?.pressed;
      const was = (i) => !!this.prevPad[i];
      const edge = (i) => b(i) && !was(i);
      const ax = (i) => {
        const v = pad.axes[i] || 0;
        return Math.abs(v) < DEADZONE ? 0 : (v - Math.sign(v) * DEADZONE) / (1 - DEADZONE);
      };
      const lx = ax(0), ly = ax(1), rx = ax(2), ry = ax(3);
      if (Math.abs(lx) + Math.abs(ly) + Math.abs(rx) + Math.abs(ry) > 0 || pad.buttons.some((x) => x.pressed)) this.lastDevice = 'gamepad';
      if (Math.abs(lx) + Math.abs(ly) > 0) { cmd.mx = lx; cmd.my = -ly; }
      const gs = 2.6 * sens.gamepadSens * dt;
      cmd.lookX += rx * Math.abs(rx) * gs * 1.4;
      cmd.lookY += ry * Math.abs(ry) * gs * (sens.invertY ? -1 : 1);
      if (edge(10)) this.padSprintToggle = !this.padSprintToggle;
      if (Math.hypot(lx, ly) < 0.2) this.padSprintToggle = false;
      cmd.jumpPressed ||= edge(0);
      cmd.jumpHeld ||= b(0);
      cmd.slidePressed ||= edge(1) || edge(6);
      cmd.vaultPressed ||= edge(2);
      cmd.dodgePressed ||= edge(4);
      cmd.sprint ||= b(5) || this.padSprintToggle;
      cmd.ability1Pressed ||= edge(3); // Y / Triangle
      cmd.ability2Pressed ||= edge(7); // RT / R2
      cmd.pausePressed ||= edge(9);
      cmd.scoreboard ||= b(8);
      cmd.swapItPressed ||= edge(13); // D-pad down
      if (edge(12)) cmd.emote = 'wave';
      if (edge(14)) cmd.emote = 'dance';
      if (edge(15)) cmd.emote = 'flex';
      if (edge(11)) cmd.emote = this.padEmoteCycle = this.padEmoteCycle === 'griddy' ? 'buggin' : this.padEmoteCycle === 'buggin' ? 'robot' : 'griddy'; // R3 cycles the new ones
      this.prevPad = pad.buttons.map((x) => x.pressed);
    }

    // ---- touch
    if (this.touch?.enabled) {
      const t = this.touch.consume();
      if (t.active) this.lastDevice = 'touch';
      if (Math.abs(t.mx) + Math.abs(t.my) > 0) { cmd.mx = t.mx; cmd.my = t.my; }
      cmd.lookX += t.lookX * 0.004 * sens.touchSens;
      cmd.lookY += t.lookY * 0.004 * sens.touchSens * (sens.invertY ? -1 : 1);
      cmd.jumpPressed ||= t.jumpPressed;
      cmd.jumpHeld ||= t.jumpHeld;
      cmd.sprint ||= t.sprint;
      cmd.slidePressed ||= t.slidePressed;
      cmd.dodgePressed ||= t.dodgePressed;
      cmd.vaultPressed ||= t.vaultPressed;
      cmd.ability1Pressed ||= t.ability1Pressed;
      cmd.ability2Pressed ||= t.ability2Pressed;
      cmd.pausePressed ||= t.pausePressed;
    }

    this.pressed.clear();
    return cmd;
  }

  /** Controller-driven menu navigation (call every frame while menus are shown). */
  pollMenuNav(dt) {
    const pad = this._pad();
    if (!pad) return;
    const b = (i) => !!pad.buttons[i]?.pressed;
    const was = (i) => !!this.prevPad[i];
    const edge = (i) => b(i) && !was(i);
    let dir = null;
    const ly = pad.axes[1] || 0, lx = pad.axes[0] || 0;
    if (b(12) || ly < -0.6) dir = 'up';
    else if (b(13) || ly > 0.6) dir = 'down';
    else if (b(14) || lx < -0.6) dir = 'left';
    else if (b(15) || lx > 0.6) dir = 'right';
    if (dir) {
      if (dir !== this.navDir) {
        this.navDir = dir;
        this.navRepeat = 0.35;
        bus.emit('ui:nav', dir);
      } else {
        this.navRepeat -= dt;
        if (this.navRepeat <= 0) {
          this.navRepeat = 0.12;
          bus.emit('ui:nav', dir);
        }
      }
    } else {
      this.navDir = null;
    }
    if (edge(0)) bus.emit('ui:nav', 'accept');
    if (edge(1)) bus.emit('ui:nav', 'back');
    if (edge(9)) bus.emit('ui:nav', 'start');
    if (pad.buttons.some((x) => x.pressed)) this.lastDevice = 'gamepad';
    this.prevPad = pad.buttons.map((x) => x.pressed);
  }

  clearEdges() {
    this.pressed.clear();
    this.lookDX = this.lookDY = 0;
  }
}

function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
