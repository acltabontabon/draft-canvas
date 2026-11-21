import { expect, test, type Page } from '@playwright/test';

import { notesOnlyDocument, storeDocument, type OutageDocument } from './fixtures/outage';

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
    await expect(headline(page)).toContainText('Pick a service, queue, data store or boundary to take down.');
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
