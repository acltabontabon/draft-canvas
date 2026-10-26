/** Reproducible PR screenshots: run against the before/after checkout's dev server on :5184. */
import { PERSONALITY_PRESETS } from '../src/ui/personality/usePersonality';
import { mkdirSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';
import { nearbyServicesDocument } from '../tests/fixtures/connectors/nearby';
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
const nearby = flag('fixture', 'checkout') === 'nearby';
const document = nearby ? nearbyServicesDocument(flag('pinned', 'false') === 'true') : connectorStyleDocument();
const preset = PERSONALITY_PRESETS.find(value => value === flag('style', 'clean')) ?? 'clean';

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
try {
  for (const colorScheme of ['light', 'dark'] as const) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2, colorScheme });
    await page.addInitScript(value => localStorage.setItem('draft-canvas.personality', value), preset);
    await page.goto(base);
    await page.setInputFiles('input[type="file"]', { name: 'connector-style.draftcanvas', mimeType: 'application/json', buffer: Buffer.from(serializeDocument(document)) });
    await expect(page.locator('.dc-editor')).toBeVisible();
    await cameraAtRest(page);
    await page.mouse.move(10, 100);
    const source = nearby ? await page.locator('.react-flow__node[data-id="source"]').boundingBox() : null;
    const far = nearby ? await page.locator('.react-flow__node[data-id="far"]').boundingBox() : null;
    const clip = source && far ? { x: Math.max(0, source.x - 20), y: source.y - 75, width: Math.min(1280 - Math.max(0, source.x - 20), far.x + far.width - source.x + 40), height: source.height + 170 } : undefined;
    await page.screenshot({ path: `${out}/style-${colorScheme}-${phase}.png`, clip });
    if (colorScheme === 'light' && !nearby) {
      const target = await page.locator('.react-flow__node[data-id="payments"]').boundingBox();
      if (!target) throw new Error('Payment node is missing');
      await page.screenshot({ path: `${out}/style-detail-${phase}.png`, clip: { x: target.x - 200, y: target.y - 55, width: 725, height: 185 } });
    }
    if (phase === 'after' && !nearby) {
      const point = await page.locator('.react-flow__edge[data-id="authorize"] .dc-edge-hit').first().evaluate(element => {
        const path = element as SVGPathElement;
        const point = path.getPointAtLength(path.getTotalLength() * 0.7).matrixTransform(path.getScreenCTM()!);
        return { x: point.x, y: point.y };
      });
      await page.mouse.click(point.x, point.y);
      await expect(page.getByRole('toolbar', { name: 'Connector options' })).toBeVisible();
      await page.mouse.move(10, 100);
      await page.screenshot({ path: `${out}/style-inspector-${colorScheme}.png` });
    }
    await page.close();
  }
} finally {
  await browser.close();
}
