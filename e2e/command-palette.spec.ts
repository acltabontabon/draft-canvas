import { expect, test, type Page } from '@playwright/test';

/** Phase 8 — the ⌘K command surface, driven start to finish from the keyboard. */

async function newCanvas(page: Page, title: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New canvas' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  const field = page.getByLabel('Diagram title');
  await field.fill(title);
  await field.blur();
}

async function openPalette(page: Page) {
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog', { name: 'Commands' })).toBeVisible();
}

test.describe('command palette', () => {
  test('adds a service from the keyboard and leaves it selected', async ({ page }) => {
    await newCanvas(page, 'Palette create');
    await openPalette(page);
    await page.keyboard.type('serv');
    await expect(page.getByRole('option', { selected: true })).toContainText('Add Service');
    await page.keyboard.press('Enter');

    await expect(page.getByRole('dialog', { name: 'Commands' })).toBeHidden();
    await expect(page.locator('.dc-node')).toHaveCount(1);
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(1);
    // Palette-created elements open ready to name, the same as every other keyboard-driven path.
    await expect(page.locator('.dc-node-editor')).toBeFocused();
  });

  test('creating several elements in a row from the keyboard, with no mouse movement, does not stack them on top of each other', async ({
    page,
  }) => {
    await newCanvas(page, 'Palette create — no overlap');
    for (const query of ['serv', 'data store', 'queue']) {
      await openPalette(page);
      await page.keyboard.type(query);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Escape'); // dismiss the new node's auto-opened editor
    }
    await expect(page.locator('.dc-node')).toHaveCount(3);

    const boxes = await page.locator('.dc-node').evaluateAll((els) => els.map((el) => el.getBoundingClientRect()));
    const overlaps = (a: DOMRect, b: DOMRect) => a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        expect(overlaps(boxes[i]!, boxes[j]!), `node ${i} and node ${j} should not overlap`).toBe(false);
      }
    }
  });

  test('Escape closes it and changes nothing', async ({ page }) => {
    await newCanvas(page, 'Palette escape');
    await openPalette(page);
    await page.keyboard.type('note');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Commands' })).toBeHidden();
    await expect(page.locator('.dc-node')).toHaveCount(0);
  });

  test('the toolbar button opens it too', async ({ page }) => {
    await newCanvas(page, 'Palette button');
    await page.getByRole('button', { name: 'Commands (Cmd+K)' }).click();
    await expect(page.getByRole('dialog', { name: 'Commands' })).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Search commands' })).toBeFocused();
  });

  test('closing it returns focus to whatever opened it', async ({ page }) => {
    await newCanvas(page, 'Palette focus return');
    const trigger = page.getByRole('button', { name: 'Commands (Cmd+K)' });
    await trigger.click();
    await expect(page.getByRole('dialog', { name: 'Commands' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Commands' })).toBeHidden();
    await expect(trigger).toBeFocused();
  });
});

test.describe('command palette — contextual', () => {
  test('connects the selected node to another one, keyboard only', async ({ page }) => {
    await newCanvas(page, 'Palette connect');
    await openPalette(page);
    await page.keyboard.type('serv');
    await page.keyboard.press('Enter');
    await expect(page.locator('.dc-node')).toHaveCount(1);
    // It opens ready to name — the editor owns the keyboard until dismissed, same as every other
    // keyboard-created element; Escape leaves its default name and keeps it selected.
    await expect(page.locator('.dc-node-editor')).toBeFocused();
    await page.keyboard.press('Escape');
    // The new node stays selected, so the next palette is contextual to it.
    await openPalette(page);
    await page.keyboard.type('conn');
    await expect(page.getByRole('option', { selected: true })).toContainText('Connect to…');
    await page.keyboard.press('Enter');
    await expect(page.locator('.dc-palette-stage')).toHaveText('Connect to');
    await page.keyboard.type('new data');
    await expect(page.getByRole('option', { selected: true })).toContainText('New Data Store');
    await page.keyboard.press('Enter');

    await expect(page.locator('.dc-node')).toHaveCount(2);
    await expect(page.locator('.react-flow__edge')).toHaveCount(1);
    // "Connect to… → New <type>" is reachable only via ⌘K/Shift+F10 on a node — never a mouse
    // gesture — so it opens ready to name too.
    await expect(page.locator('.dc-node-editor')).toBeFocused();
  });

  test('Escape inside a stage steps back instead of closing', async ({ page }) => {
    await newCanvas(page, 'Palette stage escape');
    await openPalette(page);
    await page.keyboard.type('serv');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape'); // dismiss the new node's auto-opened editor
    await openPalette(page);
    await page.keyboard.type('conn');
    await page.keyboard.press('Enter');
    await expect(page.locator('.dc-palette-stage')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.dc-palette-stage')).toBeHidden();
    await expect(page.getByRole('dialog', { name: 'Commands' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Commands' })).toBeHidden();
  });
});

test.describe('command palette — jump', () => {
  test('typing a node name jumps to it and selects it', async ({ page }) => {
    await newCanvas(page, 'Palette jump');
    await openPalette(page);
    await page.keyboard.type('add data');
    await page.keyboard.press('Enter');
    await expect(page.locator('.dc-node-editor')).toBeFocused(); // opens ready to name
    await page.keyboard.press('Escape'); // dismiss the auto-opened editor, keeping it selected
    await page.keyboard.press('Escape'); // then clear the selection the create left behind
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(0);

    await openPalette(page);
    await page.keyboard.type('data sto');
    // The node's exact name outranks "Add Data Store" — the jump row is what Enter runs.
    const jump = page.getByRole('option', { selected: true });
    await expect(jump).toContainText('Data Store');
    await expect(jump.locator('.dc-palette-tag')).toHaveText('Jump to');
    await page.keyboard.press('Enter');
    await expect(page.locator('.dc-node[data-selected="true"]')).toHaveCount(1);
    await expect(page.locator('.dc-node[data-jump-flash="true"]')).toHaveCount(1);
    // The camera actually moved there — and never zoomed in past the cap on a single node.
    await expect
      .poll(async () => {
        const transform = await page.locator('.react-flow__viewport').evaluate((el) => el.style.transform);
        return Number(/scale\(([\d.]+)\)/.exec(transform)?.[1] ?? 0);
      })
      .toBeCloseTo(1.2, 1);
  });
});

test.describe('command palette — discoverability', () => {
  test('a node with its own hint teaches that first, dismissibly, only while Learn mode is on', async ({
    page,
  }) => {
    await newCanvas(page, 'Palette hint');
    // Hints only ever surface while Learn Draft Canvas mode is on (see HintStrip.tsx) — nothing
    // shows before the toggle, and dismissing one hides it for the rest of the session.
    await page.getByRole('button', { name: 'Note', exact: true }).click();
    await page.locator('.react-flow__pane').click({ position: { x: 400, y: 300 } });
    await page.keyboard.press('Escape');
    await page.locator('.dc-node').first().click();
    await expect(page.locator('.dc-hint-strip')).toHaveCount(0);

    await page.getByRole('button', { name: 'Learn Draft Canvas' }).click();
    const strip = page.locator('.dc-hint-strip');
    await expect(strip).toContainText('Attach a note or code snippet');
    await strip.getByRole('button', { name: 'Dismiss hint' }).click();
    await expect(strip).toHaveCount(0);

    // Re-selecting the same node keeps it dismissed for the rest of this session.
    await page.keyboard.press('Escape');
    await page.locator('.dc-node').first().click();
    await expect(strip).toHaveCount(0);
  });

  test('an element with no hint of its own teaches ⌘K instead, until the palette has opened', async ({ page }) => {
    await newCanvas(page, 'Palette hint — boundary');
    await page.getByRole('button', { name: 'Learn Draft Canvas' }).click();
    // A boundary has no attachment/semantics hint of its own, so it falls straight to the ⌘K hint.
    await page.locator('.react-flow__pane').click({ button: 'right', position: { x: 400, y: 300 } });
    await page.getByRole('menuitem', { name: 'Add Boundary' }).click();
    await expect(page.locator('.dc-node[data-type="group"][data-selected="true"]')).toHaveCount(1);

    const strip = page.locator('.dc-hint-strip');
    await expect(strip).toContainText('to act on this from the keyboard');

    await openPalette(page);
    await page.keyboard.press('Escape');
    await expect(strip).toHaveCount(0);
  });
});
