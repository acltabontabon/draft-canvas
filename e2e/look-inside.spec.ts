import { expect, test, type Page } from '@playwright/test';
import { newCanvas, create, reopenAfterReload, cameraAtRest } from './canvas';

/**
 * Looking inside a shape, drawing there, and coming back out — through the real UI.
 *
 * The model itself is covered in `tests/depth.test.ts`; what only a browser can prove is that the
 * canvas actually swaps rooms, that what was drawn inside survives a reload, and that undo behaves
 * like one history across every room rather than two that disagree.
 */

const CANVAS = '.react-flow__pane';

async function select(page: Page, index: number) {
  await page.locator('.dc-node').nth(index).click();
  await expect(page.locator('.dc-node').nth(index)).toHaveAttribute('data-selected', 'true');
}

/** Reloading lands back in the library — a canvas is opened, never restored. */
async function reloadAndReopen(page: Page, title: string) {
  // Autosave is debounced; reloading before it lands would test the wrong thing.
  await expect(page.getByText('Saved locally')).toBeVisible();
  await reopenAfterReload(page, title);
  await expect(page.locator('.dc-editor')).toBeVisible();
}

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

async function lookInside(page: Page) {
  await page.keyboard.press(`${MOD}+ArrowDown`);
}

async function backOut(page: Page) {
  await page.keyboard.press(`${MOD}+ArrowUp`);
}

/** Every camera transform the canvas shows over the next `ms`, one entry per change. */
async function cameraMovesWithin(page: Page, ms: number): Promise<string[]> {
  return page.evaluate(async (duration) => {
    const viewport = document.querySelector<HTMLElement>('.react-flow__viewport')!;
    const start = performance.now();
    const first = viewport.style.transform;
    const moves: string[] = [];
    while (performance.now() - start < duration) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      const now = viewport.style.transform;
      if (now !== first && moves.at(-1) !== now) moves.push(now);
    }
    return moves;
  }, ms);
}

/** The camera is already where Fit to view (Shift 1) would put it. */
async function fitHasNothingToDo(page: Page): Promise<void> {
  const landed = await page.locator('.react-flow__viewport').getAttribute('style');
  await page.keyboard.press('Shift+Digit1');
  await cameraAtRest(page);
  expect(await page.locator('.react-flow__viewport').getAttribute('style')).toBe(landed);
}

for (const reducedMotion of ['no-preference', 'reduce'] as const) {
  test(`stepping in and back out fits and centres the content over its saved camera (${reducedMotion})`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion });
    await newCanvas(page, 'Framed inside');
    await create(page, 'Service', { x: 260, y: 260 });
    await lookInside(page);
    await expect(page.locator('.dc-node')).toHaveCount(0);
    await cameraAtRest(page);
    await create(page, 'Component', { x: 250, y: 220 });
    await create(page, 'Data Store', { x: 650, y: 420 });

    // Leave a deliberately bad saved camera: revisiting must frame the architecture even after
    // somebody has panned it out of view, rather than treating that camera as an arrival target.
    const pane = (await page.locator(CANVAS).boundingBox())!;
    await page.mouse.move(pane.x + 150, pane.y + 500);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(pane.x + pane.width - 80, pane.y + 500, { steps: 10 });
    await page.mouse.up({ button: 'middle' });
    await cameraAtRest(page);
    await backOut(page);
    await expect(page.locator('.dc-room')).toHaveCount(0);
    await cameraAtRest(page);

    await lookInside(page);
    await expect(page.locator('.dc-room')).toHaveCount(1);
    await expect(page.locator('.dc-depth-sheet')).toHaveCount(0);
    if (reducedMotion === 'reduce') await cameraAtRest(page);
    const bounds = await page.locator('.react-flow__node').evaluateAll((nodes) => {
      const boxes = nodes.map((node) => node.getBoundingClientRect());
      const x = Math.min(...boxes.map((box) => box.x));
      const y = Math.min(...boxes.map((box) => box.y));
      return {
        x, y,
        width: Math.max(...boxes.map((box) => box.right)) - x,
        height: Math.max(...boxes.map((box) => box.bottom)) - y,
      };
    });
    expect(bounds.x).toBeGreaterThan(pane.x);
    expect(bounds.y).toBeGreaterThan(pane.y);
    expect(bounds.x + bounds.width).toBeLessThan(pane.x + pane.width);
    expect(bounds.y + bounds.height).toBeLessThan(pane.y + pane.height);
    expect(Math.abs(bounds.x + bounds.width / 2 - pane.x - pane.width / 2)).toBeLessThan(5);
    expect(Math.abs(bounds.y + bounds.height / 2 - pane.y - pane.height / 2)).toBeLessThan(5);
    // The transition has already landed on the fitted camera; Shift+1 has nothing left to fix.
    expect(await cameraMovesWithin(page, 400)).toEqual([]);
    await fitHasNothingToDo(page);

    // And back out: the room it came from is framed the same way, not left where it was panned.
    await backOut(page);
    await expect(page.locator('.dc-room')).toHaveCount(0);
    await expect(page.locator('.dc-depth-sheet')).toHaveCount(0);
    await cameraAtRest(page);
    await fitHasNothingToDo(page);
  });
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
  await expect(page.getByText('What runs inside Service?', { exact: true })).toBeVisible();

  await create(page, 'Service', { x: 300, y: 240 });
  // The first shape stays where it was put. Arriving in the empty room used to ask React Flow for a
  // fit it could not do yet; it held the request and glided the camera onto this shape as it
  // appeared, so the Data Store below was clicked into the shape's toolbar instead.
  expect(await cameraMovesWithin(page, 600)).toEqual([]);
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
  await expect(page.getByText('What runs inside Service?', { exact: true })).toBeVisible();

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
  await expect(page.getByText('What runs inside Service?', { exact: true })).toBeVisible();

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

