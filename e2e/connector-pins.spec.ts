import { expect, test, type Page } from '@playwright/test';
import { afterDropGuard, cameraAtRest, clickEdge, nextFrames } from './canvas';

/**
 * Pinned and automatic connector ends, end to end: drag a shape across to the other side of the
 * shape it is joined to, and the automatic end turns to face it while the pinned one holds.
 */

const node = (id: string, x: number, y: number) => ({ id, type: 'service', x, y, width: 160, height: 80, z: 0, text: id.toUpperCase() });

async function open(page: Page) {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', {
    name: 'pins.draftcanvas',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      format: 'draft-canvas',
      version: 21,
      metadata: { id: 'connector-pins', title: 'Connector pins', createdAt: 1, updatedAt: 2 },
      nodes: [node('a', 600, 0), node('b', 1000, 0), node('c', 1000, 300)],
      edges: [
        // No anchors: both ends automatic.
        { id: 'auto', source: 'a', target: 'b', routing: 'smoothstep', directed: true },
        // Pinned at the start, three quarters down A's right side.
        { id: 'pinned', source: 'a', target: 'c', routing: 'smoothstep', directed: true, sourceAnchor: { side: 'right', offset: 0.75 } },
      ],
      flows: [],
      settings: { grid: 'dots', showSequence: false },
      viewport: { x: 0, y: 0, zoom: 1 },
    })),
  });
  await expect(page.locator('.dc-editor')).toBeVisible();
  await cameraAtRest(page);
}

/** A connector's first point, in screen coordinates. */
async function start(page: Page, id: string) {
  return page.locator(`.react-flow__edge[data-id="${id}"] .dc-edge-hit`).first().evaluate((el) => {
    const path = el as SVGPathElement;
    const point = path.getPointAtLength(0).matrixTransform(path.getScreenCTM()!);
    return { x: point.x, y: point.y };
  });
}

const boxOf = async (page: Page, id: string) => (await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox())!;

test('dragging a shape across turns an automatic end to face it and leaves a pinned end where it was pinned', async ({ page }) => {
  await open(page);
  const a = await boxOf(page, 'a');
  // Before: both leave A's right side.
  expect((await start(page, 'auto')).x).toBeCloseTo(a.x + a.width, 0);
  const pinnedBefore = await start(page, 'pinned');
  expect(pinnedBefore.x).toBeCloseTo(a.x + a.width, 0);
  expect(pinnedBefore.y).toBeCloseTo(a.y + a.height * 0.75, 0);

  // Drag B and C over to A's left. Stay clear of the canvas edge: Firefox auto-pans a drag held near it.
  for (const id of ['b', 'c']) {
    const box = await boxOf(page, id);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 - 350, box.y + box.height / 2, { steps: 8 });
    await page.mouse.move(box.x + box.width / 2 - 700, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await nextFrames(page);
  }
  await cameraAtRest(page);
  const after = await boxOf(page, 'a');
  // The automatic end now leaves A's left side, facing B.
  expect((await start(page, 'auto')).x).toBeCloseTo(after.x, 0);
  // The pinned end still leaves A's right side, three quarters down, and goes round.
  const pinnedAfter = await start(page, 'pinned');
  expect(pinnedAfter.x).toBeCloseTo(after.x + after.width, 0);
  expect(pinnedAfter.y).toBeCloseTo(after.y + after.height * 0.75, 0);
});

test('Auto attach start lets a pinned end face the shape again, in one undo step', async ({ page }) => {
  await open(page);
  const c = await boxOf(page, 'c');
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width / 2 - 700, c.y + c.height / 2, { steps: 10 });
  await page.mouse.up();
  await cameraAtRest(page);
  const a = await boxOf(page, 'a');
  expect((await start(page, 'pinned')).x).toBeCloseTo(a.x + a.width, 0);

  await page.keyboard.press('Escape');
  // A click straight after a drop is eaten by the drag's own guard.
  await afterDropGuard(page);
  await clickEdge(page, page.locator('.react-flow__edge[data-id="pinned"] .dc-edge-hit').first());
  await expect(page.getByRole('toolbar', { name: 'Connector options' })).toBeVisible();
  await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Auto attach start', exact: true }).click();
  await nextFrames(page);
  // Automatic now: it faces C, below and to the left — out of A's bottom side.
  const unpinned = await start(page, 'pinned');
  expect(unpinned.y).toBeCloseTo(a.y + a.height, 0);
  expect(unpinned.x).toBeLessThan(a.x + a.width);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await nextFrames(page);
  expect((await start(page, 'pinned')).x).toBeCloseTo(a.x + a.width, 0);
});
