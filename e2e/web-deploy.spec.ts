import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * What has to be true of the published artifact, served the way it is hosted: the site and the
 * editor each at the root of an origin of their own (draftcanvas.dev, app.draftcanvas.dev), and the
 * old front door under /draft-canvas/ (acltabontabon.com). scripts/serve-web.mjs gives each a port.
 *
 * These are failures a single root-served preview cannot see: an asset URL wrong by one directory,
 * the two bundles leaking into each other, an old link that stopped forwarding. They are about
 * behaviour and structure — deliberately not about the copy on the page, which is rewritten often
 * and is not what a test should be pinning down.
 */

const port = Number(process.env.DC_WEB_PORT ?? 4174);
const SITE = '/';
const APP = `http://localhost:${port + 1}/`;
const OLD = `http://localhost:${port + 2}/draft-canvas/`;

test('the landing page is served at the root, and points at the editor\'s own address', async ({ page }) => {
  const failures: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.goto(SITE);

  const hero = page.getByRole('region', { name: 'Make your system clear.' });
  await expect(hero.getByRole('heading', { level: 1 })).toBeInViewport();
  await expect(hero.getByRole('heading', { name: 'Technology-aware shapes' })).toBeInViewport();
  await expect(hero.getByRole('link', { name: 'Explore examples' })).toBeInViewport();
  await expect(page.getByRole('link', { name: 'Open web editor' }).first()).toHaveAttribute(
    'href',
    'https://app.draftcanvas.dev/',
  );
  expect(failures, 'nothing on the landing page 404s').toEqual([]);
  expect(errors).toEqual([]);
});

test('the editor is served at the root of its own origin, and survives a refresh', async ({ page }) => {
  const failures: string[] = [];
  page.on('response', (response) => {
    if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
  });

  await page.goto(APP);
  await expect(page.locator('#root')).not.toBeEmpty();

  await page.reload();
  await expect(page.locator('#root')).not.toBeEmpty();
  expect(failures, 'every chunk, style and asset resolves').toEqual([]);
});

test("the editor registers its own service worker; the site registers none", async ({ page }) => {
  await page.goto(APP);
  // A poll over `page.evaluate`, not `waitForFunction`: the latter does not await an async predicate.
  const scopesNow = () =>
    page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map((registration) => registration.scope));
  await expect.poll(async () => (await scopesNow()).length, { timeout: 30_000 }).toBeGreaterThan(0);
  for (const scope of await scopesNow()) expect(scope).toBe(APP);

  await page.goto(SITE);
  expect(await scopesNow(), 'the landing page has no worker of its own').toEqual([]);
});

test('an ordinary anchor stays on the landing page', async ({ page }) => {
  await page.goto(`${SITE}#features`);
  await expect(page).toHaveURL(/\/#features$/);
  await expect(page.locator('#features')).toBeVisible();
});

test('Shopify attaches illustrative SQL and a decision to its reservation operation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${SITE}#system-title`);
  const title = 'Shopify inventory reservations';
  const example = page.getByRole('figure', { name: title });
  const marker = example.getByRole('button', { name: 'Attachments on Reserve inventory', exact: true });
  const peek = page.locator('[data-attachment-peek]');
  await marker.focus();
  await expect(peek.locator('pre code')).toContainText('FOR UPDATE SKIP LOCKED');
  const decision = peek.locator('.attachment-preview').filter({ hasText: 'Decision note' });
  await expect(decision).toBeVisible();
  const source = new URL('../www/examples/shopify-inventory.draftcanvas', import.meta.url);
  const file = JSON.parse(await readFile(source, 'utf8'));
  expect(file).toMatchObject({ format: 'draft-canvas', metadata: { title } });
  const reserve = file.nodes.find((node: { id: string }) => node.id === 'reserve');
  expect(reserve.attachments).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'code', code: expect.stringContaining('FOR UPDATE SKIP LOCKED') }),
    expect.objectContaining({ type: 'note', noteKind: 'decision', text: await decision.locator('dd').innerText() }),
  ]));
  await page.keyboard.press('Escape');
  await expect(peek).toBeHidden();
});

test('Stripe Ledger opens and returns through all three C4 levels', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${SITE}#payment-title`);
  const example = page.getByRole('figure', { name: 'Stripe Ledger' });
  const trail = example.getByRole('navigation', { name: 'C4 levels' });
  const ledger = example.getByRole('button', { name: 'Look inside Ledger and Data Quality' });
  const quality = example.getByRole('button', { name: 'Look inside Data Quality checks' });
  await expect(trail.locator('[aria-current="location"]')).toHaveText('System context');
  await expect(example.locator('[data-diagram-node="finance"]')).toBeInViewport({ ratio: 0.99 });
  await ledger.press('Enter');
  await expect(trail.locator('[aria-current="location"]')).toHaveText('Containers');
  const containers = example.locator('[data-exhibit-room="ledger-system"]');
  for (const id of ['event-log', 'quality', 'investigation', 'repair', 'impact']) {
    await expect(containers.locator(`[data-diagram-node="${id}"]`)).toBeInViewport({ ratio: 0.99 });
  }
  await example.getByRole('button', { name: 'Reviewed corrections', exact: true }).focus();
  await expect(containers.locator('[data-diagram-edge="commit-repair"]')).toHaveAttribute('data-note-target', '');
  await quality.locator('.depth-hit').click({ position: { x: 15, y: 40 } });
  await expect(trail.locator('[aria-current="location"]')).toHaveText('Components');
  await expect(trail.getByRole('button')).toHaveText(['System context', 'Containers']);
  const components = example.locator('[data-exhibit-room="ledger-system/quality"]');
  for (const id of ['clearing', 'timeliness', 'completeness']) {
    await expect(components.locator(`[data-diagram-node="${id}"]`)).toBeInViewport({ ratio: 0.99 });
  }
  await example.getByRole('button', { name: 'Completeness', exact: true }).focus();
  await expect(components.locator('[data-diagram-edge="completeness-score"]')).toHaveAttribute('data-note-target', '');
  await trail.getByRole('button', { name: 'Containers' }).click();
  await expect(quality).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(ledger).toBeFocused();
  await expect(trail.locator('[aria-current="location"]')).toHaveText('System context');
});

