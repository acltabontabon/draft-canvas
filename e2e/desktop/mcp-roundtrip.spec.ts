import { test, expect, type Page } from '@playwright/test';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { McpSession } from '../agent-conversations';
import { installMockShell } from './mockShell';
import { chooseWorkFile } from './explorer';
import { nearbyServicesRequest } from '../../tests/fixtures/connectors/nearby';

/** A real stdio MCP client and sidecar joined to the real browser editor. Only the OS broker/disk
 *  are faked here; native admission, journaling and access checks have their Rust integration tests. */
async function connect(page: Page, handle: string) {
  const dir = mkdtempSync(join(tmpdir(), 'dc-mcp-'));
  const endpoint = join(dir, 'bridge.sock');
  const token = 'test-only-token'.repeat(5);
  writeFileSync(join(dir, 'agent.json'), JSON.stringify({ v: 1, endpoint, token, pid: process.pid }), { mode: 0o600 });
  let nextId = 1000;
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    let buffer = '';
    let session = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      while (buffer.includes('\n')) {
        const at = buffer.indexOf('\n');
        const frame = JSON.parse(buffer.slice(0, at)) as Record<string, unknown>;
        buffer = buffer.slice(at + 1);
        if (frame.type === 'hello') {
          session = String(frame.session);
          socket.write(`${JSON.stringify({ type: 'welcome', bridge: 1, app: 'test' })}\n`);
        } else if (frame.type === 'call') {
          void (async () => {
            const tool = String(frame.tool);
            const args = frame.args as Record<string, unknown>;
            if (tool === 'get_proposal') {
              const value = await page.evaluate((id) => window.__shell.proposal(id), String(args.proposalId));
              socket.write(`${JSON.stringify({ type: 'result', id: frame.id, ok: true, value })}\n`);
              return;
            }
            const id = nextId++;
            await page.evaluate(({ id, tool, args, handle, session }) => window.__shell.emit({ type: 'agent-request', id, tool, args, context: { handle, open: true, diagramId: 'd_mcp00000001', session } }), { id, tool, args, handle, session });
            await expect.poll(() => page.evaluate((id) => !!window.__shell.agentResponse(id), id)).toBe(true);
            const outcome = await page.evaluate((id) => window.__shell.agentResponse(id), id) as { ok: boolean; value?: Record<string, unknown>; error?: unknown };
            let value = outcome.value;
            if (tool === 'create_diagram' && outcome.ok) {
              // The real worker composes the file; only native disk persistence is mocked.
              handle = await page.evaluate(value => window.__shell.addFile(String(value.title), String(value.text)), value!);
              value = { ...(value!.receipt as Record<string, unknown>), diagramId: 'd_mcp00000001', revision: 'f:1' };
            }
            if (tool === 'submit_proposal' && outcome.ok) {
              const proposalId = `p_${id}`;
              await page.evaluate(({ value, proposalId }) => {
                window.__shell.addProposal({ ...value, proposalId, version: 1, status: 'pending', createdAt: Date.now(), updatedAt: Date.now(), resolvedAt: null, stale: false });
                window.__shell.emit({ type: 'agent-changed' });
              }, { value: value!, proposalId });
              value = { proposalId, diagramId: value!.diagramId, revision: value!.baseRevision, counts: value!.counts, status: 'pending' };
            }
            socket.write(`${JSON.stringify({ type: 'result', id: frame.id, ok: outcome.ok, ...(outcome.ok ? { value } : { error: outcome.error }) })}\n`);
          })().catch((error: unknown) => socket.destroy(error instanceof Error ? error : new Error(String(error))));
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(endpoint, resolve));
  const client = new McpSession('browser-mcp', process.env.DRAFT_CANVAS_MCP_BINARY ?? join(process.cwd(), 'src-tauri/target/debug/draft-canvas-mcp'), dir);
  await client.start();
  return { client, close: async () => {
    client.stop();
    sockets.forEach((socket) => socket.destroy());
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  } };
}

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
      expect.objectContaining({ id: 'nearby', geometry: { from: 'right', to: 'left', path: [[350, 75], [410, 75]], pins: {} } }),
      expect.objectContaining({ id: 'through', geometry: expect.objectContaining({ to: 'left', pins: {} }) }),
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
    expect(after.value.relationships).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'nearby', geometry: expect.objectContaining({ from: 'left', to: 'right', pins: {} }) })]));
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
