// Mobile touch controls: floating virtual joystick (left), camera drag zone (right) and
// large action buttons. Enabled automatically on touch devices.
import { abilityIcon } from './abilityIcons.js';
import { ABILITY_INFO } from '../gameplay/abilities.js';

export class TouchControls {
  constructor(root) {
    this.root = root;
    this.enabled = false;
    this.mx = 0;
    this.my = 0;
    this.lookX = 0;
    this.lookY = 0;
    this.sprint = false;
    this.flags = { jumpPressed: false, slidePressed: false, dodgePressed: false, vaultPressed: false, pausePressed: false, ability1Pressed: false, ability2Pressed: false };
    this.jumpHeld = false;
    this.moveTouch = null;
    this.lookTouch = null;
    root.innerHTML = `
      <div class="zone-look"></div>
      <div class="zone-move"></div>
      <div class="stick"><i></i></div>
      <button class="tbtn jump" data-a="jump">Jump</button>
      <button class="tbtn slide" data-a="slide">Slide</button>
      <button class="tbtn sprint" data-a="sprint">Sprint</button>
      <button class="tbtn dodge" data-a="dodge">Dodge</button>
      <button class="tbtn vault" data-a="vault">Vault</button>
      <button class="tbtn ab1" data-a="ability1">A1</button>
      <button class="tbtn ab2" data-a="ability2">A2</button>
      <button class="tbtn pause" data-a="pause">❚❚</button>`;
    this.stick = root.querySelector('.stick');
    this.knob = root.querySelector('.stick i');
    this._bind();
  }

  /** Touch UI by default only on real touch-first devices (phones/tablets). Laptops with a
   * touchscreen keep mouse controls until a touch actually happens (see UI). */
  static supported() {
    const hasTouch = navigator.maxTouchPoints > 0 || 'ontouchstart' in window;
    const coarseOnly = !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches && !window.matchMedia('(any-pointer: fine)').matches;
    return hasTouch && coarseOnly;
  }

  setEnabled(v) {
    this.enabled = v;
    this.root.classList.toggle('hidden', !v);
    document.body.classList.toggle('touch-ui', v);
    if (!v) this._reset();
  }

  /** Show the equipped ability icons on the A1/A2 buttons (hidden when a slot is empty). */
  setAbilities(loadout) {
    ['ab1', 'ab2'].forEach((cls, i) => {
      const b = this.root.querySelector(`.tbtn.${cls}`);
      const id = loadout[i];
      b.classList.toggle('off', !id);
      b.innerHTML = id ? `${abilityIcon(id)}<i class="cd"></i>` : '';
      b.style.setProperty('--c', id ? ABILITY_INFO[id].color : '#fff');
    });
  }

  setCooldowns(abs = []) {
    ['ab1', 'ab2'].forEach((cls, i) => {
      const a = abs[i];
      if (!a) return;
      const v = Math.round((a.cd > 0 ? a.cd / a.max : 0) * 100);
      if (this[`_cd${i}`] === v) return;
      this[`_cd${i}`] = v;
      this.root.querySelector(`.tbtn.${cls}`)?.style.setProperty('--p', v);
    });
  }

  _reset() {
    this.mx = this.my = 0;
    this.moveTouch = this.lookTouch = null;
    this.stick.style.display = 'none';
    this.jumpHeld = false;
  }

  _bind() {
    const move = this.root.querySelector('.zone-move');
    const look = this.root.querySelector('.zone-look');
    const R = 55;
    move.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      this.moveTouch = { id: t.identifier, x: t.clientX, y: t.clientY };
      this.stick.style.display = 'block';
      this.stick.style.left = `${t.clientX}px`;
      this.stick.style.top = `${t.clientY}px`;
      this.knob.style.transform = 'translate(0,0)';
    }, { passive: false });
    look.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const t = e.changedTouches[0];
      this.lookTouch = { id: t.identifier, x: t.clientX, y: t.clientY };
    }, { passive: false });
    window.addEventListener('touchmove', (e) => {
      if (!this.enabled) return;
      for (const t of e.changedTouches) {
        if (this.moveTouch && t.identifier === this.moveTouch.id) {
          let dx = t.clientX - this.moveTouch.x;
          let dy = t.clientY - this.moveTouch.y;
          const d = Math.hypot(dx, dy);
          if (d > R) { dx *= R / d; dy *= R / d; }
          this.knob.style.transform = `translate(${dx}px, ${dy}px)`;
          this.mx = dx / R;
          this.my = -dy / R;
          // pushing the stick to the edge sprints automatically
          this.autoSprint = d > R * 0.95;
        } else if (this.lookTouch && t.identifier === this.lookTouch.id) {
          this.lookX += t.clientX - this.lookTouch.x;
          this.lookY += t.clientY - this.lookTouch.y;
          this.lookTouch.x = t.clientX;
          this.lookTouch.y = t.clientY;
        }
      }
    }, { passive: true });
    const end = (e) => {
      for (const t of e.changedTouches) {
        if (this.moveTouch && t.identifier === this.moveTouch.id) {
          this.moveTouch = null;
          this.mx = this.my = 0;
          this.autoSprint = false;
          this.stick.style.display = 'none';
        }
        if (this.lookTouch && t.identifier === this.lookTouch.id) this.lookTouch = null;
      }
    };
    window.addEventListener('touchend', end);
    window.addEventListener('touchcancel', end);

    for (const b of this.root.querySelectorAll('.tbtn')) {
      const a = b.dataset.a;
      b.addEventListener('touchstart', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (a === 'sprint') {
          this.sprint = !this.sprint;
          b.classList.toggle('on', this.sprint);
          return;
        }
        if (a === 'jump') this.jumpHeld = true;
        this.flags[`${a}Pressed`] = true;
      }, { passive: false });
      b.addEventListener('touchend', (e) => {
        e.preventDefault();
        if (a === 'jump') this.jumpHeld = false;
      }, { passive: false });
    }
  }

  consume() {
    const out = {
      active: !!(this.moveTouch || this.lookTouch),
      mx: this.mx,
      my: this.my,
      lookX: this.lookX,
      lookY: this.lookY,
      jumpPressed: this.flags.jumpPressed,
      jumpHeld: this.jumpHeld,
      sprint: this.sprint || this.autoSprint,
      slidePressed: this.flags.slidePressed,
      dodgePressed: this.flags.dodgePressed,
      vaultPressed: this.flags.vaultPressed,
      ability1Pressed: this.flags.ability1Pressed,
      ability2Pressed: this.flags.ability2Pressed,
      pausePressed: this.flags.pausePressed,
    };
    this.lookX = this.lookY = 0;
    for (const k of Object.keys(this.flags)) this.flags[k] = false;
    return out;
  }
}