test('the Stripe drill-down zooms into a shape and straight back to an ancestor', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(`${SITE}#payment-title`);
  const exhibit = page.getByRole('figure', { name: 'Stripe Ledger' });
  await expect(exhibit.locator('.canvas-brief')).toBeVisible();
  await page.keyboard.press('Escape');
  const ledger = exhibit.getByRole('button', { name: 'Look inside Ledger and Data Quality' });
  await ledger.locator('.depth-hit').click({ position: { x: 15, y: 40 } });
  const child = exhibit.locator('[data-exhibit-room="ledger-system"]');
  const outgoing = exhibit.locator('[data-exhibit-room="/"]');
  await expect(outgoing).toHaveAttribute('inert', '');
  const scale = await child.locator('.system-graph').evaluate((graph) => {
    const effect = graph.getAnimations()[0]?.effect as KeyframeEffect;
    const start = effect.getKeyframes()[0].transform;
    return Number(/scale\(([^)]+)\)/.exec(String(start))?.[1]);
  });
  expect(scale).toBeGreaterThan(0);
  expect(scale).toBeLessThanOrEqual(0.42);
  await expect(outgoing).toBeHidden();
  await child.getByRole('button', { name: 'Look inside Data Quality checks' }).click();
  await expect(child).toBeHidden();
  const components = exhibit.locator('[data-exhibit-room="ledger-system/quality"]');
  const trail = exhibit.getByRole('navigation', { name: 'C4 levels' });
  await trail.getByRole('button', { name: 'System context' }).click();
  await expect(components).toHaveAttribute('inert', '');
  await expect(child).toBeHidden();
  const returnScale = await components.locator('.system-graph').evaluate((graph) => {
    const effect = graph.getAnimations()[0]?.effect as KeyframeEffect;
    return Number(/scale\(([^)]+)\)/.exec(String(effect.getKeyframes().at(-1)?.transform))?.[1]);
  });
  expect(returnScale).toBeGreaterThan(0);
  expect(returnScale).toBeLessThanOrEqual(0.42);
  await expect(components).toBeHidden();
  await expect(trail.locator('[aria-current="location"]')).toHaveText('System context');
  await expect(ledger).toBeFocused();
  await ledger.press('Enter');
  await expect(trail.getByRole('button')).toHaveText(['System context']);
});

test('browser Back and Forward traverse Stripe levels before the examples grid', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(`${SITE}#examples`);
  const grid = page.getByRole('region', { name: 'Architecture examples' });
  await grid.getByRole('link', { name: /Stripe Ledger/ }).click();
  const exhibit = page.getByRole('figure', { name: 'Stripe Ledger' });
  const current = exhibit.locator('[aria-current="location"]');
  await expect(exhibit.locator('.exhibit-draft')).toHaveCount(1);
  await page.keyboard.press('Escape');
  const ledger = exhibit.getByRole('button', { name: 'Look inside Ledger and Data Quality' });
  const quality = exhibit.getByRole('button', { name: 'Look inside Data Quality checks' });
  const components = exhibit.locator('[data-exhibit-room="ledger-system/quality"]');
  await ledger.click();
  await quality.click();
  await expect(current).toHaveText('Components');

  await page.goBack();
  await expect(components).toHaveAttribute('inert', '');
  await expect(current).toHaveText('Containers');
  await expect(quality).toBeFocused();
  await page.goBack();
  await expect(current).toHaveText('System context');
  await page.goBack();
  await expect(page).toHaveURL(SITE + '#examples');
  await expect(grid).toBeVisible();

  await page.goForward();
  await expect(current).toHaveText('System context');
  await page.goForward();
  await expect(current).toHaveText('Containers');
  await page.goForward();
  await expect(current).toHaveText('Components');
  await expect(page).toHaveURL(SITE + '#payment-title');
  await page.reload();
  await expect(current).toHaveText('Components');
  await expect(exhibit.locator('.exhibit-draft')).toHaveCount(0);
  await exhibit.getByRole('button', { name: 'System context' }).click();
  await expect(current).toHaveText('System context');
  await page.goForward();
  await expect(current).toHaveText('Containers');
});

test('the Shopify paperclip previews notes on hover and can be pinned', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${SITE}#system-title`);
  const exhibit = page.getByRole('figure', { name: 'Shopify inventory reservations' });
  const marker = exhibit.getByRole('button', { name: 'Attachments on Reserve inventory' });
  const peek = page.locator('[data-attachment-peek]');
  const claim = exhibit.getByRole('button', { name: 'Atomic claim' });
  await expect(peek).toBeHidden();
  await marker.hover();
  await expect(peek).toBeVisible();
  await claim.hover();
  await expect(peek).toBeHidden();
  await marker.focus();
  await marker.press('Enter');
  await claim.hover();
  await expect(peek).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(peek).toBeHidden();
  await expect(marker).toBeFocused();
});

test('the Slack junction highlights both regional gateways and each branch works on its own', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${SITE}#pipeline-title`);
  const exhibit = page.getByRole('figure', { name: 'Slack real-time messaging' });
  const branches = [
    ['fan-region-a', 'gateway-a'],
    ['fan-region-b', 'gateway-b'],
  ];

  await exhibit.locator('[data-diagram-node="fan-out"]').hover();
  for (const [id, destination] of branches) {
    await expect(exhibit.locator(`[data-diagram-edge="${id}"]`)).not.toHaveCSS('filter', 'none');
    await expect(exhibit.locator(`[data-diagram-node="${destination}"]`)).toHaveCSS('filter', 'brightness(1.14)');
  }
  for (const [id, destination] of branches) {
    const arrow = exhibit.locator(`[data-diagram-edge="${id}"] .exhibit-edge-hit`);
    const point = await arrow.evaluate((element: SVGPathElement) => {
      const { x, y } = element.getPointAtLength(element.getTotalLength() / 2).matrixTransform(element.getScreenCTM()!);
      return { x, y };
    });
    await page.mouse.move(point.x, point.y);
    await expect(exhibit.locator('[data-diagram-edge][data-note-target]')).toHaveCount(1);
    await expect(exhibit.locator(`[data-diagram-edge="${id}"]`)).not.toHaveCSS('filter', 'none');
    await expect(exhibit.locator('[data-diagram-node][data-note-target]')).toHaveCount(1);
    await expect(exhibit.locator(`[data-diagram-node="${destination}"]`)).toHaveCSS('filter', 'brightness(1.14)');
  }
  await page.mouse.move(10, 10);
  await expect(exhibit.locator('[data-note-target]')).toHaveCount(0);
});

