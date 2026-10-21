// In-match HUD. Built once, then updated every frame with cheap diffed DOM writes.
import { bus } from '../core/events.js';
import { settings } from '../core/settings.js';
import { formatSeconds } from '../core/mathUtil.js';
import { audio } from '../audio/audio.js';
import { abilityIcon, COIN_SVG } from './abilityIcons.js';
import { ABILITY_INFO } from '../gameplay/abilities.js';

const MODE_NAMES = { classic: 'Classic Tag', infection: 'Infection', elimination: 'Last Runner', practice: 'Practice', hotpotato: 'Hot Potato', zone: 'Shrinking Zone' };

export class Hud {
  constructor(root) {
    this.root = root;
    root.innerHTML = `
      <div class="vignette"></div>
      <div class="crosshair"></div>
      <div class="top">
        <div class="mode"></div>
        <div class="clock">0:00</div>
        <div class="itline hidden"></div>
        <div class="zonebar hidden"><i class="zarrow"></i><span></span></div>
        <div class="eventbar hidden"><b></b><span></span></div>
      </div>
      <div class="tl">
        <div class="objective"></div>
        <div class="counts"></div>
      </div>
      <div class="tr">
        <div class="tags">0<small>TAGS</small></div>
        <div class="coinsbox">${COIN_SVG}<span>0</span><em></em></div>
        <div class="net"></div>
        <div class="fps"></div>
      </div>
      <div class="feed"></div>
      <div class="arrow hidden"><i></i><span></span></div>
      <div class="banner hidden"><div class="t"></div><div class="s"></div></div>
      <div class="bottom">
        <div class="status hidden"></div>
        <div class="abilities">
          <div class="ability dodge"><div class="ring"></div><span class="ab-label">Dodge</span></div>
          <div class="ability slide"><div class="ring"></div>Slide</div>
        </div>
        <div class="stamina"><i></i></div>
      </div>
      <div class="abslots"></div>
      <div class="cloakfx"></div>
      <div class="scoreboard panel hidden"></div>
      <div class="lockhint hidden">Click to control the camera</div>
      <div class="speedlines"></div>
      <div class="dodgecue hidden"><div class="cue-target"></div><div class="cue-approach"></div><div class="cue-label"><b class="cue-key">Q</b><span class="cue-txt">DODGE</span></div></div>
      <div class="boostbar hidden"><span>SPEED BOOST</span><div class="bb"><i></i></div></div>
      <div class="perfect hidden"><div class="pt"></div><div class="ps"></div></div>`;
    const q = (s) => root.querySelector(s);
    this.el = {
      vignette: q('.vignette'), mode: q('.mode'), clock: q('.clock'), itline: q('.itline'), objective: q('.objective'),
      counts: q('.counts'), tags: q('.tags'), fps: q('.fps'), net: q('.net'), feed: q('.feed'), arrow: q('.arrow'),
      arrowI: q('.arrow i'), arrowS: q('.arrow span'), banner: q('.banner'), bannerT: q('.banner .t'), bannerS: q('.banner .s'),
      status: q('.status'), dodge: q('.ability.dodge'), slide: q('.ability.slide'), stamina: q('.stamina'), staminaI: q('.stamina i'),
      scoreboard: q('.scoreboard'), lockhint: q('.lockhint'),
      speedlines: q('.speedlines'), cue: q('.dodgecue'), cueApproach: q('.cue-approach'), cueKey: q('.cue-key'), cueTxt: q('.cue-txt'),
      boostbar: q('.boostbar'), boostI: q('.boostbar i'), perfect: q('.perfect'), perfectT: q('.perfect .pt'), perfectS: q('.perfect .ps'),
      dodgeLabel: q('.ability.dodge .ab-label'),
      crosshair: q('.crosshair'), abslots: q('.abslots'), coins: q('.coinsbox'), coinsN: q('.coinsbox span'), coinsPop: q('.coinsbox em'),
      cloakfx: q('.cloakfx'),
      zonebar: q('.zonebar'), zoneText: q('.zonebar span'), zoneArrow: q('.zonebar .zarrow'),
      eventbar: q('.eventbar'), eventTitle: q('.eventbar b'), eventText: q('.eventbar span'),
    };
    this.cache = {};
    this.bannerTimer = null;
    bus.on('hud:banner', (b) => this.banner(b));
    bus.on('hud:feed', (f) => this.feed(f));
    bus.on('hud:perfect', (p) => this.perfect(p));
    bus.on('hud:perfectEnd', () => this._hidePerfect());
    bus.on('hud:coin', (c) => this.coinPop(c));
    bus.on('settings:changed', () => this.applyScale());
    this.applyScale();
  }

