// "Ready up" burst: a shockwave ring, sparks flying out and a floating READY! from the button.
// It lives in its own fixed layer (not inside the lobby), so the lobby re-rendering a moment later
// (when the server confirms) doesn't cut it short. Transform / opacity only; gone after ~0.9 s.
import { settings } from '../core/settings.js';

export function readyBurst(button, ready) {
  if (!button?.getBoundingClientRect) return;
  const r = button.getBoundingClientRect();
  const calm = !!settings.data.accessibility.reduceFlashing;
  const el = document.createElement('div');
  el.className = `ready-burst ${ready ? 'on' : 'off'}${calm ? ' calm' : ''}`;
  el.style.left = `${r.left + r.width / 2}px`;
  el.style.top = `${r.top + r.height / 2}px`;
  el.style.setProperty('--w', `${r.width}px`);
  el.style.setProperty('--h', `${r.height}px`);
  let html = '<b class="rb-ring"></b>';
  if (ready) {
    html += `${calm ? '' : '<b class="rb-glow"></b>'}<b class="rb-ring two"></b><em class="rb-word">READY!</em>`;
    const n = calm ? 0 : 18;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.3;
      const d = 90 + Math.random() * 90;
      html += `<i class="rb-spark" style="--dx:${(Math.cos(a) * d * 1.6).toFixed(1)}px;--dy:${(Math.sin(a) * d).toFixed(1)}px;--rot:${((a * 180) / Math.PI).toFixed(0)}deg;--del:${(Math.random() * 0.05).toFixed(2)}s"></i>`;
    }
  }
  el.innerHTML = html;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 950);
}
