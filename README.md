# PRO TAG

A fast 3D parkour tag game. Vault, slide, mantle, wall-jump and dodge across seven arenas, from neon rooftops to an overgrown abandoned mall, a giant waterpark and a toy factory. Play six modes (including Hot Potato and Shrinking Zone) offline against bots, or online against friends through the included authoritative server.

**Current version: v1.05.** The first time you open a new version, a *What's new* screen lists the changes (you can reopen it from the main menu).

Every match opens with a short cutscene: the camera circles the arena with its name, the mode and who's playing, then swoops down behind you for the countdown. Any key or a click skips it.

And every match ends with one: **VICTORY** slams onto the screen letter by letter in gold, with an impact shake, light rays and confetti cannons, or **DEFEAT** crashes down and cracks with a red glitch and drifting ash. Meanwhile the camera circles the winner, who keeps dancing behind the results screen: a podium for the top three, then your stats, XP, Battle Pass XP and coins counting up. *Reduce flashing* turns the shake and flashes off.

**No installation beyond Python.** The game runs in any modern browser (Chrome, Edge or Firefox). The server is plain Python 3 with no `pip install`.

---

## Quick start (Windows)

1. Install **Python 3.10 or newer** from <https://www.python.org/downloads/>. Tick *"Add python.exe to PATH"* during setup.
2. Pick what you want to do:

