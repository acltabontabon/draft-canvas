import { expect, test, type Page } from '@playwright/test';

import { notesOnlyDocument, storeDocument, storeWithFlows, type OutageDocument } from './fixtures/outage';

async function importDocument(page: Page, document: OutageDocument, fileName: string) {
  await page.goto('/');
  const input = page.locator('input[type="file"]');
  await input.waitFor({ state: 'attached' });
  await input.setInputFiles({ name: fileName, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document)) });
  await expect(page.locator('.dc-editor')).toBeVisible();
}

const shape = (page: Page, id: string) => page.locator(`.react-flow__node[data-id="${id}"] .dc-node`);
const headline = (page: Page) => page.locator('.dc-outage-headline');
const note = (page: Page, text: string | RegExp) => page.locator('button.dc-outage-note', { hasText: text });

async function takeDown(page: Page, id: string) {
  await shape(page, id).click();
  await expect(shape(page, id)).toHaveAttribute('data-outage', /down|degraded/);
}

test.describe('Outage walk', () => {
  test('is offered for something that runs, but not for a notes-only diagram', async ({ page }) => {
    await importDocument(page, storeDocument(), 'store.draftcanvas');
    await expect(page.locator('.dc-status-outage')).toBeVisible();

    await importDocument(page, notesOnlyDocument(), 'notes-only.draftcanvas');
    await expect(page.locator('.dc-status-outage')).toHaveCount(0);
  });

  test('opens waiting for a shape, leaving the diagram as drawn until one is picked', async ({ page }) => {
    await importDocument(page, storeDocument(), 'store.draftcanvas');
    await page.locator('.dc-status-outage').click();

    await expect(page.locator('.dc-canvas')).toHaveAttribute('data-outage', 'on');
    await expect(headline(page)).toContainText('Pick a service, queue, data store, boundary or connector to take down.');
    await expect(page.locator('.dc-node[data-outage]')).toHaveCount(0);
    await expect(page.getByRole('complementary', { name: 'Outage' })).toHaveCount(0);
  });

  test('follows a failing dependency through the queue to the dead-letter queue', async ({ page }) => {
    await importDocument(page, storeDocument(), 'store.draftcanvas');
    await page.locator('.dc-status-outage').click();
    await takeDown(page, 'payments');

    await expect(headline(page)).toContainText('Payment provider is down.');
    await expect(shape(page, 'fulfilment')).toHaveAttribute('data-outage', 'failing');
    await expect(shape(page, 'orders')).toHaveAttribute('data-outage', 'retrying');
    await expect(shape(page, 'dlq')).toHaveAttribute('data-outage', 'catching');
    await expect(shape(page, 'storefront')).toHaveAttribute('data-outage', 'lit');
    await expect(shape(page, 'note')).toHaveAttribute('data-outage', 'dim');
    await expect(page.locator('.dc-edge[data-outage="recovery"] .dc-outage-flow')).toHaveCount(1);
    await expect(note(page, 'calls fail')).toBeVisible();
    await expect(note(page, 'dead-letters after 3 attempts')).toBeVisible();
    await expect(note(page, 'no replay drawn')).toBeVisible();
    // No invented numbers anywhere on the canvas.
    await expect(page.locator('.dc-outage-notes')).not.toContainText(/\/min|rps|%/);
  });

  test('lists what each outage would do before one is picked, and takes down the one chosen', async ({ page }) => {
    await importDocument(page, storeWithFlows(), 'store.draftcanvas');
    await page.locator('.dc-status-outage').click();

    const rows = page.getByRole('region', { name: 'What each outage would do' }).getByRole('button');
    await expect(rows.first()).toHaveText('StorefrontShopper sees the failure · 3 flows break1 question');
    const review = page.getByRole('region', { name: 'What each outage would do' });
    await expect(review.getByRole('list', { name: 'A person sees it' }).getByRole('button')).toHaveCount(3);
    await expect(review.getByRole('list', { name: 'No one drawn waits on it' }).getByRole('button')).toHaveCount(4);
    // Connections are folded away until asked for; a row there circles both of its ends.
    const connections = review.getByRole('list', { name: /Connections/ }).getByRole('button');
    await expect(connections.first()).toBeHidden();
    await review.getByText('Connections').click();
    await expect(connections.first()).toBeVisible();
    await connections.filter({ hasText: 'Order events → Fulfilment' }).hover();
    await expect(page.locator('.dc-outage-point')).toHaveCount(2);
    await review.getByText('Connections').click();
    // A row circles its shape in the drawing, by pointer or by keyboard, and lets go of it after.
    await rows.first().hover();
    await expect(page.locator('.dc-outage-point[data-reaches]')).toHaveCount(1);
    await rows.filter({ hasText: 'Fulfilment' }).focus();
    await expect(page.locator('.dc-outage-point:not([data-reaches])')).toHaveCount(1);
    await page.mouse.move(700, 300);
    await rows.filter({ hasText: 'Fulfilment' }).blur();
    await expect(page.locator('.dc-outage-point')).toHaveCount(0);
    await expect(page.getByText('Checkout ×2: losing one instance changes nothing drawn.')).toBeVisible();
    // The diagram is still as drawn: the list is a way in, not a reading of its own.
    await expect(page.locator('.dc-node[data-outage]')).toHaveCount(0);

    await rows.filter({ hasText: 'Payment provider' }).first().click();
    await expect(headline(page)).toContainText('Payment provider is down.');
    await expect(rows).toHaveCount(0);
    await expect(page.locator('.dc-outage-point')).toHaveCount(0);
  });

  test('takes a connector down by clicking it, with both of its ends left up', async ({ page }) => {
    await importDocument(page, storeWithFlows(), 'store.draftcanvas');
    await page.locator('.dc-status-outage').click();
    await page.locator('.react-flow__edge[data-id="orders-fulfilment"]').click({ force: true });

    await expect(headline(page)).toContainText("Order events can't reach Fulfilment.");
    await expect(page.locator('.dc-edge[data-outage="cut"] .dc-outage-cut')).toHaveCount(1);
    await expect(shape(page, 'orders')).toHaveAttribute('data-outage', 'holding');
    await expect(shape(page, 'fulfilment')).toHaveAttribute('data-outage', 'quiet');
    await expect(page.locator('.dc-node[data-outage="down"]')).toHaveCount(0);
    await expect(note(page, "holds messages while it's cut off")).toBeVisible();

    // A shape taken down next replaces it.
    await takeDown(page, 'payments');
    await expect(page.locator('.dc-outage-cut')).toHaveCount(0);
  });

  test('says a write and a message have come apart when the publish between them fails', async ({ page }) => {
    await importDocument(page, storeWithFlows(), 'store.draftcanvas');
    await page.locator('.dc-status-outage').click();
    await page.locator('.react-flow__edge[data-id="checkout-orders"]').click({ force: true });

    await expect(headline(page)).toContainText("Checkout can't reach Order events.");
    await note(page, "can't publish").click();
    // The flow puts the write first, so the note says so instead of "if".
    await expect(note(page, "can't publish")).toContainText('Checkout also writes to Orders, before this in Place an order; nothing drawn keeps that and the message in step.');
    // Unfolded, the sentence takes room of its own: it covers no shape, and its answers sit under it.
    const sentence = (await page.locator('.dc-outage-note-more').boundingBox())!;
    for (const box of await page.locator('.react-flow__node .dc-node').all()) {
      const shape = (await box.boundingBox())!;
      const apart = shape.x >= sentence.x + sentence.width || shape.x + shape.width <= sentence.x || shape.y >= sentence.y + sentence.height || shape.y + shape.height <= sentence.y;
      expect(apart).toBe(true);
    }
    const answers = (await page.getByRole('group', { name: /What does Checkout do with a message/ }).boundingBox())!;
    expect(answers.y).toBeGreaterThanOrEqual(sentence.y + sentence.height - 1);
  });

  test('says what the outage does to each flow', async ({ page }) => {
    await importDocument(page, storeWithFlows(), 'store.draftcanvas');
    await page.locator('.dc-status-outage').click();
    await takeDown(page, 'payments');

    const flows = page.getByRole('list', { name: 'What it does to each flow' }).getByRole('listitem');
    await expect(flows).toHaveText(['Fulfil an order breaks at step 1 of 2', 'Browse the catalog carries on', 'Place an order carries on']);
    await expect(flows.first()).toHaveAttribute('title', 'Step 1 of 2 in Fulfil an order (Order events → Fulfilment) fails. 1 later step is hit too.');

    // Everything is reached through the storefront, so with it down no order arrives to fulfil.
    await takeDown(page, 'storefront');
    await expect(flows).toHaveText(['Browse the catalog breaks at step 1 of 3', 'Place an order breaks at step 1 of 4', 'Fulfil an order breaks at step 1 of 2']);
    await expect(flows.last()).toHaveAttribute('title', /doesn't happen: nothing travels it while Storefront is down/);
  });

  test('unfolds a note in place and folds it with Escape without ending the walk', async ({ page }) => {
    await importDocument(page, storeDocument(), 'store.draftcanvas');
    await page.locator('.dc-status-outage').click();
    await takeDown(page, 'payments');

    const calls = note(page, 'calls fail');
    await calls.click();
    await expect(calls).toHaveAttribute('aria-expanded', 'true');
    await expect(calls).toContainText('outside your system');
    await calls.press('Escape');
    await expect(calls).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.dc-canvas')).toHaveAttribute('data-outage', 'on');
  });

  test('answers a question by drawing it, as one undoable edit the walk reads at once', async ({ page }) => {
    await importDocument(page, storeDocument(), 'store.draftcanvas');
    await page.locator('.dc-status-outage').click();
    await takeDown(page, 'payments');

    await page.getByRole('button', { name: 'Draw the replay route' }).click();
    await expect(note(page, 'replay from here once')).toBeVisible();
    await expect(note(page, 'no replay drawn')).toHaveCount(0);
    await expect(page.locator('.dc-edge')).toHaveCount(10);

    await page.locator('.dc-canvas').focus();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('.dc-edge')).toHaveCount(9);
    await expect(note(page, 'no replay drawn')).toBeVisible();
  });

  test('keeps a question on the shape as an open point', async ({ page }) => {
    await importDocument(page, storeDocument(), 'store.draftcanvas');
    await page.locator('.dc-status-outage').click();
    await takeDown(page, 'payments');

    const answers = page.getByRole('group', { name: 'What should Fulfilment do while Payment provider is down?' });
    await answers.getByRole('button', { name: 'Keep as open point' }).click();
    await expect(answers.getByRole('button', { name: 'Kept as open point' })).toBeDisabled();
    await expect(page.locator('.dc-status-open-points')).toContainText('1');
  });

  test('loses one instance of a replicated service before all of them', async ({ page }) => {
    await importDocument(page, storeDocument(), 'store.draftcanvas');
    await page.locator('.dc-status-outage').click();
    await takeDown(page, 'checkout');

    await expect(headline(page)).toContainText('One of 2 Checkout instances is down.');
    await expect(note(page, '1 of 2 still running')).toBeVisible();
    await expect(shape(page, 'shopper')).toHaveAttribute('data-outage', 'lit');

    await page.getByRole('button', { name: 'All 2' }).click();
    await expect(headline(page)).toContainText('All 2 Checkout instances are down.');
    await expect(shape(page, 'storefront')).toHaveAttribute('data-outage', 'failing');
    await expect(shape(page, 'shopper')).toHaveAttribute('data-outage', 'failing');
    await expect(shape(page, 'fulfilment')).toHaveAttribute('data-outage', 'quiet');
  });

  test('reads a cache as something fallen through', async ({ page }) => {
    await importDocument(page, storeDocument(), 'store.draftcanvas');
    await page.locator('.dc-status-outage').click();
    await takeDown(page, 'cache');

    await expect(shape(page, 'storefront')).toHaveAttribute('data-outage', 'degraded');
    await expect(shape(page, 'shopper')).toHaveAttribute('data-outage', 'lit');
    await expect(note(page, 'every read falls to Catalog?')).toBeVisible();
  });

  test('links a quoted product behaviour to the page it was read from', async ({ page }) => {
    await importDocument(page, storeDocument(), 'store.draftcanvas');
    await page.locator('.dc-status-outage').click();
    await takeDown(page, 'cache');

    // Folded, the note is a few words; the source belongs with the sentence it supports.
    await expect(page.locator('.dc-outage-source')).toHaveCount(0);
    await note(page, /every read falls to/).click();
    const source = page.locator('.dc-outage-source a');
    await expect(source).toHaveText('Redis documentation');
    await expect(source).toHaveAttribute('href', 'https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/');
    await expect(source).toHaveAttribute('target', '_blank');
  });

  test('starts from a shape’s menu and ends with Escape', async ({ page }) => {
    await importDocument(page, storeDocument(), 'store.draftcanvas');
    await shape(page, 'orders-db').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Take down' }).click();

    await expect(headline(page)).toContainText('Orders is down.');
    await page.locator('.dc-canvas').focus();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await expect(page.locator('.dc-canvas')).not.toHaveAttribute('data-outage', 'on');
    await expect(page.locator('.dc-node[data-outage]')).toHaveCount(0);
  });
});
