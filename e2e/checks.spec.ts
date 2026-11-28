import { expect, test, type Page } from '@playwright/test';

/*
 * Checks in the editor: a count in the status bar while the drawing has something to say, a list
 * that goes to each part, and nothing at all on a diagram with nothing to report.
 */
const node = (id: string, type: string, text: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({ id, type, text, x, y, width: 180, height: 84, z: 0, ...extra });
const edge = (id: string, source: string, target: string, semantic: string) => ({ id, source, target, semantic, semanticsOrigin: 'explicit', directed: true, routing: 'orthogonal' });

function store(extraEdges: Array<Record<string, unknown>> = []) {
  // Inside Orders: a queue with a publisher and nothing consuming it.
  const inside = {
    nodes: [node('pub', 'service', 'Order Publisher', 0, 0), node('q', 'queue', 'order-events', 320, 0, { queueKind: 'queue' })],
    edges: [edge('p1', 'pub', 'q', 'publishes')],
    flows: [],
    viewport: { x: 0, y: 0, zoom: 1 },
  };
  return {
    format: 'draft-canvas',
    version: 34,
    metadata: { id: 'checks-e2e', title: 'Online store', createdAt: 1, updatedAt: 1 },
    nodes: [node('web', 'service', 'Storefront', 0, 0), node('orders', 'service', 'Orders', 320, 0, { inside }), node('stock', 'service', 'Stock', 640, 0), node('pricing', 'service', 'Pricing', 320, 240)],
    // Orders, Stock and Pricing call each other in a loop.
    edges: [edge('e1', 'web', 'orders', 'http'), edge('e2', 'orders', 'stock', 'calls'), edge('e3', 'stock', 'pricing', 'calls'), edge('e4', 'pricing', 'orders', 'calls'), ...extraEdges],
    flows: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: {},
  };
}

async function importDocument(page: Page, document: unknown, fileName: string) {
  await page.goto('/');
  const input = page.locator('input[type="file"]');
  await input.waitFor({ state: 'attached' });
  await input.setInputFiles({ name: fileName, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(document)) });
  await expect(page.locator('.dc-editor')).toBeVisible();
}

const chip = (page: Page) => page.locator('button.dc-status-checks');
const panel = (page: Page) => page.getByRole('complementary', { name: 'Checks' });
const selected = (page: Page) => page.locator('.react-flow__node.selected');

test.describe('Checks', () => {
  test('counts what the drawing says and lists it, in this view and inside others', async ({ page }) => {
    await importDocument(page, store(), 'store.draftcanvas');
    await expect(chip(page)).toHaveText('2 to check');
    await expect(chip(page)).toHaveAttribute('aria-expanded', 'false');
    // Its accessible name carries the words it shows.
    await expect(chip(page)).toHaveAttribute('aria-label', 'Checks: 2 to check, review');

    await chip(page).click();
    await expect(panel(page)).toBeVisible();
    const rows = panel(page).locator('.dc-checks-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('"Orders", "Pricing", "Stock" call each other in a loop');
    await expect(rows.nth(1)).toContainText('in Orders');
    await expect(rows.nth(1)).toContainText('nothing consumes them');
    // Told apart by a word, never by colour alone.
    await expect(rows.nth(0)).toContainText('Worth a look');
  });

  test('a row goes to the part it is about, into another view when that is where it is', async ({ page }) => {
    await importDocument(page, store(), 'store.draftcanvas');
    await chip(page).click();
    const rows = panel(page).locator('.dc-checks-main');

    await rows.nth(0).click();
    await expect(selected(page)).toHaveAttribute('data-id', 'orders');

    await rows.nth(1).click();
    await expect(page.locator('.react-flow__node[data-id="q"]')).toBeVisible();
    await expect(selected(page)).toHaveAttribute('data-id', 'q');
    // The list is of the whole file, so it is still there, and still counts both.
    await expect(panel(page)).toBeVisible();
    await expect(chip(page)).toHaveText('2 to check');
  });

  test('opens from the command palette and closes from its own button, giving focus back to the canvas', async ({ page }) => {
    await importDocument(page, store(), 'store.draftcanvas');
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.type('check this');
    await page.keyboard.press('Enter');
    await expect(panel(page)).toBeVisible();
    await panel(page).getByRole('button', { name: 'Close checks' }).click();
    await expect(panel(page)).toBeHidden();
    await expect(chip(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('shares its corner with Open points: one list at a time', async ({ page }) => {
    await importDocument(page, { ...store(), openPoints: [{ id: 'op1', kind: 'tentative', targets: [{ kind: 'node', id: 'web' }] }] }, 'store.draftcanvas');
    await chip(page).click();
    await expect(panel(page)).toBeVisible();
    await page.locator('button.dc-status-open-points').click();
    await expect(page.getByRole('complementary', { name: 'Open points' })).toBeVisible();
    await expect(panel(page)).toBeHidden();
  });

  test('spotlights what a shape touches, by any relation, from the command palette', async ({ page }) => {
    const doc = store([edge('e9', 'web', 'stock', 'calls')]);
    doc.nodes.push(node('audit', 'service', 'Audit', 0, 240), node('mail', 'service', 'Mailer', 640, 240));
    doc.edges.push(edge('e8', 'audit', 'mail', 'calls'));
    await importDocument(page, doc, 'store.draftcanvas');
    await page.locator('.react-flow__node[data-id="pricing"] .dc-node').click();
    await page.keyboard.press('ControlOrMeta+k');
    await page.keyboard.type('what it touches');
    await page.keyboard.press('Enter');
    // Pricing is in the loop with Orders and Stock, which Storefront reaches: four shapes, and the
    // five connectors between them. Audit and Mailer have nothing to do with it.
    await expect(page.getByText('Spotlight · 4 shapes, 5 connectors')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByText(/^Spotlight ·/)).toHaveCount(0);
  });

  test('says nothing on a diagram with nothing to report', async ({ page }) => {
    const clean = store();
    clean.edges = clean.edges.filter((item) => item.id !== 'e4');
    (clean.nodes[1] as { inside?: unknown }).inside = undefined;
    await importDocument(page, clean, 'clean.draftcanvas');
    await expect(page.locator('.react-flow__node[data-id="orders"]')).toBeVisible();
    await expect(chip(page)).toHaveCount(0);
  });
});
