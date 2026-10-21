// Line icons for abilities (shop cards, HUD slots, touch buttons). Stroke uses currentColor.
const svg = (body) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS = {
  blink: svg('<circle cx="5.5" cy="17.5" r="2.5" stroke-dasharray="2.2 2"/><path d="M8.5 15l7-7" stroke-dasharray="2.5 2.5"/><path d="M13 7.5h3.5V11"/><path d="M18.5 3.5l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" fill="currentColor"/>'),
  rocket: svg('<path d="M12 2.5c3 2.2 4.6 5.6 4.6 9.3L15 15H9l-1.6-3.2c0-3.7 1.6-7.1 4.6-9.3z"/><circle cx="12" cy="9" r="1.7"/><path d="M9 15l-2.5 3.5M15 15l2.5 3.5M12 16.5V21"/>'),
  decoy: svg('<circle cx="7.5" cy="5.5" r="2.2"/><path d="M7.5 8.5v6M4.5 11h6M7.5 14.5l-2 5M7.5 14.5l2 5"/><g stroke-dasharray="1.6 1.8"><circle cx="16.5" cy="5.5" r="2.2"/><path d="M16.5 8.5v6M13.5 11h6M16.5 14.5l-2 5M16.5 14.5l2 5"/></g>'),
  grapple: svg('<path d="M12 2.5v11"/><path d="M6 10.5c0 3.6 2.7 6 6 6s6-2.4 6-6"/><path d="M6 10.5L4 12.5M18 10.5l2 2"/><path d="M12 16.5v5" stroke-dasharray="1.5 1.8"/>'),
  cloak: svg('<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/><path d="M4 20L20 4"/>'),
  shockwave: svg('<circle cx="12" cy="12" r="2.2" fill="currentColor"/><path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M4.8 4.8a10.2 10.2 0 0 0 0 14.4M19.2 4.8a10.2 10.2 0 0 1 0 14.4"/>'),
};

export function abilityIcon(id) {
  return ICONS[id] || '';
}

export const COIN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#ffcc33" stroke="#b37a00" stroke-width="1.5"/><circle cx="12" cy="12" r="6.5" fill="none" stroke="#fff3b0" stroke-width="1.4" opacity="0.8"/><path d="M12 8.2v7.6M9.8 10.2h4.4" stroke="#8a5a00" stroke-width="1.8" stroke-linecap="round"/></svg>';
