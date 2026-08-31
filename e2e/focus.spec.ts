import { expect, test, type Page } from '@playwright/test';

/** Focus Mode: dimming, inferred edges, the indicator, and its exits. */

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

test.describe('focus mode', () => {
  test('dims everything outside the focused set, infers internal edges, and Escape restores', async ({
    page,
  }) => {
    await newCanvas(page, 'Focus dimming');
    await create(page, 'Service', { x: 250, y: 250 });
    await create(page, 'Service', { x: 550, y: 250 });
    await create(page, 'Database', { x: 850, y: 250 });

    // A -> B, B -> C. Only A and B will be focused.
    await connect(page, 0, 1);
    await connect(page, 1, 2);
    await expect(page.locator('.dc-edge-line')).toHaveCount(2);

    // Select nodes A and B (not C), and enter Focus.
    await page.locator('.dc-node').nth(0).click();
    await page.locator('.dc-node').nth(1).click({ modifiers: ['Shift'] });
    await expect(page.locator('.dc-inspector')).toContainText('2 elements');
    await page.getByRole('button', { name: 'Focus', exact: true }).click();

    await expect(page.locator('.dc-canvas[data-focus="on"]')).toBeVisible();
    await expect(page.locator('.dc-focus-indicator')).toContainText('2 nodes');
    // Dimming animates over 180ms — let it settle before reading computed opacity.
    await page.waitForTimeout(250);

    // A and B stay lit; C is dimmed — checked via the actual visual effect
    // (the react-flow wrapper's opacity), since that is what the feature promises.
    await expect(page.locator('.dc-node').nth(0)).toHaveAttribute('data-focused', 'true');
    await expect(page.locator('.dc-node').nth(1)).toHaveAttribute('data-focused', 'true');
    const wrapperOpacity = async (index: number) =>
      page
        .locator('.react-flow__node')
        .nth(index)
        .evaluate((el) => getComputedStyle(el).opacity);

    expect(Number(await wrapperOpacity(0))).toBeCloseTo(1, 1);
    expect(Number(await wrapperOpacity(1))).toBeCloseTo(1, 1);
    expect(Number(await wrapperOpacity(2))).toBeLessThan(0.5);

    // The A->B edge is inferred-focused (both endpoints are focused) and
    // stays lit; the B->C edge, touching only one focused node, is dimmed.
    // Opacity is set on the `.dc-edge` group (SVG composites it with its
    // children), not on the line itself, so that is what must be checked.
    const edgeOpacity = async (index: number) =>
      page
        .locator('.dc-edge')
        .nth(index)
        .evaluate((el) => getComputedStyle(el).opacity);
    expect(Number(await edgeOpacity(0))).toBeCloseTo(1, 1);
    expect(Number(await edgeOpacity(1))).toBeLessThan(0.5);

    await page.keyboard.press('Escape');
    await expect(page.locator('.dc-canvas[data-focus="on"]')).toHaveCount(0);
    await expect(page.locator('.dc-focus-indicator')).toHaveCount(0);
    await page.waitForTimeout(250);
    expect(Number(await wrapperOpacity(2))).toBeCloseTo(1, 1);
  });

  test('the indicator\'s close button exits focus, and focus never creates an undo entry', async ({
    page,
  }) => {
    await newCanvas(page, 'Focus exit button');
    await create(page, 'Service', { x: 300, y: 300 });
    await create(page, 'Service', { x: 600, y: 300 });

    await page.keyboard.press('Meta+a');
    await page.getByRole('button', { name: 'Focus', exact: true }).click();
    await expect(page.locator('.dc-focus-indicator')).toBeVisible();

    await page.locator('.dc-focus-indicator').getByRole('button', { name: 'Exit focus' }).click();
    await expect(page.locator('.dc-focus-indicator')).toHaveCount(0);
    await expect(page.locator('.dc-canvas[data-focus="on"]')).toHaveCount(0);

    // Entering and exiting focus left no entry on the undo stack: a single
    // Undo reaches straight past it to the last real edit (creating the
    // second node), rather than needing two.
    const before = await page.locator('.dc-node').count();
    await page.keyboard.press('Meta+z');
    await expect(page.locator('.dc-node')).toHaveCount(before - 1);
  });
});