test('Shopify highlights reserve, claim, and replenishment independently', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${SITE}#system-title`);
  const exhibit = page.getByRole('figure', { name: 'Shopify inventory reservations' });
  const purchase = exhibit.locator('[data-diagram-edge="purchase"]');
  for (const [label, note, edges, tables] of [
    ['Reserve inventory', 'sql', ['pool-access', 'record-hold', 'request-hold'], ['units', 'held']],
    ['Claim inventory', 'claim', ['clear-hold', 'deduct-stock', 'request-claim'], ['held', 'ledger']],
    ['Replenishment', 'refill', ['empty-pool', 'refill-units'], ['units', 'ledger']],
  ] as const) {
    await exhibit.locator('svg').getByText(label, { exact: true }).hover();
    const detail = exhibit.locator(`#note-checkout-${note}`);
    await expect(detail).toBeVisible();
    await expect.poll(() => exhibit.locator('[data-diagram-edge][data-note-target]').evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-diagram-edge')).sort(),
    )).toEqual(edges);
    for (const id of edges) {
      await expect(exhibit.locator(`[data-diagram-edge="${id}"]`)).toHaveCSS('opacity', '1');
      await expect(exhibit.locator(`[data-diagram-edge-labels="${id}"]`)).toHaveCSS('opacity', '1');
    }
    for (const id of ['units', 'held', 'ledger'] as const) {
      const table = exhibit.locator(`[data-diagram-node="${id}"]`);
      const highlighted = tables.some((tableId) => tableId === id);
      await expect(table).toHaveCSS('opacity', highlighted ? '1' : '0.52');
      await expect(table).toHaveCSS('filter', highlighted ? 'brightness(1.14)' : 'none');
    }
    await expect(purchase).toHaveCSS('opacity', '0.52');
    await expect(exhibit.locator('[data-diagram-edge-labels="purchase"]')).toHaveCSS('opacity', '0.52');
    if (note === 'sql') {
      const coversHoldArrow = await detail.evaluate((element) => {
        const noteBounds = element.getBoundingClientRect();
        const arrow = element.closest('figure')!.querySelector('[data-diagram-edge="record-hold"] path[marker-end]')!;
        const line = arrow.getBoundingClientRect();
        return noteBounds.left < line.right && noteBounds.right > line.left
          && noteBounds.top < line.top && noteBounds.bottom > line.bottom;
      });
      expect(coversHoldArrow).toBe(false);
    }
  }
  await page.mouse.move(0, 0);
  await expect(exhibit.locator('[data-note-target]')).toHaveCount(0);
  await expect(purchase).toHaveCSS('opacity', '1');

  await exhibit.getByRole('button', { name: 'Attached SQL' }).focus();
  await expect(exhibit.locator('[data-diagram-node="reserve"]')).toHaveAttribute('data-note-target', '');
  await expect(purchase).toHaveCSS('opacity', '0.52');
  await page.keyboard.press('Escape');
  await expect(purchase).toHaveCSS('opacity', '1');

  for (const [label, operations, edges, dimmed] of [
    ['Available units', ['refill', 'reserve'], ['pool-access', 'refill-units'], 'claim'],
    ['Active holds', ['claim', 'reserve'], ['clear-hold', 'record-hold'], 'refill'],
    ['Inventory ledger', ['claim', 'refill'], ['deduct-stock'], 'reserve'],
  ] as const) {
    await exhibit.locator('svg').getByText(label, { exact: true }).hover();
    await expect.poll(() => exhibit.locator('[data-diagram-edge][data-note-target]').evaluateAll((elements) =>
      elements.map((element) => element.getAttribute('data-diagram-edge')).sort(),
    )).toEqual(edges);
    for (const operation of operations) {
      await expect(exhibit.locator(`[data-diagram-node="${operation}"]`)).toHaveCSS('filter', 'brightness(1.14)');
    }
    await expect(exhibit.locator(`[data-diagram-node="${dimmed}"]`)).toHaveCSS('opacity', '0.52');
    await expect(purchase).toHaveCSS('opacity', '0.52');
  }
  await page.mouse.move(0, 0);
  await expect(exhibit.locator('[data-note-target]')).toHaveCount(0);
  await expect(purchase).toHaveCSS('opacity', '1');
});

test('the pencil traces the Netflix cache read and then restores its connector label', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(`${SITE}#video-title`);
  const exhibit = page.getByRole('figure', { name: 'Netflix Live Origin' });
  await expect(exhibit.locator('.exhibit-draft')).toHaveCount(1);
  await page.keyboard.press('Escape');
  const prompt = exhibit.getByRole('button', { name: 'Cache-first reads', exact: true });
  const edge = exhibit.locator('[data-diagram-edge="cache-read"]');
  const label = exhibit.locator('[data-diagram-edge-labels="cache-read"]');
  const labelVisibility = await prompt.evaluate((button) => {
    button.focus();
    const label = document.querySelector('[data-diagram-edge-labels="cache-read"]')!;
    return getComputedStyle(label).opacity;
  });
  expect(labelVisibility).toBe('0');
  await expect(edge.locator('path:not(.exhibit-edge-hit)')).toHaveCount(1);
  await expect(label).toHaveCSS('opacity', '1');
  await expect(exhibit.locator('#note-video-database')).toBeVisible();
  await expect(exhibit.locator('[data-diagram-edge="store-fallback"]')).toHaveAttribute('data-note-target', '');
  await prompt.press('Escape');
  await expect(exhibit.locator('#note-video-database')).toBeHidden();
  await expect(label).toHaveCSS('opacity', '1');
});

