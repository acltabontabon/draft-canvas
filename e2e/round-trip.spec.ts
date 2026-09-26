import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { CURRENT_VERSION } from '../src/document/types.ts';

/**
 * Everything a discussion leaves on a canvas has to survive being saved, reopened and moved.
 *
 * One rich diagram — nested boundaries, a note and a code snippet on a shape and on a connector, a
 * shape with a room inside it, a flow, and a v15 file's actions (which become notes on the way in)
 * — goes through the whole loop: imported, saved to IndexedDB, reloaded and reopened from the Library,
 * exported as a `.draftcanvas`, imported again as a copy, and exported again. Each export has to say
 * the same thing, so a field that is dropped anywhere along the way is a failing test rather than a
 * diagram that quietly comes back thinner a week later.
 */

const richDocument = () => ({
  format: 'draft-canvas',
  version: 15,
  metadata: { id: 'round-trip', title: 'Round trip', createdAt: 1, updatedAt: 2 },
  level: 'container',
  nodes: [
    { id: 'sys', type: 'group', x: 0, y: 0, width: 980, height: 540, z: 0, text: 'Payments', boundaryPreset: 'system' },
    { id: 'box', type: 'group', x: 30, y: 60, width: 640, height: 300, z: 0, text: 'Core', boundaryPreset: 'boundary', parentId: 'sys' },
    {
      id: 'a',
      type: 'service',
      x: 70,
      y: 130,
      width: 170,
      height: 70,
      z: 1,
      text: 'Orders',
      description: 'Takes and validates orders.',
      technology: 'Spring Boot',
      parentId: 'box',
      attachments: [
        { id: 'a-note', type: 'note', text: 'Owned by the platform team', noteKind: 'warning', width: 200, height: 56 },
        { id: 'a-code', type: 'code', language: 'json', code: '{ "retries": 3 }', width: 380, height: 180 },
      ],
    },
    {
      id: 'b',
      type: 'service',
      x: 330,
      y: 130,
      width: 170,
      height: 70,
      z: 1,
      text: 'Ledger',
      parentId: 'box',
      inside: {
        nodes: [
          { id: 'r1', type: 'service', x: 60, y: 60, width: 170, height: 70, z: 0, text: 'Posting', technology: 'Kotlin' },
          { id: 'r2', type: 'database', x: 320, y: 60, width: 170, height: 90, z: 0, text: 'Journal' },
        ],
        edges: [{ id: 're1', source: 'r1', target: 'r2', directed: true, routing: 'smoothstep' }],
        flows: [],
        viewport: { x: 0, y: 0, zoom: 1 },
        level: 'component',
      },
    },
    { id: 'c', type: 'database', x: 740, y: 150, width: 170, height: 90, z: 1, text: 'Store', parentId: 'sys' },
    { id: 'free', type: 'note', x: 1040, y: 60, width: 220, height: 80, z: 1, text: 'Use asynchronous processing', noteKind: 'decision' },
  ],
  edges: [
    {
      id: 'e1',
      source: 'a',
      target: 'b',
      directed: true,
      routing: 'smoothstep',
      label: 'calls',
      hasResponse: true,
      response: '200 OK',
      attachments: [{ id: 'e1-note', type: 'note', text: 'Times out after 2s', noteKind: 'note', width: 200, height: 56 }],
    },
    { id: 'e2', source: 'b', target: 'c', directed: true, routing: 'smoothstep', kind: 'async', async: true },
  ],
  flows: [{ id: 'f1', title: 'Happy path', steps: [{ id: 's1', edgeId: 'e1', caption: 'A request comes in' }] }],
  actions: [
    { id: 'act1', text: 'Confirm the timeout @Priya', anchor: { kind: 'node', id: 'a' } },
    { id: 'act2', text: 'Write up the migration plan', done: true },
  ],
  viewport: { x: 40, y: 40, zoom: 0.7 },
  settings: { showSequence: true, grid: 'dots', background: { enabled: false, fit: 'cover', dim: 0.55, blur: 0 } },
});

type Json = Record<string, unknown>;

/** What a file says about the canvas, minus what legitimately differs between copies: the identity,
 *  the timestamps, and where the camera happened to be left. */
function content(file: Json): Json {
  const copy = structuredClone(file) as Json & { metadata: Json; viewport?: unknown; nodes: Array<Json & { inside?: Json }> };
  delete copy.viewport;
  copy.metadata = { ...copy.metadata, id: '', title: '', createdAt: 0, updatedAt: 0 };
  const strip = (nodes: Array<Json & { inside?: Json }>) => {
    for (const node of nodes) {
      if (node.inside) {
        delete node.inside.viewport;
        strip((node.inside.nodes as Array<Json & { inside?: Json }>) ?? []);
      }
    }
  };
  strip(copy.nodes);
  return copy;
}

