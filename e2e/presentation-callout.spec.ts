import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Presentation callouts: while a flow plays, the step's element tells what it carries — no click.
 * Who speaks is covered in `tests/presentation-attachments.test.ts` and where the callout sits in
 * `tests/callout-placement.test.ts`; these cover the real thing on the CQRS starter's
 * "Submit command" flow: step 1 arrives at Command API (code), step 4 is the publish edge (note),
 * step 6 arrives at Read Store (note), and steps 2, 3 and 5 stay silent.
 */

type Box = { x: number; y: number; width: number; height: number };

async function presentSubmitCommand(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start from CQRS' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  await page.getByRole('button', { name: 'Submit command' }).click();
  await expect(page.locator('.dc-explain-count')).toHaveText('Step 1 / 6');
}

async function goToStep(page: Page, step: number) {
  const count = page.locator('.dc-explain-count');
  for (;;) {
    const current = Number((await count.textContent())!.match(/Step (\d+)/)![1]);
    if (current === step) break;
    await page.keyboard.press(current < step ? 'ArrowRight' : 'ArrowLeft');
    await expect(count).toHaveText(`Step ${current < step ? current + 1 : current - 1} / 6`);
  }
}

/**
 * The boxes of every given locator once they've all simultaneously come to rest. A callout
 * tracks the same camera transform as the canvas element it's beside, in lockstep — but the
 * callout is written straight to the DOM on every store update while the canvas repaints through
 * React, so under load one can read as "settled" a frame or two before the other catches up.
 * Polling them together, and only accepting a frame where neither moved, is what actually proves
 * the camera (or entrance animation) has finished — settling either one alone doesn't.
 */
async function settledBoxes(locators: readonly Locator[]): Promise<Box[]> {
  let previous: Box[] | null = null;
  for (let i = 0; i < 40; i++) {
    const boxes = await Promise.all(locators.map((locator) => locator.boundingBox()));
    if (boxes.every((box) => box !== null)) {
      const current = boxes as Box[];
      const stable =
        previous !== null &&
        current.every(
          (box, index) =>
            Math.abs(previous![index]!.x - box.x) < 0.5 &&
            Math.abs(previous![index]!.y - box.y) < 0.5 &&
            previous![index]!.width === box.width,
        );
      if (stable) return current;
      previous = current;
    } else {
      previous = null;
    }
    await locators[0]!.page().waitForTimeout(120);
  }
  throw new Error('boxes never settled together');
}

/** The callout's card once the camera and its entrance have both come to rest. */
async function settledBox(card: Locator): Promise<Box> {
  return (await settledBoxes([card]))[0]!;
}

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Gap between two boxes' nearest edges — 0 when they touch or overlap. */
const gapBetween = (a: Box, b: Box) =>
  Math.hypot(
    Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width)),
    Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height)),
  );

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A node by its name — whole, or cut short with an ellipsis. A name is laid out to the box with
 *  system fonts, so one that fits on macOS can be truncated on a Linux runner ("Domain…"). */
const nodeNamed = (page: Page, name: string) => {
  const prefixes = Array.from({ length: name.length - 1 }, (_, i) => escapeRegExp(name.slice(0, i + 1).trimEnd()));
  const pattern = new RegExp(`(?:${escapeRegExp(name)}|(?:${prefixes.join('|')})…)`);
  return page.locator('.react-flow__node').filter({ has: page.locator('.dc-node') }).filter({ hasText: pattern }).last();
};

async function expectInViewAndClearOfChrome(page: Page, card: Box) {
  const viewport = page.viewportSize()!;
  expect(card.x).toBeGreaterThanOrEqual(0);
  expect(card.y).toBeGreaterThanOrEqual(0);
  expect(card.x + card.width).toBeLessThanOrEqual(viewport.width);
  expect(card.y + card.height).toBeLessThanOrEqual(viewport.height);
  expect(overlaps(card, (await page.locator('.dc-explain').boundingBox())!)).toBe(false);
  expect(overlaps(card, (await page.locator('.dc-present-exit').boundingBox())!)).toBe(false);
}

