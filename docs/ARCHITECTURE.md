# PRO TAG: architecture and technical decisions

## 1. Stack choice

| Requirement | Decision | Why |
|---|---|---|
| Real-time 3D in a project that is easy to run from VS Code on Windows | **three.js r170**, vendored in `vendor/three`, plain ES modules, **no build step** | The dev machine has no Node.js, and installing it was not an option (managed device). Native ES modules plus an import map need nothing but a browser. Vendoring keeps the game playable offline. |
| Authoritative multiplayer with zero installs | **Python 3 standard library**: `asyncio` + a hand-written RFC 6455 WebSocket (`server/websocket.py`) | Python 3.12 was already installed. No `pip install`, and the same process serves the game files and `/ws` on one port. |
| One source of truth for tuning and maps | `config/game.json` and `assets/maps/*.json`, read by **both** client and server | The server validates movement against the exact geometry the client collides with. |
| No asset-licensing risk | Procedural textures (canvas), primitive-built characters, Web Audio synthesis | Nothing in the repo needs attribution beyond three.js (MIT). |

The one place where logic is duplicated across languages is the **rules engine** (`src/gameplay/rules.js` ↔ `server/rules.py`, about 300 lines each, ported line for line). Duplication is the price of a Python server. It's contained by `tests/shared/rules_cases.json`, a declarative list of scenarios that **both** implementations must pass (`tests/test_rules.py` and the browser suite). The XP formula is mirrored and tested the same way.

## 2. Runtime structure (client)

```
main.js ─ boot: config → settings → InputManager, TouchControls → Game → UI
Game (gameplay/game.js)
  ├─ renderer (+ EffectComposer bloom on High/Ultra), scene, camera, CameraRig, Effects
  ├─ map: { data, world: CollisionWorld, visuals, nav (lazy NavGraph) }
  └─ session: LocalMatch | OnlineMatch | LocalMatch(attract)   ← one active at a time
UI (ui/ui.js) ─ screens, HUD, game flow (start/pause/resume/results/lobby), controller nav
```

* **Fixed timestep.** `MatchSession.frame()` accumulates time and runs `simStep(1/60)`. Rendering interpolates between the previous and current simulation states (`Player.render(alpha)`). Edge-triggered inputs (jump/slide/dodge/vault presses) are kept until a sim step consumes them, so taps are never lost on 120–240 Hz displays.
* **Event bus** (`core/events.js`) decouples systems: rules → `hud:banner`/`hud:feed`, network → `net:*`, settings → `settings:changed` (audio buses, renderer, HUD scale and camera all react live).
* **Menu attract mode.** The main menu runs a real bot-only match on a random arena, filmed by a cinematic follow camera.

## 3. Movement (`src/movement/`)

* **CollisionWorld:** axis-aligned boxes plus ramps (boxes with a sloped top), with a 4 m uniform grid broad-phase. Queries: `groundBelow`, `resolveHorizontal` (circle vs rectangle push-out with step-up tolerance), `ceilingBetween`, `isFree`, `obstacleTop`, `raycast` (slab test, marched for ramps) and `lineOfSight`.
* **CharacterController:** a kinematic vertical cylinder.
  * Ground: acceleration/deceleration curves with a turn-around boost; walk/run blend for analogue sticks; sprint gated by stamina (drain, regen delay, minimum to re-sprint).
  * Air: free steering that never brakes momentum gained from pads, slides or dodges.
  * Jump: coyote time, jump buffering, variable height (release cuts upward velocity), and up to 2 **wall jumps** off the last wall contact.
  * **Slide:** speed boost, low hitbox, limited steering, friction. If there's no headroom it crawls until it can stand; jumping out keeps momentum.
  * **Dodge:** a 0.16 s directional burst, with cooldown and stamina cost and no invulnerability.
  * **Vault / mantle:** probes forward for an obstacle; a shallow one (≤ 2.6 m deep, 0.45–1.35 m high) is vaulted, a deeper one is climbed. From the air, ledges up to 1.3 m above the feet can be mantled. The destination and the whole path are checked for clearance **before** the scripted rise → hold → settle motion starts, so the player can never be snapped through geometry.
  * Integration is sub-stepped (≤ 0.22 m per sub-step), so nothing tunnels through thin walls even at 80 m/s.
