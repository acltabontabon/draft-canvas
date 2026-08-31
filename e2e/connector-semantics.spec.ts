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
 * control grouped into labelled sections. Two different Interaction sections
 * live behind "⋯" depending on the pairing: Service→Service (and
 * Service↔External) gets the opinionated `ServiceInteractionSection`
 * (Protocol/Mode, `InspectorSelect`s named "Protocol"/"Interaction mode");
 * every other pairing keeps the generic, unrestricted Interaction section
 * ("Interaction type"/"Flow kind"). Every dropdown in this popover is a
 * custom `InspectorSelect` (`canvas/InspectorSelect.tsx`), not a native
 * `<select>` — its closed state is a `role="button"` showing the selected
 * option's label as its text, and opening it (a click) reveals a
 * `role="listbox"` of `role="option"` entries also identified by label text,
 * not by value — see the `inspectorSelect`/`chooseInspectorOption` helpers
 * below.
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

/** An `InspectorSelect`'s closed button, identified the same way a native `<select>`'s
 *  accessible name would be — but its visible text is the selected option's *label*, not its
 *  raw value (e.g. "Writes", not "writes"). */
function inspectorSelect(page: Page, ariaLabel: string) {
  return page.getByRole('button', { name: ariaLabel });
}

/** Opens an `InspectorSelect` and picks the option with the given visible label. */
async function chooseInspectorOption(page: Page, ariaLabel: string, optionLabel: string) {
  await inspectorSelect(page, ariaLabel).click();
  await page.getByRole('option', { name: optionLabel, exact: true }).click();
}

