import { expect, test, type Page } from '@playwright/test';

const CANVAS = '.react-flow__pane';
const NOTE = '.dc-node[data-type="note"]';
const EDITOR = 'textarea.dc-node-editor';

async function newCanvas(page: Page, title: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New canvas' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  const field = page.getByLabel('Diagram title');
  await field.fill(title);
  await field.blur();
}

/** Presses `N` over the canvas: the note arrives already editing. */
async function newNote(page: Page, at: { x: number; y: number }) {
  await page.locator(CANVAS).hover({ position: at });
  await page.keyboard.press('n');
  await expect(page.locator(EDITOR)).toBeFocused();
}

async function typeLines(page: Page, lines: string[]) {
  for (const [index, line] of lines.entries()) {
    if (index > 0) await page.keyboard.press('Enter');
    await page.keyboard.type(line);
  }
}

function renderedLines(page: Page) {
  return page.locator(`${NOTE} text`).evaluateAll((els) => els.map((el) => el.textContent));
}

const RETRY = ['Retry strategy', '- 3 attempts', '- exponential backoff', '- send to DLQ'];

test.describe('Note', () => {
  test('N opens a note ready to type, Enter is a newline, clicking away commits and the box grows', async ({
    page,
  }) => {
    await newCanvas(page, 'Note basics');
    await newNote(page, { x: 400, y: 300 });
    await expect(page.locator(EDITOR)).toHaveAttribute('placeholder', 'Add a note…');
    await expect(page.locator(EDITOR)).toHaveValue('');
    const before = (await page.locator(NOTE).boundingBox())!;

    await typeLines(page, RETRY);
    await expect(page.locator(EDITOR)).toHaveValue(RETRY.join('\n'));
    // Grows while typing, before anything is committed.
    const during = (await page.locator(NOTE).boundingBox())!;
    expect(during.height).toBeGreaterThan(before.height);

    await page.locator(CANVAS).click({ position: { x: 100, y: 100 } });
    await expect(page.locator(EDITOR)).toHaveCount(0);
    expect(await renderedLines(page)).toEqual(RETRY);
    const after = (await page.locator(NOTE).boundingBox())!;
    expect(after.height).toBeGreaterThanOrEqual(during.height - 1);
    expect(after.width).toBe(before.width);
  });

  test('keys typed into a note never reach the canvas: no shapes, no delete, no pan', async ({ page }) => {
    await newCanvas(page, 'Note keyboard');
    await newNote(page, { x: 400, y: 300 });
    const viewport = page.locator('.react-flow__viewport');
    const transformBefore = await viewport.evaluate((el) => el.style.transform);

    await page.keyboard.type('n s c t ');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Delete');
    await page.keyboard.press('Home');
    await page.keyboard.type('> ');
    await page.keyboard.press('End');
    await page.keyboard.type('!');
    await page.keyboard.press('Shift+ArrowLeft');
    await page.keyboard.press('ControlOrMeta+a');

    await expect(page.locator('.dc-node')).toHaveCount(1);
    await expect(page.locator(EDITOR)).toHaveValue('> n s c t!');
    expect(await viewport.evaluate((el) => el.style.transform)).toBe(transformBefore);
    await expect(page.locator(EDITOR)).toBeFocused();
  });

  test('Escape commits, Cmd/Ctrl+Enter commits, and the empty note shows its hint again once cleared', async ({
    page,
  }) => {
    await newCanvas(page, 'Note escape');
    await newNote(page, { x: 400, y: 300 });
    await page.keyboard.type('Owned by Payments');
    await page.keyboard.press('Escape');
    await expect(page.locator(EDITOR)).toHaveCount(0);
    expect(await renderedLines(page)).toEqual(['Owned by Payments']);
    await expect(page.locator('.dc-note-placeholder')).toHaveCount(0);

    await page.locator(NOTE).dblclick();
    await expect(page.locator(EDITOR)).toBeFocused();
    // Caret lands at the end — appending must not replace what is there.
    await page.keyboard.type(' (temp)');
    await page.keyboard.press('ControlOrMeta+Enter');
    await expect(page.locator(EDITOR)).toHaveCount(0);
    expect(await renderedLines(page)).toEqual(['Owned by Payments (temp)']);

    await page.locator(NOTE).dblclick();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Escape');
    expect(await renderedLines(page)).toEqual([]);
    await expect(page.locator('.dc-note-placeholder')).toHaveText('Add a note…');
  });

  test('multiline text survives reload, undo/redo, duplicate and copy/paste', async ({ page }) => {
    await newCanvas(page, 'Note persistence');
    await newNote(page, { x: 400, y: 300 });
    await typeLines(page, RETRY);
    await page.keyboard.press('Escape');
    expect(await renderedLines(page)).toEqual(RETRY);

    await page.keyboard.press('ControlOrMeta+z');
    expect(await renderedLines(page)).toEqual([]);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    expect(await renderedLines(page)).toEqual(RETRY);

    await page.locator(NOTE).click();
    await page.keyboard.press('ControlOrMeta+d');
    await expect(page.locator(NOTE)).toHaveCount(2);
    await page.keyboard.press('ControlOrMeta+c');
    await page.keyboard.press('ControlOrMeta+v');
    await expect(page.locator(NOTE)).toHaveCount(3);
    for (const index of [0, 1, 2]) {
      const lines = await page.locator(NOTE).nth(index).locator('text').evaluateAll((els) => els.map((e) => e.textContent));
      expect(lines).toEqual(RETRY);
    }

    await expect(page.locator('.dc-save')).toContainText('Saved locally');
    await page.reload();
    await page.locator('.dc-library-item', { hasText: 'Note persistence' }).click();
    await expect(page.locator(NOTE)).toHaveCount(3);
    expect(await page.locator(NOTE).first().locator('text').evaluateAll((els) => els.map((e) => e.textContent))).toEqual(
      RETRY,
    );
  });

  test('a note the user resized keeps that size when its text is edited', async ({ page }) => {
    await newCanvas(page, 'Note resize');
    await newNote(page, { x: 400, y: 300 });
    await page.keyboard.type('Legacy integration');
    await page.keyboard.press('Escape');

    await page.locator(NOTE).click();
    const corner = (await page.locator('.dc-resize-handle').nth(3).boundingBox())!;
    await page.mouse.move(corner.x + corner.width / 2, corner.y + corner.height / 2);
    await page.mouse.down();
    await page.mouse.move(corner.x + 120, corner.y + 140, { steps: 8 });
    await page.mouse.up();
    const resized = (await page.locator(NOTE).boundingBox())!;
    expect(resized.height).toBeGreaterThan(150);

    await page.locator(NOTE).dblclick();
    await page.keyboard.press('Enter');
    await page.keyboard.type('- do not extend');
    await page.keyboard.press('Escape');
    const after = (await page.locator(NOTE).boundingBox())!;
    expect(after.width).toBe(resized.width);
    expect(after.height).toBe(resized.height);
    expect(await renderedLines(page)).toEqual(['Legacy integration', '- do not extend']);
  });

  test('a mouse drag inside the editor selects text instead of moving the note', async ({ page }) => {
    await newCanvas(page, 'Note text selection');
    await newNote(page, { x: 400, y: 300 });
    await page.keyboard.type('Why is this synchronous?');
    const editor = page.locator(EDITOR);
    const box = (await editor.boundingBox())!;
    const noteBefore = (await page.locator(NOTE).boundingBox())!;

    await page.mouse.move(box.x + 4, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + 8, { steps: 6 });
    await page.mouse.up();

    const selected = await editor.evaluate((el: HTMLTextAreaElement) => el.selectionEnd - el.selectionStart);
    expect(selected).toBeGreaterThan(0);
    const noteAfter = (await page.locator(NOTE).boundingBox())!;
    expect(noteAfter.x).toBe(noteBefore.x);
    expect(noteAfter.y).toBe(noteBefore.y);
    await expect(editor).toBeFocused();
  });

  test('pasted Windows line endings and tabs are normalized at commit', async ({ page }) => {
    await newCanvas(page, 'Note paste');
    await newNote(page, { x: 400, y: 300 });
    await page.locator(EDITOR).evaluate((el: HTMLTextAreaElement) => {
      el.setRangeText('first\r\n\tsecond\r\n\r\n', 0, 0, 'end');
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.keyboard.press('Escape');
    expect(await renderedLines(page)).toEqual(['first', '  second']);
  });

  test('a note keeps its native context menu while editing, and the right-click menu otherwise', async ({
    page,
  }) => {
    await newCanvas(page, 'Note menus');
    await newNote(page, { x: 400, y: 300 });
    await page.locator(EDITOR).click({ button: 'right' });
    await expect(page.locator('.dc-context-menu')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.locator(NOTE).click({ button: 'right' });
    await expect(page.locator('.dc-context-menu')).toContainText('Edit text');
  });
});
