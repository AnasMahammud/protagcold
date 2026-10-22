// PRO TAG browser test suite. Open http://localhost:8080/tests/browser/ with the server running.
// Results are rendered on the page and exposed as window.__TEST_RESULTS__ for automation.
import * as THREE from 'three';
import { setConfig } from '../../src/core/config.js';
import { CollisionWorld } from '../../src/movement/collision.js';
import { CharacterController, MS } from '../../src/movement/controller.js';
import * as R from '../../src/gameplay/rules.js';
import { NavGraph, LINK } from '../../src/ai/navGraph.js';
import { BotBrain } from '../../src/ai/bot.js';
import { computeXp, computeCoins } from '../../src/progression/progression.js';

const out = document.getElementById('out');
const results = [];
const suites = [];
let current = null;
function suite(name, fn) {
  suites.push({ name, fn });
}
function test(name, fn) {
  current.tests.push({ name, fn });
}
class Fail extends Error {}
function expect(cond, msg) {
  if (!cond) throw new Fail(msg);
}
function near(a, b, tol, msg) {
  if (!(Math.abs(a - b) <= tol)) throw new Fail(`${msg}: expected ${b} ± ${tol}, got ${a}`);
}

const cfg = await (await fetch('../../config/game.json')).json();
setConfig(cfg);
const M = cfg.movement;
const DT = 1 / 60;

// --------------------------------------------------------------------------- test arena
function testMap() {
  const solids = [
    { b: [-60, -1, -60, 60, 0, 60], m: 'concrete' },
    { b: [10, 0, -5, 10.5, 4, 5], m: 'concrete' }, // tall thin wall
    { b: [-10, 0, -21, -8.8, 1.0, -15], m: 'concrete' }, // vault box (1.0 high, 1.2 deep)
    { b: [20, 0, -10, 24, 2.4, 10], m: 'concrete' }, // mantle ledge (2.4)
    { b: [-20, 1.05, 10, -14, 1.4, 10.4], m: 'pipe' }, // slide bar
    { b: [-20.5, 0, 8, -20, 3, 12], m: 'concrete' },
    { b: [-14, 0, 8, -13.5, 3, 12], m: 'concrete' },
    { b: [30, 0, 20, 34, 3, 30], m: 'metal', ramp: '+z', lo: 0 },
    { b: [-40, 0, 30, -30, 2, 40], m: 'concrete' }, // raised platform (coyote test)
    { b: [0, 0, 27.2, 3, 3.2, 30], m: 'concrete' }, // stair landing
  ];
  for (let i = 0; i < 8; i++) solids.push({ b: [0, 0, 20 + 0.9 * i, 3, 0.4 * (i + 1), 27.2], m: 'concrete' });
  return { id: 'test', bounds: [-50, -50, 50, 50], killY: -12, solids, pads: [{ p: [0, 0, -30], v: [0, 17.5, 0], r: 0.9 }], spawns: [[0, 0, 0]] };
}
const world = new CollisionWorld(testMap());
const I = (mx = 0, mz = 0, extra = {}) => ({ mx, mz, jumpPressed: false, jumpHeld: false, sprint: false, slidePressed: false, dodgePressed: false, vaultPressed: false, ...extra });
function ctrlAt(x, y, z, yaw = 0) {
  const c = new CharacterController(world, M);
  c.teleport(x, y, z, yaw);
  return c;
}
function run(c, seconds, inputFn, each) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    c.step(inputFn(i * DT, i), DT);
    if (each && each(c, i) === false) return i;
  }
  return n;
}
const hasEvent = (c, type) => c.events.some((e) => e.type === type);
// apex of a jump integrated at 60 Hz (semi-implicit Euler is ~v*dt/2 lower than v^2/2g)
const discreteApex = () => (M.jumpVelocity * M.jumpVelocity) / (2 * M.gravity) - (M.jumpVelocity * DT) / 2;

