import { expect, test, type Page } from '@playwright/test';
import { connect, create, newCanvas, reopenAfterReload } from './canvas';

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
const PARTICIPANT_NAME = 'input.dc-seq-editor[aria-label="Participant name"]';
const LABEL = 'input.dc-seq-editor[aria-label="Message"]';
const CONDITION = 'input.dc-seq-editor[aria-label="Condition"]';
const PARTICIPANT_KINDS: Record<string, string> = { Client: 'Actor', Database: 'Data Store' };

async function renameParticipant(page: Page, index: number, name: string, kind?: string) {
  await page.locator(HEAD).nth(index).dblclick();
  const field = page.locator(PARTICIPANT_NAME);
  await expect(field).toBeFocused();
  await field.fill(name);
  if (kind) {
    await field.press('ArrowDown');
    await page.getByRole('option', { name: new RegExp(`^${kind}`) }).click();
  } else await field.press('Enter');
  await expect(field).toHaveCount(0);
}

async function newSequence(page: Page, participants: string[], at = { x: 420, y: 260 }) {
  await page.locator(CANVAS).hover({ position: at });
  await page.keyboard.press('l');
  await expect(page.locator(HEAD)).toHaveCount(1);
  await expect(page.locator(PARTICIPANT_NAME)).toHaveCount(0);
  for (const [index, name] of participants.entries()) {
    if (index > 0) await page.getByRole('button', { name: 'Add a participant at the end' }).click();
    await renameParticipant(page, index, name, PARTICIPANT_KINDS[name]);
  }
  await page.keyboard.press('Escape');
  await expect(page.locator(HEAD)).toHaveCount(participants.length);
}

