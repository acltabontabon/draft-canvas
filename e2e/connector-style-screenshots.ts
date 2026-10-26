/** Reproducible PR screenshots: run against the before/after checkout's dev server on :5184. */
import { CONNECTOR_APPEARANCES } from '../src/document/types';
import { mkdirSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { connectorStyleDocument } from '../tests/fixtures/connectors/checkout';
import { serializeDocument } from '../src/export/project';
import { cameraAtRest } from './canvas';

const flag = (name: string, fallback: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1]!;
};
const phase = flag('phase', 'after');
const out = flag('out', 'docs/media/connectors');
const base = flag('base', 'http://localhost:5184');
const document = connectorStyleDocument();
const appearance = CONNECTOR_APPEARANCES.find(value => value === flag('appearance', ''));
if (appearance) document.edges = document.edges.map(edge => ({ ...edge, appearance }));

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const colorScheme of ['light', 'dark'] as const) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2, colorScheme });
    await page.goto(base);
    await page.setInputFiles('input[type="file"]', { name: 'connector-style.draftcanvas', mimeType: 'application/json', buffer: Buffer.from(serializeDocument(document)) });
    await expect(page.locator('.dc-editor')).toBeVisible();
    await cameraAtRest(page);
    await page.mouse.move(10, 100);
    await page.screenshot({ path: `${out}/style-${colorScheme}-${phase}.png` });
    if (colorScheme === 'light') {
      const target = await page.locator('.react-flow__node[data-id="payments"]').boundingBox();
      if (!target) throw new Error('Payment node is missing');
      await page.screenshot({ path: `${out}/style-detail-${phase}.png`, clip: { x: target.x - 200, y: target.y - 55, width: 725, height: 185 } });
    }
    if (phase === 'after') {
      const point = await page.locator('.react-flow__edge[data-id="authorize"] .dc-edge-hit').first().evaluate(element => {
        const path = element as SVGPathElement;
        const point = path.getPointAtLength(path.getTotalLength() * 0.7).matrixTransform(path.getScreenCTM()!);
        return { x: point.x, y: point.y };
      });
      await page.mouse.click(point.x, point.y);
      await page.getByRole('button', { name: 'Arrow appearance: Sculpted Ink' }).click();
      await expect(page.getByRole('listbox', { name: 'Arrow appearance' })).toBeVisible();
      await page.mouse.move(10, 100);
      await page.screenshot({ path: `${out}/style-picker-${colorScheme}.png` });
    }
    await page.close();
  }
} finally {
  await browser.close();
}