* Bots use the **same controller and the same limits** as humans; the only thing that differs is where their input comes from.

## 4. Rules and tagging

* `rules.js` is a pure state machine: `createMatch`, `tick`, `canTag`, `applyTag`, `removePlayer`, `forceIt`, `protect`, `computeResult`, `snapshot`.
* A tag requires: phase `playing`; the tagger is IT, not out and not frozen; the target is a connected runner, not out and not spawn-protected; the tagger's cooldown has expired; and it isn't a tag-back within the no-tag-back window.
* Duplicate events are harmless: once a tag is applied the state changes (IT moves, cooldown starts), so a second identical request fails validation.
* **Offline:** `LocalMatch` checks contact every step (range plus vertical overlap plus line of sight) and applies tags directly.
* **Online:** the client only *requests* tags for runners it is touching. `GameServer.on_tag` re-checks every rule, then checks distance using a **200 ms history** of both players' server-side positions (lag compensation) and a line-of-sight test against the map. The server also runs a strict, non-compensated contact check every tick as a backstop.

## 5. Networking (`server/`, `src/multiplayer/`)

* **Protocol:** JSON text frames `{ t: type, ... }` with a version number in `hello`. Clients send: `hello, ping, profile, quick_play, list_rooms, create_room, join_room, rejoin, leave_room, ready, room_settings, kick, chat, invite, friends_status, start_match, loaded, state, dodge, tag, ability, pickup, emote, respawn`. The server sends: `welcome, pong, rooms, room, left_room, chat_history, chat, friends, invited, invite_sent, kicked, error, match_start, rules, event, snap, correct, ability, ability_denied, impulse, coin_taken, coin_spawn, coin_denied, match_end, player_left, player_back, emote`.
* **Lobbies and friends** (`server/game_server.py` social section, `src/multiplayer/friends.js`):
  * Each browser profile has a persistent 6-character **friend code**, sent in `hello` and validated by the server.
  * The client polls `friends_status` (every 4 s while a social screen is open) for presence. The server reveals a private lobby's code only to players who were invited to it.
  * `invite` notifies every connection with that friend code and grants it visibility of the lobby.
  * Lobbies have a name, public/friends-only privacy, a size (2 to max), a 40-line chat history (sanitised; rate-limited to a burst of 4, then about 2/s), system lines for joins, leaves and host changes, and host kicks with a 2-minute rejoin ban.
  * `?join=CODE` links join directly. `--public-url` / LAN addresses (`welcome.share`) are used to build invite links when the host is on localhost.
* **Authority:** the server owns rooms, readiness, host rights, mode/map choice, match state, timers, IT, eliminations, results, XP and coin awards, ability validation and the map coins. A client pausing never pauses the server.
* **Movement:** the client predicts its own movement for zero-latency controls and streams state at 20 Hz. `MoveValidator` rejects malformed data, out-of-bounds positions, bodies inside solids, moving while frozen, and excess speed. Speed uses a **token bucket**: the distance budget refills at the fastest legitimate sustained speed and is capped, so network jitter can't be exploited to accumulate speed. A rejected update triggers `correct` and the client snaps back. A validated ability calls `PlayerMotion.grant(...)`, which adds a one-off distance (Blink) and/or extra horizontal and vertical speed (Grapple, Rocket Jump, Shockwave knockback) for a short time, so legitimate ability movement passes while the same movement without the ability is still rejected.
* **Remote players** are rendered about 110 ms in the past from a snapshot buffer (interpolation, plus up to 150 ms of extrapolation to hide jitter), using a server clock estimated from ping/pong.
* **Robustness:** per-client rate limiting (60 msg/s; flooding disconnects the client); a hello timeout; size limits on frames and messages; sanitised names and cosmetics; a whitelist-only static file server that normalises paths before checking them (directory-traversal safe); host migration; a 30 s reconnect grace using a session token, with a full match resync on return.

