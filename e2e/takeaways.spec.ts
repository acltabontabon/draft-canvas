import { expect, test, type Page } from '@playwright/test';

/**
 * The journey this feature exists for: something is said during a meeting, it gets captured
 * without the drawing stopping, and at the end it comes back out as text somebody can paste.
 *
 * Deliberately driven the way a person drives it — the bare key, typing, Enter — rather than
 * through the store, because the thing most likely to break is one of the guards between the
 * keydown and the document.
 */

const CANVAS = '.react-flow__pane';
const CAPTURE = '.dc-takeaways-capture input';
const PANEL = '.dc-takeaways';
const CHIP = '.dc-status-takeaways';

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
  await page.locator(CANVAS).click({ position: at });
  if (tool === 'Note') await page.keyboard.press('Escape');
}

/**
 * Names the node at `index` through its own label editor, the way a person would — committed by
 * clicking away, because Escape *reverts* a label (the rename-field convention; only a Note
 * commits on Escape). Getting that wrong silently leaves every node called "Service".
 */
async function rename(page: Page, index: number, name: string) {
  await page.locator('.dc-node').nth(index).click();
  await page.keyboard.press('Enter');
  await expect(page.locator('.dc-node-editor')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(name);
  await page.locator(CANVAS).click({ position: { x: 60, y: 60 } });
  await expect(page.locator('.dc-node-editor')).toHaveCount(0);
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

async function capture(page: Page, text: string) {
  await page.keyboard.press('i');
  await expect(page.locator(CAPTURE)).toBeFocused();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await expect(page.locator(CAPTURE)).toHaveCount(0);
}

test.describe('Takeaways', () => {
  test('captures without leaving the canvas, remembers the shape, and completing one is undoable', async ({
    page,
  }) => {
    await newCanvas(page, 'Payments Platform');

    // Nothing has happened yet, so there is nothing in the status bar to say so.
    await expect(page.locator(CHIP)).toHaveCount(0);

    await create(page, 'Service', { x: 320, y: 260 });
    await rename(page, 0, 'Payment Service');

    // Captured with nothing selected: this one belongs to the whole canvas.
    await page.locator(CANVAS).click({ position: { x: 700, y: 480 } });
    await capture(page, 'Follow up with @SRE about monitoring');
    await expect(page.locator(PANEL)).toHaveCount(0);
    await expect(page.locator(CHIP)).toHaveAttribute('aria-label', /1 open action/);

    // Captured with a shape selected: it keeps where it came from.
    await page.locator('.dc-node').first().click();
    await page.keyboard.press('i');
    await expect(page.locator('.dc-takeaways-chip')).toContainText('Payment Service');
    await page.keyboard.type('Confirm the timeout');
    await page.keyboard.press('Enter');

    await page.locator(CHIP).click();
    await expect(page.locator(PANEL)).toBeVisible();
    await expect(page.getByRole('checkbox', { name: 'Confirm the timeout' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Go to Payment Service' })).toBeVisible();

    // Completing one is quiet: it leaves the list and joins a single collapsed row.
    await page.getByRole('checkbox', { name: 'Confirm the timeout' }).click();
    await expect(page.locator('.dc-takeaways-done-toggle')).toContainText('1 done');
    await expect(page.locator(CHIP)).toHaveAttribute('aria-label', /1 open action/);

    // And it is an ordinary edit, so it comes back.
    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator(CHIP)).toHaveAttribute('aria-label', /2 open actions/);
  });

  test('backspace on an empty line drops the context it was about to keep', async ({ page }) => {
    await newCanvas(page, 'Dropping context');
    await create(page, 'Service', { x: 320, y: 260 });
    await rename(page, 0, 'Ledger');
    await page.locator('.dc-node').first().click();

    await page.keyboard.press('i');
    await expect(page.locator('.dc-takeaways-chip')).toContainText('Ledger');
    await page.keyboard.press('Backspace');
    await expect(page.locator('.dc-takeaways-chip')).toHaveCount(0);

    await page.keyboard.type('Schedule the follow-up');
    await page.keyboard.press('Enter');

    await page.locator(CHIP).click();
    await expect(page.getByRole('checkbox', { name: 'Schedule the follow-up' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Go to / })).toHaveCount(0);
  });

  test('reads back the decisions already on the canvas, and copies the lot as Markdown', async ({ page }) => {
    await newCanvas(page, 'Payments Platform');

    // An ordinary note, tagged as a decision — nothing this feature stores.
    await create(page, 'Note', { x: 360, y: 240 });
    await page.locator('.dc-node[data-type="note"]').click();
    await page.keyboard.press('Enter');
    await page.keyboard.type('Use asynchronous processing');
    await page.keyboard.press('Escape');
    await page.locator('.dc-node[data-type="note"]').click();
    await page.getByRole('button', { name: /^Note kind/ }).click();
    await page.getByRole('option', { name: 'Decision' }).click();
    await page.keyboard.press('Escape');

    // The count is there on the strength of the decision alone, with no action captured yet.
    await expect(page.locator(CHIP)).toBeVisible();

    await page.locator(CANVAS).click({ position: { x: 700, y: 480 } });
    await capture(page, 'Check DLQ retention');

    await page.evaluate(() => {
      const seen: string[] = [];
      const clipboard = navigator.clipboard as { writeText: (text: string) => Promise<void> };
      const original = clipboard.writeText.bind(clipboard);
      clipboard.writeText = (text: string) => {
        seen.push(text);
        return original(text).catch(() => {});
      };
      (window as unknown as { __seen: string[] }).__seen = seen;
    });

    await page.locator(CHIP).click();
    await page.locator('.dc-takeaways-more').click();
    await expect(page.locator('.dc-takeaways-section-title').first()).toHaveText('Decisions');
    await expect(page.locator(PANEL)).toContainText('Use asynchronous processing');

    await page.getByRole('button', { name: 'Copy takeaways' }).click();
    const markdown = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen[0] ?? '');
    expect(markdown).toContain('## Payments Platform');
    expect(markdown).toContain('### Decisions');
    expect(markdown).toContain('- Use asynchronous processing');
    expect(markdown).toContain('- [ ] Check DLQ retention');
  });

  test('a capture left half-typed does not follow you into the next canvas', async ({ page }) => {
    await newCanvas(page, 'First');
    await page.keyboard.press('i');
    await expect(page.locator(CAPTURE)).toBeFocused();
    await page.keyboard.type('half a thou');

    // Text in the line keeps it open when focus leaves (dropping it would lose what was said), so
    // walking out of the canvas is the case that has to close it.
    await page.getByRole('button', { name: 'Back to your diagrams' }).click();
    await page.getByRole('button', { name: 'New canvas' }).click();
    await expect(page.locator('.dc-editor')).toBeVisible();

    await expect(page.locator(CAPTURE)).toHaveCount(0);
    await expect(page.locator('.dc-takeaways')).toHaveCount(0);
  });

  test('the arrival note goes away when Takeaways opens, however it was opened, and stays away', async ({ page }) => {
    const NUDGE = '.dc-takeaways-nudge';
    await newCanvas(page, 'Reminder');
    await capture(page, 'Call the vendor');

    // Away and back: a canvas that still owes something says so, once.
    await page.getByRole('button', { name: 'Back to your diagrams' }).click();
    await page.locator('.dc-library-item', { hasText: 'Reminder' }).click();
    await expect(page.locator(NUDGE)).toBeVisible();

    // Opened from the palette rather than the chip it points at: it has done its job all the same,
    // and would otherwise sit underneath the panel that opened over the very corner it hangs in.
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.type('Takeaways');
    await page.keyboard.press('Enter');
    await expect(page.locator(PANEL)).toBeVisible();
    await expect(page.locator(NUDGE)).toHaveCount(0);

    // Finish the only open action, put the panel away, and capture something new later: not an
    // arrival, so nothing should point at it.
    await page.getByRole('button', { name: 'Back to actions' }).click();
    await page.getByRole('checkbox', { name: 'Call the vendor' }).click();
    await page.keyboard.press('Escape');
    await page.locator(CANVAS).click({ position: { x: 700, y: 480 } });
    await capture(page, 'Chase the invoice');
    await expect(page.locator(CHIP)).toHaveAttribute('aria-label', /1 open action/);
    await expect(page.locator(NUDGE)).toHaveCount(0);
  });

  test('capturing puts the arrival note away, so it is never underneath the capture line', async ({ page }) => {
    const NUDGE = '.dc-takeaways-nudge';
    await newCanvas(page, 'Reminder two');
    await capture(page, 'Call the vendor');
    await page.getByRole('button', { name: 'Back to your diagrams' }).click();
    await page.locator('.dc-library-item', { hasText: 'Reminder two' }).click();
    await expect(page.locator(NUDGE)).toBeVisible();

    await page.keyboard.press('i');
    await expect(page.locator(CAPTURE)).toBeFocused();
    await expect(page.locator(NUDGE)).toHaveCount(0);
  });

  test('captures mid-walkthrough, taking the step as its context, without leaving presenting', async ({
    page,
  }) => {
    await newCanvas(page, 'Presenting');
    await create(page, 'Service', { x: 260, y: 260 });
    await rename(page, 0, 'Orders');
    await create(page, 'Service', { x: 620, y: 260 });
    await rename(page, 1, 'Payments');
    await connect(page, 0, 1);
    await expect(page.locator('.dc-edge')).toHaveCount(1);

    await page.locator('.dc-edge').first().click({ force: true });
    await page.getByRole('button', { name: /Add to flow/ }).click();
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Present', exact: true }).click();
    await expect(page.locator('.dc-explain')).toBeVisible();
    await expect(page.locator('.dc-toolbar')).toHaveCount(0);

    // Into the first step (the opening has no step to capture against), then the one bare key
    // presentation lets through.
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.dc-explain-count')).toContainText('Step 1 / 1');
    await page.keyboard.press('i');
    await expect(page.locator(CAPTURE)).toBeFocused();
    await expect(page.locator('.dc-takeaways-chip')).toContainText('Orders → Payments');
    await page.keyboard.type('Verify the timeout here');
    await page.keyboard.press('Enter');

    // Still presenting, and the list itself never appeared over the diagram.
    await expect(page.locator('.dc-explain')).toBeVisible();
    await expect(page.locator('.dc-toolbar')).toHaveCount(0);
    await expect(page.locator(PANEL)).toHaveCount(0);
  });
});
