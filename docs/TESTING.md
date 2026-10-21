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

## Latest results (2026-10-21, development machine: Windows 11, Intel UHD GPU, Chromium)

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
| 10 | Each mode ends correctly | shared rule cases for classic / infection (both outcomes) / Last Runner (both outcomes) / practice never ends; headless matches for each mode |
| 11 | Bots navigate and recover | browser: *chases down a runner across the whole map* (all 4 maps), *boxed in behind an obstacle recovers*; navigation QA (*graph connects every spawn both ways*, *every jump pad lands somewhere walkable*) |
| 12 | Lobby state synchronised | Python integration: both clients receive the identical room view; host-only settings; readiness; host migration; quick-play pairing; room capacity. Social tests: friend codes, presence (private lobby code hidden until invited), invites, lobby browser (public only), chat (history, sanitising, rate limit), rename/privacy/size clamping, kick + temporary ban |
| 13 | Disconnects handled safely | Python integration: IT disconnects → `player_left`, IT handed over, match ends with a valid result and award, room returns to lobby; reconnect with token resumes identity; shared rule case *disconnect…* and *players who disconnect are ranked last* |
| 14 | Settings persist | browser: *settings persist to storage*; manually verified preset switching, FOV and render scale apply live |
| 15 | Every menu button works | browser: *every data-action in the UI has a handler* (38 actions), *every screen referenced by navigation exists*; manual pass below |
| 16 | No holes, broken collision or out-of-bounds exploits | map builder validation (spawns free and grounded); browser *spawns are free, grounded and inside bounds*; *random-movement stress* (bounds, kill-plane, solids) on all maps |
| 17 | Playable without a network | offline matches and bots need no connection (three.js is vendored); the headless match tests run the offline path |
| 18 | Abilities can't break movement or be abused online | browser: Blink/Grapple never end inside geometry, cooldowns; Python: grants, cooldowns, target validation, knockback decided by the server |
| 19 | Coins are earned fairly | rule parity for the payout; server-owned map coins with distance-checked pickups; every coin spot is reachable |

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
- **Real internet latency and packet loss:** tested on localhost (about 3 ms ping). Interpolation, extrapolation and lag-compensation windows are configurable in `config/game.json`.
- **Other GPUs and browsers:** measured on Intel UHD with Chromium only. Firefox and Safari should work (standard WebGL 2 and ES modules) but weren't run.
- **Audio by ear:** the audio graph runs without errors, but no one has listened to the synthesised sounds and music on real speakers.

## Limitations

- Bots are offline only; online rooms need 2 or more humans.
- Progression is stored locally. Online XP and coins are server-computed, but local storage isn't tamper-proof. In particular, the server can't verify which abilities a player bought; it enforces the loadout shape, cooldowns and every effect.
- The Shockwave knockback on a remote player starts when *their* client receives the `impulse` (one network trip), not on the caster's screen instantly.
- Not felt by hand: how the abilities *play* with a real mouse and keyboard, on real hardware, against real people. They were exercised by scripts and tests here, not by a human.
- Server movement validation is a practical safeguard (speed, teleport, solids, freeze); it doesn't re-simulate physics. The game isn't cheat-proof.
- Procedural characters and animation (no skinned models); no moving platforms.
- No Exit button: not applicable to a browser game.
