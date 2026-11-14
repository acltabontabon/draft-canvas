import { expect, test, type Page } from '@playwright/test';
import { create, newCanvas, nextFrames } from './canvas';

/**
 * The editor's chrome, measured rather than looked at: toasts clear of the create rail, the status bar
 * holding together at phone widths, the canvas showing where keyboard focus is, and the blank-canvas
 * hint reaching assistive technology and getting out of the chooser's way.
 */

/** A toast, without a flow of its own to produce one: pasting prose says "Nothing to paste". */
async function toast(page: Page) {
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', 'graphics are nice, but this is prose');
    document.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(page.locator('.dc-toast-message')).toContainText('Nothing to paste');
}

test.describe('narrow windows', () => {
  for (const width of [360, 375, 720]) {
    test(`the status bar holds together at ${width}px: nothing overflows or runs under the undo and zoom cluster`, async ({ page }) => {
      await page.setViewportSize({ width, height: 700 });
      await newCanvas(page, `Status bar ${width}`);
      // The chips that earn no room on a phone: stand-ins carry exactly the classes the real ones do,
      // so the rule is exercised without drawing a runtime connector, an open point and a C4 level.
      await page.locator('.dc-status-right').evaluate((right) => {
        for (const name of ['dc-status-traffic', 'dc-status-open-points', 'dc-status-level']) {
          const chip = document.createElement('button');
          chip.className = name;
          chip.textContent = name;
          right.prepend(chip);
        }
      });
      for (const name of ['dc-status-traffic', 'dc-status-open-points', 'dc-status-level']) {
        await expect(page.locator(`.dc-status-right > button.${name}`)).toBeHidden();
      }
      const bar = await page.locator('.dc-status').evaluate((element) => {
        const left = element.querySelector('.dc-status-left')!.getBoundingClientRect();
        const right = element.querySelector('.dc-status-right')!.getBoundingClientRect();
        return {
          overflows: element.scrollWidth > element.clientWidth,
          overlap: left.left < right.right && right.left < left.right && left.top < right.bottom && right.top < left.bottom,
          rightEdge: right.right,
          width: element.clientWidth,
        };
      });
      expect(bar.overflows).toBe(false);
      expect(bar.overlap).toBe(false);
      expect(bar.rightEdge).toBeLessThanOrEqual(bar.width);
    });
  }

  test('a toast sits below the whole toolbar, create rail included, when the toolbar is two rows', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'Firefox protects the clipboard data of synthetic paste events');
    await page.setViewportSize({ width: 375, height: 700 });
    await newCanvas(page, 'Toast offset');
    const toolbar = (await page.locator('.dc-toolbar').boundingBox())!;
    expect(toolbar.height).toBeGreaterThan(70); // two rows: the title, then the create rail
    await toast(page);
    const box = (await page.locator('.dc-toasts').boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(toolbar.y + toolbar.height);
  });
});

