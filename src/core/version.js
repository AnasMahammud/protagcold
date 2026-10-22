// Game version + update history. Every update bumps VERSION and adds an entry at the TOP of
// CHANGELOG: the first time a player opens a new version, the "What's new" screen shows it.
export const VERSION = '1.03';

export const CHANGELOG = [
  {
    version: '1.03',
    date: '2026-10-22',
    title: 'Scramble, the Griddy & a new look',
    sections: [
      ['New ability: Scramble', [
        'Glitch everyone within 9 m who can see you: for 3.5 s their controls are inverted, mirrored (with jump and slide swapped) or spun 90°. 400 coins in the Abilities shop.',
        'Use it to stop a chaser in their tracks, or as IT to make a runner stumble straight into you. Bots use it too.',
      ]],
      ['New emotes', [
        "The Griddy (key 4) and Buggin' (key 5), unlocked for everyone. Plus the Robot (key 6) at level 8.",
        "Bots sometimes show off their moves while the camera flies over the arena.",
      ]],
      ['New characters', [
        'Every runner is now a sleek mannequin: glossy sculpted shell plates over dark ball joints, a smooth faceless head and proper sneakers.',
        'New players start in classic pearl white. Your colours, headwear and trails still apply (Customise).',
      ]],
      ['Match intros', [
        'Before every match the camera slowly circles the arena with its name, the mode and who is playing, then swoops down behind you for the countdown.',
        'Press any key or click to skip it, or turn it off in Settings → Graphics.',
      ]],
      ['Feels smoother', [
        'A slight motion blur when the camera turns fast and at top speed, keeping your character sharp (Settings → Graphics, off on Low and with "Reduce flashing").',
      ]],
    ],
  },
  {
    version: '1.02',
    date: '2026-10-21',
    title: 'The Mall, the Waterpark & the Toy Factory',
    sections: [
      ['New maps', [
        'Overgrown Mall: a huge abandoned three-storey mall taken over by plants. Escalators, a sky bridge, a fountain to dive into, 46 shops to run through.',
        'Splash Kingdom: a sunny mega waterpark. Climb the spiral towers and RIDE the water slides into the pools (they work as escape routes!).',
        'Toy Factory: conveyor belts that carry you, giant toy blocks, catwalks, robot arms and a toy chute down into the ball pit.',
      ]],
      ['New modes', [
        'Hot Potato: tagging passes the potato. When the fuse runs out, whoever holds it explodes. Last one standing wins.',
        'Shrinking Zone: a ring closes in. Tagged runners are out, and so is anyone caught outside the ring for 4 seconds.',
      ]],
      ['Map events', [
        'Every 40–60 s the map throws something at you: Power Outage, Coin Rain, Low Gravity, Conveyor Overdrive, Wet Floors, Speed Surge, Slide Rush or Fog Bank.',
      ]],
      ['Smoother', [
        'Characters now draw in 3 draw calls instead of ~26, and map props are merged: about 60–70% fewer draw calls, frames 2–3× cheaper.',
        'Dynamic resolution keeps the frame rate up when your graphics card struggles (Settings → Graphics).',
        'Shaders compile while the arena loads, so the first seconds of a match no longer stutter.',
        'Fixed a bug that could leave a second, invisible arena loaded in the background.',
      ]],
      ['Less lag online', [
        'Movement is sent 30 times a second instead of 20, and other players are drawn about 60–80 ms behind instead of 110 ms.',
        'Jumps, dodges, slides and abilities are sent the instant they happen.',
        'Better clock sync, and your ping shows in the match HUD.',
      ]],
    ],
  },
  {
    version: '1.01',
    date: '2026-10-21',
    title: 'Abilities & Coins',
    sections: [
      ['New', [
        'Coins: earned every match and by grabbing gold coins hidden around every arena.',
        'Ability shop: Blink, Rocket Jump, Decoy, Grapple, Cloak and Shockwave. Equip two (F and R).',
      ]],
      ['Perfect dodge', [
        'No more freeze on the first perfect dodge.',
        'Harder to land, with an 8 s cooldown; bots no longer nail it every time.',
      ]],
    ],
  },
  {
    version: '1.0',
    date: '2026-10-20',
    title: 'Launch',
    sections: [
      ['The game', [
        'Neon Rooftops, Pulse Arena, Sunset Dockyard and the Training Ground.',
        'Classic Tag, Infection, Last Runner and Practice, with bots on three difficulties.',
        'Online lobbies, friend codes, invites and your own website to play with friends.',
        'The perfect dodge: slow motion, IT stunned, speed boost.',
      ]],
    ],
  },
];
