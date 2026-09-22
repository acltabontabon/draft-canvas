#!/usr/bin/env node
/*
 * Renders the site's share card and its touch icon.
 *
 *     npm --prefix www run social
 *
 * Uses the Chromium that Playwright already installs for the app's e2e suite, so regenerating them
 * needs nothing new — the same trick scripts/render-desktop-icons.mjs uses for the desktop icons.
 * The card is drawn from the same tokens and the same diagram as the page it advertises, rather
 * than being a separate artwork that would drift out of step with it. The output is committed.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const www = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(www, 'public');

const PAPER = '#0b0d11';
const INK = '#e8ecf2';
const FAINT = '#737e8d';


const card = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body { margin: 0; width: 1200px; height: 630px; }
  body {
    position: relative; overflow: hidden; background: ${PAPER}; color: ${INK};
    font-family: system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  body::before {
    content: ''; position: absolute; inset: 0;
    background-image: radial-gradient(circle at 1px 1px, #2b3441 1px, transparent 0);
    background-size: 26px 26px; opacity: 0.5;
  }
  .sheet { position: relative; display: flex; height: 100%; padding: 66px 72px; gap: 40px; }
  .words { flex: 0 0 540px; display: flex; flex-direction: column; min-width: 0; }
  .brand { display: flex; align-items: center; gap: 12px; }
  .brand span {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 15px;
    letter-spacing: 0.2em; text-transform: uppercase; color: ${FAINT};
  }
  h1 {
    margin: 40px 0 0; font-size: 74px; font-weight: 660; letter-spacing: -0.045em; line-height: 0.97;
  }
  h1 em { font-style: normal; color: #5fd6c9; }
  p.sub { margin: 30px 0 0; font-size: 23px; line-height: 1.45; color: #98a1b0; max-width: 26ch; }
  p.url {
    margin-top: auto; margin-bottom: 0; font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 16px; letter-spacing: 0.06em; color: ${FAINT};
  }
  .art { flex: 1; display: flex; align-items: center; min-width: 0; }
  .art svg { width: 100%; height: auto; overflow: visible; }
  .brand svg { flex: none; }
  .body-n { fill: #0f1218; stroke: #2b3441; stroke-width: 1.6; }
  .ghost-n { fill: none; stroke: #1d232d; stroke-width: 1.3; }
  .wire { fill: none; stroke: #6d7885; stroke-width: 1.7; }
  .wire.dash { stroke-dasharray: 5 5; }
  .head { fill: #6d7885; }
  .name { fill: ${INK}; font-size: 17px; font-weight: 560; text-anchor: middle; }
  .edge { fill: ${FAINT}; font-size: 13px; text-anchor: middle; }
  .kind { fill: ${FAINT}; font-size: 11px; letter-spacing: 0.12em; text-anchor: middle; }
  .env { fill: none; stroke: #6d7885; stroke-width: 1.3; }
  .crop { fill: none; stroke: #49535f; stroke-width: 1.3; }
  .crop-t { fill: #49535f; font-family: ui-monospace, 'SF Mono', Menlo, monospace; font-size: 11px; letter-spacing: 0.2em; }
</style></head><body>
  <div class="sheet">
    <div class="words">
      <div class="brand">
        <svg width="34" height="34" viewBox="0 0 32 32">
          <rect x="6" y="8" width="11" height="7" rx="2" fill="none" stroke="#5fd6c9" stroke-width="2"/>
          <rect x="15" y="18" width="11" height="7" rx="2" fill="none" stroke="#6b7280" stroke-width="2"/>
          <path d="M11.5 15.5v3.5h4" fill="none" stroke="#5fd6c9" stroke-width="1.6"/>
        </svg>
        <span>Draft Canvas</span>
      </div>
      <h1>Draw it so everyone <em>gets it.</em></h1>
      <p class="sub">Architecture at meeting speed.</p>
      <p class="url">acltabontabon.com/draft-canvas</p>
    </div>
    <div class="art">
      <svg viewBox="0 0 520 250">
        <path class="wire dash" d="M152 64h38"/><path class="head" d="M183 59.5l8 4.5-8 4.5z"/>
        <path class="wire dash" d="M324 64h38"/><path class="head" d="M355 59.5l8 4.5-8 4.5z"/>
        <path class="wire" d="M444 102v58"/><path class="head" d="M439.5 153l4.5 8 4.5-8z"/>

        <rect class="ghost-n" x="6" y="32" width="152" height="76" rx="10"/>
        <rect class="body-n" x="0" y="26" width="152" height="76" rx="10"/>
        <text class="name" x="76" y="70">Checkout API</text>

        <path class="body-n" d="M220 40h80a24 24 0 010 48h-80a24 24 0 010-48z"/>
        <rect class="env" x="230" y="56" width="18" height="14" rx="2"/><path class="env" d="M230.5 57l8.5 6.5 8.5-6.5"/>
        <rect class="env" x="254" y="56" width="18" height="14" rx="2"/><path class="env" d="M254.5 57l8.5 6.5 8.5-6.5"/>
        <rect class="env" x="278" y="56" width="18" height="14" rx="2"/><path class="env" d="M278.5 57l8.5 6.5 8.5-6.5"/>
        <text class="name" x="260" y="114">payments</text>
        <text class="kind" x="260" y="133">QUEUE</text>

        <rect class="ghost-n" x="374" y="32" width="146" height="76" rx="10"/>
        <rect class="body-n" x="368" y="26" width="146" height="76" rx="10"/>
        <text class="name" x="441" y="70">Payment Service</text>

        <path class="body-n" d="M402 176a42 13 0 0184 0v26a42 13 0 01-84 0z"/>
        <path class="body-n" d="M402 176a42 13 0 0084 0" fill="none"/>
        <text class="kind" x="444" y="238">PAYMENTS DB</text>
      </svg>
    </div>
  </div>
</body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(card);
  await page.waitForTimeout(200);
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
