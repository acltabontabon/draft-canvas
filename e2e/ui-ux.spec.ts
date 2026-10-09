import { expect, test, type Page } from '@playwright/test';
import { create, newCanvas } from './canvas';

async function command(page: Page, name: string) {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('dialog', { name: 'Commands' }).getByRole('combobox').fill(name);
  await page.keyboard.press('Enter');
}

test('the library folder trigger toggles its menu closed', async ({ page }) => {
  await newCanvas(page, 'Menu toggle');
  await page.getByRole('button', { name: 'Back to your diagrams' }).click();
  const trigger = page.getByRole('button', { name: 'Move Menu toggle to a project' });
  await trigger.click();
  await expect(page.getByRole('menu', { name: 'Move to project' })).toBeVisible();
  await trigger.click();
  await expect(page.getByRole('menu', { name: 'Move to project' })).toBeHidden();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('keyboard navigation scrolls the project menu to the highlighted row', async ({ page }) => {
  await newCanvas(page, 'Many projects');
  await page.getByRole('button', { name: 'Back to your diagrams' }).click();
  for (let i = 0; i < 12; i += 1) {
    await page.getByRole('button', { name: 'New project', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New project', exact: true });
    await dialog.getByLabel('Name').fill(`Project ${String(i).padStart(2, '0')}`);
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(page.getByRole('heading', { name: `Project ${String(i).padStart(2, '0')}`, exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: 'All diagrams', exact: true }).click();
  await page.getByRole('button', { name: 'Move Many projects to a project' }).click();
  const menu = page.getByRole('menu', { name: 'Move to project' });
  await page.keyboard.press('End');
  await expect(menu.locator('[data-highlighted="true"]')).toHaveText('Project 11');
  await expect.poll(() => menu.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(menu.locator('[data-highlighted="true"]')).toBeInViewport();
  await page.keyboard.press('Home');
  await expect.poll(() => menu.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(4);
});

test('settings tabs directly to the visible image chooser', async ({ page }) => {
  await newCanvas(page, 'Settings focus');
  await command(page, 'Canvas settings');
  const settings = page.getByRole('dialog', { name: 'Canvas settings', exact: true });
  await expect(settings).toBeVisible();
  await page.keyboard.press('Tab');
  await expect(settings.getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(settings.getByRole('button', { name: 'Choose image…', exact: true })).toBeFocused();
});

test('Escape during an IME conversion keeps the flow trace in progress', async ({ page }) => {
  await newCanvas(page, 'Trace overlays');
  await command(page, 'Trace a flow');
  const trace = page.getByRole('region', { name: 'Trace a flow', exact: true });
  await expect(trace).toBeVisible();
  await trace.getByLabel('Flow name').fill('Work in progress');
  await trace.getByLabel('Flow name').dispatchEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true });
  await expect(trace).toBeVisible();
  await expect(trace.getByLabel('Flow name')).toHaveValue('Work in progress');
  await trace.getByLabel('Flow name').focus();
  await page.keyboard.press('Escape');
  await expect(trace).toBeHidden();
});

test('a scrollable inspector menu keeps its keyboard highlight visible', async ({ page }) => {
  await newCanvas(page, 'Inspector scrolling');
  await create(page, 'Boundary', { x: 400, y: 300 });
  await page.locator('.dc-node').first().click();
  // Leave enough room for the inspector itself, but force its rich menu to scroll.
  await page.setViewportSize({ width: 1280, height: 450 });
  await page.getByRole('button', { name: /^Boundary kind:/ }).click();
  const menu = page.getByRole('listbox', { name: 'Boundary kind', exact: true });
  await expect(menu).toBeVisible();
  const options = menu.getByRole('option');
  for (let i = 1; i < await options.count(); i += 1) await page.keyboard.press('ArrowDown');
  await expect.poll(() => menu.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const highlighted = menu.locator('[data-highlighted="true"]');
  await expect.poll(() => highlighted.evaluate((element) => {
    const row = element.getBoundingClientRect();
    const list = element.parentElement!.getBoundingClientRect();
    return row.top >= list.top && row.bottom <= list.bottom;
  })).toBe(true);
});

test('long diagram and project names stay readable in narrow layouts', async ({ page }) => {
  const title = 'LongDiagramName'.repeat(12);
  await newCanvas(page, title);
  for (const width of [1280, 768, 375]) {
    await page.setViewportSize({ width, height: 800 });
    const field = page.getByLabel('Diagram title');
    await expect(field).toHaveValue(title);
    await expect.poll(() => field.evaluate((element) => element.scrollHeight <= element.clientHeight + 1)).toBe(true);
    await expect.poll(() => page.locator('.dc-toolbar').evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  }
  await page.getByRole('button', { name: 'Back to your diagrams' }).click();
  const name = page.locator('.dc-library-item-title');
  await expect(name).toHaveText(title);
  await expect.poll(() => name.evaluate((element) => element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  await page.getByRole('button', { name: 'New project', exact: true }).click();
  const project = 'LongProjectName'.repeat(6);
  const dialog = page.getByRole('dialog', { name: 'New project', exact: true });
  await dialog.getByLabel('Name').fill(project);
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { name: project, exact: true })).toBeVisible();
  const projectName = page.locator('.dc-sidebar-project-name');
  await expect(projectName).toHaveText(project);
  await expect.poll(() => projectName.evaluate((element) => element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1)).toBe(true);
});

test('a long edited shape name grows its box and stays complete after reload', async ({ page }) => {
  await newCanvas(page, 'Flexible names');
  await create(page, 'Service', { x: 320, y: 300 });
  const title = 'LongArchitectureName'.repeat(8);
  const node = page.locator('.dc-node').first();
  await node.dblclick();
  await page.locator('.dc-node-editor').fill(title);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(node.locator('.dc-node-surface')).toHaveText(title);
  await expect(page.locator('.dc-save')).toContainText('Saved locally');
  await page.reload();
  await expect(page.locator('.dc-editor')).toBeVisible();
  await expect(page.locator('.dc-node-surface')).toHaveText(title);
});

test('an existing small shape can fit its full label from the palette', async ({ page }) => {
  await newCanvas(page, 'Saved label');
  const title = 'LongSavedArchitectureName'.repeat(6);
  await page.evaluate(async (text) => {
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    useEditorStore.getState().addNode({ type: 'service', x: 260, y: 230, text });
  }, title);
  const node = page.locator('.dc-node').first();
  await expect(node.locator('.dc-node-surface')).toContainText('…');
  await node.click();
  await command(page, 'Fit shapes to text');
  await expect(node.locator('.dc-node-surface')).toHaveText(title);
});

test('long presentation details remain scrollable within the camera footprint', async ({ page }) => {
  await newCanvas(page, 'Long presentation details');
  const caption = 'A complete explanation of this handoff. '.repeat(12);
  const title = 'LongFlowName'.repeat(8);
  const nextTitle = 'NextFlowName'.repeat(8);
  await page.evaluate(async ({ text, title, nextTitle }) => {
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    const state = useEditorStore.getState();
    const a = state.addNode({ type: 'service', x: 200, y: 200, text: 'Sender' });
    const b = state.addNode({ type: 'service', x: 500, y: 200, text: 'Receiver' });
    const edge = state.connect(a.id, b.id)!;
    const flow = state.createFlow(title)!;
    state.addEdgeToFlow(flow, edge.id, text);
    const returnEdge = state.connect(b.id, a.id)!;
    state.addEdgeToFlow(flow, returnEdge.id, text);
    const nextFlow = state.createFlow(nextTitle)!;
    state.addEdgeToFlow(nextFlow, returnEdge.id, text);
    state.setSelectedFlowId(flow);
  }, { text: caption, title, nextTitle });
  await page.getByRole('button', { name: 'Present', exact: true }).click();
  await page.keyboard.press('ArrowRight');
  const details = page.getByRole('region', { name: 'Step details' });
  await expect(page.locator('.dc-explain-flow-title')).toHaveText(title);
  await expect.poll(() => page.locator('.dc-explain-flow-title').evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThan(100);
  await page.setViewportSize({ width: 375, height: 760 });
  await expect.poll(() => page.locator('.dc-explain-bar').evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(104);
  await page.getByRole('button', { name: 'Exit', exact: true }).focus();
  await expect(page.getByRole('button', { name: 'Exit', exact: true })).toBeInViewport();
  await expect(details.locator('.dc-present-text')).toHaveText(caption.trim());
  await expect.poll(() => details.evaluate((element) => element.getBoundingClientRect().height)).toBeLessThanOrEqual(132);
  await details.getByRole('button', { name: 'Read full step details' }).click();
  await expect(details).toBeFocused();
  await page.keyboard.press('End');
  await expect.poll(() => details.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  await expect(details.locator('.dc-present-eyebrow')).toContainText('Step 1 of 2');
  await page.keyboard.press('ArrowRight');
  await expect(details.locator('.dc-present-eyebrow')).toContainText('Step 2 of 2');
  await expect.poll(() => details.evaluate((element) => element.scrollTop)).toBe(0);
  await page.keyboard.press('ArrowRight');
  const nextFlowButton = page.locator('.dc-explain-next-flow-button');
  await expect(nextFlowButton).toHaveAccessibleName(`Next flow: ${nextTitle}`);
  await nextFlowButton.focus();
  await expect(nextFlowButton).toBeInViewport();
  await expect.poll(() => nextFlowButton.evaluate((element) => {
    const text = element.querySelector('.dc-explain-next-flow')!;
    return text.getBoundingClientRect().height <= element.getBoundingClientRect().height;
  })).toBe(true);
  await nextFlowButton.click();
  await expect(page.locator('.dc-explain-flow-title')).toHaveText(nextTitle);
});
