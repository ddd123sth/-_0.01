/* Boot seam: the formal app owns state and starts first; the moon layer then claims the settings screen.
   If anything here fails the old template keeps rendering, so a presentation error can never blank the app. */
import { install } from './entry.js';
import { installMoonTextScale } from './text-scale.js';

function start() {
  if (!window.GardenHost) { window.setTimeout(start, 30); return; }
  try {
    window.MoonTextScale = installMoonTextScale();
  } catch {
    // Typography adaptation must never prevent the real app from mounting.
    window.MoonTextScale = { snapshot: () => ({ source: 'moon-declared-cssom', status: 'unavailable' }) };
  }
  try {
    const result = install(window.GardenHost);
    window.MoonBoot = { ok: true, ...result };
  } catch (error) {
    window.MoonBoot = { ok: false, reason: String(error?.message || error).slice(0, 160) };
  }
}
start();