test('the example grid works from the landing page and exhibits with reduced motion', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(SITE);
  const explore = page.getByRole('link', { name: 'Explore examples' });
  const examples = page.getByRole('region', { name: 'Architecture examples' });
  const exhibit = page.locator('#example');
  const scene = exhibit.getByRole('figure');
  await explore.press('Enter');
  await expect(page).toHaveURL(SITE + '#examples');
  await expect(examples).toBeFocused();
  await expect(examples.getByRole('listitem')).toHaveCount(6);
  await expect(examples.locator('.example-card-preview img')).toHaveCount(6);
  await expect(scene).toHaveCount(0);
  const stage = exhibit.getByRole('region', { name: 'Architecture exhibits' });
  const gridBounds = await stage.boundingBox();
  await examples.getByRole('link', { name: /Uber IngestionNext/ }).press('Enter');
  await expect(page).toHaveURL(SITE + '#lakehouse-title');
  await expect(scene).toHaveAccessibleName('Uber IngestionNext');
  await expect(examples).toBeHidden();
  expect(await stage.boundingBox()).toEqual(gridBounds);
  await expect(scene.locator('.example-art')).toBeFocused();
  await expect(exhibit.locator('.exhibit-draft')).toHaveCount(0);

  const browse = exhibit.getByRole('link', { name: 'All examples' });
  await browse.click();
  await expect(examples).toBeVisible();
  await expect(scene).toHaveCount(0);
  await expect(examples.getByRole('link', { name: /Uber IngestionNext/ })).toHaveAttribute('aria-current', 'true');
  await examples.getByRole('link', { name: /Slack real-time messaging/ }).click();
  await expect(page).toHaveURL(SITE + '#pipeline-title');
  await expect(scene).toHaveAccessibleName('Slack real-time messaging');
  await expect(scene.locator('.system-graph')).toBeInViewport({ ratio: 1 });
  await page.reload();
  await expect(scene).toHaveAccessibleName('Slack real-time messaging');
});

test('choosing an example leads straight into the sketch and Stripe keeps its full C4 sketch', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(SITE, { waitUntil: 'domcontentloaded' });
  const brief = page.locator('#brief-checkout');
  const art = page.locator('#system-title .system-graph');
  const draft = art.locator('.exhibit-draft');
  const openingBrief = page.locator('#system-title .canvas-brief');
  await expect(draft).toHaveCount(0);
  const examples = page.getByRole('region', { name: 'Architecture examples' });
  await page.getByRole('link', { name: 'Explore examples' }).click();
  await examples.getByRole('link', { name: /Shopify inventory reservations/ }).click();
  await expect(page).toHaveURL(SITE + '#system-title');
  await expect(draft).toHaveCount(1);
  await expect(openingBrief).toHaveCount(0);
  await expect(art.locator('[role="img"]')).toHaveCSS('opacity', '0');
  await expect(page.locator('#system-title .example-art')).toBeFocused();
  await expect(brief).toBeInViewport();
  await expect(brief).toContainText('reserves stock while payment is in progress');
  await expect(draft).toHaveCount(0, { timeout: 20_000 });
  const cues = page.locator('#system-title .exhibit-cue');
  await expect(cues.first()).toBeVisible();
  await expect(cues.last()).toHaveCSS('opacity', '0.34');
  await expect(cues.last()).toBeVisible();

  const canvas = page.getByRole('region', { name: 'Architecture exhibits' });
  await expect(canvas).toBeInViewport({ ratio: 0.99 });
  await expect(canvas.getByRole('figure', { name: 'Shopify inventory reservations' })).toBeVisible();

  await page.goBack();
  await expect(page).toHaveURL(SITE + '#examples');
  await expect(examples).toBeInViewport({ ratio: 0.99 });
  await examples.getByRole('link', { name: /Shopify inventory reservations/ }).click();
  await expect(canvas).toBeInViewport({ ratio: 0.99 });
  await expect(draft).toHaveCount(0);

  await page.goto(`${SITE}#system-title`);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(openingBrief).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(openingBrief).toHaveCount(0);
  await expect(cues.first()).toBeVisible();

  await page.goto(`${SITE}#payment-title`);
  await page.reload();
  await expect(canvas.getByRole('figure', { name: 'Stripe Ledger' })).toBeVisible();
  await expect(page.locator('#payment-title .exhibit-draft')).toHaveCount(1);
  await expect(page.locator('#payment-title .system-graph:visible [role="img"]')).toHaveCSS('opacity', '0');
  const sheet = page.locator('#payment-title .exhibit-sketch-sheet .exhibit-draft');
  const sketchParts = [
    'level-0-payments', 'level-0-producers', 'level-0-ledger-system', 'level-0-readiness',
    'level-1-event-log', 'level-1-quality', 'level-1-commit-repair',
    'level-2-clearing', 'level-2-timeliness', 'level-2-completeness', 'ledger-depth', 'quality-depth',
  ];
  for (const id of sketchParts) {
    await expect(sheet.locator(`[data-sketch-part="${id}"]`)).toHaveCount(1);
  }
  await expect(sheet).toHaveCount(0, { timeout: 25_000 });
  await expect(page.locator('#payment-title .system-graph:visible [data-diagram-node="finance"]')).toBeVisible();
  await page.keyboard.press('Escape');
  const payment = canvas.getByRole('figure', { name: 'Stripe Ledger' });
  await payment.getByRole('button', { name: 'Look inside Ledger and Data Quality' }).click();
  const containers = payment.locator('[data-exhibit-room="ledger-system"]');
  await expect(containers).toBeVisible();
  await expect(payment.locator('.exhibit-draft')).toHaveCount(0);
  await containers.getByRole('button', { name: 'Look inside Data Quality checks' }).click();
  await expect(payment.locator('[data-exhibit-room="ledger-system/quality"]')).toBeVisible();
  await expect(payment.locator('.exhibit-draft')).toHaveCount(0);
});

