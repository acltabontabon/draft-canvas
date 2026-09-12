import { expect, test, type Page } from '@playwright/test';

/** The right-click contextual menu — empty canvas, a single node, and multi-selection. */

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

/** Drags from a node's right-hand handle onto another node — same recipe as `editing.spec.ts`. */
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

const menu = (page: Page) => page.locator('.dc-context-menu');
const menuItem = (page: Page, title: string) => menu(page).getByRole('menuitem', { name: title });

test.describe('context menu — empty canvas', () => {
  test('opens at the click point with every preset, no native menu, no pan', async ({ page }) => {
    await newCanvas(page, 'Context menu pane');
    const viewportBefore = await page.locator('.react-flow__viewport').evaluate((el) => el.style.transform);

    await page.locator('.react-flow__pane').click({ button: 'right', position: { x: 400, y: 300 } });
    await expect(menu(page)).toBeVisible();
    for (const title of ['Add Text', 'Add Note', 'Add Code', 'Add Boundary', 'Add Service', 'Add Data Store', 'Add Queue', 'Add Actor', 'Add Junction']) {
      await expect(menuItem(page, title)).toBeVisible();
    }
    // Paste is always offered (the OS clipboard is only checked once clicked); Select all is
    // correctly absent — there's nothing to select on a genuinely empty document.
    await expect(menuItem(page, 'Paste')).toBeVisible();
    await expect(menuItem(page, 'Select all')).toHaveCount(0);

    const viewportAfter = await page.locator('.react-flow__viewport').evaluate((el) => el.style.transform);
    expect(viewportAfter).toBe(viewportBefore);
  });

  test('Select all appears once a node exists', async ({ page }) => {
    await newCanvas(page, 'Context menu select all');
    await create(page, 'Service', { x: 400, y: 300 });
    await page.keyboard.press('Escape');
    await page.locator('.react-flow__pane').click({ button: 'right', position: { x: 100, y: 100 } });
    await expect(menuItem(page, 'Select all')).toBeVisible();
    await menuItem(page, 'Select all').click();
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(1);
  });

  test('Escape closes it without changing anything', async ({ page }) => {
    await newCanvas(page, 'Context menu escape');
    await page.locator('.react-flow__pane').click({ button: 'right', position: { x: 400, y: 300 } });
    await expect(menu(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect(page.locator('.dc-node')).toHaveCount(0);
  });

  test('a click outside closes it', async ({ page }) => {
    await newCanvas(page, 'Context menu outside click');
    await page.locator('.react-flow__pane').click({ button: 'right', position: { x: 400, y: 300 } });
    await expect(menu(page)).toBeVisible();
    await page.locator('.react-flow__pane').click({ position: { x: 100, y: 500 } });
    await expect(menu(page)).toBeHidden();
  });

  test('Add Boundary creates a group node roughly centered on the click point', async ({ page }) => {
    await newCanvas(page, 'Context menu add boundary');
    await page.locator('.react-flow__pane').click({ button: 'right', position: { x: 400, y: 300 } });
    await menuItem(page, 'Add Boundary').click();
    await expect(menu(page)).toBeHidden();
    await expect(page.locator('.dc-node[data-type="group"]')).toHaveCount(1);
    await expect(page.locator('.dc-node[data-type="group"][data-selected="true"]')).toHaveCount(1);
  });

  test('Paste appears after a copy and lands exactly at the click point', async ({ page }) => {
    await newCanvas(page, 'Context menu paste');
    await create(page, 'Service', { x: 300, y: 200 });
    await page.locator('.dc-node').first().click();
    await page.keyboard.press('ControlOrMeta+c');

    // `.click({position})` is relative to the pane element's own box, not the page — comparing
    // against that same box's origin (rather than a bare page-absolute number) is what keeps this
    // correct regardless of any chrome (a toolbar, say) offsetting the pane from the page origin.
    const paneBox = (await page.locator('.react-flow__pane').boundingBox())!;
    const clickAt = { x: 550, y: 400 };
    await page.locator('.react-flow__pane').click({ button: 'right', position: clickAt });
    await expect(menuItem(page, 'Paste')).toBeVisible();
    await menuItem(page, 'Paste').click();
    await expect(menu(page)).toBeHidden();
    // First-ever explicit Paste on a fresh profile: the pre-permission dialog asks before Draft
    // Canvas ever calls `navigator.clipboard.readText()`. Either answer still pastes — the
    // in-memory clipboard from the `ControlOrMeta+c` above already has the fragment — so "Not now"
    // is enough to exercise the fallback without needing a real OS clipboard grant.
    await page.getByRole('button', { name: 'Not now' }).click();
    await expect(page.locator('.dc-node')).toHaveCount(2);

    const pasted = page.locator('.dc-node').nth(1);
    const box = (await pasted.boundingBox())!;
    expect(box.x + box.width / 2).toBeCloseTo(paneBox.x + clickAt.x, -1);
    expect(box.y + box.height / 2).toBeCloseTo(paneBox.y + clickAt.y, -1);
  });

  test('the pre-permission dialog asks once, then Paste remembers the answer', async ({ page, context }) => {
    // Pre-granting here stands in for the user answering the browser's own native prompt — it's
    // Draft Canvas's own dialog, not this grant, that's under test: does it appear before the read,
    // and does it stay answered.
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await newCanvas(page, 'Context menu paste permission');
    await create(page, 'Service', { x: 300, y: 200 });
    await page.locator('.dc-node').first().click();
    await page.keyboard.press('ControlOrMeta+c');

    await page.locator('.react-flow__pane').click({ button: 'right', position: { x: 500, y: 400 } });
    await menuItem(page, 'Paste').click();
    await expect(menu(page)).toBeHidden();
    await expect(page.getByRole('alertdialog', { name: 'Paste from your clipboard?' })).toBeVisible();
    await page.getByRole('button', { name: 'Allow clipboard access' }).click();
    await expect(page.locator('.dc-node')).toHaveCount(2);

    // A second explicit Paste no longer shows the dialog — the answer was remembered.
    await page.locator('.react-flow__pane').click({ button: 'right', position: { x: 700, y: 400 } });
    await menuItem(page, 'Paste').click();
    await expect(menu(page)).toBeHidden();
    await expect(page.getByRole('alertdialog')).toHaveCount(0);
    await expect(page.locator('.dc-node')).toHaveCount(3);
  });

  test('the native menu is preserved inside the command palette search box', async ({ page }) => {
    await newCanvas(page, 'Context menu native preserved');
    await page.keyboard.press('ControlOrMeta+k');
    const input = page.getByRole('textbox', { name: 'Search commands' });
    await expect(input).toBeVisible();
    await input.click({ button: 'right' });
    await expect(menu(page)).toHaveCount(0);
  });
});

test.describe('context menu — a single node', () => {
  test('right-clicking an unselected node selects it and opens its menu', async ({ page }) => {
    await newCanvas(page, 'Context menu node select');
    await create(page, 'Service', { x: 400, y: 300 });
    await page.keyboard.press('Escape'); // clear the selection creation left behind
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(0);

    await page.locator('.dc-node').first().click({ button: 'right' });
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(1);
    for (const title of ['Edit text', 'Add Note', 'Add Code', 'Duplicate', 'Copy', 'Cut', 'Bring to front', 'Bring forward', 'Send backward', 'Send to back', 'Spotlight selection', 'Delete']) {
      await expect(menuItem(page, title)).toBeVisible();
    }
  });

  test('Add Note attaches a note and opens its card', async ({ page }) => {
    await newCanvas(page, 'Context menu add note');
    await create(page, 'Service', { x: 400, y: 300 });
    await page.locator('.dc-node').first().click({ button: 'right' });
    await menuItem(page, 'Add Note').click();
    await expect(menu(page)).toBeHidden();
    await expect(page.locator('.dc-attachment-chip')).toHaveCount(1);
    await expect(page.locator('.dc-attachment-card[data-pinned="true"]')).toBeVisible();
    // One click from editing — see `addAttachmentCommand`'s own comment for why this doesn't also
    // force the card's separate `editing` state open.
    await page.getByRole('button', { name: 'Edit attached detail' }).click();
    await expect(page.locator('.dc-attachment-card textarea')).toBeFocused();
  });

  test('Bring to front changes stacking order, undoably', async ({ page }) => {
    await newCanvas(page, 'Context menu z-order');
    await create(page, 'Service', { x: 300, y: 300 });
    await create(page, 'Data Store', { x: 600, y: 300 });

    // Reads the document model directly rather than inferring z-order from rendered paint order —
    // a *selected* node gets its own separate visual "float to top" treatment independent of the
    // document's `z` field, which would otherwise confound a paint-order-based check right after
    // the right-click below selects Service.
    const zOf = (type: string) =>
      page.evaluate(async (t) => {
        const mod = await import('/src/store/editorStore.ts');
        return mod.useEditorStore.getState().document.nodes.find((n: { type: string }) => n.type === t)?.z;
      }, type);

    const [serviceZBefore, dbZBefore] = [await zOf('service'), await zOf('database')];
    expect(serviceZBefore).toBe(dbZBefore); // both freshly created, no z-order applied yet

    await page.locator('.dc-node[data-type="service"]').click({ button: 'right' });
    await menuItem(page, 'Bring to front').click();
    await expect(menu(page)).toBeHidden();
    expect(await zOf('service')).toBeGreaterThan((await zOf('database'))!);

    await page.keyboard.press('ControlOrMeta+z');
    expect(await zOf('service')).toBe(serviceZBefore);
    expect(await zOf('database')).toBe(dbZBefore);
  });

  test('the native menu is preserved while editing a node\'s text', async ({ page }) => {
    await newCanvas(page, 'Context menu native in editor');
    await create(page, 'Service', { x: 400, y: 300 });
    const node = page.locator('.dc-node').first();
    await node.dblclick();
    const editor = node.locator('textarea.dc-node-editor');
    await expect(editor).toBeFocused();
    await editor.click({ button: 'right' });
    await expect(menu(page)).toHaveCount(0);
  });
});

test.describe('context menu — multi-selection', () => {
  test('right-clicking a node already in a multi-selection preserves the whole selection', async ({ page }) => {
    await newCanvas(page, 'Context menu multi preserve');
    await create(page, 'Service', { x: 250, y: 200 });
    await create(page, 'Data Store', { x: 250, y: 400 });
    // Data Store (nth 1) is already selected alone, fresh off its own creation — shift-clicking the
    // *other* node (nth 0) is what grows the selection to both, rather than toggling it back off.
    await page.locator('.dc-node').nth(0).click({ modifiers: ['Shift'] });
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(2);

    await page.locator('.dc-node').first().click({ button: 'right' });
    // The multi-selection menu doesn't exist yet (a later phase) — the important assertion here is
    // that the selection itself is never collapsed to just the clicked node by the right-click.
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(2);
  });

  test('right-clicking a node NOT in the current multi-selection replaces it', async ({ page }) => {
    await newCanvas(page, 'Context menu multi replace');
    await create(page, 'Service', { x: 250, y: 200 });
    await create(page, 'Data Store', { x: 250, y: 400 });
    await create(page, 'Actor', { x: 550, y: 300 });
    // Actor (nth 2) is selected alone, fresh off its own creation — shift-clicking Service (nth 0)
    // grows the selection to {Actor, Service}, leaving Data Store (nth 1) genuinely outside it.
    await page.locator('.dc-node').nth(0).click({ modifiers: ['Shift'] });
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(2);

    await page.locator('.dc-node').nth(1).click({ button: 'right' });
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(1);
  });
});

test.describe('context menu — an edge', () => {
  async function edgeMidpoint(page: Page) {
    const a = (await page.locator('.dc-node').nth(0).boundingBox())!;
    const b = (await page.locator('.dc-node').nth(1).boundingBox())!;
    return { x: (a.x + a.width + b.x) / 2, y: (a.y + a.height / 2 + b.y + b.height / 2) / 2 };
  }

  test('right-clicking an edge selects it and opens its menu', async ({ page }) => {
    await newCanvas(page, 'Context menu edge select');
    await create(page, 'Service', { x: 300, y: 250 });
    await create(page, 'Data Store', { x: 600, y: 250 });
    await connect(page, 0, 1);
    await page.keyboard.press('Escape');
    await expect(page.locator('.dc-edge[data-selected="true"]')).toHaveCount(0);

    const mid = await edgeMidpoint(page);
    await page.mouse.click(mid.x, mid.y, { button: 'right' });
    await expect(page.locator('.dc-edge[data-selected="true"]')).toHaveCount(1);
    for (const title of ['Edit label', 'Reverse direction', 'Add Note', 'Add Code', 'Spotlight selection', 'Delete connector']) {
      await expect(menuItem(page, title)).toBeVisible();
    }
    // Stage-returning commands never appear in a context menu — see the "stage-command rule".
    for (const title of ['Change relationship…', 'Change kind…', 'Reconnect source…', 'Reconnect target…', 'Add to flow…']) {
      await expect(menuItem(page, title)).toHaveCount(0);
    }
  });

  test('Reverse direction flips the arrow and re-infers the semantic, undoably', async ({ page }) => {
    await newCanvas(page, 'Context menu reverse');
    await create(page, 'Service', { x: 300, y: 250 });
    await create(page, 'Data Store', { x: 600, y: 250 });
    await connect(page, 0, 1);

    const before = await page.evaluate(async () => {
      const mod = await import('/src/store/editorStore.ts');
      const e = mod.useEditorStore.getState().document.edges[0]!;
      return { source: e.source, semantic: e.semantic };
    });
    expect(before.semantic).toBe('writes'); // Service → Data Store infers "writes"

    const mid = await edgeMidpoint(page);
    await page.mouse.click(mid.x, mid.y, { button: 'right' });
    await menuItem(page, 'Reverse direction').click();
    await expect(menu(page)).toBeHidden();

    const after = await page.evaluate(async () => {
      const mod = await import('/src/store/editorStore.ts');
      const e = mod.useEditorStore.getState().document.edges[0]!;
      return { source: e.source, target: e.target, semantic: e.semantic };
    });
    expect(after.source).not.toBe(before.source);
    expect(after.semantic).toBe('reads'); // Data Store → Service re-infers "reads"

    await page.keyboard.press('ControlOrMeta+z');
    const reverted = await page.evaluate(async () => {
      const mod = await import('/src/store/editorStore.ts');
      const e = mod.useEditorStore.getState().document.edges[0]!;
      return { source: e.source, semantic: e.semantic };
    });
    expect(reverted).toEqual(before);
  });

  test('the native menu is preserved while editing an edge label', async ({ page }) => {
    await newCanvas(page, 'Context menu edge native');
    await create(page, 'Service', { x: 300, y: 250 });
    await create(page, 'Data Store', { x: 600, y: 250 });
    await connect(page, 0, 1);
    const mid = await edgeMidpoint(page);
    await page.mouse.click(mid.x, mid.y);
    await page.keyboard.press('Enter');
    const input = page.locator('.dc-edge-label-input');
    await expect(input).toBeFocused();
    await input.click({ button: 'right' });
    await expect(menu(page)).toHaveCount(0);
  });
});

test.describe('context menu — a boundary', () => {
  test('right-clicking an empty boundary hides Select Contents; a populated one shows it and it selects the members', async ({ page }) => {
    await newCanvas(page, 'Context menu boundary');
    await create(page, 'Service', { x: 300, y: 250 });
    await create(page, 'Data Store', { x: 550, y: 250 });
    await page.locator('.dc-node').first().click();
    await page.locator('.dc-node').nth(1).click({ modifiers: ['Shift'] });
    await page.getByRole('button', { name: 'Group', exact: true }).click();
    await expect(page.locator('.dc-node[data-type="group"]')).toHaveCount(1);

    // Click in the boundary's own empty padding, clear of its contained nodes.
    const boundary = page.locator('.dc-node[data-type="group"]');
    await boundary.click({ button: 'right', position: { x: 8, y: 8 } });
    for (const title of ['Edit caption', 'Add Note', 'Add Code', 'Duplicate', 'Copy', 'Cut', 'Bring to front', 'Ungroup', 'Delete']) {
      await expect(menuItem(page, title)).toBeVisible();
    }
    await expect(menuItem(page, 'Select Contents')).toBeVisible();
    await menuItem(page, 'Select Contents').click();
    await expect(menu(page)).toBeHidden();
    // The two members are selected, not the boundary itself.
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(2);
    await expect(page.locator('.dc-node[data-type="group"][data-selected="true"]')).toHaveCount(0);
  });

  test('Select Contents is absent on an empty boundary', async ({ page }) => {
    await newCanvas(page, 'Context menu empty boundary');
    await create(page, 'Service', { x: 300, y: 250 });
    await create(page, 'Data Store', { x: 550, y: 250 });
    await page.locator('.dc-node').first().click();
    await page.locator('.dc-node').nth(1).click({ modifiers: ['Shift'] });
    await page.getByRole('button', { name: 'Group', exact: true }).click();
    // Ungroup, leaving an empty boundary behind is awkward to set up via the UI directly — instead,
    // drag the two members back out from under a *second*, freshly-created empty boundary.
    const empty = await page.evaluate(async () => {
      const mod = await import('/src/store/editorStore.ts');
      const node = mod.useEditorStore.getState().addNode({ type: 'group', x: 900, y: 900, width: 200, height: 150 });
      return node.id;
    });
    await page.keyboard.press('Shift+1'); // fit-to-view, so the newly added boundary is on screen
    await page.locator(`[data-id="${empty}"]`).click({ button: 'right' });
    await expect(menuItem(page, 'Select Contents')).toHaveCount(0);
  });
});

test.describe('context menu — multi-selection contents and commands', () => {
  test('2 nodes: Align but not Distribute; 3+ nodes: both', async ({ page }) => {
    await newCanvas(page, 'Context menu multi align');
    await create(page, 'Service', { x: 250, y: 200 });
    await create(page, 'Data Store', { x: 550, y: 200 });
    await page.locator('.dc-node').nth(0).click({ modifiers: ['Shift'] });
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(2);

    await page.locator('.dc-node').first().click({ button: 'right' });
    await expect(menuItem(page, 'Align left')).toBeVisible();
    await expect(menuItem(page, 'Distribute horizontally')).toHaveCount(0);
    await page.keyboard.press('Escape');

    await create(page, 'Actor', { x: 400, y: 450 });
    await page.locator('.dc-node').nth(0).click();
    await page.locator('.dc-node').nth(1).click({ modifiers: ['Shift'] });
    await page.locator('.dc-node').nth(2).click({ modifiers: ['Shift'] });
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(3);
    await page.locator('.dc-node').first().click({ button: 'right' });
    await expect(menuItem(page, 'Align left')).toBeVisible();
    await expect(menuItem(page, 'Distribute horizontally')).toBeVisible();
  });

  test('the Inspector bar\'s own Distribute buttons match the same ≥3 gate (regression check for the bundled fix)', async ({ page }) => {
    await newCanvas(page, 'Inspector distribute gate');
    await create(page, 'Service', { x: 250, y: 200 });
    await create(page, 'Data Store', { x: 550, y: 200 });
    await page.locator('.dc-node').nth(0).click({ modifiers: ['Shift'] });
    await expect(page.locator('.dc-inspector')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Distribute ↔' })).toHaveCount(0);

    await create(page, 'Actor', { x: 400, y: 450 });
    await page.locator('.dc-node').nth(0).click();
    await page.locator('.dc-node').nth(1).click({ modifiers: ['Shift'] });
    await page.locator('.dc-node').nth(2).click({ modifiers: ['Shift'] });
    await expect(page.getByRole('button', { name: 'Distribute ↔' })).toBeVisible();
  });

  test('an edges-only multi-selection shows only Spotlight and Delete', async ({ page }) => {
    await newCanvas(page, 'Context menu multi edges only');
    await create(page, 'Service', { x: 250, y: 200 });
    await create(page, 'Data Store', { x: 550, y: 200 });
    await create(page, 'Queue', { x: 250, y: 450 });
    // Connecting and selecting both via the store directly — what's under test here is the menu's
    // own curation for an edges-only selection, not the drag-to-connect or click-to-select gestures
    // (already covered elsewhere); this also sidesteps needing an exact click point on a
    // `smoothstep`-bent path for a second connector reached via a repeat drag from the same handle.
    await page.evaluate(async () => {
      const mod = await import('/src/store/editorStore.ts');
      const state = mod.useEditorStore.getState();
      const [service, dataStore, queue] = state.document.nodes;
      const e1 = state.connect(service!.id, dataStore!.id)!;
      const e2 = state.connect(service!.id, queue!.id)!;
      state.setSelection({ nodes: [], edges: [e1.id, e2.id] });
    });
    await expect(page.locator('.dc-edge[data-selected="true"]')).toHaveCount(2);

    // The true rendered-path midpoint of the first connector, not a node-box average —
    // `smoothstep` routing bends through an intermediate run once two nodes differ enough in
    // height, which a naive box-center average misses; this is robust to any routing shape.
    const mid = await page.locator('.dc-edge-line').first().evaluate((el: SVGPathElement) => {
      const point = el.getPointAtLength(el.getTotalLength() / 2);
      const screenPoint = point.matrixTransform(el.getScreenCTM()!);
      return { x: screenPoint.x, y: screenPoint.y };
    });
    await page.mouse.click(mid.x, mid.y, { button: 'right' });
    await expect(menuItem(page, 'Spotlight selection')).toBeVisible();
    await expect(menuItem(page, 'Delete selection')).toBeVisible();
    await expect(menu(page).getByRole('menuitem')).toHaveCount(2);
  });

  test('Group into boundary, then Ungroup, both from the menu', async ({ page }) => {
    await newCanvas(page, 'Context menu multi group');
    await create(page, 'Service', { x: 250, y: 200 });
    await create(page, 'Data Store', { x: 550, y: 200 });
    await page.locator('.dc-node').nth(0).click({ modifiers: ['Shift'] });
    await page.locator('.dc-node').first().click({ button: 'right' });
    await menuItem(page, 'Group into boundary').click();
    await expect(page.locator('.dc-node[data-type="group"]')).toHaveCount(1);

    await page.locator('.dc-node[data-type="group"]').click({ button: 'right', position: { x: 8, y: 8 } });
    await menuItem(page, 'Ungroup').click();
    await expect(page.locator('.dc-node[data-type="group"]')).toHaveCount(0);
  });
});

test.describe('context menu — keyboard-only operation', () => {
  test('Shift+F10 opens the selected node\'s menu; arrows navigate; Enter runs the highlighted item', async ({ page }) => {
    await newCanvas(page, 'Context menu keyboard');
    await create(page, 'Service', { x: 400, y: 300 });
    await page.locator('.dc-node').first().click();

    await page.keyboard.press('Shift+F10');
    await expect(menu(page)).toBeVisible();
    await expect(menuItem(page, 'Edit text')).toBeVisible();

    // Down twice from the first item lands on Add Code (Edit text, Add Note, Add Code, …).
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(menu(page)).toBeHidden();
    await expect(page.locator('.dc-attachment-chip[data-kind="code"]')).toHaveCount(1);
  });

  test('the Menu/ContextMenu key does the same as Shift+F10', async ({ page }) => {
    await newCanvas(page, 'Context menu key');
    await create(page, 'Service', { x: 400, y: 300 });
    await page.locator('.dc-node').first().click();
    await page.keyboard.press('ContextMenu');
    await expect(menu(page)).toBeVisible();
  });

  test('Escape closes the keyboard-opened menu with no change', async ({ page }) => {
    await newCanvas(page, 'Context menu keyboard escape');
    await create(page, 'Service', { x: 400, y: 300 });
    await page.locator('.dc-node').first().click();
    await page.keyboard.press('Shift+F10');
    await expect(menu(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect(page.locator('.dc-node')).toHaveCount(1);
  });

  test('is a no-op with nothing selected — there is no keyboard equivalent of a click point on empty canvas', async ({ page }) => {
    await newCanvas(page, 'Context menu keyboard empty');
    await create(page, 'Service', { x: 400, y: 300 });
    await page.keyboard.press('Escape'); // clear the selection creation left behind
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(0);
    await page.keyboard.press('Shift+F10');
    await expect(menu(page)).toHaveCount(0);
  });

  test('anchors to the selection bounds for a multi-selection', async ({ page }) => {
    await newCanvas(page, 'Context menu keyboard multi');
    await create(page, 'Service', { x: 250, y: 200 });
    await create(page, 'Data Store', { x: 550, y: 200 });
    await page.locator('.dc-node').nth(0).click({ modifiers: ['Shift'] });
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(2);
    await page.keyboard.press('Shift+F10');
    await expect(menuItem(page, 'Align left')).toBeVisible();
    // Selection is untouched by opening the menu via the keyboard.
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(2);
  });
});

test.describe('context menu — cross-cutting hardening', () => {
  test('flips away from the bottom-right corner to stay fully inside the viewport', async ({ page }) => {
    await newCanvas(page, 'Context menu edge flip');
    const viewport = page.viewportSize()!;
    // Near the pane's own bottom-right corner, not the raw viewport's — a status bar (or other
    // chrome) below the pane would otherwise intercept a click aimed at the literal viewport corner.
    const pane = (await page.locator('.react-flow__pane').boundingBox())!;
    await page.locator('.react-flow__pane').click({
      button: 'right',
      position: { x: pane.width - 20, y: pane.height - 20 },
    });
    const box = (await menu(page).boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  });

  test('right-clicking closes an already-open Quick Connect menu and opens the context menu instead', async ({ page }) => {
    await newCanvas(page, 'Context menu vs quick connect');
    // Double-click empty canvas with no tool armed opens Quick Connect (see `onPaneDoubleClick`).
    await page.locator('.react-flow__pane').dblclick({ position: { x: 400, y: 300 } });
    const quickConnect = page.locator('.dc-quick-connect');
    await expect(quickConnect).toBeVisible();

    await page.locator('.react-flow__pane').click({ button: 'right', position: { x: 400, y: 300 } });
    await expect(quickConnect).toBeHidden();
    await expect(menu(page)).toBeVisible();
  });

  test('the native menu is preserved inside an attachment card textarea', async ({ page }) => {
    await newCanvas(page, 'Context menu native attachment');
    await create(page, 'Service', { x: 400, y: 300 });
    await page.locator('.dc-node').first().click({ button: 'right' });
    await menuItem(page, 'Add Note').click();
    await page.getByRole('button', { name: 'Edit attached detail' }).click();
    const textarea = page.locator('.dc-attachment-card textarea');
    await expect(textarea).toBeFocused();
    await textarea.click({ button: 'right' });
    await expect(menu(page)).toHaveCount(0);
  });

  test('Presentation Mode fully suppresses the context menu', async ({ page }) => {
    await newCanvas(page, 'Context menu presentation');
    await create(page, 'Service', { x: 300, y: 250 });
    await create(page, 'Data Store', { x: 600, y: 250 });
    await connect(page, 0, 1);
    await page.keyboard.press('Escape');

    await page.keyboard.press('ControlOrMeta+Enter'); // enter Presentation Mode
    await expect(page.locator('.dc-editor[data-mode="present"]')).toBeVisible();

    await page.locator('.react-flow__pane').click({ button: 'right', position: { x: 400, y: 400 } });
    await expect(menu(page)).toHaveCount(0);

    // Nothing is selectable in Presentation Mode, so there's nothing for Shift+F10 to anchor to
    // either — the same empty-selection invariant that keeps the pane menu itself suppressed.
    await page.keyboard.press('Shift+F10');
    await expect(menu(page)).toHaveCount(0);
  });

  test('outside-click and Escape dismissal both work for a node menu too, not just the pane menu', async ({ page }) => {
    await newCanvas(page, 'Context menu node dismissal');
    await create(page, 'Service', { x: 400, y: 300 });
    await page.locator('.dc-node').first().click({ button: 'right' });
    await expect(menu(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();

    await page.locator('.dc-node').first().click({ button: 'right' });
    await expect(menu(page)).toBeVisible();
    await page.locator('.react-flow__pane').click({ position: { x: 100, y: 500 } });
    await expect(menu(page)).toBeHidden();
  });

  test('closes reactively if the right-clicked node is deleted from elsewhere while the menu is open', async ({ page }) => {
    await newCanvas(page, 'Context menu stale target');
    await create(page, 'Service', { x: 400, y: 300 });
    await page.locator('.dc-node').first().click({ button: 'right' });
    await expect(menu(page)).toBeVisible();

    // The right-clicked node is already the current selection (right-clicking it selected it) — a
    // plain `deleteSelection()` from elsewhere simulates "deleted out from under the open menu"
    // without needing a hand-rolled document patch.
    await page.evaluate(async () => {
      const mod = await import('/src/store/editorStore.ts');
      mod.useEditorStore.getState().deleteSelection();
    });
    await expect(menu(page)).toBeHidden();
  });
});
