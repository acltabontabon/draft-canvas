import { test, expect } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { installMockShell } from './mockShell';
import { chooseWorkFile } from './explorer';
import { connect } from './mcpConnection';

type Room = { nodes: { id: string; inside?: Room }[]; relationships?: { id: string }[]; notes?: { id: string; text: string }[] };
const request = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/agent/draft-canvas.request.json'), 'utf8'));

function rooms(room: Room, path: string[] = []): { room: Room; path: string[] }[] {
  return [{ room, path }, ...room.nodes.flatMap(node => node.inside ? rooms(node.inside, [...path, node.id]) : [])];
}

/** A realistic skill journey: the repository itself, nested rooms, evidence, flows, a precise edit,
 * a stale write and a rendered export of every view. Native admission/disk remain Rust-tested. */
test('skill maps Draft Canvas through MCP and renders every view', async ({ page }) => {
  test.setTimeout(120_000);
  test.skip(process.platform === 'win32', 'The fixture broker uses a Unix socket.');
  test.skip(!existsSync(process.env.DRAFT_CANVAS_MCP_BINARY ?? join(process.cwd(), 'src-tauri/target/debug/draft-canvas-mcp')), 'Build the MCP sidecar first.');
  await installMockShell(page);
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'New Quick Draft' })).toBeVisible();
  const connection = await connect(page, '');
  const { client } = connection;
  const report: Record<string, unknown> = {};
  try {
    const capabilities = await client.call('get_capabilities', { topics: ['readability'] });
    expect(capabilities.ok, JSON.stringify(capabilities.value)).toBe(true);
    const created = await client.call('create_diagram', { ...request, requestId: randomUUID() });
    report.created = created.value;
    writeFileSync(test.info().outputPath('receipt.json'), JSON.stringify(report, null, 2));
    expect(created.ok, JSON.stringify(created.value)).toBe(true);
    expect(created.value.created).toMatchObject({ insideViews: 3, attachments: 7 });
    const diagramId = created.value.diagramId;
    await page.getByRole('button', { name: 'Open file…' }).click();
    await chooseWorkFile(page, request.title);
    await expect(page.locator('.dc-editor')).toBeVisible();
    const initial = await client.call('read_diagram', { diagramId, include: ['views', 'geometry'] });
    expect(initial.ok).toBe(true);
    expect((initial.value.views as { inside: string[] }[]).map(view => view.inside)).toEqual(rooms(request).slice(1).map(view => view.path));
    report.initial = initial.value;
    const before = await client.call('read_diagram', { diagramId, view: { inside: ['editor'] }, include: ['geometry'] });
    expect(before.ok).toBe(true);
    const preview = await client.call('preview_diagram', {
      diagramId, expectedRevision: initial.value.revision, view: { inside: ['editor'] },
      ops: [{ op: 'update', id: 'e.model', set: { description: 'Transforms immutable graphs and lenses nested rooms.' } }],
    });
    expect(preview.ok, JSON.stringify(preview.value)).toBe(true);
    const previewImage = await client.call('render_diagram', { diagramId, previewId: preview.value.previewId, view: { inside: ['editor'] } });
    expect(previewImage.ok).toBe(true);
    expect(previewImage.value.provisional).toBe(true);
    const untouched = await client.call('read_diagram', { diagramId, view: { inside: ['editor'] } });
    expect(untouched.value.revision).toBe(initial.value.revision);
    const updated = await client.call('update_diagram', {
      diagramId, expectedRevision: initial.value.revision, view: { inside: ['editor'] }, previewId: preview.value.previewId,
    });
    expect(updated.ok, JSON.stringify(updated.value)).toBe(true);
    report.updated = updated.value;
    const stale = await client.call('update_diagram', {
      diagramId, expectedRevision: initial.value.revision,
      ops: [{ op: 'update', id: 'editor', set: { label: 'Stale edit must not land' } }],
    });
    expect(stale.ok).toBe(false);
    expect(stale.record.code).toBe('REVISION_CONFLICT');
    const views = [];
    for (const { room, path } of rooms(request)) {
      const view = { inside: path };
      const read = await client.call('read_diagram', { diagramId, view, include: ['geometry', 'fullText'] });
      expect(read.ok, JSON.stringify(read.value)).toBe(true);
      const nodes = read.value.elements as { id: string; geometry?: unknown }[];
      expect(nodes.map(node => node.id).sort()).toEqual(room.nodes.map(node => node.id).sort());
      const relationships = read.value.relationships as { id: string }[];
      expect(relationships.map(edge => edge.id).sort()).toEqual((room.relationships ?? []).map(edge => edge.id).sort());
      const hosts = [...nodes, ...relationships] as { attachments?: { id: string; text: string }[] }[];
      const attachments = hosts.flatMap(host => host.attachments ?? []);
      for (const note of room.notes ?? []) expect(attachments).toContainEqual(expect.objectContaining({ id: note.id, text: note.text }));
      expect(read.value.revision).toBe(updated.value.revision);
      if (path.join('/') === 'editor') {
        const original = before.value.elements as { id: string; geometry?: unknown }[];
        expect(nodes.map(node => [node.id, node.geometry])).toEqual(original.map(node => [node.id, node.geometry]));
      }
      const rendered = await client.call('render_diagram', { diagramId, view, format: 'png', scale: 1 });
      expect(rendered.ok, JSON.stringify(rendered.value)).toBe(true);
      expect(rendered.images).toHaveLength(1);
      const name = path.join('-') || 'overview';
      writeFileSync(test.info().outputPath(`${name}.png`), Buffer.from(rendered.images[0]!.data, 'base64'));
      views.push({ path, read: read.value, render: rendered.value });
    }
    report.views = views;
    report.calls = client.records;
    const file = await connection.file();
    expect(file).toBeDefined();
    writeFileSync(test.info().outputPath('draft-canvas-architecture.draftcanvas'), file!.text);
    writeFileSync(test.info().outputPath('report.json'), JSON.stringify(report, null, 2));
  } finally {
    await connection.close();
  }
});
