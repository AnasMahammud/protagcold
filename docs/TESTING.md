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

## Latest results (2026-10-20, development machine: Windows 11, Intel UHD GPU, Chromium)

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
- Progression is stored locally. Online XP is server-computed, but local storage isn't tamper-proof.
- Server movement validation is a practical safeguard (speed, teleport, solids, freeze); it doesn't re-simulate physics. The game isn't cheat-proof.
- Procedural characters and animation (no skinned models); no moving platforms.
- No Exit button: not applicable to a browser game.