test('the gallery draws each exhibit once and shows the finished diagram on return', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(`${SITE}#pipeline-title`);
  const exhibit = page.locator('#example');
  const scene = exhibit.getByRole('figure');
  const browse = exhibit.getByRole('link', { name: 'All examples' });
  const examples = page.getByRole('region', { name: 'Architecture examples' });
  await expect(scene.locator('.canvas-brief')).toContainText('fans out each message');
  await expect(scene.locator('.exhibit-draft')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(scene.locator('.canvas-brief')).toHaveCount(0);
  await expect(scene.locator('.system-graph:visible')).toHaveCSS('opacity', '1');
  for (const [title, card] of [
    ['Netflix Live Origin', /Netflix Live Origin/],
    ['Uber IngestionNext', /Uber IngestionNext/],
    ['Stripe Ledger', /Stripe Ledger/],
    ['Discord message search', /Discord message search/],
  ] as const) {
    await browse.click();
    await examples.getByRole('link', { name: card }).click();
    await expect(scene).toHaveAccessibleName(title);
    await expect(browse).toBeInViewport();
    await expect(scene.locator('.canvas-brief')).toHaveCount(0);
    await expect(scene.locator('.exhibit-draft-pencil')).toBeVisible({ timeout: 1500 });
    await expect(scene.locator('.system-graph:visible [role="img"]')).toHaveCSS('opacity', '0');
    await page.keyboard.press('Escape');
    await expect(scene.locator('.exhibit-cue').first()).toBeVisible();
  }
  await page.goBack();
  await expect(page).toHaveURL(SITE + '#examples');
  await page.goBack();
  await expect(scene).toHaveAccessibleName('Stripe Ledger');
  await browse.click();
  await examples.getByRole('link', { name: /Discord message search/ }).click();
  await expect(scene).toHaveAccessibleName('Discord message search');
  await expect(scene.locator('.exhibit-draft')).toHaveCount(0);
  await expect(exhibit.locator('.pencil-travelling')).toHaveCount(0);
  await expect(scene.locator('[data-diagram-node="ingest-nodes"]')).toContainText('×3');
  await expect(scene.locator('[data-diagram-node="master-nodes"]')).toContainText('×3');
  await expect(scene.locator('[data-diagram-node="data-nodes"]')).toContainText('×5');
  await scene.getByText('Replica shard', { exact: true }).hover();
  await expect(scene.locator('#note-search-replicas')).toBeVisible();
  await expect(scene.locator('[data-diagram-edge="replicate"]')).toHaveAttribute('data-note-target', '');
  await expect(scene.locator('[data-diagram-node="primary-shard"]')).toHaveAttribute('data-note-target', '');
  await browse.click();
  await expect(page).toHaveURL(SITE + '#examples');
  await page.goBack();
  await expect(scene).toHaveAccessibleName('Discord message search');
  await expect(scene.locator('.canvas-brief')).toHaveCount(0);
  await expect(scene.locator('.exhibit-draft')).toHaveCount(0);
  await expect(scene.locator('.system-graph:visible [role="img"]')).toHaveCSS('opacity', '1');

  await page.goForward();
  await expect(page).toHaveURL(SITE + '#examples');
  await page.goBack();
  await expect(scene).toHaveAccessibleName('Discord message search');
  await expect(scene.locator('.exhibit-draft')).toHaveCount(0);

  await page.reload();
  await expect(scene.locator('.canvas-brief')).toContainText('Discord batches new messages for indexing');
  await expect(scene.locator('.exhibit-draft')).toHaveCount(1);
});

test('every exhibit finishes sketching within five seconds and holds before the fade', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  for (const id of ['system-title', 'pipeline-title', 'video-title', 'lakehouse-title', 'payment-title', 'search-title']) {
    await page.goto(`${SITE}#${id}`);
    const draft = page.locator(`#${id} .exhibit-draft`);
    const timing = await draft.evaluate((layer) => {
      const fade = layer.getAnimations()[0].effect!.getComputedTiming();
      const lastInk = Math.max(...layer.getAnimations({ subtree: true })
        .filter((animation) => {
          const target = (animation.effect as KeyframeEffect).target;
          return target && target !== layer && !target.classList.contains('exhibit-draft-pencil');
        })
        .map((animation) => Number(animation.effect!.getComputedTiming().endTime)));
      return { duration: Number(fade.endTime), hold: Number(fade.delay) - lastInk };
    });
    expect(timing.duration, id).toBeLessThanOrEqual(5000);
    expect(timing.hold, id).toBeGreaterThanOrEqual(649);
  }
});

test('the pencil sketch gives way to the finished exhibit and can be skipped', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(`${SITE}#system-title`);
  const browse = page.getByRole('link', { name: 'All examples' });
  const examples = page.getByRole('region', { name: 'Architecture examples' });
  await browse.click();
  await examples.getByRole('link', { name: /Slack real-time messaging/ }).click();
  const pipeline = page.getByRole('figure', { name: 'Slack real-time messaging' });
  const draft = pipeline.locator('.exhibit-draft');
  const finished = pipeline.getByRole('img', { includeHidden: true });
  await expect(draft.locator('.exhibit-sketch-stroke').first()).toBeAttached();
  await expect(finished).toHaveCSS('opacity', '0');
  const aligned = await draft.evaluate((layer) => {
    const diagram = layer.closest('.system-graph')!;
    return Array.from(layer.querySelectorAll<SVGGeometryElement>('[data-sketch-part]'), (copy) => {
      const id = copy.dataset.sketchPart;
      const part = diagram.querySelector(`[data-diagram-node="${id}"], [data-diagram-edge="${id}"]`)!;
      const original = part.querySelector<SVGGeometryElement>(
        ':is(path, rect, ellipse, circle, line, polygon, polyline)[stroke]:not([stroke="none"])',
      )!;
      const expected = original.getPointAtLength(0).matrixTransform(original.getScreenCTM()!);
      const actual = copy.getPointAtLength(0).matrixTransform(copy.getScreenCTM()!);
      return { id, error: Math.hypot(actual.x - expected.x, actual.y - expected.y) };
    });
  });
  expect(aligned.length).toBeGreaterThan(20);
  for (const { id, error } of aligned) expect(error, id).toBeLessThan(0.1);
  const lettering = await draft.evaluate((layer) => {
    const label = Array.from(layer.querySelectorAll('text')).find((text) => text.textContent === 'Gateway B')!;
    const clipId = label.parentElement!.getAttribute('clip-path')!.slice(5, -1);
    const ink = layer.querySelector(`#${clipId} rect`)!;
    const animation = ink.getAnimations()[0];
    const timing = animation.effect!.getComputedTiming();
    const delay = Number(timing.delay);
    const duration = Number(timing.duration);
    const current = animation.currentTime;
    const widths = [delay - 1, delay + duration / 2, delay + duration].map((time) => {
      animation.currentTime = time;
      return parseFloat(getComputedStyle(ink).width);
    });
    animation.currentTime = current;
    const lastStroke = layer.querySelectorAll('.exhibit-sketch-stroke');
    const stroke = lastStroke[lastStroke.length - 1]!;
    const strokeAnimation = stroke.getAnimations()[0];
    const strokeTime = strokeAnimation.currentTime;
    strokeAnimation.currentTime = strokeAnimation.effect!.getComputedTiming().endTime!;
    const completedStroke = parseFloat(getComputedStyle(stroke).strokeDashoffset);
    strokeAnimation.currentTime = strokeTime;
    const diagram = layer.parentElement!.querySelector('[role="img"]')!;
    const reveal = Number(diagram.getAnimations()[0].effect!.getComputedTiming().delay);
    return { widths, hold: reveal - delay - duration, completedStroke };
  });
  const [beforeWriting, duringWriting, afterWriting] = lettering.widths;
  expect(beforeWriting).toBe(0);
  expect(duringWriting).toBeGreaterThan(0);
  expect(duringWriting).toBeLessThan(afterWriting);
  expect(lettering.hold).toBeGreaterThanOrEqual(500);
  expect(lettering.completedStroke).toBeCloseTo(0);
  await expect(draft).toHaveCount(0, { timeout: 8_000 });
  await expect(finished).toHaveCSS('opacity', '1');
  await expect(pipeline.locator('[data-diagram-node="gateway-b"]')).toBeVisible();

  await browse.click();
  await examples.getByRole('link', { name: /Netflix Live Origin/ }).click();
  const video = page.getByRole('figure', { name: 'Netflix Live Origin' });
  await expect(video.locator('.exhibit-sketch-stroke').first()).toBeAttached();
  await page.keyboard.press('Escape');
  await expect(video.locator('.exhibit-sketch-stroke')).toHaveCount(0);
  await expect(video.locator('[data-diagram-node="chunk-cache"]')).toHaveCSS('opacity', '1');
});