| I want to… | Do this |
|---|---|
| **Play on my own** (bots, practice) | Double-click **`start-game.bat`** → **Play → Start offline match** |
| **Play with friends: give them a website to type in** (recommended) | Double-click **`publish-website.bat`** once and follow its 2 steps. You get your own address like `https://pro-tag.onrender.com`, with multiplayer built in, that you and your friends open any time. See [Your own website](#your-own-website-recommended). |
| Play with friends tonight without making accounts | Double-click **`start-online.bat`** and send friends the temporary link it prints (works while that window stays open) |

Or start it from a terminal (VS Code: *Terminal → Run Task → PRO TAG: start server*):

```bash
python server/main.py
```

Then open <http://localhost:8080>. Stop the server with `Ctrl+C`.

Options:

```bash
python server/main.py --port 9000          # another port
python server/main.py --host 0.0.0.0       # LAN play (see "Online play")
python server/main.py --verbose            # debug logging
```

> The game must be opened through the server (`http://localhost:8080`). Opening `index.html` directly from disk (`file://`) won't work, because browsers block ES modules there.

## How to play

- **Classic Tag:** one player is IT. Touch a runner to pass IT on. The player with the **least total time as IT** wins. New ITs are stunned for 1 s, and there are no instant tag-backs.
- **Infection:** tagged runners join the infected. Runners win if anyone survives the clock; the infected win if everyone is caught.
- **Last Runner:** tagged runners are eliminated and spectate (press Jump to switch who you watch). The last runner standing wins.
- **Practice:** no clock. Train every move on any arena, with 0 to 7 bots. Press **T** to swap who is IT.
- **Hot Potato:** whoever is IT holds a lit bomb. Tagging someone passes it on, but the fuse keeps burning (25 s, 3 s shorter every round, down to 12 s). When it runs out, the holder explodes and is out, and the potato goes to whoever has held it least. Last one standing wins. There is no match clock.
- **Shrinking Zone:** classic chase inside a ring that starts closing after 20 s and keeps shrinking to 7 m for the next 140 s. Tagged runners are out, and so is any runner who spends 4 s outside the ring (the time recovers slowly once you're back inside). The HUD shows when the ring closes, and an arrow and countdown when you're outside.

Tagging is automatic on contact. The HUD always shows who is IT, a directional arrow to the nearest threat (or, if you are IT, the nearest runner within 30 m), your stamina, the dodge and slide cooldowns, your two ability slots and the gold coins you've grabbed. Hold **Tab** for the scoreboard.

### Arenas

| Arena | What's special |
|---|---|
| Neon Rooftops | Night-time city roofs, gaps to jump, cranes and billboards |
| Pulse Arena | Indoor chase-tag stadium with blocks, bars and ramps |
| Sunset Dockyard | Containers, cranes and a harbour |
| Training Ground | Small and simple; every move in one place |
| **Overgrown Mall** (new) | A huge abandoned three-storey mall taken over by plants: atrium with a skylight, escalators that carry you, a sky bridge, a fountain and 46 shops |
| **Splash Kingdom** (new) | A sunny mega waterpark: spiral stair towers, pools that slow you down, and seven water slides you ride from the top (a great escape route) |
| **Toy Factory** (new) | Conveyor belts that carry you, giant toy blocks, catwalks, robot arms and a chute into the ball pit |

### Map events

Every 40–60 s an arena throws an event at everyone, announced 3 s ahead in the HUD:

| Event | Effect | Where |
|---|---|---|
| ⚡ Power Outage | Lights go out (emergency lights only), the radar arrow and name tags disappear, bots see less | Mall, Factory, Rooftops, Arena |
| 🪙 Coin Rain | Bonus coins drop from the sky; grab them before they're gone (they don't respawn) | Everywhere |
| 🪐 Low Gravity | Jump higher, fall slower | Rooftops, Docks, Factory, Training |
| ⚙ Conveyor Overdrive | Every belt and escalator reverses at double speed | Factory |
| 💦 Wet Floors | Sprinklers on: slippery floors, longer slides | Mall, Waterpark |
| 🏃 Speed Surge | Everyone runs 15% faster | Mall, Waterpark, Arena, Docks, Training |
| 🌊 Slide Rush | Water slides go 50% faster | Waterpark |
| 🌫 Fog Bank | Thick fog rolls in | Rooftops, Docks |

Online, the server schedules the events so everyone gets the same one at the same moment. Tuning: `config/game.json` → `mapEvents`; which events a map has: `events` in its `env` in `tools/build_maps.py`.

### Controls (defaults, all rebindable in Settings → Controls)

| Action | Keyboard / mouse | Controller | Touch |
|---|---|---|---|
| Move / look | WASD / mouse | Left / right stick | Left half drag / right half drag |
| Jump, wall jump | Space | A | Jump button |
| Sprint | Shift (hold) | RB (hold) or L3 | Sprint toggle, or push the stick fully |
| Slide | C | B or LT | Slide button |
| Dodge | Q or right mouse | LB | Dodge button |
| Vault / climb | E (also automatic) | X | Vault button |
| Ability slot 1 / 2 | F / R | Y / RT | Ability buttons (show the equipped icons) |
| Emotes: wave, groove, flex, Griddy, Buggin', robot, then the Battle Pass ones (salute, chicken dance, chill, moonwalk) | 1 – 9, 0 | D-pad ↑ ← →, R3 cycles Griddy / Buggin' / robot | — |
| Scoreboard | Tab | View | — |
| Practice: swap IT | T | D-pad ↓ | — |
| Pause | Esc / P | Menu | ❚❚ |

Ctrl isn't a default binding on purpose: in a browser window, Ctrl+W (slide + forward) closes the tab. If you bind Ctrl, play in fullscreen (Settings → Graphics), where the game locks browser shortcuts.

**Movement tips:** run into low walls to auto-vault. Jump at ledges up to about 3 m to mantle up. Jump again while touching a wall to wall-jump (twice). Jumping out of a slide keeps its momentum. Dodge has a cooldown and normally does **not** make you invulnerable, except for a perfect dodge (below).

### Perfect dodge

Press **dodge** (Q, right mouse, LB, or the touch Dodge button) at the last moment, just as IT is about to reach you.

- **It's hard on purpose:** the window is about 0.14 s, IT has to really be lunging at you, and after a perfect dodge you can't land another one for 8 s.
- **The timing ring:** when IT closes in, a ring shrinks onto a target circle in the middle of the screen. Dodge as they meet. The **Perfect-dodge assist** setting (Accessibility) adds a **NOW!** flash inside the window; it's off by default.
- **The cinematic:** time slows to 15% (offline), the world flips into an inverted neon negative, shockwaves ripple out from you, afterimages trail your dodge, and the camera sweeps around you. Then time snaps back with a flash.
- **The reward:** IT is stunned (dizzy stars) until 1 s after the cinematic ends, and you get a **5-second speed boost** (+30%, full stamina) with a short moment of protection.
- **Online:** the server decides perfect dodges, so they're fair and can't be faked. You see the same cinematic, but the world isn't slowed, because other players' time can't be.
- **Bots** on Normal and Hard can pull it off, but like a human they misjudge the moment: in the test suite a bot perfect-dodges roughly 1 charge in 13. (Before this update they nailed about half.)
- **No lag:** every shader the cinematic needs is compiled and drawn once behind the loading screen, so the first perfect dodge of a match no longer freezes the game (it used to stall ~0.7–0.9 s).
- **Accessibility:** "Reduce flashing & shake" tones the inversion down and removes the flashes and glitches.
- **Tuning:** all values are in `config/game.json` under `perfectDodge`.

### Abilities and coins

Spend **coins** in the **Abilities** shop (main menu) and equip two abilities, one on **F** and one on **R**.

| Ability | Price | Cooldown | What it does |
|---|---|---|---|
| Blink | 100 | 9 s | Teleport up to 9 m the way you're moving (or looking). It stops at walls, so it can't clip through anything. |
| Rocket Jump | 200 | 8 s | Blast yourself straight up with a small forward kick. It works mid-air, so you can reach rooftops in one move. |
| Decoy | 250 | 14 s | Drop a hologram of yourself that sprints off. Bots, and careless friends, chase it; it pops when IT touches it. |
| Grapple | 300 | 10 s | Fire a hook at whatever is under your crosshair (up to 24 m) and zip to it. The crosshair turns into a green ring when a surface is in range. Jump to let go early. |
| Cloak | 350 | 18 s | Turn almost invisible for 4 s: no name tag, no HUD arrow pointing at you, and bots lose track of you beyond 3 m. |
| Shockwave | 450 | 16 s | Blast everyone within 6 m away from you and into the air. Escape a corner, or knock runners off a roof. |
| Scramble (new) | 400 | 15 s | Glitch everyone within 9 m who can see you: for 3.5 s their controls are inverted, mirrored (with jump and slide swapped) or spun 90°. Stop a chaser cold, or as IT make a runner stumble into you. |

**Earning coins:** every match pays out for playing (+15), tags (+4 each), survival (+1 per 10 s), winning (+25) and perfect dodges (+8 each). On top of that, **10 gold coins** are scattered around every arena (+3 each, respawning after 18 s), mostly up high on rooftops and platforms, so parkour pays. New players start with 100 coins: enough for Blink.

**Bots** get random abilities on Normal (one) and Hard (two) and use them tactically: blinking, cloaking, shockwaving or scrambling when IT is on them, rocket-jumping up to runners above them, scrambling a runner who's just out of reach, and grabbing coins when nobody's chasing them. A scrambled bot stumbles about too.

**Online**, the server validates every ability: it must be in the loadout you joined with and off cooldown, Blink must land somewhere legal, and the Grapple anchor must be in range. The server grants exactly the extra movement that ability allows (so the anti-cheat doesn't snap you back), decides who a Shockwave hits and pushes them, decides who a Scramble hits (and how their controls get mixed up), and owns every map coin: it spawns them, checks you were really standing at a coin before counting it, and pays coins out with the match result.

All the numbers are in `config/game.json` under `abilities` and `coins`.

## Online play

The server in `server/` is authoritative. It decides IT status, tags, eliminations, timers, results, XP and coins. Clients send only their movement (validated for speed, teleports, wall-clipping and freeze), plus tag, ability and coin-pickup *requests*, which the server checks (tags with lag compensation).

**Lag (v1.02):** movement is sent and broadcast 30 times a second (was 20), and jumps, dodges, slides, vaults and abilities go out the instant they happen. Each snapshot row carries the time the server received that player's movement, and the client measures the jitter and draws other players only as far in the past as it needs to (typically 60–80 ms, at most 140 ms; it was a fixed 110 ms on top of the slower 20 Hz updates). The match HUD shows your ping and that delay.

**Ping depends mostly on distance to the server.** Render puts a new service in Oregon (USA) unless told otherwise, which adds roughly 150 ms of round-trip ping for players in Europe. If you and your friends are in Europe, add `region: frankfurt` under the service in `render.yaml` before deploying. An existing Render service can't change region: you'd deploy a new one, which gets a new address.

### Your own website (recommended)

This puts the whole game, including the multiplayer server, on the internet at a fixed address. Friends type that address into any browser (PC, laptop, even phone), and everyone meets there. You don't need to keep anything running on your PC.

It uses two free services: **GitHub**, which stores your game's files, and **Render**, which runs the website. If you don't have a GitHub account, make one first at <https://github.com/signup>.

1. Double-click **`publish-website.bat`**.
2. **Step 1 (GitHub):** type your GitHub username and press Enter twice to keep the name `pro-tag`. GitHub's "new repository" page opens with everything filled in, so just click **Create repository**, then press Enter in the black window. Your game uploads; the first time, a browser window asks you to sign in to GitHub.
3. **Step 2 (Render):** Render's deploy page opens. Sign in **with GitHub**, then click **Deploy Blueprint** without changing anything. After 2–3 minutes it says **Live**, and the address at the top (something like `https://pro-tag.onrender.com`) is your game. Paste it into the black window so the script remembers it.
4. Send that address to your friends. Everyone opens it, clicks **Play → Create lobby** or **Join with code**, and plays together.

**Updating the game later:** run `publish-website.bat` again. It uploads your changes and Render updates the website by itself within a few minutes.

**Good to know**

- **Free sites take a nap.** A free Render website sleeps after 15 minutes with nobody on it. The first person to open it afterwards waits about a minute while it wakes up; after that it's instant.
- **The code is public.** Your game's code goes into a public GitHub repository, which Render's one-click deploy needs. Commits are made under your GitHub username with GitHub's private "noreply" email, never your personal or school address.
- **Progress stays on each device.** Player levels and unlocks are stored in each player's browser, and the server keeps no accounts or passwords.
- **Other hosts:** to use a different host instead of Render, the project also includes a `Procfile` (Railway and Heroku-style hosts) and a `Dockerfile` (Fly.io, Koyeb, Google Cloud Run, any Docker host). On your own server, run `python3 server/main.py --host 0.0.0.0 --public-url https://your.domain` behind an HTTPS proxy.

### Quick temporary link (no accounts)

Double-click **`start-online.bat`**. It runs the game on your PC and opens a free Cloudflare tunnel, giving a public link like `https://wild-otter-example.trycloudflare.com` (copied to your clipboard).

- **Sending it:** friends open that link from anywhere.
- **It's temporary:** the link changes every time, and stops working when you close the window.
- **First run:** it offers to download Cloudflare's free `cloudflared` program (about 60 MB) into `tools/bin/`. Or run `winget install --id Cloudflare.cloudflared` yourself.

### Same PC or same network

- **Same computer:** open two browser windows at `http://localhost:8080`.
- **Local network (LAN):** run `start-lan-server.bat` (or `python server/main.py --host 0.0.0.0`). Friends open the `http://<your-ip>:8080` address printed in the console. Allow Python through the Windows firewall on *private* networks when asked.

### Lobbies and friends

Everything is under **Play → Online with friends**, and the **Friends** button on the main menu:

- **Create lobby:** choose *Public* (listed in the lobby browser and Quick play) or *Friends only* (hidden; you need the code, the link or an invite). You become the host.
- **Invite friends**, in any of three ways:
  - **Copy invite link** in the lobby. Friends open it and land straight in your lobby (`http://<server>/?join=CODE`). When you play on `localhost`, the link automatically uses your LAN or public address.
  - **Lobby code:** friends type the 5 letters under *Join with code*.
  - **Friend codes:** everyone has a permanent friend code (e.g. `6LU-Z72`) on the Friends screen. Add each other once, and from then on you can see who's online and what they're doing, press **Invite** (they get a pop-up with a Join button), or press **Join** on a friend's lobby. A friends-only lobby can only be joined by friends you invited. Players you meet in lobbies appear under *Recently played with*.
- **Browse lobbies:** a live list of public lobbies with host, mode, arena and player count.
- **In the lobby:** text chat with history, ready up, add other players as friends.
- **Host controls:** rename the lobby, set the mode, arena, privacy and size (2 to 10), kick players (they can't rejoin for 2 minutes), and start the match once everyone is ready. If the host leaves, the next player becomes host.
- **Quick play** drops you into the fullest open public lobby, or creates one.

If your connection drops, the client reconnects automatically and you keep your place (including a running match) for 30 s. Friend codes belong to the browser profile on your device; two tabs in the same browser share one code.

## Settings

Everything in Settings changes the real game and is saved on your device:

- **Audio:** master, music and SFX volume.
- **Controls:** mouse X/Y, controller and touch sensitivity, invert Y, always-sprint, full key rebinding.
- **Camera:** FOV, distance, speed-FOV, shake, landing dip.
- **Graphics:** Low/Medium/High/Ultra presets, resolution scale, dynamic resolution (lowers the resolution a little only while the graphics card can't keep up), map intro cutscene on/off, motion blur (slight: fast camera turns and top speed, your character stays sharp; not on Low or with *Reduce flashing*), frame-rate limit, FPS counter, fullscreen.
- **Accessibility:** reduce flashing and shake, HUD scale, larger text, perfect-dodge assist.
- **Network:** custom server address.

On first launch the game picks a preset to suit your GPU.

## Battle Pass

**Season 1: Glitch Season** (main menu → ★ Battle Pass) has 30 tiers of 300 pass XP. Every match gives its XP to the pass too, and challenges give a lot more: **3 daily** (+150 XP each, new every day) and **4 weekly** (+600 XP each, new every Monday), the same for every player, like "Tag 5 runners", "Ride 2 water slides", "Scramble 8 players" or "Play a Hot Potato match".

- **Free track** (everyone): coins, the Party Hat, Cat Ears, the Salute and Chill emotes, new colours, titles and the Golden Cap at tier 30.
- **Premium track**: unlocked for **600 coins earned by playing**. There's no real money anywhere in PRO TAG. It adds a second reward on every tier: the Traffic Cone, Glitch Visor, Propeller Cap and Neon Crown, the Chicken Dance and the Moonwalk, the Glitch and Gold Rush trails, the Glitch Burst and Fireworks tag effects, more colours and titles, and 1,350 coins back. Buying it late is fine: every tier you've already reached becomes claimable.
- **Claim** rewards on the pass screen (or *Claim all*), then equip them in Customise. **Titles** show under your name on the menu and in lobbies.
- The results screen shows the pass XP you earned and any challenges you finished. Progress is stored on your device, like your level and coins. When a new season arrives, the pass starts again, but everything you claimed stays yours.

## Progression

You earn XP and coins for every match. The results screen breaks both down. XP comes from participation, tags, survival time, wins, and a top-3 bonus. Levels unlock cosmetics: suit (shell), trim (joints) and accent colours, 10 hats, trails, tag effects and emotes (the Griddy and Buggin' are free for everyone; the robot unlocks at level 8). Some unlock through achievements (wins, lifetime tags, total survival time). Cosmetics never change gameplay. Coins buy abilities (see above). The Profile screen shows lifetime stats and recent matches. Everything is earned by playing, the Battle Pass included: there is no real-money shop and no loot boxes.

---

## Project structure

```
index.html              entry page (import map -> vendored three.js)
start-game.bat          one-click launcher (Windows)
start-lan-server.bat    launcher for LAN play
config/game.json        ALL gameplay tuning, shared by client and server
src/
  core/         config loader, event bus, settings, storage, input (kbd/mouse/gamepad/touch), math,
                version.js (VERSION + CHANGELOG for the "What's new" screen)
  movement/     collision world (AABB + ramps, grid broad-phase, water/conveyor zones, slide paths)
                and the character controller
  gameplay/     rules engine, Game (renderer/loop), session base, offline LocalMatch,
                abilities (AbilitySystem), map coins (MapCoins), map events (mapEvents.js),
                the pre-match cutscene (intro.js)
  multiplayer/  WebSocket client, OnlineMatch (prediction + interpolation)
  ai/           navigation graph + A*, bot brain
  player/       procedural "mannequin" character (one skinned mesh) + animation and emotes, Player entity
  camera/       third-person camera rig
  maps/         map loader, renderer, static batching (batch.js), procedural textures,
                decor prefabs (decor.js, decor2.js), sky/backgrounds
  effects/      pooled particles, rings, trails, lightning, perfect-dodge cinematic,
                screen shader, ability effects, shrinking-zone wall (zoneFx.js), motion blur (motionBlur.js)
  audio/        synthesised SFX engine + procedural music sequencer
  progression/  XP/levels/stats, cosmetics catalogue, Battle Pass (battlepass.js)
  ui/           menus (incl. the Abilities shop), HUD, touch controls, ability icons,
                character preview, victory / defeat screens (endScreen.js), stylesheet
server/         Python stdlib server: HTTP + RFC 6455 WebSocket, rooms, match loop,
                rules (port of src/gameplay/rules.js), movement validation, map collision
tools/build_maps.py     map source -> assets/maps/*.json (run after editing maps)
assets/maps/            generated map JSON (rendering, physics, AI and server validation)
tests/                  Python unit and integration tests, browser test suite, shared rule cases
docs/                   architecture, testing and limitations notes
vendor/three/           three.js r170 (MIT) + post-processing add-ons
```

See **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** for the technical design and decisions.

### Editing the game

- **Tuning** (speeds, jump height, cooldowns, match length, bot difficulty, XP, coins, ability prices and cooldowns, perfect-dodge window): edit `config/game.json`. Client and server both read it.
- **Maps:** edit `tools/build_maps.py`, then run `python tools/build_maps.py`. The builder validates spawns and geometry before writing, and places the coin spots (platform tops first, then open ground).
- **Rules:** change `src/gameplay/rules.js` **and** `server/rules.py`, and add a case to `tests/shared/rules_cases.json`. Both test suites run it.
- **Releasing an update:** raise `VERSION` in `src/core/version.js` and `"version"` in `config/game.json` (a test checks they match), add an entry at the top of `CHANGELOG` in `version.js`, then run `publish-website.bat`. Every player sees the *What's new* screen once.

## Tests

```bash
python -m unittest discover -s tests -v                      # 82 server, rules, integration, social, hosting, publishing, perfect-dodge, ability, coin, new-mode, map-event, map-feature and cosmetics tests
# with the server running, open http://localhost:8080/tests/browser/   (150 browser tests)
```

Latest results: **82/82 Python tests** and **150/150 browser tests** passing. Details, the manual verification checklist, and what could not be tested are in **[docs/TESTING.md](docs/TESTING.md)**.

## Requirements and performance

- Windows 10/11 (also works on macOS/Linux), Python 3.10+, and a WebGL 2 browser (current Chrome, Edge or Firefox).
- **v1.02 optimisations:** each character is now one skinned mesh (3 draw calls instead of about 26), static map props are merged by material, and coins are instanced. A full 10-player match issues roughly 70–125 draw calls per frame, about 60–70% fewer than before. Shaders compile while the arena loads (the Mall took about 5 s to load, now about 1 s), and dynamic resolution steps in only when the graphics card is the bottleneck.
- The table below was measured for **v1.0**, before those optimisations, on the development laptop's **Intel UHD integrated GPU** at 1024×768, in a full 10-player match on Neon Rooftops. Figures are frame cost converted to FPS (CPU simulation + GPU render, forced to finish). New figures for v1.02 couldn't be measured reliably here (the test browser ran in the background):

  | Preset | Frame cost | ≈ FPS |
  |---|---|---|
  | Low | 8.1 ms | 123 |
  | Medium (auto-selected for this GPU) | 7.9 ms | 126 |
  | High | 13.9 ms | 72 |
  | Ultra | 26.4 ms | 38 |

  Simulation of all 10 players, including bot AI, costs about 1–1.5 ms per frame. A discrete GPU at 1080p should comfortably run High; that hasn't been measured on other hardware.

## Known limitations

Also listed in [docs/TESTING.md](docs/TESTING.md#limitations).

- **I couldn't watch the reference video** (only its title, "World Chase Tag USA 2021", was accessible). The design follows the publicly known chase-tag format and this project's design brief.
- **Bots are offline only.** Online rooms are human players (minimum 2).
- **Progression is stored locally** in the browser, including coins and which abilities you own. Online XP and coins are computed by the server, but local storage can still be edited by the player, so this isn't tamper-proof persistence. Online, the server can't know what you *bought*; it enforces the loadout shape (2 slots, no duplicates), the cooldowns, and every ability's effect.
- **Anti-cheat is practical, not perfect:** the server validates speed, teleports, solids and freeze, and checks tags with lag compensation, but it doesn't re-simulate full movement physics.
- **Characters are built from procedural shapes** (sculpted shell plates and ball joints merged into one skinned mesh) and animated procedurally, emotes included; there are no authored or motion-captured models.
- **The Battle Pass lives on your device**, like levels and coins: there are no accounts, so it doesn't follow you to another browser, and a player who edits their local storage could give themselves rewards. Cosmetics are visual only, so that can't affect anyone else's game.
- **Scramble is applied by the victim's own game online.** The server decides who is hit and how, but a modified client could ignore it (the same goes for any client-side input effect).
- **Not tested on real hardware here:** gamepads, physical touch devices, and real internet latency. Each is implemented to the standard browser APIs; see TESTING.md.
- **There's no Exit button.** It isn't applicable in a browser: close the tab, or stop the server with Ctrl+C.
- **No moving platforms.** Jump pads, conveyor belts, escalators and water slides are the dynamic traversal.
- **Bots don't use conveyors on purpose.** Belts simply carry them, which can push them off course for a moment.

## Roadmap

1. Server-side bots for online rooms (needs a Python port of the controller and navigation, or a shared WebAssembly core).
2. A server-trusted account and progression service (signed results or a small database).
3. Skinned character models with authored animations, and more emotes.
4. Moving platforms, ziplines and destructible cover, with server reconciliation.
5. Replays and a kill-cam for tags, plus spectator free-cam.
6. Matchmaking across several server instances, region selection and a server browser.
7. Mobile packaging (PWA) and controller-first menu polish.
8. A map editor UI on top of `tools/build_maps.py`.

## Credits and licensing

- Game code, maps, procedural art and audio: original to this project (Anas Studios, built with Claude).
- [three.js](https://threejs.org) r170, MIT licence (`vendor/three/LICENSE`).
- All textures are generated at runtime from code, and all music and sound effects are synthesised with the Web Audio API. There are no third-party asset files.
- PRO TAG is an independent project and isn't affiliated with any chase-tag league, broadcaster or brand.
