import { expect, test, type Page } from '@playwright/test';
import { create, newCanvas, reopenAfterReload } from './canvas';

/**
 * A sequence on the canvas, driven the way a person drives it: named participants, messages drawn
 * between lifelines, things inside it selected, moved and wrapped — by pointer and by keyboard.
 */

const CANVAS = '.react-flow__pane';
const SEQUENCE = '.dc-node[data-type="sequence"]';
const HEAD = '.dc-seq-head';
const MESSAGE = '.dc-seq-message';
const LIFELINE = '.dc-seq-lifeline';
const FRAME = '.dc-seq-frame';
const INSPECTOR = '.dc-element-inspector';
const NEW_PARTICIPANT = '.dc-seq-new input';
const LABEL = 'input.dc-seq-editor[aria-label="Message"]';
const CONDITION = 'input.dc-seq-editor[aria-label="Condition"]';

/** Presses L over the canvas and names the participants, one Enter each. */
async function newSequence(page: Page, participants: string[], at = { x: 420, y: 260 }) {
  await page.locator(CANVAS).hover({ position: at });
  await page.keyboard.press('l');
  await expect(page.locator(NEW_PARTICIPANT)).toBeFocused();
  for (const [index, name] of participants.entries()) {
    await page.keyboard.type(name);
    await page.keyboard.press('Enter');
    await expect(page.locator(HEAD)).toHaveCount(index + 1);
  }
  await page.keyboard.press('Escape');
  await expect(page.locator(NEW_PARTICIPANT)).toHaveCount(0);
}

/** Drags from one lifeline to another near the bottom of both, then types what the message says. */
async function draw(page: Page, from: number, to: number, label: string) {
  const start = (await page.locator(LIFELINE).nth(from).boundingBox())!;
  const end = (await page.locator(LIFELINE).nth(to).boundingBox())!;
  const y = start.y + start.height - 6;
  await page.mouse.move(start.x + start.width / 2, y);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, y + 1, { steps: 5 });
  await page.mouse.move(end.x + end.width / 2, y, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator(LABEL)).toBeFocused();
  await page.keyboard.type(label);
  await page.keyboard.press('Enter');
  await expect(page.locator(LABEL)).toHaveCount(0);
}

const said = (page: Page) =>
  page.locator(MESSAGE).evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')!.replace('Message from ', '')));

