/**
 * Renders a diagram for the docs or the site's share card, in the real editor: an agent request
 * (a `.json` beside the image), composed by the app's own pipeline, imported through the file
 * picker, fitted, and captured as the canvas alone — no toolbar, no status bar — at 2x. The docs
 * draw their architecture this way rather than in ASCII or Mermaid. Like `e2e/agent-gallery.ts`, it
 * is not a test.
 *
 *   npm run dev -- --port 5393 --strictPort      # a dev server of its own, never 5180
 *   npx tsx e2e/og-diagram.ts --base http://localhost:5393     # the share card's diagram
 *   npx tsx e2e/og-diagram.ts --base http://localhost:5393 \
 *     --request docs/media/reference/architecture.json --out docs/media/reference/architecture.png
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const flag = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};
const BASE = flag('base') ?? 'http://localhost:5393';
const REQUEST = JSON.parse(readFileSync(flag('request') ?? 'www/scripts/og-diagram.json', 'utf8')) as Record<string, unknown>;
const OUT = flag('out') ?? 'www/scripts/og-diagram.png';
const WIDTH = Number(flag('width') ?? 1500);
const HEIGHT = Number(flag('height') ?? 860);
const PAD = Number(flag('pad') ?? 36);

async function main() {
  const browser = await chromium.launch();
  try {
    const setup = await browser.newPage();
    await setup.addInitScript('window.__name = (fn) => fn;');
    await setup.goto(BASE);
    const composed = await setup.evaluate(async (request) => {
      // oxlint-disable-next-line typescript/no-explicit-any
      const load = (path: string) => import(/* @vite-ignore */ path) as Promise<any>;
      const { compose } = await load('/src/agent/compile.ts');
      return compose({ requestId: 'og', ...request }, 'd_ogcard000000').text as string;
    }, REQUEST);
    await setup.close();

    const context = await browser.newContext({ colorScheme: 'light', viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    await page.goto(BASE);
    await page.setInputFiles('input[type="file"]', { name: 'og.draftcanvas', mimeType: 'application/json', buffer: Buffer.from(composed) });
    await page.waitForSelector('.dc-editor');
    await page.waitForSelector('.dc-node');
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Shift+1');
    await page.mouse.move(2, HEIGHT - 2);
    await page.waitForTimeout(900);

    // The drawing's own bounds — everything on the canvas, including the technology logos that sit
    // outside a shape's box and the connectors' labels — plus a margin.
    const box = await page.evaluate(() => {
      const rects = [...document.querySelectorAll('.react-flow__viewport *, .dc-edge-label, [class*="edge-label"]')]
        .map((element) => element.getBoundingClientRect())
        // Layers the size of the canvas itself (edge and label planes) would swallow the bounds.
        .filter((rect) => rect.width > 0 && rect.height > 0 && rect.width < innerWidth * 0.8 && rect.height < innerHeight * 0.8);
      const pane = document.querySelector('.react-flow__pane')!.getBoundingClientRect();
      return {
        left: Math.min(...rects.map((r) => r.left)),
        top: Math.min(...rects.map((r) => r.top)),
        right: Math.max(...rects.map((r) => r.right)),
        bottom: Math.max(...rects.map((r) => r.bottom)),
        pane: { left: pane.left, top: pane.top, right: pane.right, bottom: pane.bottom },
      };
    });
    // Never past the canvas: the toolbar and the status bar are not the drawing.
    const left = Math.max(box.pane.left, box.left - PAD);
    const top = Math.max(box.pane.top, box.top - PAD);
    const clip = {
      x: left,
      y: top,
      width: Math.min(box.pane.right, box.right + PAD) - left,
      height: Math.min(box.pane.bottom, box.bottom + PAD) - top,
    };
    writeFileSync(OUT, await page.screenshot({ clip }));
    process.stdout.write(`og-shot: ${OUT} ${Math.round(clip.width)}x${Math.round(clip.height)} css px\n`);
  } finally {
    await browser.close();
  }
}

void main();
