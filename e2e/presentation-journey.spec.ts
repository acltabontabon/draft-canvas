import { expect, test, type Page } from '@playwright/test';

/**
 * Presentation Mode's journey — "follow the signal": an opening that frames the flow under its
 * title, a step whose signal travels its own connector once and settles, a closing that returns
 * to the whole path, and the ways a presenter steers through it (timeline, overview, a manual
 * pan and the way back, the pointer) — on the CQRS starter's "Submit command" flow. The camera's
 * rules are covered in `tests/presentation-framing.test.ts`; this is the real thing on screen.
 */
async function presentSubmitCommand(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start from CQRS' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Submit command' }).click();
  await expect(page.locator('.dc-present-card[data-kind="opening"]')).toBeVisible();
}

/** React Flow's camera, read off the viewport transform. */
async function cameraOf(page: Page): Promise<{ x: number; y: number; zoom: number }> {
  return page.evaluate(() => {
    const viewport = document.querySelector<HTMLElement>('.react-flow__viewport')!;
    const match = viewport.style.transform.match(/translate\(([-\d.]+)px, ([-\d.]+)px\) scale\(([-\d.]+)\)/);
    return match ? { x: Number(match[1]), y: Number(match[2]), zoom: Number(match[3]) } : { x: 0, y: 0, zoom: 1 };
  });
}

