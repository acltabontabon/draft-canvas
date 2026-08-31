import { expect, test, type Page } from '@playwright/test';

/**
 * Connection-attached details: dragging an existing Note/Code node onto a connector folds it into
 * that connector's attachment (mirroring `attachments.spec.ts`'s node-onto-node drag), and the
 * resulting chip/card reveal (`EdgeAttachmentRow`/`EdgeAttachmentChip` in `DraftEdgeView.tsx`).
 * The data model, persistence, and reconnection guarantees are covered directly in
 * `tests/edge-attachments.test.ts`; these cover the actual drag/click interaction and the
 * type-matched visual result.
 *
 * A card is visible only when its own chip is clicked (`pinned`, or `presentationReveal` while
 * presenting) — deliberately not on hover and not just because the connector itself is selected,
 * per `EdgeAttachmentChip`'s own doc comment: either read as noisy on a diagram with several
 * attachments. A pinned card also opens read-only first; a second click on its own pencil glyph
 * ("Edit attached detail") is what reveals the actual textarea.
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

/**
 * The connector's own true midpoint — read from the actual rendered SVG path (via
 * `getPointAtLength`/`getScreenCTM`), not guessed by averaging the two nodes' own boxes the way
 * `editing.spec.ts`/`connector-semantics.spec.ts` do for a plain "click somewhere on the line" —
 * this one needs to be precise enough to drop a dragged node onto, and `smoothstep` routing can
 * bend through an intermediate run far from that naive average once the two nodes have noticeably
 * different heights (as a Service→Queue pair now does). The node indices are accepted only so
 * every existing call site stays unchanged; there is always exactly one connector in these tests.
 */
async function edgeMidpoint(page: Page, _nodeAIndex: number, _nodeBIndex: number) {
  return page.locator('.dc-edge-line').first().evaluate((path: SVGPathElement) => {
    const point = path.getPointAtLength(path.getTotalLength() / 2);
    const screenPoint = point.matrixTransform(path.getScreenCTM()!);
    return { x: screenPoint.x, y: screenPoint.y };
  });
}

/**
 * Drags a node by its center onto a point, in one smooth gesture — mirrors
 * `attachments.spec.ts`'s `dragNodeCenterTo`, reused here for dropping onto a connector instead
 * of another node.
 *
 * React Flow's own drag-position bookkeeping can occasionally land a few pixels off from the
 * pointer's true screen position by the time a synthetic, multi-step Playwright drag ends — a
 * live-drag timing artifact, not anything this app computes wrong (`Canvas.tsx`'s own
 * `onNodesChange` already guards against the one reproducible cause found here: a stale
 * drag-end frame overwriting a just-armed target). A single connector's `interactionWidth` hit
 * corridor is narrow enough that a straight-line drag can still occasionally land just outside
 * it, so this nudges in a small spiral around the intended point before releasing, and retries
 * the whole grab-drag-release gesture a few times — the node stays a plain, re-draggable
 * standalone node on a failed attempt — rather than trusting a single try.
 */
async function dragNodeCenterTo(page: Page, node: ReturnType<Page['locator']>, target: { x: number; y: number }) {
  const armed = () => page.locator('.dc-edge[data-attach-target="true"]').count();
  const nudges: [number, number][] = [
    [0, 0],
    [0, -8],
    [0, 8],
    [-8, 0],
    [8, 0],
    [0, -16],
    [0, 16],
    [-16, 0],
    [16, 0],
  ];

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const box = (await node.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x, target.y, { steps: 15 });
    for (const [dx, dy] of nudges) {
      if (await armed()) break;
      await page.mouse.move(target.x + dx, target.y + dy, { steps: 3 });
    }
    await page.mouse.up();
    if ((await node.count()) === 0) return; // Folded into the connector's attachment.
  }
}

async function servicePublishingToTopic(page: Page, title: string) {
  await newCanvas(page, title);
  await create(page, 'Service', { x: 300, y: 300 });
  // Far enough from Service that a dropped Code card (380px wide by default)
  // can sit centred on the connector between them without its own rect
  // overlapping either node — which would arm a node-attach instead of an
  // edge-attach, folding it into the wrong node entirely.
  await create(page, 'Queue', { x: 1000, y: 300 });
  await connect(page, 0, 1);
}

/** Pins a chip open (read-only) and clicks through to its editable textarea —
 *  the two deliberate steps a real edit now takes, see the file doc comment. */
async function openForEditing(page: Page, chip: ReturnType<Page['locator']>) {
  await chip.click();
  await page.getByRole('button', { name: 'Edit attached detail' }).click();
  return page.locator('.dc-attachment-card textarea');
}

