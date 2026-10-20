import { openStarter } from './library';
import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * Presentation callouts: while a flow plays, the step's element tells what it carries — no click.
 * Who speaks is covered in `tests/presentation-attachments.test.ts` and where the callout sits in
 * `tests/callout-placement.test.ts`; these cover the real thing on the CQRS starter's
 * "Submit command" flow: step 1 arrives at Command API (code), step 5 is the publish edge (note),
 * step 7 arrives at Read Store (note), and steps 2, 3, 4 and 6 stay silent.
 */

type Box = { x: number; y: number; width: number; height: number };

async function presentSubmitCommand(page: Page) {
  await page.goto('/');
  await openStarter(page, 'CQRS');
  await expect(page.locator('.dc-editor')).toBeVisible();
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  // The flow picker is a menu, and each flow one of its options — see `FlowBar.tsx`, where that
  // role is what stands the walkthrough's own arrow keys down while the list is open.
  await page.getByRole('menuitemradio', { name: 'Submit command' }).click();
  // Through the opening (the title over the whole path) to the first step.
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.dc-explain-count')).toHaveText('Step 1 / 7');
}

async function goToStep(page: Page, step: number) {
  const count = page.locator('.dc-explain-count');
  for (;;) {
    const current = Number((await count.textContent())!.match(/Step (\d+)/)![1]);
    if (current === step) break;
    await page.keyboard.press(current < step ? 'ArrowRight' : 'ArrowLeft');
    await expect(count).toHaveText(`Step ${current < step ? current + 1 : current - 1} / 7`);
  }
}

/**
 * Wait for the actual camera transition and entrance animations, then sample all boxes together.
 * Callouts follow the camera straight through the DOM while canvas nodes follow through React,
 * so one stationary element alone cannot prove the pair has caught up.
 */
