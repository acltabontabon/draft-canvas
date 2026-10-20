import { expect, test, type Page } from '@playwright/test';

async function example(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await page.getByRole('button', { name: 'Try an example', exact: true }).click();
  await expect(page.getByLabel('Diagram title')).toHaveValue('Order processing');
  await expect(page.locator('.dc-node')).toHaveCount(4);
}

async function command(page: Page, name: string) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('dialog', { name: 'Commands' }).getByRole('combobox').fill(name);
  await page.keyboard.press('Enter');
}

async function clickEdge(page: Page, index: number) {
  const point = await page.locator('.react-flow__edge .dc-edge-hit').nth(index).evaluate((element) => {
    const path = element as SVGPathElement;
    const local = path.getPointAtLength(path.getTotalLength() * .4);
    const screen = new DOMPoint(local.x, local.y).matrixTransform(path.getScreenCTM()!);
    return { x: screen.x, y: screen.y };
  });
  await page.mouse.click(point.x, point.y);
}

test('example plays, edits, and creates a flow with one undo step', async ({ page }, testInfo) => {
  await example(page);
  await page.getByRole('button', { name: 'Play explanation', exact: true }).click();
  await expect(page.locator('.dc-editor')).toHaveAttribute('data-mode', 'present');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Escape');
  await expect(page.locator('.dc-editor')).toHaveAttribute('data-mode', 'edit');
  await command(page, 'Trace a flow');
  const trace = page.getByRole('region', { name: 'Trace a flow' });
  await expect(trace).toBeVisible();
  await trace.getByLabel('Flow name').fill('New explanation');
  const shape = await page.locator('.dc-node').first().boundingBox();
  await page.mouse.dblclick(shape!.x + shape!.width / 2, shape!.y + shape!.height / 2);
  await expect(page.getByRole('textbox', { name: 'Label', exact: true })).toHaveCount(0);
  await clickEdge(page, 0);
  await clickEdge(page, 1);
  await expect(trace.getByText('2 steps', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('flow-trace.png') });
  expect(await page.evaluate(async () => (await import('/src/store/editorStore.ts')).useEditorStore.getState().document.flows.length)).toBe(1);
  await trace.getByRole('button', { name: 'Finish', exact: true }).click();
  await expect(trace).toBeHidden();
  expect(await page.evaluate(async () => (await import('/src/store/editorStore.ts')).useEditorStore.getState().document.flows.length)).toBe(2);
  await page.locator('.dc-canvas').focus();
  await page.keyboard.press('ControlOrMeta+z');
  expect(await page.evaluate(async () => (await import('/src/store/editorStore.ts')).useEditorStore.getState().document.flows.length)).toBe(1);
});

