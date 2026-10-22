# Testing

## How to run

```bash
# 1. Server, rules, networking and integration tests (Python, no dependencies)
python -m unittest discover -s tests -v

# 2. Browser suite: start the server, then open the test page
python server/main.py
#    http://localhost:8080/tests/browser/
```

The browser page shows each result and exposes `window.__TEST_RESULTS__` for automation.

## Latest results (development machine: Windows 11, Intel UHD GPU, Chromium)

### v1.03: Scramble, new emotes, new characters, intro cutscene, motion blur (2026-10-22)

- **Python: 81 / 81 passed.** New: a Scramble online hits the player 5 m away in the open with one of the three modes (the caster is told too) and nobody when they're 27 m away; the Griddy and Buggin' are relayed while an unknown emote id isn't.
- **Browser: 140 / 140 passed.** New tests:
  - Scramble remaps controls correctly (inverted, mirrored with jump/slide swapped, spun 90°, in camera and world frames).
  - Offline Scramble doesn't go through a wall, hits a player 5 m away in sight, never the caster, remaps a scrambled bot's input and wears off after 3.5 s.
  - Every emote has a key, a duration and a pose that really moves (finite joints every frame); moving cancels an emote.
  - The character is one skinned mesh with 3 material groups, about 6,600 vertices and 1.95 m tall.
  - The intro camera's orbit is in the open on every map (at least 16 of 24 points free) and stays under the Mall's and Factory's ceilings.
  - Motion blur stays off for a still camera, blurs along a turn (no vertical smear for a pure yaw), ignores a camera cut, adds the radial streak at top speed and never runs when switched off.