  applyScale() {
    this.root.style.setProperty('--hud-scale', settings.data.accessibility.hudScale);
  }

  _set(key, el, prop, val) {
    if (this.cache[key] === val) return;
    this.cache[key] = val;
    if (prop === 'text') el.textContent = val;
    else if (prop === 'html') el.innerHTML = val;
    else if (prop === 'width') el.style.width = val;
    else if (prop === 'hidden') el.classList.toggle('hidden', val);
  }

  show(v) {
    this.root.classList.toggle('hidden', !v);
    if (!v) {
      this.el.feed.innerHTML = '';
      this.el.banner.classList.add('hidden');
    }
  }

  update(s, extra) {
    const e = this.el;
    this._set('mode', e.mode, 'text', MODE_NAMES[s.mode] || s.mode);
    let clock = s.clock;
    if (s.phase === 'countdown') clock = String(Math.ceil(s.countdown));
    else if (s.fuse != null) clock = s.fuse < 10 ? s.fuse.toFixed(1) : String(Math.ceil(s.fuse)); // hot potato: the fuse IS the clock
    this._set('clock', e.clock, 'text', clock);
    const low = s.phase === 'playing' && (s.fuse != null ? s.fuse < 6 : s.timeLeft < 15);
    if (this.cache.low !== low) {
      this.cache.low = low;
      e.clock.classList.toggle('low', low);
    }
    if (this.cache.fuseMode !== (s.fuse != null)) {
      this.cache.fuseMode = s.fuse != null;
      e.clock.classList.toggle('fuse', s.fuse != null);
    }
    const itLabel = s.mode === 'infection' ? '☣ INFECTED' : s.mode === 'hotpotato' ? `💣 POTATO${s.potatoRound ? ` · ROUND ${s.potatoRound}` : ''}` : '🔥 IT';
    const itText = s.its.length ? `${itLabel}: ${s.its.length > 3 ? `${s.its.length} players` : s.its.join(', ')}` : '';
    this._set('it', e.itline, 'text', itText);
    this._set('itH', e.itline, 'hidden', !itText);
    if (this.cache.inf !== (s.mode === 'infection')) {
      this.cache.inf = s.mode === 'infection';
      e.itline.classList.toggle('infection', this.cache.inf);
    }
    this._set('obj', e.objective, 'text', s.spectating ? `Spectating ${s.spectating} — Jump to switch` : s.objective);
    const counts = s.mode === 'hotpotato' ? `${s.alive} still standing · ${plural(s.total, 'player')}` : ['infection', 'elimination', 'zone'].includes(s.mode) ? `${s.runners} runner${s.runners === 1 ? '' : 's'} left · ${plural(s.total, 'player')}` : plural(s.total, 'player');
    this._set('counts', e.counts, 'text', counts);
    this._set('tags', e.tags, 'html', `${s.tags}<small>TAGS</small>`);
    this._set('fps', e.fps, 'text', settings.data.graphics.showFps ? `${Math.round(extra.fps)} FPS${extra.resScale && extra.resScale < 1 ? ` · ${Math.round(extra.resScale * 100)}% res` : ''}` : '');
    this._set('net', e.net, 'text', s.net || '');

    // stamina & abilities
    this._set('stam', e.staminaI, 'width', `${Math.round(s.stamina * 100)}%`);
    const lowSt = s.stamina < 0.2;
    if (this.cache.lowSt !== lowSt) {
      this.cache.lowSt = lowSt;
      e.stamina.classList.toggle('low', lowSt);
    }
    for (const [k, el] of [['dodge', e.dodge], ['slide', e.slide]]) {
      const p = Math.max(0, Math.min(1, s[k]));
      const key = `ab${k}`;
      const v = Math.round(p * 100);
      if (this.cache[key] !== v) {
        this.cache[key] = v;
        el.querySelector('.ring').style.setProperty('--p', v);
        el.classList.toggle('ready', v >= 100);
      }
    }
    this._perfectHud(s);
    this._abilityHud(s);
    this._zoneHud(s);
    this._eventHud(s);
    let status = '';
    if (s.stunned) status = 'STUNNED — you got perfect-dodged!';
    else if (s.frozen) status = 'STUNNED — new IT';
    else if (s.protected) status = s.boostLeft > 0 ? 'UNTOUCHABLE' : 'SPAWN PROTECTION';
    else if (s.localOut) status = 'ELIMINATED';
    this._set('status', e.status, 'text', status);
    this._set('statusH', e.status, 'hidden', !status);
    const danger = !s.localIt && !s.localOut && s.arrow && s.arrow.threat && s.arrow.dist < 7 && !settings.data.accessibility.reduceFlashing;
    if (this.cache.danger !== danger) {
      this.cache.danger = danger;
      e.vignette.classList.toggle('on', !!danger);
    }

    // directional indicator
    if (s.arrow && s.phase === 'playing') {
      this._set('arrowH', e.arrow, 'hidden', false);
      const deg = (s.arrow.angle * 180) / Math.PI;
      e.arrowI.style.transform = `rotate(${deg.toFixed(1)}deg)`;
      const label = `${s.arrow.name} · ${Math.round(s.arrow.dist)}m`;
      this._set('arrowS', e.arrowS, 'text', label);
      if (this.cache.arrowT !== s.arrow.threat) {
        this.cache.arrowT = s.arrow.threat;
        e.arrow.classList.toggle('target', !s.arrow.threat);
      }
    } else {
      this._set('arrowH', e.arrow, 'hidden', true);
    }

    // scoreboard
    if (s.scoreboard) {
      const rows = s.scoreboard.map((r) => `<tr class="${r.me ? 'me' : ''}"><td>${esc(r.name)}${r.bot ? ' <span class="badge wait">BOT</span>' : ''}</td><td>${r.it ? '<span class="badge it">IT</span>' : r.out ? '<span class="badge wait">OUT</span>' : ''}</td><td>${r.tags}</td><td>${formatSeconds(r.itTime)}</td><td>${formatSeconds(r.survival)}</td></tr>`).join('');
      this._set('sb', e.scoreboard, 'html', `<table class="results"><tr><th>Player</th><th></th><th>Tags</th><th>Time as IT</th><th>Survived</th></tr>${rows}</table>`);
      this._set('sbH', e.scoreboard, 'hidden', false);
    } else {
      this._set('sbH', e.scoreboard, 'hidden', true);
    }
    this._set('lock', e.lockhint, 'hidden', !extra.showLockHint);
  }

