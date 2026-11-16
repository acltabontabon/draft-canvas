import { expect, test, type Page } from '@playwright/test';
import { cameraAtRest, newCanvas as openCanvas, reopenAfterReload } from './canvas';
import { serveStarterGallery } from './gallery';

/** A new canvas once the starters gallery has arrived: its tiles, and its ⌘K rows, are there. */
async function newCanvas(page: Page, title: string) {
  await openCanvas(page, title);
  await expect(page.getByRole('group', { name: 'Suggested starters', exact: true })).toBeVisible();
}

/**
 * Architecture Starters, driven the way they are meant to be used: ⌘K, a few letters, Enter, and a
 * diagram to talk about. The keyboard path is the product claim, so it is the one asserted first.
 */

async function insertViaPalette(page: Page, query: string) {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog', { name: 'Commands' })).toBeVisible();
  await page.keyboard.type(query);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Commands' })).toBeHidden();
}

/** Selects a connector by its position in creation order — `.dc-edge-line`'s DOM order — clicking
 *  the midpoint of its drawn path, the same way `critical-journey.spec.ts` does. */
async function clickEdgeBetween(page: Page, edgeIndex: number) {
  await cameraAtRest(page); // the point is read off the screen, so the camera must have stopped
  const path = page.locator('.dc-edge-line').nth(edgeIndex);
  const point = await path.evaluate((el: SVGPathElement) => {
    const len = el.getTotalLength();
    const p = el.getPointAtLength(len / 2);
    const ctm = el.getScreenCTM()!;
    const screenPoint = new DOMPoint(p.x, p.y).matrixTransform(ctm);
    return { x: screenPoint.x, y: screenPoint.y };
  });
  await page.mouse.click(point.x, point.y);
}

