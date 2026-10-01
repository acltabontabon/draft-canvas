import { expect, test, type Page } from '@playwright/test';
import { afterDropGuard, create, newCanvas, nextFrames, reopenAfterReload } from './canvas';

/** Node attachments: drag-to-attach arming, the badge opening a connector-style chip row/card
 *  (`AttachmentPresentation.tsx`, shared with `DraftEdgeView.tsx`), detach, delete. */

/** Drags a node by its center to a new center point. With `dwell`, holds there until the target
 *  under the pointer has armed — the dwell is a timer in `Canvas.tsx` (`ATTACH_DWELL_MS`), and the
 *  armed target is its one visible effect, so that is what is waited for rather than its length. */
async function dragNodeCenterTo(
  page: Page,
  node: ReturnType<Page['locator']>,
  target: { x: number; y: number },
  options: { dwell?: boolean; steps?: number } = {},
) {
  const box = (await node.boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: options.steps ?? 15 });
  if (options.dwell) await expect(page.locator('.dc-node[data-attach-target="true"]')).toHaveCount(1);
  return async () => {
    await page.mouse.up();
    await afterDropGuard(page);
  };
}

test.describe('attachments', () => {
  test('a low-overlap, brief pass-over does not attach — it is a plain move', async ({ page }) => {
    await newCanvas(page, 'Attach no-arm');
    await create(page, 'Service', { x: 300, y: 300 });
    await create(page, 'Note', { x: 700, y: 300 });

    const note = page.locator('.dc-node[data-type="note"]');
    const service = page.locator('.dc-node[data-type="service"]');
    const serviceBox = (await service.boundingBox())!;

    // Clip only the note's corner across the service's edge — low overlap,
    // and release immediately (no dwell).
    const release = await dragNodeCenterTo(page, note, {
      x: serviceBox.x + serviceBox.width - 4,
      y: serviceBox.y + serviceBox.height - 4,
    });
    await release();

    await expect(page.locator('.dc-attachment-badge')).toHaveCount(0);
    await expect(page.locator('.dc-node')).toHaveCount(2);
  });

  test('a large attachable node dropped fully onto a small target arms and attaches instantly', async ({ page }) => {
    await newCanvas(page, 'Attach large onto small');
    await create(page, 'Service', { x: 300, y: 300 });
    await create(page, 'Code', { x: 700, y: 300 });

    const service = page.locator('.dc-node[data-type="service"]');
    const code = page.locator('.dc-node[data-type="code"]');
    const serviceBox = (await service.boundingBox())!;
    const serviceCenter = { x: serviceBox.x + serviceBox.width / 2, y: serviceBox.y + serviceBox.height / 2 };

    const release = await dragNodeCenterTo(page, code, serviceCenter);
    // The affordance should already be showing before release, and the
    // target should read as armed, with no dwell required for this overlap.
    await expect(page.locator('.dc-attach-affordance')).toBeVisible();
    await expect(page.locator('.dc-node[data-attach-target="true"]')).toHaveCount(1);
    await release();

    await expect(page.locator('.dc-node[data-type="code"]')).toHaveCount(0);
    await expect(page.locator('.dc-attachment-badge')).toHaveCount(1);
    await expect(page.locator('.dc-attachment-badge')).toContainText('1');
    await expect(page.locator('.dc-node')).toHaveCount(1);
  });

  test('a small attachable node dropped fully onto a large target arms and attaches instantly', async ({ page }) => {
    await newCanvas(page, 'Attach small onto large');
    await create(page, 'Note', { x: 300, y: 300 });
    await create(page, 'Text', { x: 700, y: 300 });

    // Resize the target node up considerably so the dragged text node is the
    // smaller of the two areas.
    const target = page.locator('.dc-node').first();
    await target.click();
    const handles = page.locator('.dc-resize-handle');
    const corner = (await handles.nth(3).boundingBox())!;
    await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
    await page.mouse.down();
    await page.mouse.move(corner.x + 260, corner.y + 220, { steps: 12 });
    await nextFrames(page);
    await page.mouse.up();

    const targetBox = (await target.boundingBox())!;
    const targetCenter = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + targetBox.height / 2 };

    const textNode = page.locator('.dc-node[data-type="text"]');
    const release = await dragNodeCenterTo(page, textNode, targetCenter);
    await expect(page.locator('.dc-attach-affordance')).toBeVisible();
    await release();

    await expect(page.locator('.dc-node[data-type="text"]')).toHaveCount(0);
    await expect(page.locator('.dc-attachment-badge')).toContainText('1');
  });

  test('a low-overlap hold arms via dwell, not overlap', async ({ page }) => {
    await newCanvas(page, 'Attach dwell');
    await create(page, 'Service', { x: 300, y: 300 });
    // Same default footprint as the target (176×68), which keeps the overlap
    // arithmetic simple and symmetric.
    await create(page, 'Note', { x: 700, y: 300 });

    const note = page.locator('.dc-node[data-type="note"]');
    const service = page.locator('.dc-node[data-type="service"]');
    const serviceBox = (await service.boundingBox())!;

    // Offset the note's centre 110px in from the target's left edge (same
    // width, so this leaves ~37% area overlap — comfortably under the 65%
    // instant-arm threshold) and well clear of SNAP_THRESHOLD (6px) around
    // any of the target's edges or centre, so alignment snapping cannot pull
    // the drop point somewhere this test didn't intend.
    const dwellPoint = { x: serviceBox.x + 110, y: serviceBox.y + serviceBox.height / 2 };

    const release = await dragNodeCenterTo(page, note, dwellPoint, { dwell: true });
    await expect(page.locator('.dc-node[data-attach-target="true"]')).toHaveCount(1);
    await release();

    await expect(page.locator('.dc-node[data-type="note"]')).toHaveCount(0);
    await expect(page.locator('.dc-attachment-badge')).toContainText('1');
  });

  test('opens the badge into a chip row, edits via its card, detaches with original size preserved, and deletes with undo', async ({
    page,
  }) => {
    await newCanvas(page, 'Attach popover');
    await create(page, 'Service', { x: 350, y: 320 });
    await create(page, 'Code', { x: 750, y: 320 });

    const service = page.locator('.dc-node[data-type="service"]');
    const code = page.locator('.dc-node[data-type="code"]');
    const codeBoxBefore = (await code.boundingBox())!;
    const serviceBox = (await service.boundingBox())!;
    const serviceCenter = { x: serviceBox.x + serviceBox.width / 2, y: serviceBox.y + serviceBox.height / 2 };

    const release = await dragNodeCenterTo(page, code, serviceCenter);
    // Same wait every other full-overlap attach test in this file does before releasing — the
    // instant-arm path is still set on the drag's last frame (`Canvas.tsx`'s `onNodesChange`),
    // which can land via `requestAnimationFrame` slightly after the synthetic move resolves.
    // Releasing before the armed affordance is visible races that frame.
    await expect(page.locator('.dc-node[data-attach-target="true"]')).toHaveCount(1);
    await release();
    await expect(page.locator('.dc-attachment-badge')).toHaveCount(1);

    // Badge click reveals the (connector-style) chip row, matching a connector's own attachments —
    // not the old always-expanded list popover.
    await page.locator('.dc-attachment-badge').click();
    const chip = page.locator('.dc-attachment-chip');
    await expect(chip).toHaveCount(1);

    // Chip click pins its card open read-only first.
    await chip.click();
    const card = page.locator('.dc-attachment-card');
    await expect(card).toBeVisible();
    await expect(card.locator('.dc-attachment-code')).toBeVisible();

    // The pencil glyph is what reveals editing — same as a connector attachment's card.
    await card.getByRole('button', { name: 'Edit attached detail' }).click();
    const editor = card.locator('.dc-attachment-editor-code');
    await editor.fill('const attached = true;');
    // Commit via outside click, not blur — the ref-based commit-on-close pattern shared with
    // connector attachments. This closes the whole popover (row + card), not just the card, since
    // a node has no intermediate "row open, nothing pinned" state to fall back to.
    await page.mouse.click(60, 60);
    await expect(card).toHaveCount(0);

    // Reopen to Detach — action lives in the card's own (now shared) action row.
    await page.locator('.dc-attachment-badge').click();
    await chip.click();
    await card.getByRole('button', { name: 'Detach onto the canvas' }).click();
    await expect(page.locator('.dc-attachment-badge')).toHaveCount(0);
    await expect(page.locator('.dc-node')).toHaveCount(2);

    const detached = page.locator('.dc-node[data-type="code"]');
    const detachedBox = (await detached.boundingBox())!;
    // Same footprint it had before attaching — not the type default.
    expect(Math.abs(detachedBox.width - codeBoxBefore.width)).toBeLessThan(4);
    expect(Math.abs(detachedBox.height - codeBoxBefore.height)).toBeLessThan(4);
    // Selected immediately on detach.
    await expect(detached).toHaveAttribute('data-selected', 'true');

    // Re-attach, then delete the attachment outright, with one undo restoring it.
    // Re-measured, not the `serviceCenter` from before the popover round-trip above: opening it
    // can leave the page horizontally scrolled (an unrelated pre-existing overflow — see
    // `document.documentElement.scrollWidth` vs `window.innerWidth`), which would silently shift
    // every screen coordinate captured before it and make a stale target miss the node entirely.
    const serviceBoxNow = (await service.boundingBox())!;
    const release2 = await dragNodeCenterTo(page, detached, {
      x: serviceBoxNow.x + serviceBoxNow.width / 2,
      y: serviceBoxNow.y + serviceBoxNow.height / 2,
    });
    // Same wait as the first attach above — see that comment.
    await expect(page.locator('.dc-node[data-attach-target="true"]')).toHaveCount(1);
    await release2();
    await expect(page.locator('.dc-attachment-badge')).toHaveCount(1);

    await page.locator('.dc-attachment-badge').click();
    await chip.click();
    await card.getByRole('button', { name: 'Delete attached detail' }).click();
    await expect(page.locator('.dc-attachment-badge')).toHaveCount(0);

    await page.keyboard.press('Meta+z');
    await expect(page.locator('.dc-attachment-badge')).toHaveCount(1);
  });

  test('an attachment survives a reload — content, chip label, and dimensions all round-trip', async ({
    page,
  }) => {
    await newCanvas(page, 'Attachment persistence');
    await create(page, 'Service', { x: 350, y: 320 });
    await create(page, 'Code', { x: 750, y: 320 });

    const service = page.locator('.dc-node[data-type="service"]');
    const code = page.locator('.dc-node[data-type="code"]');
    const codeBoxBefore = (await code.boundingBox())!;
    const serviceBox = (await service.boundingBox())!;
    const serviceCenter = { x: serviceBox.x + serviceBox.width / 2, y: serviceBox.y + serviceBox.height / 2 };

    const release = await dragNodeCenterTo(page, code, serviceCenter);
    // A Note/Code card is aimed with its capsule now, so a shape arms through the dwell rather
    // than through overlap — the same wait `:146` documents, for the same reason.
    await expect(page.locator('.dc-node[data-attach-target="true"]')).toHaveCount(1);
    await release();
    await expect(page.locator('.dc-attachment-badge')).toHaveCount(1);

    await page.locator('.dc-attachment-badge').click();
    const chip = page.locator('.dc-attachment-chip');
    const chipLabelBefore = await chip.locator('.dc-attachment-chip-label').innerText();
    await chip.click();
    const card = page.locator('.dc-attachment-card');
    await card.getByRole('button', { name: 'Edit attached detail' }).click();
    const editor = card.locator('.dc-attachment-editor-code');
    await editor.fill('SELECT * FROM accounts;');
    // Outside click commits (Escape now discards — see the dedicated test for that).
    await page.mouse.click(60, 60);
    await expect(card).toHaveCount(0);

    await expect(page.locator('.dc-save')).toContainText('Saved locally');
    await reopenAfterReload(page, 'Attachment persistence');

    await expect(page.locator('.dc-node')).toHaveCount(1);
    await expect(page.locator('.dc-attachment-badge')).toHaveCount(1);

    await page.locator('.dc-attachment-badge').click();
    const reopenedChip = page.locator('.dc-attachment-chip');
    await expect(reopenedChip.locator('.dc-attachment-chip-label')).toHaveText(chipLabelBefore);
    await reopenedChip.click();
    const reopenedCard = page.locator('.dc-attachment-card');
    await expect(reopenedCard).toBeVisible();
    await expect(reopenedCard.locator('.dc-attachment-code')).toContainText('SELECT * FROM accounts;');
    await page.keyboard.press('Escape');
    await expect(reopenedCard).toHaveCount(0);

    // Detach after reload: still recreated at its preserved size, not the
    // type default — the round-trip through IndexedDB must not have dropped
    // the width/height captured at attach time.
    await page.locator('.dc-attachment-badge').click();
    await reopenedChip.click();
    await reopenedCard.getByRole('button', { name: 'Detach onto the canvas' }).click();

    const detached = page.locator('.dc-node[data-type="code"]');
    const detachedBox = (await detached.boundingBox())!;
    expect(Math.abs(detachedBox.width - codeBoxBefore.width)).toBeLessThan(4);
    expect(Math.abs(detachedBox.height - codeBoxBefore.height)).toBeLessThan(4);
  });

  test('Escape while editing an attachment discards the edit, matching every other inline editor', async ({
    page,
  }) => {
    await newCanvas(page, 'Escape discards an attachment edit');
    await create(page, 'Service', { x: 350, y: 320 });
    await create(page, 'Code', { x: 750, y: 320 });

    const service = page.locator('.dc-node[data-type="service"]');
    const code = page.locator('.dc-node[data-type="code"]');
    const serviceBox = (await service.boundingBox())!;
    const serviceCenter = { x: serviceBox.x + serviceBox.width / 2, y: serviceBox.y + serviceBox.height / 2 };

    const release = await dragNodeCenterTo(page, code, serviceCenter);
    // A Note/Code card is aimed with its capsule now, so a shape arms through the dwell rather
    // than through overlap — the same wait `:146` documents, for the same reason.
    await expect(page.locator('.dc-node[data-attach-target="true"]')).toHaveCount(1);
    await release();
    await expect(page.locator('.dc-attachment-badge')).toHaveCount(1);

    await page.locator('.dc-attachment-badge').click();
    const chip = page.locator('.dc-attachment-chip');
    await chip.click();
    const card = page.locator('.dc-attachment-card');
    await card.getByRole('button', { name: 'Edit attached detail' }).click();
    await card.locator('.dc-attachment-editor-code').fill('this text must not survive');
    await page.keyboard.press('Escape');
    await expect(card).toHaveCount(0);

    await page.locator('.dc-attachment-badge').click();
    await chip.click();
    await expect(card.locator('.dc-attachment-code')).not.toContainText('this text must not survive');
  });

  test('a concrete attach target wins over an enclosing boundary', async ({ page }) => {
    await newCanvas(page, 'Attach beats boundary');
    await create(page, 'Service', { x: 350, y: 300 });
    await create(page, 'Data Store', { x: 600, y: 300 });

    // Group both into a boundary, so the Service now sits inside a Domain.
    await page.keyboard.press('Meta+a');
    await page.getByRole('button', { name: 'Group', exact: true }).click();
    await expect(page.locator('.dc-node[data-type="group"]')).toHaveCount(1);

    await create(page, 'Note', { x: 900, y: 550 });
    const note = page.locator('.dc-node[data-type="note"]');
    const service = page.locator('.dc-node[data-type="service"]');
    const serviceBox = (await service.boundingBox())!;
    const serviceCenter = { x: serviceBox.x + serviceBox.width / 2, y: serviceBox.y + serviceBox.height / 2 };

    // Dwell over the centre rather than relying on instant-arm overlap: a fresh note is a compact
    // two-line box now, and the first mouse step of a drag is what starts it rather than moving it.
    const release = await dragNodeCenterTo(page, note, serviceCenter, { dwell: true });
    await release();

    // Attached to the Service, not reparented into the boundary.
    await expect(page.locator('.dc-node[data-type="note"]')).toHaveCount(0);
    await expect(page.locator('.dc-attachment-badge')).toHaveCount(1);
  });

  test('several attachments on one element render as separate chips, matching a connector\'s own', async ({
    page,
  }) => {
    await newCanvas(page, 'Multiple element attachments');
    await create(page, 'Service', { x: 350, y: 320 });
    const service = page.locator('.dc-node[data-type="service"]');
    const serviceBox = (await service.boundingBox())!;
    const serviceCenter = { x: serviceBox.x + serviceBox.width / 2, y: serviceBox.y + serviceBox.height / 2 };

    await create(page, 'Note', { x: 750, y: 200 });
    const releaseNote = await dragNodeCenterTo(page, page.locator('.dc-node[data-type="note"]'), serviceCenter);
    // A Note/Code card is aimed with its capsule now, so a shape arms through the dwell rather
    // than through overlap — the same wait `:146` documents, for the same reason.
    await expect(page.locator('.dc-node[data-attach-target="true"]')).toHaveCount(1);
    await releaseNote();

    await create(page, 'Code', { x: 750, y: 440 });
    const releaseCode = await dragNodeCenterTo(page, page.locator('.dc-node[data-type="code"]'), serviceCenter);
    // A Note/Code card is aimed with its capsule now, so a shape arms through the dwell rather
    // than through overlap — the same wait `:146` documents, for the same reason.
    await expect(page.locator('.dc-node[data-attach-target="true"]')).toHaveCount(1);
    await releaseCode();

    await expect(page.locator('.dc-attachment-badge')).toContainText('2');

    await page.locator('.dc-attachment-badge').click();
    const chips = page.locator('.dc-attachment-chip');
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(0)).toHaveAttribute('data-kind', 'note');
    await expect(chips.nth(1)).toHaveAttribute('data-kind', 'code');

    // Clicking one reveals only its own card — same "compact list, one active card" behaviour a
    // connector's own attachments already have.
    await chips.nth(1).click();
    await expect(page.locator('.dc-attachment-card')).toHaveCount(1);
  });
});