  /** Perfect-dodge cue, boost meter, speed lines and the dodge key label. Called from update(). */
  _perfectHud(s) {
    const e = this.el;
    this._set('dodgeKey', e.dodgeLabel, 'text', s.dodgeKey ? `Dodge · ${s.dodgeKey}` : 'Dodge');
    const cue = s.dodgeCue;
    this._set('cueH', e.cue, 'hidden', !cue);
    if (cue) {
      // the approach ring shrinks onto the target ring: press dodge when they meet
      const k = Math.min(1, cue.ttc / 0.6);
      e.cueApproach.style.transform = `translate(-50%, -50%) scale(${(1 + k * 2.2).toFixed(3)})`;
      this._set('cueKey', e.cueKey, 'text', s.dodgeKey || 'Q');
      const now = cue.perfect && s.dodgeAssist;
      this._set('cueTxt', e.cueTxt, 'text', now ? 'NOW!' : 'DODGE');
      if (this.cache.cueP !== now) {
        this.cache.cueP = now;
        e.cue.classList.toggle('now', now);
      }
    }
    const boosting = s.boostLeft > 0;
    this._set('boostH', e.boostbar, 'hidden', !boosting);
    if (boosting) this._set('boostW', e.boostI, 'width', `${Math.round((s.boostLeft / s.boostTime) * 100)}%`);
    if (this.cache.lines !== boosting) {
      this.cache.lines = boosting;
      e.speedlines.classList.toggle('on', boosting && !settings.data.accessibility.reduceFlashing);
    }
  }