test.describe('keyboard and assistive technology', () => {
  test('Tab onto the canvas shows where focus is, as an inset ring that moves nothing', async ({ page }) => {
    await newCanvas(page, 'Canvas focus ring');
    const canvas = page.locator('.dc-canvas');
    const before = await canvas.boundingBox();
    // From the title field, so the last input was the keyboard and `:focus-visible` applies.
    await page.getByLabel('Diagram title').focus();
    await page.keyboard.press('Shift+Tab');
    await canvas.focus();
    await expect(canvas).toBeFocused();
    // The ring keys on `:focus-visible`, and whether an engine treats scripted focus after a key press
    // as keyboard focus is its own call; where it does not there is no ring to measure.
    if (await canvas.evaluate((element) => element.matches(':focus-visible'))) {
      await expect(canvas).toHaveCSS('outline-style', 'solid');
      await expect(canvas).toHaveCSS('outline-width', '2px');
      await expect(canvas).toHaveCSS('outline-offset', '-2px');
    } else {
      test.info().annotations.push({ type: 'note', description: 'This engine did not mark the script-focused canvas :focus-visible.' });
    }
    expect(await canvas.boundingBox()).toEqual(before);
  });

  test('Shift+F10 with nothing selected opens the canvas menu, reachable and usable by keyboard', async ({ page }) => {
    await newCanvas(page, 'Pane menu by keyboard');
    await page.locator('.dc-canvas').focus();
    await page.keyboard.press('Shift+F10');
    const menu = page.locator('.dc-context-menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Service', exact: true })).toBeVisible();
    // The first row is highlighted at once, so the arrows and Enter work: walk to Service, take it.
    await expect(menu.locator('[data-highlighted="true"]')).toHaveCount(1);
    for (let step = 0; step < 6 && !(await menu.locator('[data-highlighted="true"]').textContent())?.startsWith('Service'); step += 1) {
      await page.keyboard.press('ArrowDown');
    }
    await expect(menu.locator('[data-highlighted="true"]')).toHaveText('Service');
    await page.keyboard.press('Enter');
    await expect(menu).toBeHidden();
    await expect(page.locator('.dc-node')).toHaveCount(1);
  });

  test('the blank-canvas hint is read out, and gets out of the way of the chooser it leads to', async ({ page }) => {
    await newCanvas(page, 'Blank canvas hint');
    const hint = page.getByRole('status').filter({ hasText: 'Double-click or long-press' });
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('S');
    await expect(hint).toContainText('D');
    await expect(hint).toContainText('Q');
    await page.locator('.react-flow__pane').dblclick({ position: { x: 600, y: 400 } });
    const chooser = page.locator('.dc-quick-connect-item').first();
    await expect(chooser).toBeVisible();
    await expect(page.locator('.dc-empty-start')).toHaveCSS('visibility', 'hidden');
    // The highlighted row carries an accent bar, not only a tint that is 1.1:1 against the menu.
    await expect(page.locator('.dc-quick-connect-item[data-highlighted="true"]').first()).not.toHaveCSS('box-shadow', 'none');
    await page.keyboard.press('Escape');
    await expect(page.locator('.dc-empty-start')).toHaveCSS('visibility', 'visible');
  });
});

test.describe('a coarse pointer', () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 412, height: 915 } });

  // Emulated, not a real finger: Chromium reports `(pointer: coarse)` for a touch context, which is
  // what the rules key on. What a thumb really hits is for a device to say.
  test('chrome grows to a 40px target: buttons, status bar, popovers and menu rows', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'WebKit and Firefox contexts here do not report a coarse pointer');
    await newCanvas(page, 'Touch targets');
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.type('add service');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await page.keyboard.press('Shift+1');
    await nextFrames(page);

    const heights = (selector: string) =>
      page.locator(selector).evaluateAll((elements) =>
        elements.filter((element) => getComputedStyle(element).display !== 'none').map((element) => Math.round(element.getBoundingClientRect().height)),
      );
    // The status bar: Undo, Redo, zoom out / in and the percentage, Canvas settings, Help.
    const status = await heights('.dc-status .dc-status-right button');
    expect(status.length).toBeGreaterThanOrEqual(6);
    for (const height of status) expect(height).toBeGreaterThanOrEqual(40);

    // The selected shape's popover: every control in its row.
    await page.locator('.dc-node').first().tap();
    await expect(page.locator('.dc-element-inspector')).toBeVisible();
    const popover = await heights('.dc-element-inspector .dc-element-identity-row .dc-button, .dc-element-inspector .dc-inspector-select-button');
    expect(popover.length).toBeGreaterThanOrEqual(4);
    for (const height of popover) expect(height).toBeGreaterThanOrEqual(40);

    // And a context menu's rows, opened the keyboard way (a long-press needs a real finger).
    await page.locator('.dc-canvas').focus();
    await page.keyboard.press('Shift+F10');
    await expect(page.locator('.dc-context-menu')).toBeVisible();
    const rows = await heights('.dc-context-menu .dc-context-menu-item');
    expect(rows.length).toBeGreaterThan(3);
    for (const height of rows) expect(height).toBeGreaterThanOrEqual(40);
  });
});

test('a mouse keeps the compact chrome at any width', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await newCanvas(page, 'Mouse targets');
  expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(false);
  await create(page, 'Service', { x: 200, y: 300 });
  await page.locator('.dc-node').first().click();
  const undo = page.getByRole('button', { name: 'Undo' });
  expect((await undo.boundingBox())!.height).toBeLessThan(36);
});
