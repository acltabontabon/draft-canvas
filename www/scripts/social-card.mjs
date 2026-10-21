#!/usr/bin/env node
/*
 * Renders the site's share card and its touch icon.
 *
 *     npm --prefix www run social
 *
 * Uses the Chromium that Playwright already installs for the app's e2e suite, so regenerating them
 * needs nothing new — the same trick scripts/render-desktop-icons.mjs uses for the desktop icons.
 *
 * The card shows the product as it is, not a drawing of it: `og-diagram.png`, a diagram the real
 * editor rendered from `og-diagram.json` (see e2e/og-diagram.ts), laid across the bottom of the
 * site's white sheet under the headline, with the prompt a coding agent is given. When the editor's
 * look moves on, re-render the diagram and run this again. The output is committed.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const www = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(www, 'public');

const page = readFileSync(join(www, 'index.html'), 'utf8');
const styles = readFileSync(join(www, 'src', 'styles.css'), 'utf8');
const mark = page.match(/<svg class="mark"[\s\S]*?<\/svg>/)?.[0] ?? '';
const diagram = `data:image/png;base64,${readFileSync(join(www, 'scripts', 'og-diagram.png')).toString('base64')}`;

const card = `<!doctype html><html><head><meta charset="utf-8"><style>${styles}
  html, body { width: 1200px; height: 630px; overflow: hidden; }
  /* No paper grain: at this size it is invisible, and it would more than double the PNG. */
  body::before { display: none; }
  .card { position: relative; height: 630px; }
  .top { position: absolute; left: 64px; right: 64px; top: 50px; }
  .row { display: flex; align-items: center; justify-content: space-between; }
  .brand { display: flex; align-items: center; gap: 11px; color: var(--accent); }
  .brand span { font-family: var(--mono); font-size: 15px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--ink-faint); }
  .brand svg { width: 28px; height: 28px; }
  .url { margin: 0; font-family: var(--mono); font-size: 17px; letter-spacing: 0.04em; color: var(--accent-ink); }
  h1 { margin: 34px 0 0; font-family: var(--serif); font-weight: 400; font-size: 60px; line-height: 1; letter-spacing: -0.025em; white-space: nowrap; }
  h1 em { font-style: italic; color: var(--accent-ink); }
  .sub { margin: 16px 0 0; font-size: 21px; color: var(--ink-soft); }
  /* The editor's canvas: a sheet laid along the bottom edge, running off it. */
  .sheet { position: absolute; left: 40px; right: 40px; top: 268px; bottom: -30px; padding: 26px 30px;
    background: #fafafa; border: 1px solid var(--rule-strong); border-radius: 18px;
    box-shadow: 0 -2px 0 rgba(255, 255, 255, 1), 0 30px 70px -30px rgba(48, 38, 20, 0.4), 0 2px 8px -2px rgba(48, 38, 20, 0.08); }
  .sheet img { display: block; width: 100%; height: auto; }
  /* What an agent is told, clipped to the corner of the sheet it drew. */
  .prompt { position: absolute; right: 64px; top: 236px; padding: 12px 18px 13px; background: var(--ink); color: #f3f1ea;
    border-radius: 11px; font-family: var(--mono); font-size: 15px; line-height: 1.4; white-space: nowrap;
    box-shadow: 0 18px 36px -16px rgba(20, 16, 8, 0.55); transform: rotate(-1.5deg); }
  .prompt small { margin-right: 12px; font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: #a8a396; }
  .prompt b { font-weight: 400; color: #5fd6c9; margin-right: 8px; }
</style></head><body>
  <div class="card">
    <div class="top">
      <div class="row">
        <div class="brand">${mark}<span>Draft Canvas</span></div>
        <p class="url">draftcanvas.dev</p>
      </div>
      <h1>Draw software. <em>Explain</em> how it works.</h1>
      <p class="sub">A local-first architecture canvas &mdash; and your coding agent can draw in it too.</p>
    </div>
    <div class="sheet"><img src="${diagram}" alt=""></div>
    <div class="prompt"><small>Your agent</small><b>&rsaquo;</b>Draw this repository in Draft Canvas</div>
  </div>
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.setContent(card);
  await page.waitForTimeout(300);
  writeFileSync(join(out, 'og-image.png'), await page.screenshot({ clip: { x: 0, y: 0, width: 1200, height: 630 } }));
  console.log('social-card: og-image.png 1200x630');

  // The Apple touch icon, from the same mark the favicon and the installers use.
  await page.setViewportSize({ width: 180, height: 180 });
  await page.setContent(
    `<style>html,body{margin:0}svg{display:block;width:180px;height:180px}</style>${readFileSync(join(out, 'favicon.svg'), 'utf8')}`,
  );
  writeFileSync(join(out, 'icon-180.png'), await page.screenshot({ clip: { x: 0, y: 0, width: 180, height: 180 } }));
  console.log('social-card: icon-180.png 180x180');
} finally {
  await browser.close();
}
