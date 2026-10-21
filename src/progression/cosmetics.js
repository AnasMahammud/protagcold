// Cosmetic catalogue. Cosmetics are purely visual: none of them change hitboxes, speed or
// visibility in a way that affects gameplay. Unlocks come from levels and achievements only
// (no purchases, no loot boxes).

const mat = (THREE, color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.1, ...extra });

export const HATS = {
  none: { name: 'None', unlock: { level: 1 } },
  cap: {
    name: 'Runner Cap',
    unlock: { level: 1 },
    build(THREE, c) {
      const g = new THREE.Group();
      const dome = new THREE.Mesh(new THREE.SphereGeometry(0.185, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), mat(THREE, c.secondary || '#222'));
      dome.position.y = -0.1;
      const brim = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.02, 0.17), mat(THREE, c.accent || '#3df5ff'));
      brim.position.set(0, -0.09, 0.2);
      g.add(dome, brim);
      return g;
    },
  },
  beanie: {
    name: 'Beanie',
    unlock: { level: 2 },
    build(THREE, c) {
      const g = new THREE.Group();
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.19, 16, 10, 0, Math.PI * 2, 0, Math.PI / 1.9), mat(THREE, c.accent || '#ff5a3d', { roughness: 0.95 }));
      b.position.y = -0.1;
      const pom = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), mat(THREE, '#f4f4f4', { roughness: 1 }));
      pom.position.y = 0.1;
      g.add(b, pom);
      return g;
    },
  },
  headphones: {
    name: 'Headphones',
    unlock: { level: 4 },
    build(THREE, c) {
      const g = new THREE.Group();
      const band = new THREE.Mesh(new THREE.TorusGeometry(0.19, 0.022, 6, 20, Math.PI), mat(THREE, '#1a1a1a'));
      band.rotation.y = Math.PI / 2;
      band.position.y = -0.14;
      g.add(band);
      for (const x of [-0.19, 0.19]) {
        const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.06, 14), mat(THREE, c.accent || '#3df5ff', { metalness: 0.4 }));
        cup.rotation.z = Math.PI / 2;
        cup.position.set(x, -0.16, 0);
        g.add(cup);
      }
      return g;
    },
  },
  mohawk: {
    name: 'Mohawk',
    unlock: { level: 6 },
    build(THREE, c) {
      const g = new THREE.Group();
      for (let i = 0; i < 5; i++) {
        const s = new THREE.Mesh(new THREE.ConeGeometry(0.04, 0.16, 5), mat(THREE, c.accent || '#ff3df0'));
        s.position.set(0, 0.02 - Math.abs(i - 2) * 0.02, -0.12 + i * 0.06);
        s.rotation.x = (i - 2) * 0.25;
        g.add(s);
      }
      return g;
    },
  },
  tophat: {
    name: 'Top Hat',
    unlock: { level: 8 },
    build(THREE) {
      const g = new THREE.Group();
      const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.24, 0.02, 20), mat(THREE, '#111'));
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.24, 20), mat(THREE, '#111'));
      top.position.y = 0.12;
      const band = new THREE.Mesh(new THREE.CylinderGeometry(0.152, 0.152, 0.04, 20), mat(THREE, '#b5382c'));
      band.position.y = 0.03;
      g.add(brim, top, band);
      g.position.y = -0.02;
      return g;
    },
  },
  horns: {
    name: 'Horns',
    unlock: { level: 10 },
    build(THREE) {
      const g = new THREE.Group();
      for (const s of [-1, 1]) {
        const h = new THREE.Mesh(new THREE.ConeGeometry(0.045, 0.2, 8), mat(THREE, '#f0e6d0'));
        h.position.set(s * 0.11, -0.02, 0.02);
        h.rotation.z = -s * 0.5;
        g.add(h);
      }
      return g;
    },
  },
  bunny: {
    name: 'Bunny Ears',
    unlock: { level: 12 },
    build(THREE, c) {
      const g = new THREE.Group();
      for (const s of [-1, 1]) {
        const e = new THREE.Mesh(new THREE.CapsuleGeometry(0.035, 0.22, 3, 8), mat(THREE, c.primary || '#fff'));
        e.position.set(s * 0.07, 0.1, 0);
        e.rotation.z = -s * 0.2;
        g.add(e);
      }
      return g;
    },
  },
  antenna: {
    name: 'Antenna',
    unlock: { level: 15 },
    build(THREE, c) {
      const g = new THREE.Group();
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.25, 5), mat(THREE, '#888', { metalness: 0.8 }));
      rod.position.y = 0.08;
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.035, 10, 8), new THREE.MeshBasicMaterial({ color: c.accent || '#3df5ff' }));
      ball.position.y = 0.22;
      g.add(rod, ball);
      return g;
    },
  },
  crown: {
    name: 'Champion Crown',
    unlock: { wins: 10 },
    build(THREE) {
      const g = new THREE.Group();
      const gold = mat(THREE, '#ffcc33', { metalness: 0.9, roughness: 0.25 });
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.08, 16, 1, true), gold);
      ring.material.side = THREE.DoubleSide;
      g.add(ring);
      for (let i = 0; i < 6; i++) {
        const sp = new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.09, 4), gold);
        const a = (i / 6) * Math.PI * 2;
        sp.position.set(Math.cos(a) * 0.15, 0.08, Math.sin(a) * 0.15);
        g.add(sp);
      }
      g.position.y = -0.02;
      return g;
    },
  },
  halo: {
    name: 'Untouchable Halo',
    unlock: { survival: 900 },
    build(THREE) {
      const m = new THREE.MeshBasicMaterial({ color: '#fff3a8' });
      m.toneMapped = false;
      const h = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.02, 8, 28), m);
      h.rotation.x = Math.PI / 2;
      h.position.y = 0.12;
      return h;
    },
  },
};

