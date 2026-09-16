import { expect, test, type Page } from '@playwright/test';

/**
 * Looking inside a shape, drawing there, and coming back out — through the real UI.
 *
 * The model itself is covered in `tests/depth.test.ts`; what only a browser can prove is that the
 * canvas actually swaps rooms, that what was drawn inside survives a reload, and that undo behaves
 * like one history across every room rather than two that disagree.
 */

const CANVAS = '.react-flow__pane';

async function newCanvas(page: Page, title: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New canvas' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  const titleField = page.getByLabel('Diagram title');
  await titleField.fill(title);
  await titleField.blur();
}

async function create(page: Page, tool: string, at: { x: number; y: number }) {
  await page.getByRole('button', { name: tool, exact: true }).click();
  await page.locator(CANVAS).click({ position: at });
  // A new shape opens its own name editor; commit it so the next keystroke is a shortcut again.
  await page.keyboard.press('Escape');
}

async function select(page: Page, index: number) {
  await page.locator('.dc-node').nth(index).click();
  await expect(page.locator('.dc-node').nth(index)).toHaveAttribute('data-selected', 'true');
}

/** Reloading lands back in the library — a canvas is opened, never restored. */
async function reloadAndReopen(page: Page, title: string) {
  // Autosave is debounced; reloading before it lands would test the wrong thing.
  await expect(page.getByText('Saved locally')).toBeVisible();
  await page.reload();
  await page.locator('.dc-library-item', { hasText: title }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
}

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

async function lookInside(page: Page) {
  await page.keyboard.press(`${MOD}+ArrowDown`);
}

async function backOut(page: Page) {
  await page.keyboard.press(`${MOD}+ArrowUp`);
}

test('draw inside a shape, come back out, and find it still there', async ({ page }) => {
  await newCanvas(page, 'Lending');
  await create(page, 'Service', { x: 260, y: 260 });
  await create(page, 'Service', { x: 620, y: 260 });
  await expect(page.locator('.dc-node')).toHaveCount(2);

  await select(page, 0);
  await lookInside(page);
  // A shape nobody has drawn in yet opens empty — and the canvas says so.
  await expect(page.locator('.dc-node')).toHaveCount(0);
  await expect(page.getByText(/What runs inside/)).toBeVisible();

  await create(page, 'Service', { x: 300, y: 240 });
  await create(page, 'Data Store', { x: 600, y: 240 });
  await expect(page.locator('.dc-node')).toHaveCount(2);

  await backOut(page);
  await expect(page.locator('.dc-node')).toHaveCount(2);

  // Back in, everything is where it was left.
  await select(page, 0);
  await lookInside(page);
  await expect(page.locator('.dc-node')).toHaveCount(2);

  // And it is in the file, not just the session.
  await backOut(page);
  await reloadAndReopen(page, 'Lending');
  await select(page, 0);
  await lookInside(page);
  await expect(page.locator('.dc-node')).toHaveCount(2);
});

test('undo reaches into the room the change was made in', async ({ page }) => {
  await newCanvas(page, 'Undo across rooms');
  await create(page, 'Service', { x: 260, y: 260 });
  await select(page, 0);
  await lookInside(page);
  await create(page, 'Service', { x: 320, y: 240 });
  await expect(page.locator('.dc-node')).toHaveCount(1);

  await backOut(page);
  await expect(page.locator('.dc-node')).toHaveCount(1);

  // Undoing from outside goes back to where the change happened and takes it back.
  await page.keyboard.press(`${MOD}+z`);
  await expect(page.locator('.dc-node')).toHaveCount(0);
  await expect(page.getByText(/What runs inside/)).toBeVisible();

  await page.keyboard.press(`${MOD}+Shift+z`);
  await expect(page.locator('.dc-node')).toHaveCount(1);

  await backOut(page);
  await expect(page.locator('.dc-node')).toHaveCount(1);
});

test('the canvas says where you are, and how to get back', async ({ page }) => {
  await newCanvas(page, 'Orientation');
  await create(page, 'Service', { x: 300, y: 260 });
  // Nothing on a shape that has nothing in it.
  await expect(page.locator('.dc-node:has(.dc-inside-mark)')).toHaveCount(0);
  await expect(page.locator('.dc-depth')).toHaveCount(0);

  await select(page, 0);
  await lookInside(page);
  // Inside, the corner names where you are, and holds every layer back out to the whole canvas.
  await expect(page.locator('.dc-depth-here')).toHaveText('Service');
  await expect(page.locator('.dc-depth')).toContainText('Orientation');
  await expect(page.getByText(/What runs inside/)).toBeVisible();

  await create(page, 'Component', { x: 320, y: 240 });
  // Once the room holds something it is a sheet with a name on it.
  await expect(page.locator('.dc-room-name')).toHaveText('Service');
  // Escape with nothing selected is the last step out.
  await page.locator(CANVAS).click({ position: { x: 60, y: 420 } });
  await page.keyboard.press('Escape');
  await expect(page.locator('.dc-room')).toHaveCount(0);
  // Back on the whole canvas, which now has somewhere to go, so the corner stays — as its depth.
  await expect(page.locator('.dc-depth-here')).toHaveText('Depth');

  // Back outside, the shape now carries the one standing mark saying it holds something.
  await expect(page.locator('.dc-node:has(.dc-inside-mark)')).toHaveCount(1);
  // And the shape it belongs to is selected, ready to go straight back in.
  await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(1);
});

test('a room visited and left empty is never saved', async ({ page }) => {
  await newCanvas(page, 'Nothing inside');
  await create(page, 'Service', { x: 260, y: 260 });
  await select(page, 0);
  await lookInside(page);
  await expect(page.locator('.dc-node')).toHaveCount(0);
  await backOut(page);

  await reloadAndReopen(page, 'Nothing inside');
  // Asserted the way a user would see it: the shape carries no mark, because there is nothing in
  // it. (Deliberately not read out of the store — a spec that reaches into the app's modules can
  // pass against a module the app itself isn't using.)
  await expect(page.locator('.dc-node')).toHaveCount(1);
  await expect(page.locator('.dc-node:has(.dc-inside-mark)')).toHaveCount(0);
});