- **Real client checks:** the new mannequin close up (pearl white matches the reference look; the user's own red suit and cap still apply); the intro on the Waterpark (outdoor), the Mall (indoor, framed in the atrium) and Rooftops, with the swoop and the hand-off to the countdown; Scramble from the player (two bots in range scrambled, one far away not, the cooldown on the F slot, glitch glyphs over the victims) and on the player (banner, status timer, glitch overlay, W moving backwards when inverted); the Griddy and Buggin' close up and in the Customise preview; motion blur during a fast camera turn (edges smeared, the character sharp); the Scramble card in the shop; the *What's new* screen for v1.03.
- **Not checked by hand:** how Scramble *feels* to play against real people online; the intro on a slow machine (the server waits up to 16 s for everyone to finish loading and watching).

### v1.02: new maps, modes, map events, performance and lag (2026-10-21)

- **Python: 79 / 79 passed.** New tests:
  - Rule parity (both languages): Hot Potato (tags pass the potato, the fuse keeps burning, the holder explodes, the potato goes to whoever held it least, the fuse gets shorter; with two players the first explosion ends it) and Shrinking Zone (4 s outside knocks a runner out, going back in recovers, IT is immune, the ring closes; survivors win on time).
  - Server, with real WebSocket clients: a Hot Potato match where the fuse runs out, the holder explodes and the other player wins (`last_runner`); a Shrinking Zone match where a runner left 15 m outside a small ring is eliminated by the server after 4 s while the runner inside isn't; a map event announced ahead in the rules snapshot (`ev`), Coin Rain dropping bonus coins that don't respawn once taken; snapshot rows carrying each player's receive time.
  - Movement validation on the new maps: a boosted slide along a Factory belt in Overdrive is accepted, the same speed on plain floor is rejected; riding a Waterpark slide at Slide Rush speed is accepted along the slide, the same speed on open ground is rejected.
- **Browser: 128 / 128 passed.** New tests:
  - The three new maps pass every map check: spawns, navigation connects every spawn both ways, pads, 60 s random-movement stress, coin spots (Mall 35/36 on the bot graph, Waterpark 33/36, Factory 30/36), and a Normal bot catching a runner across the whole map (Mall 44.5 s, Waterpark 39.2 s, Factory 38.3 s).
  - Zones: water slows you to its speed factor; a conveyor carries you at its speed and Overdrive reverses it at double speed; the Factory's real belts carry you.
  - Slides: a slide is ridden end to end and shoots you out; Slide Rush makes it faster; Rocket Jump can't interrupt a ride; **every slide on the Waterpark (7) and Factory (1), at normal and Slide Rush speed, lands the rider grounded, inside the map, out of every wall**, and the bots' graph has a ride link for each.
  - Low gravity jumps higher; wet floors take more than twice as far to stop.
  - Full 8-bot headless matches: Hot Potato on the Mall (7 explosions, one winner, 119 s), Shrinking Zone on the Waterpark (the ring closed, last runner standing at 130 s) and Classic on the Factory.
  - Map events: the scheduler warns 3 s ahead, keeps the first event in 30–45 s and the gaps in 40–60 s, never repeats a kind back to back and never starts one in the last 12 s; event effects only apply while the event is on; every map lists known events (the Mall and Factory can lose power); Coin Rain coins don't respawn.
  - Version: `version.js`, `config/game.json` and the newest changelog entry agree; the changelog is newest first and complete.
- **Real client checks** (in-app browser): the *What's new* screen opens once for a new version and from the menu; the main menu (10 entries) fits an 800×600 window. Hot Potato on the Waterpark: fuse clock, holder banner, the bomb with its spark over the holder's head, explosion → eliminated → spectating, the next round with a shorter fuse. Shrinking Zone: "Ring closes in …", the red ring wall and vignette with "GET IN THE RING! 2.2 s · 6 m" when outside. A Power Outage on the Mall: warning, lights out with green emergency lights, radar arrow hidden. Riding a Waterpark slide; a bot climbing a spiral tower.
- **Bugs found and fixed while testing this update:**
  - The Waterpark's tower stairs were too steep for the bots' navigation (they couldn't reach two spawn points). The flights now collide as smooth slopes with the steps drawn on top.
  - Slide Rush had no effect on slides too short to reach top speed; it now scales the ride speed itself (and the server allowance).
  - The red "outside the ring" vignette could stay on into the next match.
  - A non-finite sound volume (from a broken camera position) threw an error every frame; sounds now fall back to silent.
  - Earlier in this update: the attract match's arena could stay loaded invisibly behind a match; the Mall's first load took about 5 s (now about 1 s).
- **Not measured:** new FPS figures. The in-app browser ran in the background, where GPU timings are unreliable (the same scene measured faster with 9 bots than with none). The deterministic part: a full 10-player match now issues about 70–125 draw calls per frame.

### Abilities, coins and the perfect-dodge rework (2026-10-21)

- **Python: 69 / 69 passed.** New tests:
  - Movement grants: a 9 m jump is rejected, but accepted right after a validated Blink. The allowance is used up, and an unused one expires. Grapple speed is allowed only while granted.
  - Server, with real WebSocket clients: loadouts are sanitised and abilities that aren't equipped are refused; cooldowns are enforced per ability and uses are relayed to other players; a Blink into a wall or too far away is refused, while a legal Blink is relayed and the following movement is accepted with no correction; Shockwave pushes only players in range (away and up) and grants their speed.
  - Map coins: the right number spawn with unique ids; standing at a coin picks it up, it's broadcast and the rules count it; picking the same coin twice, or one across the map, is refused; respawns broadcast.
  - Rule parity: the coin payout (`coinAward`) and the perfect-dodge cooldown.
- **Browser: 90 / 90 passed.** New tests:
  - Blink travels its full range in the open, stops before a wall (never inside it), and refuses when there's no room.
  - Rocket Jump reaches the expected apex.
  - Grapple reaches its anchor and lets go there; jumping releases it with a hop; a wall in the way stops it.
  - Offline Shockwave pushes only players in range.
  - Cooldowns, empty slots and Cloak duration.
  - Decoys run off, look like runners to bots, and pop when IT touches them.
  - Bots ignore a cloaked runner beyond 3 m and notice them once uncloaked.
  - Every map's coin spots stand on walkable ground, are free, and are reachable by bots (Rooftops 32/36, Arena 34/36, Docks 30/36, Training 35/36).
  - Offline coin pickup counts and respawns.
  - Shop: can't afford, buy, auto-equip, positional slots, swap, clear, no double buy, can't equip what you don't own.
  - Key bindings: the defaults never collide, and old saves move F from Slide to Ability 1.
- **Bots and perfect dodges:** IT homes in on a fleeing Normal or Hard bot 40 times. Result: **3 perfect dodges**, 35 tags, 2 escapes. With the old bot logic, about half of all contacts were perfect-dodged: its fallback "panic dodge" fired about 10% per frame once IT was within 3 m, which is almost entirely inside the perfect window.
- **First-use frame times** (real client, Rooftops, synchronous render + `gl.finish`), before → after `Game.prewarmEffects`:

  | | Before | After |
  |---|---|---|
  | First perfect-dodge frame | 686–875 ms | 14–30 ms |
  | First frame of a match | 1570 ms | 7 ms |
  | First Blink | 177 ms | 9 ms |
  | First Grapple | 585 ms | 32 ms (later uses 7–18 ms) |
  | First Cloak | 249–569 ms | 16 ms |
  | Decoy / Rocket / Shockwave | 5–25 ms | 5–10 ms |

  The prewarm itself takes about 0.9–1.1 s, behind the loading screen.
- **Real client checks:** the menu shows the Abilities entry with the coin balance, and the player card shows coins and the F/R loadout. In the shop, buying Blink with the 100 starting coins auto-equipped it on F. In a practice match the HUD shows both ability slots with key labels and cooldown counters, the coin counter, and the green grapple ring when a surface is in range. The menu fits a 800×600 window.
- **Real online match (two browser tabs):** both clients loaded the server's 10 coins. Shockwave and Grapple were relayed to the other client and replayed there (the rope appeared, then cleaned up). Abilities that weren't in the loadout the player joined with were refused by the server (`ability_denied`). Walking to a coin produced a server-validated `coin_taken`, the HUD counter showed 1, and the server's rules counted it. No console errors.

### Earlier results (2026-10-20)

- **Python: 60 / 60 passed** (`tests/test_rules.py`, `tests/test_server.py`, `tests/test_online.py`), including 6 lobby/friends tests, 8 internet-hosting tests, 3 server perfect-dodge tests and 2 perfect-dodge rule-parity cases:
  - cloud environment detection and invite addresses
  - `/healthz`
  - the `start-online` tunnel launcher, driven by a fake `cloudflared`: public-link parsing, the tunnel staying up, and the failure message
- Cloud mode smoke test: started with Render's `PORT` and `RENDER_EXTERNAL_URL`. It listened on all interfaces, `/healthz` returned 200, and the welcome message advertised the public address used for invite links.
- **Browser: 71 / 71 passed**, including the perfect dodge:
  - a well-timed dodge evades the tag, stuns IT and boosts the runner
  - a dodge that's too early gets no reward
  - the boost speed is correct
  - the cinematic slows time to 0.15× and fully restores time and screen
- **Perfect dodge in the real client:** a bot IT charged; the timing cue showed NOW! in the last ~0.1 s; an injected Q press triggered the cinematic (time 0.15×, inverted screen, camera sweep, IT frozen). Screenshots were taken and there were no console errors.

Highlights from the browser run:

- A normal-difficulty bot chases down a runner from the farthest spawn on every map: Rooftops 9.8 s, Arena 4.7 s, Docks 11.9 s, Training 6.1 s.
- Full headless 8-bot matches with the real rules:
  - Classic on Rooftops: timer end, 12 tags in 180 s.
  - Infection on Arena: everyone infected after 33 s.
  - Last Runner on Docks: one runner left after 107 s.
  - Classic on Training: timer end, 19 tags.

## Coverage of the required scenarios

| # | Scenario | Covered by |
|---|---|---|
| 1 | Move, jump, sprint, land correctly | browser: *accelerates to run speed*, *sprint…stamina*, *jump reaches expected apex and lands*, *variable jump*, *coyote time*, *jump buffer*, *stairs*, *ramp* |
| 2 | Cannot walk through solid walls | browser: *cannot walk through a solid wall*, *no tunnelling at extreme speed*; every map: *60 s random-movement stress* (8 controllers, random inputs, checked every step) |
| 3 | No unintended mid-air jumps | browser: *no double jump in mid-air*; wall jumps capped (*wall jump…limited count*) |
| 4 | Sliding works | browser: *slide: boosts speed, lowers the body, then recovers*, *slide passes under a low bar; running does not* |
| 5 | Vaulting doesn't teleport through obstacles | browser: *vault over a low obstacle without passing through it* (body checked against solids every step), *mantle onto a 2.4 m ledge*, *cannot climb a 4 m wall* |
| 6 | A valid tag transfers IT exactly once | shared rule cases (both implementations): *classic: valid tag transfers IT exactly once…*, *duplicate tag events are processed once*; Python integration: server-confirmed tag + duplicate request ignored |
| 7 | Invalid tags rejected | shared rule cases: *invalid tags* (self, unknown, IT target, not IT, out), *countdown*, *spawn protection*; integration: out-of-range tag rejected |
| 8 | Tag cooldowns | shared rule cases: freeze, cooldown, no-tag-back |
| 9 | Match timers | shared rule cases: timer expiry (classic, infection); headless matches |
| 10 | Each mode ends correctly | shared rule cases for classic / infection (both outcomes) / Last Runner (both outcomes) / practice never ends / Hot Potato / Shrinking Zone (both outcomes); headless matches for each mode; server Hot Potato and Zone matches |
| 11 | Bots navigate and recover | browser: *chases down a runner across the whole map* (all 7 maps), *boxed in behind an obstacle recovers*; navigation QA (*graph connects every spawn both ways*, *every jump pad lands somewhere walkable*) |
| 12 | Lobby state synchronised | Python integration: both clients receive the identical room view; host-only settings; readiness; host migration; quick-play pairing; room capacity. Social tests: friend codes, presence (private lobby code hidden until invited), invites, lobby browser (public only), chat (history, sanitising, rate limit), rename/privacy/size clamping, kick + temporary ban |
| 13 | Disconnects handled safely | Python integration: IT disconnects → `player_left`, IT handed over, match ends with a valid result and award, room returns to lobby; reconnect with token resumes identity; shared rule case *disconnect…* and *players who disconnect are ranked last* |
| 14 | Settings persist | browser: *settings persist to storage*; manually verified preset switching, FOV and render scale apply live |
| 15 | Every menu button works | browser: *every data-action in the UI has a handler* (38 actions), *every screen referenced by navigation exists*; manual pass below |
| 16 | No holes, broken collision or out-of-bounds exploits | map builder validation (spawns free and grounded); browser *spawns are free, grounded and inside bounds*; *random-movement stress* (bounds, kill-plane, solids) on all maps |
| 17 | Playable without a network | offline matches and bots need no connection (three.js is vendored); the headless match tests run the offline path |
| 18 | Abilities can't break movement or be abused online | browser: Blink/Grapple never end inside geometry, cooldowns; Python: grants, cooldowns, target validation, knockback decided by the server |
| 19 | Coins are earned fairly | rule parity for the payout; server-owned map coins with distance-checked pickups; every coin spot is reachable; Coin Rain coins never respawn (browser and server) |
| 20 | Water, conveyors and slides behave | browser: water speed factor, conveyor carry and reversal, every slide ridden to a safe landing at both speeds, ride links for bots; server: conveyor and slide movement allowances |
| 21 | Map events are fair and in sync | browser: scheduler timing, no repeats, nothing at the very end, effects only while active; server: the event is announced in the rules snapshot before it starts |
| 22 | Players see each update's changes | browser: version and changelog agree; manual: *What's new* opens once per version |

Additional server tests:

- WebSocket framing (RFC 6455 example key; masked frames of every length class; unmasked or oversized frames rejected).
- Map collision and line of sight.
- Movement validation: normal sprinting accepted; teleport, sustained speed hack, wall clipping, moving while frozen and malformed data rejected.
- Static file whitelist and path traversal (`/src/../server/main.py` is refused).
- Protocol version mismatch, name and cosmetic sanitising, rate limiting.

## Manual verification in the real client

**Lobbies with friends (three browser tabs on one server):**

- Background connection at start-up, with the friend code confirmed by the server.
- The host created a friends-only lobby. A friend added the host's code, which showed "in lobby … · friends-only" with no Join button.
- The host added the friend and pressed Invite. The friend got the pop-up, joined, chatted and readied up.
- The host renamed the lobby, set the size to 4 and switched it to Public. The friend left, found it in the lobby browser and joined.
- A third tab opened `/?join=CODE` and landed in the lobby with chat history.
- All three readied up and the host started the match. Everyone loaded the online match, with no console errors.

The UI kick button and the invite pop-up's "Join after match" path were not clicked through, because they rely on `confirm()` dialogs and a running match. The kick server logic is covered by the tests above.

Done in the in-app browser against the running server:

- Main menu with the live 3D attract match, plus the Play, Practice, Customise (3D preview, locked items), Profile, Settings (all tabs), Controls, Credits, Pause and Results screens.
- An offline match on every map, checking the HUD (clock, IT line, objective, threat arrow, stamina, cooldowns) and the countdown → GO → results flow.
- **Real online match between two browser tabs:** create a private room → join by code → ready → host start → both load the arena → the host's movement streamed and accepted (0 corrections) → server-confirmed tag → both clients agree on the new IT → the guest disconnects → the host gets `match_end` with server-awarded XP → results screen.
- Graphics presets switched live with no errors. Frame cost was measured per preset (see the README).

Bugs found by this testing and fixed:

- Path traversal in the static server.
- Initial players treated as late joiners when the countdown is 0.
- NaN normals on ramp faces causing black bloom rectangles.
- Disconnected players ranked first.
- A vault arc that clipped obstacle corners.
- Lost key presses on high-refresh displays.
- Touch UI showing on desktop.
- Ctrl+W closing the tab when sliding.
- High and Ultra presets too slow on integrated GPUs (point-light and shadow budget).

## Not tested (no hardware or environment available)

- **Physical gamepads:** implemented with the standard Gamepad API mapping (Xbox/PlayStation layouts), including menu navigation. Untested with a real controller.
- **Physical touch devices:** touch controls verified in a touch-emulating browser pane only.
- **A live Cloudflare tunnel and a real cloud deployment:** not run from here. That needs downloading `cloudflared` and opening a public endpoint (your go-ahead), or your hosting account. The launcher logic and cloud configuration are tested as described above.
- **Real internet latency and packet loss:** tested on localhost (about 3 ms ping). The adaptive interpolation delay, extrapolation and lag-compensation windows are configurable in `config/game.json`. The live site's ping was measured from Ireland at 250–330 ms to first byte (Render's default Oregon region); a Frankfurt server would cut most of that.
- **Other GPUs and browsers:** measured on Intel UHD with Chromium only. Firefox and Safari should work (standard WebGL 2 and ES modules) but weren't run.
- **Audio by ear:** the audio graph runs without errors, but no one has listened to the synthesised sounds and music on real speakers.

## Limitations

- Bots are offline only; online rooms need 2 or more humans.
- Progression is stored locally. Online XP and coins are server-computed, but local storage isn't tamper-proof. In particular, the server can't verify which abilities a player bought; it enforces the loadout shape, cooldowns and every effect.
- The Shockwave knockback on a remote player starts when *their* client receives the `impulse` (one network trip), not on the caster's screen instantly.
- Not felt by hand: how the abilities *play* with a real mouse and keyboard, on real hardware, against real people. They were exercised by scripts and tests here, not by a human.
- Server movement validation is a practical safeguard (speed, teleport, solids, freeze); it doesn't re-simulate physics. The game isn't cheat-proof.
- Procedural characters and animation (no authored or motion-captured models); no moving platforms (conveyors, escalators and slides are the dynamic traversal).
- No Exit button: not applicable to a browser game.