// --------------------------------------------------------------------------- movement
suite('Movement & collision', () => {
  test('stands still on flat ground', () => {
    const c = ctrlAt(0, 0, 0);
    run(c, 1, () => I());
    expect(c.grounded, 'grounded');
    near(c.pos.y, 0, 1e-6, 'y');
  });
  test('accelerates smoothly to run speed', () => {
    const c = ctrlAt(0, 0, 40);
    let t1 = null;
    run(c, 1.2, () => I(0, -1), (cc, i) => {
      if (t1 === null && cc.horizontalSpeed >= M.runSpeed - 0.01) t1 = i * DT;
    });
    near(c.horizontalSpeed, M.runSpeed, 0.05, 'run speed');
    expect(t1 !== null && t1 > 0.05 && t1 < 0.3, `reaches run speed quickly but not instantly (${t1})`);
  });
  test('sprint is faster and drains stamina, regenerates afterwards', () => {
    const c = ctrlAt(-40, 0, 45);
    run(c, 2, () => I(1, 0, { sprint: true }));
    near(c.horizontalSpeed, M.sprintSpeed, 0.05, 'sprint speed');
    expect(c.stamina < M.staminaMax - 30, `stamina drained (${c.stamina})`);
    const s = c.stamina;
    run(c, 3, () => I());
    expect(c.stamina > s + 20, 'stamina regenerates');
  });
  test('stamina runs out: sprint stops', () => {
    const c = ctrlAt(-45, 0, -45);
    let slowAfterEmpty = false;
    run(c, 7, (t) => I(Math.cos(t), Math.sin(t), { sprint: true }), (cc) => {
      if (cc.stamina === 0 && !cc.sprinting) slowAfterEmpty = true;
    });
    expect(slowAfterEmpty, 'sprinting stops when stamina hits zero');
  });
  test('jump reaches the expected apex and lands', () => {
    const c = ctrlAt(0, 0, 40);
    let maxY = 0;
    let landed = false;
    run(c, 1.2, (t, i) => I(0, 0, { jumpPressed: i === 0, jumpHeld: true }), (cc) => {
      maxY = Math.max(maxY, cc.pos.y);
      if (hasEvent(cc, 'land')) landed = true;
      cc.events.length = 0;
    });
    near(maxY, discreteApex(), 0.03, 'apex');
    expect(landed && c.grounded, 'landed');
  });
  test('tapping jump gives a lower jump (variable height)', () => {
    const c = ctrlAt(0, 0, 40);
    let maxY = 0;
    run(c, 1, (t, i) => I(0, 0, { jumpPressed: i === 0, jumpHeld: i < 4 }), (cc) => {
      maxY = Math.max(maxY, cc.pos.y);
    });
    expect(maxY < 1.3 && maxY > 0.5, `short hop apex ${maxY}`);
  });
  test('no double jump in mid-air', () => {
    const c = ctrlAt(0, 0, 40);
    let maxY = 0;
    run(c, 1.3, (t, i) => I(0, 0, { jumpPressed: i === 0 || i === 20 || i === 30, jumpHeld: true }), (cc) => {
      maxY = Math.max(maxY, cc.pos.y);
    });
    near(maxY, discreteApex(), 0.03, 'apex unchanged by extra presses');
  });
  test('coyote time: can still jump just after running off a ledge', () => {
    const c = ctrlAt(-33, 2, 35, -Math.PI / 2);
    let leftAt = -1;
    let jumped = false;
    run(c, 2, (t, i) => I(1, 0, { jumpPressed: leftAt >= 0 && i === leftAt + 4, jumpHeld: true }), (cc, i) => {
      if (leftAt < 0 && !cc.grounded) leftAt = i;
      if (leftAt >= 0 && i > leftAt + 4 && cc.vel.y > 5) jumped = true;
    });
    expect(leftAt > 0, 'ran off the ledge');
    expect(jumped, 'jump accepted during coyote time');
  });
  test('jump buffer: pressing just before landing still jumps', () => {
    const c = ctrlAt(0, 3, 40);
    let pressedAt = -1;
    let jumped = false;
    run(c, 2, (t, i) => {
      const press = pressedAt < 0 && c.pos.y < 0.45 && c.vel.y < 0;
      if (press) pressedAt = i;
      return I(0, 0, { jumpPressed: press, jumpHeld: true });
    }, (cc, i) => {
      if (pressedAt >= 0 && i < pressedAt + 15 && cc.vel.y > 5) jumped = true;
    });
    expect(pressedAt > 0, 'pressed in the air');
    expect(jumped, 'buffered jump fired on landing');
  });
  test('cannot walk through a solid wall (even sprinting)', () => {
    const c = ctrlAt(5, 0, 0);
    let maxX = -1e9;
    run(c, 2.5, () => I(1, 0, { sprint: true }), (cc) => {
      maxX = Math.max(maxX, cc.pos.x);
    });
    expect(maxX <= 10 - M.radius + 0.01, `max x ${maxX}`);
  });
  test('no tunnelling through a thin wall at extreme speed', () => {
    const c = ctrlAt(5, 0, 0);
    c.vel.x = 80;
    run(c, 0.3, () => I());
    expect(c.pos.x < 10, `x ${c.pos.x}`);
  });
  test('walks up stairs', () => {
    const c = ctrlAt(1.5, 0, 18);
    run(c, 1.6, () => I(0, 1));
    near(c.pos.y, 3.2, 0.02, 'top of stairs');
    expect(c.grounded, 'grounded on landing');
  });
  test('walks up a ramp', () => {
    const c = ctrlAt(32, 0, 16);
    let maxY = 0;
    let airborne = 0;
    run(c, 1.9, () => I(0, 1), (cc) => {
      maxY = Math.max(maxY, cc.pos.y);
      if (!cc.grounded) airborne++;
    });
    expect(maxY > 2.0, `climbed the ramp (${maxY})`);
    expect(airborne < 3, `stays grounded on the slope (${airborne} airborne steps)`);
  });
  test('slide: boosts speed, lowers the body, then recovers', () => {
    const c = ctrlAt(-45, 0, 45);
    run(c, 1, () => I(1, 0));
    run(c, 0.05, (t, i) => I(1, 0, { slidePressed: i === 0 }));
    expect(c.state === MS.SLIDE, 'is sliding');
    expect(c.horizontalSpeed > M.runSpeed + 1, `boosted (${c.horizontalSpeed})`);
    near(c.height, M.slideHeight, 1e-6, 'height');
    run(c, 1.5, () => I(1, 0));
    expect(c.state === MS.GROUND && c.height === M.height, 'recovered to running');
  });
  test('slide passes under a low bar; running does not', () => {
    const a = ctrlAt(-17, 0, 16, 0);
    run(a, 0.65, () => I(0, -1));
    run(a, 2, (t, i) => I(0, -1, { slidePressed: i === 0 }));
    expect(a.pos.z < 9.5, `slid under (z=${a.pos.z})`);
    const b = ctrlAt(-17, 0, 16, 0);
    run(b, 3, () => I(0, -1));
    expect(b.pos.z >= 10.4 + M.radius - 0.02, `blocked without sliding (z=${b.pos.z})`);
  });
  test('vault over a low obstacle without passing through it', () => {
    const c = ctrlAt(-16, 0, -18, -Math.PI / 2);
    let vaulted = false;
    let clipped = false;
    run(c, 2, () => I(1, 0), (cc) => {
      if (cc.state === MS.VAULT) vaulted = true;
      if (!world.isFree(cc.pos.x, cc.pos.y + 0.02, cc.pos.z, M.radius * 0.5, 0.5)) clipped = true;
    });
    expect(vaulted, 'vault triggered');
    expect(!clipped, 'body never inside the obstacle');
    expect(c.pos.x > -8.8 + M.radius, `ended beyond the obstacle (x=${c.pos.x})`);
    near(c.pos.y, 0, 0.01, 'back on the ground');
  });
  test('mantle onto a 2.4 m ledge by jumping at it', () => {
    const c = ctrlAt(16, 0, 0, -Math.PI / 2);
    let mantled = false;
    let onTop = false;
    run(c, 1.5, (t) => I(1, 0, { jumpPressed: Math.abs(t - 0.35) < DT / 2, jumpHeld: true }), (cc) => {
      if (cc.state === MS.MANTLE) mantled = true;
      if (mantled && cc.grounded && Math.abs(cc.pos.y - 2.4) < 0.01) onTop = true;
      return !onTop; // stop as soon as we stand on top (otherwise we run off the far side)
    });
    expect(mantled, 'mantle triggered');
    expect(onTop, `standing on the ledge (y=${c.pos.y})`);
  });
  test('cannot climb a 4 m wall', () => {
    const c = ctrlAt(8, 0, 2, -Math.PI / 2);
    run(c, 2, (t, i) => I(1, 0, { jumpPressed: i === 10, jumpHeld: true }));
    expect(c.pos.x < 10 && c.pos.y < 0.1, `still below (x=${c.pos.x}, y=${c.pos.y})`);
  });
  test('wall jump: works off a wall, limited count', () => {
    const c = ctrlAt(8.5, 0, 0, -Math.PI / 2);
    let wallJumps = 0;
    run(c, 1.2, (t, i) => I(1, 0, { jumpPressed: i === 0 || i === 12 || i === 24 || i === 36 || i === 48, jumpHeld: true }), (cc) => {
      for (const e of cc.events) if (e.type === 'walljump') wallJumps++;
      cc.events.length = 0;
    });
    expect(wallJumps >= 1, 'at least one wall jump');
    expect(wallJumps <= M.maxWallJumps, `at most ${M.maxWallJumps} (${wallJumps})`);
  });
  test('dodge: quick sidestep with a cooldown', () => {
    const c = ctrlAt(0, 0, 10);
    run(c, M.dodgeDuration, (t, i) => I(1, 0, { dodgePressed: i === 0 }));
    expect(c.pos.x > M.dodgeSpeed * M.dodgeDuration * 0.75, `moved ${c.pos.x}`);
    c.events.length = 0;
    run(c, 0.2, (t, i) => I(1, 0, { dodgePressed: i === 0 }));
    expect(!hasEvent(c, 'dodge'), 'second dodge blocked by cooldown');
  });
  test('jump pad launches the player', () => {
    const c = ctrlAt(0, 0, -30);
    run(c, DT, () => I());
    expect(hasEvent(c, 'pad'), 'pad event');
    expect(c.vel.y > 15, `launched (${c.vel.y})`);
  });
  test('map bounds cannot be left', () => {
    const c = ctrlAt(45, 0, 45);
    run(c, 3, () => I(1, 1, { sprint: true }));
    expect(c.pos.x <= 50 - M.radius + 1e-6 && c.pos.z <= 50 - M.radius + 1e-6, `pos ${c.pos.x},${c.pos.z}`);
  });
  test('frozen players cannot move', () => {
    const c = ctrlAt(0, 0, 40);
    c.frozen = true;
    run(c, 1, () => I(1, 0, { sprint: true, jumpPressed: true }));
    near(c.pos.x, 0, 1e-6, 'x');
    near(c.pos.y, 0, 1e-6, 'y');
  });
});

// --------------------------------------------------------------------------- rules parity
suite('Rules (shared cases, parity with server)', async () => {
  const { cases } = await (await fetch('../shared/rules_cases.json')).json();
  for (const kase of cases) {
    test(kase.name, () => {
      const c = kase.create;
      const st = R.createMatch({ mode: c.mode, players: c.players.map((p) => ({ id: p, name: p.toUpperCase() })), startIt: c.it, cfg, countdown: c.countdown, zone: c.zone });
      kase.steps.forEach((step, i) => {
        const where = `step ${i} ${JSON.stringify(step)}`;
        if ('tick' in step) R.tick(st, step.tick);
        if (step.tag) {
          const res = R.applyTag(st, step.tag[0], step.tag[1]);
          const e = step.expect || {};
          if ('ok' in e) expect(res.ok === e.ok, `${where}: ok=${res.ok} reason=${res.reason}`);
          if ('reason' in e) expect(res.reason === e.reason, `${where}: reason=${res.reason}`);
          return;
        }
        if (step.perfectDodge) {
          const res = R.perfectDodge(st, step.perfectDodge[0], step.perfectDodge[1], step.opts || {});
          const e = step.expect || {};
          if ('ok' in e) expect(res.ok === e.ok, `${where}: ok=${res.ok} reason=${res.reason}`);
          if ('reason' in e) expect(res.reason === e.reason, `${where}: reason=${res.reason}`);
          return;
        }
        if (step.collectCoin) {
          const got = R.collectCoin(st, step.collectCoin);
          if (step.expect && 'ok' in step.expect) expect(got === step.expect.ok, `${where}: collect=${got}`);
          return;
        }
        if (step.zone) R.zoneTick(st, step.zone[0], step.zone[1], step.zone[2]);
        if (step.join) R.addPlayer(st, step.join);
        if (step.leave) R.removePlayer(st, step.leave);
        if (step.protect) R.protect(st, step.protect);
        if (step.forceIt) R.forceIt(st, step.forceIt);
        const e = step.expect;
        if (!e) return;
        const ps = Object.values(st.players);
        if (e.it) expect(JSON.stringify(ps.filter((p) => p.it && !p.out && p.connected).map((p) => p.id).sort()) === JSON.stringify([...e.it].sort()), `${where}: it`);
        if (e.out) expect(JSON.stringify(ps.filter((p) => p.out).map((p) => p.id).sort()) === JSON.stringify([...e.out].sort()), `${where}: out`);
        if (e.phase) expect(st.phase === e.phase, `${where}: phase=${st.phase}`);
        if (e.endReason) expect(st.result?.reason === e.endReason, `${where}: reason=${st.result?.reason}`);
        if (e.winners) expect(JSON.stringify([...st.result.winners].sort()) === JSON.stringify([...e.winners].sort()), `${where}: winners=${st.result.winners}`);
        if (e.team) expect(st.result.team === e.team, `${where}: team`);
        if (e.tags) for (const [id, n] of Object.entries(e.tags)) expect(st.players[id].tags === n, `${where}: tags ${id}`);
        if (e.itTime) for (const [id, v] of Object.entries(e.itTime)) near(st.players[id].itTime, v, 0.01, `${where}: itTime ${id}`);
        if (e.coins) for (const [id, n] of Object.entries(e.coins)) expect(st.players[id].coinsPicked === n, `${where}: coins ${id}`);
        if (e.dodges) for (const [id, n] of Object.entries(e.dodges)) expect(st.players[id].perfectDodges === n, `${where}: dodges ${id}`);
        if (e.boost) for (const [id, v] of Object.entries(e.boost)) near(Math.max(0, st.players[id].boostUntil - st.time), v, 0.01, `${where}: boost ${id}`);
        if (e.potato) for (const [k, v] of Object.entries(e.potato)) near(st.potato[k], v, 0.01, `${where}: potato.${k}`);
        if (e.storm) for (const [id, v] of Object.entries(e.storm)) near(st.players[id].stormTime, v, 0.01, `${where}: storm ${id}`);
        if (e.zoneAt) {
          const z = R.zoneAt(st, e.zoneAt.t);
          for (const k of ['x', 'z', 'r']) near(z[k], e.zoneAt[k], 0.01, `${where}: zone.${k}`);
        }
        if ('tagCount' in e) expect(st.tagCount === e.tagCount, `${where}: tagCount=${st.tagCount}`);
        if (e.ranking) expect(JSON.stringify(st.result.ranking.map((r) => r.id)) === JSON.stringify(e.ranking), `${where}: ranking=${st.result.ranking.map((r) => r.id)}`);
        if (e.coinAward) for (const [id, v] of Object.entries(e.coinAward)) expect(computeCoins(st.result, id, cfg.coins).coins === v, `${where}: coins ${id}=${computeCoins(st.result, id, cfg.coins).coins}`);
        if (e.xp) for (const [id, v] of Object.entries(e.xp)) expect(computeXp(st.result, id, cfg.progression).total === v, `${where}: xp ${id}=${computeXp(st.result, id, cfg.progression).total}`);
      });
    });
  }
});