test('the depth map opens and closes when asked, and Escape closes it before leaving the room', async ({ page }) => {
  await newCanvas(page, 'Map');
  await create(page, 'Service', { x: 300, y: 260 });
  await select(page, 0);
  await lookInside(page);
  await create(page, 'Component', { x: 320, y: 240 });

  const map = page.locator('.dc-depth');
  const head = page.locator('.dc-depth-head');
  // A press keeps it open; a second press closes it, even with the pointer still resting on it.
  await head.click();
  await expect(map).toHaveAttribute('data-open', 'true');
  await head.click();
  await expect(map).not.toHaveAttribute('data-open', 'true');
  await expect(head).toHaveAttribute('aria-expanded', 'false');

  // Opened by the pointer alone, with the keyboard still on the canvas: Escape puts the map away
  // and leaves you where you are.
  await page.locator(CANVAS).click({ position: { x: 700, y: 520 } });
  await head.hover();
  await expect(map).toHaveAttribute('data-open', 'true');
  // The attribute changes during the commit; test the keyboard once the opened surface has
  // painted and its Escape listener has attached, as it has when a person sees the map.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.keyboard.press('Escape');
  await expect(map).not.toHaveAttribute('data-open', 'true');
  await expect(page.locator('.dc-room')).toHaveCount(1);

  // Picking a plane from the keyboard moves you, closes the map, and keeps the keyboard on it.
  await head.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('.dc-room')).toHaveCount(0);
  await expect(head).toBeFocused();
  await expect(map).not.toHaveAttribute('data-open', 'true');
});

test('⌘↑ still backs out right after the mouse picks a plate to go in', async ({ page }) => {
  await newCanvas(page, 'Mouse map pick');
  await create(page, 'Service', { x: 300, y: 260 });
  await select(page, 0);
  await lookInside(page);
  await create(page, 'Component', { x: 320, y: 240 });
  await backOut(page);
  await expect(page.locator('.dc-room')).toHaveCount(0);

  // The map's own plain-arrow plate cycling must not also swallow the chorded shortcut once
  // picking a plate hands the keyboard to the head — ⌘↑ is a different key, not another plate step.
  await page.locator('.dc-depth-head').click();
  await page.getByRole('button', { name: 'Look inside Service' }).click();
  await expect(page.locator('.dc-room')).toHaveCount(1);
  await backOut(page);
  await expect(page.locator('.dc-room')).toHaveCount(0);
});
