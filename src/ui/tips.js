// Gameplay tips shown on the loading screens.
export const TIPS = [
  'Jump at a wall, then jump again while touching it, to wall-jump (twice in a row).',
  'Perfect dodge: press dodge just as IT lunges at you. Time slows down and IT gets stunned.',
  'Run into a low wall to vault it without slowing down. Jump at a ledge to climb up.',
  'Jumping out of a slide keeps all of its speed.',
  'Grapple works on anything under your crosshair: look for the green ring.',
  'Scramble a chaser right before they reach you and watch them run the wrong way.',
  'Water slides are the fastest way across the Waterpark and great escape routes.',
  'Conveyor belts carry you: run with them to go faster, or against them to fool a chaser.',
  'In Shrinking Zone, the arrow at the top points you back to the ring.',
  'Hot Potato: the fuse never resets, so pass it on fast!',
  'Gold coins sit up high. Parkour pays: grab them to buy abilities.',
  'Daily and weekly challenges give lots of Battle Pass XP.',
  'Hold Tab to see the scoreboard.',
  'Map events like Power Outage hide the radar: listen for footsteps.',
];

export function randomTip() {
  return TIPS[Math.floor(Math.random() * TIPS.length)];
}
