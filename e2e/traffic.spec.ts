import { expect, test, type Page } from '@playwright/test';

type TrafficDocument = {
  format: 'draft-canvas';
  version: number;
  metadata: { id: string; title: string; createdAt: number; updatedAt: number };
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  viewport: { x: number; y: number; zoom: number };
  settings: { showSequence: boolean; grid: 'dots'; background: { enabled: boolean; fit: 'cover'; dim: number; blur: number } };
  flows: [];
};

const node = (id: string, type: string, text: string, x: number, y: number, extra: Record<string, unknown> = {}) => ({
  id,
  type,
  x,
  y,
  width: type === 'database' ? 176 : 180,
  height: type === 'note' ? 80 : 84,
  z: 0,
  text,
  ...extra,
});

function trafficDocument(title = 'Traffic journey'): TrafficDocument {
  return {
    format: 'draft-canvas',
    version: 21,
    metadata: { id: 'traffic-journey', title, createdAt: 1, updatedAt: 2 },
    nodes: [
      node('gateway', 'service', 'API Gateway', 0, 0, { serviceKind: 'gateway' }),
      node('mobile', 'service', 'Mobile App API', 0, 220),
      node('checkout', 'service', 'Checkout', 360, 100),
      node('billing', 'service', 'Billing', 720, 0),
      node('postgres', 'database', 'PostgreSQL', 720, 240, { databaseKind: 'sql' }),
      node('note', 'note', 'A note outside runtime traffic', 380, 360, { noteKind: 'note' }),
    ],
    edges: [
      { id: 'gateway-checkout', source: 'gateway', target: 'checkout', directed: true, routing: 'smoothstep', semantic: 'calls' },
      { id: 'mobile-checkout', source: 'mobile', target: 'checkout', directed: true, routing: 'smoothstep', semantic: 'calls' },
      { id: 'checkout-postgres', source: 'checkout', target: 'postgres', directed: true, routing: 'smoothstep', semantic: 'readsWrites' },
      { id: 'billing-postgres', source: 'billing', target: 'postgres', directed: true, routing: 'smoothstep', semantic: 'readsWrites' },
    ],
    viewport: { x: 0, y: 0, zoom: 1 },
    settings: { showSequence: true, grid: 'dots', background: { enabled: false, fit: 'cover', dim: 0.55, blur: 0 } },
    flows: [],
  };
}

function notesOnlyDocument(): TrafficDocument {
  const document = trafficDocument('Notes only');
  return { ...document, nodes: [node('note', 'note', 'Only a note', 0, 0)], edges: [] };
}

async function importDocument(page: Page, document: TrafficDocument, fileName: string) {
  await page.goto('/');
  const input = page.locator('input[type="file"]');
  await input.waitFor({ state: 'attached' });
  await input.setInputFiles({
    name: fileName,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(document)),
  });
  await expect(page.locator('.dc-editor')).toBeVisible();
}

async function showTraffic(page: Page) {
  await page.locator('.dc-status-traffic').click();
  await expect(page.locator('.dc-canvas')).toHaveAttribute('data-traffic', 'on');
  await expect(page.getByRole('complementary', { name: 'Traffic' })).toHaveCount(0);
  await expect(page.locator('.dc-traffic-badge').first()).toBeVisible();
  await expect(page.locator('.dc-traffic-headline-note')).toContainText('Most paths meet at');
  await expect(page.locator('.dc-edge .dc-traffic-flow').first()).toBeVisible();
  await expect(page.locator('button.dc-traffic-note').first()).toBeVisible({ timeout: 5000 });
}

async function runCommand(page: Page, name: string) {
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Commands' });
  await expect(palette).toBeVisible();
  await palette.getByRole('combobox').fill(name);
  await page.keyboard.press('Enter');
}

async function editorRevision(page: Page) {
  return page.evaluate(async () => {
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    return useEditorStore.getState().revision;
  });
}