test('Uber IngestionNext traces streaming lineage and recovery paths independently', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${SITE}#lakehouse-title`);
  const exhibit = page.getByRole('figure', { name: 'Uber IngestionNext' });
  const streamEdge = exhibit.locator('[data-diagram-edge="decode"]');
  await expect(streamEdge).toHaveCSS('opacity', '1');
  const highlightedEdges = () => exhibit.locator('[data-diagram-edge][data-note-target]').evaluateAll((edges) =>
    edges.map((edge) => edge.getAttribute('data-diagram-edge')).sort(),
  );
  for (const [id, label, edges] of [
    ['stream', 'Flink ingestion', ['commit', 'consume', 'decode', 'stage']],
    ['recovery', 'Checkpoint recovery', ['match-commit', 'sync-checkpoint']],
    ['fallback', 'Batch fallback', ['batch-input', 'batch-output']],
    ['compaction', 'Parquet compaction', ['compact-files']],
  ] as const) {
    await exhibit.locator('svg').getByText(label, { exact: true }).hover();
    await expect(exhibit.locator(`#note-lakehouse-${id}`)).toBeVisible();
    await expect.poll(highlightedEdges).toEqual(edges);
    const isolated = id === 'recovery' || id === 'fallback';
    await expect(streamEdge).toHaveCSS('opacity', isolated ? '0.52' : '1');
    await expect(exhibit.locator(`[data-diagram-edge="${edges[0]}"]`)).toHaveCSS('opacity', '1');
  }
  await exhibit.locator('svg').getByText('Raw data lake', { exact: true }).hover();
  await expect(exhibit.locator('#note-lakehouse-stream')).toBeVisible();
  await expect.poll(highlightedEdges).toEqual(['commit', 'consume', 'decode', 'stage']);
  for (const id of ['lake', 'writer', 'flink', 'poll', 'kafka']) {
    await expect(exhibit.locator(`[data-diagram-node="${id}"]`)).toHaveCSS('opacity', '1');
  }
  for (const id of ['batch-input', 'batch-output', 'compact-files']) {
    await expect(exhibit.locator(`[data-diagram-edge="${id}"]`)).toHaveCSS('opacity', '0.52');
  }
  await page.mouse.move(0, 0);
  await expect(exhibit.locator('[data-note-target]')).toHaveCount(0);
  await expect(streamEdge).toHaveCSS('opacity', '1');
  await exhibit.getByRole('button', { name: 'Batch fallback' }).focus();
  await expect(streamEdge).toHaveCSS('opacity', '0.52');
  await page.keyboard.press('Escape');
  await expect(streamEdge).toHaveCSS('opacity', '1');
  await exhibit.getByRole('button', { name: 'Streaming lineage' }).focus();
  await expect.poll(highlightedEdges).toEqual(['commit', 'consume', 'decode', 'stage']);
});

