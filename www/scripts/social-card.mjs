#!/usr/bin/env node
/*
 * Renders the site's share card and its touch icon.
 *
 *     npm --prefix www run social
 *
 * Uses the Chromium that Playwright already installs for the app's e2e suite, so regenerating them
 * needs nothing new — the same trick scripts/render-desktop-icons.mjs uses for the desktop icons.
 * The card is the page's own hero, set on a 1200×630 sheet: the site's stylesheet, and the drawing
 * www/scripts/hero-art.mjs put in index.html, rendered at rest — so it cannot drift away from the
 * page it advertises. The output is committed.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const www = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(www, 'public');

const page = readFileSync(join(www, 'index.html'), 'utf8');
const art = page.match(/<!-- art:wide -->([\s\S]*?)<!-- \/art:wide -->/)?.[1];
if (!art) throw new Error('social-card: no <!-- art:wide --> drawing in index.html; run hero-art.mjs first');
const styles = readFileSync(join(www, 'src', 'styles.css'), 'utf8');
const mark = page.match(/<svg class="mark"[\s\S]*?<\/svg>/)?.[0] ?? '';

const card = `<!doctype html><html><head><meta charset="utf-8"><style>${styles}
  html, body { width: 1200px; height: 630px; overflow: hidden; }
  /* No paper grain: at this size it is invisible, and it would more than double the PNG. */
  body::before { display: none; }
  .card { position: relative; display: grid; grid-template-columns: 430px 1fr; align-items: center; gap: 28px;
    height: 630px; padding: 56px 40px 52px 72px; }
  .card::before { content: ''; position: absolute; inset: 0 0 0 38%; z-index: -1;
    background-image: radial-gradient(circle at 1px 1px, var(--rule-strong) 1px, transparent 0);
    background-size: 24px 24px; opacity: 0.7;
    mask-image: radial-gradient(ellipse 62% 64% at 60% 50%, #000 30%, transparent 100%); }
  .words { display: flex; flex-direction: column; height: 100%; }
  .brand { display: flex; align-items: center; gap: 11px; color: var(--accent); }
  .brand span { font-family: var(--mono); font-size: 15px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--ink-faint); }
  .brand svg { width: 30px; height: 30px; }
  h1 { margin: auto 0 0; font-family: var(--serif); font-weight: 400; font-size: 78px; line-height: 1; letter-spacing: -0.024em; }
  h1 em { font-style: italic; color: var(--accent-ink); }
  .url { margin: 34px 0 0; font-family: var(--mono); font-size: 15px; letter-spacing: 0.06em; color: var(--ink-faint); }
  .card .art { width: 100%; }
</style></head><body>
  <div class="card">
    <div class="words">
      <div class="brand">${mark}<span>Draft Canvas</span></div>
      <h1>Draw software. <em>Explain</em> how it works.</h1>
      <p class="url">draftcanvas.dev</p>
    </div>
    <div>${art}</div>
  </div>
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  // At rest: the finished drawing, not a frame of it being drawn.
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
