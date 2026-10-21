// PRO TAG entry point: load config, create systems, show the menu.
import { loadConfig } from './core/config.js';
import { settings, detectQuality } from './core/settings.js';
import { InputManager } from './core/input.js';
import { Game } from './gameplay/game.js';
import { UI } from './ui/ui.js';
import { TouchControls } from './ui/touch.js';
import { net } from './multiplayer/netClient.js';
import { audio } from './audio/audio.js';

const bar = document.getElementById('load-bar');
const msg = document.getElementById('load-msg');
const progress = (p, text) => {
  bar.style.width = `${Math.round(p * 100)}%`;
  if (text) msg.textContent = text;
};

async function boot() {
  progress(0.1, 'Loading configuration…');
  await loadConfig();
  if (!hasWebGL()) throw new Error('WebGL is not available in this browser. Try an up-to-date Chrome, Edge or Firefox.');
  document.body.classList.toggle('large-text', settings.data.accessibility.largeText);

  progress(0.3, 'Starting renderer…');
  const canvas = document.getElementById('game');
  const input = new InputManager(canvas);
  const touch = new TouchControls(document.getElementById('touch'));
  input.touch = touch;
  const game = new Game(canvas, input);
  if (!settings.data.graphics.autoDetected) {
    // first launch: choose a preset that suits this GPU (the player can change it any time)
    const gl = game.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : '';
    settings.set('graphics.autoDetected', true);
    settings.set('graphics.quality', detectQuality(gpu));
    console.info(`[boot] GPU "${gpu}" -> default quality "${settings.data.graphics.quality}"`);
  }

  progress(0.55, 'Building the arena…');
  const ui = new UI({ game, input, net, touch });
  await ui.init();
  progress(1, 'Ready');

  // the browser only allows audio after a user gesture
  const unlock = () => {
    audio.unlock();
    audio.playMusic('menu');
    audio.setAmbience(game.map?.data?.theme || null);
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('keydown', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);

  const loading = document.getElementById('loading');
  loading.style.opacity = '0';
  setTimeout(() => loading.remove(), 500);

  // handy for debugging from the console and for automated browser tests
  window.PROTAG = { game, ui, input, net, settings };
}

function hasWebGL() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

boot().catch((err) => {
  console.error('[boot] failed', err);
  msg.textContent = `Failed to start: ${err.message}`;
  msg.style.color = '#ff6b5e';
  bar.style.background = '#ff3b2f';
});

window.addEventListener('unhandledrejection', (e) => console.error('[unhandled]', e.reason));
