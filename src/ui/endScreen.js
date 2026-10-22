// End-of-match presentation: the full-screen VICTORY / DEFEAT slam with an impact shake, then a
// background layer (light rays, confetti or falling ash, vignette) that stays behind the results
// screen while the 3D camera circles the winner. Performance: only transform / opacity are
// animated, so everything (confetti and ash included) runs on the browser's compositor: no
// per-frame JavaScript, no canvas, no blur filters. Every particle animation is finite (the
// pieces are removed after ~8 s); only the light rays keep slowly turning.
import { settings } from '../core/settings.js';
import { audio } from '../audio/audio.js';

const CONFETTI = ['#ffd23d', '#ff3df0', '#3df5ff', '#7dff6b', '#ff7a2f', '#ffffff'];

export class EndScreenFx {
  /** won: the local player won; info: { title, sub, place, total } */
  constructor(won, info) {
    this.won = won;
    this.calm = !!settings.data.accessibility.reduceFlashing;
    const layer = document.createElement('div');
    layer.className = `endfx ${won ? 'win' : 'lose'}${this.calm ? ' calm' : ''}`;
    layer.innerHTML = `
      <div class="endfx-tint"></div>
      ${won ? '<div class="endfx-rays"></div>' : '<div class="endfx-scan"></div>'}
      <div class="endfx-bits"></div>
      <div class="endfx-vignette"></div>`;
    document.body.appendChild(layer);
    this.layer = layer;
    this.bits = layer.querySelector('.endfx-bits');
    this._outro(info);
    if (!won) this._ash();
  }

  /** The big title: letters slam in one by one, then the whole thing shakes on impact. */
  _outro({ title, sub, place, total }) {
    const el = document.createElement('div');
    el.className = `endfx-outro ${this.won ? 'win' : 'lose'}${this.calm ? ' calm' : ''}`;
    const letters = [...title].map((ch, i) => `<span style="--i:${i}">${ch === ' ' ? '&nbsp;' : esc(ch)}</span>`).join('');
    el.innerHTML = `
      <div class="eo-flash"></div>
      <div class="eo-shake">
        ${place ? `<div class="eo-place">${this.won ? 'WINNER' : `#${place}<small>${total ? ` of ${total}` : ''}</small>`}</div>` : ''}
        <div class="eo-title" data-text="${esc(title)}">${letters}${this.won ? '' : '<svg class="eo-crack" viewBox="0 0 400 120" preserveAspectRatio="none"><path d="M0 64 L70 58 L96 72 L140 50 L176 66 L214 44 L250 70 L292 52 L330 68 L400 56"/></svg>'}</div>
        <div class="eo-sub">${esc(sub)}</div>
      </div>`;
    document.body.appendChild(el);
    this.outroEl = el;
    // impact: when the last letter lands
    const land = 0.18 + title.length * 0.055 + 0.12;
    this._t1 = setTimeout(() => {
      el.classList.add('hit');
      audio.play(this.won ? 'titleSlam' : 'defeatHit');
      if (this.won) this._confetti();
    }, land * 1000);
  }

  /** The outro hands over to the results screen: the title flies up and fades. */
  toResults() {
    const el = this.outroEl;
    if (!el) return;
    el.classList.add('leave');
    this._leaving = el;
    this._t2 = setTimeout(() => el.remove(), 450);
    this.outroEl = null;
  }

  // ------------------------------------------------------------------ particles (pure CSS)
  /** Two confetti cannons from the bottom corners, then a gentle shower from the top. */
  _confetti() {
    const R = Math.random;
    const html = [];
    for (const side of [0, 1]) {
      const dir = side ? -1 : 1;
      for (let i = 0; i < 34; i++) {
        const ax = dir * (8 + R() * 38), ay = -(42 + R() * 46); // apex (vw / vh from the corner)
        const ex = ax * (1.25 + R() * 0.5) + (R() - 0.5) * 10, ey = ay + 70 + R() * 50; // where it falls to
        html.push(bit('cannon', side ? 'right:0' : 'left:0', 'bottom:0', { ax: `${ax}vw`, ay: `${ay}vh`, ex: `${ex}vw`, ey: `${ey}vh`, r: `${(R() - 0.5) * 1440}deg`, t: `${2.4 + R() * 1.2}s`, d: `${R() * 0.18}s` }));
      }
    }
    for (let i = 0; i < 46; i++) {
      const x0 = R() * 100;
      html.push(bit('fall', `left:0`, 'top:0', { x0: `${x0}vw`, x1: `${x0 + (R() - 0.5) * 18}vw`, r: `${(R() - 0.5) * 1080}deg`, t: `${3 + R() * 2.2}s`, d: `${0.4 + R() * 2.6}s` }));
    }
    this.bits.insertAdjacentHTML('beforeend', html.join(''));
    this._cleanup = setTimeout(() => (this.bits.innerHTML = ''), 9000); // every piece has landed by now
  }

  /** Defeat: ash and embers drifting down. */
  _ash() {
    const R = Math.random;
    const html = [];
    for (let i = 0; i < 38; i++) {
      const x0 = R() * 100;
      html.push(bit('ash', 'left:0', 'top:0', { x0: `${x0}vw`, x1: `${x0 + (R() - 0.5) * 12}vw`, y1: `${55 + R() * 50}vh`, t: `${3.5 + R() * 2.5}s`, d: `${R() * 2.5}s` }, R() < 0.25 ? '#ff4d3a' : '#8c93a3'));
    }
    this.bits.innerHTML = html.join('');
    this._cleanup = setTimeout(() => (this.bits.innerHTML = ''), 9000);
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this._cleanup);
    clearTimeout(this._t1);
    clearTimeout(this._t2);
    this.outroEl?.remove();
    this._leaving?.remove(); // still fading out when the results were left
    const layer = this.layer;
    layer.classList.add('gone');
    setTimeout(() => layer.remove(), 400);
  }
}

/** Count numbers up and fill bars on the results screen (one short rAF loop for all of them). */
export function animateResults(root) {
  const calm = !!settings.data.accessibility.reduceFlashing;
  const nums = [...root.querySelectorAll('[data-count]')].map((el) => ({ el, to: Number(el.dataset.count) || 0, delay: Number(el.dataset.delay || 0), pre: el.dataset.pre || '' }));
  const bars = [...root.querySelectorAll('[data-fill]')];
  requestAnimationFrame(() => bars.forEach((b) => (b.style.width = `${b.dataset.fill}%`))); // CSS transition does the rest
  if (calm) {
    nums.forEach((n) => (n.el.textContent = `${n.pre}${n.to}`));
    return;
  }
  const t0 = performance.now();
  const dur = 900;
  let ticks = 0;
  const step = (now) => {
    let busy = false;
    for (const n of nums) {
      const k = Math.min(1, Math.max(0, (now - t0 - n.delay) / dur));
      const e = 1 - (1 - k) ** 3;
      n.el.textContent = `${n.pre}${Math.round(n.to * e)}`;
      if (k < 1) busy = true;
    }
    if (busy && ++ticks % 4 === 0) audio.play('uiHover', { volume: 0.25 }); // a soft ticking while counting
    if (busy) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** One particle: a tiny div whose CSS animation (bit-cannon / bit-fall / bit-ash) uses these variables. */
function bit(kind, x, y, vars, color = CONFETTI[(Math.random() * CONFETTI.length) | 0]) {
  const v = Object.entries(vars).map(([k, val]) => `--${k}:${val}`).join(';');
  return `<i class="bit ${kind}" style="${x};${y};background:${color};${v}"></i>`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