test.describe('connection-attached details', () => {
  test('dragging a Note onto a connector attaches it, styled like a real note card', async ({ page }) => {
    await servicePublishingToTopic(page, 'Drag note onto connector');
    await create(page, 'Note', { x: 500, y: 500 });
    const note = page.locator('.dc-node[data-type="note"]');
    await note.dblclick();
    await page.keyboard.type('APPLICATION_STATUS_UPDATED');
    await page.locator('.react-flow__pane').click({ position: { x: 100, y: 100 } });

    const target = await edgeMidpoint(page, 0, 1);
    await dragNodeCenterTo(page, note, target);

    // The standalone node is gone — it became the connector's own attachment.
    await expect(page.locator('.dc-node[data-type="note"]')).toHaveCount(0);

    const chip = page.locator('.dc-attachment-chip');
    await expect(chip).toHaveCount(1);
    await expect(chip).toHaveText('NOTE');
    await expect(chip).toHaveAttribute('data-kind', 'note');

    // Preserves the note's own amber styling, not a generic box.
    const fill = await chip.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(fill).not.toBe('rgba(0, 0, 0, 0)');
  });

  test('dragging a Code node onto a connector attaches it as a syntax-highlighted card', async ({ page }) => {
    await servicePublishingToTopic(page, 'Drag code onto connector');
    await create(page, 'Code', { x: 500, y: 500 });
    const code = page.locator('.dc-node[data-type="code"]');

    const target = await edgeMidpoint(page, 0, 1);
    await dragNodeCenterTo(page, code, target);

    await expect(page.locator('.dc-node[data-type="code"]')).toHaveCount(0);
    const chip = page.locator('.dc-attachment-chip[data-kind="code"]');
    await expect(chip).toHaveCount(1);

    // A click pins the card open, read-only — exactly the view this test checks.
    await chip.click();
    const card = page.locator('.dc-attachment-card');
    await expect(card).toBeVisible();
    // The default JSON sample (`{ "accountId": "123", "status": "CANCELLED" }`) is four lines.
    await expect(card.locator('.dc-code-line')).toHaveCount(4);
    await expect(card).toContainText('accountId');
  });

  test('several attachments render as separate chips, each independently revealable', async ({ page }) => {
    await servicePublishingToTopic(page, 'Multiple attachments');
    await create(page, 'Note', { x: 500, y: 500 });
    await dragNodeCenterTo(page, page.locator('.dc-node[data-type="note"]'), await edgeMidpoint(page, 0, 1));

    await create(page, 'Code', { x: 500, y: 500 });
    await dragNodeCenterTo(page, page.locator('.dc-node[data-type="code"]'), await edgeMidpoint(page, 0, 1));

    const chips = page.locator('.dc-attachment-chip');
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toHaveAttribute('data-kind', 'note');
    await expect(chips.nth(1)).toHaveAttribute('data-kind', 'code');

    // Clicking one reveals only its own card.
    await chips.nth(1).click();
    await expect(page.locator('.dc-attachment-card')).toHaveCount(1);
  });

  test('clicking a chip pins its card open read-only; the pencil glyph is what reveals editing', async ({
    page,
  }) => {
    await servicePublishingToTopic(page, 'Pin and edit');
    await create(page, 'Note', { x: 500, y: 500 });
    await dragNodeCenterTo(page, page.locator('.dc-node[data-type="note"]'), await edgeMidpoint(page, 0, 1));

    const chip = page.locator('.dc-attachment-chip');
    await chip.click();
    const card = page.locator('.dc-attachment-card');
    await expect(card).toBeVisible();
    await expect(card.locator('textarea')).toHaveCount(0);

    // Already pinned open from the click above — a second click on the chip
    // now correctly toggles it *closed* (see the regression test further
    // down), so only the pencil glyph itself is clicked here, not the full
    // `openForEditing` helper (which assumes a not-yet-open chip).
    await page.getByRole('button', { name: 'Edit attached detail' }).click();
    const textarea = page.locator('.dc-attachment-card textarea');
    await expect(textarea).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete attached detail' })).toBeVisible();

    await textarea.fill('Mixed Case Value');
    // Escape closes the card without ever blurring the textarea — this is the exact commit path
    // that regressed once already (see `tests/edge-attachments.test.ts`'s history and the memory
    // note on it): the value must be tracked live via `onChange`, not committed on blur.
    await page.keyboard.press('Escape');

    await chip.click();
    const note = page.locator('.dc-attachment-note');
    await expect(note).toHaveText('Mixed Case Value');
    const transform = await note.evaluate((el) => getComputedStyle(el).textTransform);
    expect(transform).toBe('none');
  });

  test('typing then clicking outside the card commits the edit, not discards it', async ({ page }) => {
    await servicePublishingToTopic(page, 'Outside click commits');
    await create(page, 'Note', { x: 500, y: 500 });
    await dragNodeCenterTo(page, page.locator('.dc-node[data-type="note"]'), await edgeMidpoint(page, 0, 1));

    const chip = page.locator('.dc-attachment-chip');
    const textarea = await openForEditing(page, chip);
    await textarea.pressSequentially('kept via outside click');
    await page.locator('.react-flow__pane').click({ position: { x: 100, y: 500 } });

    await chip.click();
    await expect(page.locator('.dc-attachment-note')).toHaveText('kept via outside click');
  });

  test('Escape closes an open chip\'s card', async ({ page }) => {
    await servicePublishingToTopic(page, 'Escape closes');
    await create(page, 'Note', { x: 500, y: 500 });
    await dragNodeCenterTo(page, page.locator('.dc-node[data-type="note"]'), await edgeMidpoint(page, 0, 1));

    const chip = page.locator('.dc-attachment-chip');
    await chip.click();
    const card = page.locator('.dc-attachment-card');
    await expect(card).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);
  });

  test('clicking an open chip again closes its card', async ({ page }) => {
    // Regression test: the outside-pointerdown-close listener used to check
    // only against the card (`cardRef`), so a pointerdown on the chip's own
    // label — genuinely outside the card — closed it first; then the click
    // phase's own `togglePin()` reopened it from a `pinned` closure captured
    // before that close landed, netting a no-op. Fixed by checking against
    // the whole chip (`chipRef`) instead, so a click on the chip itself is
    // `onClick`'s job alone.
    await servicePublishingToTopic(page, 'Toggle closed');
    await create(page, 'Note', { x: 500, y: 500 });
    await dragNodeCenterTo(page, page.locator('.dc-node[data-type="note"]'), await edgeMidpoint(page, 0, 1));

    const chip = page.locator('.dc-attachment-chip');
    await chip.click();
    const card = page.locator('.dc-attachment-card');
    await expect(card).toBeVisible();

    // The chip's own label span specifically, not a raw offset into the
    // chip's outer box — once open, that box also contains the card (a DOM
    // child positioned off it, per `EdgeAttachmentChip`'s own comment).
    await page.locator('.dc-attachment-chip-label').click();
    await expect(card).toHaveCount(0);
  });

  test('selecting the connection alone does not reveal any attachment card', async ({ page }) => {
    // A card popping open just because the connector got selected read as noisy on a diagram
    // with several attachments — see `EdgeAttachmentChip`'s own doc comment. Only a click on a
    // specific chip pins that one card open now.
    await servicePublishingToTopic(page, 'Selection does not reveal');
    await create(page, 'Note', { x: 500, y: 500 });
    await dragNodeCenterTo(page, page.locator('.dc-node[data-type="note"]'), await edgeMidpoint(page, 0, 1));

    const target = await edgeMidpoint(page, 0, 1);
    await page.mouse.click(target.x, target.y);

    await expect(page.locator('.dc-attachment-card')).toHaveCount(0);
  });

  test('presentation mode reveals a chip\'s card on click, with no editing available', async ({ page }) => {
    await servicePublishingToTopic(page, 'Presentation reveal');
    await create(page, 'Note', { x: 500, y: 500 });
    const chip = page.locator('.dc-attachment-chip');
    await dragNodeCenterTo(page, page.locator('.dc-node[data-type="note"]'), await edgeMidpoint(page, 0, 1));
    const textarea = await openForEditing(page, chip);
    await textarea.fill('present me');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Present (Cmd+Enter)' }).click();
    await expect(page.getByRole('button', { name: 'Exit presentation' })).toBeVisible();

    await expect(chip).toBeVisible();
    await chip.click();
    const card = page.locator('.dc-attachment-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('present me');
    await expect(card.locator('textarea')).toHaveCount(0);
    // Presenting never unlocks editing — the pencil glyph itself is gone, not just its textarea.
    await expect(page.getByRole('button', { name: 'Edit attached detail' })).toHaveCount(0);
  });

  test('deleting the connection removes its attachments, and undo restores them together', async ({ page }) => {
    await servicePublishingToTopic(page, 'Delete cascades');
    await create(page, 'Note', { x: 500, y: 500 });
    await dragNodeCenterTo(page, page.locator('.dc-node[data-type="note"]'), await edgeMidpoint(page, 0, 1));

    const target = await edgeMidpoint(page, 0, 1);
    await page.mouse.click(target.x, target.y);
    await page.keyboard.press('Backspace');
    await expect(page.locator('.dc-edge')).toHaveCount(0);

    await page.keyboard.press('Meta+z');
    await expect(page.locator('.dc-edge')).toHaveCount(1);
    await expect(page.locator('.dc-attachment-chip')).toHaveCount(1);
  });

  test('the card\'s own Delete button removes just that attachment', async ({ page }) => {
    await servicePublishingToTopic(page, 'Delete one attachment');
    await create(page, 'Note', { x: 500, y: 500 });
    await dragNodeCenterTo(page, page.locator('.dc-node[data-type="note"]'), await edgeMidpoint(page, 0, 1));

    await page.locator('.dc-attachment-chip').click();
    await page.getByRole('button', { name: 'Delete attached detail' }).click();

    await expect(page.locator('.dc-attachment-chip')).toHaveCount(0);
    await expect(page.locator('.dc-edge')).toHaveCount(1);
  });
});