/** Drags from one lifeline to another near the bottom of both, then types what the message says. */
async function draw(page: Page, from: number, to: number, label: string, defaultLabel?: string) {
  const start = (await page.locator(LIFELINE).nth(from).boundingBox())!;
  const end = (await page.locator(LIFELINE).nth(to).boundingBox())!;
  const y = start.y + start.height - 6;
  await page.mouse.move(start.x + start.width / 2, y);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, y + 1, { steps: 5 });
  await page.mouse.move(end.x + end.width / 2, y, { steps: 5 });
  await expect(page.locator(LIFELINE).nth(to)).toHaveAttribute('data-endpoint-target', 'true');
  await page.mouse.up();
  await expect(page.locator(`${LIFELINE}[data-endpoint-target="true"]`)).toHaveCount(0);
  await expect(page.locator(LABEL)).toBeFocused();
  if (defaultLabel !== undefined) await expect(page.locator(LABEL)).toHaveValue(defaultLabel);
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
    await draw(page, 1, 2, 'SELECT orders', 'reads / writes');
    expect(await said(page)).toEqual(['Client to API: GET /orders', 'API to Database: SELECT orders']);
    await expect(page.locator(MESSAGE).nth(0)).toHaveAttribute('aria-description', 'Message 1 of 2');
    await expect(page.locator(MESSAGE).nth(1)).toHaveAttribute('aria-description', 'Message 2 of 2');

    // Undo two messages, three renames, two adds and the sequence with its first participant.
    for (let step = 0; step < 8; step += 1) await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator(SEQUENCE)).toHaveCount(0);
  });

  test('starts from the toolbar and takes a suggested message with the mouse', async ({ page }) => {
    await newCanvas(page, 'Pointer');
    await page.getByRole('toolbar', { name: 'Create' }).getByRole('button', { name: 'Sequence', exact: true }).click();
    await page.locator(CANVAS).click({ position: { x: 420, y: 260 } });
    await expect(page.locator(HEAD)).toHaveCount(1);
    await page.getByRole('button', { name: 'Add a participant at the end' }).click();
    await expect(page.locator(HEAD)).toHaveCount(2);
    await expect(page.locator(PARTICIPANT_NAME)).toHaveCount(0);

    await page.locator(HEAD).first().click();
    await page.locator('.dc-seq-ghost-hint').click();
    const field = page.locator(LABEL);
    await expect(field).toBeFocused();
    await expect(page.locator(`${MESSAGE}[data-focused="true"]`)).toHaveCount(0);
    await field.fill('Fetch orders');
    await page.locator(CANVAS).click({ position: { x: 30, y: 30 } });
    await page.locator(SEQUENCE).hover();
    expect(await said(page)).toEqual(['Participant 1 to Participant 2: Fetch orders']);

    const message = page.locator(MESSAGE).first();
    await message.click();
    await expect(page.locator('.dc-seq-selected-arrows path')).toHaveCount(2);
    await expect(page.locator(INSPECTOR)).toBeVisible();
    await page.locator(INSPECTOR).getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(field).toBeFocused();
    await expect(page.locator('.dc-seq-selected-arrows')).toHaveCount(0);
    await expect(page.locator(INSPECTOR)).toHaveCount(0);
    await field.press('Escape');
    await expect(page.locator(INSPECTOR)).toBeVisible();
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

  test('retargets a self-message by its arrowhead and leaves space to draw a second message', async ({ page }) => {
    await newCanvas(page, 'Endpoints');
    await newSequence(page, ['Client', 'API', 'Database']);
    await draw(page, 0, 0, 'Read orders');

    const message = page.locator(MESSAGE).first();
    await message.click();
    const receiver = page.locator('.dc-seq-endpoint[data-end="to"]');
    const start = (await receiver.boundingBox())!;
    const target = (await page.locator(HEAD).nth(2).boundingBox())!;
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    const between = { x: start.x + start.width / 2 + 32, y: start.y + start.height / 2 + 26 };
    await page.mouse.move(between.x, between.y);
    // The loose end follows in both axes even between participants, before there is a drop target.
    await expect.poll(async () => page.locator('.dc-seq-draw:not([data-ghost]) path').first().evaluate((path: SVGPathElement, pointer) => {
      const tip = path.getPointAtLength(path.getTotalLength()).matrixTransform(path.getScreenCTM()!);
      return Math.hypot(tip.x - pointer.x, tip.y - pointer.y);
    }, between)).toBeLessThan(2);
    await expect(message).toHaveAttribute('aria-label', 'Message from Client to Client: Read orders');
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
    await expect(page.locator(LIFELINE).nth(2)).toHaveAttribute('data-endpoint-target', 'true');
    await page.mouse.up();
    await expect(page.locator(`${LIFELINE}[data-endpoint-target="true"]`)).toHaveCount(0);

    await expect(message).toHaveAttribute('aria-label', 'Message from Client to Database: Read orders');
    await draw(page, 0, 1, 'Fetch orders');
    expect(await said(page)).toEqual(['Client to Database: Read orders', 'Client to API: Fetch orders']);
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

    // The sequence is selected; the key that looks inside a shape steps into it, at its first participant.
    await page.keyboard.press('ControlOrMeta+ArrowDown');
    await expect(page.locator(`${HEAD}[data-focused="true"]`)).toHaveAttribute('aria-label', 'Participant Client');
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

  /** Carries a shape over the sequence, between its first two participants, rests there and lets go. */
  async function dropBetweenFirstTwo(page: Page, shape: ReturnType<Page['locator']>, hint: string) {
    const home = (await shape.boundingBox())!;
    const first = (await page.locator(HEAD).nth(0).boundingBox())!;
    const second = (await page.locator(HEAD).nth(1).boundingBox())!;
    const over = { x: (first.x + first.width + second.x) / 2, y: first.y + first.height + 30 };
    await page.mouse.move(home.x + home.width / 2, home.y + home.height / 2);
    await page.mouse.down();
    await page.mouse.move(over.x, over.y, { steps: 12 });
    await expect(page.locator('.dc-seq-stand[data-drop="true"]')).toContainText(hint);
    await page.mouse.up();
    return home;
  }

  test('a shape on its own, dropped in, moves into the sequence: nothing is left behind', async ({ page }) => {
    await newCanvas(page, 'Moved in');
    await create(page, 'Data Store', { x: 220, y: 520 });
    const shape = page.locator('.dc-node[data-type="database"]');
    await newSequence(page, ['Shopper', 'Orders API'], { x: 620, y: 200 });

    await dropBetweenFirstTwo(page, shape, 'Move into the sequence');
    await expect(shape).toHaveCount(0);
    expect(await page.locator(HEAD).evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))).toEqual([
      'Participant Shopper',
      'Participant Data Store',
      'Participant Orders API',
    ]);
    // It is the participant now, not a stand-in for something else.
    await expect(page.locator('.dc-seq-link')).toHaveCount(0);

    // One step back and it is on the canvas again, where it was.
    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+z');
    await expect(shape).toHaveCount(1);
    await page.locator(SEQUENCE).hover();
    await expect(page.locator(HEAD)).toHaveCount(2);
  });

  test('a shape that is part of a diagram stays in it, stands in the sequence, and the two are renamed together', async ({ page }) => {
    await newCanvas(page, 'Linked');
    await create(page, 'Service', { x: 180, y: 520 });
    await create(page, 'Data Store', { x: 520, y: 520 });
    await connect(page, 0, 1);
    const shape = page.locator('.dc-node[data-type="service"]');
    await page.keyboard.press('Escape');
    await newSequence(page, ['Shopper', 'Orders'], { x: 760, y: 160 });

    const home = await dropBetweenFirstTwo(page, shape, 'stays linked');
    await expect(page.locator(HEAD)).toHaveCount(3);
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

  test('a shape tool put down on a sequence adds a participant of that kind, and the + between two adds one there', async ({ page }) => {
    await newCanvas(page, 'Placed');
    await newSequence(page, ['Shopper', 'Orders API']);

    // Data Store from the toolbar, clicked past the last participant.
    await page.getByRole('toolbar', { name: 'Create' }).getByRole('button', { name: 'Data Store', exact: true }).click();
    const last = (await page.locator(HEAD).nth(1).boundingBox())!;
    await page.mouse.click(last.x + last.width + 24, last.y + last.height + 40);
    await expect(page.locator(HEAD)).toHaveCount(3);
    await expect(page.locator('.dc-node[data-type="database"]')).toHaveCount(0);
    await expect(page.locator(HEAD).nth(2)).toHaveAttribute('aria-label', 'Participant Data Store');
    await expect(page.locator(PARTICIPANT_NAME)).toHaveCount(0);
    await renameParticipant(page, 2, 'Orders');
    await page.locator(HEAD).nth(2).click();
    await expect(page.locator(`${INSPECTOR} .dc-inspector-select`).first()).toContainText('Data Store');

    // The + between the first two: the others make room, and the name is typed where it will stand.
    await page.keyboard.press('Escape');
    await page.locator('.dc-seq-add').nth(1).click();
    await expect(page.locator(HEAD)).toHaveCount(4);
    await expect(page.locator(HEAD).nth(1)).toHaveAttribute('aria-label', 'Participant Participant 1');
    await expect(page.locator(PARTICIPANT_NAME)).toHaveCount(0);
    await renameParticipant(page, 1, 'Gateway');
    await page.keyboard.press('Escape');
    expect(await page.locator(HEAD).evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))).toEqual([
      'Participant Shopper',
      'Participant Gateway',
      'Participant Orders API',
      'Participant Orders',
    ]);
    // With the naming done the sequence itself is selected again, and offers what comes next.
    await expect(page.locator(INSPECTOR).getByRole('button', { name: 'Add participant' })).toBeVisible();
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
    await expect(page.locator('.dc-seq-present-lifelines path[stroke-dasharray]')).toHaveCount(3);
    // Only the message being told, and the two it is between, are drawn at full strength.
    expect(await page.locator('.dc-seq-now text').allTextContents()).toEqual(expect.arrayContaining(['1', 'GET /orders', 'Client', 'API']));
    expect(await page.locator('.dc-seq-now text').allTextContents()).not.toContain('Database');

    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.dc-explain-count')).toContainText('Step 2 / 2');
    expect(await page.locator('.dc-seq-now text').allTextContents()).toEqual(expect.arrayContaining(['2', 'SELECT orders', 'API', 'Database']));
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
    await page.locator(HEAD).first().click();
    const colour = page.getByRole('button', { name: 'Participant colour' });
    await colour.click();
    await page.getByRole('button', { name: 'Colour violet' }).click();
    await expect(colour).toHaveAttribute('aria-expanded', 'false');
    await draw(page, 0, 1, 'Place order');
    const numbering = page.getByRole('button', { name: 'Message numbers' });
    await page.locator(SEQUENCE).click({ position: { x: 30, y: 12 } });
    await expect(numbering).toHaveAttribute('aria-pressed', 'true');
    await numbering.click();
    await expect(numbering).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator(SEQUENCE).locator('text').getByText('1', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Saved locally')).toBeVisible();

    await reopenAfterReload(page, 'Kept');
    await expect(page.locator(SEQUENCE)).toHaveCount(1);
    await page.locator(SEQUENCE).hover();
    expect(await said(page)).toEqual(['Shopper to Storefront: Place order']);
    await page.locator(SEQUENCE).click({ position: { x: 30, y: 12 } });
    await expect(numbering).toHaveAttribute('aria-pressed', 'false');
    await numbering.click();
    await expect(page.locator(SEQUENCE).locator('text').getByText('1', { exact: true })).toHaveCount(1);
    await page.locator(HEAD).first().click();
    await colour.click();
    await expect(page.getByRole('button', { name: 'Colour violet' })).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('Escape');

    await page.locator(MESSAGE).first().dblclick();
    await expect(page.locator(LABEL)).toBeFocused();
    await page.keyboard.type('Check out');
    await page.keyboard.press('Enter');
    expect(await said(page)).toEqual(['Shopper to Storefront: Check out']);
  });

  test('connects two sequences at their participant lifelines', async ({ page }) => {
    await newCanvas(page, 'Two sequences');
    await newSequence(page, ['Sender'], { x: 265, y: 230 });
    await page.locator(CANVAS).hover({ position: { x: 880, y: 350 } });
    await page.keyboard.press('l');
    await expect(page.locator(SEQUENCE)).toHaveCount(2);
    const left = page.locator(SEQUENCE).first();
    const right = page.locator(SEQUENCE).last();
    await left.hover({ position: { x: 30, y: 12 } });
    const start = (await left.locator(LIFELINE).boundingBox())!;
    const destination = (await right.locator('.dc-node-surface').boundingBox())!;
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
    await page.mouse.down();
    await page.mouse.move(destination.x + 80, destination.y + 64, { steps: 12 });
    await expect(right.locator(`${LIFELINE}[data-endpoint-target="true"]`)).toHaveCount(1);
    await page.mouse.up();
    const edge = page.locator('.react-flow__edge');
    await expect(edge).toHaveCount(1);
    await expect(edge).toHaveAttribute('aria-label', /Sender.*Participant 1/);
    const route = edge.locator('.dc-edge-line');
    const destinationHead = (await right.locator(HEAD).boundingBox())!;
    const landed = await route.evaluate((path: SVGPathElement) => {
      const point = path.getPointAtLength(path.getTotalLength()).matrixTransform(path.getScreenCTM()!);
      return { x: point.x, y: point.y };
    });
    expect(Math.abs(landed.x - (destinationHead.x + destinationHead.width / 2))).toBeLessThan(2);
    expect(landed.y).toBeGreaterThanOrEqual(destinationHead.y + destinationHead.height - 3);
    const before = await route.getAttribute('d');
    const frame = (await right.boundingBox())!;
    await page.mouse.move(frame.x + 36, frame.y + 13);
    await page.mouse.down();
    await page.mouse.move(frame.x + 36, frame.y + 77, { steps: 8 });
    await page.mouse.up();
    await expect(route).not.toHaveAttribute('d', before!);
    await expect(left.locator(MESSAGE)).toHaveCount(0);
    await expect(page.getByText('Saved locally')).toBeVisible();
    await reopenAfterReload(page, 'Two sequences');
    await expect(edge).toHaveCount(1);
    await page.locator(SEQUENCE).last().hover({ position: { x: 35, y: 13 } });
    await page.locator(SEQUENCE).last().locator(HEAD).click();
    await page.keyboard.press('Delete');
    await expect(edge).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(edge).toHaveCount(1);
  });
});
