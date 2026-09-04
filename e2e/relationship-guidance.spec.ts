import { expect, test, type Page } from '@playwright/test';

/**
 * The opinionated relationship model beyond what `connector-semantics.spec.ts` already covers:
 * Topic-aware categorisation (a `queue` node with `queueKind: 'topic'` reads as its own category —
 * see `document/connectorSemantics.ts`'s `NodeCategory`), the "is this pairing unusual" guidance
 * layer (`RelationshipStatus`/`quickFixesFor`), the "Insert Worker" quick fix
 * (`store/editorStore.ts`'s `insertWorkerOnEdge`), and the request/response connector's own
 * default caption. Domain rules (which pairing gets which status/guidance/default) are unit-tested
 * directly in `tests/connector-semantics.test.ts`; these cover the popover and canvas actually
 * showing the right thing for a real pointer-driven connection.
 */

async function newCanvas(page: Page, title: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'New canvas' }).click();
  await expect(page.locator('.dc-editor')).toBeVisible();
  const field = page.getByLabel('Diagram title');
  await field.fill(title);
  await field.blur();
}

async function create(page: Page, tool: string, at: { x: number; y: number }) {
  await page.getByRole('button', { name: tool, exact: true }).click();
  await page.locator('.react-flow__pane').click({ position: at });
}

/** A Queue node, immediately switched to the Topic sub-kind via `ElementInspectorPopover.tsx`'s
 *  "Queue type" `InspectorSelect` — the only way `queueKind` is set from the UI. */
async function createTopic(page: Page, at: { x: number; y: number }) {
  await create(page, 'Queue', at);
  await page.getByRole('button', { name: 'Queue type' }).click();
  await page.getByRole('option', { name: 'Topic', exact: true }).click();
  await page.keyboard.press('Escape');
}

