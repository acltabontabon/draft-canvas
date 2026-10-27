import { expect, test, type Page } from '@playwright/test';

import { notesOnlyDocument, recoveryDocument, trafficDocument, type TrafficDocument } from './fixtures/traffic';

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
    await expect(callout.locator('.dc-traffic-callout-metric')).toHaveText('~2,000 calls/min');
    await expect(callout.locator('.dc-traffic-callout-sources li')).toHaveCount(2);
    await expect(callout.getByRole('heading', { name: /Calls waiting|If it goes down/ })).toBeVisible();
    const frame = await page.locator('.dc-canvas').boundingBox();
    const noteBounds = await callout.boundingBox();
    expect(noteBounds!.x).toBeGreaterThanOrEqual(frame!.x);
    expect(noteBounds!.y).toBeGreaterThanOrEqual(frame!.y);
    expect(noteBounds!.x + noteBounds!.width).toBeLessThanOrEqual(frame!.x + frame!.width);
    expect(noteBounds!.y + noteBounds!.height).toBeLessThanOrEqual(frame!.y + frame!.height);
    const clearOfFindings = await callout.evaluate((element) => {
      const at = element.getBoundingClientRect();
      return [...window.document.querySelectorAll('.dc-traffic-note, .dc-traffic-headline-note')].every((note) => {
        const other = note.getBoundingClientRect();
        return at.right <= other.left || at.left >= other.right || at.bottom <= other.top || at.top >= other.bottom;
      });
    });
    expect(clearOfFindings).toBe(true);

    await page.getByRole('button', { name: 'Zoom out', exact: true }).click();
    const zoomedBounds = await callout.boundingBox();
    expect(Math.abs(zoomedBounds!.width - noteBounds!.width)).toBeLessThan(1);

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

  for (const colorScheme of ['light', 'dark'] as const) {
    test(`keeps traffic above overlapping connector labels and raised shapes in ${colorScheme} mode`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce', colorScheme });
      const document = trafficDocument('Overlapping labels');
      document.edges[0]!.label = 'A connector label under the traffic finding';
      document.nodes[0]!.z = 10000;
      await importDocument(page, document, 'traffic-overlap.draftcanvas');
      await showTraffic(page);

      const note = page.locator('button.dc-traffic-note').first();
      // Force the collision a dense drawing can produce. Hit testing must reach the traffic
      // finding even when a raised shape and an editable connector label sit directly below it.
      await note.evaluate((element) => {
        const label = window.document.querySelector<HTMLElement>('.dc-edge-label')!;
        const shape = window.document.querySelector<HTMLElement>('.react-flow__node[data-id="gateway"]')!;
        const at = element.getBoundingClientRect();
        for (const obstacle of [label, shape]) {
          const before = obstacle.getBoundingClientRect();
          const zoom = new DOMMatrix(getComputedStyle(window.document.querySelector('.react-flow__viewport')!).transform).a;
          obstacle.style.translate = `${(at.x - before.x) / zoom}px ${(at.y - before.y) / zoom}px`;
        }
      });
      const bounds = await note.boundingBox();
      expect(bounds).not.toBeNull();
      const point = { x: bounds!.x + bounds!.width / 2, y: bounds!.y + bounds!.height / 2 };
      const top = await page.evaluate(({ x, y }) => Boolean(window.document.elementFromPoint(x, y)?.closest('button.dc-traffic-note')), point);
      expect(top).toBe(true);
      // A solid board-coloured mask keeps underlying words from showing through the finding.
      await expect(note).toHaveCSS('background-color', await page.locator('.dc-canvas').evaluate((element) => getComputedStyle(element).backgroundColor));
      await note.click();
      await expect(note).toHaveAttribute('aria-expanded', 'true');
    });
  }

  test('can delete every shape and undo while traffic stays active', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await importDocument(page, trafficDocument(), 'traffic-delete-all.draftcanvas');
    await showTraffic(page);
    await page.locator('.dc-canvas').focus();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    await expect(page.locator('.react-flow__node')).toHaveCount(0);
    await expect(page.locator('.dc-editor')).toBeVisible();
    await expect(page.locator('.dc-traffic-notes')).toHaveCount(0);
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.locator('.react-flow__node')).toHaveCount(6);
    await expect(page.locator('button.dc-traffic-note').first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('lays out long findings once and keeps their lines anchored when expanded', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const document = trafficDocument('Long traffic findings');
    document.nodes[0]!.serviceKind = 'api';
    document.nodes[0]!.text = 'International storefront for customers placing wholesale orders';
    document.nodes[1]!.text = 'Mobile storefront for customers placing international wholesale orders';
    document.nodes[2]!.text = 'Checkout for customers placing international wholesale orders with delivery tracking';
    document.nodes[4]!.text = 'Database for customers placing international wholesale orders with delivery tracking';
    document.edges.push({ id: 'checkout-billing', source: 'checkout', target: 'billing', directed: true, semantic: 'calls' });
    await importDocument(page, document, 'traffic-long-notes.draftcanvas');
    await showTraffic(page);
    const title = page.locator('.dc-hand-title');
    await expect(title.locator('.dc-hand-title-line')).toHaveCount(3);
    const titleBounds = await title.boundingBox();
    const firstNode = await page.locator('.react-flow__node[data-id="gateway"]').boundingBox();
    expect(titleBounds!.y + titleBounds!.height).toBeLessThan(firstNode!.y);
    const note = page.getByRole('button', { name: /^only way in/ }).first();
    const rows = note.locator('.dc-traffic-note-line');
    await expect(rows).toHaveCount(3);
    const before = await rows.first().boundingBox();
    await note.click();
    const after = await rows.first().boundingBox();
    expect(Math.abs(after!.y - before!.y)).toBeLessThan(1);
    await expect(note.locator('.dc-traffic-note-more')).toContainText('International storefront');
    for (const row of await rows.all()) await expect(row).toHaveCSS('white-space', 'pre');
  });

  test('scrolls a field note by keyboard without editing the selected shape', async ({ page }) => {
    await page.setViewportSize({ width: 640, height: 460 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await importDocument(page, trafficDocument(), 'traffic-small-view.draftcanvas');
    await runCommand(page, 'Show traffic');
    await expect(page.locator('.dc-canvas')).toHaveAttribute('data-traffic', 'on');
    await page.locator('.react-flow__node[data-id="checkout"] .dc-node').click();
    const note = page.locator('.dc-traffic-callout');
    const revision = await editorRevision(page);
    await note.focus();
    await note.press('ArrowDown');
    await note.press('PageDown');
    await expect.poll(() => note.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await note.press('Backspace');
    expect(await editorRevision(page)).toBe(revision);
    expect(await note.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
    const at = await note.boundingBox();
    const frame = await page.locator('.dc-canvas').boundingBox();
    expect(at!.y + at!.height).toBeLessThanOrEqual(frame!.y + frame!.height);
    await note.press('Escape');
    await expect(note).toHaveCount(0);
    await expect(page.locator('.dc-canvas')).toBeFocused();
    await expect(page.locator('.dc-canvas')).toHaveAttribute('data-traffic', 'on');
  });
});


test('illustrative traffic explains the fixed example without rate controls', async ({ page }) => {
  await importDocument(page, trafficDocument(), 'traffic-scenario.draftcanvas');
  await showTraffic(page);
  const scenario = page.locator('.dc-traffic-scenario');
  await expect(scenario).toContainText('1,000 starts/min per entry');
  await expect(scenario.getByRole('button')).toHaveCount(1);
  const revision = await editorRevision(page);
  const closedBounds = await scenario.boundingBox();
  await scenario.getByRole('button', { name: 'How to read this' }).focus();
  await page.keyboard.press('Enter');
  await expect(scenario).toContainText('not live measurements');
  expect(await editorRevision(page)).toBe(revision);
  expect((await scenario.boundingBox())!.height).toBe(closedBounds!.height);
  const helpBounds = await scenario.getByRole('region', { name: 'Traffic reading guide' }).boundingBox();
  expect(helpBounds!.height).toBeLessThanOrEqual(180);
  expect(helpBounds!.width).toBeLessThanOrEqual(320);
  await scenario.getByRole('region', { name: 'Traffic reading guide' }).focus();
  await page.keyboard.press('Escape');
  await expect(scenario.getByRole('button', { name: 'How to read this' })).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.dc-canvas')).toHaveAttribute('data-traffic', 'on');
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`traffic controls fit a narrow canvas in ${colorScheme} mode`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await importDocument(page, trafficDocument(), 'traffic-narrow.draftcanvas');
    await runCommand(page, 'Show traffic');
    const scenario = page.locator('.dc-traffic-scenario');
    await scenario.getByRole('button', { name: 'How to read this' }).click();
    await expect(scenario).toContainText('Example only:');
    const guide = scenario.getByRole('region', { name: 'Traffic reading guide' });
    const helpBounds = await guide.boundingBox();
    expect(helpBounds!.height).toBeLessThanOrEqual(180);
    expect(helpBounds!.width).toBeLessThanOrEqual(320);
    const bounds = await scenario.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await expect(scenario).toContainText('1,000 starts/min per entry');
    await page.screenshot({ path: `/tmp/traffic-mobile-${colorScheme}.png` });
    await page.locator('.react-flow__pane').click({ position: { x: 20, y: 220 } });
    await expect(guide).toHaveCount(0);
  });
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`explains incoming rates and unfolds work per request in ${colorScheme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await importDocument(page, trafficDocument(), 'traffic-work.draftcanvas');
    await showTraffic(page);
    await page.locator('.react-flow__node[data-id="checkout"] .dc-node').click();
    const callout = page.locator('.dc-traffic-callout');
    await expect(callout.getByRole('list', { name: 'Rate breakdown' })).toContainText('API Gateway');
    await expect(callout.locator('.dc-traffic-callout-count')).toHaveText(['~1,000 calls/min', '~1,000 calls/min']);
    const fold = callout.locator('summary');
    await expect(fold).toHaveText('One request from here…');
    await fold.focus();
    await page.keyboard.press('Enter');
    await expect(callout.locator('details')).toHaveAttribute('open', '');
    await expect(callout.getByRole('list', { name: 'Work per arrival' })).toHaveText('1 data operation');
    await expect(page.getByRole('toolbar', { name: 'Selection options' })).toHaveCount(0);
    await callout.getByRole('list', { name: 'Work per arrival' }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `/tmp/traffic-work-${colorScheme}.png` });
    await page.locator('.react-flow__node[data-id="postgres"] .dc-node').click();
    const downstream = callout.locator('details').filter({ hasText: 'One operation from here' });
    await expect(downstream).not.toHaveAttribute('open');
    await downstream.locator('summary').click();
    await expect(callout.getByRole('list', { name: 'Work per arrival' })).toHaveText('No downstream work drawn.');
  });
}


test('the unfolded work note stays inside a phone-width canvas', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await importDocument(page, trafficDocument(), 'traffic-work-mobile.draftcanvas');
  await runCommand(page, 'Show traffic');
  await page.locator('.react-flow__node[data-id="checkout"] .dc-node').click();
  const callout = page.locator('.dc-traffic-callout');
  await callout.locator('summary').click();
  await expect(callout.getByRole('list', { name: 'Work per arrival' })).toHaveText('1 data operation');
  const bounds = await callout.boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  await page.screenshot({ path: '/tmp/traffic-work-mobile.png' });
});

test('replay batches show total recovery work without editing the diagram or baseline', async ({ page }) => {
  await importDocument(page, recoveryDocument(), 'recovery.draftcanvas');
  await page.locator('.dc-status-traffic').click();
  const revision = await editorRevision(page);
  const workerRate = page.locator('.react-flow__node[data-id="worker"] .dc-traffic-badge');
  await expect(workerRate).toContainText('1,000 calls/min');
  await page.locator('.react-flow__node[data-id="dlq"] .dc-node').click();
  const recovery = page.locator('.dc-traffic-recovery');
  await recovery.locator('summary').click();
  const count = page.getByRole('textbox', { name: 'Messages to replay' });
  await expect(count).toHaveValue('1');
  await count.fill('500');
  await expect(recovery.getByLabel('Recovery totals')).toContainText('500 data operations');
  await expect(recovery.getByLabel('Recovery totals')).toContainText('500 message deliveries');
  await expect(workerRate).toContainText('1,000 calls/min');
  await expect(page.locator('.dc-traffic-replay-badge')).toHaveCount(2);
  await count.fill('1000');
  await expect(page.locator('.dc-traffic-replay-badge').filter({ hasText: 'data ops' })).toContainText('Replay +1,000 data ops total');
  await expect(page.locator('.dc-traffic-replay-badge').filter({ hasText: 'data ops' })).toContainText('~1,000 data ops/min');
  await expect(workerRate).toContainText('1,000 calls/min');
  await count.fill('500');
  await count.press('Backspace');
  await expect(count).toHaveValue('50');
  await count.fill('0');
  await expect(recovery.getByRole('alert')).toBeVisible();
  await count.fill('500');
  expect(await editorRevision(page)).toBe(revision);
  await page.screenshot({ path: '/tmp/traffic-recovery-preview.png' });
  await recovery.getByRole('button', { name: 'Worker', exact: true }).click();
  await expect(page.locator('.dc-traffic-callout')).toContainText('Worker');
  await expect(page.locator('.dc-traffic-replay-badge')).toHaveCount(0);
});

for (const colorScheme of ['light', 'dark'] as const) {
  test(`recovery notes stay compact on a narrow canvas in ${colorScheme}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    await importDocument(page, recoveryDocument(), 'recovery-narrow.draftcanvas');
    await runCommand(page, 'Show traffic');
    await page.locator('.react-flow__node[data-id="dlq"] .dc-node').click();
    await page.locator('.dc-traffic-recovery summary').click();
    await page.getByRole('textbox', { name: 'Messages to replay' }).fill('500');
    const bounds = await page.locator('.dc-traffic-callout').boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
    expect(bounds!.height).toBeLessThanOrEqual(500);
    await page.screenshot({ path: `/tmp/traffic-recovery-mobile-${colorScheme}.png` });
  });
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`database work separates reads and writes in ${colorScheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme, reducedMotion: 'reduce' });
    const document = recoveryDocument();
    document.edges.push({ id: 'read', source: 'api', target: 'db', semantic: 'reads', directed: true });
    await importDocument(page, document, 'database-work.draftcanvas');
    await page.locator('.dc-status-traffic').click();
    const revision = await editorRevision(page);
    await page.locator('.react-flow__node[data-id="db"] .dc-node').click();
    await page.locator('.dc-traffic-database summary').click();
    const work = page.getByRole('list', { name: 'Database work', exact: true });
    await expect(work).toContainText('~1,000 reads/min');
    await expect(work).toContainText('~1,000 writes/min');
    await expect(page.locator('.dc-traffic-database input')).toHaveCount(0);
    expect(await editorRevision(page)).toBe(revision);
    await page.screenshot({ path: `/tmp/database-work-${colorScheme}.png` });
  });
}