test.describe('Sequence', () => {
  test('a basic sequence from an empty canvas: three names, two drags, no layout', async ({ page }) => {
    await newCanvas(page, 'Orders');
    await newSequence(page, ['Client', 'API', 'Database']);

    // The names were read the way the shape picker reads them.
    await expect(page.locator(HEAD)).toHaveCount(3);
    await page.locator(HEAD).nth(2).click();
    await expect(page.locator(`${INSPECTOR} .dc-inspector-select`).first()).toContainText('Data Store');

    await draw(page, 0, 1, 'GET /orders');
    await draw(page, 1, 2, 'SELECT orders');
    expect(await said(page)).toEqual(['Client to API: GET /orders', 'API to Database: SELECT orders']);

    // Each participant and each message is one step back: six in all, then nothing is left.
    for (let step = 0; step < 6; step += 1) await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator(SEQUENCE)).toHaveCount(0);
  });

  test('selecting inside it: one click, a range with Shift, and the sequence still moves as a shape', async ({ page }) => {
    await newCanvas(page, 'Selecting');
    await newSequence(page, ['Client', 'API', 'Database']);
    await draw(page, 0, 1, 'GET /orders');
    await draw(page, 1, 2, 'SELECT orders');

    await page.locator(MESSAGE).nth(0).click();
    await expect(page.locator(`${MESSAGE}[data-focused="true"]`)).toHaveCount(1);
    await expect(page.locator(INSPECTOR)).toContainText('Add reply');

    // Shift extends the range and never lets go of the sequence itself.
    await page.locator(MESSAGE).nth(1).click({ modifiers: ['Shift'] });
    await expect(page.locator(`${MESSAGE}[data-focused="true"]`)).toHaveCount(2);
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);

    // Delete takes what is selected inside, not the sequence.
    await page.keyboard.press('Delete');
    await expect(page.locator(MESSAGE)).toHaveCount(0);
    await expect(page.locator(SEQUENCE)).toHaveCount(1);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator(MESSAGE)).toHaveCount(2);

    // Pressing on the sequence where none of its parts are picks the whole of it up.
    const node = page.locator('.react-flow__node').first();
    const before = (await node.boundingBox())!;
    await page.mouse.move(before.x + 60, before.y + 12);
    await page.mouse.down();
    await page.mouse.move(before.x + 160, before.y + 72, { steps: 6 });
    await page.mouse.up();
    const after = (await node.boundingBox())!;
    expect(after.x - before.x).toBeGreaterThan(60);
    expect(after.y - before.y).toBeGreaterThan(30);
    expect(await said(page)).toEqual(['Client to API: GET /orders', 'API to Database: SELECT orders']);
  });

  test('replies land below what their call set going, and a stretch is wrapped without drawing a box', async ({ page }) => {
    await newCanvas(page, 'Fragments');
    await newSequence(page, ['Client', 'API', 'Database']);
    await draw(page, 0, 1, 'GET /orders');
    await draw(page, 1, 2, 'SELECT orders');

    for (const [index, label] of [[1, 'rows'], [0, '200 OK']] as const) {
      await page.locator(MESSAGE).nth(index).click();
      await page.locator(INSPECTOR).getByRole('button', { name: 'Add reply' }).click();
      await expect(page.locator(LABEL)).toBeFocused();
      await page.keyboard.type(label);
      await page.keyboard.press('Enter');
    }
    expect(await said(page)).toEqual([
      'Client to API: GET /orders',
      'API to Database: SELECT orders',
      'Database to API: rows',
      'API to Client: 200 OK',
    ]);

    await page.locator(MESSAGE).nth(1).click();
    await page.locator(MESSAGE).nth(2).click({ modifiers: ['Shift'] });
    await page.locator(INSPECTOR).getByRole('button', { name: 'Wrap in…' }).click();
    await page.locator(INSPECTOR).getByRole('button', { name: 'Optional' }).click();
    await expect(page.locator(CONDITION)).toBeFocused();
    await page.keyboard.type('not cached');
    await page.keyboard.press('Enter');
    await expect(page.locator(FRAME)).toHaveCount(1);
    await expect(page.locator(`${SEQUENCE} text`).filter({ hasText: '[not cached]' })).toHaveCount(1);

    // Delete on a frame that holds messages takes the frame and leaves them.
    await page.keyboard.press('Delete');
    await expect(page.locator(FRAME)).toHaveCount(0);
    await expect(page.locator(MESSAGE)).toHaveCount(4);
  });

  test('the whole of it by keyboard: the suggested next message, arrows to reorder, a refusal that says why', async ({ page }) => {
    await newCanvas(page, 'Keyboard');
    await newSequence(page, ['Client', 'API', 'Database']);

    // The last participant named is selected: over to Client, then take what is offered.
    await page.keyboard.press('Alt+ArrowLeft');
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(page.locator('.dc-seq-ghost-hint')).toContainText('Client calls API');
    for (const label of ['GET /orders', 'SELECT orders', 'rows', '200 OK']) {
      await page.keyboard.press('Tab');
      await expect(page.locator(LABEL)).toBeFocused();
      await page.keyboard.type(label);
      await page.keyboard.press('Enter');
    }
    expect(await said(page)).toEqual([
      'Client to API: GET /orders',
      'API to Database: SELECT orders',
      'Database to API: rows',
      'API to Client: 200 OK',
    ]);

    // A reply may move up as far as its call and no further.
    for (let press = 0; press < 3; press += 1) await page.keyboard.press('ArrowUp');
    expect((await said(page))[1]).toBe('API to Client: 200 OK');
    await expect(page.locator('.dc-toast').last()).toContainText('This reply comes before the call it answers.');

    // Escape steps out to the sequence, then off it.
    await page.keyboard.press('Escape');
    await expect(page.locator('.dc-seq-overlay [data-focused="true"]')).toHaveCount(0);
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
  });

  test('a shape dropped in stands in the sequence, stays in the architecture, and the two are renamed together', async ({ page }) => {
    await newCanvas(page, 'Linked');
    await create(page, 'Service', { x: 220, y: 520 });
    const shape = page.locator('.dc-node[data-type="service"]');
    await shape.dblclick();
    await page.keyboard.type('Checkout API');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await newSequence(page, ['Shopper', 'Orders'], { x: 620, y: 200 });

    // Carry the shape over the sequence, between its two participants, and rest there.
    const home = (await shape.boundingBox())!;
    const first = (await page.locator(HEAD).nth(0).boundingBox())!;
    const second = (await page.locator(HEAD).nth(1).boundingBox())!;
    const over = { x: (first.x + first.width + second.x) / 2, y: first.y + first.height + 30 };
    await page.mouse.move(home.x + home.width / 2, home.y + home.height / 2);
    await page.mouse.down();
    await page.mouse.move(over.x, over.y, { steps: 12 });
    await expect(page.locator('.dc-seq-stand[data-drop="true"]')).toContainText('Add as participant');
    await page.mouse.up();

    // It stands between the two, and the shape is back exactly where it was.
    await expect(page.locator(HEAD)).toHaveCount(3);
    expect(await page.locator(HEAD).evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))).toEqual([
      'Participant Shopper',
      'Participant Checkout API',
      'Participant Orders',
    ]);
    const back = (await shape.boundingBox())!;
    expect(Math.abs(back.x - home.x)).toBeLessThan(1);
    expect(Math.abs(back.y - home.y)).toBeLessThan(1);
    await expect(page.locator('.dc-seq-link')).toHaveCount(1);

    // Renamed on the canvas, it is renamed in the sequence.
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await shape.dblclick();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Checkout');
    await page.keyboard.press('Enter');
    await page.locator(SEQUENCE).hover();
    await expect(page.locator(HEAD).nth(1)).toHaveAttribute('aria-label', 'Participant Checkout');

    // One step back for the rename, one for the drop — and no stray move in between.
    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+z');
    await page.keyboard.press('ControlOrMeta+z');
    await page.locator(SEQUENCE).hover();
    await expect(page.locator(HEAD)).toHaveCount(2);
    await expect(shape).toHaveCount(1);
  });

  test('is presented one message at a time, through the canvas’s own presentation', async ({ page }) => {
    await newCanvas(page, 'Told');
    await newSequence(page, ['Client', 'API', 'Database']);
    await draw(page, 0, 1, 'GET /orders');
    await draw(page, 1, 2, 'SELECT orders');

    // Back to the sequence as a whole: its inspector offers to present it.
    await page.keyboard.press('Escape');
    await page.locator(INSPECTOR).getByRole('button', { name: 'Present this sequence' }).click();
    await expect(page.locator('.dc-explain')).toContainText('2 steps');

    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.dc-explain-count')).toContainText('Step 1 / 2');
    await expect(page.locator(`${SEQUENCE}[data-seq-telling="true"]`)).toHaveCount(1);
    // Only the message being told, and the two it is between, are drawn at full strength.
    expect(await page.locator('.dc-seq-now text').allTextContents()).toEqual(expect.arrayContaining(['GET /orders', 'Client', 'API']));
    expect(await page.locator('.dc-seq-now text').allTextContents()).not.toContain('Database');

    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.dc-explain-count')).toContainText('Step 2 / 2');
    expect(await page.locator('.dc-seq-now text').allTextContents()).toEqual(expect.arrayContaining(['SELECT orders', 'API', 'Database']));
    expect(await page.locator('.dc-seq-told text').allTextContents()).toContain('GET /orders');

    // Leaving puts everything back as it was, still editable.
    await page.keyboard.press('Escape');
    await expect(page.locator(`${SEQUENCE}[data-seq-telling="true"]`)).toHaveCount(0);
    await page.locator(SEQUENCE).hover();
    expect(await said(page)).toEqual(['Client to API: GET /orders', 'API to Database: SELECT orders']);
  });

  test('a Mermaid sequence diagram pasted in becomes a sequence that can be edited, and goes back out as text', async ({ page, browserName }) => {
    test.skip(browserName === 'firefox', 'Firefox protects the clipboard data of synthetic paste events');
    await newCanvas(page, 'Pasted');
    const text = ['sequenceDiagram', '  actor Shopper', '  Shopper->>+Store: Place order', '  alt in stock', '    Store-->>-Shopper: Confirmed', '  else sold out', '    Store-->>Shopper: Sorry', '  end'].join('\n');
    await page.evaluate((body) => {
      const data = new DataTransfer();
      data.setData('text/plain', body);
      document.querySelector('.dc-canvas')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    }, text);

    await expect(page.locator(SEQUENCE)).toHaveCount(1);
    await page.locator(SEQUENCE).hover();
    await expect(page.locator(HEAD)).toHaveCount(2);
    expect(await said(page)).toEqual(['Shopper to Store: Place order', 'Store to Shopper: Confirmed', 'Store to Shopper: Sorry']);
    await expect(page.locator(FRAME)).toHaveCount(1);

    // It is an ordinary sequence now: a message can be renamed where it stands.
    await page.locator(MESSAGE).nth(2).dblclick();
    await expect(page.locator(LABEL)).toBeFocused();
    await page.keyboard.type('Out of stock');
    await page.keyboard.press('Enter');

    // Exported as source, it is the same diagram with the edit in it.
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await page.getByRole('menuitem', { name: /^Export/ }).click();
    const dialog = page.getByRole('dialog', { name: 'Export & share' });
    await dialog.locator('[data-mode="sequence"]').click();
    const preview = dialog.getByTestId('export-source-preview');
    await expect(preview).toContainText('sequenceDiagram');
    await expect(preview).toContainText('Store-->>Shopper: Out of stock');
    await expect(preview).toContainText('alt in stock');
  });

  test('is still there, and still editable, after a reload', async ({ page }) => {
    await newCanvas(page, 'Kept');
    await newSequence(page, ['Shopper', 'Storefront']);
    await draw(page, 0, 1, 'Place order');
    await expect(page.getByText('Saved locally')).toBeVisible();

    await reopenAfterReload(page, 'Kept');
    await expect(page.locator(SEQUENCE)).toHaveCount(1);
    await page.locator(SEQUENCE).hover();
    expect(await said(page)).toEqual(['Shopper to Storefront: Place order']);

    await page.locator(MESSAGE).first().dblclick();
    await expect(page.locator(LABEL)).toBeFocused();
    await page.keyboard.type('Check out');
    await page.keyboard.press('Enter');
    expect(await said(page)).toEqual(['Shopper to Storefront: Check out']);
  });
});
