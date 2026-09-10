import { expect, test, type Page } from '@playwright/test';

/** Editing mechanics that the critical journey does not exercise. */

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
  // A new Note opens ready to type into; Escape commits (empty) and leaves it selected, so the
  // rest of a test sees the same plain, selected node it would for any other tool.
  if (tool === 'Note') await page.keyboard.press('Escape');
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

test.describe('editing', () => {
  test('resizes a node and keeps the new size after a reload', async ({ page }) => {
    await newCanvas(page, 'Resizing');
    await create(page, 'Service', { x: 400, y: 300 });

    const node = page.locator('.dc-node').first();
    await node.click();
    const before = (await node.boundingBox())!;

    // Drag the bottom-right resize control outwards.
    const handles = page.locator('.dc-resize-handle');
    await expect(handles).toHaveCount(4);
    const corner = (await handles.nth(3).boundingBox())!;
    await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
    await page.mouse.down();
    await page.mouse.move(corner.x + 140, corner.y + 90, { steps: 12 });
    await page.mouse.up();

    const after = (await node.boundingBox())!;
    expect(after.width).toBeGreaterThan(before.width + 100);
    expect(after.height).toBeGreaterThan(before.height + 60);

    await expect(page.locator('.dc-save')).toContainText('Saved locally');
    await page.reload();
    await page.locator('.dc-library-item', { hasText: 'Resizing' }).click();

    const restored = (await page.locator('.dc-node').first().boundingBox())!;
    expect(Math.abs(restored.width - after.width)).toBeLessThan(4);
    expect(Math.abs(restored.height - after.height)).toBeLessThan(4);
  });

  test('a resize is one undo step', async ({ page }) => {
    await newCanvas(page, 'Resize undo');
    await create(page, 'Service', { x: 400, y: 300 });

    const node = page.locator('.dc-node').first();
    await node.click();
    const before = (await node.boundingBox())!;

    const corner = (await page.locator('.dc-resize-handle').nth(3).boundingBox())!;
    await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
    await page.mouse.down();
    await page.mouse.move(corner.x + 150, corner.y + 100, { steps: 15 });
    await page.mouse.up();
    await page.waitForTimeout(200);

    await page.keyboard.press('Meta+z');
    await expect
      .poll(async () => Math.abs((await node.boundingBox())!.width - before.width))
      .toBeLessThan(4);
  });

  test('resizes live: content and the dimension indicator track the pointer mid-gesture', async ({
    page,
  }) => {
    await newCanvas(page, 'Live resize');
    await create(page, 'Service', { x: 400, y: 300 });

    const node = page.locator('.dc-node').first();
    await node.click();
    const surface = node.locator('.dc-node-surface');
    const before = (await surface.boundingBox())!;
    const widthBefore = await surface.getAttribute('width');

    const corner = (await page.locator('.dc-resize-handle').nth(3).boundingBox())!;
    await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
    await page.mouse.down();
    await page.mouse.move(corner.x + 140, corner.y + 90, { steps: 12 });

    // Assert mid-gesture, before mouseup: the surface (and the indicator) must
    // already reflect the live size, not the pre-drag committed size.
    const duringWidth = await surface.getAttribute('width');
    expect(Number(duringWidth)).not.toBe(Number(widthBefore));
    const during = (await surface.boundingBox())!;
    expect(during.width).toBeGreaterThan(before.width + 80);

    const indicator = page.locator('.dc-resize-indicator');
    await expect(indicator).toBeVisible();
    const [w, h] = (await indicator.textContent())!.split('×').map((n) => Number(n.trim()));
    expect(Math.abs(w - during.width)).toBeLessThan(6);
    expect(h).toBeGreaterThan(0);

    await page.mouse.up();
    await expect(indicator).toHaveCount(0);
  });

  test('resize never shrinks a node below its per-type minimum', async ({ page }) => {
    await newCanvas(page, 'Resize minimum');
    await create(page, 'Service', { x: 500, y: 400 });

    const node = page.locator('.dc-node').first();
    await node.click();

    const corner = (await page.locator('.dc-resize-handle').nth(3).boundingBox())!;
    await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
    await page.mouse.down();
    // Drag the bottom-right handle far up and to the left of the node's origin.
    await page.mouse.move(corner.x - 400, corner.y - 300, { steps: 20 });
    await page.mouse.up();

    const after = (await node.boundingBox())!;
    // The generic-default floor `minSizeFor` falls back to for a type with no
    // type-specific minimum (Service included) — see src/document/factory.ts.
    expect(after.width).toBeGreaterThanOrEqual(96 - 2);
    expect(after.height).toBeGreaterThanOrEqual(48 - 2);
  });

  test('quick connect: dragging to empty canvas offers a type picker and creates+connects on choice', async ({
    page,
  }) => {
    await newCanvas(page, 'Quick connect');
    await create(page, 'Service', { x: 300, y: 300 });
    await expect(page.locator('.dc-node')).toHaveCount(1);

    const source = page.locator('.dc-node').first();
    await source.hover();
    const handle = (await source.locator('.dc-handle').nth(1).boundingBox())!; // right side
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + 260, handle.y + 40, { steps: 12 });
    await page.mouse.up();

    const menu = page.locator('.dc-quick-connect');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveCount(4);

    await menu.getByRole('menuitem', { name: 'Data Store', exact: true }).click();
    await expect(menu).toBeHidden();
    await expect(page.locator('.dc-node')).toHaveCount(2);
    await expect(page.locator('.dc-node[data-type="database"]')).toHaveCount(1);
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  });

  test('quick connect: Escape dismisses the picker without creating anything', async ({ page }) => {
    await newCanvas(page, 'Quick connect escape');
    await create(page, 'Service', { x: 300, y: 300 });

    const source = page.locator('.dc-node').first();
    await source.hover();
    const handle = (await source.locator('.dc-handle').nth(1).boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + 260, handle.y + 40, { steps: 12 });
    await page.mouse.up();

    const menu = page.locator('.dc-quick-connect');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(page.locator('.dc-node')).toHaveCount(1);
    await expect(page.locator('.react-flow__edge')).toHaveCount(0);
  });

  test('snaps a resized edge into alignment with a neighbour', async ({ page }) => {
    await newCanvas(page, 'Resize snapping');
    await create(page, 'Service', { x: 350, y: 250 });
    await create(page, 'Service', { x: 700, y: 250 });

    const neighbour = (await page.locator('.dc-node').nth(1).boundingBox())!;
    const resizing = page.locator('.dc-node').nth(0);
    await resizing.click();
    const before = (await resizing.boundingBox())!;

    const corner = (await page.locator('.dc-resize-handle').nth(3).boundingBox())!;
    // Grow the right edge to within SNAP_THRESHOLD (6px) of the neighbour's
    // left edge, not flush against it.
    const targetRight = neighbour.x - 4;
    await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
    await page.mouse.down();
    await page.mouse.move(targetRight, corner.y + corner.height / 2, { steps: 12 });
    await page.waitForTimeout(150);

    // Both nodes share a height, so the unmoved bottom edge coincidentally
    // lines up with the neighbour's too — assert the x-axis guide this test
    // is actually about, rather than an exact guide count.
    await expect(page.locator('.dc-guide[data-axis="x"]')).toHaveCount(1);
    await page.mouse.up();

    const after = (await resizing.boundingBox())!;
    // Pulled flush against the neighbour's left edge, not left a few pixels short.
    expect(Math.abs(after.x + after.width - neighbour.x)).toBeLessThan(1.5);
    expect(after.width).toBeGreaterThan(before.width);
  });

  test('opening a diagram never shows stray guides for nodes that already line up', async ({ page }) => {
    // React Flow fires a `dimensions` change for every node as it is first
    // measured after mount, with no `resizing` field at all — indistinguishable
    // from a resize's own dimension changes unless that field is checked. Two
    // same-sized nodes share top/bottom edges by construction, so the mount-time
    // measurement alone used to compute a bogus resize-snap guide and render it
    // with nothing being dragged or resized.
    await newCanvas(page, 'No stale guides on load');
    await create(page, 'Service', { x: 350, y: 250 });
    await create(page, 'Service', { x: 700, y: 250 });

    await expect(page.locator('.dc-save')).toContainText('Saved locally');
    await page.reload();
    await page.locator('.dc-library-item', { hasText: 'No stale guides on load' }).click();

    await expect(page.locator('.dc-node')).toHaveCount(2);
    await expect(page.locator('.dc-guide')).toHaveCount(0);
  });

  test('multi-selects with a marquee and moves the selection together', async ({ page }) => {
    await newCanvas(page, 'Multi-select');
    await create(page, 'Service', { x: 300, y: 250 });
    await create(page, 'Service', { x: 600, y: 250 });
    await create(page, 'Service', { x: 900, y: 250 });

    // Rubber-band across the first two.
    await page.mouse.move(200, 150);
    await page.mouse.down();
    await page.mouse.move(760, 420, { steps: 12 });
    await page.mouse.up();

    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(2);
    await expect(page.locator('.dc-inspector')).toContainText('2 elements');

    const first = page.locator('.dc-node').nth(0);
    const second = page.locator('.dc-node').nth(1);
    const third = page.locator('.dc-node').nth(2);
    const before = [
      (await first.boundingBox())!,
      (await second.boundingBox())!,
      (await third.boundingBox())!,
    ];

    // Dragging one selected node moves the whole selection, and only it.
    await page.mouse.move(before[0]!.x + before[0]!.width / 2, before[0]!.y + before[0]!.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      before[0]!.x + before[0]!.width / 2,
      before[0]!.y + before[0]!.height / 2 + 180,
      { steps: 12 },
    );
    await page.mouse.up();

    const after = [
      (await first.boundingBox())!,
      (await second.boundingBox())!,
      (await third.boundingBox())!,
    ];
    expect(after[0]!.y - before[0]!.y).toBeGreaterThan(150);
    expect(after[1]!.y - before[1]!.y).toBeGreaterThan(150);
    expect(Math.abs(after[2]!.y - before[2]!.y)).toBeLessThan(4);

    // And the whole group move is a single undo.
    await page.keyboard.press('Meta+z');
    await expect
      .poll(async () => Math.abs((await first.boundingBox())!.y - before[0]!.y))
      .toBeLessThan(4);
    await expect
      .poll(async () => Math.abs((await second.boundingBox())!.y - before[1]!.y))
      .toBeLessThan(4);
  });

  test('a marquee that captures connected nodes never crashes the app', async ({ page }) => {
    // Regression test: React Flow drives a marquee's edge selection through an
    // internal pathway that bypasses the controlled `edges` prop, selecting
    // every edge connected to a newly-selected node directly in its own
    // store — independently of, and in addition to, the ordinary
    // `onEdgesChange('select', ...)` this app also receives for the same
    // edges. Applying both used to race: this app's own patch and the
    // store-driven `projectEdges` recompute could each make React Flow
    // perceive the result as yet another change, looping forever and
    // crashing with "Maximum update depth exceeded" the moment a marquee
    // drag captured any node with a connected edge — which a marquee
    // spanning only unconnected nodes (the test above) never exercises.
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await newCanvas(page, 'Marquee over connected nodes');
    await create(page, 'Service', { x: 300, y: 250 });
    await create(page, 'Data Store', { x: 600, y: 250 });
    await connect(page, 0, 1);

    // A rubber-band spanning both connected nodes — the exact shape that
    // used to crash.
    await page.mouse.move(200, 150);
    await page.mouse.down();
    await page.mouse.move(760, 420, { steps: 12 });
    await page.mouse.up();

    await expect(page.locator('.dc-editor')).toBeVisible();
    expect(errors).toEqual([]);
    // The gesture still does what a marquee is for.
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(2);
  });

  test('a marquee released over the toolbar still resets selection state cleanly', async ({ page }) => {
    // The fix for the test above reads React Flow's own `userSelectionActive`
    // store flag instead of a hand-rolled ref set by `onSelectionStart`/
    // `onSelectionEnd` props — this exercises that the flag still resets
    // correctly when the release point is outside the canvas pane itself,
    // which native pointer capture (not this app's own prop callbacks) is
    // what actually guarantees.
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await newCanvas(page, 'Marquee released outside canvas');
    await create(page, 'Service', { x: 300, y: 250 });
    await create(page, 'Data Store', { x: 600, y: 250 });
    await connect(page, 0, 1);

    await page.mouse.move(200, 150);
    await page.mouse.down();
    await page.mouse.move(760, 420, { steps: 12 });
    await page.mouse.move(400, 20, { steps: 6 }); // over the toolbar, above the canvas pane
    await page.mouse.up();

    await expect(page.locator('.dc-editor')).toBeVisible();
    expect(errors).toEqual([]);

    // A subsequent, ordinary marquee still works correctly — the real
    // regression signal, proving no stale state carried over.
    await page.mouse.move(200, 150);
    await page.mouse.down();
    await page.mouse.move(760, 420, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(2);
    expect(errors).toEqual([]);
  });

  test('two marquee gestures back-to-back never leave stale selection state', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await newCanvas(page, 'Back-to-back marquees');
    await create(page, 'Service', { x: 300, y: 250 });
    await create(page, 'Data Store', { x: 600, y: 250 });
    await connect(page, 0, 1);

    // The exact marquee that used to crash the app (see the test above),
    // fired twice in a row with no deliberate pause — re-exercises
    // `onSelectionStart` → filtered `onEdgesChange` → reset all over again
    // immediately, rather than only once.
    for (let i = 0; i < 2; i += 1) {
      await page.mouse.move(200, 150);
      await page.mouse.down();
      await page.mouse.move(760, 420, { steps: 10 });
      await page.mouse.up();
    }

    await expect(page.locator('.dc-editor')).toBeVisible();
    expect(errors).toEqual([]);
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(2);
  });

  test('losing window focus mid-marquee never crashes the app', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));

    await newCanvas(page, 'Blur mid-marquee');
    await create(page, 'Service', { x: 300, y: 250 });
    await create(page, 'Data Store', { x: 600, y: 250 });
    await connect(page, 0, 1);

    await page.mouse.move(200, 150);
    await page.mouse.down();
    await page.mouse.move(760, 420, { steps: 12 });
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.up();

    await expect(page.locator('.dc-editor')).toBeVisible();
    expect(errors).toEqual([]);

    // A subsequent ordinary marquee still works — proves no stuck state.
    await page.mouse.move(200, 150);
    await page.mouse.down();
    await page.mouse.move(760, 420, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(2);
  });

  test('aligns and distributes a multi-selection via the Inspector', async ({ page }) => {
    await newCanvas(page, 'Align and distribute');
    await create(page, 'Service', { x: 300, y: 220 });
    await create(page, 'Service', { x: 600, y: 340 });
    await create(page, 'Service', { x: 900, y: 480 });

    await page.keyboard.press('Meta+a');
    await expect(page.locator('.dc-inspector')).toContainText('3 elements');

    await page.getByLabel('Align').selectOption('top');
    const afterAlign = [
      (await page.locator('.dc-node').nth(0).boundingBox())!,
      (await page.locator('.dc-node').nth(1).boundingBox())!,
      (await page.locator('.dc-node').nth(2).boundingBox())!,
    ];
    // All three now share the topmost node's y.
    expect(Math.abs(afterAlign[1]!.y - afterAlign[0]!.y)).toBeLessThan(1.5);
    expect(Math.abs(afterAlign[2]!.y - afterAlign[0]!.y)).toBeLessThan(1.5);

    await page.getByRole('button', { name: 'Distribute ↔' }).click();
    const afterDistribute = [
      (await page.locator('.dc-node').nth(0).boundingBox())!,
      (await page.locator('.dc-node').nth(1).boundingBox())!,
      (await page.locator('.dc-node').nth(2).boundingBox())!,
    ];
    const gapA = afterDistribute[1]!.x - (afterDistribute[0]!.x + afterDistribute[0]!.width);
    const gapB = afterDistribute[2]!.x - (afterDistribute[1]!.x + afterDistribute[1]!.width);
    expect(Math.abs(gapA - gapB)).toBeLessThan(1.5);
  });

  test('copies, pastes, cuts and duplicates', async ({ page }) => {
    await newCanvas(page, 'Clipboard');
    await create(page, 'Note', { x: 400, y: 300 });
    await page.locator('.dc-node').first().click();

    await page.keyboard.press('ControlOrMeta+c');
    await page.keyboard.press('ControlOrMeta+v');
    await expect(page.locator('.dc-node')).toHaveCount(2);

    await page.keyboard.press('Meta+d');
    await expect(page.locator('.dc-node')).toHaveCount(3);

    await page.keyboard.press('Meta+z');
    await expect(page.locator('.dc-node')).toHaveCount(2);

    await page.keyboard.press('Meta+a');
    await page.keyboard.press('ControlOrMeta+x');
    await expect(page.locator('.dc-node')).toHaveCount(0);

    await page.keyboard.press('Meta+z');
    await expect(page.locator('.dc-node')).toHaveCount(2);
  });

  test('pastes a copied selection into a different diagram after a reload', async ({ page, context }) => {
    // The in-memory clipboard alone already survives switching diagrams within the same tab; a
    // reload after copying is what forces this test through the OS clipboard instead. Plain
    // Cmd/Ctrl+V itself never calls `navigator.clipboard.readText()` — it reads a native `paste`
    // event's `clipboardData` directly, which needs no permission at all — so granting
    // `clipboard-read` here isn't what makes the later `ControlOrMeta+v` work; it's what lets the
    // `readText()` poll just below observe that the earlier `writeText()` actually landed.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    await newCanvas(page, 'Clipboard source');
    await create(page, 'Note', { x: 400, y: 300 });
    await page.locator('.dc-node').first().click();
    await page.keyboard.press('ControlOrMeta+c');
    // The OS-clipboard write is fire-and-forget; wait for it to actually
    // land before navigating away, or the write's promise never resolves.
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain('"format":"draft-canvas"');

    await newCanvas(page, 'Clipboard target');
    await expect(page.locator('.dc-save')).toContainText('Saved locally');
    await page.reload();
    await page.locator('.dc-library-item', { hasText: 'Clipboard target' }).click();
    // The Async Clipboard API's readText() requires document focus even with
    // the permission granted — a plain click after navigating in gives it that.
    await page.locator('.react-flow__pane').click();

    await page.keyboard.press('ControlOrMeta+v');
    await expect(page.locator('.dc-node')).toHaveCount(1);
  });

  test('groups a selection into a boundary and ungroups it', async ({ page }) => {
    await newCanvas(page, 'Grouping');
    await create(page, 'Service', { x: 350, y: 280 });
    await create(page, 'Data Store', { x: 650, y: 280 });

    await page.keyboard.press('Meta+a');
    await expect(page.locator('.dc-inspector')).toContainText('2 elements');
    await page.getByRole('button', { name: 'Group', exact: true }).click();

    await expect(page.locator('.dc-node[data-type="group"]')).toHaveCount(1);
    await expect(page.locator('.dc-node')).toHaveCount(3);

    await page.getByRole('button', { name: 'Ungroup', exact: true }).click();
    await expect(page.locator('.dc-node[data-type="group"]')).toHaveCount(0);
    await expect(page.locator('.dc-node')).toHaveCount(2);
  });

  test('dragging a boundary moves its contained nodes along with it', async ({ page }) => {
    await newCanvas(page, 'Boundary drag');
    await create(page, 'Service', { x: 350, y: 280 });
    await create(page, 'Data Store', { x: 650, y: 280 });
    await connect(page, 0, 1);

    await page.keyboard.press('Meta+a');
    await page.getByRole('button', { name: 'Group', exact: true }).click();

    const boundary = page.locator('.dc-node[data-type="group"]');
    await expect(boundary).toHaveCount(1);
    const children = page.locator('.dc-node:not([data-type="group"])');
    await expect(children).toHaveCount(2);

    const boundaryBefore = (await boundary.boundingBox())!;
    const childBefore = [
      (await children.nth(0).boundingBox())!,
      (await children.nth(1).boundingBox())!,
    ];

    // Grab a point inside the boundary's own padding, clear of any child.
    const grab = { x: boundaryBefore.x + 8, y: boundaryBefore.y + 8 };
    const dragDx = 120;
    const dragDy = 60;
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x + dragDx, grab.y + dragDy, { steps: 10 });
    await page.mouse.up();

    const boundaryAfter = (await boundary.boundingBox())!;
    const childAfter = [
      (await children.nth(0).boundingBox())!,
      (await children.nth(1).boundingBox())!,
    ];
    const boundaryDelta = { x: boundaryAfter.x - boundaryBefore.x, y: boundaryAfter.y - boundaryBefore.y };

    // Each child moves by exactly the boundary's own delta — not merely by
    // the same amount as each other — and keeps its own size untouched.
    for (let i = 0; i < 2; i += 1) {
      expect(Math.abs(childAfter[i]!.x - childBefore[i]!.x - boundaryDelta.x)).toBeLessThan(2);
      expect(Math.abs(childAfter[i]!.y - childBefore[i]!.y - boundaryDelta.y)).toBeLessThan(2);
      expect(Math.abs(childAfter[i]!.width - childBefore[i]!.width)).toBeLessThan(1);
      expect(Math.abs(childAfter[i]!.height - childBefore[i]!.height)).toBeLessThan(1);
    }
    // The connection between them is unaffected by the sweep — still one edge.
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
  });

  test('dragging an outer boundary sweeps a nested boundary and everything inside it', async ({
    page,
  }) => {
    await newCanvas(page, 'Nested boundary drag');
    await create(page, 'Service', { x: 350, y: 280 });
    await create(page, 'Data Store', { x: 650, y: 280 });
    await create(page, 'Note', { x: 650, y: 500 });

    // Inner boundary around the Database and the Note (Group needs 2+ nodes
    // selected — Inspector only shows it for a multi-selection).
    await page.locator('.dc-node[data-type="database"]').click();
    await page.locator('.dc-node[data-type="note"]').click({ modifiers: ['Shift'] });
    await page.getByRole('button', { name: 'Group', exact: true }).click();
    const inner = page.locator('.dc-node[data-type="group"]');
    await expect(inner).toHaveCount(1);

    // Outer boundary around the Service and the inner boundary together —
    // selecting the inner boundary itself (a point in its own padding, clear
    // of its children) rather than "select all", which would also pick up
    // Database/Note individually and reparent them straight to the outer
    // boundary instead of leaving them nested inside the inner one.
    await page.locator('.dc-node[data-type="service"]').click();
    await inner.click({ modifiers: ['Shift'], position: { x: 8, y: 8 } });
    await expect(page.locator('.dc-inspector')).toContainText('2 elements');
    await page.getByRole('button', { name: 'Group', exact: true }).click();
    const groups = page.locator('.dc-node[data-type="group"]');
    await expect(groups).toHaveCount(2);

    const service = page.locator('.dc-node[data-type="service"]');
    const database = page.locator('.dc-node[data-type="database"]');
    const before = { service: (await service.boundingBox())!, database: (await database.boundingBox())! };

    // The outer boundary is whichever group node encloses the other.
    const boxes = [
      { box: (await groups.nth(0).boundingBox())!, index: 0 },
      { box: (await groups.nth(1).boundingBox())!, index: 1 },
    ];
    const outerEntry = boxes[0]!.box.width * boxes[0]!.box.height >= boxes[1]!.box.width * boxes[1]!.box.height ? boxes[0]! : boxes[1]!;
    const outerBefore = outerEntry.box;

    const grab = { x: outerBefore.x + 6, y: outerBefore.y + 6 };
    const dragDx = 90;
    const dragDy = 40;
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x + dragDx, grab.y + dragDy, { steps: 10 });
    await page.mouse.up();

    const outerAfter = (await groups.nth(outerEntry.index).boundingBox())!;
    const outerDelta = { x: outerAfter.x - outerBefore.x, y: outerAfter.y - outerBefore.y };
    // The move actually landed in the neighbourhood requested (snapping may
    // adjust it slightly, exactly as in the single-level drag test above).
    expect(Math.abs(outerDelta.x - dragDx)).toBeLessThan(10);
    expect(Math.abs(outerDelta.y - dragDy)).toBeLessThan(10);

    const after = { service: (await service.boundingBox())!, database: (await database.boundingBox())! };
    // Both the direct child (Service) and the doubly-nested one (Database,
    // inside the inner boundary) move by the outer boundary's own actual
    // delta, snap-correction included — the sweep must propagate through the
    // inner boundary transparently, not just to its immediate children.
    expect(Math.abs(after.service.x - before.service.x - outerDelta.x)).toBeLessThan(2);
    expect(Math.abs(after.service.y - before.service.y - outerDelta.y)).toBeLessThan(2);
    expect(Math.abs(after.database.x - before.database.x - outerDelta.x)).toBeLessThan(2);
    expect(Math.abs(after.database.y - before.database.y - outerDelta.y)).toBeLessThan(2);
  });

  test('boundary reparent: entering and leaving a boundary never jumps the node', async ({ page }) => {
    await newCanvas(page, 'Reparent invariant');
    await create(page, 'Service', { x: 350, y: 280 });
    await create(page, 'Data Store', { x: 650, y: 280 });
    await page.keyboard.press('Meta+a');
    await page.getByRole('button', { name: 'Group', exact: true }).click();

    const boundary = page.locator('.dc-node[data-type="group"]');
    const boundaryBox = (await boundary.boundingBox())!;

    // Placed clear of the bottom-center Inspector, which grows wide enough
    // for a boundary selection (colour swatches, boundary preset, ungroup,
    // focus, delete) to reach the lower half of the viewport.
    await create(page, 'Actor', { x: 350, y: 480 });
    const extra = page.locator('.dc-node[data-type="actor"]');

    // A point inside the boundary's own padding, clear of either child.
    const dropPoint = { x: boundaryBox.x + boundaryBox.width - 15, y: boundaryBox.y + boundaryBox.height / 2 };
    const extraStart = (await extra.boundingBox())!;
    await page.mouse.move(extraStart.x + extraStart.width / 2, extraStart.y + extraStart.height / 2);
    await page.mouse.down();
    await page.mouse.move(dropPoint.x, dropPoint.y, { steps: 15 });

    const justBeforeDrop = (await extra.boundingBox())!;
    await page.mouse.up();
    const justAfterDrop = (await extra.boundingBox())!;

    // The critical invariant: assigning parentId must not move the node.
    expect(Math.abs(justAfterDrop.x - justBeforeDrop.x)).toBeLessThan(1.5);
    expect(Math.abs(justAfterDrop.y - justBeforeDrop.y)).toBeLessThan(1.5);

    // Behavioural proof of containment: dragging the boundary now carries
    // the extra node with it too, alongside the two original members.
    const grab = { x: boundaryBox.x + 8, y: boundaryBox.y + 8 };
    const extraBeforeSweep = (await extra.boundingBox())!;
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x + 90, grab.y + 40, { steps: 10 });
    await page.mouse.up();
    const extraAfterSweep = (await extra.boundingBox())!;
    expect(extraAfterSweep.x - extraBeforeSweep.x).toBeGreaterThan(60);
    expect(extraAfterSweep.y - extraBeforeSweep.y).toBeGreaterThan(20);

    // Drag the extra node back out onto bare canvas — no jump leaving either.
    const outside = { x: 200, y: 600 };
    const extraNow = (await extra.boundingBox())!;
    await page.mouse.move(extraNow.x + extraNow.width / 2, extraNow.y + extraNow.height / 2);
    await page.mouse.down();
    await page.mouse.move(outside.x, outside.y, { steps: 15 });
    const justBeforeExit = (await extra.boundingBox())!;
    await page.mouse.up();
    const justAfterExit = (await extra.boundingBox())!;
    expect(Math.abs(justAfterExit.x - justBeforeExit.x)).toBeLessThan(1.5);
    expect(Math.abs(justAfterExit.y - justBeforeExit.y)).toBeLessThan(1.5);

    // Now outside the boundary: dragging the boundary no longer moves it.
    const boundaryBox2 = (await boundary.boundingBox())!;
    const grab2 = { x: boundaryBox2.x + 8, y: boundaryBox2.y + 8 };
    const extraBeforeSweep2 = (await extra.boundingBox())!;
    await page.mouse.move(grab2.x, grab2.y);
    await page.mouse.down();
    await page.mouse.move(grab2.x + 90, grab2.y + 40, { steps: 10 });
    await page.mouse.up();
    const extraAfterSweep2 = (await extra.boundingBox())!;
    expect(Math.abs(extraAfterSweep2.x - extraBeforeSweep2.x)).toBeLessThan(1.5);
    expect(Math.abs(extraAfterSweep2.y - extraBeforeSweep2.y)).toBeLessThan(1.5);
  });

  test('boundary reparent: nested boundaries resolve to the innermost one', async ({ page }) => {
    await newCanvas(page, 'Nested boundaries');
    await create(page, 'Service', { x: 300, y: 250 });
    await create(page, 'Data Store', { x: 560, y: 250 });
    await page.keyboard.press('Meta+a');
    await page.getByRole('button', { name: 'Group', exact: true }).click();

    // Grow the inner boundary generously so there is empty room inside it,
    // clear of its two members, both for dropping a third node and for a
    // separate grab point that does not overlap that node. Pinned to index 0
    // among group nodes: it is created first, and node DOM order follows
    // document order, so it stays addressable once an outer boundary exists.
    const inner = page.locator('.dc-node[data-type="group"]').nth(0);
    let box = (await inner.boundingBox())!;
    const resizeHandle = (await page.locator('.dc-resize-handle').nth(3).boundingBox())!;
    await page.mouse.move(resizeHandle.x + resizeHandle.width / 2, resizeHandle.y + resizeHandle.height / 2);
    await page.mouse.down();
    await page.mouse.move(resizeHandle.x + 260, resizeHandle.y + 260, { steps: 12 });
    await page.mouse.up();
    box = (await inner.boundingBox())!;

    // A node just outside the inner boundary, to group alongside it into an
    // outer boundary whose bounds strictly contain the inner one.
    await create(page, 'Actor', { x: box.x + box.width + 90, y: box.y });
    await inner.click();
    await page.locator('.dc-node[data-type="actor"]').click({ modifiers: ['Shift'] });
    await page.getByRole('button', { name: 'Group', exact: true }).click();
    await expect(page.locator('.dc-node[data-type="group"]')).toHaveCount(2);

    // Drop a plain extra node into the inner boundary's new empty region (its
    // bottom-right quadrant, away from the Service/Database pair).
    const dropPoint = { x: box.x + box.width - 40, y: box.y + box.height - 40 };
    await create(page, 'Queue', { x: 60, y: 550 });
    const extra = page.locator('.dc-node[data-type="queue"]');
    const extraStart = (await extra.boundingBox())!;
    await page.mouse.move(extraStart.x + extraStart.width / 2, extraStart.y + extraStart.height / 2);
    await page.mouse.down();
    await page.mouse.move(dropPoint.x, dropPoint.y, { steps: 15 });
    await page.mouse.up();

    // Grab the inner boundary at an empty point (its own top-left padding —
    // clear of Service, Database, and the dropped extra node) and drag it alone.
    const innerBox = (await inner.boundingBox())!;
    const grab = { x: innerBox.x + 8, y: innerBox.y + 8 };
    const extraBefore = (await extra.boundingBox())!;
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x + 70, grab.y + 50, { steps: 10 });
    await page.mouse.up();
    const extraAfter = (await extra.boundingBox())!;

    // The extra node moved with the *inner* boundary specifically — proof it
    // resolved to the innermost containing boundary, not the outer one.
    expect(extraAfter.x - extraBefore.x).toBeGreaterThan(50);
    expect(extraAfter.y - extraBefore.y).toBeGreaterThan(30);
  });

  test('snaps a dragged node into alignment with its neighbour', async ({ page }) => {
    await newCanvas(page, 'Snapping');
    await create(page, 'Service', { x: 350, y: 250 });
    await create(page, 'Service', { x: 700, y: 460 });

    const anchor = (await page.locator('.dc-node').nth(0).boundingBox())!;
    const mover = page.locator('.dc-node').nth(1);
    const start = (await mover.boundingBox())!;

    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    // The node trails the pointer by the first move of a drag, so aim is taken
    // after the gesture has actually begun rather than from the start position.
    await page.mouse.move(start.x + start.width / 2 - 40, start.y + start.height / 2, { steps: 4 });

    const moving = (await mover.boundingBox())!;
    const pointer = { x: start.x + start.width / 2 - 40, y: start.y + start.height / 2 };
    const targetCentre = anchor.x + anchor.width / 2;
    // Aim a few pixels off the neighbour's centre line: close enough to attract.
    const remaining = targetCentre + 4 - (moving.x + moving.width / 2);

    await page.mouse.move(pointer.x + remaining, pointer.y, { steps: 8 });
    await page.waitForTimeout(150);

    await expect(page.locator('.dc-guide')).toHaveCount(1);
    await page.mouse.up();

    const landed = (await mover.boundingBox())!;
    // Pulled onto the guide, not left a few pixels off it.
    expect(Math.abs(landed.x + landed.width / 2 - targetCentre)).toBeLessThan(1.5);
  });

  test('copies a code card\'s contents to the clipboard', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await newCanvas(page, 'Copy code');
    await create(page, 'Code', { x: 400, y: 300 });

    const node = page.locator('.dc-node[data-type="code"]');
    await node.dblclick();
    const editor = page.locator('.dc-node-editor-code');
    await editor.fill('const answer = 42;');
    await editor.blur();

    await node.hover();
    // A class locator, not `getByRole`: the button is only visible on
    // hover/selection (CSS opacity), and `getByRole`'s accessibility-tree
    // based resolution proved unreliable at actually landing the click on it
    // even with `force`, despite the feature working correctly (confirmed
    // manually) — a plain CSS locator does not have that problem.
    const copyButton = page.locator('.dc-code-copy');
    await copyButton.click({ force: true });
    await expect(copyButton).toContainText('Copied');

    const clipboard = await page.evaluate(() => navigator.clipboard.readText());
    expect(clipboard).toBe('const answer = 42;');
  });

  test('a code card grows to fit a paste that would otherwise clip lines, but never shrinks', async ({
    page,
  }) => {
    await newCanvas(page, 'Code card grows to fit');
    await create(page, 'Code', { x: 400, y: 300 });

    const node = page.locator('.dc-node[data-type="code"]');
    const before = (await node.boundingBox())!;

    const longSnippet = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    await node.dblclick();
    await page.locator('.dc-node-editor-code').fill(longSnippet);
    await page.locator('.dc-node-editor-code').blur();

    const grown = (await node.boundingBox())!;
    expect(grown.height).toBeGreaterThan(before.height);

    // Editing again with something shorter must not shrink it back down —
    // only growing to avoid clipping is in scope, not auto-fitting either way.
    await node.dblclick();
    await page.locator('.dc-node-editor-code').fill('short');
    await page.locator('.dc-node-editor-code').blur();

    const afterShort = (await node.boundingBox())!;
    expect(Math.abs(afterShort.height - grown.height)).toBeLessThan(1.5);
  });

  test('arrow keys nudge the selection, Shift moves further, and rapid taps coalesce', async ({
    page,
  }) => {
    await newCanvas(page, 'Keyboard nudge');
    await create(page, 'Service', { x: 400, y: 300 });

    const node = page.locator('.dc-node').first();
    await node.click();
    const before = (await node.boundingBox())!;

    await page.keyboard.press('ArrowRight');
    const afterOne = (await node.boundingBox())!;
    expect(afterOne.x - before.x).toBeCloseTo(1, 0);

    await page.keyboard.press('Shift+ArrowDown');
    const afterShift = (await node.boundingBox())!;
    expect(afterShift.y - afterOne.y).toBeCloseTo(10, 0);

    // Five rapid taps coalesce into a single undo step.
    for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowRight');
    const afterBurst = (await node.boundingBox())!;
    expect(afterBurst.x).toBeGreaterThan(afterShift.x);

    await page.keyboard.press('Meta+z');
    const afterUndo = (await node.boundingBox())!;
    expect(Math.abs(afterUndo.x - afterShift.x)).toBeLessThan(1.5);
  });

  test('Enter edits a single selected node or edge, and is a no-op otherwise', async ({ page }) => {
    await newCanvas(page, 'Keyboard enter');
    await create(page, 'Service', { x: 300, y: 250 });
    await create(page, 'Data Store', { x: 600, y: 250 });
    await connect(page, 0, 1);

    // A single selected node.
    const node = page.locator('.dc-node').first();
    await node.click();
    await page.keyboard.press('Enter');
    await expect(page.locator('.dc-node-editor')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.dc-node-editor')).toHaveCount(0);

    // A single selected edge.
    const nodeA = (await page.locator('.dc-node').nth(0).boundingBox())!;
    const nodeB = (await page.locator('.dc-node').nth(1).boundingBox())!;
    await page.mouse.click(
      (nodeA.x + nodeA.width + nodeB.x) / 2,
      (nodeA.y + nodeA.height / 2 + nodeB.y + nodeB.height / 2) / 2,
    );
    await expect(page.locator('.dc-edge[data-selected="true"]')).toHaveCount(1);
    await page.keyboard.press('Enter');
    await expect(page.locator('.dc-edge-label-input')).toBeVisible();
    await page.keyboard.press('Escape');

    // Multi-selection: no-op.
    await page.keyboard.press('Meta+a');
    await page.keyboard.press('Enter');
    await expect(page.locator('.dc-node-editor')).toHaveCount(0);

    // A boundary (group) node: no-op.
    await page.getByRole('button', { name: 'Group', exact: true }).click();
    // Click in the boundary's own padding, clear of the connector running
    // between its two contained nodes (which would otherwise intercept a
    // click at the node's default centre point).
    await page.locator('.dc-node[data-type="group"]').click({ position: { x: 8, y: 8 } });
    await page.keyboard.press('Enter');
    await expect(page.locator('.dc-node-editor')).toHaveCount(0);
  });

  test('a connector selects even when clicked a few pixels off its visible line', async ({ page }) => {
    await newCanvas(page, 'Wide hit target');
    await create(page, 'Service', { x: 300, y: 250 });
    await create(page, 'Data Store', { x: 600, y: 250 });
    await connect(page, 0, 1);

    const nodeA = (await page.locator('.dc-node').nth(0).boundingBox())!;
    const nodeB = (await page.locator('.dc-node').nth(1).boundingBox())!;
    const midX = (nodeA.x + nodeA.width + nodeB.x) / 2;
    const midY = (nodeA.y + nodeA.height / 2 + nodeB.y + nodeB.height / 2) / 2;

    // The visible stroke is under 3px wide; 6px off its centre lands well
    // outside it but safely inside `BaseEdge`'s invisible `interactionWidth`
    // corridor (Chromium's own stroke hit-testing gives that a little less
    // than the raw 18px prop value, but comfortably more than 6px either side).
    await page.mouse.click(midX, midY - 6);
    await expect(page.locator('.dc-edge[data-selected="true"]')).toHaveCount(1);
  });

  test('Enter never starts editing while an attachment popover is open, and picks the highlighted row of an open Quick Connect menu', async ({
    page,
  }) => {
    await newCanvas(page, 'Keyboard enter overlays');
    await create(page, 'Service', { x: 300, y: 300 });
    await create(page, 'Code', { x: 700, y: 300 });

    // Attach the code card so there is a populated attachment popover.
    const service = page.locator('.dc-node[data-type="service"]');
    const code = page.locator('.dc-node[data-type="code"]');
    const serviceBox = (await service.boundingBox())!;
    const codeBox = (await code.boundingBox())!;
    await page.mouse.move(codeBox.x + codeBox.width / 2, codeBox.y + codeBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(serviceBox.x + serviceBox.width / 2, serviceBox.y + serviceBox.height / 2, {
      steps: 12,
    });
    await page.mouse.up();
    await expect(page.locator('.dc-attachment-badge')).toHaveCount(1);

    // The badge is visible regardless of selection — click it directly
    // rather than selecting the node first, which would show its resize
    // handles overlapping the same corner.
    const badge = page.locator('.dc-attachment-badge');
    await badge.click();
    await expect(page.locator('.dc-attachment-popover')).toBeVisible();
    // The badge is a native <button> and stays focused after the click — an
    // unrelated browser default (Enter activates a focused button) would
    // otherwise re-toggle it closed itself, which is not what this test
    // means to exercise.
    await badge.evaluate((el) => (el as HTMLElement).blur());

    await page.keyboard.press('Enter');
    await expect(page.locator('.dc-node-editor')).toHaveCount(0);
    await expect(page.locator('.dc-attachment-popover')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.dc-attachment-popover')).toHaveCount(0);

    // Quick Connect menu open — select first, then open the menu without any
    // further click (which would dismiss it as a click outside the menu).
    await service.click();
    await service.hover();
    const handle = (await service.locator('.dc-handle').nth(1).boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + 260, handle.y + 40, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator('.dc-quick-connect')).toBeVisible();

    // The menu owns Enter: it takes the highlighted row (the first — a Service, since nothing is
    // suggested for a plain Service) rather than opening any editor behind it.
    await page.keyboard.press('Enter');
    await expect(page.locator('.dc-node-editor')).toHaveCount(0);
    await expect(page.locator('.dc-quick-connect')).toBeHidden();
    await expect(page.locator('.dc-node[data-type="service"]')).toHaveCount(2);
  });
});

/** The selected connector's source (0) or target (1) endpoint handle. */
async function endpointBox(page: Page, which: 0 | 1) {
  return (await page.locator('.dc-edge-endpoint').nth(which).boundingBox())!;
}

test.describe('reconnection', () => {
  test('the connector visibly follows the pointer while an endpoint is being dragged', async ({ page }) => {
    await newCanvas(page, 'Live drag preview');
    await create(page, 'Service', { x: 300, y: 200 });
    await create(page, 'Data Store', { x: 600, y: 200 });
    await connect(page, 0, 1);

    const nodeA = (await page.locator('.dc-node').nth(0).boundingBox())!;
    const nodeB = (await page.locator('.dc-node').nth(1).boundingBox())!;
    await page.mouse.click(
      (nodeA.x + nodeA.width + nodeB.x) / 2,
      (nodeA.y + nodeA.height / 2 + nodeB.y + nodeB.height / 2) / 2,
    );
    await expect(page.locator('.dc-edge[data-selected="true"]')).toHaveCount(1);

    const pathBefore = await page.locator('.dc-edge-line').getAttribute('d');
    const target = await endpointBox(page, 1);
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
    await page.mouse.down();
    // Move partway, well short of any drop target — the path should already
    // be tracking the pointer before the gesture ends.
    await page.mouse.move(target.x + 60, target.y + 180, { steps: 5 });
    await expect(page.locator('.dc-edge-line')).not.toHaveAttribute('d', pathBefore ?? '');

    // Released over empty canvas: a no-op, so the path returns to normal.
    await page.mouse.up();
    await expect(page.locator('.dc-edge-line')).toHaveAttribute('d', pathBefore ?? '');
  });

  test('dragging the target endpoint moves it to a different node and reroutes', async ({ page }) => {
    await newCanvas(page, 'Reconnect target');
    await create(page, 'Service', { x: 300, y: 200 });
    await create(page, 'Data Store', { x: 600, y: 200 });
    await create(page, 'Queue', { x: 600, y: 450 });
    await connect(page, 0, 1);

    const nodeA = (await page.locator('.dc-node').nth(0).boundingBox())!;
    const nodeB = (await page.locator('.dc-node').nth(1).boundingBox())!;
    await page.mouse.click(
      (nodeA.x + nodeA.width + nodeB.x) / 2,
      (nodeA.y + nodeA.height / 2 + nodeB.y + nodeB.height / 2) / 2,
    );
    await expect(page.locator('.dc-edge[data-selected="true"]')).toHaveCount(1);
    await expect(page.locator('.dc-edge-endpoint')).toHaveCount(2);

    const target = await endpointBox(page, 1);
    const queue = (await page.locator('.dc-node').nth(2).boundingBox())!;
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
    await page.mouse.down();
    await page.mouse.move(queue.x + queue.width / 2, queue.y + queue.height / 2, { steps: 10 });
    await page.mouse.up();

    // Reconnected onto the queue: the relationship is freshly inferred as an
    // event publish, and there's still exactly one connector (moved, not duplicated).
    await expect(page.locator('.dc-edge')).toHaveCount(1);
    const select = page.getByRole('button', { name: 'Interaction type' });
    await expect(select).toHaveText('Publishes');
  });

  test('dragging an endpoint to a different side of the same node keeps the same connection', async ({
    page,
  }) => {
    await newCanvas(page, 'Reconnect same node');
    await create(page, 'Service', { x: 300, y: 300 });
    await create(page, 'Data Store', { x: 650, y: 300 });
    await connect(page, 0, 1);

    const nodeA = (await page.locator('.dc-node').nth(0).boundingBox())!;
    const nodeB = (await page.locator('.dc-node').nth(1).boundingBox())!;
    await page.mouse.click(
      (nodeA.x + nodeA.width + nodeB.x) / 2,
      (nodeA.y + nodeA.height / 2 + nodeB.y + nodeB.height / 2) / 2,
    );
    await expect(page.locator('.dc-edge[data-selected="true"]')).toHaveCount(1);

    const target = await endpointBox(page, 1);
    // Drop on the same node's bottom edge instead of its left side.
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
    await page.mouse.down();
    await page.mouse.move(nodeB.x + nodeB.width / 2, nodeB.y + nodeB.height - 4, { steps: 10 });
    await page.mouse.up();

    await expect(page.locator('.dc-node')).toHaveCount(2);
    await expect(page.locator('.dc-edge')).toHaveCount(1);
    // Still the same two nodes connected — a same-node re-side, not a new edge.
    await expect(page.locator('.dc-edge[data-selected="true"]')).toHaveCount(1);
  });

  test('Escape cancels an in-flight reconnect and restores the original connection', async ({ page }) => {
    await newCanvas(page, 'Reconnect escape');
    await create(page, 'Service', { x: 300, y: 200 });
    await create(page, 'Data Store', { x: 600, y: 200 });
    await create(page, 'Queue', { x: 600, y: 450 });
    await connect(page, 0, 1);

    const nodeA = (await page.locator('.dc-node').nth(0).boundingBox())!;
    const nodeB = (await page.locator('.dc-node').nth(1).boundingBox())!;
    await page.mouse.click(
      (nodeA.x + nodeA.width + nodeB.x) / 2,
      (nodeA.y + nodeA.height / 2 + nodeB.y + nodeB.height / 2) / 2,
    );
    await expect(page.locator('.dc-edge[data-selected="true"]')).toHaveCount(1);

    const target = await endpointBox(page, 1);
    const queue = (await page.locator('.dc-node').nth(2).boundingBox())!;
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
    await page.mouse.down();
    await page.mouse.move(queue.x + queue.width / 2, queue.y + queue.height / 2, { steps: 10 });
    await page.keyboard.press('Escape');
    await page.mouse.up();

    // Escape's usual, app-wide effect also clears the selection — but the
    // connection itself is what this test cares about: still exactly one,
    // and still the original Service → Database pair, never reassigned to
    // the Queue mid-drag.
    await expect(page.locator('.dc-edge')).toHaveCount(1);
    await page.mouse.click(
      (nodeA.x + nodeA.width + nodeB.x) / 2,
      (nodeA.y + nodeA.height / 2 + nodeB.y + nodeB.height / 2) / 2,
    );
    // Still the original Service → Database pair, which infers `writes`.
    const select = page.getByRole('button', { name: 'Interaction type' });
    await expect(select).toHaveText('Writes');
  });

  test('dropping a reconnect on empty canvas leaves the original connection intact', async ({ page }) => {
    await newCanvas(page, 'Reconnect invalid drop');
    await create(page, 'Service', { x: 300, y: 200 });
    await create(page, 'Data Store', { x: 600, y: 200 });
    await connect(page, 0, 1);

    const nodeA = (await page.locator('.dc-node').nth(0).boundingBox())!;
    const nodeB = (await page.locator('.dc-node').nth(1).boundingBox())!;
    await page.mouse.click(
      (nodeA.x + nodeA.width + nodeB.x) / 2,
      (nodeA.y + nodeA.height / 2 + nodeB.y + nodeB.height / 2) / 2,
    );
    await expect(page.locator('.dc-edge[data-selected="true"]')).toHaveCount(1);

    const target = await endpointBox(page, 1);
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + 300, target.y + 250, { steps: 10 });
    await page.mouse.up();

    // Empty canvas: a clean no-op — unlike drawing a brand-new connection,
    // reconnecting an existing one to nothing doesn't offer a Quick Connect
    // picker, it just leaves the original connection exactly as it was.
    await expect(page.locator('.dc-quick-connect')).toHaveCount(0);
    await expect(page.locator('.dc-edge')).toHaveCount(1);
    await expect(page.locator('.dc-node')).toHaveCount(2);
    await page.mouse.click(
      (nodeA.x + nodeA.width + nodeB.x) / 2,
      (nodeA.y + nodeA.height / 2 + nodeB.y + nodeB.height / 2) / 2,
    );
    // Still the original Service → Database pair, which infers `writes`.
    const select = page.getByRole('button', { name: 'Interaction type' });
    await expect(select).toHaveText('Writes');
  });

  test('a reconnect is one undo step and restores the exact prior connection', async ({ page }) => {
    await newCanvas(page, 'Reconnect undo');
    await create(page, 'Service', { x: 300, y: 200 });
    await create(page, 'Data Store', { x: 600, y: 200 });
    await create(page, 'Queue', { x: 600, y: 450 });
    await connect(page, 0, 1);

    const nodeA = (await page.locator('.dc-node').nth(0).boundingBox())!;
    const nodeB = (await page.locator('.dc-node').nth(1).boundingBox())!;
    await page.mouse.click(
      (nodeA.x + nodeA.width + nodeB.x) / 2,
      (nodeA.y + nodeA.height / 2 + nodeB.y + nodeB.height / 2) / 2,
    );
    const target = await endpointBox(page, 1);
    const queue = (await page.locator('.dc-node').nth(2).boundingBox())!;
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
    await page.mouse.down();
    await page.mouse.move(queue.x + queue.width / 2, queue.y + queue.height / 2, { steps: 10 });
    await page.mouse.up();

    const select = page.getByRole('button', { name: 'Interaction type' });
    await expect(select).toHaveText('Publishes');
    // Belt-and-braces: the app's own global shortcut guard (deliberately) ignores Meta+Z while
    // an INPUT/TEXTAREA/SELECT is focused, so make sure the select isn't before relying on undo.
    await select.blur();

    await page.keyboard.press('Meta+z');
    // Back to the original Service → Database connection, which infers `writes`.
    await expect(page.locator('.dc-edge[data-selected="true"]')).toHaveCount(1);
    await expect(select).toHaveText('Writes');
  });

  test('a plain click on an endpoint never reconnects it — only an actual drag does', async ({ page }) => {
    await newCanvas(page, 'Endpoint click is not a drag');
    await create(page, 'Service', { x: 300, y: 200 });
    await create(page, 'Data Store', { x: 600, y: 200 });
    await connect(page, 0, 1);

    const nodeA = (await page.locator('.dc-node').nth(0).boundingBox())!;
    const nodeB = (await page.locator('.dc-node').nth(1).boundingBox())!;
    await page.mouse.click(
      (nodeA.x + nodeA.width + nodeB.x) / 2,
      (nodeA.y + nodeA.height / 2 + nodeB.y + nodeB.height / 2) / 2,
    );
    await expect(page.locator('.dc-edge[data-selected="true"]')).toHaveCount(1);
    const pathBefore = await page.locator('.dc-edge-line').getAttribute('d');

    // `page.mouse.click` moves to the point and fires down/up with no
    // movement in between — the plain-click case a real trackpad or mouse
    // always has a pixel or two of jitter on, which is exactly what the
    // drag threshold in `EdgeEndpointHandle` exists to absorb.
    const target = await endpointBox(page, 1);
    await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);

    await expect(page.locator('.dc-edge')).toHaveCount(1);
    await expect(page.locator('.dc-edge-line')).toHaveAttribute('d', pathBefore ?? '');
  });
});
