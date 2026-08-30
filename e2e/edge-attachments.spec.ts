import { expect, test, type Page } from '@playwright/test';

/**
 * Connection-attached details: dragging an existing Note/Code node onto a connector folds it into
 * that connector's attachment (mirroring `attachments.spec.ts`'s node-onto-node drag), and the
 * resulting chip/card reveal (`EdgeAttachmentRow`/`EdgeAttachmentChip` in `DraftEdgeView.tsx`).
 * The data model, persistence, and reconnection guarantees are covered directly in
 * `tests/edge-attachments.test.ts`; these cover the actual drag/hover/pin interaction and the
 * type-matched visual result.
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

/** The connector's own midpoint — the same pattern `editing.spec.ts` and
 *  `connector-semantics.spec.ts` use to select or reconnect a specific edge, and here, to drop an
 *  attachable node precisely onto the connector's hit corridor. */
async function edgeMidpoint(page: Page, nodeAIndex: number, nodeBIndex: number) {
  const nodeA = (await page.locator('.dc-node').nth(nodeAIndex).boundingBox())!;
  const nodeB = (await page.locator('.dc-node').nth(nodeBIndex).boundingBox())!;
  return {
    x: (nodeA.x + nodeA.width + nodeB.x) / 2,
    y: (nodeA.y + nodeA.height / 2 + nodeB.y + nodeB.height / 2) / 2,
  };
}

/** Drags a node by its center onto a point, in one smooth gesture — mirrors
 *  `attachments.spec.ts`'s `dragNodeCenterTo`, reused here for dropping onto a connector instead
 *  of another node. */
async function dragNodeCenterTo(page: Page, node: ReturnType<Page['locator']>, target: { x: number; y: number }) {
  const box = (await node.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 15 });
  await page.mouse.up();
}

async function servicePublishingToTopic(page: Page, title: string) {
  await newCanvas(page, title);
  await create(page, 'Service', { x: 300, y: 300 });
  await create(page, 'Queue', { x: 700, y: 300 });
  await connect(page, 0, 1);
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

    const chip = page.locator('.dc-edge-attachment-chip');
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
    const chip = page.locator('.dc-edge-attachment-chip[data-kind="code"]');
    await expect(chip).toHaveCount(1);

    await chip.hover();
    const card = page.locator('.dc-edge-attachment-card');
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

    const chips = page.locator('.dc-edge-attachment-chip');
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toHaveAttribute('data-kind', 'note');
    await expect(chips.nth(1)).toHaveAttribute('data-kind', 'code');

    // Hovering one reveals only its own card.
    await chips.nth(1).hover();
    await expect(page.locator('.dc-edge-attachment-card')).toHaveCount(1);
  });

  test('clicking a chip pins its card open for editing, preserving case (not forced uppercase)', async ({
    page,
  }) => {
    await servicePublishingToTopic(page, 'Pin and edit');
    await create(page, 'Note', { x: 500, y: 500 });
    await dragNodeCenterTo(page, page.locator('.dc-node[data-type="note"]'), await edgeMidpoint(page, 0, 1));

    const chip = page.locator('.dc-edge-attachment-chip');
    await chip.click();
    const textarea = page.locator('.dc-edge-attachment-card textarea');
    await expect(textarea).toBeVisible();
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();

    await textarea.fill('Mixed Case Value');
    // Escape closes the card without ever blurring the textarea — this is the exact commit path
    // that regressed once already (see `tests/edge-attachments.test.ts`'s history and the memory
    // note on it): the value must be tracked live via `onChange`, not committed on blur.
    await page.keyboard.press('Escape');

    const note = page.locator('.dc-edge-attachment-note');
    await expect(note).toHaveText('Mixed Case Value');
    const transform = await note.evaluate((el) => getComputedStyle(el).textTransform);
    expect(transform).toBe('none');
  });

  test('typing then clicking outside the card commits the edit, not discards it', async ({ page }) => {
    await servicePublishingToTopic(page, 'Outside click commits');
    await create(page, 'Note', { x: 500, y: 500 });
    await dragNodeCenterTo(page, page.locator('.dc-node[data-type="note"]'), await edgeMidpoint(page, 0, 1));

    await page.locator('.dc-edge-attachment-chip').click();
    await page.locator('.dc-edge-attachment-card textarea').pressSequentially('kept via outside click');
    await page.locator('.react-flow__pane').click({ position: { x: 100, y: 500 } });

    await page.locator('.dc-edge-attachment-chip').hover();
    await expect(page.locator('.dc-edge-attachment-note')).toHaveText('kept via outside click');
  });

  test('moving from the chip into its card keeps it open; leaving both closes it', async ({ page }) => {
    await servicePublishingToTopic(page, 'Hover stability');
    await create(page, 'Note', { x: 500, y: 500 });
    await dragNodeCenterTo(page, page.locator('.dc-node[data-type="note"]'), await edgeMidpoint(page, 0, 1));

    const chip = page.locator('.dc-edge-attachment-chip');
    await chip.hover();
    const card = page.locator('.dc-edge-attachment-card');
    await expect(card).toBeVisible();

    const box = (await card.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(150);
    await expect(card).toBeVisible();

    await page.mouse.move(100, 500);
    await expect(card).toHaveCount(0, { timeout: 1000 });
  });

  test('selecting the connection reveals the chip row\'s cards without hovering', async ({ page }) => {
    await servicePublishingToTopic(page, 'Selection reveal');
    await create(page, 'Note', { x: 500, y: 500 });
    await dragNodeCenterTo(page, page.locator('.dc-node[data-type="note"]'), await edgeMidpoint(page, 0, 1));

    const target = await edgeMidpoint(page, 0, 1);
    await page.mouse.click(target.x, target.y);

    const card = page.locator('.dc-edge-attachment-card');
    await expect(card).toBeVisible();
    await expect(card.locator('textarea')).toHaveCount(0);
  });

  test('presentation mode reveals a chip\'s card on hover with no editing available', async ({ page }) => {
    await servicePublishingToTopic(page, 'Presentation reveal');
    await create(page, 'Note', { x: 500, y: 500 });
    await dragNodeCenterTo(page, page.locator('.dc-node[data-type="note"]'), await edgeMidpoint(page, 0, 1));
    await page.locator('.dc-edge-attachment-chip').click();
    await page.locator('.dc-edge-attachment-card textarea').fill('present me');
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Present (Cmd+Enter)' }).click();
    await expect(page.getByRole('button', { name: 'Exit presentation' })).toBeVisible();

    const chip = page.locator('.dc-edge-attachment-chip');
    await expect(chip).toBeVisible();
    await chip.hover();
    const card = page.locator('.dc-edge-attachment-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('present me');
    await expect(card.locator('textarea')).toHaveCount(0);
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
    await expect(page.locator('.dc-edge-attachment-chip')).toHaveCount(1);
  });

  test('the card\'s own Delete button removes just that attachment', async ({ page }) => {
    await servicePublishingToTopic(page, 'Delete one attachment');
    await create(page, 'Note', { x: 500, y: 500 });
    await dragNodeCenterTo(page, page.locator('.dc-node[data-type="note"]'), await edgeMidpoint(page, 0, 1));

    await page.locator('.dc-edge-attachment-chip').click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();

    await expect(page.locator('.dc-edge-attachment-chip')).toHaveCount(0);
    await expect(page.locator('.dc-edge')).toHaveCount(1);
  });
});