test.describe('Presentation callouts', () => {
  test('a step’s note appears beside its connector without a click, and leaves with the step', async ({ page }) => {
    await presentSubmitCommand(page);
    await goToStep(page, 4);

    const callout = page.locator('.dc-callout');
    await expect(callout).toHaveCount(1);
    await expect(callout).toContainText('OrderPlaced — a fact, published after the write store commits.');
    // Only the story — no editing chrome, and not a repeat of the flow bar's "Write Model → Domain Events".
    await expect(callout.locator('button, textarea')).toHaveCount(0);
    await expect(callout).not.toContainText('Write Model');

    const [card, chip] = await settledBoxes([
      callout.locator('.dc-callout-card'),
      page.locator('.dc-attachment-chip-row').filter({ hasText: 'Note' }),
    ]);
    expect(gapBetween(card, chip)).toBeLessThan(60);
    expect(overlaps(card, (await nodeNamed(page, 'Write Model').boundingBox())!)).toBe(false);
    expect(overlaps(card, (await nodeNamed(page, 'Domain Events').boundingBox())!)).toBe(false);
    await expectInViewAndClearOfChrome(page, card);
    // The flow bar's announcement carries the note too.
    await expect(page.locator('.dc-explain [role="status"]')).toContainText('Note: OrderPlaced');

    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.dc-explain-count')).toHaveText('Step 5 / 6');
    await expect(callout).toHaveCount(0);

    await page.keyboard.press('ArrowLeft');
    await expect(callout).toHaveCount(1);
    await expect(callout).toContainText('OrderPlaced');
  });

  test('a node introduces itself when the flow first reaches it, and code reads as code', async ({ page }) => {
    await presentSubmitCommand(page);

    const callout = page.locator('.dc-callout');
    await expect(callout.locator('.dc-callout-code')).toContainText('"type": "PlaceOrder"');
    const [card, commandApi] = await settledBoxes([callout.locator('.dc-callout-card'), nodeNamed(page, 'Command API')]);
    expect(overlaps(card, commandApi)).toBe(false);
    expect(gapBetween(card, commandApi)).toBeLessThan(80);
    await expectInViewAndClearOfChrome(page, card);

    // Command API has already spoken — leaving it doesn't bring its code back.
    await goToStep(page, 2);
    await expect(callout).toHaveCount(0);

    await goToStep(page, 6);
    await expect(callout).toContainText('Shaped for the questions asked of it');
    const [readStoreCard, readStore] = await settledBoxes([callout.locator('.dc-callout-card'), nodeNamed(page, 'Read Store')]);
    expect(overlaps(readStoreCard, readStore)).toBe(false);
    expect(gapBetween(readStoreCard, readStore)).toBeLessThan(80);
  });

  test('stepping quickly converges on the step you land on, with nothing left behind', async ({ page }) => {
    await presentSubmitCommand(page);
    await expect(page.locator('.dc-callout')).toHaveCount(1);
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    await expect(page.locator('.dc-explain-count')).toHaveText('Step 6 / 6');
    await expect(page.locator('.dc-callout')).toHaveCount(1);
    await expect(page.locator('.dc-callout')).toContainText('Shaped for the questions');
    await expect(page.locator('.dc-callout[data-leaving]')).toHaveCount(0);

    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.dc-explain-count')).toHaveText('Step 1 / 6');
    await expect(page.locator('.dc-callout')).toHaveCount(1);
    await expect(page.locator('.dc-callout')).toContainText('PlaceOrder');
  });

  test('stays attached through zoom and resize, and docks above the bar when there is no room', async ({ page }) => {
    await presentSubmitCommand(page);
    await goToStep(page, 4);
    const card = page.locator('.dc-callout .dc-callout-card');
    const chipRow = page.locator('.dc-attachment-chip-row').filter({ hasText: 'Note' });
    await settledBox(card);

    // Zoom out around the connector: the callout keeps its size and follows the chip.
    const chip = (await chipRow.boundingBox())!;
    await page.mouse.move(chip.x + chip.width / 2, chip.y + 40);
    await page.mouse.wheel(0, 300);
    const [zoomed, zoomedChip] = await settledBoxes([card, chipRow]);
    expect(gapBetween(zoomed, zoomedChip)).toBeLessThan(60);

    await page.setViewportSize({ width: 1000, height: 720 });
    const resized = await settledBox(card);
    await expectInViewAndClearOfChrome(page, resized);

    await page.setViewportSize({ width: 520, height: 760 });
    await expect(page.locator('.dc-callout')).toHaveAttribute('data-placement', 'docked');
    const docked = await settledBox(card);
    expect(docked.y + docked.height).toBeLessThanOrEqual((await page.locator('.dc-explain').boundingBox())!.y);
  });

  test('with reduced motion the note is simply there, and simply gone', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await presentSubmitCommand(page);
    await goToStep(page, 4);
    await expect(page.locator('.dc-callout')).toBeVisible();
    const animations = await page.evaluate(
      () =>
        document.getAnimations().filter((animation) => (animation as CSSAnimation).animationName?.startsWith('dc-callout'))
          .length,
    );
    expect(animations).toBe(0);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.dc-callout')).toHaveCount(0);
  });

  test('a presenter can ask another element to speak, and the step change lets it go', async ({ page }) => {
    await presentSubmitCommand(page);
    await goToStep(page, 4);
    await nodeNamed(page, 'Read Store').locator('.dc-attachment-badge').click();
    await expect(page.locator('.dc-callout')).toHaveCount(1);
    await expect(page.locator('.dc-callout')).toContainText('Shaped for the questions');
    // Clicking inside the callout neither steps the presentation nor dismisses it.
    await page.locator('.dc-callout-note').click();
    await expect(page.locator('.dc-explain-count')).toHaveText('Step 4 / 6');
    await expect(page.locator('.dc-callout')).toContainText('Shaped for the questions');

    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.dc-callout')).toHaveCount(0);
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.dc-callout')).toContainText('OrderPlaced');
  });

  test('a reveal never flashes into the next step, and closes on a second click or Escape', async ({ page }) => {
    await presentSubmitCommand(page);
    await goToStep(page, 4);
    const badge = nodeNamed(page, 'Read Store').locator('.dc-attachment-badge');
    await badge.click();
    await expect(page.locator('.dc-callout')).toHaveCount(1);
    await expect(page.locator('.dc-callout')).toContainText('Shaped for the questions');
    await settledBox(page.locator('.dc-callout .dc-callout-card'));

    // Count every callout that mounts from here on: stepping must not mount a fresh one for the
    // element revealed on the previous step, even for the one render before the reveal clears.
    await page.evaluate(() => {
      const w = window as unknown as { __calloutMounts: string[] };
      w.__calloutMounts = [];
      new MutationObserver((records) => {
        for (const record of records) {
          for (const added of record.addedNodes) {
            if (added instanceof Element && added.matches('.dc-callout')) w.__calloutMounts.push(added.getAttribute('aria-label') ?? '');
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.dc-explain-count')).toHaveText('Step 5 / 6');
    await expect(page.locator('.dc-callout')).toHaveCount(0);
    expect(await page.evaluate(() => (window as unknown as { __calloutMounts: string[] }).__calloutMounts)).toEqual([]);

    // Asked again on this step, then asked to let go — by the same badge, then by Escape.
    await badge.click();
    await expect(page.locator('.dc-callout')).toHaveCount(1);
    await badge.click();
    await expect(page.locator('.dc-callout')).toHaveCount(0);
    await badge.click();
    await expect(page.locator('.dc-callout')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.dc-callout')).toHaveCount(0);
    // Escape backed out of the reveal only — still presenting, still on the step.
    await expect(page.locator('.dc-explain-count')).toHaveText('Step 5 / 6');
  });
});
