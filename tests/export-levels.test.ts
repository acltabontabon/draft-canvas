import { describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import type { DraftDocument, DraftNode } from '../src/document/types';
import { collectLevels, renderEveryLevel, zipEveryLevel } from '../src/export/levels';
import { collectRooms, hasRooms, roomTitleFor } from '../src/export/rooms';
import { unzipFiles } from '../src/export/zip';

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

  it('zips them into an archive that reads back with the same members', async () => {
    const doc = threeLevels();
    const archive = await zipEveryLevel(doc, { format: 'svg' });
    const back = unzipFiles(archive);
    expect(back.map((entry) => entry.name)).toEqual(collectLevels(doc).map((level) => `${level.name}.svg`));
    expect(decoder.decode(back[2]!.data)).toContain('Parser');
  });
});