test('the exported architecture arrows follow horizontal and vertical runs', async ({ page }) => {
  await page.goto(SITE);
  const paths = await page.locator('.system-graph path[marker-end]').evaluateAll((paths) =>
    paths.map((path) => (path.getAttribute('d') ?? '').replaceAll(',', ' ')),
  );
  expect(paths.length).toBeGreaterThan(15);
  for (const path of paths) {
    expect(path, 'the export uses moves, straight runs and rounded corners').toMatch(/^[MLQ\d\s.e+-]+$/);
    const points = Array.from(path.matchAll(/(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\s+(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi), (match) =>
      [Number(match[1]), Number(match[2])],
    );
    expect(points.length).toBeGreaterThan(1);
    let lastRun: { axis: 'x' | 'y'; distance: number } | undefined;
    for (let i = 1; i < points.length; i++) {
      const [x, y] = points[i];
      const [previousX, previousY] = points[i - 1];
      const dx = x - previousX;
      const dy = y - previousY;
      expect(Math.min(Math.abs(dx), Math.abs(dy)), path).toBeLessThan(0.001);
      const horizontal = Math.abs(dx) > Math.abs(dy);
      const distance = horizontal ? dx : dy;
      if (Math.abs(distance) < 0.001) continue;
      const axis = horizontal ? 'x' : 'y';
      if (lastRun?.axis === axis) {
        expect(Math.sign(distance), `the connector never retraces its own path: ${path}`).toBe(Math.sign(lastRun.distance));
      }
      lastRun = { axis, distance };
    }
  }
});

test('the architecture gallery keeps the diagrams inside their scroll regions', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(SITE);
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(audit.violations).toEqual([]);

  await page.setViewportSize({ width: 640, height: 900 });
  for (const anchor of ['system-title', 'pipeline-title', 'video-title', 'lakehouse-title', 'payment-title', 'search-title']) {
    await page.goto(`${SITE}#${anchor}`);
    const art = page.locator(`#${anchor} .example-art:visible`);
    await expect(art).toBeVisible();
    expect(await art.evaluate((region) => region.scrollWidth > region.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(640);
  }
});

test('the exhibits link back to the feature overview', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(`${SITE}#payment-title`);
  await page.getByRole('link', { name: 'Overview' }).click();
  await expect(page).toHaveURL(SITE + '#features');
  const features = page.locator('#features');
  await expect(features).toBeFocused();
  await expect(features).toBeInViewport({ ratio: 0.99 });
  await expect(features.getByRole('heading', { name: 'Collaborate live' })).toBeInViewport();
  await expect(features.getByRole('heading', { name: 'Present flows step by step' })).toBeInViewport();
  await expect(features.getByRole('heading', { name: 'Bring your own agent' })).toBeInViewport();
  await expect(features.getByRole('heading', { name: 'Keep your files on your device' })).toBeInViewport();
});

test('the feature overview passes the accessibility scan at desktop width', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto(`${SITE}#features`);
  // Audit the settled overview independently from the animated return from the gallery.
  const audit = await new AxeBuilder({ page }).include('#features').withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(audit.violations).toEqual([]);
});

test('the closing canvas draws its final arrow and links back to the overview', async ({ page }) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto(`${SITE}#examples`);
  const closing = page.getByRole('region', { name: 'There’s always one more arrow.' });
  await closing.scrollIntoViewIfNeeded();
  await expect(closing).toHaveAttribute('data-drawn', '');
  await closing.getByRole('link', { name: 'Back to top' }).click();
  await expect(page).toHaveURL(SITE + '#features');
  await expect(page.locator('#features')).toBeFocused();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test('the two bundles stay apart', async ({ page }) => {
  await page.goto(SITE);
  const siteAssets = await page.evaluate(() =>
    [...document.querySelectorAll('script[src], link[rel="stylesheet"]')].map(
      (node) => node.getAttribute('src') ?? node.getAttribute('href') ?? '',
    ),
  );
  expect(siteAssets.every((url) => url.startsWith('./') || url.startsWith('/'))).toBe(true);

  await page.goto(APP);
  const editorAssets = await page.evaluate(() =>
    [...document.querySelectorAll('script[src], link[rel="stylesheet"]')].map(
      (node) => node.getAttribute('src') ?? node.getAttribute('href') ?? '',
    ),
  );
  // Every asset from the editor's own origin, none of them climbing out of its own build. Written
  // relative in the page; a lazy chunk's stylesheet is added later by Vite's preload, resolved
  // against the chunk's own address, so it arrives absolute but on the same origin.
  for (const url of editorAssets) {
    expect(url.startsWith('..'), `${url} reaches out of the editor`).toBe(false);
    const resolved = new URL(url, APP);
    expect(resolved.origin, `${url} loads from another origin`).toBe(new URL(APP).origin);
    expect(resolved.pathname.startsWith(new URL(APP).pathname), `${url} reaches out of the editor`).toBe(true);
  }
});

test('a path the site does not have gets its 404 page', async ({ page }) => {
  const response = await page.goto('/no-such-page/');
  expect(response?.status()).toBe(404);
  await expect(page.getByRole('link', { name: 'Open the editor' })).toHaveAttribute('href', 'https://app.draftcanvas.dev/');
});

test('the editor asks not to be indexed as a second landing page', async ({ page }) => {
  await page.goto(APP);
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
  // Off a release tag the editor here is the latest release, which can predate a change of
  // address, so this asks only that it never claims the landing page's place. The exact address
  // is pinned against the current source in tests/site-isolation.test.ts.
  const canonical = await page.locator('link[rel="canonical"]').getAttribute('href');
  expect(canonical).toMatch(/^https:\/\//);
  expect(canonical).not.toBe('https://draftcanvas.dev/');

  await page.goto(SITE);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://draftcanvas.dev/');
});

test.describe('the old address', () => {
  test('says where Draft Canvas moved, styled and without errors', async ({ page }) => {
    const failures: string[] = [];
    page.on('response', (response) => {
      if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
    });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await page.goto(OLD);
    await expect(page.locator('h1')).toBeVisible();
    await expect(page.locator('body')).toHaveCSS('background-color', /rgb\(/);
    await expect(page.getByRole('link', { name: 'Go to draftcanvas.dev' })).toHaveAttribute('href', 'https://draftcanvas.dev/');
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://draftcanvas.dev/');
    expect(failures).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('redirects a directory without its trailing slash rather than breaking', async ({ page }) => {
    /*
     * With a relative `base`, a page served at /draft-canvas would resolve ./assets/* against the
     * origin root and load nothing at all. GitHub Pages redirects to the trailing-slash form instead
     * — verified against the sibling project site, https://acltabontabon.com/scuttle — and
     * scripts/serve-web.mjs reproduces that here so the preview cannot be more forgiving than
     * production.
     */
    const response = await page.goto(OLD.replace(/\/$/, ''));
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(OLD);
    await expect(page.locator('h1')).toBeVisible();
  });

  test('keeps the editor, so diagrams saved there can be brought along', async ({ page }) => {
    await page.goto(`${OLD}editor/`);
    await expect(page.locator('#root')).not.toBeEmpty();
  });

  test('puts their diagrams first for someone who has drawn here', async ({ page }) => {
    // The key the app writes the first time it runs. Nothing is opened and no diagram is read.
    await page.addInitScript(() => localStorage.setItem('draft-canvas.personality', 'plain'));
    await page.goto(OLD);
    await expect(page.locator('#yours')).toHaveAttribute('data-found', '');
    await expect(page.locator('#yours a[href="./editor/"]')).toBeVisible();
  });

  test('forwards every other old link to the same page on draftcanvas.dev', async ({ page }) => {
    // Stop at the forward rather than leaving the machine: the target is the real domain.
    await page.route('https://draftcanvas.dev/**', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>new home</h1>' }),
    );
    await page.goto(`${OLD}docs/getting-started/?from=old#install`);
    // The fragment never reaches a server, so it is the address bar that has to carry it across.
    await expect(page).toHaveURL('https://draftcanvas.dev/docs/getting-started/?from=old#install');
  });
});

test.describe('the documentation', () => {
  /*
   * docs/ rendered into pages by www/scripts/docs.mjs. The build already refuses a link to a page,
   * section or image it did not publish; this checks the other half — that what it published is
   * where those links say, as it is served, which a build cannot see.
   */
  const DOCS = `${SITE}docs/`;
  const START = `${DOCS}getting-started/`;

  test('every page, and everything it links to on this site, is there', async ({ page }) => {
    const failures: string[] = [];
    page.on('response', (response) => {
      if (response.status() >= 400) failures.push(`${response.status()} ${response.url()}`);
    });

    const pages = new Set<string>([START]);
    const visited = new Set<string>();
    const elsewhere = new Set<string>();
    while (visited.size < pages.size) {
      const next = [...pages].find((path) => !visited.has(path))!;
      visited.add(next);
      await page.goto(next);
      await expect(page.locator('h1')).toBeVisible();
      const targets = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLAnchorElement | HTMLImageElement>('a[href], img[src]')]
          .map((node) => ('href' in node ? node.href : node.src))
          .filter((url) => new URL(url).origin === location.origin),
      );
      for (const target of targets) {
        const { pathname } = new URL(target);
        if (pathname.startsWith(DOCS) && pathname.endsWith('/')) pages.add(pathname);
        else elsewhere.add(pathname);
      }
    }

    expect(visited.size, 'every guide and the published references').toBeGreaterThan(10);
    for (const path of elsewhere) {
      const response = await page.request.get(path);
      expect(response.status(), path).toBe(200);
    }
    expect(failures, 'no page, stylesheet or screenshot 404s').toEqual([]);
  });

  test('is reached from the landing page, and finds its way around', async ({ page }) => {
    await page.goto(SITE);
    await page.getByRole('navigation', { name: 'Resources' }).getByRole('link', { name: 'Docs', exact: true }).click();
    await expect(page).toHaveURL(START);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Getting started');
    const sidebar = page.getByRole('navigation', { name: 'Documentation' });
    await expect(sidebar.getByRole('link', { name: 'Getting started' })).toHaveAttribute('aria-current', 'page');
    // Styled, not merely served: a stylesheet that 404'd leaves the body transparent.
    await expect(page.locator('body')).toHaveCSS('background-color', /rgb\(/);

    await expect(page.getByRole('link', { name: 'Open web editor' })).toHaveAttribute('href', 'https://app.draftcanvas.dev/');
  });

  test('redirects the old docs home and opens the current topic in the sidebar', async ({ page }) => {
    await page.goto(DOCS);
    await expect(page).toHaveURL(START);
    const sidebar = page.getByRole('navigation', { name: 'Documentation' });
    await expect(sidebar.locator('details[open]')).toHaveCount(0);
    await sidebar.getByText('Present and share', { exact: true }).click();
    await sidebar.getByRole('link', { name: 'Saving and sharing', exact: true }).click();
    await expect(sidebar.locator('details[open] > summary')).toHaveText('Present and share');
    await expect(sidebar.getByRole('link', { name: 'Saving and sharing', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(sidebar.getByRole('link', { name: 'Shapes and connectors', exact: true })).toBeHidden();
  });

  test('searches guide text locally and opens the matching section', async ({ page }) => {
    await page.goto(`${DOCS}shapes-and-connectors/`);
    await page.getByRole('button', { name: 'Search documentation' }).click();
    const search = page.getByRole('searchbox', { name: 'Search documentation' });
    const results = page.getByRole('region', { name: 'Search results' });
    await search.fill('Fulfilment worker');
    const match = results.getByRole('link', { name: /Draw Service.*Queue.*Worker/ });
    await expect(match).toBeVisible();
    await search.fill('zzznosuchdoc');
    await expect(results.getByRole('status')).toHaveText('No results. Try a different term.');
    await search.press('Escape');
    await expect(results).toBeHidden();
    await page.getByRole('button', { name: 'Search documentation' }).click();

    await search.fill('Fulfilment worker');
    await match.click();
    await expect(page).toHaveURL(/\/docs\/getting-started\/#draw-service--queue--worker$/);
  });

  test('opens search from a guide and follows a reference result on the site', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${DOCS}getting-started/`);
    const trigger = page.getByRole('button', { name: 'Search documentation' });
    const dialog = page.getByRole('dialog', { name: 'Search documentation' });
    const search = dialog.getByRole('searchbox');
    await trigger.click();
    await expect(search).toBeFocused();
    await search.fill('Privacy and security');
    const reference = dialog.getByRole('link', { name: 'Privacy and security', exact: true });
    await expect(reference).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await reference.click();
    await expect(page).toHaveURL(`${DOCS}privacy/`);
    await expect(page.getByRole('heading', { level: 1, name: 'Privacy and security' })).toBeVisible();
  });

  test('links directly to Privacy and security with private vulnerability reporting', async ({ page }) => {
    await page.goto(START);
    const sidebar = page.getByRole('navigation', { name: 'Documentation' });
    const privacy = sidebar.getByRole('link', { name: 'Privacy and security', exact: true });
    await expect(privacy).toBeVisible();
    await privacy.click();
    await expect(page).toHaveURL(`${DOCS}privacy/`);
    await expect(page.getByRole('link', { name: 'Report a vulnerability privately' })).toHaveAttribute(
      'href', 'https://github.com/acltabontabon/draft-canvas/security/advisories/new',
    );
    await page.goto(`${DOCS}security/`);
    await expect(page).toHaveURL(`${DOCS}privacy/`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByText('All docs', { exact: true }).click();
    await expect(privacy).toBeVisible();
    await expect(privacy).toHaveAttribute('aria-current', 'page');
  });

  test('omits unpublished documents from navigation, search, and public routes', async ({ page }) => {
    await page.goto(START);
    const sidebar = page.getByRole('navigation', { name: 'Documentation' });
    await expect(sidebar.getByText('Contributing and maintenance')).toHaveCount(0);
    const unpublished = [
      ['changelog', 'Changelog'],
      ['contributing', 'Contributing'],
      ['reliability', 'Reliability and release acceptance'],
      ['semantics', 'Semantics'],
      ['schema', 'Document schema'],
      ['mermaid-import', 'Mermaid import'],
      ['architecture', 'Architecture'],
      ['performance', 'Performance'],
      ['agent-integration', 'Agent integration'],
      ['principles', 'Principles'],
    ] as const;
    for (const [, title] of unpublished) {
      await expect(sidebar.getByRole('link', { name: title, exact: true })).toHaveCount(0);
    }
    await page.getByRole('button', { name: 'Search documentation' }).click();
    const search = page.getByRole('searchbox');
    const results = page.getByRole('region', { name: 'Search results' });
    for (const [slug, title] of unpublished) {
      await search.fill(title);
      await expect(results).toBeVisible();
      await expect(results.locator(`a[href*="/docs/${slug}/"]`)).toHaveCount(0);
      expect((await page.request.get(`${DOCS}${slug}/`)).status()).toBe(404);
    }
  });

  test('serves guide search under the same policy as the landing page', async ({ page }) => {
    await page.goto(`${DOCS}getting-started/`);
    await expect(page.locator('meta[http-equiv="Content-Security-Policy"]')).toHaveAttribute(
      'content',
      /connect-src 'none'/,
    );
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute('href', 'https://draftcanvas.dev/docs/getting-started/');
  });
});