test.describe('contextual connector toolbar', () => {
  test('Service → Database infers Writes, with no flow-kind picker or condition needed', async ({ page }) => {
    await newCanvas(page, 'Service to database toolbar');
    await create(page, 'Service', { x: 300, y: 200 });
    await create(page, 'Database', { x: 600, y: 200 });
    await connect(page, 0, 1);

    await openExpandedPanel(page);
    await expect(inspectorSelect(page, 'Interaction type')).toHaveText('Writes');
    await expect(inspectorSelect(page, 'Flow kind')).toHaveCount(0);
    await expect(page.locator('.dc-inspector-badge')).toHaveCount(0);
    await expect(page.getByLabel('Condition')).toHaveCount(0);
  });

  test('Database → Service infers Reads', async ({ page }) => {
    await newCanvas(page, 'Database to service toolbar');
    await create(page, 'Database', { x: 300, y: 200 });
    await create(page, 'Service', { x: 600, y: 200 });
    await connect(page, 0, 1);

    await openExpandedPanel(page);
    await expect(inspectorSelect(page, 'Interaction type')).toHaveText('Reads');
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
    const relation = inspectorSelect(page, 'Interaction type');
    await expect(relation).toHaveText('Writes');
    await relation.click();
    await expect(page.getByRole('option')).toHaveText([
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
    await expect(inspectorSelect(page, 'Interaction type')).toHaveText('Publishes');
    await expect(inspectorSelect(page, 'Flow kind')).toHaveCount(0);
    const badge = page.getByRole('button', { name: 'Event · Async' });
    await expect(badge).toHaveAttribute('title', /Inferred from what this connects/);

    // Clicking it reveals the full picker (and, with it, the condition field).
    await badge.click();
    const kind = inspectorSelect(page, 'Flow kind');
    await expect(kind).toBeVisible();
    await expect(kind).toHaveText('Event');
    await expect(page.getByLabel('Condition')).toBeVisible();
  });

  test('Service → Service defaults to Generic Call + Sync, with Request/Response ready to go', async ({ page }) => {
    await newCanvas(page, 'Service to service toolbar');
    await create(page, 'Service', { x: 300, y: 200 });
    await create(page, 'Service', { x: 600, y: 200 });
    await connect(page, 0, 1);

    await openExpandedPanel(page);
    // Service→Service gets the opinionated editor, not the generic Interaction section — its
    // Protocol/Mode selects replace "Interaction type"/"Flow kind" entirely for this pairing.
    await expect(page.getByRole('button', { name: 'Interaction type' })).toHaveCount(0);
    await expect(inspectorSelect(page, 'Protocol')).toHaveText('Generic Call');
    await expect(inspectorSelect(page, 'Interaction mode')).toHaveText('Sync');

    // Only HTTP and Generic Call are offered — none of the generic vocabulary (Event, Reads,
    // Retry, Fallback, …) or gRPC (deliberately deferred) belongs on a direct service call.
    await inspectorSelect(page, 'Protocol').click();
    await expect(page.getByRole('option')).toHaveText(['HTTP', 'Generic Call']);
    await page.keyboard.press('Escape');

    await inspectorSelect(page, 'Interaction mode').click();
    await expect(page.getByRole('option')).toHaveText(['Sync', 'Async']);
    await page.keyboard.press('Escape');

    // A fresh Service → Service connector already defaults to a request/response
    // interaction (see `document/connectorSemantics.ts`'s `defaultsToResponse`) —
    // the Response section reflects that "On" state without the user touching anything.
    await expect(page.getByTitle('Draw a quieter reply line back to the caller')).toHaveText('On');
  });

  test('Service → Service: switching Protocol to HTTP splits Request into a method dropdown + text', async ({
    page,
  }) => {
    await newCanvas(page, 'Service to service HTTP');
    await create(page, 'Service', { x: 300, y: 200 });
    await create(page, 'Service', { x: 600, y: 200 });
    await connect(page, 0, 1);

    await openExpandedPanel(page);
    await chooseInspectorOption(page, 'Protocol', 'HTTP');

    const method = inspectorSelect(page, 'Request method');
    await expect(method).toHaveText('GET');
    await method.click();
    await expect(page.getByRole('option')).toHaveText(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
    // Already open from the check above — clicking the option directly, not
    // `chooseInspectorOption` (which would re-click the button first and toggle it shut).
    await page.getByRole('option', { name: 'POST', exact: true }).click();

    // Scoped to the Request group specifically — Response's own resource field shares the same
    // "Customers" placeholder.
    const resource = page.getByLabel('Request', { exact: true }).getByPlaceholder('Customers');
    await resource.fill('Customers');
    await resource.blur();
    await expect(page.locator('.dc-edge-label')).toHaveText('POST Customers');
  });

  test('Service → Service: Async hides Response and never dashes the primary request line', async ({ page }) => {
    await newCanvas(page, 'Service to service async');
    await create(page, 'Service', { x: 300, y: 200 });
    await create(page, 'Service', { x: 600, y: 200 });
    await connect(page, 0, 1);

    await openExpandedPanel(page);
    await expect(page.getByTitle('Draw a quieter reply line back to the caller')).toHaveText('On');
    await expect(page.locator('.dc-edge-async-marker')).toHaveCount(0);

    await chooseInspectorOption(page, 'Interaction mode', 'Async');
    await expect(page.getByTitle('Draw a quieter reply line back to the caller')).toHaveCount(0);
    await expect(page.locator('.dc-edge-response-line')).toHaveCount(0);
    // The bug this section exists to fix: choosing Async is a semantic choice, not a line style —
    // the primary request line must stay solid. The connector still needs *some* way to read as
    // async at a glance, though — the small "//" marker on the line itself.
    await expect(page.locator('.dc-edge-line')).not.toHaveCSS('stroke-dasharray', /\d/);
    await expect(page.locator('.dc-edge-async-marker')).toBeVisible();

    await chooseInspectorOption(page, 'Interaction mode', 'Sync');
    await expect(page.getByTitle('Draw a quieter reply line back to the caller')).toBeVisible();
    await expect(page.locator('.dc-edge-async-marker')).toHaveCount(0);
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
    await expect(inspectorSelect(page, 'Protocol')).toHaveText('Generic Call');
    await expect(inspectorSelect(page, 'Interaction mode')).toHaveText('Sync');

    const target = (await page.locator('.dc-edge-endpoint').nth(1).boundingBox())!;
    const database = (await page.locator('.dc-node').nth(2).boundingBox())!;
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
    await page.mouse.down();
    await page.mouse.move(database.x + database.width / 2, database.y + database.height / 2, { steps: 10 });
    await page.mouse.up();

    // The panel itself was never closed by the reconnect — the pairing swapping from
    // Service→Service to Service→Database swaps in the generic Interaction section entirely,
    // and its own behaviour field collapses from a real picker back to none, since a
    // `service>database` write has a predetermined kind.
    await expect(inspectorSelect(page, 'Protocol')).toHaveCount(0);
    await expect(inspectorSelect(page, 'Interaction type')).toHaveText('Writes');
    await expect(inspectorSelect(page, 'Flow kind')).toHaveCount(0);
    await expect(page.getByLabel('Condition')).toHaveCount(0);
  });
});
