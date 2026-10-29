import { test, expect } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { connect } from './mcpConnection';
import { installMockShell } from './mockShell';
import { chooseWorkFile } from './explorer';
import { nearbyServicesRequest } from '../../tests/fixtures/connectors/nearby';

test('real MCP sidecar: create smart attachments, render them, and accept a proposal that moves a shape', async ({ page }) => {
  test.skip(process.platform === 'win32', 'The fixture broker uses a Unix socket.');
  test.skip(!existsSync(process.env.DRAFT_CANVAS_MCP_BINARY ?? join(process.cwd(), 'src-tauri/target/debug/draft-canvas-mcp')), 'Build the real MCP sidecar first.');
  await installMockShell(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'New Quick Draft' })).toBeVisible();
  const connection = await connect(page, '');
  const { client } = connection;
  try {
    const created = await client.call('create_diagram', { requestId: 'nearby-create', ...nearbyServicesRequest() });
    expect(created.ok).toBe(true);
    await page.getByRole('button', { name: 'Open file…' }).click();
    await chooseWorkFile(page, 'MCP nearby services');
    await expect(page.locator('.dc-editor')).toBeVisible();
    const initial = await client.call('read_diagram', { diagramId: 'd_mcp00000001', include: ['geometry'] });
    expect(initial.ok).toBe(true);
    expect(initial.value.relationships).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'nearby', geometry: { from: 'right', to: 'left', path: [[350, 75], [410, 75]] } }),
      expect.objectContaining({ id: 'through', geometry: expect.not.objectContaining({ pins: expect.anything() }) }),
    ]));
    const path = page.locator('.react-flow__edge[data-id="nearby"] .dc-edge-hit').first();
    expect(await path.evaluate(e => (e as SVGPathElement).getTotalLength())).toBeCloseTo(60, 1);
    const image = await client.call('render_diagram', { diagramId: 'd_mcp00000001' });
    expect(image.ok).toBe(true);
    expect(image.record.imageBlocks).toBe(1);
    await page.screenshot({ path: test.info().outputPath('mcp-smart-create.png') });
    const proposed = await client.call('submit_proposal', { requestId: 'nearby-move', diagramId: 'd_mcp00000001', expectedRevision: initial.value.revision, summary: 'Move Service B to the left', ops: [{ op: 'update', id: 'near', set: { place: { x: -410, y: 41 } } }] });
    expect(proposed.ok).toBe(true);
    await page.getByRole('button', { name: '1 proposal to review' }).click();
    await page.getByRole('region', { name: 'Proposal review' }).getByRole('button', { name: 'Accept', exact: true }).click();
    const after = await client.call('read_diagram', { diagramId: 'd_mcp00000001', include: ['geometry'] });
    expect(after.ok).toBe(true);
    expect(after.value.relationships).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'nearby', geometry: { from: 'left', to: 'right', path: expect.any(Array) } })]));
    await page.screenshot({ path: test.info().outputPath('mcp-smart-attachments.png') });
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    const undone = await client.call('read_diagram', { diagramId: 'd_mcp00000001', include: ['geometry'] });
    expect(undone.value.relationships).toEqual(initial.value.relationships);
  } finally {
    await connection.close();
  }
});

