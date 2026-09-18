import { expect, test } from '@playwright/test';

/**
 * The same diagram open in two tabs. Draft Canvas checks every save against what the other tab last
 * stored, and asks which copy to keep when they disagree — which is right when somebody *edited*, and
 * a false alarm when all they did was look around: panning and zooming are saved too (so a diagram
 * reopens where it was left), and used to count as a change to the diagram.
 */

const diagram = {
  format: 'draft-canvas',
  version: 1,
  metadata: { id: 'two-tabs', title: 'Two tabs', createdAt: 1, updatedAt: 2 },
  nodes: [
    { id: 'a', type: 'service', x: 100, y: 100, width: 160, height: 70, z: 0, text: 'A' },
    { id: 'b', type: 'service', x: 420, y: 100, width: 160, height: 70, z: 0, text: 'B' },
  ],
  edges: [],
  viewport: { x: 0, y: 0, zoom: 1 },
  settings: { showSequence: true, grid: 'dots' },
};

test('looking around in one tab does not make the other tab conflict on its next edit', async ({ context }) => {
  const one = await context.newPage();
  await one.goto('/');
  await one.setInputFiles('input[type="file"]', {
    name: 'two-tabs.draftcanvas',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(diagram)),
  });
  await one.waitForSelector('.dc-editor');
  await expect(one.locator('.dc-save')).toContainText('Saved locally');

  const two = await context.newPage();
  await two.goto('/');
  await two.locator('.dc-library-item', { hasText: 'Two tabs' }).click();
  await two.waitForSelector('.dc-editor');
  await expect(two.locator('.dc-save')).toContainText('Saved locally');

  // Tab one only looks around: no content changes at all.
  await one.bringToFront();
  await one.mouse.move(800, 500);
  for (let i = 0; i < 6; i += 1) await one.mouse.wheel(30, 20);
  // Past the autosave debounce, so the camera move has really been written before tab two saves.
  await one.waitForTimeout(1600);
  await expect(one.locator('.dc-save')).toContainText('Saved locally');

  // Tab two makes a real edit, and is not told the canvas changed underneath it.
  await two.bringToFront();
  const box = (await two.locator('.dc-node').first().boundingBox())!;
  await two.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await two.mouse.down();
  await two.mouse.move(box.x + 200, box.y + 120, { steps: 8 });
  await two.mouse.up();
  await two.waitForTimeout(1600);

  await expect(two.locator('.dc-save-conflict')).toHaveCount(0);
  await expect(two.locator('.dc-save')).toContainText('Saved locally');
});
