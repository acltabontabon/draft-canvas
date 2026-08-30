import { expect, test, type Page } from '@playwright/test';

/** Editing mechanics that the critical journey does not exercise. */

async function newCanvas(page: Page, title: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New canvas' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  const field = page.getByLabel('Diagram title');
  await field.fill(title);
  await field.blur();
}

async function create(page: Page, tool: string, at: { x: number; y: number }) {
  await page.getByRole('button', { name: tool, exact: true }).click();
  await page.locator('.react-flow__pane').click({ position: at });
}

test.describe('editing', () => {
  test('resizes a node and keeps the new size after a reload', async ({ page }) => {
    await newCanvas(page, 'Resizing');
    await create(page, 'Card', { x: 400, y: 300 });

    const node = page.locator('.dc-node').first();
    await node.click();
    const before = (await node.boundingBox())!;

    // Drag the bottom-right resize control outwards.
    const handles = page.locator('.dc-resize-handle');
    await expect(handles).toHaveCount(4);
    const corner = (await handles.nth(3).boundingBox())!;
    await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
    await page.mouse.down();
    await page.mouse.move(corner.x + 140, corner.y + 90, { steps: 12 });
    await page.mouse.up();

    const after = (await node.boundingBox())!;
    expect(after.width).toBeGreaterThan(before.width + 100);
    expect(after.height).toBeGreaterThan(before.height + 60);

    await expect(page.locator('.dc-save')).toContainText('Saved locally');
    await page.reload();
    await page.locator('.dc-library-item', { hasText: 'Resizing' }).click();

    const restored = (await page.locator('.dc-node').first().boundingBox())!;
    expect(Math.abs(restored.width - after.width)).toBeLessThan(4);
    expect(Math.abs(restored.height - after.height)).toBeLessThan(4);
  });

  test('a resize is one undo step', async ({ page }) => {
    await newCanvas(page, 'Resize undo');
    await create(page, 'Card', { x: 400, y: 300 });

    const node = page.locator('.dc-node').first();
    await node.click();
    const before = (await node.boundingBox())!;

    const corner = (await page.locator('.dc-resize-handle').nth(3).boundingBox())!;
    await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
    await page.mouse.down();
    await page.mouse.move(corner.x + 150, corner.y + 100, { steps: 15 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    await page.keyboard.press('Meta+z');
    await expect
      .poll(async () => Math.abs((await node.boundingBox())!.width - before.width))
      .toBeLessThan(4);
  });

  test('multi-selects with a marquee and moves the selection together', async ({ page }) => {
    await newCanvas(page, 'Multi-select');
    await create(page, 'Card', { x: 300, y: 250 });
    await create(page, 'Card', { x: 600, y: 250 });
    await create(page, 'Card', { x: 900, y: 250 });

    // Rubber-band across the first two.
    await page.mouse.move(200, 150);
    await page.mouse.down();
    await page.mouse.move(760, 420, { steps: 12 });
    await page.mouse.up();

    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(2);
    await expect(page.locator('.dc-inspector')).toContainText('2 elements');

    const first = page.locator('.dc-node').nth(0);
    const second = page.locator('.dc-node').nth(1);
    const third = page.locator('.dc-node').nth(2);
    const before = [
      (await first.boundingBox())!,
      (await second.boundingBox())!,
      (await third.boundingBox())!,
    ];

    // Dragging one selected node moves the whole selection, and only it.
    await page.mouse.move(before[0]!.x + before[0]!.width / 2, before[0]!.y + before[0]!.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      before[0]!.x + before[0]!.width / 2,
      before[0]!.y + before[0]!.height / 2 + 180,
      { steps: 12 },
    );
    await page.mouse.up();

    const after = [
      (await first.boundingBox())!,
      (await second.boundingBox())!,
      (await third.boundingBox())!,
    ];
    expect(after[0]!.y - before[0]!.y).toBeGreaterThan(150);
    expect(after[1]!.y - before[1]!.y).toBeGreaterThan(150);
    expect(Math.abs(after[2]!.y - before[2]!.y)).toBeLessThan(4);

    // And the whole group move is a single undo.
    await page.keyboard.press('Meta+z');
    await expect
      .poll(async () => Math.abs((await first.boundingBox())!.y - before[0]!.y))
      .toBeLessThan(4);
    await expect
      .poll(async () => Math.abs((await second.boundingBox())!.y - before[1]!.y))
      .toBeLessThan(4);
  });

  test('copies, pastes and duplicates', async ({ page }) => {
    await newCanvas(page, 'Clipboard');
    await create(page, 'Note', { x: 400, y: 300 });
    await page.locator('.dc-node').first().click();

    await page.keyboard.press('Meta+c');
    await page.keyboard.press('Meta+v');
    await expect(page.locator('.dc-node')).toHaveCount(2);

    await page.keyboard.press('Meta+d');
    await expect(page.locator('.dc-node')).toHaveCount(3);

    await page.keyboard.press('Meta+z');
    await expect(page.locator('.dc-node')).toHaveCount(2);
  });

  test('groups a selection into a boundary and ungroups it', async ({ page }) => {
    await newCanvas(page, 'Grouping');
    await create(page, 'Service', { x: 350, y: 280 });
    await create(page, 'Database', { x: 650, y: 280 });

    await page.keyboard.press('Meta+a');
    await expect(page.locator('.dc-inspector')).toContainText('2 elements');
    await page.getByRole('button', { name: 'Group', exact: true }).click();

    await expect(page.locator('.dc-node[data-type="group"]')).toHaveCount(1);
    await expect(page.locator('.dc-node')).toHaveCount(3);

    await page.getByRole('button', { name: 'Ungroup', exact: true }).click();
    await expect(page.locator('.dc-node[data-type="group"]')).toHaveCount(0);
    await expect(page.locator('.dc-node')).toHaveCount(2);
  });

  test('snaps a dragged node into alignment with its neighbour', async ({ page }) => {
    await newCanvas(page, 'Snapping');
    await create(page, 'Card', { x: 350, y: 250 });
    await create(page, 'Card', { x: 700, y: 460 });

    const anchor = (await page.locator('.dc-node').nth(0).boundingBox())!;
    const mover = page.locator('.dc-node').nth(1);
    const start = (await mover.boundingBox())!;

    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    // The node trails the pointer by the first move of a drag, so aim is taken
    // after the gesture has actually begun rather than from the start position.
    await page.mouse.move(start.x + start.width / 2 - 40, start.y + start.height / 2, { steps: 4 });

    const moving = (await mover.boundingBox())!;
    const pointer = { x: start.x + start.width / 2 - 40, y: start.y + start.height / 2 };
    const targetCentre = anchor.x + anchor.width / 2;
    // Aim a few pixels off the neighbour's centre line: close enough to attract.
    const remaining = targetCentre + 4 - (moving.x + moving.width / 2);

    await page.mouse.move(pointer.x + remaining, pointer.y, { steps: 8 });
    await page.waitForTimeout(150);

    await expect(page.locator('.dc-guide')).toHaveCount(1);
    await page.mouse.up();

    const landed = (await mover.boundingBox())!;
    // Pulled onto the guide, not left a few pixels off it.
    expect(Math.abs(landed.x + landed.width / 2 - targetCentre)).toBeLessThan(1.5);
  });
});