## 6. AI (`src/ai/`)

* **NavGraph** is built automatically from the collision world in about 150 ms: walkable surfaces are sampled every 1.25 m, and nodes are linked as WALK, DROP, CLIMB (vault/mantle), JUMP (gap jumps up to 5 m) or PAD. Pad links are found by **simulating a real launch** with the controller. Nodes under low bars are flagged as slide-only.
* **BotBrain:** perception runs on a reaction timer. Chasers know runners only through line of sight or hearing (11 m); runners always know where IT is, just as the HUD shows IT to humans. Decisions run at 10 Hz:
  * **Chase:** target selection, then movement prediction (hard bots lead their target), direct steering at close range, otherwise A* over the nav graph.
  * **Flee:** samples candidate escape nodes and scores them by distance from IT, the cost of getting there, a penalty for running toward IT, and (normal/hard) escape options and high ground. Includes close-range sidesteps and slides.
  * **Wander** when safe, often toward the nearest gold coin.
  * **Perfect dodges:** once per approach the bot decides *when* to dodge, as a time-to-contact. A difficulty-scaled share of approaches aim for the perfect window but misjudge it by up to ±0.15 s; the rest flinch early (a plain sidestep before the window) or just run. The old rule (a ~10%-per-frame panic dodge inside 3 m) landed almost entirely inside the window, which is why bots used to perfect-dodge about half of all contacts.
  * **Abilities:** checked 4× per second. When IT is close and closing: Blink away, Cloak, Decoy, Shockwave (if within 3.5 m) or Rocket Jump. When chasing: Rocket Jump up to a runner more than 2.2 m above, or Blink toward one 4.5–9.5 m away in line of sight. Cloaked players are ignored beyond 3 m and never targeted by abilities; decoys appear to chasers as ordinary runners.
  * **Stuck recovery:** jump, then re-plan, then a random detour.
  * Mistakes and hesitation are scaled by difficulty.

## 7. Rendering and performance

* Map solids are merged into **one mesh per material**, with world-space UVs and per-face normals (degenerate ramp faces are skipped, since NaN normals would wreck the bloom pass). A thin edge trim on every walkable top makes traversable surfaces readable at speed.
* Presets set the pixel-ratio cap, shadow map size, **static vs dynamic shadows** (Medium bakes map shadows once and uses blob shadows for characters), point-light budget (0/0/3/6), bloom resolution, particle budget, draw distance and decor density. The first launch auto-selects a preset from the GPU name.
* Particles, rings and trails are pooled. Remote cosmetics are sanitised. Leaving a match disposes players, trails and loops, and maps dispose their GPU resources on unload.

## 8. Audio

* `AudioEngine` routes master → music / sfx / ui / ambience buses through a compressor. Every sound effect is synthesised (filtered noise plus oscillators) and spatialised by distance and stereo pan, with per-sound throttling and voice limits.
* Footsteps follow the animation's foot plants and vary with the surface material.
* `MusicPlayer` is a look-ahead step sequencer with five original tracks. A match's intensity rises as the clock runs down, adding layers.

## 9. Data files

* `config/game.json` holds movement, tag, match, mode, validation, progression and bot-difficulty tuning.
* `assets/maps/<id>.json` is generated by `tools/build_maps.py`. It contains `solids` (boxes and ramps, with material and variant), `pads`, `spawns`, `coinSpots`, `decor` (visual prefabs), `env` (sky, fog, lights, music) and `bounds`/`killY`. The builder validates spawns (free, grounded, in bounds, at least 10) before writing. Coin spots are platform tops (highest first, up to 8.5 m) then open ground, 4.5 m apart, each with headroom and clear of every solid including ramps.

## 10. Perfect dodge

