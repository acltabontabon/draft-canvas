import { describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { normalizeStyle } from '../src/document/style';
import type { DraftDocument, DraftNode } from '../src/document/types';
import { collectLevels, renderEveryLevel, roomIdScope, zipEveryLevel } from '../src/export/levels';
import { collectRooms, hasRooms, roomTitleFor } from '../src/export/rooms';
import { unzipFiles } from '../src/export/zip';
import { BUILTIN_BACKDROPS } from '../src/render/style/backdrops';
import { renderDocumentSvg } from '../src/render/svg/document';

const decoder = new TextDecoder();

function room(nodes: DraftNode[], edges = []): NonNullable<DraftNode['inside']> {
  return { nodes, edges, flows: [], viewport: { x: 0, y: 0, zoom: 1 } };
}

/**
 * Checkout
 * ├── Orders API            (a service with a room)
 * │   └── Handler           (a component with a room)
 * │       └── Parser
 * ├── Orders API            (a second, same-named service with a room — names must not collide)
 * │   └── Cache
 * └── Billing               (no room)
 */
function threeLevels(): DraftDocument {
  const parser = createNode({ type: 'component', x: 0, y: 0, text: 'Parser' });
  const handler = { ...createNode({ type: 'component', x: 0, y: 0, text: 'Handler' }), inside: room([parser]) };
  const ordersApi = { ...createNode({ type: 'service', x: 0, y: 0, text: 'Orders API' }), inside: room([handler]) };
  const cache = createNode({ type: 'database', x: 0, y: 0, text: 'Cache' });
  const ordersApiTwin = { ...createNode({ type: 'service', x: 240, y: 0, text: 'Orders API' }), inside: room([cache]) };
  const billing = createNode({ type: 'service', x: 480, y: 0, text: 'Billing' });
  const edge = createEdge({ source: ordersApi.id, target: billing.id, label: 'charges' });
  return { ...createDocument('Checkout'), nodes: [ordersApi, ordersApiTwin, billing], edges: [edge] };
}

describe('collectRooms', () => {
  it('walks the tree outermost first, each room as a document carrying the file title', () => {
    const doc = threeLevels();
    const rooms = collectRooms(doc);
    expect(rooms.map((r) => r.path.length)).toEqual([0, 1, 2, 1]);
    expect(rooms[0]!.document).toBe(doc);
    expect(rooms.map(roomTitleFor)).toEqual([
      'Checkout',
      'Checkout / Orders API',
      'Checkout / Orders API / Handler',
      'Checkout / Orders API',
    ]);
    expect(rooms[2]!.document.nodes.map((n) => n.text)).toEqual(['Parser']);
    expect(rooms[2]!.document.metadata.title).toBe('Checkout');
  });

  it('knows whether there is anything below the top', () => {
    expect(hasRooms(threeLevels())).toBe(true);
    expect(hasRooms(createDocument('Flat'))).toBe(false);
  });
});

describe('collectLevels', () => {
  it('names each room by its path of slugs, and keeps two same-named owners apart', () => {
    expect(collectLevels(threeLevels()).map((level) => level.name)).toEqual([
      'checkout',
      'checkout--orders-api',
      'checkout--orders-api--handler',
      'checkout--orders-api-2',
    ]);
  });

  it('keeps counting when a counted name is already another room’s slug', () => {
    const owner = (text: string, x: number) => ({
      ...createNode({ type: 'service', x, y: 0, text }),
      inside: room([createNode({ type: 'component', x: 0, y: 0, text: 'Inner' })]),
    });
    for (const texts of [['API', 'API', 'API 2'], ['API 2', 'API', 'API']]) {
      const doc = { ...createDocument('Shop'), nodes: texts.map((text, index) => owner(text, index * 240)) };
      const names = collectLevels(doc).map((level) => level.name);
      expect(new Set(names).size).toBe(names.length);
      expect(names).toContain('shop--api-2');
    }
  });

  it('a flat canvas is one level, and an unnamed owner is named by its kind', () => {
    expect(collectLevels(createDocument('Flat')).map((level) => level.name)).toEqual(['flat']);
    const inner = createNode({ type: 'component', x: 0, y: 0, text: 'Inner' });
    const owner = { ...createNode({ type: 'service', x: 0, y: 0 }), text: '', inside: room([inner]) };
    const doc = { ...createDocument(''), nodes: [owner] };
    expect(collectLevels(doc).map((level) => level.name)).toEqual(['draft-canvas', 'draft-canvas--service']);
  });
});

describe('renderEveryLevel / zipEveryLevel', () => {
  it('renders one SVG per room with that room’s own shapes in it', async () => {
    const entries = await renderEveryLevel(threeLevels(), { format: 'svg', theme: 'dark' });
    expect(entries.map((entry) => entry.name)).toEqual([
      'checkout.svg',
      'checkout--orders-api.svg',
      'checkout--orders-api--handler.svg',
      'checkout--orders-api-2.svg',
    ]);
    const text = entries.map((entry) => (typeof entry.data === 'string' ? entry.data : decoder.decode(entry.data)));
    expect(text[0]).toContain('Billing');
    expect(text[0]).not.toContain('Parser');
    expect(text[1]).toContain('Handler');
    expect(text[2]).toContain('Parser');
    expect(text[2]).not.toContain('Handler');
    expect(text[3]).toContain('Cache');
  });

  it('ignores a selection — the export is every room, not the corner one was made in', async () => {
    const doc = threeLevels();
    const entries = await renderEveryLevel(doc, { format: 'svg', only: new Set([doc.nodes[2]!.id]) });
    expect(entries[0]!.data).toContain('Orders API');
  });

  it('gives each room’s picture ids of its own, so several can be inlined on one page', async () => {
    // Each room is drawn in the file's id, so every member once had the same clip and backdrop ids
    // with different definitions: inlined together, the second resolved `url(#…)` to the first's.
    const note = (text: string, width: number, height: number) => createNode({ type: 'note', x: 0, y: 0, width, height, text });
    const owner = { ...createNode({ type: 'service', x: 300, y: 0, text: 'Orders API' }), inside: room([note('Inner note', 260, 180)]) };
    const tile = BUILTIN_BACKDROPS[0]!.asset;
    const style = normalizeStyle({ v: 1, hand: { base: 'clean' }, backdrop: { art: tile.id }, assets: [tile] }).style;
    const doc = { ...createDocument('Checkout'), nodes: [note('Root note', 160, 90), owner], style };
    const entries = await renderEveryLevel(doc, { format: 'svg', theme: 'light' });
    const definitions = new Map<string, Set<string>>();
    for (const entry of entries) {
      for (const match of (entry.data as string).matchAll(/<(clipPath|pattern|filter|marker)\b[^>]*\bid="([^"]+)"[^>]*>[\s\S]*?<\/\1>/g)) {
        definitions.set(match[2]!, (definitions.get(match[2]!) ?? new Set()).add(match[0]));
      }
    }
    expect(definitions.size).toBeGreaterThan(2);
    expect([...definitions].filter(([, found]) => found.size > 1).map(([id]) => id)).toEqual([]);
    // The top is the picture a single export of it is, byte for byte; a room is the one its own export is.
    expect(entries[0]!.data).toBe(renderDocumentSvg(doc, { theme: 'light' }).svg);
    const inside = collectRooms(doc)[1]!;
    expect(entries[1]!.data).toBe(renderDocumentSvg(inside.document, { theme: 'light', idScope: roomIdScope(inside.path) }).svg);
  });

  it('scopes a room by its whole path, from wherever the export starts', () => {
    expect(roomIdScope([])).toBeUndefined();
    expect(roomIdScope([], 'docs-top')).toBe('docs-top');
    expect(roomIdScope(['a', 'b'])).toBe('level-a.b');
    // Every level of the room the editor is in: its own rooms are scoped as if from the top.
    expect(roomIdScope(['b'], roomIdScope(['a']))).toBe(roomIdScope(['a', 'b']));
  });

  it('zips them into an archive that reads back with the same members', async () => {
    const doc = threeLevels();
    const archive = await zipEveryLevel(doc, { format: 'svg' });
    const back = unzipFiles(archive);
    expect(back.map((entry) => entry.name)).toEqual(collectLevels(doc).map((level) => `${level.name}.svg`));
    expect(decoder.decode(back[2]!.data)).toContain('Parser');
  });
});
