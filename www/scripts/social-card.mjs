#!/usr/bin/env node
/*
 * Renders the site's share card and its touch icon.
 *
 *     npm --prefix www run social
 *
 * Uses the Chromium that Playwright already installs for the app's e2e suite, so regenerating them
 * needs nothing new — the same trick scripts/render-desktop-icons.mjs uses for the desktop icons.
 *
 * The social image uses the same exported diagram as the landing page.
 * Both generated files are committed, so deployment needs no browser.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const www = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(www, 'public');

const { checkout } = JSON.parse(readFileSync(join(www, 'src', 'checkout-views.json'), 'utf8'));

const card = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: #101217; }
  .card { height: 100%; padding: 48px 65px; color: #eff0f1;
    background: radial-gradient(#282e37 0.9px, transparent 0.9px) center / 17px 17px; }
  .brand { margin: 0 0 10px; color: #b8e6de;
    font: 600 16px/1.4 ui-monospace, 'Courier New', monospace; letter-spacing: 0.12em; }
  h1 { margin: 0; font: 640 52px/1.05 system-ui, sans-serif; letter-spacing: -0.06em; }
  .system-graph { display: block; width: 100%; height: 430px; margin-top: 15px; }
</style></head><body>
  <div class="card">
    <div><p class="brand">DRAFT CANVAS</p><h1>Draw software systems.</h1></div>
    ${checkout.system}
  </div>
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.setContent(card);
  writeFileSync(join(out, 'og-image.png'), await page.screenshot({ clip: { x: 0, y: 0, width: 1200, height: 630 } }));
  console.log('social-card: og-image.png 1200x630');

  // The Apple touch icon, from the same mark the favicon and the installers use.
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 180, height: 180 });
  await page.setContent(
    `<style>html,body{margin:0}svg{display:block;width:180px;height:180px}</style>${readFileSync(join(out, 'favicon.svg'), 'utf8')}`,
  );
  writeFileSync(join(out, 'icon-180.png'), await page.screenshot({ clip: { x: 0, y: 0, width: 180, height: 180 } }));
  console.log('social-card: icon-180.png 180x180');
} finally {
  await browser.close();
}
