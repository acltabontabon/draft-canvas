import { expect, test, type Page } from '@playwright/test';

/**
 * The contextual connector toolbar — see `document/connectorSemantics.ts`'s
 * capability matrix and `EdgeInspectorPopover.tsx`'s `EdgeInspectorRow`.
 * Domain rules (which pairing infers what) are unit-tested directly in
 * `tests/connector-semantics.test.ts`; these cover the popover actually
 * showing the right controls for a real pointer-driven connection.
 *
 * The popover shows a compact row (label chip, flow-membership chip, "⋯")
 * with at most one of two sub-panels open at a time: "+ Flow" opens a small
 * membership checklist, "⋯" opens a single expanded editor with every other
 * control (interaction type/behaviour, request/response, routing, style),
 * grouped into labelled sections. Unlike the older three-panel toolbar this
 * replaced, the interaction `<select>` and the behaviour/routing/colour
 * controls now live in that one panel together — a test only opens it once.
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

/** Opens the popover's single expanded editor — interaction type, behaviour, request/response,
 *  routing, and colour all live here together now. */
async function openExpandedPanel(page: Page) {
  await page.getByRole('button', { name: 'More connector options' }).click();
}

test.describe('contextual connector toolbar', () => {
  test('Service → Database infers Writes, with no flow-kind picker or condition needed', async ({ page }) => {
    await newCanvas(page, 'Service to database toolbar');
    await create(page, 'Service', { x: 300, y: 200 });
    await create(page, 'Database', { x: 600, y: 200 });
    await connect(page, 0, 1);

    await openExpandedPanel(page);
    await expect(page.getByRole('combobox', { name: 'Interaction type' })).toHaveValue('writes');
    await expect(page.getByRole('combobox', { name: 'Flow kind' })).toHaveCount(0);
    await expect(page.locator('.dc-inspector-badge')).toHaveCount(0);
    await expect(page.getByLabel('Condition')).toHaveCount(0);
  });

  test('Database → Service infers Reads', async ({ page }) => {
    await newCanvas(page, 'Database to service toolbar');
    await create(page, 'Database', { x: 300, y: 200 });
    await create(page, 'Service', { x: 600, y: 200 });
    await connect(page, 0, 1);

    await openExpandedPanel(page);
    await expect(page.getByRole('combobox', { name: 'Interaction type' })).toHaveValue('reads');
  });

  test('the Interaction type select lists every relation, unfiltered by node pairing', async ({ page }) => {
    // The popover's relation picker is a plain, full `EDGE_SEMANTICS` list —
    // unlike the older side-panel toolbar it replaced, it no longer narrows
    // options by capability (and so has no "Show all…" escape hatch either).
    await newCanvas(page, 'Full relation list');
    await create(page, 'Service', { x: 300, y: 200 });
    await create(page, 'Database', { x: 600, y: 200 });
    await connect(page, 0, 1);

    await openExpandedPanel(page);
    const relation = page.getByRole('combobox', { name: 'Interaction type' });
    await expect(relation).toHaveValue('writes');
    await expect(relation.locator('option')).toHaveText([
      'No type',
      'HTTP',
      'Event',
      'Command',
      'Query',
      'Reads',
      'Writes',
      'Publishes',
      'Consumes',
      'Calls',
      'Depends on',
    ]);
  });

  test('Service → Queue infers Publishes and shows a compact, expandable behaviour badge', async ({ page }) => {
    await newCanvas(page, 'Service to queue toolbar');
    await create(page, 'Service', { x: 300, y: 200 });
    await create(page, 'Queue', { x: 600, y: 200 });
    await connect(page, 0, 1);

    await openExpandedPanel(page);
    await expect(page.getByRole('combobox', { name: 'Interaction type' })).toHaveValue('publishes');
    await expect(page.getByRole('combobox', { name: 'Flow kind' })).toHaveCount(0);
    const badge = page.getByRole('button', { name: 'Event · Async' });
    await expect(badge).toHaveAttribute('title', /Inferred from what this connects/);

    // Clicking it reveals the full picker (and, with it, the condition field).
    await badge.click();
    const kind = page.getByRole('combobox', { name: 'Flow kind' });
    await expect(kind).toBeVisible();
    await expect(kind).toHaveValue('event');
    await expect(page.getByLabel('Condition')).toBeVisible();
  });

  test('Service → Service infers Calls and shows the full behaviour range, including Condition and Request/Response', async ({
    page,
  }) => {
    await newCanvas(page, 'Service to service toolbar');
    await create(page, 'Service', { x: 300, y: 200 });
    await create(page, 'Service', { x: 600, y: 200 });
    await connect(page, 0, 1);

    await openExpandedPanel(page);
    await expect(page.getByRole('combobox', { name: 'Interaction type' })).toHaveValue('calls');

    const kind = page.getByRole('combobox', { name: 'Flow kind' });
    await expect(kind).toBeVisible();
    // The unset value reads as "Sync" here, not the generic "No kind" —
    // and "Sync" appears exactly once, not duplicated as a real option too
    // ("Async" is deliberately excluded from this check: it contains "sync"
    // as a substring, which a plain text match would wrongly count).
    await expect(kind.locator('option').first()).toHaveText('Sync');
    await expect(kind.locator('option', { hasText: /^Sync$/ })).toHaveCount(1);
    await expect(page.getByLabel('Condition')).toBeVisible();

    // A fresh Service → Service connector already defaults to a request/response
    // interaction (see `document/connectorSemantics.ts`'s `defaultsToResponse`) —
    // the Response section reflects that "On" state without the user touching anything.
    await expect(page.getByTitle('Draw a quieter reply line back to the caller')).toHaveText('On');
  });

  test('reconnecting a Service → Service call onto a Database re-infers Writes and re-collapses the toolbar', async ({
    page,
  }) => {
    await newCanvas(page, 'Reconnect re-inference toolbar');
    await create(page, 'Service', { x: 300, y: 200 });
    await create(page, 'Service', { x: 600, y: 200 });
    await create(page, 'Database', { x: 600, y: 450 });
    await connect(page, 0, 1);

    const nodeA = (await page.locator('.dc-node').nth(0).boundingBox())!;
    const nodeB = (await page.locator('.dc-node').nth(1).boundingBox())!;
    await page.mouse.click(
      (nodeA.x + nodeA.width + nodeB.x) / 2,
      (nodeA.y + nodeA.height / 2 + nodeB.y + nodeB.height / 2) / 2,
    );
    await openExpandedPanel(page);
    await expect(page.getByRole('combobox', { name: 'Interaction type' })).toHaveValue('calls');
    await expect(page.getByRole('combobox', { name: 'Flow kind' })).toBeVisible();

    const target = (await page.locator('.dc-edge-endpoint').nth(1).boundingBox())!;
    const database = (await page.locator('.dc-node').nth(2).boundingBox())!;
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
    await page.mouse.down();
    await page.mouse.move(database.x + database.width / 2, database.y + database.height / 2, { steps: 10 });
    await page.mouse.up();

    // The panel itself was never closed by the reconnect — only its behaviour field
    // re-collapses, from a real picker back to no picker at all, once there's no longer
    // anything ambiguous to choose (a `service>database` write has a predetermined kind).
    await expect(page.getByRole('combobox', { name: 'Interaction type' })).toHaveValue('writes');
    await expect(page.getByRole('combobox', { name: 'Flow kind' })).toHaveCount(0);
    await expect(page.getByLabel('Condition')).toHaveCount(0);
  });
});