async function exportDocument(page: Page): Promise<Json> {
  await page.getByRole('button', { name: 'Export', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Export' });
  await dialog.locator('[data-mode="document"]').click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export document' }).click();
  const file = await download;
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  return JSON.parse(readFileSync(await file.path(), 'utf8')) as Json;
}

test('a rich diagram survives save, reopen, export and import unchanged', async ({ page }) => {
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', {
    name: 'round-trip.draftcanvas',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(richDocument())),
  });
  await page.waitForSelector('.dc-editor');
  await expect(page.locator('.dc-node')).toHaveCount(7);
  await expect(page.locator('.dc-save')).toContainText('Saved locally');

  const first = await exportDocument(page);
  // The things this test exists to protect are all present in what the app holds.
  const nodes = first.nodes as Array<{ id: string; attachments?: unknown[]; inside?: { nodes: unknown[]; edges: unknown[] } }>;
  // The anchored action arrived as a third attachment on its shape; the unanchored one as an Actions note.
  expect(nodes.find((n) => n.id === 'a')?.attachments).toHaveLength(3);
  expect(nodes.find((n) => n.id === 'b')?.inside?.nodes).toHaveLength(2);
  // Schema v15's C4 text, at the top and inside a room.
  expect(nodes.find((n) => n.id === 'a')).toMatchObject({ description: 'Takes and validates orders.', technology: 'Spring Boot' });
  expect(nodes.find((n) => n.id === 'b')?.inside?.nodes[0]).toMatchObject({ technology: 'Kotlin' });
  expect((first.edges as Array<{ id: string; attachments?: unknown[] }>).find((e) => e.id === 'e1')?.attachments).toHaveLength(1);
  expect(first.actions).toBeUndefined();
  expect(((nodes.find((n) => n.id === 'a')?.attachments ?? []) as Array<{ text?: string }>).map((a) => a.text)).toContain('Action: Confirm the timeout @Priya');
  expect((nodes as unknown as Array<{ type: string; text?: string }>).find((n) => n.type === 'note' && n.text?.startsWith('Actions\n'))?.text).toBe('Actions\n☑ Write up the migration plan');
  expect(first.flows).toHaveLength(1);
  expect(nodes.filter((n) => (n as { parentId?: string }).parentId === 'box').map((n) => n.id).sort()).toEqual(['a', 'b']);

  // Saved, closed, reloaded from disk, reopened from the Library.
  await page.reload();
  await page.locator('.dc-library-item', { hasText: 'Round trip' }).click();
  await expect(page.locator('.dc-node')).toHaveCount(7);
  const reopened = await exportDocument(page);
  expect(content(reopened)).toEqual(content(first));

  // Exported, and imported again: the id is taken, so it arrives as a copy — and says the same.
  await page.getByRole('button', { name: 'Back to your diagrams' }).click();
  await page.setInputFiles('input[type="file"]', {
    name: 'again.draftcanvas',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(reopened)),
  });
  await page.waitForSelector('.dc-editor');
  await expect(page.locator('.dc-node')).toHaveCount(7);
  const copy = await exportDocument(page);
  expect((copy.metadata as { id: string }).id).not.toBe((first.metadata as { id: string }).id);
  expect(content(copy)).toEqual(content(first));
});

/**
 * A diagram an agent created on the desktop (schema v15, C4 text, a system boundary) opened in the web
 * editor, edited there, exported, and opened again: its architecture comes back as it went out.
 * The file is the one the desktop app wrote, kept as a fixture.
 */
test('a desktop-created v15 diagram survives web editing and export', async ({ page }) => {
  const text = readFileSync(new URL('../tests/fixtures/agent/online-shop.desktop.draftcanvas', import.meta.url), 'utf8');
  const original = JSON.parse(text) as Json & { nodes: Array<Json & { id: string }> };
  await page.goto('/');
  await page.setInputFiles('input[type="file"]', { name: 'shop.draftcanvas', mimeType: 'application/json', buffer: Buffer.from(text) });
  await page.waitForSelector('.dc-editor');
  await expect(page.locator('.dc-node')).toHaveCount(original.nodes.length);
  // An edit made in the web editor, through the same store action the inspector uses.
  await page.evaluate(async () => {
    const { useEditorStore } = await import('/src/store/editorStore.ts');
    useEditorStore.getState().setNodeC4Text('ordersDb', { technology: 'PostgreSQL 16' });
  });
  const exported = await exportDocument(page);
  // The v15 file is migrated on open, so the export carries whatever the current schema is.
  expect(exported.version).toBe(CURRENT_VERSION);
  const nodes = exported.nodes as Array<Json & { id: string; description?: string; technology?: string; parentId?: string }>;
  for (const node of original.nodes) {
    const back = nodes.find((n) => n.id === node.id);
    expect(back?.description).toBe(node.description);
    expect(back?.parentId).toBe(node.parentId);
    if (node.id !== 'ordersDb') expect(back?.technology).toBe(node.technology);
  }
  expect(nodes.find((n) => n.id === 'ordersDb')?.technology).toBe('PostgreSQL 16');
  expect((exported.edges as unknown[]).length).toBe((original.edges as unknown[]).length);
});
