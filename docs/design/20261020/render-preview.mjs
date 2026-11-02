// Design export only. Does not load or exercise the Android app or game engine.
// Run with bundled Node packages on NODE_PATH: node render-preview.mjs
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { exportScreenshot } from './render-image-file.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const lucide = require('lucide');
const root = dirname(fileURLToPath(import.meta.url));
const iconNames = ['Signal', 'Wifi', 'BatteryFull', 'Sprout', 'CircleHelp', 'Plus',
  'ChevronsUpDown', 'Leaf', 'Moon', 'SlidersHorizontal', 'ScrollText', 'Square',
  'Play', 'UserRound', 'ChevronRight', 'Minus', 'Check', 'Droplets', 'Flower2',
  'ChevronDown', 'House', 'Spool', 'Blocks', 'ShoppingBag', 'Crown', 'UsersRound',
  'Video', 'Gift', 'Flower', 'ArrowRight', 'BookOpen', 'Sparkles', 'Info',
  'LockKeyhole', 'Eye', 'ListFilter', 'CalendarDays', 'Settings2', 'ShieldCheck',
  'KeyRound', 'Smartphone', 'BatteryCharging', 'Route', 'X', 'ArrowLeft',
  'Ellipsis', 'CircleCheck', 'CircleAlert', 'Clock3', 'LoaderCircle', 'CloudOff'];
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');
const subset = Object.fromEntries(iconNames.map(name => {
  const nodes = lucide.icons[name];
  if (!Array.isArray(nodes)) throw new Error(`Missing Lucide icon ${name}`);
  return [name, nodes.map(([tag, attributes]) => `<${tag} ${Object.entries(attributes).map(([key, value]) => `${key}="${escape(value)}"`).join(' ')} />`).join('')];
}));
await writeFile(join(root, 'icons.js'), `// Lucide 1.8.0 (ISC), selected icons; see assets/lucide-LICENSE.txt.\nwindow.PROTOTYPE_ICONS = ${JSON.stringify(subset)};\n`);
await mkdir(join(root, 'screens'), { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const context = await browser.newContext({ viewport: { width: 1450, height: 1200 }, deviceScaleFactor: 2 });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('requestfailed', request => errors.push(`Asset failed: ${request.url()}`));
const base = pathToFileURL(join(root, 'prototype.html')).href;
const report = { kind: 'design-layout-inspection-only', network: 'connect-src none; local files only', boards: [], screens: [], narrowLayouts: [], errors };
for (const board of [1, 2]) {
  await page.goto(`${base}?board=${board}`);
  await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
  await exportScreenshot(page.locator('.design-board'),join(root, `prototype-board-${board}.png`));
  report.boards.push({ board, ...await page.locator('.design-board').boundingBox() });
}
for (const view of ['login', 'accounts', 'land', 'orders', 'art', 'logs', 'me']) {
  await page.goto(`${base}?view=${view}`);
  await page.waitForFunction(() => [...document.images].every(image => image.complete && image.naturalWidth > 0));
  await exportScreenshot(page.locator('.phone'),join(root, 'screens', `${view}.png`));
  report.screens.push(await page.evaluate(() => ({
    view: new URLSearchParams(location.search).get('view'),
    width: document.querySelector('.phone').clientWidth,
    height: document.querySelector('.phone').clientHeight,
    areas: [...document.querySelectorAll('.scroll-area')].map(el => ({ visibleHeight: el.clientHeight, fullHeight: el.scrollHeight, horizontalOverflow: el.scrollWidth > el.clientWidth + 1 }))
  })));
}
for (const width of [320, 360, 390]) {
  await page.setViewportSize({ width, height: 1050 });
  for (const view of ['login', 'accounts', 'land', 'orders', 'art', 'logs', 'me']) {
    await page.goto(`${base}?view=${view}`);
    report.narrowLayouts.push(await page.evaluate(() => ({
      view: new URLSearchParams(location.search).get('view'), width: innerWidth,
      documentOverflow: document.documentElement.scrollWidth > innerWidth + 1,
      phoneOverflow: document.querySelector('.phone').scrollWidth > document.querySelector('.phone').clientWidth + 1,
      contentOverflow: [...document.querySelectorAll('.scroll-area')].some(el => el.scrollWidth > el.clientWidth + 1)
    })));
  }
}
await browser.close();
// Inspection output is ignored, separate from deliverable design images.
const inspectionDir = join(root, '..', '..', '..', '.runtime', 'design-20261020');
await mkdir(inspectionDir, { recursive: true });
await writeFile(join(inspectionDir, 'layout-inspection.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (errors.length || report.narrowLayouts.some(row => row.documentOverflow || row.phoneOverflow || row.contentOverflow)) process.exitCode = 1;
