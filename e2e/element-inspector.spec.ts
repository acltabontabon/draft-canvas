import { expect, test, type Page } from '@playwright/test';

/** Contextual popover for a single selected element, anchored at the element instead of docked
 *  at the bottom of the screen — mirrors `connector-semantics.spec.ts`'s coverage of the
 *  equivalent connector popover. */

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

test.describe('element inspector popover', () => {
  test('selecting one element shows its popover near it, not the bottom bar', async ({ page }) => {
    await newCanvas(page, 'Element popover basics');
    await create(page, 'Service', { x: 400, y: 300 });

    await page.locator('.dc-node').first().click();

    await expect(page.locator('.dc-element-inspector')).toBeVisible();
    await expect(page.locator('.dc-inspector')).toHaveCount(0);

    // Colour: opens the palette and applies a swatch, which the compact row's own swatch then
    // reflects.
    const swatch = page.getByRole('button', { name: 'Element colour' });
    const before = await swatch.getAttribute('style');
    await swatch.click();
    await page.getByRole('button', { name: 'Colour rose' }).click();
    await expect(swatch).not.toHaveAttribute('style', before ?? '');

    // Type: Service's kind dropdown changes the node's badge.
    await page.getByRole('button', { name: 'Service type' }).click();
    await page.getByRole('option', { name: 'External' }).click();
    await expect(page.locator('.dc-node').first()).toContainText('EXTERNAL');

    // Regression: switching to a short value (e.g. "API") must not shrink the *menu* down to
    // that value's width — reopening it should still show every option at full width, not
    // clipped to "G..."/"W..." by an inherited, too-narrow trigger box.
    await page.getByRole('button', { name: 'Service type' }).click();
    await page.getByRole('option', { name: 'API' }).click();
    await page.getByRole('button', { name: 'Service type' }).click();
    for (const option of await page.getByRole('option').all()) {
      await expect
        .poll(() => option.evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
        .toBe(true);
    }
    await expect(page.getByRole('option', { name: 'External' })).toBeVisible();
    await page.getByRole('option', { name: 'External' }).click();
    await expect(page.locator('.dc-node').first()).toContainText('EXTERNAL');

    // Focus.
    await page.getByRole('button', { name: 'Focus', exact: true }).click();
    await expect(page.locator('.dc-canvas[data-focus="on"]')).toBeVisible();
    await page.keyboard.press('Escape');

    // Delete is directly in the row — no "More options" step.
    await page.getByRole('button', { name: 'Delete selection' }).click();
    await expect(page.locator('.dc-node')).toHaveCount(0);
  });

  test('hides while the element is being dragged, and reappears once the drag ends', async ({ page }) => {
    await newCanvas(page, 'Element popover during drag');
    await create(page, 'Service', { x: 350, y: 250 });
    await page.locator('.dc-node').first().click();

    const popover = page.locator('.dc-element-inspector');
    await expect(popover).toBeVisible();

    const node = page.locator('.dc-node').first();
    const start = (await node.boundingBox())!;
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    // The node trails the pointer by the first move of a drag — a real gesture, not a plain click.
    await page.mouse.move(start.x + start.width / 2 + 120, start.y + start.height / 2 + 80, { steps: 8 });

    // Frozen in place mid-drag (see the component's own `interactionActive` comment) would just sit
    // there visibly detached from the moving element — hidden outright instead.
    await expect(popover).toBeHidden();

    await page.mouse.up();

    await expect(popover).toBeVisible();
    const landed = (await node.boundingBox())!;
    // Settles back over the element at its new position, not stuck wherever it was before the drag
    // (grid snap means the exact landing spot isn't the raw pointer delta — just that it moved).
    expect(landed.x).toBeGreaterThan(start.x + 60);
  });

  test('selecting two elements still shows the shared bottom bar, not the popover', async ({ page }) => {
    await newCanvas(page, 'Element popover multi-select');
    await create(page, 'Service', { x: 300, y: 300 });
    await create(page, 'Data Store', { x: 600, y: 300 });

    await page.locator('.dc-node').first().click();
    await expect(page.locator('.dc-element-inspector')).toBeVisible();

    await page.locator('.dc-node').nth(1).click({ modifiers: ['Shift'] });

    await expect(page.locator('.dc-inspector')).toContainText('2 elements');
    await expect(page.locator('.dc-element-inspector')).toHaveCount(0);
  });

  test('stays on screen when the selected shape is far larger than the window', async ({ page }) => {
    // A system boundary worked inside at high zoom: its top and bottom are thousands of pixels off
    // screen, so neither "above" nor "below" fits, and its left edge is too close to the window's
    // for "left". The popover used to follow its anchor off the screen, with every control in it.
    const document = {
      format: 'draft-canvas',
      version: 1,
      metadata: { id: 'huge', title: 'Huge boundary', createdAt: 1, updatedAt: 2 },
      nodes: [
        { id: 'b', type: 'group', x: 100, y: -2000, width: 3000, height: 5000, z: 0, text: 'System', boundaryPreset: 'system' },
        { id: 's', type: 'service', x: 500, y: 300, width: 160, height: 70, z: 1, text: 'Inside', parentId: 'b' },
      ],
      edges: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      settings: { showSequence: true, grid: 'dots' },
    };
    await page.goto('/');
    await page.setInputFiles('input[type="file"]', {
      name: 'huge.draftcanvas',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(document)),
    });
    await page.waitForSelector('.dc-editor');

    // The boundary's own left padding, the one part of it in view.
    await page.mouse.click(108, 400);
    const popover = page.locator('.dc-element-inspector');
    await expect(popover).toBeVisible();

    const box = (await popover.boundingBox())!;
    const viewport = page.viewportSize()!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  });

  test('an open dropdown moves out of the way when the window is made smaller under it', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 760 });
    await newCanvas(page, 'Dropdown and resize');
    await create(page, 'Service', { x: 500, y: 60 });
    await page.locator('.dc-node').first().click();
    await page.getByRole('button', { name: 'Service type' }).click();
    const menu = page.getByRole('listbox');
    await expect(menu).toBeVisible();

    const paneBox = async () => (await page.locator('.react-flow').boundingBox())!;
    const fits = async () => {
      const pane = await paneBox();
      const box = (await menu.boundingBox())!;
      return box.y >= pane.y - 1 && box.y + box.height <= pane.y + pane.height + 1;
    };
    expect(await fits()).toBe(true);

    // Made short enough that where the menu opened now runs off the bottom of the canvas. It was
    // placed once, when it opened, and used to stay there with its last options out of reach.
    await page.setViewportSize({ width: 1280, height: 330 });
    await expect.poll(fits).toBe(true);
  });
});
