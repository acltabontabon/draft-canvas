#!/usr/bin/env node
/*
 * Renders the site's share card and its touch icon.
 *
 *     npm --prefix www run social
 *
 * Uses the Chromium that Playwright already installs for the app's e2e suite, so regenerating them
 * needs nothing new — the same trick scripts/render-desktop-icons.mjs uses for the desktop icons.
 *
 * The card shows the product as it is, not a drawing of it: a crop of a real editor screenshot
 * (`SHOT`, a release image already in docs/media), framed on the site's white sheet beside the
 * headline, with the prompt a coding agent is given. When the editor's look moves on, point `SHOT`
 * and `CROP` at a newer release shot and run this again. The output is committed.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const www = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(www, 'public');

/** The 1.15 Storefront diagram: technology logos, a code chip, a decision, a stream and a cache. */
const SHOT = join(www, '..', 'docs', 'media', 'releases', 'v1.15.0', 'repository.png');
const SHOT_SIZE = { width: 3200, height: 1640 };
/** The part of `SHOT` the card shows, in its own pixels. */
const CROP = { x: 624, y: 372, width: 1607, height: 700 };
const FRAME_WIDTH = 900;

const page = readFileSync(join(www, 'index.html'), 'utf8');
const styles = readFileSync(join(www, 'src', 'styles.css'), 'utf8');
const mark = page.match(/<svg class="mark"[\s\S]*?<\/svg>/)?.[0] ?? '';
const shot = `data:image/png;base64,${readFileSync(SHOT).toString('base64')}`;
const scale = FRAME_WIDTH / CROP.width;
const px = (n) => `${Math.round(n * scale)}px`;

const card = `<!doctype html><html><head><meta charset="utf-8"><style>${styles}
  html, body { width: 1200px; height: 630px; overflow: hidden; }
  /* No paper grain: at this size it is invisible, and it would more than double the PNG. */
  body::before { display: none; }
  .card { position: relative; height: 630px; }
  .card::before { content: ''; position: absolute; inset: 0 0 0 34%;
    background-image: radial-gradient(circle at 1px 1px, var(--rule-strong) 1px, transparent 0);
    background-size: 24px 24px; opacity: 0.55;
    mask-image: radial-gradient(ellipse 70% 70% at 70% 50%, #000 30%, transparent 100%); }
  .words { position: absolute; left: 68px; top: 56px; bottom: 54px; width: 400px; display: flex; flex-direction: column; }
  .brand { display: flex; align-items: center; gap: 11px; color: var(--accent); }
  .brand span { font-family: var(--mono); font-size: 15px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--ink-faint); }
  .brand svg { width: 30px; height: 30px; }
  h1 { margin: auto 0 0; font-family: var(--serif); font-weight: 400; font-size: 68px; line-height: 1; letter-spacing: -0.026em; }
  h1 em { font-style: italic; color: var(--accent-ink); }
  .sub { margin: 26px 0 0; font-size: 21px; line-height: 1.45; color: var(--ink-soft); }
  .url { margin: 30px 0 0; font-family: var(--mono); font-size: 16px; letter-spacing: 0.06em; color: var(--accent-ink); }
  /* The editor, bleeding off the right edge: there is more of it than fits. */
  .frame { position: absolute; left: 524px; top: 70px; width: ${FRAME_WIDTH}px; height: ${px(CROP.height)};
    overflow: hidden; background: #fafafa; border: 1px solid var(--rule-strong); border-radius: 16px;
    box-shadow: 0 40px 80px -36px rgba(48, 38, 20, 0.45), 0 2px 8px -2px rgba(48, 38, 20, 0.1); }
  .frame img { position: absolute; max-width: none; left: ${px(-CROP.x)}; top: ${px(-CROP.y)};
    width: ${px(SHOT_SIZE.width)}; height: ${px(SHOT_SIZE.height)}; }
  /* What an agent is told, laid over the drawing it made. */
  .prompt { position: absolute; left: 590px; top: 436px; width: 470px; padding: 16px 20px 17px;
    background: var(--ink); color: #f3f1ea; border-radius: 12px; font-family: var(--mono); font-size: 15px; line-height: 1.5;
    box-shadow: 0 24px 48px -20px rgba(20, 16, 8, 0.55); transform: rotate(-1.2deg); }
  .prompt small { display: block; margin-bottom: 6px; font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: #a8a396; }
  .prompt b { font-weight: 400; color: #5fd6c9; margin-right: 8px; }
</style></head><body>
  <div class="card">
    <div class="words">
      <div class="brand">${mark}<span>Draft Canvas</span></div>
      <h1>Draw software. <em>Explain</em> how it works.</h1>
      <p class="sub">A local-first canvas for architecture &mdash; and for the coding agent beside you.</p>
      <p class="url">draftcanvas.dev</p>
    </div>
    <div class="frame"><img src="${shot}" alt=""></div>
    <div class="prompt"><small>Your agent</small><b>&rsaquo;</b>Draw this repository in Draft Canvas, with its flows and the code behind them.</div>
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