test.describe('architecture starters', () => {
  // The gallery as GitHub would serve it, loaded as though the person chose "Load starters".
  test.beforeEach(async ({ page }) => {
    await serveStarterGallery(page);
  });

  test('⌘K, "microservices", Enter — and the whole thing undoes in one step', async ({ page }) => {
    await newCanvas(page, 'Starter keyboard');

    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.type('microservices');
    // Distinct from an ordinary command, and described in one line.
    const row = page.getByRole('option', { selected: true });
    await expect(row).toContainText('Microservices');
    await expect(row).toContainText('Architectures');
    await page.keyboard.press('Enter');

    await expect(page.locator('.dc-node')).toHaveCount(14);
    // Selected, so the next thing typed acts on what was just inserted.
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(14);
    await expect(page.locator('.react-flow__edge')).toHaveCount(8);

    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('.dc-node')).toHaveCount(0);

    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(page.locator('.dc-node')).toHaveCount(14);
  });

  test('every starter is reachable by the words people actually type', async ({ page }) => {
    await newCanvas(page, 'Starter search');
    for (const [query, expected] of [
      ['monolith', 'Monolith'],
      ['modular', 'Modular Monolith'],
      ['event driven', 'Event-Driven'],
      ['ports and adapters', 'Hexagonal'],
    ] as const) {
      await page.keyboard.press('ControlOrMeta+k');
      await page.keyboard.type(query);
      await expect(page.getByRole('option', { selected: true })).toContainText(expected);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name: 'Commands' })).toBeHidden();
    }
  });

  test('a condition set on a starter’s service call is edited in place — double-click the chip, type, Enter', async ({
    page,
  }) => {
    await newCanvas(page, 'Editable condition');
    await insertViaPalette(page, 'microservices');
    await page.locator('.dc-canvas, .react-flow').first().click({ position: { x: 20, y: 20 } });

    // The one service-to-service call (the last connector the starter creates) carries the full
    // Service → Service editor, condition field included.
    await clickEdgeBetween(page, 7);
    await page.getByRole('button', { name: 'Condition', exact: true }).click();
    const condition = page.getByRole('textbox', { name: 'Condition text' });
    await condition.fill('when B needs C');
    await condition.press('Enter');
    const chip = page.locator('.dc-edge-condition', { hasText: 'when B needs C' });
    await expect(chip).toHaveCount(1);

    await chip.dblclick();
    const input = page.locator('.dc-edge-condition-input');
    await expect(input).toBeVisible();
    await input.fill('on every B request');
    await page.keyboard.press('Enter');
    await expect(page.locator('.dc-edge-condition', { hasText: 'on every B request' })).toHaveCount(1);
    await expect(page.locator('.dc-edge-condition-input')).toHaveCount(0);
  });

  test('an armed drawing tool can place a shape where the starter choices were', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 560 });
    await newCanvas(page, 'Draw through starters');
    const starters = page.getByRole('group', { name: 'Suggested starters', exact: true });
    const tile = (await starters.getByRole('button').first().boundingBox())!;
    await page.getByRole('button', { name: 'Service', exact: true }).click();
    await page.mouse.click(tile.x + tile.width / 2, tile.y + tile.height / 2);
    await expect(page.locator('.dc-node')).toHaveCount(1);
    await expect(page.locator('.dc-node[data-type="service"]')).toHaveCount(1);
    await expect(starters).toBeHidden();
  });

  test('the blank canvas offers them too, and stops offering once there is anything', async ({
    page,
  }) => {
    await newCanvas(page, 'Starter empty state');
    const starters = page.getByRole('group', { name: 'Suggested starters', exact: true });
    await expect(starters).toBeVisible();

    const browse = page.getByRole('button', { name: 'View all starters', exact: true });
    await browse.focus();
    await page.keyboard.press('Enter');
    const collection = page.getByRole('dialog', { name: 'Starters', exact: true });
    await expect(collection).toBeVisible();
    await expect(collection.locator('.dc-starters-grid .dc-starter')).toHaveCount(14);
    await page.keyboard.press('Escape');
    await expect(browse).toBeFocused();
    await expect(starters).toBeVisible();

    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.getByRole('dialog', { name: 'Commands' })).toBeVisible();
    await page.keyboard.press('Escape');

    await starters.getByRole('button', { name: 'Start from Event-Driven', exact: true }).click();
    await expect(page.locator('.dc-node')).toHaveCount(9);
    await expect(starters).toBeHidden();
  });

  test('the full collection previews a nonfeatured starter, adds it, and undoes in one step', async ({ page }) => {
    await newCanvas(page, 'Browse all starters');
    await page.getByRole('button', { name: 'View all starters', exact: true }).click();
    const collection = page.getByRole('dialog', { name: 'Starters', exact: true });
    await collection.getByRole('radio', { name: /^Patterns/ }).click();
    await collection.getByRole('button', { name: 'Transactional Outbox', exact: true }).click();
    // A preview first, with what it's for, then a choice.
    await expect(collection.getByRole('heading', { name: 'Transactional Outbox' })).toBeVisible();
    await expect(collection.getByText('Use it when')).toBeVisible();
    await collection.getByRole('button', { name: 'Add to canvas', exact: true }).click();
    await expect(collection).toBeHidden();
    await expect(page.locator('.dc-node').first()).toBeVisible();
    await expect(page.getByRole('group', { name: 'Suggested starters', exact: true })).toBeHidden();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('.dc-node')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'View all starters', exact: true })).toBeVisible();
  });

  test('a second starter lands clear of the first, and both survive a reload', async ({ page }) => {
    await newCanvas(page, 'Starter twice');
    await insertViaPalette(page, 'microservices');
    await expect(page.locator('.dc-node')).toHaveCount(14);
    await insertViaPalette(page, 'microservices');
    await expect(page.locator('.dc-node')).toHaveCount(28);

    // The two blocks occupy disjoint horizontal ranges in document space — nothing was dropped on
    // top of anything, and nothing already on the canvas moved to make room.
    const spans = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll('.react-flow__node')].map((node) => {
        const rect = node.getBoundingClientRect();
        return { left: rect.left, right: rect.right };
      });
      boxes.sort((a, b) => a.left - b.left);
      return boxes;
    });
    expect(spans.length).toBe(28);
    const firstBlockRight = Math.max(...spans.slice(0, 14).map((box) => box.right));
    const secondBlockLeft = Math.min(...spans.slice(14).map((box) => box.left));
    expect(secondBlockLeft).toBeGreaterThan(firstBlockRight);

    // A reload lands back in the library, the same way `critical-journey.spec.ts` re-opens.
    await expect(page.locator('.dc-save')).toContainText('Saved locally');
    await reopenAfterReload(page, 'Starter twice');
    await expect(page.locator('.dc-editor')).toBeVisible();
    await expect(page.locator('.dc-node')).toHaveCount(28);
  });
});

test.describe('the starters gallery, before it is loaded', () => {
  test('asks first, reads nothing until then, and then offers its starters', async ({ page }) => {
    const requests: string[] = [];
    page.on('request', (request) => {
      // By host, not by substring: any request to GitHub's raw file host counts, wherever it points.
      if (new URL(request.url()).hostname === 'raw.githubusercontent.com') requests.push(request.url());
    });
    await serveStarterGallery(page, { enabled: false });
    await openCanvas(page, 'Gallery consent');
    await expect(page.getByRole('group', { name: 'Suggested starters', exact: true })).toHaveCount(0);

    await page.getByRole('button', { name: /Browse the starters gallery/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Starters', exact: true });
    await expect(dialog.getByText(/Nothing about your diagrams is sent/)).toBeVisible();
    expect(requests).toEqual([]);

    await dialog.getByRole('button', { name: 'Load starters', exact: true }).click();
    await expect(dialog.locator('.dc-starters-grid .dc-starter')).toHaveCount(14);
    expect(requests.every((url) => url.startsWith('https://raw.githubusercontent.com/acltabontabon/draft-canvas-starters/main/'))).toBe(true);

    await page.keyboard.press('Escape');
    await expect(page.getByRole('group', { name: 'Suggested starters', exact: true })).toBeVisible();
  });
});