async function settledBoxes(locators: readonly Locator[]): Promise<Box[]> {
  const page = locators[0]!.page();
  await page.bringToFront();
  let previous: { transform: string; boxes: Box[] } | null = null;
  let stableRuns = 0;
  await expect.poll(async () => {
    const camera = await page.locator('.react-flow__renderer').evaluate((renderer) => {
      // React Flow's XYPanZoom schedules d3 transitions on this renderer. Their removal proves
      // completion even when WebKit delays idle animation frames; a quiet transform alone can
      // also be a transition that has not received its first tick yet.
      const transitions = (renderer as HTMLElement & { __transition?: Record<string, unknown> }).__transition;
      const viewport = renderer.querySelector<HTMLElement>('.react-flow__viewport');
      return { moving: Object.keys(transitions ?? {}).length > 0, transform: viewport?.style.transform };
    });
    const animations = await Promise.all(locators.map((locator) =>
      locator.evaluate((el) => el.getAnimations({ subtree: true }).some((animation) => animation.playState === 'running')),
    ));
    const boxes = await Promise.all(locators.map((locator) => locator.boundingBox()));
    if (camera.moving || camera.transform === undefined || animations.some(Boolean) || boxes.some((box) => box === null)) {
      previous = null;
      stableRuns = 0;
      return false;
    }
    const current = boxes as Box[];
    const stable = previous !== null && previous.transform === camera.transform && current.every((box, index) =>
      Math.abs(previous!.boxes[index]!.x - box.x) < 0.5 &&
      Math.abs(previous!.boxes[index]!.y - box.y) < 0.5 &&
      previous!.boxes[index]!.width === box.width &&
      previous!.boxes[index]!.height === box.height,
    );
    stableRuns = stable ? stableRuns + 1 : 0;
    previous = { transform: camera.transform, boxes: current };
    return stableRuns >= 2;
  }, {
    message: 'the camera and callout boxes have come to rest together',
    intervals: [100],
    timeout: 10_000,
  }).toBe(true);
  return previous!.boxes;
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
    await goToStep(page, 5);

    const callout = page.locator('.dc-callout');
    await expect(callout).toHaveCount(1);
    await expect(callout).toContainText('Published only after the commit');
    // Only the story — no editing chrome, and not a repeat of the flow bar's "Outbox Relay → Domain Events".
    await expect(callout.locator('button, textarea')).toHaveCount(0);
    await expect(callout).not.toContainText('Outbox Relay');

    const [card, chip] = await settledBoxes([
      callout.locator('.dc-callout-card'),
      page.locator('.dc-attachment-chip-row').filter({ hasText: 'Note' }),
    ]);
    expect(gapBetween(card, chip)).toBeLessThan(60);
    expect(overlaps(card, (await nodeNamed(page, 'Outbox Relay').boundingBox())!)).toBe(false);
    expect(overlaps(card, (await nodeNamed(page, 'Domain Events').boundingBox())!)).toBe(false);
    await expectInViewAndClearOfChrome(page, card);
    // The flow bar's announcement carries the note too.
    await expect(page.locator('.dc-explain [role="status"]')).toContainText('Note: Published only after');

    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.dc-explain-count')).toHaveText('Step 6 / 7');
    await expect(callout).toHaveCount(0);

    await page.keyboard.press('ArrowLeft');
    await expect(callout).toHaveCount(1);
    await expect(callout).toContainText('Published only after');
  });

  test('settled callouts can be measured without more animation frames', async ({ page }) => {
    await presentSubmitCommand(page);
    await goToStep(page, 5);
    const locators = [
      page.locator('.dc-callout-card'),
      page.locator('.dc-attachment-chip-row').filter({ hasText: 'Note' }),
    ];
    const resting = await settledBoxes(locators);
    // Reproduce an idle WebKit page withholding further frame callbacks. Measurement must
    // observe the completed transition and geometry, without asking that idle page to animate.
    await page.evaluate(() => { window.requestAnimationFrame = () => 0; });
    expect(await settledBoxes(locators)).toEqual(resting);
  });

  test('a node introduces itself when the flow first reaches it, and code reads as code', async ({ page }) => {
    await presentSubmitCommand(page);

    const callout = page.locator('.dc-callout');
    await expect(callout.locator('.dc-callout-code')).toContainText('"type": "ChangeStatus"');
    const [card, commandApi] = await settledBoxes([callout.locator('.dc-callout-card'), nodeNamed(page, 'Command API')]);
    expect(overlaps(card, commandApi)).toBe(false);
    expect(gapBetween(card, commandApi)).toBeLessThan(80);
    await expectInViewAndClearOfChrome(page, card);

    // Command API has already spoken — leaving it doesn't bring its code back.
    await goToStep(page, 2);
    await expect(callout).toHaveCount(0);

    await goToStep(page, 7);
    await expect(callout).toContainText('Shaped for the questions asked of it');
    const [readStoreCard, readStore] = await settledBoxes([callout.locator('.dc-callout-card'), nodeNamed(page, 'Read Store')]);
    expect(overlaps(readStoreCard, readStore)).toBe(false);
    expect(gapBetween(readStoreCard, readStore)).toBeLessThan(80);
  });

  test('stepping quickly converges on the step you land on, with nothing left behind', async ({ page }) => {
    await presentSubmitCommand(page);
    await expect(page.locator('.dc-callout')).toHaveCount(1);
    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowRight');
    await expect(page.locator('.dc-explain-count')).toHaveText('Step 7 / 7');
    await expect(page.locator('.dc-callout')).toHaveCount(1);
    await expect(page.locator('.dc-callout')).toContainText('Shaped for the questions');
    await expect(page.locator('.dc-callout[data-leaving]')).toHaveCount(0);

    for (let i = 0; i < 6; i++) await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.dc-explain-count')).toHaveText('Step 1 / 7');
    await expect(page.locator('.dc-callout')).toHaveCount(1);
    await expect(page.locator('.dc-callout')).toContainText('ChangeStatus');
  });

  test('stays attached through zoom and resize, and docks above the bar when there is no room', async ({ page }) => {
    await presentSubmitCommand(page);
    await goToStep(page, 5);
    const card = page.locator('.dc-callout .dc-callout-card');
    const chipRow = page.locator('.dc-attachment-chip-row').filter({ hasText: 'Note' });
    const resting = await settledBox(card);

    // Zoom out around the connector: the callout keeps its size and follows the chip. The wheel goes
    // over the chip itself — a point picked relative to it lands on whatever the layout puts there
    // (the flow bar on one machine, bare canvas on another) — and holds Control, because a plain
    // wheel pans this canvas (`panOnScroll`). A pan that pushes the chip against the canvas edge
    // rightly docks the callout above the flow bar, far from the chip.
    const chip = (await chipRow.boundingBox())!;
    const pointer = { x: chip.x + chip.width / 2, y: chip.y + chip.height / 2 };
    const hit = await page.evaluate(({ x, y }) => {
      const element = document.elementFromPoint(x, y);
      return { chip: !!element?.closest('.dc-attachment-chip-row'), className: element?.getAttribute('class'), text: element?.textContent?.slice(0, 100) };
    }, pointer);
    if (!hit.chip) await page.screenshot({ path: test.info().outputPath('covered-chip.png') });
    expect(hit.chip, `Chip covered by ${JSON.stringify(hit)}`).toBe(true);
    const zoom = () =>
      page.locator('.react-flow__viewport').evaluate((viewport) => new DOMMatrixReadOnly(getComputedStyle(viewport).transform).a);
    const before = await zoom();
    await page.mouse.move(pointer.x, pointer.y);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, 300);
    await page.keyboard.up('Control');
    await expect.poll(zoom).toBeLessThan(before);
    const [zoomed, zoomedChip] = await settledBoxes([card, chipRow]);
    expect(zoomed.width).toBeCloseTo(resting.width, 0);
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
    await goToStep(page, 5);
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
    // The Command API: on screen at steps 5 and 6 at this window size, in every engine (Read Store,
    // further right, is only reachable by scrolling the canvas, which only Chromium allows).
    await presentSubmitCommand(page);
    await goToStep(page, 5);
    await nodeNamed(page, 'Command API').locator('.dc-attachment-badge').click();
    await expect(page.locator('.dc-callout')).toHaveCount(1);
    await expect(page.locator('.dc-callout')).toContainText('ChangeStatus');
    // Clicking inside the callout neither steps the presentation nor dismisses it.
    await page.locator('.dc-callout-card').click();
    await expect(page.locator('.dc-explain-count')).toHaveText('Step 5 / 7');
    await expect(page.locator('.dc-callout')).toContainText('ChangeStatus');

    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.dc-callout')).toHaveCount(0);
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.dc-callout')).toContainText('Published only after');
  });

  test('a reveal never flashes into the next step, and closes on a second click or Escape', async ({ page }) => {
    await presentSubmitCommand(page);
    await goToStep(page, 5);
    const badge = nodeNamed(page, 'Command API').locator('.dc-attachment-badge');
    await badge.click();
    await expect(page.locator('.dc-callout')).toHaveCount(1);
    await expect(page.locator('.dc-callout')).toContainText('ChangeStatus');
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
    await expect(page.locator('.dc-explain-count')).toHaveText('Step 6 / 7');
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
    await expect(page.locator('.dc-explain-count')).toHaveText('Step 6 / 7');
  });
});