  /** Ability slots (icon, key, cooldown sweep), grapple crosshair, cloak overlay, coin counter. */
  _abilityHud(s) {
    const e = this.el;
    const abs = s.abilities || [];
    const sig = abs.map((a) => (a ? `${a.id}:${a.key}` : '-')).join('|');
    if (this.cache.absig !== sig) {
      this.cache.absig = sig;
      e.abslots.innerHTML = abs.some(Boolean)
        ? abs.map((a) => (a
          ? `<div class="abslot ready" style="--c:${ABILITY_INFO[a.id].color}"><div class="ico">${abilityIcon(a.id)}</div><div class="sweep"></div><b class="cdn"></b><span class="key">${esc(a.key)}</span></div>`
          : '<div class="abslot empty"><span class="key">—</span></div>')).join('')
        : '';
      this.slotEls = [...e.abslots.querySelectorAll('.abslot')];
      this.slotReady = abs.map(() => true);
      for (let i = 0; i < abs.length; i++) delete this.cache[`abp${i}`];
    }
    abs.forEach((a, i) => {
      const el = this.slotEls[i];
      if (!a || !el) return;
      const pv = Math.round((a.cd > 0 ? a.cd / a.max : 0) * 100);
      const key = `abp${i}`;
      if (this.cache[key] !== pv) {
        this.cache[key] = pv;
        el.style.setProperty('--p', pv);
        el.querySelector('.cdn').textContent = a.cd > 0 ? Math.ceil(a.cd) : '';
      }
      const ready = a.cd <= 0;
      if (this.slotReady[i] !== ready) {
        this.slotReady[i] = ready;
        el.classList.toggle('ready', ready);
        el.classList.remove('flash', 'used');
        void el.offsetWidth; // restart the animation
        el.classList.add(ready ? 'flash' : 'used');
        if (ready) audio.play('abilityReady');
      }
    });
    if (this.cache.grap !== s.grappleOk) {
      this.cache.grap = s.grappleOk;
      e.crosshair.classList.toggle('grapple', !!s.grappleOk);
    }
    if (this.cache.cloak !== s.cloaked) {
      this.cache.cloak = s.cloaked;
      e.cloakfx.classList.toggle('on', !!s.cloaked);
    }
    this._set('coinsN', e.coinsN, 'text', String(s.coinsGrabbed || 0));
  }