export const COLORS = [
  { id: 'ember', hex: '#ff5a3d', unlock: { level: 1 } },
  { id: 'sky', hex: '#3d9bff', unlock: { level: 1 } },
  { id: 'lime', hex: '#7dff6b', unlock: { level: 1 } },
  { id: 'snow', hex: '#e9edf5', unlock: { level: 1 } },
  { id: 'ink', hex: '#20242e', unlock: { level: 1 } },
  { id: 'sun', hex: '#ffd23d', unlock: { level: 2 } },
  { id: 'magenta', hex: '#ff3df0', unlock: { level: 3 } },
  { id: 'cyan', hex: '#3df5ff', unlock: { level: 3 } },
  { id: 'violet', hex: '#8a5cff', unlock: { level: 5 } },
  { id: 'mint', hex: '#3dffb0', unlock: { level: 7 } },
  { id: 'rose', hex: '#ff7aa8', unlock: { level: 9 } },
  { id: 'gold', hex: '#ffcc33', unlock: { level: 14 } },
  { id: 'crimson', hex: '#b5112c', unlock: { level: 18 } },
  { id: 'void', hex: '#0b0b10', unlock: { level: 20 } },
];

export const TRAILS = {
  none: { name: 'None', unlock: { level: 1 } },
  streak: { name: 'Speed Streak', unlock: { level: 2 }, style: 'ribbon' },
  sparks: { name: 'Sparks', unlock: { level: 5 }, style: 'sparks' },
  rainbow: { name: 'Prism', unlock: { level: 11 }, style: 'rainbow' },
  ember: { name: 'Ember', unlock: { tags: 100 }, style: 'ember' },
};

export const TAG_EFFECTS = {
  burst: { name: 'Burst', unlock: { level: 1 } },
  shockwave: { name: 'Shockwave', unlock: { level: 3 } },
  confetti: { name: 'Confetti', unlock: { level: 7 } },
  lightning: { name: 'Lightning', unlock: { level: 13 } },
};

export const EMOTES = {
  wave: { name: 'Wave', unlock: { level: 1 } },
  dance: { name: 'Groove', unlock: { level: 3 } },
  flex: { name: 'Flex', unlock: { level: 6 } },
};

export const DEFAULT_COSMETICS = {
  primary: '#ff5a3d',
  secondary: '#20242e',
  accent: '#3df5ff',
  hat: 'cap',
  trail: 'streak',
  tagEffect: 'burst',
};

/** Checks an unlock requirement against a profile. */
export function isUnlocked(unlock, profile) {
  if (!unlock) return true;
  if (unlock.level && profile.level < unlock.level) return false;
  if (unlock.wins && profile.stats.wins < unlock.wins) return false;
  if (unlock.tags && profile.stats.tags < unlock.tags) return false;
  if (unlock.survival && profile.stats.survival < unlock.survival) return false;
  return true;
}

export function describeUnlock(unlock) {
  if (!unlock) return '';
  if (unlock.level) return `Reach level ${unlock.level}`;
  if (unlock.wins) return `Win ${unlock.wins} matches`;
  if (unlock.tags) return `Make ${unlock.tags} tags`;
  if (unlock.survival) return `Survive ${Math.round(unlock.survival / 60)} minutes in total`;
  return '';
}

/** Validate a cosmetics object (used for remote players too: never trust unknown values). */
export function sanitizeCosmetics(c) {
  const hex = (v, d) => (typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v) ? v : d);
  return {
    primary: hex(c?.primary, DEFAULT_COSMETICS.primary),
    secondary: hex(c?.secondary, DEFAULT_COSMETICS.secondary),
    accent: hex(c?.accent, DEFAULT_COSMETICS.accent),
    hat: HATS[c?.hat] ? c.hat : 'none',
    trail: TRAILS[c?.trail] ? c.trail : 'none',
    tagEffect: TAG_EFFECTS[c?.tagEffect] ? c.tagEffect : 'burst',
  };
}

/** Random-but-pleasant bot outfits. */
export function randomCosmetics(rng = Math.random) {
  const pick = (arr) => arr[Math.floor(rng() * arr.length)];
  const cols = COLORS.map((c) => c.hex);
  const primary = pick(cols.filter((c) => c !== '#20242e' && c !== '#0b0b10'));
  return {
    primary,
    secondary: pick(['#20242e', '#e9edf5', '#2a3550', '#15171c']),
    accent: pick(['#3df5ff', '#ff3df0', '#ffd23d', '#7dff6b', '#ffffff']),
    hat: pick(['none', 'cap', 'beanie', 'headphones', 'mohawk', 'tophat', 'horns', 'bunny', 'antenna']),
    trail: pick(['none', 'streak', 'sparks']),
    tagEffect: pick(['burst', 'shockwave', 'confetti']),
  };
}