test.describe('Traffic', () => {
  test('offers Traffic for runtime connectors, but not for a notes-only diagram', async ({ page }) => {
    await importDocument(page, trafficDocument(), 'traffic.draftcanvas');
    await expect(page.locator('.dc-status-traffic')).toBeVisible();

    await importDocument(page, notesOnlyDocument(), 'notes-only.draftcanvas');
    await expect(page.locator('.dc-status-traffic')).toHaveCount(0);
  });

  test('shows traffic findings on the canvas instead of a panel', async ({ page }) => {
    await importDocument(page, trafficDocument(), 'traffic.draftcanvas');
    await showTraffic(page);
    await expect(page.locator('.react-flow__node[data-id="note"] .dc-node[data-traffic="dim"]')).toBeVisible();
  });

  test('expands and folds a traffic note with Escape or a canvas click', async ({ page }) => {
    await importDocument(page, trafficDocument(), 'traffic-notes.draftcanvas');
    await showTraffic(page);

    const note = page.locator('button.dc-traffic-note').first();
    await note.click();
    await expect(note).toHaveAttribute('aria-expanded', 'true');
    await expect(note.locator('.dc-traffic-note-more')).toHaveText(/.+[.!?]$/);

    await note.press('Escape');
    await expect(note).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.dc-traffic-note-more')).toHaveCount(0);
    await expect(page.locator('.dc-canvas')).toHaveAttribute('data-traffic', 'on');

    await note.click();
    await expect(note).toHaveAttribute('aria-expanded', 'true');
    await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } });
    await expect(note).toHaveAttribute('aria-expanded', 'false');
  });

  test('shows Checkout impact and cascades Escape from selection to traffic', async ({ page }) => {
    await importDocument(page, trafficDocument(), 'traffic-selection.draftcanvas');
    await showTraffic(page);

    await page.locator('.react-flow__node[data-id="checkout"] .dc-node').click();
    const callout = page.locator('.dc-traffic-callout');
    await expect(page.locator('.react-flow__node[data-id="checkout"] .dc-node[data-selected="true"]')).toBeVisible();
    await expect(callout).toContainText('paths');
    await expect(callout).toContainText("if it's down");

    await page.locator('.dc-canvas').focus();
    await page.keyboard.press('Escape');
    await expect(callout).toHaveCount(0);
    await expect(page.locator('.react-flow__node[data-id="checkout"] .dc-node[data-selected="true"]')).toHaveCount(0);
    await expect(page.locator('.dc-canvas')).toHaveAttribute('data-traffic', 'on');
    await page.keyboard.press('Escape');
    await expect(page.locator('.dc-canvas')).not.toHaveAttribute('data-traffic');
    await expect(page.locator('.dc-traffic-notes')).toHaveCount(0);
  });

  test('lets keyboard focus reach a note and Enter expand it', async ({ page }) => {
    await importDocument(page, trafficDocument(), 'traffic-keyboard.draftcanvas');
    await showTraffic(page);

    const note = page.locator('button.dc-traffic-note').first();
    await note.focus();
    await expect(note).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(note).toHaveAttribute('aria-expanded', 'true');
  });

  test('shows traffic from the command palette and hides it when Present starts', async ({ page }) => {
    await importDocument(page, trafficDocument('Traffic commands'), 'traffic-commands.draftcanvas');
    await runCommand(page, 'Show traffic');
    await expect(page.locator('.dc-canvas')).toHaveAttribute('data-traffic', 'on');

    await page.getByRole('button', { name: 'Present', exact: true }).click();
    await expect(page.locator('.dc-editor')).toHaveAttribute('data-mode', 'present');
    await expect(page.locator('.dc-canvas')).not.toHaveAttribute('data-traffic');
    await expect(page.locator('.dc-traffic-notes')).toHaveCount(0);
  });

  test('showing and hiding traffic leaves the editor revision unchanged', async ({ page }) => {
    await importDocument(page, trafficDocument('Traffic is transient'), 'traffic-transient.draftcanvas');
    const revision = await editorRevision(page);

    await showTraffic(page);
    await expect.poll(() => editorRevision(page)).toBe(revision);
    await page.locator('.dc-status-traffic').click();
    await expect(page.locator('.dc-canvas')).not.toHaveAttribute('data-traffic');
    await expect.poll(() => editorRevision(page)).toBe(revision);
  });

  test('keeps notes and badges visible with reduced motion in dark mode', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce', colorScheme: 'dark' });
    await importDocument(page, trafficDocument('Traffic dark'), 'traffic-dark.draftcanvas');
    await showTraffic(page);
    await expect(page.locator('.dc-traffic-badge').first()).toBeVisible();
    await expect(page.locator('button.dc-traffic-note').first()).toBeVisible();
  });
});