test('tracing works from the Outline and Escape discards the preview', async ({ page }) => {
  await example(page);
  await command(page, 'Trace a flow');
  const trace = page.getByRole('region', { name: 'Trace a flow' });
  await trace.getByRole('button', { name: 'Outline', exact: true }).click();
  const edge = page.getByRole('treeitem').filter({ hasText: 'sends command' }).last();
  await edge.focus();
  await page.keyboard.press('Enter');
  await expect(trace.getByText('1 step', { exact: true })).toBeVisible();
  await page.keyboard.press('Backspace');
  await expect(trace.getByText('0 steps', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(trace).toBeHidden();
  expect(await page.evaluate(async () => (await import('/src/store/editorStore.ts')).useEditorStore.getState().document.flows.length)).toBe(1);
});

test('Share from here opens the chosen flow introduction read-only', async ({ page, context }) => {
  await example(page);
  await command(page, 'Share from here');
  await expect(page.getByRole('combobox', { name: 'Start at' })).toBeVisible();
  const url = await page.evaluate(async () => {
    const editor = (await import('/src/store/editorStore.ts')).useEditorStore.getState();
    const { encodeShareLink } = await import('/src/share/link.ts');
    const result = await encodeShareLink(editor.document, location.href, { path: [], flowId: editor.document.flows[0].id });
    if (!('url' in result)) throw new Error('Expected a share link');
    return result.url;
  });
  const reader = await context.newPage();
  await reader.goto(url);
  await expect(reader.locator('.dc-editor')).toHaveAttribute('data-mode', 'present');
  expect(await reader.evaluate(async () => (await import('/src/store/editorStore.ts')).useEditorStore.getState().flowPlayback.stage)).toBe('opening');
  await reader.keyboard.press('Escape');
  await expect(reader.getByRole('button', { name: 'Make an editable copy' })).toBeVisible();
  await reader.close();
});

test('Arrange selection leaves a fixed neighbor in place', async ({ page }) => {
  await example(page);
  const before = await page.evaluate(async () => {
    const editor = (await import('/src/store/editorStore.ts')).useEditorStore.getState();
    const nodes = editor.document.nodes;
    editor.setSelection({ nodes: [nodes[0].id, nodes[1].id], edges: [] });
    return JSON.stringify(nodes.slice(2));
  });
  await command(page, 'Arrange selection');
  await expect.poll(() => page.evaluate(async () => (await import('/src/store/editorStore.ts')).useEditorStore.getState().history.past.at(-1)?.label)).toBe('Arrange selection');
  expect(await page.evaluate(async () => JSON.stringify((await import('/src/store/editorStore.ts')).useEditorStore.getState().document.nodes.slice(2)))).toBe(before);
});

test('a nested flow link opens its room and an editable copy leaves sharing behind', async ({ page, context }) => {
  await example(page);
  const shared = await page.evaluate(async () => {
    const editor = (await import('/src/store/editorStore.ts')).useEditorStore.getState();
    const { createNode } = await import('/src/document/factory.ts');
    const { encodeShareLink } = await import('/src/share/link.ts');
    const doc = editor.document;
    const owner = createNode({ type: 'service', x: 0, y: 0, text: 'Order system' });
    const nested = { ...doc, nodes: [{ ...owner, inside: { nodes: doc.nodes, edges: doc.edges, flows: doc.flows, viewport: doc.viewport } }], edges: [], flows: [] };
    const link = await encodeShareLink(nested, location.href, { path: [owner.id], flowId: doc.flows[0].id });
    if (!('url' in link)) throw new Error('Expected link');
    return { url: link.url, owner: owner.id };
  });
  const reader = await context.newPage();
  await reader.goto(shared.url);
  await expect(reader.locator('.dc-editor')).toHaveAttribute('data-mode', 'present');
  expect(await reader.evaluate(async () => (await import('/src/store/editorStore.ts')).useEditorStore.getState().path)).toEqual([shared.owner]);
  await reader.keyboard.press('Escape');
  await reader.getByRole('button', { name: 'Make an editable copy' }).click();
  await expect(reader.getByRole('button', { name: 'Make an editable copy' })).toHaveCount(0);
  expect(new URL(reader.url()).hash).not.toContain('start=');
  expect(await page.getByLabel('Diagram title').inputValue()).toBe('Order processing');
  await reader.close();
});

test('an external edit cancels a trace before anything provisional can be saved', async ({ page }) => {
  await example(page);
  await command(page, 'Trace a flow');
  await clickEdge(page, 0);
  await expect(page.locator('.dc-trace-badge')).toHaveCount(1);
  await page.evaluate(async () => {
    const editor = (await import('/src/store/editorStore.ts')).useEditorStore.getState();
    editor.applyToFile('Outside edit', (doc: { metadata: Record<string, unknown> }) => ({ ...doc, metadata: { ...doc.metadata, title: 'Outside edit' } }));
  });
  await expect(page.getByRole('region', { name: 'Trace a flow' })).toHaveCount(0);
  await expect(page.getByLabel('Diagram title')).toHaveValue('Outside edit');
  expect(await page.evaluate(async () => (await import('/src/store/editorStore.ts')).useEditorStore.getState().document.flows.length)).toBe(1);
});

test.describe('touch tracing', () => {
  test.use({ hasTouch: true });
  test.skip(({ browserName }) => browserName !== 'chromium', 'Touch target journey uses Chromium.');
  test('tapping a connector previews a step and cancellation preserves the flow', async ({ page }) => {
    await example(page);
    await page.getByRole('button', { name: 'Flows', exact: true }).click();
    await page.getByRole('button', { name: 'Trace a flow', exact: true }).click();
    const point = await page.locator('.dc-edge-hit').first().evaluate(element => {
      const path = element as SVGPathElement;
      const p = path.getPointAtLength(path.getTotalLength() * .4).matrixTransform(path.getScreenCTM()!);
      return { x: p.x, y: p.y };
    });
    await page.touchscreen.tap(point.x, point.y);
    await expect(page.getByRole('region', { name: 'Trace a flow' }).getByText('1 step', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await page.evaluate(async () => (await import('/src/store/editorStore.ts')).useEditorStore.getState().document.flows.length)).toBe(1);
  });
});