// --------------------------------------------------------------------------- maps & navigation
const mapIndex = (await (await fetch('../../assets/maps/index.json')).json()).maps;
const maps = {};
for (const m of mapIndex) {
  const data = await (await fetch(`../../assets/maps/${m.id}.json`)).json();
  const w = new CollisionWorld(data);
  maps[m.id] = { data, world: w, nav: null };
}
const navFor = (id) => maps[id].nav || (maps[id].nav = new NavGraph(maps[id].world, M));

suite('Maps & navigation QA', () => {
  test(`at least 3 playable arenas (${mapIndex.length})`, () => expect(mapIndex.length >= 3, 'map count'));
  for (const id of Object.keys(maps)) {
    const { data, world: w } = maps[id];
    test(`${id}: spawns are free, grounded and inside bounds`, () => {
      for (const s of data.spawns) {
        expect(w.isFree(s[0], s[1] + 0.02, s[2], M.radius, M.height), `spawn ${s} blocked`);
        const g = w.groundBelow(s[0], s[2], M.radius * 0.6, s[1] + 0.05);
        expect(g && Math.abs(g.y - s[1]) < 0.01, `spawn ${s} not on ground`);
      }
    });
    test(`${id}: navigation graph connects every spawn (both ways)`, () => {
      const nav = navFor(id);
      expect(nav.nodes.length > 200, `nodes ${nav.nodes.length}`);
      const ids = data.spawns.map((s) => nav.nearest(s[0], s[1], s[2], 2)?.id);
      expect(ids.every((x) => x != null), 'every spawn has a nav node');
      const from0 = nav.reachableFrom(ids[0]);
      for (const sid of ids) {
        expect(from0.has(sid), `spawn node ${sid} unreachable from spawn 0`);
        expect(nav.reachableFrom(sid).has(ids[0]), `spawn 0 unreachable from ${sid}`);
      }
    });
    test(`${id}: every jump pad lands somewhere walkable`, () => {
      const nav = navFor(id);
      const padLinks = nav.nodes.flatMap((n) => n.links.filter((l) => l.type === LINK.PAD));
      expect(padLinks.length === (data.pads || []).length, `pads ${data.pads?.length || 0}, pad links ${padLinks.length}`);
    });
    test(`${id}: 60 s random-movement stress (no escapes, no wall clipping, no falling out)`, () => {
      let rng = 12345;
      const rand = () => ((rng = (rng * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      const ctrls = data.spawns.slice(0, 8).map((s) => {
        const c = new CharacterController(w, M);
        c.teleport(s[0], s[1], s[2]);
        return { c, inp: I() };
      });
      const [bx0, bz0, bx1, bz1] = w.bounds;
      for (let i = 0; i < 3600; i++) {
        for (const o of ctrls) {
          if (i % 30 === 0) {
            const a = rand() * Math.PI * 2;
            o.inp = I(Math.cos(a), Math.sin(a), { sprint: rand() < 0.5, jumpHeld: true });
          }
          o.inp.jumpPressed = rand() < 0.03;
          o.inp.slidePressed = rand() < 0.01;
          o.inp.dodgePressed = rand() < 0.005;
          o.inp.vaultPressed = rand() < 0.01;
          o.c.step(o.inp, DT);
          const p = o.c.pos;
          expect(p.x >= bx0 && p.x <= bx1 && p.z >= bz0 && p.z <= bz1, `left bounds at ${p.x},${p.z}`);
          expect(p.y > w.killY, `fell out at ${p.x},${p.y},${p.z}`);
          expect(w.isFree(p.x, p.y + 0.3, p.z, M.radius * 0.5, 0.55), `inside solid at ${p.x.toFixed(2)},${p.y.toFixed(2)},${p.z.toFixed(2)} state=${o.c.state}`);
          o.c.events.length = 0;
        }
      }
    });
  }
});

// --------------------------------------------------------------------------- bots
function farthestSpawns(data) {
  let best = [0, 1];
  let bd = 0;
  data.spawns.forEach((a, i) => data.spawns.forEach((b, j) => {
    const d = Math.hypot(a[0] - b[0], a[2] - b[2]) + Math.abs(a[1] - b[1]);
    if (d > bd) { bd = d; best = [i, j]; }
  }));
  return best;
}

suite('Bots', () => {
  for (const id of Object.keys(maps)) {
    test(`${id}: a normal bot chases down a runner across the whole map`, () => {
      const { data, world: w } = maps[id];
      const nav = navFor(id);
      const [i, j] = farthestSpawns(data);
      const ctrl = new CharacterController(w, M);
      ctrl.teleport(...data.spawns[i]);
      const me = { id: 'bot', ctrl };
      const brain = new BotBrain(me, nav, cfg.bots.normal, 7);
      const target = { x: data.spawns[j][0], y: data.spawns[j][1], z: data.spawns[j][2] };
      brain.known.set('t', { ...target, vx: 0, vz: 0, t: 0 });
      const ctx = { world: w, phase: 'playing', players: [
        { id: 'bot', pos: ctrl.pos, vel: ctrl.vel, it: true, out: false, protected: false, frozen: false },
        { id: 't', pos: target, vel: { x: 0, y: 0, z: 0 }, it: false, out: false, protected: false, frozen: false },
      ] };
      let caughtAt = null;
      for (let k = 0; k < 60 * 60; k++) {
        const inp = brain.update(DT, ctx);
        ctrl.step(inp, DT);
        ctrl.events.length = 0;
        if (Math.hypot(ctrl.pos.x - target.x, ctrl.pos.z - target.z) < cfg.tag.range && Math.abs(ctrl.pos.y - target.y) < 1.7) {
          caughtAt = k * DT;
          break;
        }
      }
      expect(caughtAt !== null, `did not reach the runner within 60 s (ended at ${ctrl.pos.x.toFixed(1)},${ctrl.pos.y.toFixed(1)},${ctrl.pos.z.toFixed(1)})`);
      current.note = `caught after ${caughtAt.toFixed(1)} s`;
    });
  }
  test('rooftops: a bot boxed in behind an obstacle recovers and reaches its goal', () => {
    const { world: w } = maps.rooftops;
    const nav = navFor('rooftops');
    const ctrl = new CharacterController(w, M);
    // start pressed against the west face of the central tower, goal on the far side
    ctrl.teleport(-3.5, 0, 0, Math.PI / 2);
    const me = { id: 'bot', ctrl };
    const brain = new BotBrain(me, nav, cfg.bots.easy, 3);
    const target = { x: 5, y: 0, z: 0 };
    brain.known.set('t', { ...target, vx: 0, vz: 0, t: 0 });
    const ctx = { world: w, phase: 'playing', players: [
      { id: 'bot', pos: ctrl.pos, vel: ctrl.vel, it: true, out: false, protected: false, frozen: false },
      { id: 't', pos: target, vel: { x: 0, y: 0, z: 0 }, it: false, out: false, protected: false, frozen: false },
    ] };
    let ok = false;
    for (let k = 0; k < 60 * 30; k++) {
      ctrl.step(brain.update(DT, ctx), DT);
      ctrl.events.length = 0;
      if (Math.hypot(ctrl.pos.x - target.x, ctrl.pos.z - target.z) < cfg.tag.range) { ok = true; break; }
    }
    expect(ok, 'bot reached the goal around the tower');
  });
});

// --------------------------------------------------------------------------- zones, conveyors, water slides
function zoneMap() {
  return {
    id: 'zones', bounds: [-50, -50, 50, 50], killY: -12, spawns: [[0, 0, 0]], pads: [],
    solids: [
      { b: [-60, -1, -60, 60, 0, 60], m: 'concrete' },
      { b: [-3, 0, 27, 3, 5, 31], m: 'concrete' }, // slide start deck
    ],
    zones: [
      { k: 'water', b: [-45, -0.3, -45, -15, 0.9, -15], s: 0.72 },
      { k: 'conveyor', b: [15, -0.2, -5, 45, 0.5, 5], v: [3, 0] },
    ],
    rides: [{ pts: [[0, 5, 30], [0, 4.2, 34], [0, 2.5, 40], [0, 1, 46], [0, 0.6, 50]], r: 1.1, vmax: 14 }],
  };
}
const zw = new CollisionWorld(zoneMap());
const zctrl = (x, y, z) => {
  const c = new CharacterController(zw, M);
  c.teleport(x, y, z, 0);
  return c;
};
/** Ride a slide from its entry until the rider lands; returns what happened. */
function rideIt(w, r) {
  const c = new CharacterController(w, M);
  const e = r.pts[0];
  c.teleport(e.x, e.y, e.z, 0);
  let rode = false, ended = false, t = 0;
  for (let i = 0; i < 60 * 30; i++) {
    c.step(I(), DT);
    t += DT;
    if (c.state === MS.RIDE) rode = true;
    if (hasEvent(c, 'ride_end')) ended = true;
    c.events.length = 0;
    if (ended && c.grounded) break;
  }
  return { c, rode, ended, t };
}

suite('Zones, conveyors & water slides', () => {
  test('water slows you down to its speed factor', () => {
    const dry = zctrl(-10, 0, 10);
    const wet = zctrl(-40, 0, -30);
    run(dry, 1.5, () => I(1, 0));
    run(wet, 1.5, () => I(1, 0));
    near(wet.horizontalSpeed / dry.horizontalSpeed, 0.72, 0.03, 'speed ratio in water');
    expect(wet.zone && wet.zone.k === 'water', 'controller reports the water zone');
  });
  test('a conveyor carries you along (and an Overdrive event reverses it)', () => {
    const c = zctrl(20, 0, 0);
    run(c, 1, () => I());
    near(c.pos.x, 23, 0.1, 'carried +x at 3 m/s');
    zw.conveyorScale = -2;
    run(c, 1, () => I());
    zw.conveyorScale = 1;
    near(c.pos.x, 17, 0.1, 'carried back at 6 m/s');
  });
  test('stepping onto a slide rides it end to end and shoots you out', () => {
    const r = zw.rides[0];
    const { c, rode, ended, t } = rideIt(zw, r);
    expect(rode && ended, `rode ${rode}, ended ${ended}`);
    expect(c.grounded && c.state !== MS.RIDE, 'landed after the ride');
    expect(c.pos.z > 49, `came out at the end (${c.pos.z.toFixed(2)})`);
    expect(t < r.len / 5 + 1.5, `ride took ${t.toFixed(2)} s for ${r.len.toFixed(1)} m`);
    current.note = `${r.len.toFixed(1)} m in ${t.toFixed(2)} s`;
  });
  test('Slide Rush (rideScale) makes slides faster; abilities cannot interrupt a ride', () => {
    const r = zw.rides[0];
    const slow = rideIt(zw, r).t;
    zw.rideScale = 1.5;
    const fast = rideIt(zw, r).t;
    zw.rideScale = 1;
    expect(fast < slow, `faster (${fast.toFixed(2)} < ${slow.toFixed(2)} s)`);
    const c = zctrl(0, 5, 30);
    c.step(I(), DT);
    expect(c.state === MS.RIDE, 'riding');
    const y = c.pos.y;
    c.rocket(20, 5);
    c.step(I(), DT);
    expect(c.state === MS.RIDE && c.pos.y <= y, 'rocket jump ignored mid-ride');
  });
  test('low gravity jumps higher; wet floors take longer to stop', () => {
    const c = zctrl(0, 0, -10);
    c.gravityScale = 0.45;
    let maxY = 0;
    run(c, 2.5, (t, i) => I(0, 0, { jumpPressed: i === 0, jumpHeld: true }), (cc) => { maxY = Math.max(maxY, cc.pos.y); });
    expect(maxY > discreteApex() * 1.8, `apex ${maxY.toFixed(2)} vs ${discreteApex().toFixed(2)}`);
    const stopDist = (traction) => {
      const k = zctrl(-10, 0, 10);
      k.traction = traction;
      run(k, 1.2, () => I(1, 0));
      const x = k.pos.x;
      run(k, 2, () => I());
      return k.pos.x - x;
    };
    const dry = stopDist(1), wet = stopDist(0.22);
    expect(wet > dry * 2, `slides further when wet (${wet.toFixed(2)} vs ${dry.toFixed(2)} m)`);
  });
  for (const id of Object.keys(maps).filter((k) => maps[k].world.rides.length)) {
    test(`${id}: every slide can be ridden end to end and lands somewhere safe`, () => {
      const w = maps[id].world;
      const [bx0, bz0, bx1, bz1] = w.bounds;
      for (const r of w.rides) for (const scale of [1, 1.5]) {
        w.rideScale = scale; // 1.5 = the Slide Rush event
        const { c, rode, ended } = rideIt(w, r);
        w.rideScale = 1;
        const at = `slide ${r.id} x${scale} (${c.pos.x.toFixed(1)}, ${c.pos.y.toFixed(1)}, ${c.pos.z.toFixed(1)})`;
        expect(rode && ended && c.grounded, `${at}: rode ${rode}, ended ${ended}, grounded ${c.grounded}`);
        expect(c.pos.y < r.pts[0].y - 2 && c.pos.y > w.killY, `${at}: came down`);
        expect(c.pos.x > bx0 && c.pos.x < bx1 && c.pos.z > bz0 && c.pos.z < bz1, `${at}: inside the map`);
        expect(!insideSolid(w, c), `${at}: not inside a wall`);
      }
      const links = navFor(id).nodes.reduce((n, a) => n + a.links.filter((l) => l.type === LINK.RIDE).length, 0);
      expect(links === w.rides.length, `bots know every slide (${links}/${w.rides.length} ride links)`);
      current.note = `${w.rides.length} slides`;
    });
  }
  test('factory: the conveyor belts carry you', () => {
    const w = maps.factory.world;
    const zn = w.zones.find((z) => z.k === 'conveyor' && z.vx > 0 && z.y0 < 1.2);
    const c = new CharacterController(w, M);
    const x = zn.x0 + 3, z = (zn.z0 + zn.z1) / 2;
    const g = w.groundBelow(x, z, 0.2, 5);
    c.teleport(x, g.y, z, 0);
    run(c, 1, () => I());
    near(c.pos.x - x, zn.vx, 0.15, 'moved one second of belt');
  });
});

// --------------------------------------------------------------------------- headless matches
const { LocalMatch } = await import('../../src/gameplay/localMatch.js');
function stubGame(id) {
  const noop = () => {};
  const fx = new Proxy({}, { get: () => noop });
  return {
    cfg,
    scene: new THREE.Scene(),
    map: { id, data: maps[id].data, world: maps[id].world, nav: navFor(id) },
    effects: fx,
    cameraRig: { snapBehind: noop, forward: () => ({ x: 0, z: -1 }), right: () => ({ x: 1, z: 0 }), applyLook: noop, onLand: noop, shake: noop, pivotInit: false },
    getNav: () => navFor(id),
  };
}
suite('Full headless matches (8 bots, real rules)', () => {
  const plans = [
    ['rooftops', 'classic'],
    ['arena', 'infection'],
    ['docks', 'elimination'],
    ['training', 'classic'],
    ['mall', 'hotpotato'],
    ['waterpark', 'zone'],
    ['factory', 'classic'],
  ];
  for (const [id, mode] of plans) {
    test(`${mode} on ${id} plays to a correct finish`, () => {
      const game = stubGame(id);
      const m = new LocalMatch(game, { mode, mapId: id, bots: 8, difficulty: 'normal', headless: true, seed: 42 }, game.map.nav);
      m.setup();
      const zero = I();
      const limit = ((cfg.modes[mode].duration || 400) + cfg.match.countdown + 2) / DT; // hot potato has no clock
      let steps = 0;
      while (!m.ended && steps < limit) {
        m.simStep(DT, zero);
        steps++;
      }
      const r = m.rules;
      expect(m.ended && r.phase === 'ended', `ended (phase ${r.phase})`);
      expect(r.result.ranking.length === 8, 'result has every player');
      expect(r.result.winners.length >= 1, 'has a winner');
      if (mode === 'classic') expect(r.tagCount >= 3, `bots tagged each other (${r.tagCount} tags)`);
      if (mode === 'elimination') expect(r.result.ranking.filter((x) => x.out).length >= 1, 'someone was eliminated');
      if (mode === 'hotpotato') {
        expect(r.result.winners.length === 1 && r.result.ranking.filter((x) => x.out).length === 7, 'potato exploded until one was left');
        expect(r.potato.round >= 7 && r.potato.max <= cfg.modes.hotpotato.fuse, `fuse got shorter each round (${r.potato.max} s)`);
      }
      if (mode === 'zone') {
        const z = R.zoneAt(r);
        expect(z.r < R.zoneAt(r, 0).r, 'the ring closed in');
        expect(r.result.ranking.filter((x) => x.out).length >= 1, 'someone was knocked out');
      }
      current.note = `${r.result.reason}, ${r.tagCount} tags in ${r.time.toFixed(0)} s, winners: ${r.result.winners.join(', ')}`;
      m.dispose();
    });
  }
});

// --------------------------------------------------------------------------- perfect dodge (offline)
suite('Perfect dodge', () => {
  // IT sprints straight at a standing runner on the open training floor; the runner dodges
  // sideways when IT is `dodgeAt` metres away.
  function charge(dodgeAt) {
    const game = stubGame('training');
    const m = new LocalMatch(game, { mode: 'classic', mapId: 'training', bots: 2, difficulty: 'normal', headless: true, seed: 1 }, game.map.nav);
    m.setup();
    for (let i = 0; i < 200; i++) m.simStep(DT, I()); // past the countdown
    const itP = [...m.players.values()].find((p) => p.it);
    const runP = [...m.players.values()].find((p) => !p.it);
    itP.spawn(10, 0, 4, 0);
    runP.spawn(10, 0, -6, 0);
    let dodged = false;
    itP.brain = { update: () => I(0, -1, { sprint: true }) };
    runP.brain = {
      update: () => {
        const d = Math.hypot(itP.ctrl.pos.x - runP.ctrl.pos.x, itP.ctrl.pos.z - runP.ctrl.pos.z);
        if (!dodged && d <= dodgeAt) {
          dodged = true;
          return I(1, 0, { dodgePressed: true });
        }
        return I();
      },
    };
    const evs = [];
    const orig = m.feedback.bind(m);
    m.feedback = (ev) => { evs.push(ev); orig(ev); };
    for (let i = 0; i < 90; i++) m.simStep(DT, I());
    return { m, itP, runP, evs };
  }

  test('dodging right as IT arrives = perfect dodge: no tag, IT stunned, runner boosted', () => {
    const range = cfg.tag.range;
    const { m, itP, runP, evs } = charge(range + 0.6);
    const pd = evs.find((e) => e.type === 'perfect_dodge');
    expect(pd, `perfect dodge triggered (events: ${evs.map((e) => e.type).join(',') || 'none'})`);
    expect(pd.tagger === itP.id && pd.dodger === runP.id, 'right players');
    expect(m.rules.tagCount === 0, 'not tagged');
    expect(itP.frozen, 'IT is stunned');
    expect(runP.boosted && runP.boostLeft > 3, `runner boosted (${runP.boostLeft?.toFixed(2)} s left)`);
    expect(m.rules.players[runP.id].perfectDodges === 1, 'counted in stats');
  });

  test('dodging too early is just a normal dodge (no slow-mo reward)', () => {
    const { evs } = charge(6.5);
    expect(!evs.some((e) => e.type === 'perfect_dodge'), 'no perfect dodge');
  });

  test('speed boost really makes you faster', () => {
    const { runP } = charge(cfg.tag.range + 0.6);
    runP.ctrl.speedMultiplier = cfg.perfectDodge.boostSpeed;
    for (let i = 0; i < 90; i++) runP.ctrl.step(I(-1, 0, { sprint: true }), DT);
    near(runP.ctrl.horizontalSpeed, cfg.movement.sprintSpeed * cfg.perfectDodge.boostSpeed, 0.1, 'boosted sprint speed');
  });

  test('the cinematic slows time, then restores it exactly', async () => {
    const { PerfectDodgeDirector } = await import('../../src/effects/perfectDodge.js');
    const { createScreenFx } = await import('../../src/effects/screenFx.js');
    const cam = new THREE.PerspectiveCamera();
    const fakeGame = { cfg, scene: new THREE.Scene(), camera: cam, screenFx: createScreenFx(), effects: new Proxy({}, { get: () => () => {} }),
      cameraRig: { cine: { orbit: 0, zoom: 0, roll: 0, fov: 0, lift: 0 }, shake() {} }, screenPoint: (p, out) => out.set(0.5, 0.5) };
    const dir = new PerfectDodgeDirector(fakeGame);
    const sess = { timeScale: 1, disposed: false };
    const model = { bakePose: () => new THREE.BoxGeometry(0.5, 1.8, 0.5) };
    const dodger = { name: 'You', renderPos: { x: 0, y: 0, z: 0 }, model };
    const tagger = { name: 'IT', renderPos: { x: 1, y: 0, z: 0 }, model };
    dir.play({ session: sess, dodger, tagger, kind: 'hero', slowmo: true, duration: cfg.perfectDodge.animTime });
    let minScale = 1, gameTime = 0, inverted = false;
    for (let t = 0; t < cfg.perfectDodge.animTime + 0.2; t += 1 / 60) {
      dir.update(1 / 60);
      gameTime += (1 / 60) * sess.timeScale;
      minScale = Math.min(minScale, sess.timeScale);
      if (fakeGame.screenFx.u.uInvert.value > 0.9) inverted = true;
    }
    near(minScale, cfg.perfectDodge.slowmo, 0.02, 'slowest time scale');
    expect(inverted, 'screen inverted during the cinematic');
    expect(sess.timeScale === 1 && !fakeGame.screenFx.active, 'time and screen restored');
    // the rules stun the tagger from the start of the cinematic: delay must match its game time
    const s = cfg.perfectDodge.slowmo;
    near(gameTime, 0.2 * (1 + s) + (cfg.perfectDodge.animTime - 0.48) * s + 0.08 + 0.2, 0.12, 'cinematic game time');
    current.note = `slowest x${minScale.toFixed(2)}, cinematic = ${gameTime.toFixed(2)} s of game time`;
  });
});

// --------------------------------------------------------------------------- abilities & coins
const { validLoadout, ABILITY_IDS } = await import('../../src/gameplay/abilities.js');
const insideSolid = (w, c) => !w.isFree(c.pos.x, c.pos.y + 0.3, c.pos.z, M.radius * 0.5, 0.55);

/** A 2-bot training match that is already past its countdown. */
function liveMatch(seed = 1, difficulty = 'normal') {
  const game = stubGame('training');
  const m = new LocalMatch(game, { mode: 'classic', mapId: 'training', bots: 2, difficulty, headless: true, seed }, game.map.nav);
  m.setup();
  for (let i = 0; i < 200; i++) m.simStep(DT, I());
  const itP = [...m.players.values()].find((p) => p.it);
  const runP = [...m.players.values()].find((p) => !p.it);
  for (const p of m.players.values()) m.abilities.setLoadout(p, []);
  return { m, itP, runP };
}

suite('Abilities & coins', () => {
  test('blink teleports up to its range in the open', () => {
    const c = ctrlAt(-30, 0, 0);
    const r = c.blink(1, 0, cfg.abilities.blink.range);
    expect(r, 'blinked');
    near(c.pos.x - -30, cfg.abilities.blink.range, 0.26, 'blink distance');
    expect(hasEvent(c, 'blink'), 'blink event');
  });
  test('blink stops in front of a wall — never through it', () => {
    const c = ctrlAt(4, 0, 0); // tall wall at x = 10 .. 10.5
    const r = c.blink(1, 0, cfg.abilities.blink.range);
    expect(r && c.pos.x < 10 - M.radius + 0.01 && c.pos.x > 8.5, `stopped at x=${c.pos.x.toFixed(2)}`);
    expect(!insideSolid(world, c), 'not inside the wall');
    const d = ctrlAt(10 - M.radius - 0.02, 0, 0);
    expect(d.blink(1, 0, 9) === null, 'no room = no blink');
  });
  test('rocket jump launches high (and works in the air)', () => {
    const c = ctrlAt(-25, 0, -25, 0);
    c.rocket(cfg.abilities.rocket.velocity, cfg.abilities.rocket.forward);
    let top = 0;
    run(c, 2.5, () => I(), (cc) => { top = Math.max(top, cc.pos.y); });
    const v = cfg.abilities.rocket.velocity;
    near(top, (v * v) / (2 * M.gravity), 0.35, 'apex');
    expect(c.grounded && c.pos.z < -26, 'landed a little forward');
  });
  test('grapple zips to the anchor and lets go there', () => {
    const c = ctrlAt(12, 0, 8, -Math.PI / 2);
    const g = cfg.abilities.grapple;
    expect(c.startGrapple({ x: 19.6, y: 2.9, z: 8 }, g.speed, g.maxTime), 'started');
    expect(c.state === MS.GRAPPLE, 'grapple state');
    let clip = false;
    const n = run(c, 1.5, () => I(), (cc) => { if (insideSolid(world, cc)) clip = true; if (!cc.grapple) return false; });
    expect(!c.grapple && n * DT < g.maxTime, `released after ${(n * DT).toFixed(2)} s`);
    expect(c.pos.x > 17, `arrived (x=${c.pos.x.toFixed(2)})`);
    expect(!clip, 'never inside geometry');
  });
  test('grapple: jump lets go early, a blocked line stops it', () => {
    const g = cfg.abilities.grapple;
    const c = ctrlAt(-30, 0, -30);
    c.startGrapple({ x: -30, y: 8, z: 10 }, g.speed, g.maxTime);
    run(c, 0.1, () => I());
    c.step(I(0, 0, { jumpPressed: true }), DT);
    expect(!c.grapple && c.vel.y >= 3.9, 'released with a hop');
    const d = ctrlAt(6, 0, 0); // the tall wall is in the way of an anchor behind it
    d.startGrapple({ x: 14, y: 2, z: 0 }, g.speed, g.maxTime);
    const n = run(d, 1.5, () => I(), (cc) => (cc.grapple ? undefined : false));
    expect(!d.grapple && n * DT < 0.7 && d.pos.x < 10, `stopped by the wall after ${(n * DT).toFixed(2)} s`);
  });
  test('shockwave knockback (offline): pushes away and up, only in range', () => {
    const { m, itP, runP } = liveMatch(3);
    itP.spawn(10, 0, 2, 0);
    runP.spawn(10, 0, -1, 0);
    m.abilities.setLoadout(itP, ['shockwave', null]);
    expect(m.abilities.use(itP, 0, {}).ok, 'used');
    expect(runP.ctrl.vel.z < -5 && runP.ctrl.vel.y > 3 && !runP.ctrl.grounded, `pushed (vz ${runP.ctrl.vel.z.toFixed(1)}, vy ${runP.ctrl.vel.y.toFixed(1)})`);
    runP.spawn(10, 0, -12, 0);
    m.abilities.setLoadout(itP, ['shockwave', null]);
    m.abilities.use(itP, 0, {});
    expect(Math.hypot(runP.ctrl.vel.x, runP.ctrl.vel.z) < 0.01, 'out of range: untouched');
    m.dispose();
  });
  test('cooldowns, slots and cloak duration', () => {
    const { m, runP } = liveMatch(4);
    m.abilities.setLoadout(runP, [null, 'cloak']);
    expect(m.abilities.use(runP, 0, {}).reason === 'empty', 'empty slot');
    expect(m.abilities.use(runP, 1, {}).ok, 'cloak on');
    expect(m.abilities.isCloaked(runP), 'cloaked');
    expect(m.abilities.use(runP, 1, {}).reason === 'cooldown', 'on cooldown');
    for (let t = 0; t < cfg.abilities.cloak.duration + 0.1; t += DT) m.abilities.step(DT);
    expect(!m.abilities.isCloaked(runP), 'cloak wears off');
    for (let t = 0; t < cfg.abilities.cloak.cooldown; t += DT) m.abilities.step(DT);
    expect(m.abilities.use(runP, 1, {}).ok, 'ready again after the cooldown');
    m.dispose();
  });
  test('decoy runs off as a hologram and pops when IT touches it', () => {
    const { m, itP, runP } = liveMatch(5);
    runP.spawn(0, 0, 8, 0);
    itP.spawn(-20, 0, -15, 0);
    m.abilities.setLoadout(runP, ['decoy', null]);
    expect(m.abilities.use(runP, 0, { dir: { x: 1, z: 0 } }).ok, 'used');
    const dcy = m.abilities.decoys[0];
    for (let i = 0; i < 30; i++) m.abilities.step(DT);
    expect(dcy.ctrl.pos.x > 2, `decoy ran (x=${dcy.ctrl.pos.x.toFixed(1)})`);
    expect(m.abilities.perceivables()[0].decoy, 'bots perceive it as a runner');
    itP.spawn(dcy.ctrl.pos.x + 0.5, dcy.ctrl.pos.y, dcy.ctrl.pos.z, 0);
    m.abilities.step(DT);
    expect(m.abilities.decoys.length === 0, 'popped');
    m.dispose();
  });
  test('cloaked runners are invisible to bots beyond 3 m', () => {
    const nav = navFor('training');
    const ctrl = new CharacterController(maps.training.world, M);
    ctrl.teleport(0, 0, -6);
    const brain = new BotBrain({ id: 'bot', ctrl }, nav, cfg.bots.hard, 9);
    const runner = { id: 'r', pos: { x: 0, y: 0, z: 2 }, vel: { x: 0, y: 0, z: 0 }, it: false, out: false, protected: false, frozen: false, cloaked: true };
    const ctx = { world: maps.training.world, phase: 'playing', players: [{ id: 'bot', pos: ctrl.pos, vel: ctrl.vel, it: true, out: false, protected: false, frozen: false }, runner] };
    for (let i = 0; i < 30; i++) brain.update(DT, ctx);
    expect(!brain.known.has('r'), 'not noticed while cloaked');
    runner.cloaked = false;
    for (let i = 0; i < 30; i++) brain.update(DT, ctx);
    expect(brain.known.has('r'), 'noticed once visible');
  });
  for (const id of Object.keys(maps)) {
    test(`${id}: coin spots stand on walkable ground and bots can path to most`, () => {
      const { data, world: w } = maps[id];
      const spots = data.coinSpots || [];
      expect(spots.length >= cfg.coins.mapCoins, `${spots.length} spots`);
      const nav = navFor(id);
      const from = nav.reachableFrom(nav.nearest(...data.spawns[0], 2).id);
      let reach = 0;
      for (const [x, y, z] of spots) {
        const g = w.groundBelow(x, z, M.radius * 0.6, y - 0.85);
        expect(g && Math.abs(g.y - (y - 0.9)) < 0.06, `coin ${x},${y},${z} not above ground`);
        expect(w.isFree(x, y - 0.88, z, M.radius, M.height), `coin ${x},${y},${z} blocked`);
        const n = nav.nearest(x, y - 0.9, z, 2.5);
        if (n && from.has(n.id)) reach++;
      }
      expect(reach / spots.length >= 0.75, `only ${reach}/${spots.length} reachable by bots`);
      current.note = `${spots.length} spots, ${reach} on the bot nav graph, ${spots.filter((s) => s[1] > 2).length} up high`;
    });
  }
  test('offline coins: pickup counts, then respawns elsewhere', () => {
    const { m, runP } = liveMatch(6);
    const before = m.coins.coins.size;
    expect(before === Math.min(cfg.coins.mapCoins, maps.training.data.coinSpots.length), `spawned ${before}`);
    const c = [...m.coins.coins.values()][0];
    runP.spawn(c.pos.x, c.pos.y - 0.9, c.pos.z, 0);
    m.coins.step(DT);
    expect(!m.coins.coins.has(c.id) && m.rules.players[runP.id].coinsPicked === 1, 'picked up');
    for (let t = 0; t < cfg.coins.respawn + 0.1; t += DT) m.coins.step(DT);
    expect(m.coins.coins.size === before, 'respawned');
    m.dispose();
  });
  test('bots rarely land perfect dodges (human-like timing error)', () => {
    // IT homes in on a fleeing bot at full speed; count how the approach ends
    const tally = { perfect: 0, tag: 0, none: 0 };
    const trials = 40;
    for (let k = 0; k < trials; k++) {
      const { m, itP, runP } = liveMatch(100 + k, k % 2 ? 'hard' : 'normal');
      itP.spawn(10, 0, -1, 0);
      runP.spawn(10, 0, -6, 0);
      itP.ctrl.vel.z = -10;
      itP.brain = { update: () => {
        const dx = runP.ctrl.pos.x - itP.ctrl.pos.x, dz = runP.ctrl.pos.z - itP.ctrl.pos.z, d = Math.hypot(dx, dz) || 1;
        return I(dx / d, dz / d, { sprint: true });
      } };
      let out = 'none';
      const orig = m.feedback.bind(m);
      m.feedback = (ev) => { if (out === 'none' && (ev.type === 'perfect_dodge' || ev.type === 'tag')) out = ev.type === 'tag' ? 'tag' : 'perfect'; orig(ev); };
      for (let i = 0; i < 150; i++) m.simStep(DT, I());
      tally[out]++;
      m.dispose();
    }
    expect(tally.perfect + tally.tag >= trials * 0.7, `IT reached the bot (${JSON.stringify(tally)})`);
    expect(tally.perfect / trials < 0.2, `too many perfect dodges (${JSON.stringify(tally)})`);
    current.note = `${trials} charges: ${tally.perfect} perfect dodges, ${tally.tag} tags, ${tally.none} escapes`;
  });
  test('shop: buy with coins, auto-equip, positional slots, no double buy', async () => {
    const { progression } = await import('../../src/progression/progression.js');
    const saved = JSON.stringify(progression.profile);
    try {
      progression.init(cfg);
      progression.profile.coins = 120;
      progression.profile.abilities = { owned: [], loadout: [null, null] };
      expect(!progression.buyAbility('rocket').ok && progression.coins === 120, 'cannot afford');
      expect(progression.buyAbility('blink').ok && progression.coins === 120 - cfg.abilities.blink.price, 'bought');
      expect(progression.loadout.join() === 'blink,', `auto-equipped in slot 1 (${progression.loadout})`);
      expect(!progression.buyAbility('blink').ok, 'no double purchase');
      progression.profile.coins = 1000;
      progression.buyAbility('cloak');
      expect(progression.loadout.join() === 'blink,cloak', 'second purchase fills slot 2');
      progression.equip(1, 'blink');
      expect(progression.loadout.join() === 'cloak,blink', `equipping swaps slots (${progression.loadout})`);
      progression.equip(0, null);
      expect(progression.loadout.join() === ',blink', 'slot cleared, R slot kept');
      expect(!progression.equip(0, 'shockwave'), 'cannot equip what you do not own');
      expect(validLoadout(['blink', 'blink', 'cloak']).join() === 'blink,', 'no duplicates / max 2');
      expect(validLoadout(['nope', 'cloak']).join() === ',cloak', 'unknown ids dropped');
      expect(ABILITY_IDS.every((id) => cfg.abilities[id]?.price > 0), 'every ability has a price');
    } finally {
      progression.profile = JSON.parse(saved);
      progression.save();
    }
  });
});

// --------------------------------------------------------------------------- settings & UI
// --------------------------------------------------------------------------- v1.03: scramble, emotes, models, intro, motion blur
const { scrambleStick, scrambleWorldInput, SCRAMBLE_MODES } = await import('../../src/gameplay/abilities.js');
const { CharacterModel, EMOTE_TIME } = await import('../../src/player/characterModel.js');
const { EMOTES, EMOTE_IDS } = await import('../../src/progression/cosmetics.js');
const { DEFAULT_BINDINGS } = await import('../../src/core/settings.js');
const { MatchIntro } = await import('../../src/gameplay/intro.js');
const { MotionBlur } = await import('../../src/effects/motionBlur.js');

suite('Scramble, emotes, characters, intro & motion blur', () => {
  test('scramble remaps controls: inverted, mirrored (+ jump/slide swapped), spun 90°', () => {
    const eq = (a, b, msg) => expect(Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9, `${msg}: ${a}`);
    eq(scrambleStick(0.3, 1, 'invert'), [-0.3, -1], 'invert');
    eq(scrambleStick(0.3, 1, 'mirror'), [-0.3, 1], 'mirror');
    eq(scrambleStick(0, 1, 'spin'), [1, 0], 'spin: forward goes right');
    eq(scrambleStick(1, 0, 'spin'), [0, -1], 'spin: right goes back');
    const inp = I(0.6, -0.8, { jumpPressed: true });
    const inv = scrambleWorldInput(inp, 'invert', 1.1);
    near(inv.mx, -0.6, 1e-9, 'world invert x');
    near(inv.mz, 0.8, 1e-9, 'world invert z');
    const mir = scrambleWorldInput(inp, 'mirror', 0);
    expect(mir.slidePressed && !mir.jumpPressed, 'mirror swaps jump and slide');
    near(Math.hypot(mir.mx, mir.mz), 1, 1e-9, 'mirror keeps the stick length');
    const sp = scrambleWorldInput(inp, 'spin', 0.4);
    near(sp.mx * inp.mx + sp.mz * inp.mz, 0, 1e-9, 'spin turns the direction 90°');
    expect(SCRAMBLE_MODES.length === 3, 'three modes');
  });
  test('scramble (offline): hits players in range and in sight only, then wears off', () => {
    const { m } = liveMatch(5);
    const [a, b] = [...m.players.values()];
    const w = m.world;
    // a tall, thin wall to hide behind
    const wall = w.colliders.find((c) => !c.invisible && !c.ramp && c.y0 <= 0.1 && c.y1 > 2.5 && Math.min(c.x1 - c.x0, c.z1 - c.z0) < 2 && Math.max(c.x1 - c.x0, c.z1 - c.z0) > 3);
    expect(wall, 'found a wall');
    const alongX = wall.x1 - wall.x0 < wall.z1 - wall.z0; // thin in x: stand either side of it in x
    const mid = alongX ? (wall.z0 + wall.z1) / 2 : (wall.x0 + wall.x1) / 2;
    const side = (s) => (alongX ? [s < 0 ? wall.x0 - 1.2 : wall.x1 + 1.2, mid] : [mid, s < 0 ? wall.z0 - 1.2 : wall.z1 + 1.2]);
    const [ax, az] = side(-1), [bx, bz] = side(1);
    a.spawn(ax, wall.y0, az, 0);
    b.spawn(bx, wall.y0, bz, 0);
    m.abilities.setLoadout(a, ['scramble']);
    expect(m.abilities.use(a, 0, {}).ok, 'used');
    expect(!m.abilities.isScrambled(b), 'not through a wall');
    m.abilities.setLoadout(a, ['scramble']); // fresh cooldown
    // somewhere 5 m away in the open, in plain sight
    let spot = null;
    for (let i = 0; i < 32 && !spot; i++) {
      const ang = (i / 32) * Math.PI * 2, x = ax + Math.cos(ang) * 5, z = az + Math.sin(ang) * 5;
      if (w.isFree(x, wall.y0 + 0.05, z, M.radius, M.height) && w.groundBelow(x, z, 0.2, wall.y0 + 0.5)?.y === wall.y0 && w.lineOfSight({ x: ax, y: wall.y0 + 1, z: az }, { x, y: wall.y0 + 1, z })) spot = [x, z];
    }
    expect(spot, 'found an open spot');
    b.spawn(spot[0], wall.y0, spot[1], 0);
    expect(m.abilities.use(a, 0, {}).ok && m.abilities.isScrambled(b), 'in range and in sight: scrambled');
    expect(SCRAMBLE_MODES.includes(b.scrambleMode), `mode ${b.scrambleMode}`);
    expect(!m.abilities.isScrambled(a), 'never yourself');
    const inv = m.abilities.scrambledInput(b, I(1, 0));
    expect(Math.abs(inv.mx - 1) + Math.abs(inv.mz) > 0.5, 'a scrambled bot gets remapped input');
    for (let t = 0; t < cfg.abilities.scramble.duration + 0.05; t += DT) m.abilities.step(DT);
    expect(!m.abilities.isScrambled(b), 'wears off after its duration');
    m.dispose();
  });
  test('emotes: every emote has a key, a duration and a real pose (griddy, buggin, robot...)', () => {
    expect(EMOTE_IDS.includes('griddy') && EMOTE_IDS.includes('buggin'), 'the new emotes exist');
    const model = new CharacterModel({});
    const idle = { x: 0, y: 0, z: 0, yaw: 0, vx: 0, vy: 0, vz: 0, state: MS.GROUND, grounded: true, sprinting: false, scriptProgress: 0, groundY: 0 };
    for (let i = 0; i < 60; i++) model.update(idle, DT, i * DT);
    const rest = model.joints.map((j) => j.cur.clone());
    EMOTE_IDS.forEach((id, i) => {
      expect(EMOTES[id] && EMOTE_TIME[id] > 1, `${id}: catalogue + duration`);
      expect(DEFAULT_BINDINGS[`emote${i + 1}`]?.length, `${id}: key binding`);
      model.playEmote(id);
      let moved = 0;
      for (let k = 0; k < 90; k++) {
        model.update(idle, DT, 1 + k * DT);
        for (const j of model.joints) expect(Number.isFinite(j.cur.x + j.cur.y + j.cur.z), `${id}: finite joints`);
      }
      model.joints.forEach((j, n) => (moved = Math.max(moved, j.cur.distanceTo(rest[n]))));
      expect(model.emote === id && moved > 0.3, `${id}: actually animates (${moved.toFixed(2)})`);
      model.emote = null;
      for (let k = 0; k < 60; k++) model.update(idle, DT, 3 + k * DT);
    });
    model.playEmote('griddy');
    model.update({ ...idle, vx: 3 }, DT, 5);
    expect(model.emote === null, 'moving cancels an emote');
    model.dispose();
  });
  test('character model: one skinned mesh, 3 materials, sensible size', () => {
    const model = new CharacterModel({ primary: '#e9edf5', hat: 'cap' });
    const m = model.mesh;
    expect(m.isSkinnedMesh && m.material.length === 3 && m.geometry.groups.length === 3, 'one skinned mesh, three groups');
    const n = m.geometry.attributes.position.count;
    expect(n > 2000 && n < 12000, `${n} vertices`);
    m.geometry.computeBoundingBox();
    const bb = m.geometry.boundingBox;
    expect(bb.min.y > -0.1 && bb.max.y > 1.75 && bb.max.y < 2.2, `height ${bb.min.y.toFixed(2)}..${bb.max.y.toFixed(2)}`);
    expect(bb.max.x - bb.min.x < 0.9, `width ${(bb.max.x - bb.min.x).toFixed(2)}`);
    current.note = `${n} vertices, ${(bb.max.y - bb.min.y).toFixed(2)} m tall`;
    model.dispose();
  });
  for (const id of Object.keys(maps)) {
    test(`${id}: the intro camera orbits in the open (and under indoor ceilings)`, () => {
      const fake = { game: { map: { data: maps[id].data, world: maps[id].world, id } }, s: { local: null } };
      MatchIntro.prototype._planOrbit.call(fake);
      const o = fake.orbit;
      const w = maps[id].world;
      let free = 0;
      for (let i = 0; i < 24; i++) {
        const a = (i / 24) * Math.PI * 2;
        if (w.isFree(o.cx + Math.cos(a) * o.r, o.h - 0.4, o.cz + Math.sin(a) * o.r, 0.4, 0.8)) free++;
      }
      expect(free >= 16, `${free}/24 orbit points in the open`);
      const ceil = Math.min(Infinity, ...(maps[id].data.decor || []).filter((d) => d.t === 'ceiling').map((d) => d.y));
      expect(o.h * 1.12 < ceil, `orbit ${o.h.toFixed(1)} m stays under the ceiling (${ceil})`);
      current.note = `h ${o.h.toFixed(1)} m, r ${o.r.toFixed(1)} m${o.indoor ? ', indoor' : ''}`;
    });
  }
  test('motion blur: only while the view turns or at speed, never across a camera cut', () => {
    const mb = new MotionBlur();
    const cam = new THREE.PerspectiveCamera(70, 16 / 9, 0.1, 100);
    cam.updateMatrixWorld();
    expect(!mb.update(cam, DT, 0, true), 'first frame: nothing to compare with');
    expect(!mb.update(cam, DT, 0, true), 'still camera: off');
    cam.rotation.y += 0.05; cam.updateMatrixWorld();
    expect(mb.update(cam, DT, 0, true) && Math.abs(mb.u.uVel.value.x) > 0.002, 'turning: blur along the turn');
    expect(Math.abs(mb.u.uVel.value.y) < 1e-6, 'no vertical smear for a pure yaw');
    cam.rotation.y += 1.5; cam.updateMatrixWorld();
    mb.update(cam, DT, 0, true);
    expect(mb.u.uVel.value.length() === 0, 'a camera cut is not motion');
    for (let i = 0; i < 60; i++) mb.update(cam, DT, 16, true);
    expect(mb.pass.enabled && mb.u.uRadial.value > 0.02, 'radial streak at top speed');
    expect(!mb.update(cam, DT, 16, false), 'setting off: never runs');
  });
});

// --------------------------------------------------------------------------- map events & versions
const { EventScheduler, eventMods, eventsForMap, EVENT_INFO } = await import('../../src/gameplay/mapEvents.js');
const { VERSION, CHANGELOG } = await import('../../src/core/version.js');

suite('Map events & updates', () => {
  test('scheduler: warning first, sensible gaps, no repeats in a row, nothing right before the end', () => {
    let s = 7;
    const rng = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const me = cfg.mapEvents;
    const sch = new EventScheduler(me, ['blackout', 'coinrain', 'lowgrav', 'fog'], rng);
    const evs = [];
    let prev = null, starts = 0;
    const step = 0.05, dur = 300;
    for (let i = 0; i <= dur / step; i++) {
      const t = i * step;
      const { ev, started } = sch.step(t, dur);
      if (ev && ev !== prev) evs.push({ ev, seenAt: t });
      if (started) {
        starts++;
        expect(t >= ev.start && t - ev.start < step + 1e-9, `starts on time (${t} vs ${ev.start})`);
      }
      prev = ev;
    }
    expect(evs.length >= 3, `${evs.length} events in 5 minutes`);
    expect(starts === evs.length, 'every event fires once');
    const first = evs[0].ev;
    expect(first.start >= me.firstAt[0] && first.start <= me.firstAt[1], `first event at ${first.start.toFixed(1)} s`);
    evs.forEach(({ ev, seenAt }, i) => {
      near(ev.start - seenAt, me.warn, step + 1e-6, `event ${i} warned ahead`);
      near(ev.end - ev.start, me.events[ev.kind].duration, 1e-9, `event ${i} duration`);
      expect(ev.start + 12 <= dur, `event ${i} not right before the end`);
      if (i) {
        const p = evs[i - 1].ev;
        expect(ev.kind !== p.kind, `event ${i} repeats ${ev.kind}`);
        const gap = ev.start - p.end;
        expect(gap >= me.gap[0] - 1e-9 && gap <= me.gap[1] + step + 1e-6, `gap ${gap.toFixed(1)} s`);
      }
    });
    current.note = evs.map((e) => `${e.ev.kind}@${e.ev.start.toFixed(0)}s`).join(', ');
  });
  test('event effects only apply while the event is on', () => {
    const ev = (kind) => ({ kind, start: 10, end: 20 });
    const neutral = eventMods(ev('lowgrav'), 9.9);
    expect(neutral.kind === null && neutral.gravity === 1 && neutral.traction === 1 && neutral.speed === 1 && neutral.radar, 'nothing before it starts');
    expect(eventMods(ev('lowgrav'), 20).gravity === 1, 'nothing after it ends');
    expect(eventMods(ev('lowgrav'), 15).gravity < 0.6, 'low gravity');
    expect(eventMods(ev('slick'), 15).traction < 0.5, 'wet floors');
    expect(eventMods(ev('surge'), 15).speed > 1.1, 'speed surge');
    const dark = eventMods(ev('blackout'), 15);
    expect(dark.dark && !dark.radar, 'power outage: dark, no radar');
    expect(eventMods(null, 15).kind === null, 'no event');
  });
  test('every map lists known events (and the indoor maps can lose power)', () => {
    for (const { id } of mapIndex) {
      const kinds = eventsForMap(maps[id].data);
      expect(kinds.length >= 2, `${id}: ${kinds.length} events`);
      for (const k of kinds) expect(EVENT_INFO[k] && cfg.mapEvents.events[k]?.duration > 0, `${id}: unknown event ${k}`);
    }
    for (const id of ['mall', 'factory']) expect(eventsForMap(maps[id].data).includes('blackout'), `${id} has power outages`);
    expect(eventsForMap(maps.factory.data).includes('overdrive') && eventsForMap(maps.waterpark.data).includes('sliderush'), 'map-specific events');
  });
  test('coin rain drops bonus coins that do not respawn', () => {
    const { m, runP } = liveMatch(3);
    const before = m.coins.coins.size;
    m.coins.rain(5);
    expect(m.coins.coins.size === before + 5, `rained ${m.coins.coins.size - before}`);
    const c = [...m.coins.coins.values()].find((k) => k.bonus);
    const queued = m.coins.respawns.length;
    runP.spawn(c.pos.x, c.pos.y - 0.9, c.pos.z, 0);
    m.coins.step(DT);
    expect(!m.coins.coins.has(c.id) && m.rules.players[runP.id].coinsPicked === 1, 'picked up');
    expect(m.coins.respawns.length === queued, 'no respawn queued for a bonus coin');
    m.dispose();
  });
  test('version: config, game and changelog agree', () => {
    expect(VERSION === cfg.version, `version.js ${VERSION} vs config ${cfg.version}`);
    expect(CHANGELOG[0].version === VERSION, 'newest changelog entry is this version');
    const nums = CHANGELOG.map((u) => parseFloat(u.version));
    expect(nums.every((v, i) => !i || v < nums[i - 1]), 'changelog newest first');
    for (const u of CHANGELOG) expect(u.title && u.date && u.sections.length && u.sections.every(([t, items]) => t && items.length), `entry ${u.version} complete`);
    current.note = `v${VERSION}`;
  });
});

suite('Settings & UI wiring', () => {
  test('settings persist to storage and survive a reload', async () => {
    const { settings } = await import('../../src/core/settings.js');
    const before = settings.get('audio.music');
    settings.set('audio.music', 0.37);
    const raw = JSON.parse(localStorage.getItem('protag.settings'));
    expect(raw.audio.music === 0.37, 'written to localStorage');
    settings.set('audio.music', before);
  });
  test('key bindings: defaults never collide, old saves are migrated (F: Slide -> Ability 1)', async () => {
    const { dedupeBindings, DEFAULT_BINDINGS } = await import('../../src/core/settings.js');
    expect(!dedupeBindings(structuredClone(DEFAULT_BINDINGS)), 'one key per action in the defaults');
    const old = { ...structuredClone(DEFAULT_BINDINGS), slide: ['KeyC', 'KeyF'] };
    expect(dedupeBindings(old), 'collision detected');
    expect(old.slide.join() === 'KeyC' && old.ability1.join() === 'KeyF', `slide ${old.slide}, ability1 ${old.ability1}`);
    const only = { ...structuredClone(DEFAULT_BINDINGS), slide: ['KeyF'] };
    dedupeBindings(only);
    expect(only.slide.join() === 'KeyC', 'an action never ends up unbound');
  });
  test('every data-action in the UI has a handler', async () => {
    const src = await (await fetch('../../src/ui/ui.js')).text();
    const used = new Set([...src.matchAll(/data-action="(\w+)"/g)].map((m) => m[1]));
    const block = src.slice(src.indexOf('actions = {'), src.indexOf('\n  leaveMatchSilently() {'));
    const defined = new Set([...block.matchAll(/^ {4}(\w+): /gm)].map((m) => m[1]));
    const missing = [...used].filter((a) => !defined.has(a));
    expect(missing.length === 0, `no handler for: ${missing.join(', ')}`);
    current.note = `${used.size} actions wired`;
  });
  test('every screen referenced by navigation exists', async () => {
    const src = await (await fetch('../../src/ui/ui.js')).text();
    const targets = new Set([...src.matchAll(/data-target="(\w+)"/g)].map((m) => m[1]).concat([...src.matchAll(/this\.show\('(\w+)'/g)].map((m) => m[1])));
    const screens = new Set([...src.matchAll(/^ {2}screen_(\w+)\(\)/gm)].map((m) => m[1]));
    const missing = [...targets].filter((t) => !screens.has(t) && t !== 'loading');
    expect(missing.length === 0, `missing screens: ${missing.join(', ')}`);
  });
});

// --------------------------------------------------------------------------- runner
// MessageChannel yields are not throttled in background tabs (setTimeout is clamped to 1 s)
const yieldToBrowser = () => new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });
let pass = 0, fail = 0;
const t0 = performance.now();
for (const s of suites) {
  current = { tests: [] };
  const holder = current;
  await s.fn();
  const head = document.createElement('div');
  head.className = 'suite';
  head.textContent = s.name;
  out.append(head);
  for (const t of holder.tests) {
    current = { note: '' };
    const row = document.createElement('div');
    row.className = 't';
    const start = performance.now();
    try {
      await t.fn();
      pass++;
      row.innerHTML = `<span class="pass">✔</span> ${t.name} <small>${(performance.now() - start).toFixed(0)} ms ${current.note ? '· ' + current.note : ''}</small>`;
      results.push({ suite: s.name, name: t.name, ok: true, note: current.note });
    } catch (err) {
      fail++;
      row.innerHTML = `<span class="fail">✘</span> ${t.name}<pre>${(err && err.stack) || err}</pre>`;
      results.push({ suite: s.name, name: t.name, ok: false, error: String(err && err.message ? err.message : err) });
    }
    out.append(row);
    await yieldToBrowser();
  }
}
const sum = document.getElementById('sum');
sum.innerHTML = `<span class="${fail ? 'fail' : 'pass'}">${pass} passed, ${fail} failed</span> in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
window.__TEST_RESULTS__ = { pass, fail, results };