  /** Shrinking Zone: when the ring closes, how far it is, and a loud warning when you're outside. */
  _zoneHud(s) {
    const e = this.el;
    const z = s.zone;
    this._set('zoneH', e.zonebar, 'hidden', !z || s.phase !== 'playing');
    if (!z || s.phase !== 'playing') {
      // match over / next match: never leave the red "outside the ring" vignette behind
      if (this.cache.zOut) {
        this.cache.zOut = false;
        e.zonebar.classList.remove('out');
        e.vignette.classList.remove('zone');
      }
      return;
    }
    let text;
    if (z.outside) text = `GET IN THE RING! ${Math.max(0, z.limit - z.storm).toFixed(1)} s · ${Math.round(z.dist)} m`;
    else if (z.closingIn > 0) text = `Ring closes in ${Math.ceil(z.closingIn)} s`;
    else if (z.k < 1) text = `Ring closing · ${Math.round(z.r)} m wide`;
    else text = `Final ring · ${Math.round(z.r)} m`;
    this._set('zoneT', e.zoneText, 'text', text);
    if (this.cache.zOut !== z.outside) {
      this.cache.zOut = z.outside;
      e.zonebar.classList.toggle('out', z.outside);
      e.vignette.classList.toggle('zone', z.outside && !settings.data.accessibility.reduceFlashing);
    }
    e.zoneArrow.style.transform = `rotate(${((z.angle * 180) / Math.PI).toFixed(1)}deg)`;
    this._set('zArrowH', e.zoneArrow, 'hidden', !z.outside);
  }

  /** Map events (power outage, coin rain...): title + time left. */
  _eventHud(s) {
    const e = this.el;
    const ev = s.mapEvent;
    this._set('evH', e.eventbar, 'hidden', !ev);
    if (!ev) return;
    this._set('evT', e.eventTitle, 'text', `${ev.icon} ${ev.name}`);
    this._set('evS', e.eventText, 'text', ev.warning ? 'incoming…' : `${Math.ceil(ev.left)} s`);
    if (this.cache.evWarn !== !!ev.warning) {
      this.cache.evWarn = !!ev.warning;
      e.eventbar.classList.toggle('warn', !!ev.warning);
    }
  }

  coinPop({ value }) {
    const e = this.el;
    e.coinsPop.textContent = `+${value}`;
    e.coins.classList.remove('pop');
    void e.coins.offsetWidth;
    e.coins.classList.add('pop');
  }

  perfect({ title, sub = '', kind = 'hero', ms = 1500 }) {
    const e = this.el;
    e.perfectT.textContent = title;
    e.perfectT.dataset.text = title;
    e.perfectS.textContent = sub;
    e.perfect.className = `perfect ${kind}`;
    void e.perfect.offsetWidth; // restart the animation
    e.perfect.classList.add('show');
    e.speedlines.classList.toggle('burst', kind === 'hero' && !settings.data.accessibility.reduceFlashing);
    // hidden when the cinematic ends (frame-timed); the timer is only a safety net
    clearTimeout(this.perfectTimer);
    this.perfectTimer = setTimeout(() => this._hidePerfect(), ms + 4000);
  }

  _hidePerfect() {
    clearTimeout(this.perfectTimer);
    this.el.perfect.className = 'perfect hidden';
    this.el.speedlines.classList.remove('burst');
  }

  banner({ text, sub = '', color = '#fff', ms = 1600, big = false }) {
    const e = this.el;
    e.bannerT.textContent = text;
    e.bannerT.style.color = color;
    e.bannerS.textContent = sub;
    e.banner.classList.remove('hidden', 'show');
    e.banner.classList.toggle('big', big);
    void e.banner.offsetWidth; // restart animation
    e.banner.classList.add('show');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => e.banner.classList.add('hidden'), ms);
  }

  feed(f) {
    const div = document.createElement('div');
    if (f.kind === 'tag') {
      div.innerHTML = `${esc(f.a)} <b>tagged</b> ${esc(f.b)}`;
      if (f.mine) div.className = 'mine';
      if (f.me) div.className = 'me';
    } else {
      div.textContent = f.text;
    }
    this.el.feed.prepend(div);
    while (this.el.feed.children.length > 5) this.el.feed.lastChild.remove();
    setTimeout(() => div.remove(), 5000);
  }
}

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
