import { expect, test, type Page } from '@playwright/test';
import { clickEdge, connect, connectAndOpen, create, newCanvas, nextFrames } from './canvas';

/**
 * The contextual connector toolbar — see `document/connectorSemantics.ts`'s
 * capability matrix and `EdgeInspectorPopover.tsx`'s `EdgeInspectorRow`.
 * Domain rules (which pairing infers what) are unit-tested directly in
 * `tests/connector-semantics.test.ts`; these cover the popover actually
 * showing the right controls for a real pointer-driven connection.
 *
 * Selecting a connector shows its full contextual editor immediately, right
 * under the compact row (label chip, flow-membership chip) — no extra click.
 * "+ Flow" is the one remaining disclosure: a small membership checklist.
 * Two different Interaction sections render depending on the pairing:
 * Service→Service (and Service↔External) gets the opinionated
 * `ServiceInteractionSection` (Protocol/Mode, `InspectorSelect`s named
 * "Protocol"/"Interaction mode"); every other pairing gets the generic
 * Interaction section ("Interaction type"/"Flow kind"), whose "Interaction
 * type" options are themselves narrowed to what that pairing's capability
 * entry actually supports (falling back to the full vocabulary for a
 * pairing with no capability-matrix entry at all). Every dropdown in this
 * popover is a custom `InspectorSelect` (`canvas/InspectorSelect.tsx`), not
 * a native `<select>` — its closed state is a `role="button"` showing the
 * selected option's label as its text, and opening it (a click) reveals a
 * `role="listbox"` of `role="option"` entries also identified by label text,
 * not by value — see the `inspectorSelect`/`chooseInspectorOption` helpers
 * below.
 */

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
  test('Service → Database infers Reads / writes, with no flow-kind picker or condition needed', async ({ page }) => {
    await newCanvas(page, 'Service to database toolbar');
    await create(page, 'Service', { x: 300, y: 200 });
    await create(page, 'Data Store', { x: 600, y: 200 });
    await connectAndOpen(page, 0, 1);

    await expect(inspectorSelect(page, 'Interaction type')).toHaveText('Reads / writes');
    await expect(inspectorSelect(page, 'Flow kind')).toHaveCount(0);
    await expect(page.locator('.dc-inspector-badge')).toHaveCount(0);
    await expect(page.getByLabel('Condition')).toHaveCount(0);
  });

  test('Database → Service infers Reads', async ({ page }) => {
    await newCanvas(page, 'Database to service toolbar');
    await create(page, 'Data Store', { x: 300, y: 200 });
    await create(page, 'Service', { x: 600, y: 200 });
    await connectAndOpen(page, 0, 1);

    await expect(inspectorSelect(page, 'Interaction type')).toHaveText('Reads');
  });

  test('the Interaction type select is narrowed to what the pairing actually supports', async ({ page }) => {
    // Service→Database's capability entry lists exactly `['writes', 'reads', 'query',
    // 'dependsOn']` (see `document/connectorSemantics.ts`'s `MATRIX`) — the picker reflects that
    // instead of the full, unfiltered `EDGE_SEMANTICS` vocabulary (HTTP, Event, Command, …, none
    // of which describe a database interaction).
    await newCanvas(page, 'Filtered relation list');
    await create(page, 'Service', { x: 300, y: 200 });
    await create(page, 'Data Store', { x: 600, y: 200 });
    await connectAndOpen(page, 0, 1);

    const relation = inspectorSelect(page, 'Interaction type');
    await expect(relation).toHaveText('Reads / writes');
    await relation.click();
    await expect(page.getByRole('option')).toHaveText(['No type', 'Reads / writes', 'Writes', 'Reads', 'Query', 'Depends on']);
  });

  test('the Interaction type select keeps the full vocabulary for an unclassified pairing', async ({ page }) => {
    // Two plain, unclassified shapes have no capability-matrix entry at all — the generic
    // Interaction section falls back to the full, unrestricted `EDGE_SEMANTICS` list. An unfed
    // Junction ends up here too, but for a different reason — see the dedicated "Junction
    // connector" describe block below.
    await newCanvas(page, 'Unfiltered relation list');
    await create(page, 'Text', { x: 300, y: 200 });
    await create(page, 'Text', { x: 600, y: 200 });
    await connectAndOpen(page, 0, 1);

    await inspectorSelect(page, 'Interaction type').click();
    await expect(page.getByRole('option')).toHaveText([
      'No type',
      'HTTP',
      'gRPC',
      'Event',
      'Command',
      'Query',
      'Reads',
      'Writes',
      'Reads / writes',
      'Publishes',
      'Consumes',
      'Calls',
      'Depends on',
      'Uses',
      'Fans out',
      'Delivers to',
      'Ingests',
      'Replicates',
      'CDC',
      'Syncs',
      'Dead-letters to',
      'Invalidates',
      'Watches',
      'Searches',
      'Indexes',
      'Routes',
      'Triggers',
      'Implemented by',
      'Implements',
      'Compensates',
      'Transforms',
      'Asks',
      'Delegates to',
      'Escalates to',
      'Notifies',
    ]);
  });

  test('Service → Queue infers Command, dashed, and shows a compact, expandable behaviour badge', async ({ page }) => {
    await newCanvas(page, 'Service to queue toolbar');
    await create(page, 'Service', { x: 300, y: 200 });
    await create(page, 'Queue', { x: 600, y: 200 });
    await connectAndOpen(page, 0, 1);

    await expect(inspectorSelect(page, 'Interaction type')).toHaveText('Command');
    await expect(inspectorSelect(page, 'Flow kind')).toHaveCount(0);
    const badge = page.getByRole('button', { name: 'Async' });
    await expect(badge).toHaveAttribute('title', /Inferred from what this connects/);

    // Clicking it reveals the full picker and the compact condition control.
    await badge.click();
    const kind = inspectorSelect(page, 'Flow kind');
    await expect(kind).toBeVisible();
    await expect(kind).toHaveText('Async');
    await expect(page.getByLabel('Condition')).toBeVisible();
    await page.getByRole('button', { name: 'Condition', exact: true }).click();
    await expect(page.getByLabel('Condition text')).toBeFocused();
    await page.getByLabel('Condition text').fill('retry needed');
    await page.getByLabel('Condition text').press('Enter');
    await expect(page.getByRole('button', { name: 'Condition', exact: true })).toHaveAttribute('data-active', 'true');
  });

  test('Service → Service defaults to Generic Call + Sync, with Request/Response offered but off', async ({ page }) => {
    await newCanvas(page, 'Service to service toolbar');
    await create(page, 'Service', { x: 300, y: 200 });
    await create(page, 'Service', { x: 600, y: 200 });
    await connectAndOpen(page, 0, 1);
    await expect(page.locator('.dc-edge-inspector')).toHaveCSS('opacity', '1');
    const inspector = page.locator('.dc-edge-inspector .dc-popover-inner');
    await expect(inspector).toBeVisible();
    expect(await inspector.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);

    // Service→Service gets the opinionated editor, not the generic Interaction section — its
    // Protocol/Mode selects replace "Interaction type"/"Flow kind" entirely for this pairing.
    await expect(page.getByRole('button', { name: 'Interaction type' })).toHaveCount(0);
    await expect(inspectorSelect(page, 'Protocol')).toHaveText('Generic Call');
    await expect(inspectorSelect(page, 'Interaction mode')).toHaveText('Sync');

    // HTTP, Generic Call — and Compensates, a saga's undo, which nothing else can set — none of
    // the generic vocabulary (Event, Reads, Retry, Fallback, …) or gRPC (deliberately deferred).
    await inspectorSelect(page, 'Protocol').click();
    await expect(page.getByRole('option')).toHaveText(['HTTP', 'Generic Call', 'Compensates']);
    await page.keyboard.press('Escape');

    await inspectorSelect(page, 'Interaction mode').click();
    await expect(page.getByRole('option')).toHaveText(['Sync', 'Async']);
    await page.keyboard.press('Escape');

    // The Response section is *offered* for this pairing (that's what
    // `defaultsToResponse` still decides) but starts Off: at the altitude an
    // architecture diagram works at the return path is implied, and drawing it
    // unasked doubles the lines on the busiest kind of diagram. One click here
    // brings it back.
    await expect(page.getByRole('button', { name: 'Add reply' })).toHaveText('+ Add reply');
  });

  test('a Saga recovery action connects on the canvas and edits beside its HTTP interaction', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await newCanvas(page, 'Order reservation Saga');
    await create(page, 'Service', { x: 220, y: 240 });
    await create(page, 'Service', { x: 680, y: 240 });
    await create(page, 'Service', { x: 680, y: 450 });
    for (const [index, name] of ['Order Service', 'Inventory Service', 'Payment Service'].entries()) {
      await page.locator('.dc-node').nth(index).dblclick();
      const editor = page.locator('.dc-node-editor');
      await editor.fill(name);
      await editor.press('Enter');
    }
    await connectAndOpen(page, 0, 1);
    await chooseInspectorOption(page, 'Protocol', 'HTTP');
    await chooseInspectorOption(page, 'Request method', 'POST');
    await page.getByRole('textbox', { name: 'Request resource' }).fill('/reservations');
    await page.getByRole('textbox', { name: 'Request resource' }).blur();
    await expect(page.locator('.dc-edge-inspector')).toBeVisible();

    await page.getByRole('button', { name: '+ Add compensating action' }).click();
    await expect(page.locator('.dc-recovery-connect-path')).toHaveCount(1);
    await expect(page.locator('.dc-recovery-connect-prompt')).toContainText('Choose a recovery target');
    await page.locator('.dc-node').nth(2).click();
    await expect(page.locator('.dc-edge-line')).toHaveCount(2);
    await expect(page.locator('.dc-edge-inspector')).toHaveCount(0);
    await expect(page.locator('.dc-edge-compensation-marker')).toHaveCount(0);
    const recoveryCaption = page.locator('.dc-edge-caption').filter({ hasText: 'compensates' });
    await recoveryCaption.hover();
    await expect(page.getByRole('tooltip')).toContainText('Order Service');
    await expect(page.getByRole('tooltip')).toContainText('Inventory Service');
    await expect(page.locator('.dc-edge[data-recovery-associated="true"]')).toHaveCount(2);
    await recoveryCaption.click();
    await expect(page.getByRole('button', { name: 'Hide compensation on canvas' })).toHaveCount(0);
    const protocols = page.getByRole('group', { name: 'Compensation protocol' });
    await expect(protocols.getByRole('button')).toHaveCount(3);
    await protocols.getByRole('button', { name: 'Call' }).click();
    await page.getByRole('textbox', { name: 'Compensation operation' }).fill('OK');
    await page.getByRole('textbox', { name: 'Compensation operation' }).blur();
    await protocols.getByRole('button', { name: 'HTTP' }).click();
    await expect(page.getByRole('button', { name: 'Compensation operation method' })).toHaveText('POST');
    await expect(page.getByRole('textbox', { name: 'Compensation operation resource' })).toHaveValue('');
    await expect(recoveryCaption).toContainText('compensates');
    await expect(page.getByRole('button', { name: '+ Add note' })).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Compensating action name' }).fill('Release reservation');
    await page.getByRole('textbox', { name: 'Compensating action name' }).blur();
    await expect(page.locator('.dc-recovery-operation-name')).toHaveText('Release reservation');
    await expect(page.locator('.dc-recovery-thread')).toBeVisible();
    const panel = (await page.locator('.dc-edge-inspector').boundingBox())!;
    const companion = (await page.locator('.dc-recovery-action-fields').boundingBox())!;
    expect(companion.x - (panel.x + panel.width)).toBeGreaterThanOrEqual(40);
    await page.getByRole('textbox', { name: 'Compensation operation resource' }).fill('/reservations/{id}/release');
    await page.getByRole('textbox', { name: 'Compensation operation resource' }).blur();
    const recoveryLabel = page.locator('.dc-edge-label[data-recovery-detail="true"]');
    await expect(recoveryLabel.locator('.dc-edge-recovery-name')).toHaveText('Release reservation');
    await expect(recoveryLabel.locator('.dc-edge-recovery-operation')).toHaveText('POST /reservations/{id}/release');
    const nameBox = (await recoveryLabel.locator('.dc-edge-recovery-name').boundingBox())!;
    const editorBox = (await page.locator('.dc-edge-inspector').boundingBox())!;
    expect(nameBox.y).toBeGreaterThan(editorBox.y + editorBox.height);
    await page.getByRole('button', { name: 'Collapse compensating action' }).click();
    await expect(page.locator('.dc-recovery-thread')).toHaveCount(0);
    await page.getByRole('button', { name: /Release reservation/ }).click();
    await expect(inspectorSelect(page, 'Compensation target')).toHaveText('Payment Service');
    await expect(page.getByRole('textbox', { name: 'Compensating action name' })).toHaveValue('Release reservation');
    await expect(page.getByRole('textbox', { name: 'Compensation operation resource' })).toHaveValue('/reservations/{id}/release');
    await expect(page.locator('.dc-edge-inspector .dc-popover-inner')).toHaveCSS('overflow-y', 'visible');

    const card = page.locator('.dc-recovery-action-fields');
    const beforeCardMove = (await card.boundingBox())!;
    await expect(page.getByRole('button', { name: 'Move counteraction popup' })).toHaveCount(0);
    const editor = page.locator('.dc-edge-inspector');
    const beforeEditorMove = (await editor.boundingBox())!;
    const moveEdge = (await page.getByRole('button', { name: 'Move connector popup' }).boundingBox())!;
    await page.mouse.move(moveEdge.x + moveEdge.width / 2, moveEdge.y + moveEdge.height / 2);
    await page.mouse.down();
    await page.mouse.move(moveEdge.x + moveEdge.width / 2 - 35, moveEdge.y + moveEdge.height / 2 + 35, { steps: 5 });
    await page.mouse.up();
    const afterEditorMove = (await editor.boundingBox())!;
    const afterCardMove = (await card.boundingBox())!;
    expect(afterEditorMove.y).toBeGreaterThan(beforeEditorMove.y + 20);
    expect(afterCardMove.y - beforeCardMove.y).toBeCloseTo(afterEditorMove.y - beforeEditorMove.y, 0);
    await expect(page.locator('.dc-recovery-thread')).toBeVisible();
    await page.locator('.react-flow__pane').click({ position: { x: 20, y: 20 } });
    await expect(editor).toHaveCount(0);
  });

  test('a recovery arrow to the same service stays movable while its inspector is open', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await newCanvas(page, 'Recovery arrow editing');
    await create(page, 'Service', { x: 220, y: 240 });
    await create(page, 'Service', { x: 680, y: 240 });
    await connectAndOpen(page, 0, 1);
    await page.getByRole('button', { name: '+ Add compensating action' }).click();
    await page.locator('.dc-node').nth(1).click();
    await page.locator('.dc-edge-caption').filter({ hasText: 'compensates' }).click();
    await expect(page.locator('.dc-recovery-section[data-single-action="true"]')).toHaveCSS('border-top-width', '0px');

    const bend = page.locator('.dc-edge-bend[data-kind="run"][data-level="true"]').last();
    await expect(bend).toBeVisible();
    const recoveryPath = page.locator('.dc-edge[data-selected="true"] .dc-edge-line');
    const before = await recoveryPath.getAttribute('d');
    const box = (await bend.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 34, { steps: 3 });
    await expect(page.locator('.dc-edge-inspector')).toHaveAttribute('data-reshaping', 'true');
    await expect(page.locator('.dc-edge-inspector')).toHaveCSS('visibility', 'hidden');
    await page.mouse.up();
    await expect(page.locator('.dc-edge-inspector')).not.toHaveAttribute('data-reshaping', 'true');
    expect(await recoveryPath.getAttribute('d')).not.toBe(before);
  });

  test('two recovery targets create two visible arrows', async ({ page }) => {
    await newCanvas(page, 'Unlabelled recovery');
    await create(page, 'Service', { x: 280, y: 280 });
    await create(page, 'Service', { x: 670, y: 280 });
    await create(page, 'Service', { x: 670, y: 490 });
    await connectAndOpen(page, 0, 1);
    await chooseInspectorOption(page, 'Protocol', 'HTTP');
    await page.getByRole('button', { name: '+ Add compensating action' }).click();
    await page.locator('.dc-node').nth(1).click();
    await page.locator('.dc-edge-caption').first().click();
    await expect(page.locator('.dc-edge-inspector')).toBeVisible();
    await page.getByRole('button', { name: '+ Add compensating action' }).click();
    await page.locator('.dc-node').nth(2).click();

    await expect(page.locator('.dc-edge-line')).toHaveCount(3);
    await expect(page.locator('.dc-recovery-action')).toHaveCount(2);
    await expect(page.locator('.dc-edge-caption').first()).toContainText('calls over HTTP');
  });

  test('Service → Service: switching Protocol to HTTP splits Request into a method dropdown + text', async ({
    page,
  }) => {
    await newCanvas(page, 'Service to service HTTP');
    await create(page, 'Service', { x: 300, y: 200 });
    await create(page, 'Service', { x: 600, y: 200 });
    await connectAndOpen(page, 0, 1);

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
    const resource = page.getByLabel('Request', { exact: true }).getByPlaceholder('/customers');
    await resource.fill('/customers');
    await resource.blur();
    await expect(page.locator('.dc-edge-label')).toHaveText('POST /customers');
    await expect(page.locator('.dc-edge-inspector')).toHaveCSS('opacity', '1');
    await page.getByRole('button', { name: 'Add reply' }).click();
    await expect(page.getByRole('textbox', { name: 'Response status' })).toHaveValue('201');
    await expect(page.getByRole('textbox', { name: 'Response resource' })).toHaveValue('Created');
    await expect(page.getByRole('button', { name: 'Guess' })).toHaveCount(0);
  });

  test('Response keeps its label beside the reply line when toggled off and back on', async ({ page }) => {
    await newCanvas(page, 'Response label toggle');
    await create(page, 'Service', { x: 300, y: 200 });
    await create(page, 'Service', { x: 600, y: 200 });
    await connectAndOpen(page, 0, 1);

    const addReply = page.getByRole('button', { name: 'Add reply', exact: true });
    const hideReply = page.getByRole('button', { name: 'Hide reply', exact: true });
    const label = page.locator('.dc-edge-response-label');
    await addReply.click();
    await page.getByRole('textbox', { name: 'Response', exact: true }).fill('Customer found');
    await page.getByRole('textbox', { name: 'Response', exact: true }).blur();
    await expect(label).toHaveText('Customer found');
    const position = await label.getAttribute('style');

    // The text is retained for reuse. With no reply route it must not become an orphan at (0, 0).
    await hideReply.click();
    await expect(page.locator('.dc-edge-response-line')).toHaveCount(0);
    await expect(label).toHaveCount(0);

    await addReply.click();
    await expect(page.locator('.dc-edge-response-line')).toHaveCount(1);
    await expect(label).toHaveText('Customer found');
    await expect(label).toHaveAttribute('style', position!);
  });

  test('Service → Service: Async hides Response and never dashes the primary request line', async ({ page }) => {
    await newCanvas(page, 'Service to service async');
    await create(page, 'Service', { x: 300, y: 200 });
    await create(page, 'Service', { x: 600, y: 200 });
    await connectAndOpen(page, 0, 1);

    // Offered, and off by default — this test is about Async *removing* the
    // section, so turn it on first to have something to remove.
    const addReply = page.getByRole('button', { name: 'Add reply' });
    await expect(addReply).toHaveText('+ Add reply');
    await addReply.click();
    await expect(page.getByRole('button', { name: 'Hide reply' })).toHaveAttribute('title', 'Hide reply line');
    await page.getByRole('textbox', { name: 'Response', exact: true }).fill('OK');
    await page.getByRole('textbox', { name: 'Response', exact: true }).blur();
    await expect(page.locator('.dc-edge-response-label')).toHaveText('OK');
    await expect(page.locator('.dc-edge-async-marker')).toHaveCount(0);

    await chooseInspectorOption(page, 'Interaction mode', 'Async');
    await expect(page.getByRole('button', { name: 'Add reply' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Hide reply' })).toHaveCount(0);
    await expect(page.locator('.dc-edge-response-line')).toHaveCount(0);
    await expect(page.locator('.dc-edge-response-label')).toHaveCount(0);
    // The bug this section exists to fix: choosing Async is a semantic choice, not a line style —
    // the primary request line must stay solid. The connector still needs *some* way to read as
    // async at a glance, though — the small "//" marker on the line itself.
    await expect(page.locator('.dc-edge-line')).not.toHaveCSS('stroke-dasharray', /\d/);
    await expect(page.locator('.dc-edge-async-marker')).toBeVisible();

    await chooseInspectorOption(page, 'Interaction mode', 'Sync');
    await expect(page.getByRole('button', { name: 'Add reply' })).toBeVisible();
    await expect(page.locator('.dc-edge-async-marker')).toHaveCount(0);
  });

  test('reconnecting a Service → Service call onto a Database re-infers Reads / writes and re-collapses the toolbar', async ({
    page,
  }) => {
    await newCanvas(page, 'Reconnect re-inference toolbar');
    await create(page, 'Service', { x: 300, y: 200 });
    await create(page, 'Service', { x: 600, y: 200 });
    await create(page, 'Data Store', { x: 600, y: 450 });
    await connectAndOpen(page, 0, 1);

    const nodeA = (await page.locator('.dc-node').nth(0).boundingBox())!;
    const nodeB = (await page.locator('.dc-node').nth(1).boundingBox())!;
    await page.mouse.click(
      (nodeA.x + nodeA.width + nodeB.x) / 2,
      (nodeA.y + nodeA.height / 2 + nodeB.y + nodeB.height / 2) / 2,
    );
    await expect(inspectorSelect(page, 'Protocol')).toHaveText('Generic Call');
    await expect(inspectorSelect(page, 'Interaction mode')).toHaveText('Sync');

    const target = (await page.locator('.dc-edge-endpoint').nth(1).boundingBox())!;
    const database = (await page.locator('.dc-node').nth(2).boundingBox())!;
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
    await page.mouse.down();
    await page.mouse.move(database.x + database.width / 2, database.y + database.height / 2, { steps: 10 });
    await nextFrames(page);
    await page.mouse.up();

    // The panel itself was never closed by the reconnect — the pairing swapping from
    // Service→Service to Service→Database swaps in the generic Interaction section entirely,
    // and its own behaviour field collapses from a real picker back to none, since a
    // `service>database` write has a predetermined kind.
    await expect(inspectorSelect(page, 'Protocol')).toHaveCount(0);
    await expect(inspectorSelect(page, 'Interaction type')).toHaveText('Reads / writes');
    await expect(inspectorSelect(page, 'Flow kind')).toHaveCount(0);
    await expect(page.getByLabel('Condition')).toHaveCount(0);
  });
});

test.describe('Junction connector', () => {
  // A Junction (`ellipse`) is a routing/convergence point with no semantic identity of its own —
  // see `connectorSemantics.ts`'s `'junction'` category and `resolveTransparentCategory`, and
  // `EdgeInspectorPopover.tsx`'s `touchesJunction`. It is semantically *transparent*, not blank:
  // an edge touching one resolves through it to whatever real node(s) actually feed/receive it,
  // reusing the exact same Interaction UI (and endpoint-compatibility rules) a direct connection
  // between those real nodes would get — narrowed options, the opinionated Service↔Service
  // editor, all of it. Only two things are unconditionally different from a direct connection: the
  // free-text Condition field never shows (a Junction has nothing of its own to attach a condition
  // to), and an edge leaving one frames its own label as a branch name. A Junction with nothing
  // else feeding the relevant side (an "unfed convergence") has nothing to resolve through, so it
  // falls back to the full, unrestricted picker — the same fallback an unclassified pairing gets,
  // for the same reason (no capability-matrix opinion).
  test('Service → Junction (unfed) falls back to the full Interaction picker, with no Condition', async ({
    page,
  }) => {
    await newCanvas(page, 'Service to junction');
    await create(page, 'Service', { x: 300, y: 200 });
    await create(page, 'Junction', { x: 600, y: 200 });
    await connectAndOpen(page, 0, 1);

    await expect(inspectorSelect(page, 'Interaction type')).toHaveText('No type');
    await inspectorSelect(page, 'Interaction type').click();
    await expect(page.getByRole('option')).toHaveText([
      'No type',
      'HTTP',
      'gRPC',
      'Event',
      'Command',
      'Query',
      'Reads',
      'Writes',
      'Reads / writes',
      'Publishes',
      'Consumes',
      'Calls',
      'Depends on',
      'Uses',
      'Fans out',
      'Delivers to',
      'Ingests',
      'Replicates',
      'CDC',
      'Syncs',
      'Dead-letters to',
      'Invalidates',
      'Watches',
      'Searches',
      'Indexes',
      'Routes',
      'Triggers',
      'Implemented by',
      'Implements',
      'Compensates',
      'Transforms',
      'Asks',
      'Delegates to',
      'Escalates to',
      'Notifies',
    ]);
    await page.keyboard.press('Escape');

    await expect(inspectorSelect(page, 'Flow kind')).toHaveText('No kind');
    await expect(inspectorSelect(page, 'Protocol')).toHaveCount(0);
    await expect(page.getByLabel('Condition')).toHaveCount(0);
    await expect(page.getByLabel('Request', { exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Response', { exact: true })).toHaveCount(0);

    // Route and style are visible without another disclosure.
    await expect(page.getByRole('button', { name: /^Advanced/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Stepped route' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Straight route' }).click();
    await expect(page.getByRole('button', { name: 'Straight route' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('button', { name: 'Arrow', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connector colour' })).toBeVisible();
    await page.getByRole('button', { name: 'Connector colour' }).hover();
    await expect(page.getByRole('tooltip')).toContainText('Automatic colour');

    await expect(page.getByTitle('Rename connector')).toHaveText('Add label…');
  });

  test('Junction → Service (unfed) also falls back to the full picker, and offers a branch-label placeholder', async ({
    page,
  }) => {
    await newCanvas(page, 'Junction to service');
    await create(page, 'Junction', { x: 300, y: 200 });
    await create(page, 'Service', { x: 600, y: 200 });
    await connectAndOpen(page, 0, 1);

    await expect(inspectorSelect(page, 'Interaction type')).toHaveText('No type');
    await expect(page.getByLabel('Condition')).toHaveCount(0);

    const caption = page.getByTitle('Rename connector');
    await expect(caption).toHaveText('Add branch label…');
    await caption.click();
    await expect(page.getByLabel('Connector label')).toHaveAttribute('placeholder', 'Add branch label…');
    await page.getByLabel('Connector label').fill('approved');
    await page.getByLabel('Connector label').blur();
    await expect(page.locator('.dc-edge-label')).toHaveText('approved');
  });

  test('a Junction chain with nothing else feeding it also falls back to the full picker, never the opinionated Service→Service editor', async ({
    page,
  }) => {
    await newCanvas(page, 'Junction chain');
    await create(page, 'Junction', { x: 300, y: 200 });
    await create(page, 'Junction', { x: 600, y: 200 });
    await connectAndOpen(page, 0, 1);

    await expect(inspectorSelect(page, 'Protocol')).toHaveCount(0);
    await expect(inspectorSelect(page, 'Interaction type')).toHaveText('No type');
  });

  test('Service → Junction → Database inherits Writes through the Junction, exactly like a direct connection', async ({
    page,
  }) => {
    // The "smart inheritance" case: a Junction fed by exactly one real category on the relevant
    // side resolves transparently to it, reusing that pairing's own narrowed capability — not the
    // full picker (that fallback is only for an unfed or ambiguous convergence, covered above).
    await newCanvas(page, 'Junction smart inheritance');
    await create(page, 'Service', { x: 200, y: 200 });
    await create(page, 'Junction', { x: 500, y: 200 });
    await create(page, 'Data Store', { x: 800, y: 200 });
    await connectAndOpen(page, 0, 1);
    // The first connection auto-selects its edge, opening a popover that covers the Junction
    // node and would block the next `connect()` call's hover on it.
    await page.keyboard.press('Escape');
    await connect(page, 1, 2);

    // Select the Junction → Database leg specifically. Clicked on its line rather than the middle of
    // its box: the connector just drawn is selected, so a bend handle sits there.
    await clickEdge(page, page.locator('.dc-edge').nth(1).locator('.dc-edge-line'));
    await expect(inspectorSelect(page, 'Interaction type')).toHaveText('Reads / writes');
    // `service>database`'s capability has no behaviour options of its own, so the picker
    // collapses to a badge instead of an open `InspectorSelect` — same as a direct connection.
    await expect(inspectorSelect(page, 'Flow kind')).toHaveCount(0);
    await expect(page.getByLabel('Condition')).toHaveCount(0);
  });
});
