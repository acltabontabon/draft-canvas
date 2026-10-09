import { expect, test, type Page } from '@playwright/test';
import { cameraAtRest, newCanvas } from './canvas';

/**
 * The editor under a finger: a phone-sized viewport with a touch screen. A tap selects, a hold opens
 * the context menu a right-click would, two fingers zoom, and the create rail — which overflows at
 * this width — pages with its chevrons. Not a Playwright project of its own: the touch surface is one
 * spec's concern, not every spec's.
 */
test.use({ hasTouch: true, isMobile: true, viewport: { width: 412, height: 915 } });

/** A shape via the palette — the one creation path that needs no pointer at all. */
async function addService(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog', { name: 'Commands' })).toBeVisible();
  await page.keyboard.type('add service');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(page.locator('.dc-node-editor')).toHaveCount(0);
  await page.keyboard.press('Shift+1');
  // Fit animates: a gesture sent while that camera move is in flight can be overwritten by its tail.
  await cameraAtRest(page);
}

async function nodeCenter(page: Page) {
  const box = (await page.locator('.dc-node').first().boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Holds a finger still at a point. Chromium gets a real touch through CDP; WebKit, which Playwright
 * cannot drive with raw touches, gets the pointer events a held finger produces, dispatched at the
 * element under the point — the same events the editor listens for.
 */
async function hold(page: Page, browserName: string, at: { x: number; y: number }, ms: number) {
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: at.x, y: at.y }] });
    await page.waitForTimeout(ms);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();
    return;
  }
  await page.evaluate(
    ([x, y]) => {
      const target = document.elementFromPoint(x, y)!;
      const init = { bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, pointerId: 7, button: 0, clientX: x, clientY: y };
      target.dispatchEvent(new PointerEvent('pointerdown', init));
    },
    [at.x, at.y],
  );
  await page.waitForTimeout(ms);
  await page.evaluate(
    ([x, y]) => {
      const target = document.elementFromPoint(x, y)!;
      const init = { bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, pointerId: 7, button: 0, clientX: x, clientY: y };
      target.dispatchEvent(new PointerEvent('pointerup', init));
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
    },
    [at.x, at.y],
  );
}

async function zoomOf(page: Page) {
  return page.locator('.react-flow__viewport').evaluate((el) => {
    const match = /scale\(([\d.]+)\)/.exec(el.style.transform);
    return match ? Number(match[1]) : 1;
  });
}

test.describe('touch', () => {
  // Playwright emulates a touch device (`isMobile`) only in Chromium and WebKit.
  test.skip(({ browserName }) => browserName === 'firefox', 'mobile emulation is not available for Firefox in Playwright');
  test('a tap selects a shape, and a tap on empty canvas clears it', async ({ page }) => {
    await newCanvas(page, 'Touch tap');
    await addService(page);
    await page.locator('.dc-canvas').click({ position: { x: 5, y: 5 } }); // drop the fresh selection
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(0);

    const at = await nodeCenter(page);
    await page.touchscreen.tap(at.x, at.y);
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(1);

    // Empty canvas, well below the shape the fit just centred — and checked to be the pane itself,
    // so a miss reads as "that point is covered", not as a tap that did nothing.
    const pane = (await page.locator('.react-flow__pane').boundingBox())!;
    const empty = { x: pane.x + pane.width / 2, y: pane.y + pane.height - 60 };
    expect(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.className, [empty.x, empty.y])).toContain('react-flow__pane');
    await page.touchscreen.tap(empty.x, empty.y);
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(0);
  });

  test('a long-press on a shape opens its context menu; a short press does not', async ({ page, browserName }) => {
    await newCanvas(page, 'Touch long-press');
    await addService(page);
    const at = await nodeCenter(page);

    await hold(page, browserName, at, 150);
    await expect(page.locator('.dc-context-menu')).toHaveCount(0);

    await hold(page, browserName, at, 700);
    const menu = page.locator('.dc-context-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Edit text' })).toBeVisible();
    // The shape the finger was on is what the menu is for.
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(1);
  });

  test('a long-press on empty canvas opens the Add menu', async ({ page, browserName }) => {
    await newCanvas(page, 'Touch long-press pane');
    await addService(page);
    await hold(page, browserName, { x: 40, y: 860 }, 700);
    const menu = page.locator('.dc-context-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Add Service' })).toBeVisible();
  });

  test('two fingers moving apart zoom the canvas in', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'raw multi-touch is only dispatchable through CDP');
    // Headless Chromium on Linux receives the CDP touch points but does not turn two of them into a
    // pinch (the zoom never moves), where the macOS build does; CI's runners are Linux.
    test.skip(process.platform === 'linux', 'headless Chromium on Linux does not synthesize pinch-zoom from CDP touches');
    await newCanvas(page, 'Touch pinch');
    await addService(page);
    await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
    const before = await zoomOf(page);

    const cdp = await page.context().newCDPSession(page);
    // Fit puts the shape at the canvas centre. Pinching there starts a node drag, not a canvas
    // gesture; choose empty canvas below it, with every touch point inside the viewport.
    const pane = (await page.locator('.react-flow__pane').boundingBox())!;
    const cx = pane.x + pane.width / 2;
    const cy = pane.y + pane.height * 0.8;
    expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.classList.contains('react-flow__pane')), { x: cx, y: cy })).toBe(true);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [
        { x: cx - 30, y: cy, id: 0 },
        { x: cx + 30, y: cy, id: 1 },
      ],
    });
    // A real gesture spans frames. Sending every move and the release in one compositor frame can
    // coalesce away the starting distance, so Chromium never recognizes a pinch.
    const nextFrame = () => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await nextFrame();
    for (let step = 1; step <= 8; step += 1) {
      const spread = 30 + step * 15;
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          { x: cx - spread, y: cy, id: 0 },
          { x: cx + spread, y: cy, id: 1 },
        ],
      });
      await nextFrame();
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await cdp.detach();

    await expect.poll(() => zoomOf(page)).toBeGreaterThan(before * 1.3);
  });

  test("the create rail's chevron pages the tools that don't fit", async ({ page }) => {
    await newCanvas(page, 'Touch rail');
    const rail = page.locator('.dc-create-rail');
    await expect(rail).toBeVisible();
    const more = page.getByRole('button', { name: 'Show more tools' });
    await expect(more).toBeVisible();
    expect(await rail.evaluate((el) => el.scrollLeft)).toBe(0);
    const box = (await more.boundingBox())!;
    await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
    await expect.poll(() => rail.evaluate((el) => el.scrollLeft)).toBeGreaterThan(40);
  });
});