test.describe('Presentation journey', () => {
  test('opens on the whole flow, tells each step once, and closes on the path', async ({ page }) => {
    await presentSubmitCommand(page);

    // The opening: the flow's title, the shapes its path passes through, how to begin — and the
    // whole path lit at once, with no single step active and nothing speaking yet.
    const opening = page.locator('.dc-present-card[data-kind="opening"]');
    await expect(opening).toContainText('Submit command');
    await expect(opening).toContainText('6 steps');
    await expect(opening.locator('.dc-present-route')).toContainText('Client');
    await expect(page.locator('.dc-canvas[data-explain-stage="overview"]')).toBeVisible();
    await expect(page.locator('.dc-edge[data-shown="true"]')).toHaveCount(6);
    await expect(page.locator('.dc-edge[data-active="true"]')).toHaveCount(0);
    await expect(page.locator('.dc-callout')).toHaveCount(0);
    await expect(page.locator('.dc-explain-count')).toHaveText('6 steps');

    // The first press begins the story: one signal, on the step's own connector, and a caption
    // that names the interaction with words already on the canvas.
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.dc-explain-count')).toHaveText('Step 1 / 6');
    await expect(page.locator('.dc-canvas[data-explain-stage]')).toHaveCount(0);
    await expect(page.locator('.dc-edge[data-active="true"] .dc-signal')).toHaveCount(1);
    await expect(page.locator('.dc-node[data-explain-role="target"] .dc-arrival')).toHaveCount(1);
    const caption = page.locator('.dc-present-caption');
    await expect(caption).toContainText('Step 1 of 6');
    await expect(caption).toContainText('Client');
    await expect(caption).toContainText('Command API');
    // Client sits outside the Command boundary; the API inside it — the crossing is named.
    await expect(caption.locator('.dc-present-chip')).toContainText(['crosses Command']);
    await expect(page.locator('.dc-node[data-explain-crossed="true"]')).toHaveCount(1);
    await expect(page.locator('.dc-present-tick[aria-current="step"]')).toHaveAttribute('aria-label', /Step 1/);

    // Once the signal has arrived, the scene is still: the same one signal element, no loop.
    await page.waitForTimeout(1200);
    await expect(page.locator('.dc-signal')).toHaveCount(1);

    // The last step, then the closing: the whole path again, replay and the next flow offered.
    await page.keyboard.press('End');
    await expect(page.locator('.dc-explain-count')).toHaveText('Step 6 / 6');
    await page.keyboard.press('ArrowRight');
    const closing = page.locator('.dc-present-card[data-kind="closing"]');
    await expect(closing).toContainText('End of flow');
    await expect(closing).toContainText('Submit command');
    await expect(page.locator('.dc-canvas[data-explain-stage="overview"]')).toBeVisible();
    await expect(page.locator('.dc-callout')).toHaveCount(0);
    await expect(page.locator('.dc-present-caption')).toHaveCount(0);

    await closing.getByRole('button', { name: 'Replay' }).click();
    await expect(page.locator('.dc-explain-count')).toHaveText('Step 1 / 6');
    await page.keyboard.press('End');
    await page.keyboard.press('ArrowRight');
    await closing.getByRole('button', { name: /^Next: Read projection/ }).click();
    await expect(page.locator('.dc-present-card[data-kind="opening"]')).toContainText('Read projection');
    await expect(page.locator('.dc-explain-flow-pos')).toContainText('Flow 2 of 2');
  });

  test('back from step 1 is the opening; the timeline and digits jump straight to a step', async ({ page }) => {
    await presentSubmitCommand(page);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.dc-present-card[data-kind="opening"]')).toBeVisible();

    await page.locator('.dc-present-tick').nth(3).click();
    await expect(page.locator('.dc-explain-count')).toHaveText('Step 4 / 6');
    await page.keyboard.press('2');
    await expect(page.locator('.dc-explain-count')).toHaveText('Step 2 / 6');
    await page.keyboard.press('Home');
    await expect(page.locator('.dc-explain-count')).toHaveText('Step 1 / 6');
  });

  test('the latest press wins: a burst of navigation converges with one signal and no stale card', async ({ page }) => {
    await presentSubmitCommand(page);
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowLeft');
    await expect(page.locator('.dc-present-card[data-kind="opening"]')).toContainText('Submit command');
    await expect(page.locator('.dc-signal')).toHaveCount(0);
    await expect(page.locator('.dc-present-caption')).toHaveCount(0);
    await page.keyboard.press('3');
    await expect(page.locator('.dc-explain-count')).toHaveText('Step 3 / 6');
    await expect(page.locator('.dc-signal')).toHaveCount(1);
    await expect(page.locator('.dc-present-card')).toHaveCount(0);
  });

  test('overview keeps the step, a manual pan is respected until Re-centre, and exit restores the editor', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Start from Microservices' }).click();
    await expect(page.locator('.dc-editor')).toBeVisible();
    // Leave the editor somewhere deliberate, so coming back has something to restore.
    await page.mouse.move(700, 450);
    await page.mouse.wheel(0, 240);
    await page.waitForTimeout(300);
    const before = await cameraOf(page);

    await page.getByRole('button', { name: 'Present', exact: true }).click();
    await page.getByRole('menuitemradio', { name: 'Place an order' }).click();
    await expect(page.locator('.dc-present-card[data-kind="opening"]')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.dc-explain-count')).toHaveText('Step 1 / 4');
    await page.waitForTimeout(600);
    const framed = await cameraOf(page);

    // Overview pulls back to the whole flow without losing the step; O again returns to it.
    await page.keyboard.press('o');
    await expect(page.getByRole('button', { name: 'Back to the step' })).toBeVisible();
    await expect(page.locator('.dc-explain-count')).toHaveText('Step 1 / 4');
    await page.waitForTimeout(700);
    const overview = await cameraOf(page);
    expect(overview.zoom).toBeLessThan(framed.zoom);
    await page.keyboard.press('o');
    await expect(page.getByRole('button', { name: 'Overview' })).toBeVisible();
    await page.waitForTimeout(700);
    expect((await cameraOf(page)).zoom).toBeCloseTo(framed.zoom, 2);

    // A hand on the camera: the presentation stands down and offers the way back.
    await page.mouse.move(700, 450);
    await page.mouse.wheel(0, 200);
    await expect(page.getByRole('button', { name: 'Re-centre on the step' })).toBeVisible();
    await page.waitForTimeout(400);
    const moved = await cameraOf(page);
    expect(moved.y).not.toBeCloseTo(framed.y, 0);
    await page.keyboard.press('r');
    await expect(page.getByRole('button', { name: 'Overview' })).toBeVisible();
    await page.waitForTimeout(700);
    expect((await cameraOf(page)).y).toBeCloseTo(framed.y, 0);

    // The pointer follows the cursor while on, and comes off with the mode.
    await page.keyboard.press('p');
    await page.mouse.move(500, 300);
    await expect(page.locator('.dc-present-pointer[data-shown="true"]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.dc-toolbar')).toBeVisible();
    await expect(page.locator('.dc-present-pointer')).toHaveCount(0);
    await expect(page.locator('.dc-signal')).toHaveCount(0);
    await page.waitForTimeout(500);
    const after = await cameraOf(page);
    expect(after.x).toBeCloseTo(before.x, 0);
    expect(after.y).toBeCloseTo(before.y, 0);
    expect(after.zoom).toBeCloseTo(before.zoom, 2);
  });
});