test('real MCP sidecar: inspect a candidate, commit, submit a semantic proposal, review and accept', async ({ page }) => {
  test.skip(process.platform === 'win32', 'The fixture broker uses a Unix socket; the Windows bridge has native tests.');
  test.skip(!existsSync(process.env.DRAFT_CANVAS_MCP_BINARY ?? join(process.cwd(), 'src-tauri/target/debug/draft-canvas-mcp')), 'Build the real sidecar with npm run desktop:check; the macOS Rust CI lane runs this journey.');
  await installMockShell(page);
  await page.goto('/');
  const handle = await page.evaluate(async () => {
    // oxlint-disable-next-line typescript/no-explicit-any -- dev-server module imports are runtime URLs
    const load = (path: string) => import(/* @vite-ignore */ path) as Promise<any>;
    const { compose } = await load('/src/agent/compile.ts');
    const text = compose({ title: 'MCP order', nodes: [{ id: 'api', type: 'api', label: 'Orders API', evidence: [{ path: 'src/orders.ts', basis: 'observed', line: 42 }] }, { id: 'db', type: 'database', label: 'Orders DB' }, { id: 'release', type: 'service', label: 'Release service' }], relationships: [{ id: 'r', from: 'api', to: 'db' }], flows: [{ id: 'f', title: 'Order', steps: ['r'] }], notes: [{ id: 'decision', text: 'Old decision', about: 'api' }] }, 'd_mcp00000001').text;
    const handle = window.__shell.addFile('MCP order', text);
    return handle;
  });
  await page.getByRole('button', { name: 'Open file…' }).click();
  await chooseWorkFile(page, 'MCP order');
  await expect(page.locator('.dc-editor')).toBeVisible();
  const connection = await connect(page, handle);
  const { client } = connection;
  try {
    await page.locator('.react-flow__node[data-id="api"]').click();
    await page.locator('.dc-element-inspector').getByRole('button', { name: 'Details' }).click();
    await page.locator('.dc-source-evidence summary').click();
    await expect(page.locator('.dc-source-evidence')).toContainText('src/orders.ts:42');
    await expect(page.locator('.dc-source-evidence')).toContainText('Observed');
    await page.screenshot({ path: test.info().outputPath('mcp-source-evidence.png') });
    await page.keyboard.press('Escape');
    const initial = await client.call('read_diagram', { diagramId: 'd_mcp00000001', include: ['attachments'] });
    expect(initial.ok).toBe(true);
    const candidate = await client.call('preview_diagram', { diagramId: 'd_mcp00000001', expectedRevision: initial.value.revision, ops: [{ op: 'update', id: 'api', set: { label: 'Checkout API' } }] });
    expect(candidate.ok).toBe(true);
    await expect(page.locator('.react-flow__node[data-id="api"]')).toContainText('Orders API');
    const image = await client.call('render_diagram', { diagramId: 'd_mcp00000001', previewId: candidate.value.previewId, focus: { nodes: ['api'] } });
    expect(image.ok).toBe(true);
    expect(image.record.imageBlocks).toBe(1);
    expect(image.value.provisional).toBe(true);
    const committed = await client.call('update_diagram', { diagramId: 'd_mcp00000001', expectedRevision: initial.value.revision, previewId: candidate.value.previewId });
    expect(committed.ok).toBe(true);
    await expect(page.locator('.react-flow__node[data-id="api"]')).toContainText('Checkout API');
    const proposed = await client.call('submit_proposal', { requestId: 'proposal-roundtrip', diagramId: 'd_mcp00000001', expectedRevision: committed.value.revision, summary: 'Clarify order semantics', ops: [{ op: 'update', id: 'f', set: { title: 'Create order' } }, { op: 'update', id: 'decision', set: { text: 'Writes atomically' } }, { op: 'update', id: 'r', set: { directed: false } }] });
    expect(proposed.ok).toBe(true);
    await page.getByRole('button', { name: '1 proposal to review' }).click();
    const panel = page.getByRole('region', { name: 'Proposal review' });
    await expect(panel).toContainText('Create order');
    await expect(panel).toContainText('Writes atomically');
    await expect(panel).toContainText('directed');
    await page.screenshot({ path: test.info().outputPath('mcp-review-light.png') });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: test.info().outputPath('mcp-review-dark.png') });
    await panel.getByRole('button', { name: 'Accept', exact: true }).click();
    await expect.poll(async () => (await client.call('get_proposal', { proposalId: proposed.value.proposalId })).value.status).toBe('accepted');
    const final = await client.call('read_diagram', { diagramId: 'd_mcp00000001', include: ['fullText'] });
    expect(final.ok).toBe(true);
    expect(final.value.flows).toEqual([expect.objectContaining({ id: 'f', title: 'Create order' })]);
    expect(final.value.relationships).toEqual([expect.objectContaining({ id: 'r', directed: false })]);
    await page.keyboard.press('Escape');
    await page.keyboard.press('ControlOrMeta+z');
    const undone = await client.call('read_diagram', { diagramId: 'd_mcp00000001', include: ['fullText'] });
    expect(undone.value.flows).toEqual([expect.objectContaining({ id: 'f', title: 'Order' })]);
    const linked = await client.call('update_diagram', {
      diagramId: 'd_mcp00000001', expectedRevision: undone.value.revision,
      ops: [{ op: 'add', relationships: [{ id: 'release-stock', from: 'api', to: 'release', semantic: 'compensates', compensationFor: 'r', compensationName: 'Release stock', compensationProtocol: 'http', label: 'POST /release', compensationVisible: false }] }],
    });
    expect(linked.ok).toBe(true);
    const linkedRead = await client.call('read_diagram', { diagramId: 'd_mcp00000001' });
    expect(linkedRead.value.relationships).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'release-stock', compensationFor: 'r', compensationName: 'Release stock', compensationProtocol: 'http', compensationVisible: false })]));
  } finally { await connection.close(); }
});
