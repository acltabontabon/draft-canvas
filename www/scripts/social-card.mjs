#!/usr/bin/env node
/*
 * Renders the site's share card and its touch icon.
 *
 *     npm --prefix www run social
 *
 * Uses the Chromium that Playwright already installs for the app's e2e suite, so regenerating them
 * needs nothing new — the same trick scripts/render-desktop-icons.mjs uses for the desktop icons.
 *
 * The committed `og-illustration.png` follows a charcoal sketch direction. Keep
 * lettering out of that artwork: the renderer adds the headline and current package version, so
 * typography stays editable and regenerating the card cannot retain an old release number.
 * Both the source artwork and the rendered output are committed; deployment needs no browser.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const www = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(www, 'public');

const { version } = JSON.parse(readFileSync(join(www, '..', 'package.json'), 'utf8'));
const illustration = `data:image/png;base64,${readFileSync(join(www, 'scripts', 'og-illustration.png')).toString('base64')}`;

const card = `<!doctype html><html><head><meta charset="utf-8"><style>
  html, body { margin: 0; width: 1200px; height: 630px; overflow: hidden; background: #101113; }
  .card { position: relative; height: 630px; color: #c9c7c0; }
  .illustration { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .brand { position: absolute; left: 64px; top: 46px;
    font: 22px/1.4 ui-monospace, 'Courier New', monospace; letter-spacing: 0.2em; color: #e8e6df; }
  .version { margin: 8px 0 0; font-size: 18px; letter-spacing: 0.16em; color: #9acfc3; }
  /* One quiet line, clear of the illustration and comfortably inside social-preview crops. */
  h1 { position: absolute; left: 64px; right: 64px; top: 414px; margin: 0;
    font: 400 64px/1.16 Georgia, 'Times New Roman', serif; letter-spacing: -0.035em; white-space: nowrap; }
</style></head><body>
  <div class="card">
    <img class="illustration" src="${illustration}" alt="">
    <div class="brand">DRAFT CANVAS
      <p class="version">${version} RELEASE</p>
    </div>
    <h1>Nodi + live collaboration</h1>
  </div>
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
  await page.setContent(card);
  await page.locator('.illustration').evaluate((image) => image.decode());
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
