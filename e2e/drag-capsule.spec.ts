import { expect, test, type Page } from '@playwright/test';

/**
 * Dragging a Note/Code card shows its identity rather than its geometry: past a real movement
 * threshold, and only once the aim point reaches something the card could attach to, the card
 * collapses into the very chip it is about to become (`DragCapsule.tsx`), leaving a quiet
 * silhouette where it came from. Everywhere else the drag is exactly what it always was.
 *
 * The timing rules themselves are covered directly in `tests/capsule-collapse.test.ts` and the
 * nearest-connector arithmetic in `tests/edge-nearest.test.ts`; these cover what actually happens
 * on a canvas under a real pointer.
 */

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
  if (tool === 'Note') await page.keyboard.press('Escape');
}

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

/** Presses on a node's centre and moves to a point, leaving the pointer down. */
async function grabAndMoveTo(page: Page, node: ReturnType<Page['locator']>, to: { x: number; y: number }) {
  const box = (await node.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 15 });
  return box;
}

const capsule = (page: Page) => page.locator('.dc-drag-capsule');

test.describe('drag capsule', () => {
  test('a card moved across open canvas keeps its full geometry — the capsule is for attaching', async ({
    page,
  }) => {
    await newCanvas(page, 'Capsule open canvas');
    await create(page, 'Note', { x: 300, y: 250 });
    const note = page.locator('.dc-node[data-type="note"]');

    const before = await grabAndMoveTo(page, note, { x: 760, y: 560 });
    // Nothing to attach to anywhere along the way, so the card stays itself and its alignment
    // guides stay meaningful.
    await expect(capsule(page)).toHaveCount(0);
    await expect(note).toBeVisible();
    await page.mouse.up();

    // ...and the free move still lands, exactly as it always did.
    const after = (await note.boundingBox())!;
    expect(Math.abs(after.x - before.x)).toBeGreaterThan(100);
  });

  test('reaching a shape collapses the card into its own chip', async ({ page }) => {
    await newCanvas(page, 'Capsule over shape');
    await create(page, 'Service', { x: 350, y: 300 });
    await create(page, 'Note', { x: 800, y: 300 });

    const note = page.locator('.dc-node[data-type="note"]');
    const serviceBox = (await page.locator('.dc-node[data-type="service"]').boundingBox())!;
    await grabAndMoveTo(page, note, {
      x: serviceBox.x + serviceBox.width / 2,
      y: serviceBox.y + serviceBox.height / 2,
    });

    await expect(capsule(page)).toHaveCount(1);
    // The capsule says what it is — the same label the chip will carry once it lands.
    await expect(capsule(page)).toContainText('NOTE');

    // Arming is still the deliberate dwell, and dropping still attaches.
    await expect(page.locator('.dc-node[data-attach-target="true"]')).toHaveCount(1);
    await page.mouse.up();
    await expect(capsule(page)).toHaveCount(0);
    await expect(page.locator('.dc-attachment-badge')).toContainText('1');
  });

  test('a Code card carries its language, not a generic label', async ({ page }) => {
    await newCanvas(page, 'Capsule code label');
    await create(page, 'Service', { x: 350, y: 300 });
    await create(page, 'Code', { x: 850, y: 300 });

    const serviceBox = (await page.locator('.dc-node[data-type="service"]').boundingBox())!;
    await grabAndMoveTo(page, page.locator('.dc-node[data-type="code"]'), {
      x: serviceBox.x + serviceBox.width / 2,
      y: serviceBox.y + serviceBox.height / 2,
    });

    await expect(capsule(page)).toHaveCount(1);
    // A new Code card is JSON, and the capsule says so rather than "CODE" — the same label its
    // chip carries once attached.
    await expect(capsule(page)).toContainText('JSON');
    await page.mouse.up();
  });

  test('a connector is reachable in one straight drag, and says where the note will land', async ({
    page,
  }) => {
    await newCanvas(page, 'Capsule onto connector');
    await create(page, 'Service', { x: 300, y: 300 });
    await create(page, 'Queue', { x: 1000, y: 300 });
    await connect(page, 0, 1);
    await create(page, 'Note', { x: 640, y: 600 });

    const midpoint = await page.locator('.dc-edge-line').first().evaluate((path: SVGPathElement) => {
      const point = path.getPointAtLength(path.getTotalLength() / 2);
      const screen = point.matrixTransform(path.getScreenCTM()!);
      return { x: screen.x, y: screen.y };
    });

    // One straight move, no spiral and no retry — which is the whole point of the widened
    // corridor. `edge-attachments.spec.ts`'s own helper still nudges around the target because it
    // predates this.
    await grabAndMoveTo(page, page.locator('.dc-node[data-type="note"]'), midpoint);

    await expect(capsule(page)).toHaveCount(1);
    await expect(page.locator('.dc-edge[data-attach-target="true"]')).toHaveCount(1);
    // A single dot on the line, at the exact point the chip will appear.
    await expect(page.locator('.dc-edge-landing')).toHaveCount(1);

    await page.mouse.up();
    await expect(page.locator('.dc-node[data-type="note"]')).toHaveCount(0);
    await expect(page.locator('.dc-attachment-chip')).toHaveCount(1);
    // No mark left on the connector once the gesture is over.
    await expect(page.locator('.dc-edge-landing')).toHaveCount(0);
  });

  test('Escape puts the card back and commits nothing at all', async ({ page }) => {
    await newCanvas(page, 'Capsule escape');
    await create(page, 'Service', { x: 350, y: 300 });
    await create(page, 'Note', { x: 800, y: 300 });

    const note = page.locator('.dc-node[data-type="note"]');
    const serviceBox = (await page.locator('.dc-node[data-type="service"]').boundingBox())!;
    const before = await grabAndMoveTo(page, note, {
      x: serviceBox.x + serviceBox.width / 2,
      y: serviceBox.y + serviceBox.height / 2,
    });
    await expect(page.locator('.dc-node[data-attach-target="true"]')).toHaveCount(1);

    await page.keyboard.press('Escape');
    // Everything the gesture put on screen is gone the moment it is cancelled.
    await expect(capsule(page)).toHaveCount(0);
    await expect(page.locator('.dc-node[data-attach-target="true"]')).toHaveCount(0);
    await page.mouse.up();

    // The card is back where it started, still a card, and nothing was attached.
    await expect(note).toHaveCount(1);
    await expect(page.locator('.dc-attachment-badge')).toHaveCount(0);
    const after = (await note.boundingBox())!;
    expect(Math.round(after.x)).toBe(Math.round(before.x));
    expect(Math.round(after.y)).toBe(Math.round(before.y));

    // And no history entry: undo reaches past the cancelled drag to the note's own creation.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('.dc-node[data-type="note"]')).toHaveCount(0);
  });

  test('Escape puts every shape of a multi-selection back, keeps it selected, and commits nothing', async ({
    page,
  }) => {
    await newCanvas(page, 'Escape multi');
    await create(page, 'Service', { x: 350, y: 300 });
    await create(page, 'Data Store', { x: 650, y: 300 });
    await page.keyboard.press('ControlOrMeta+a');
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(2);

    const first = page.locator('.dc-node').nth(0);
    const second = page.locator('.dc-node').nth(1);
    const beforeFirst = (await first.boundingBox())!;
    const beforeSecond = (await second.boundingBox())!;
    await grabAndMoveTo(page, first, { x: beforeFirst.x + 320, y: beforeFirst.y + 240 });
    // Mid-gesture the whole selection has really moved.
    expect(Math.abs((await second.boundingBox())!.x - beforeSecond.x)).toBeGreaterThan(100);

    await page.keyboard.press('Escape');
    await page.mouse.up();

    for (const [node, before] of [
      [first, beforeFirst],
      [second, beforeSecond],
    ] as const) {
      const after = (await node.boundingBox())!;
      expect(Math.round(after.x)).toBe(Math.round(before.x));
      expect(Math.round(after.y)).toBe(Math.round(before.y));
    }
    // Escape meant "cancel the drag", not "and also deselect".
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(2);

    // Nothing was written: undo reaches past the cancelled drag to the second shape's creation.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('.dc-node')).toHaveCount(1);
  });

  test('the window losing focus mid-drag puts the shape back instead of dropping it wherever it is', async ({
    page,
  }) => {
    await newCanvas(page, 'Blur mid-drag');
    await create(page, 'Service', { x: 350, y: 300 });
    const node = page.locator('.dc-node').first();
    const before = await grabAndMoveTo(page, node, { x: 720, y: 500 });

    // Cmd-Tab away: the release will go to another window, so the drag never gets its own ending.
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.up();

    const after = (await node.boundingBox())!;
    expect(Math.round(after.x)).toBe(Math.round(before.x));
    expect(Math.round(after.y)).toBe(Math.round(before.y));
    // Nothing was written, and the keyboard is the app's again: undo reaches the shape's creation.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('.dc-node')).toHaveCount(0);
  });

  test('Escape puts a dragged boundary back with everything nested inside it', async ({ page }) => {
    await newCanvas(page, 'Escape boundary');
    await create(page, 'Service', { x: 350, y: 300 });
    await create(page, 'Data Store', { x: 650, y: 300 });
    await page.keyboard.press('ControlOrMeta+a');
    await page.getByRole('button', { name: 'Group', exact: true }).click();

    const boundary = page.locator('.dc-node[data-type="group"]');
    const children = page.locator('.dc-node:not([data-type="group"])');
    await expect(boundary).toHaveCount(1);
    await expect(children).toHaveCount(2);
    const boundaryBefore = (await boundary.boundingBox())!;
    const childrenBefore = [(await children.nth(0).boundingBox())!, (await children.nth(1).boundingBox())!];

    // The boundary's own padding, clear of any child — the grip a real drag of it uses.
    await page.mouse.move(boundaryBefore.x + 8, boundaryBefore.y + 8);
    await page.mouse.down();
    await page.mouse.move(boundaryBefore.x + 8 + 260, boundaryBefore.y + 8 + 160, { steps: 15 });
    expect(Math.abs((await children.nth(0).boundingBox())!.x - childrenBefore[0]!.x)).toBeGreaterThan(100);

    await page.keyboard.press('Escape');
    await page.mouse.up();

    const boundaryAfter = (await boundary.boundingBox())!;
    expect(Math.round(boundaryAfter.x)).toBe(Math.round(boundaryBefore.x));
    expect(Math.round(boundaryAfter.y)).toBe(Math.round(boundaryBefore.y));
    for (let i = 0; i < 2; i += 1) {
      const after = (await children.nth(i).boundingBox())!;
      expect(Math.round(after.x)).toBe(Math.round(childrenBefore[i]!.x));
      expect(Math.round(after.y)).toBe(Math.round(childrenBefore[i]!.y));
    }

    // No history entry: the last thing undo can reach is the grouping itself.
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('.dc-node[data-type="group"]')).toHaveCount(0);
    await expect(children).toHaveCount(2);
  });
});