/** Drags from a node's right-hand handle onto another node. */
async function connect(page: Page, fromIndex: number, toIndex: number) {
  const source = page.locator('.dc-node').nth(fromIndex);
  await source.hover();
  const handle = (await source.locator('.dc-handle').nth(1).boundingBox())!;
  const target = (await page.locator('.dc-node').nth(toIndex).boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
  await page.mouse.up();
}

/** An `InspectorSelect`'s closed button — see `connector-semantics.spec.ts`'s identical helper. */
function inspectorSelect(page: Page, ariaLabel: string) {
  return page.getByRole('button', { name: ariaLabel });
}

test.describe('Topic-aware relationships', () => {
  test('Topic → Queue defaults to Fans out, with only messaging-relevant options', async ({ page }) => {
    await newCanvas(page, 'Topic to queue');
    await createTopic(page, { x: 300, y: 200 });
    await create(page, 'Queue', { x: 600, y: 200 });
    await connect(page, 0, 1);

    const relation = inspectorSelect(page, 'Interaction type');
    await expect(relation).toHaveText('Fans out');
    await expect(page.locator('.dc-relationship-guidance')).toHaveCount(0);

    await relation.click();
    await expect(page.getByRole('option')).toHaveText(['No type', 'Fans out', 'Delivers to', 'Depends on']);
  });

  test('Service → Topic infers Publishes, same shape as Service → Queue', async ({ page }) => {
    await newCanvas(page, 'Service to topic');
    await create(page, 'Service', { x: 300, y: 200 });
    await createTopic(page, { x: 600, y: 200 });
    await connect(page, 0, 1);

    await expect(inspectorSelect(page, 'Interaction type')).toHaveText('Publishes');
  });

  test('Topic → Service defaults to Delivers to, not Consumes', async ({ page }) => {
    await newCanvas(page, 'Topic to service');
    await createTopic(page, { x: 300, y: 200 });
    await create(page, 'Service', { x: 600, y: 200 });
    await connect(page, 0, 1);

    await expect(inspectorSelect(page, 'Interaction type')).toHaveText('Delivers to');
  });

  test('Queue → Topic is drawable but shows guidance and an Insert Worker quick fix', async ({ page }) => {
    await newCanvas(page, 'Queue to topic guidance');
    await create(page, 'Queue', { x: 300, y: 200 });
    await createTopic(page, { x: 600, y: 200 });
    await connect(page, 0, 1);

    // No default — nothing should ever auto-infer into this unusual a pairing.
    await expect(inspectorSelect(page, 'Interaction type')).toHaveText('No type');

    const guidance = page.locator('.dc-relationship-guidance-text');
    await expect(guidance).toHaveText(/doesn't typically publish to a topic/);
    await expect(page.getByRole('button', { name: 'Insert Worker' })).toBeVisible();
  });

  test('clicking Insert Worker replaces the connector with Queue → Worker → Topic, correctly labeled, as one undo step', async ({
    page,
  }) => {
    await newCanvas(page, 'Insert worker quick fix');
    await create(page, 'Queue', { x: 300, y: 200 });
    await createTopic(page, { x: 600, y: 200 });
    await connect(page, 0, 1);

    await page.getByRole('button', { name: 'Insert Worker' }).click();

    await expect(page.locator('.dc-node')).toHaveCount(3);
    await expect(page.locator('.dc-edge')).toHaveCount(2);
    await expect(page.locator('.dc-relationship-guidance')).toHaveCount(0);
    await expect(inspectorSelect(page, 'Service type')).toHaveText('Worker');

    // Both new connectors' own inferred captions read correctly — a more direct check than
    // clicking each short connector to select it, which the compact layout (the Worker node
    // necessarily overlapping both its own short edges) makes unreliable.
    await expect(page.locator('svg text').filter({ hasText: 'consumes' })).toBeVisible();
    await expect(page.locator('svg text').filter({ hasText: 'publishes' })).toBeVisible();

    await page.keyboard.press('Meta+z');
    await expect(page.locator('.dc-node')).toHaveCount(2);
    await expect(page.locator('.dc-edge')).toHaveCount(1);
  });

  test('re-pointing a Service → Database "writes" connector to a Topic offers a retarget quick fix instead of silently keeping or clearing the label', async ({
    page,
  }) => {
    await newCanvas(page, 'Retarget quick fix');
    await create(page, 'Service', { x: 300, y: 200 });
    await create(page, 'Data Store', { x: 600, y: 200 });
    await createTopic(page, { x: 600, y: 450 });
    await connect(page, 0, 1);

    // Explicitly choose Writes (not just accept the inferred default) so the edge's semantic is
    // `explicit` — the one case `isEligibleForReinference` never silently rewrites on reconnect.
    const relation = inspectorSelect(page, 'Interaction type');
    await relation.click();
    await page.getByRole('option', { name: 'Writes', exact: true }).click();
    await expect(relation).toHaveText('Writes');

    const nodeA = (await page.locator('.dc-node').nth(0).boundingBox())!;
    const nodeB = (await page.locator('.dc-node').nth(1).boundingBox())!;
    await page.mouse.click(
      (nodeA.x + nodeA.width + nodeB.x) / 2,
      (nodeA.y + nodeA.height / 2 + nodeB.y + nodeB.height / 2) / 2,
    );

    const target = (await page.locator('.dc-edge-endpoint').nth(1).boundingBox())!;
    const topic = (await page.locator('.dc-node').nth(2).boundingBox())!;
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
    await page.mouse.down();
    await page.mouse.move(topic.x + topic.width / 2, topic.y + topic.height / 2, { steps: 10 });
    await page.mouse.up();

    // Still reads "Writes" — an explicit choice is never silently overwritten by a reconnect.
    await expect(relation).toHaveText('Writes');
    await expect(page.locator('.dc-relationship-guidance-text')).toHaveText(
      /"Writes" doesn't typically apply to this connection/,
    );
    const fix = page.getByRole('button', { name: 'Use "publishes" instead' });
    await expect(fix).toBeVisible();

    await fix.click();
    await expect(relation).toHaveText('Publishes');
    await expect(page.locator('.dc-relationship-guidance')).toHaveCount(0);
  });
});

test.describe('Database → Database relationships', () => {
  test('defaults to Ingests, with only data-movement options — no request/response section', async ({ page }) => {
    await newCanvas(page, 'Database to database');
    await create(page, 'Data Store', { x: 300, y: 200 });
    await create(page, 'Data Store', { x: 600, y: 200 });
    await connect(page, 0, 1);

    const relation = inspectorSelect(page, 'Interaction type');
    await expect(relation).toHaveText('Ingests');
    await expect(page.getByLabel('Request', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Response', { exact: true })).toHaveCount(0);

    await relation.click();
    await expect(page.getByRole('option')).toHaveText([
      'No type',
      'Ingests',
      'Replicates',
      'CDC',
      'Syncs',
      'Depends on',
    ]);
  });
});

test.describe('Request/response default caption', () => {
  test('a fresh Service → Service connector shows a subtle "requests" caption; picking HTTP replaces it', async ({
    page,
  }) => {
    await newCanvas(page, 'Requests default caption');
    await create(page, 'Service', { x: 300, y: 200 });
    await create(page, 'Service', { x: 600, y: 200 });
    await connect(page, 0, 1);

    await expect(page.locator('svg text').filter({ hasText: 'requests' })).toBeVisible();

    await inspectorSelect(page, 'Protocol').click();
    await page.getByRole('option', { name: 'HTTP', exact: true }).click();

    await expect(page.locator('svg text').filter({ hasText: 'requests' })).toHaveCount(0);
    await expect(page.locator('svg text').filter({ hasText: 'HTTP' })).toBeVisible();
  });
});