* **Rule** (`perfectDodge` in `rules.js` / `perfect_dodge` in `rules.py`, with parity cases): the attempt must be a legal tag, the tagger is frozen until `delay + stunTime`, and the dodger gets `boostUntil` and short protection. No tag happens.
* **Detection:** a runner whose dodge started less than `window` (0.14 s) ago, with an IT within tag range + `nearMiss` (0.6 m) who is closing in at 3 m/s or more (or already touching), triggers it. A player who perfect-dodged can't do it again for `cooldown` (8 s), enforced by the rules on both sides.
  * **Offline:** `LocalMatch.detectPerfectDodges`.
  * **Online:** the server. The client sends `dodge`, the server stamps the time with a server-side cooldown (so spamming can't hold the window open), then checks near-misses each tick and turns tags during the window into perfect dodges.
* **Cinematic** (`src/effects/perfectDodge.js`, `src/effects/screenFx.js`): a director running on real time drives the session time scale (offline only), a post-processing shader (inversion, ripples, chromatic aberration, zoom blur, glitch, flash; added to the bloom composer or a lazy lightweight composer), the camera's `cine` offsets, afterimage clones, particles, audio (slow-motion low-pass) and the HUD title. The rules `delay` equals the cinematic's length in game time, so the stun starts when the cinematic ends.
* **No first-use hitch:** `Game.prewarmEffects()` runs while the loading screen is still up. It draws the effect pass, an afterimage, the cloaked (see-through) character variant and one object per ability-effect material in front of the camera, then compiles the rest of the scene and renders once. Two details matter. (1) Compiling isn't enough: drivers can finish a program lazily on its first real draw, so everything is actually drawn. (2) three.js deletes a program when the last material using it is disposed, so the warm-up materials in `abilityFx.js` are kept alive, and afterimages use a pool of 12 never-disposed materials plus a baked single-mesh pose (`CharacterModel.bakePose`) instead of cloning ~25 meshes. Measured on the dev laptop: first cinematic frame 686–875 ms → 14–30 ms; first match frame 1570 → 7 ms; first Blink 177 → 9 ms; first Grapple 585 → 32 ms; first Cloak 569 → 16 ms.

## 11. Abilities and coins

* **Data:** `config/game.json` → `abilities` (price, cooldown, and range/speed/duration/force per ability) and `coins` (match payouts, pickup value, map coin count, pickup radius, respawn time).
* **Shop and ownership:** `progression.js` stores `coins` and `abilities: { owned, loadout: [F, R] }` in the browser profile. `buyAbility` spends coins and auto-equips into a free slot; `equip` keeps the two slots positional (equipping into the other slot swaps). Coin payouts are a pure function (`computeCoins` / `compute_coins`) mirrored in JS and Python and covered by a shared rules case.
* **AbilitySystem** (`src/gameplay/abilities.js`) is shared by humans and bots: positional loadouts, per-ability cooldowns in sim time, `use(player, slot, aim)` → `execute(...)`. Movement abilities are controller methods (`blink` marches 0.25 m steps with `isFree` and follows ground, so it stops at walls; `startGrapple` / `_stepGrapple` (state 6) ends near the anchor, on timeout, when blocked, or on jump; `rocket`; `applyImpulse`). Decoys are their own `CharacterController` + hologram `CharacterModel`. Cloak is a time stamp checked by the HUD arrow, the bots' perception and the character renderer.
* **Online:** the client predicts its own ability and sends `ability` (with the Blink target / Grapple anchor / Decoy direction). `GameServer.on_ability` checks the phase, freeze, loadout (sent once with `loaded`, sanitised to 2 unique known ids), a 0.9× cooldown, Blink target distance and free space, and Grapple anchor range. It grants the movement allowance and relays the ability to everyone else, who replay it with `execute(..., remote=true)` (effects only). Shockwave knockback is decided by the server (`_shockwave`), which sends `impulse` to each victim and grants their extra speed. A refusal sends `ability_denied`; an illegal Blink is then also snapped back by the normal movement validation.
* **Map coins** (`src/gameplay/coins.js`): offline the session spawns and respawns them; online `Match` owns them (`coins` in `match_start`, `pickup` checked against the last 0.4 s of accepted positions, `coin_taken` / `coin_spawn` broadcasts, respawns in the match loop). Picked coins are counted by the rules (`collectCoin`) and paid out with the match award.
