import { expect, test } from '@playwright/test';
import { cameraAtRest, create, newCanvas } from './canvas';

/** Contextual popover for a single selected element, anchored at the element instead of docked
 *  at the bottom of the screen — mirrors `connector-semantics.spec.ts`'s coverage of the
 *  equivalent connector popover. */

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
    const scheduler = page.getByRole('option', { name: 'Scheduler' }).locator('.dc-inspector-select-option-label');
    await expect(scheduler).toHaveCSS('white-space', 'nowrap');
    expect(await scheduler.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    for (const option of await page.getByRole('option').all()) {
      await expect
        .poll(() => option.evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
        .toBe(true);
    }
    await expect(page.getByRole('option', { name: 'External' })).toBeVisible();
    await page.getByRole('option', { name: 'External' }).click();
    await expect(page.locator('.dc-node').first()).toContainText('EXTERNAL');

    // One row: colour, kind, technology and the two unambiguous actions — no overflow hop needed.
    const inspector = page.locator('.dc-element-inspector');
    await expect(inspector.locator('.dc-element-action-row')).toBeVisible();
    expect((await inspector.boundingBox())!.width).toBeLessThanOrEqual(340);
    await expect(inspector.locator('.dc-popover-inner')).toHaveCSS('overflow-y', 'visible');
    await expect(inspector.getByRole('button', { name: 'Actions' })).toHaveCount(0);
    await expect(inspector.getByRole('button', { name: 'Edit text' })).toBeVisible();
    await inspector.getByRole('button', { name: 'Edit text' }).hover();
    await expect(page.getByRole('tooltip')).toContainText('Change the name shown on the canvas.');

    // Delete is direct too, with the same command used by the palette and context menu.
    await inspector.getByRole('button', { name: 'Delete' }).click();
    await expect(page.locator('.dc-node')).toHaveCount(0);
  });

  test('the C4 details show an undo, and leaving the field afterwards does not bring the text back', async ({ page }) => {
    await newCanvas(page, 'Details undo');
    await create(page, 'Service', { x: 400, y: 300 });
    await page.locator('.dc-node').first().click();
    await page.getByRole('button', { name: 'Details' }).click();
    // By role: the chip that opened it is named for technology too.
    const technology = page.getByRole('combobox', { name: 'Technology' });
    await expect(technology).toBeFocused();
    await technology.fill('Go');
    await technology.press('Enter');
    await expect(page.locator('.dc-node').first()).toContainText('Go');
    // The first Enter accepts a suggestion; the next commits and advances to the description.
    await expect(technology).toBeFocused();
    await technology.press('Enter');
    await expect(page.getByLabel('Description')).toBeFocused();

    await page.locator('.dc-canvas').focus();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(technology).toHaveValue('');
    await technology.focus();
    await technology.blur();
    await expect(page.locator('.dc-node').first()).not.toContainText('Go');
  });

  test('technology stays compact and opens details directly by keyboard in either theme', async ({ page }) => {
    await newCanvas(page, 'Technology shortcut');
    await create(page, 'Service', { x: 400, y: 300 });
    await page.locator('.dc-node').first().click();
    await page.getByRole('button', { name: 'Details' }).click();
    const technology = page.getByRole('combobox', { name: 'Technology' });
    // Long enough to overflow the chip, inside the field's own limit (longer is cut on commit).
    const value = 'Internal application runtime, long-named on purpose';
    await technology.fill(value);
    await technology.press('Enter');
    await expect(page.getByLabel('Description')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(technology).toHaveCount(0);

    const chip = page.getByRole('button', { name: `Technology: ${value}, edit` });
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(chip).toBeVisible();
      expect(await chip.locator('span').evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
      expect((await page.locator('.dc-element-inspector').boundingBox())!.width).toBeLessThanOrEqual(480);
      await chip.focus();
      await chip.press('Enter');
      await expect(technology).toBeFocused();
      await expect(technology).toHaveValue(value);
      await technology.press('Escape');
      await expect(technology).toHaveCount(0);
    }

    // The technology chip remains the direct way to open the same details panel.
    await page.getByRole('button', { name: `Technology: ${value}, edit` }).click();
    await expect(technology).toBeFocused();
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

  test('a small junction gets a small movable popup that closes on canvas click', async ({ page }) => {
    await newCanvas(page, 'Move a compact shape popup');
    await create(page, 'Junction', { x: 400, y: 300 });
    await page.locator('.dc-node').first().click();
    const popup = page.locator('.dc-element-inspector');
    await expect(popup).toBeVisible();
    expect((await popup.boundingBox())!.width).toBeLessThan(150);
    const start = (await popup.boundingBox())!;
    const junction = (await page.locator('.dc-node').first().boundingBox())!;
    expect(start.x).toBeGreaterThan(junction.x + junction.width + 8);
    const moveEdge = (await page.getByRole('button', { name: 'Move element popup' }).boundingBox())!;
    await page.mouse.move(moveEdge.x + moveEdge.width / 2, moveEdge.y + moveEdge.height / 2);
    await page.mouse.down();
    await page.mouse.move(moveEdge.x + moveEdge.width / 2 + 80, moveEdge.y + moveEdge.height / 2 + 60, { steps: 5 });
    await page.mouse.up();
    // The drop commits on the next frame; WebKit can report the box before it lands.
    await expect.poll(async () => (await popup.boundingBox())!.x).toBeGreaterThan(start.x + 40);
    await expect.poll(async () => (await popup.boundingBox())!.y).toBeGreaterThan(start.y + 30);
    await page.locator('.react-flow__pane').click({ position: { x: 50, y: 50 } });
    await expect(popup).toHaveCount(0);

    await page.locator('.dc-node').first().click();
    const node = page.locator('.dc-node').first();
    const beforeNodeDrag = (await node.boundingBox())!;
    await page.mouse.move(beforeNodeDrag.x + beforeNodeDrag.width / 2, beforeNodeDrag.y + beforeNodeDrag.height / 2);
    await page.mouse.down();
    await page.mouse.move(beforeNodeDrag.x + beforeNodeDrag.width / 2 + 100, beforeNodeDrag.y + beforeNodeDrag.height / 2 + 70, { steps: 5 });
    await page.mouse.up();
    await expect.poll(async () => (await node.boundingBox())!.x).toBeGreaterThan(beforeNodeDrag.x + 50);
  });

  test('note and code popups fit their controls', async ({ page }) => {
    await newCanvas(page, 'Compact editors');
    await create(page, 'Note', { x: 340, y: 300 });
    await page.locator('.dc-node').first().click();
    expect((await page.locator('.dc-element-inspector').boundingBox())!.width).toBeLessThan(230);
    await page.getByRole('button', { name: 'Note kind: Note' }).click();
    await page.getByRole('option', { name: 'Warning' }).click();
    await expect(page.getByRole('button', { name: 'Note kind: Warning' })).toBeVisible();
    await create(page, 'Code', { x: 670, y: 300 });
    await page.locator('.dc-node').nth(1).click();
    expect((await page.locator('.dc-element-inspector').boundingBox())!.width).toBeLessThan(250);
  });

  test('a single canvas action fills its compact card', async ({ page }) => {
    await newCanvas(page, 'Single action card');
    await create(page, 'Component', { x: 400, y: 300 });
    await page.locator('.dc-node').first().click();
    const card = page.locator('.dc-element-inspector');
    const action = card.getByRole('button', { name: 'Look inside' });
    await expect(action).toBeVisible();
    const outer = (await card.boundingBox())!;
    const tile = (await action.boundingBox())!;
    expect(outer.width).toBeLessThan(340);
    expect(tile.width).toBeGreaterThan(outer.width - 30);
  });

  test('actor technology stays readable beside both kind pickers', async ({ page }) => {
    await newCanvas(page, 'Actor controls');
    await create(page, 'Actor', { x: 400, y: 300 });
    await page.locator('.dc-node').first().click();
    await page.getByRole('button', { name: 'Actor frame' }).click();
    await page.getByRole('option', { name: 'Borderless' }).click();
    const card = page.locator('.dc-element-inspector');
    const technology = card.getByRole('button', { name: 'Details' });
    await expect(technology).toBeVisible();
    await expect(technology.locator('span')).toHaveCSS('display', 'none');
    expect((await technology.boundingBox())!.width).toBeLessThan(35);
    await technology.hover();
    await expect(page.getByRole('tooltip')).toContainText('Element details');
  });

  test('the description field can be resized without moving its popup', async ({ page, browserName }) => {
    await newCanvas(page, 'Resizable description');
    await create(page, 'Service', { x: 400, y: 300 });
    await page.locator('.dc-node').first().click();
    await page.getByRole('button', { name: 'Details' }).click();
    const popup = page.locator('.dc-element-inspector');
    const description = page.getByLabel('Description');
    await expect(description).toHaveCSS('resize', 'vertical');
    // Opening the details repositions the popup; wait for a stable field before locating its grip.
    await description.hover();
    const before = (await description.boundingBox())!;
    const popupBefore = (await popup.boundingBox())!;
    await page.mouse.move(before.x + before.width - 5, before.y + before.height - 5);
    await page.mouse.down();
    await expect(popup).toHaveAttribute('data-moved', 'true');
    // Headless WebKitGTK does not drag the native textarea grip. Supply that size change while
    // the real grip press still exercises the popup's pinning and resize observer.
    if (browserName === 'webkit' && process.platform === 'linux') {
      await description.evaluate((element, height) => { element.style.height = `${height}px`; }, before.height + 60);
    }
    await page.mouse.move(before.x + before.width - 5, before.y + before.height + 55, { steps: 8 });
    expect((await popup.boundingBox())!.x).toBeCloseTo(popupBefore.x, 0);
    expect((await popup.boundingBox())!.y).toBeCloseTo(popupBefore.y, 0);
    await page.mouse.up();
    await expect.poll(async () => (await description.boundingBox())!.height).toBeGreaterThan(before.height + 30);
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
    await cameraAtRest(page); // the opening ease has to finish before anything is measured on screen

    // Opening frames the whole diagram, which makes the boundary small. Zoom back in on its left
    // edge — as someone working inside it would have — until it runs far off the top and bottom.
    const boundary = page.locator('.react-flow__node[data-id="b"]');
    for (let i = 0; i < 40; i += 1) {
      const frame = (await boundary.boundingBox())!;
      if (frame.height > 4000) break;
      await page.mouse.move(Math.max(frame.x, 0) + 8, 400);
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -120);
      await page.keyboard.up('Control');
      // Each tick is read back before the next, so the next frame is measured at the zoom it
      // produced rather than mid-way; the target is far under the canvas's zoom ceiling, so every
      // tick grows the boundary.
      await expect.poll(async () => (await boundary.boundingBox())!.height, { message: 'the zoom tick landed' }).toBeGreaterThan(frame.height);
    }
    const frame = (await boundary.boundingBox())!;
    expect(frame.height).toBeGreaterThan(4000);

    // The boundary's own left padding, the one part of it in view.
    await page.mouse.click(frame.x + 8, 400);
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
    // Keep the placement away from the toolbar's explanatory tooltip; this tests menu resizing.
    await create(page, 'Service', { x: 800, y: 60 });
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
