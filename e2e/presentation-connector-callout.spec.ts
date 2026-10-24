import { expect, test, type Page } from '@playwright/test';
import { cameraAtRest } from './canvas';

/**
 * A connector's note, presented on a short connector, and the step card beside it.
 *
 * The publish connector runs straight down from Loan Account Service to Loan Events Queue across a
 * narrow gap, with its question chip in that gap. Every spot the callout tried hugged the chip and
 * so touched one endpoint or the other, and it docked at the bottom of the canvas, threadless and
 * nowhere near its connector. The step card's 132px cap meanwhile cut its chips row in half.
 * Placement itself is covered in `tests/callout-placement.test.ts`; this is the real thing, in the
 * dark theme, at an ordinary and a short window.
 */

type Box = { x: number; y: number; width: number; height: number };

const node = (id: string, type: string, text: string, x: number, y: number, extra: object = {}) => ({
  id,
  type,
  text,
  x,
  y,
  width: type === 'queue' ? 172 : 180,
  height: type === 'queue' ? 56 : 84,
  z: 1,
  ...extra,
});

function loanDocument() {
  return {
    format: 'draft-canvas',
    version: 21,
    metadata: { id: 'loan-callout', title: 'Loan events', createdAt: 1, updatedAt: 2 },
    nodes: [
      node('domain', 'group', 'Loan Domain', -40, -60, { width: 560, height: 220, z: 0, boundaryPreset: 'domain' }),
      node('api', 'service', 'Loan API', 0, 0, { parentId: 'domain' }),
      node('account', 'service', 'Loan Account Service', 300, 0, { parentId: 'domain' }),
      node('messaging', 'group', 'Messaging', 260, 170, { width: 260, height: 120, z: 0, boundaryPreset: 'boundary' }),
      node('queue', 'queue', 'Loan Events Queue', 304, 214, { parentId: 'messaging' }),
      node('ledger', 'service', 'Ledger Service', 700, 200),
    ],
    edges: [
      { id: 'opens', source: 'api', target: 'account', directed: true, routing: 'smoothstep', label: 'Opens loan' },
      {
        id: 'publishes',
        source: 'account',
        target: 'queue',
        directed: true,
        routing: 'smoothstep',
        label: 'Publishes LoanEvent',
        async: true,
        attachments: [
          {
            id: 'outbox',
            type: 'note',
            noteKind: 'question',
            text: 'Saving to the DB and publishing are two separate writes. If the publish fails after the save, the ledger misses the event. Consider a transactional outbox.',
          },
        ],
      },
      { id: 'delivers', source: 'queue', target: 'ledger', directed: true, routing: 'smoothstep', label: 'Delivers LoanEvent', async: true },
    ],
    flows: [
      {
        id: 'loan-flow',
        title: 'Loan event reaches the ledger',
        steps: [
          { id: 's1', edgeId: 'opens', caption: 'The API opens the loan account' },
          { id: 's2', edgeId: 'publishes', caption: 'Service publishes the matching event' },
          { id: 's3', edgeId: 'delivers', caption: 'The ledger records it' },
        ],
      },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { showSequence: true, grid: 'dots' },
  };
}

async function presentPublishStep(page: Page) {
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', {
    name: 'loan.draftcanvas',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(loanDocument())),
  });
  await page.waitForSelector('.dc-editor');
  await cameraAtRest(page);
  // The diagram's only flow opens straight away, at its opening overview.
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.dc-explain-count')).toHaveText('Step 1 / 3');
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.dc-explain-count')).toHaveText('Step 2 / 3');
  await expect(page.locator('.dc-callout')).toHaveCount(1);
  await cameraAtRest(page);
  // The entrances (card, thread) have played once nothing on the callout or the caption runs.
  await expect
    .poll(() =>
      page.locator('.dc-callout, .dc-present-caption').evaluateAll((elements) =>
        elements.some((el) => el.getAnimations({ subtree: true }).some((animation) => animation.playState === 'running')),
      ),
    )
    .toBe(false);
}

const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

const gapBetween = (a: Box, b: Box) =>
  Math.hypot(
    Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.width, b.x + b.width)),
    Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.height, b.y + b.height)),
  );

const nodeBox = async (page: Page, id: string) => (await page.locator(`.react-flow__node[data-id="${id}"]`).boundingBox())!;

for (const size of [
  { width: 1440, height: 900 },
  { width: 1000, height: 630 },
]) {
  test.describe(`Presenting a short connector’s note at ${size.width}×${size.height}`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize(size);
      await presentPublishStep(page);
    });

    test('the note hangs beside its chip on a thread, off the step’s shapes and on screen', async ({ page }) => {
      const callout = page.locator('.dc-callout');
      await expect(callout).toContainText('transactional outbox');
      await expect(callout).not.toHaveAttribute('data-placement', 'docked');
      const card = (await callout.locator('.dc-callout-card').boundingBox())!;
      const chip = (await page.locator('.dc-attachment-chip-row[data-host-id="publishes"]').boundingBox())!;
      expect(gapBetween(card, chip)).toBeLessThan(120);
      // The thread is drawn, and actually reaches across the gap.
      const leader = (await callout.locator('.dc-callout-leader').boundingBox())!;
      expect(Math.max(leader.width, leader.height)).toBeGreaterThan(4);
      expect(overlaps(card, await nodeBox(page, 'account'))).toBe(false);
      expect(overlaps(card, await nodeBox(page, 'queue'))).toBe(false);
      expect(card.x).toBeGreaterThanOrEqual(0);
      expect(card.y).toBeGreaterThanOrEqual(0);
      expect(card.x + card.width).toBeLessThanOrEqual(size.width);
      expect(card.y + card.height).toBeLessThanOrEqual(size.height);
      for (const chrome of ['.dc-explain', '.dc-present-exit', '.dc-present-caption']) {
        expect(overlaps(card, (await page.locator(chrome).boundingBox())!)).toBe(false);
      }
    });

    test('the step card shows all of its content, chips included', async ({ page }) => {
      const caption = page.locator('.dc-present-caption');
      await expect(caption).toContainText('Service publishes the matching event');
      expect(await caption.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
      const box = (await caption.boundingBox())!;
      const chips = page.locator('.dc-present-chip');
      await expect(chips).toHaveText(['async', 'crosses Loan Domain', 'crosses Messaging']);
      for (const chip of await chips.all()) {
        const b = (await chip.boundingBox())!;
        expect(b.y).toBeGreaterThanOrEqual(box.y);
        expect(b.y + b.height).toBeLessThanOrEqual(box.y + box.height);
        expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width);
      }
      // Nothing more to read, so no control offering it.
      await expect(page.locator('.dc-present-read-more')).toHaveCount(0);
    });
  });
}
