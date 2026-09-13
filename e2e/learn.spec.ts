import { expect, test, type Page } from '@playwright/test';

/**
 * Learn Draft Canvas: a field guide pulled open beside the canvas — never a mode, never hints
 * pushed into the editor's own popovers. Search, recipe navigation and focus are unit-tested in
 * `tests/learn-drawer.test.tsx`; these cover it inside the real editor: the menu, docking beside a
 * canvas that stays live, a contextual "?" deep link, and the narrow-window sheet.
 */

async function newCanvas(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New canvas' }).first().click();
  await expect(page.locator('.dc-editor')).toBeVisible();
}

async function openLearnFromMenu(page: Page) {
  await page.getByRole('button', { name: /^More/ }).click();
  // A plain menu item: Learn is a place you go, not a setting you toggle.
  await expect(page.getByRole('menuitemcheckbox')).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Learn Draft Canvas' }).click();
  const learn = page.getByRole('complementary', { name: 'Learn Draft Canvas' });
  await expect(learn).toBeVisible();
  return learn;
}

/** Drags from a node's right-hand handle onto another node. */
async function connect(page: Page, fromIndex: number, toIndex: number) {
  const source = page.locator('.dc-node').nth(fromIndex);
  await source.hover();
  const handle = (await source.locator('.dc-handle').nth(1).boundingBox())!;
  const target = (await page.locator('.dc-node').nth(toIndex).boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
  await page.mouse.up();
}

async function clickEdge(page: Page, index: number) {
  const point = await page
    .locator('.dc-edge-line')
    .nth(index)
    .evaluate((el: SVGPathElement) => {
      const p = el.getPointAtLength(el.getTotalLength() / 2);
      return new DOMPoint(p.x, p.y).matrixTransform(el.getScreenCTM()!);
    });
  await page.mouse.click(point.x, point.y);
}

test.describe('Learn Draft Canvas', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('opens from the menu beside the canvas and answers "async" in a few keystrokes', async ({ page }) => {
    await newCanvas(page);
    const canvasBefore = (await page.locator('.dc-editor-canvas').boundingBox())!;
    const learn = await openLearnFromMenu(page);

    // Docked: the canvas narrows to make room rather than being covered.
    const canvasAfter = (await page.locator('.dc-editor-canvas').boundingBox())!;
    const drawer = (await learn.boundingBox())!;
    expect(canvasAfter.width).toBeLessThan(canvasBefore.width);
    expect(drawer.x).toBeGreaterThanOrEqual(canvasAfter.x + canvasAfter.width - 1);

    await expect(learn.getByRole('searchbox', { name: 'Search Learn' })).toBeFocused();
    await page.keyboard.type('async');
    const first = learn.getByRole('list', { name: 'Results' }).getByRole('button').first();
    await expect(first).toContainText('Make a call async');
    await first.click();

    await expect(learn.getByRole('heading', { name: 'Make a call async' })).toBeFocused();
    const stage = learn.getByRole('img', { name: /Interaction mode is switched/ });
    await expect(stage).toBeVisible();
    // Drawn by the real renderer, with its markers scoped away from the canvas's own.
    await expect(stage.locator('svg defs marker').first()).toHaveAttribute('id', /^dc-learn-/);
    await expect(learn.getByRole('list', { name: 'Steps' }).getByRole('button')).toHaveCount(3);

    await page.keyboard.press('Escape');
    await expect(learn.getByRole('searchbox', { name: 'Search Learn' })).toBeVisible();
    await learn.getByRole('button', { name: 'Close Learn' }).click();
    await expect(learn).toBeHidden();
  });

  test('keeps the canvas live while open, and its own keys to itself', async ({ page }) => {
    await newCanvas(page);
    const learn = await openLearnFromMenu(page);

    // Focus inside Learn: a bare letter must not drop a shape behind it.
    await learn.getByRole('button', { name: 'Close Learn' }).focus();
    await page.keyboard.press('s');
    await expect(page.locator('.dc-node')).toHaveCount(0);

    // Back on the canvas, shortcuts work as ever — and Learn stays open.
    await page.locator('.react-flow__pane').click({ position: { x: 300, y: 300 } });
    await page.keyboard.press('s');
    await expect(page.locator('.dc-node')).toHaveCount(1);
    await expect(learn).toBeVisible();
    await expect(learn).toContainText('Selected · Service');
  });

  test('never pushes hints into the editor’s popovers, and a "?" pulls the right recipe', async ({ page }) => {
    await newCanvas(page);
    const pane = page.locator('.react-flow__pane');
    await pane.click({ position: { x: 250, y: 300 } });
    await page.keyboard.press('s');
    await pane.click({ position: { x: 650, y: 300 } });
    await page.keyboard.press('q');
    await page.keyboard.press('Escape');
    await expect(page.locator('.dc-node')).toHaveCount(2);

    await page.locator('.dc-node').first().click();
    await expect(page.getByRole('toolbar', { name: 'Element options' })).toBeVisible();
    await expect(page.locator('.dc-hint-strip')).toHaveCount(0);

    await connect(page, 0, 1);
    await expect(page.locator('.dc-edge-line')).toHaveCount(1);
    await clickEdge(page, 0);
    const popover = page.getByRole('toolbar', { name: 'Connector options' });
    await expect(popover).toBeVisible();
    await expect(page.locator('.dc-hint-strip')).toHaveCount(0);

    await popover.getByRole('button', { name: 'Learn: Say what the arrow means' }).click();
    const learn = page.getByRole('complementary', { name: 'Learn Draft Canvas' });
    await expect(learn.getByRole('heading', { name: 'Say what the arrow means' })).toBeVisible();
  });

  test('becomes a modal sheet on a narrow window, and traps focus', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await newCanvas(page);
    await page.getByRole('button', { name: /^More/ }).click();
    await page.getByRole('menuitem', { name: 'Learn Draft Canvas' }).click();
    const sheet = page.getByRole('dialog', { name: 'Learn Draft Canvas' });
    await expect(sheet).toHaveAttribute('aria-modal', 'true');

    for (let i = 0; i < 12; i += 1) await page.keyboard.press('Tab');
    const inside = await sheet.evaluate((el) => el.contains(document.activeElement));
    expect(inside).toBe(true);

    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });
});
