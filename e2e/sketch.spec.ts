import { expect, test, type Page } from '@playwright/test';
import { cameraAtRest } from './canvas';

/**
 * The Pencil, with a real mouse: sketching over a diagram without touching it, Smart Ink turning a
 * rough box and an arrow into a native shape and connector, undo taking a conversion back to the
 * drawing, and sketches surviving a reload and reaching an export.
 *
 * Recognition itself is unit-tested against a generated corpus (`tests/ink/`); this checks what
 * only a browser can — pointer capture over React Flow, the live stroke, the suggestion strip.
 */

function twoServices() {
  const box = (id: string, x: number, text: string) => ({ id, type: 'service', x, y: 200, width: 176, height: 68, z: 0, text });
  return {
    format: 'draft-canvas',
    version: 25,
    metadata: { id: 'sketch-e2e', title: 'Sketching', createdAt: 1, updatedAt: 2 },
    nodes: [box('api', 0, 'API'), box('worker', 520, 'Worker')],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { showSequence: true, grid: 'dots' },
  };
}

async function open(page: Page) {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', {
    name: 'sketching.draftcanvas',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(twoServices())),
  });
  await page.waitForSelector('.dc-editor');
  await cameraAtRest(page);
}

/** Drags the mouse through `points`, a little at a time, as a hand would. */
async function stroke(page: Page, points: Array<[number, number]>) {
  await page.mouse.move(points[0]![0], points[0]![1]);
  await page.mouse.down();
  for (let i = 1; i < points.length; i += 1) {
    const [ax, ay] = points[i - 1]!;
    const [bx, by] = points[i]!;
    const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 6));
    for (let k = 1; k <= steps; k += 1) {
      const wobble = Math.sin((i * 7 + k) * 0.9) * 1.2;
      await page.mouse.move(ax + ((bx - ax) * k) / steps + wobble, ay + ((by - ay) * k) / steps - wobble);
    }
  }
  await page.mouse.up();
}

async function box(page: Page, name: string) {
  const found = await page.locator('.react-flow__node', { hasText: name }).first().boundingBox();
  if (!found) throw new Error(`no ${name}`);
  return found;
}

const strokes = (page: Page) => page.locator('.dc-ink-layer > g[data-ink-id]');

test('sketching over a diagram leaves the diagram alone, and survives a reload', async ({ page }) => {
  await open(page);
  await page.locator('.dc-canvas').focus();
  await page.getByRole('button', { name: 'Pencil' }).click();
  await expect(page.locator('.dc-ink-bar')).toBeVisible();

  const api = await box(page, 'API');
  const cx = api.x + api.width / 2;
  const cy = api.y + api.height / 2;
  const circle: Array<[number, number]> = Array.from({ length: 41 }, (_, k) => [cx + Math.cos((k / 40) * Math.PI * 2) * (api.width / 2 + 24), cy + Math.sin((k / 40) * Math.PI * 2) * (api.height / 2 + 20)]);
  await stroke(page, circle);
  await expect(strokes(page)).toHaveCount(1);
  // The shape under the sketch was neither moved nor selected.
  expect(await box(page, 'API')).toEqual(api);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);

  // The eraser takes it away; undo brings it back.
  await page.keyboard.press('e');
  await stroke(page, [[cx - api.width / 2 - 40, cy], [cx - api.width / 2 - 10, cy]]);
  await expect(strokes(page)).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(strokes(page)).toHaveCount(1);

  await expect(page.getByText('Saved locally')).toBeVisible();
  await page.reload();
  await page.waitForSelector('.dc-editor');
  await expect(strokes(page)).toHaveCount(1);
});

test('Smart Ink turns a rough box and an arrow into a shape and a connector, and undo takes each back to the drawing', async ({ page }) => {
  await open(page);
  await page.locator('.dc-canvas').focus();
  await page.keyboard.press('p');
  await page.getByRole('button', { name: /Smart ink/ }).click();

  const api = await box(page, 'API');
  const worker = await box(page, 'Worker');
  const left = api.x;
  const top = api.y + 220;
  await stroke(page, [[left, top], [left + 200, top + 3], [left + 198, top + 100], [left + 2, top + 98], [left, top + 4]]);

  const strip = page.locator('.dc-ink-suggestion');
  await expect(strip).toBeVisible();
  await expect(strip.getByRole('button', { name: 'Component' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.react-flow__node', { hasText: 'Component' })).toHaveCount(1);
  await expect(strokes(page)).toHaveCount(0);

  // Another choice, in place.
  await strip.getByRole('button', { name: 'Service' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  await expect(strip.getByRole('button', { name: 'Service' })).toHaveAttribute('aria-pressed', 'true');

  // An arrow from API to Worker: a connector, no strip.
  const from: [number, number] = [api.x + api.width - 6, api.y + api.height / 2];
  const tip: [number, number] = [worker.x + 6, worker.y + worker.height / 2];
  await stroke(page, [from, tip, [tip[0] - 16, tip[1] - 12], tip, [tip[0] - 16, tip[1] + 12]]);
  await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  await expect(strokes(page)).toHaveCount(0);
  // Drawn while the strip was still open: a stroke, never also a selection marquee.
  await expect(page.locator('.react-flow__selection')).toHaveCount(0);
  await expect(page.locator('.react-flow__node.selected')).toHaveCount(0);

  // Undo: the connector is the arrow drawing again. Then the arrow stroke itself goes, and then the
  // Service — whichever choice it was given — is the box drawing again, not gone.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  await expect(strokes(page)).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(strokes(page)).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.locator('.react-flow__node')).toHaveCount(2);
  await expect(strokes(page)).toHaveCount(1);
});

test('the wheel still pans while the Pencil is in hand, and Escape puts it down', async ({ page }) => {
  await open(page);
  await page.locator('.dc-canvas').focus();
  await page.keyboard.press('p');
  const before = await box(page, 'API');
  await page.mouse.move(before.x + 300, before.y + 300);
  await page.mouse.wheel(0, 120);
  await expect.poll(async () => (await box(page, 'API')).y).not.toBe(before.y);
  await expect(strokes(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.dc-ink-bar')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Select' })).toHaveAttribute('aria-pressed', 'true');
});
