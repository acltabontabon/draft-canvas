import { describe, expect, it } from 'vitest';
import { createNode } from '../src/document/factory';
import type { DraftEdge } from '../src/document/types';
import { buildOutline, edgeKey, nodeKey, rowKeyForSelection } from '../src/ui/Editor/outlineModel';

/** The Outline's tree: boundaries hold members, shapes hold the connectors that touch them. */
describe('buildOutline', () => {
  const boundary = { ...createNode({ type: 'group', x: 0, y: 0 }), id: 'b', text: 'Checkout', width: 600, height: 300 };
  const api = { ...createNode({ type: 'service', x: 20, y: 40 }), id: 'api', text: 'Orders API', parentId: 'b' };
  const orders = { ...createNode({ type: 'database', x: 300, y: 40 }), id: 'orders', text: 'Orders', parentId: 'b' };
  const user = { ...createNode({ type: 'actor', x: 0, y: -200 }), id: 'user', text: 'Shopper' };
  const stray = { ...createNode({ type: 'note', x: 900, y: 40 }), id: 'stray', parentId: 'gone' };
  const writes: DraftEdge = { id: 'w', source: 'api', target: 'orders', directed: true, routing: 'smoothstep', semantic: 'writes' };
  const uses: DraftEdge = { id: 'u', source: 'user', target: 'api', directed: true, routing: 'smoothstep', label: 'places order' };
  const room = { nodes: [boundary, api, orders, user, stray], edges: [writes, uses] };

  it('lists in reading order, nests members under their boundary, and lists a stray member at the top', () => {
    const rows = buildOutline(room);
    expect(rows.map((row) => row.key)).toEqual([
      nodeKey('user'),
      edgeKey('u', 'user'),
      nodeKey('b'),
      nodeKey('api'),
      edgeKey('w', 'api'),
      edgeKey('u', 'api'),
      nodeKey('orders'),
      edgeKey('w', 'orders'),
      nodeKey('stray'),
    ]);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    expect(byKey.get(nodeKey('b'))!.childKeys).toEqual([nodeKey('api'), nodeKey('orders')]);
    expect(byKey.get(nodeKey('api'))!.depth).toBe(2);
    expect(byKey.get(nodeKey('api'))!.parentKey).toBe(nodeKey('b'));
    expect(byKey.get(nodeKey('stray'))!.depth).toBe(1);
  });

  it('reads each row the way the canvas speaks it', () => {
    const rows = buildOutline(room);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    expect(byKey.get(nodeKey('api'))!.reading).toBe('Orders API, service, 2 connectors');
    expect(byKey.get(nodeKey('api'))!.detail).toBe('service');
    const out = byKey.get(edgeKey('w', 'api'))!;
    expect(out).toMatchObject({ label: 'Orders', detail: 'writes to', direction: 'out', reading: 'Orders API writes to Orders' });
    const inbound = byKey.get(edgeKey('u', 'api'))!;
    expect(inbound).toMatchObject({ label: 'Shopper', detail: 'places order', direction: 'in', reading: 'Shopper places order Orders API' });
  });

  it('points the roving stop at the first selected shape, else the first selected connector', () => {
    const rows = buildOutline(room);
    expect(rowKeyForSelection({ nodes: ['orders'], edges: ['w'] }, rows)).toBe(nodeKey('orders'));
    expect(rowKeyForSelection({ nodes: [], edges: ['w'] }, rows)).toBe(edgeKey('w', 'api'));
    // The keyboard is on the connector's row under the other end: that row keeps the stop.
    expect(rowKeyForSelection({ nodes: [], edges: ['w'] }, rows, edgeKey('w', 'orders'))).toBe(edgeKey('w', 'orders'));
    expect(rowKeyForSelection({ nodes: [], edges: ['w'] }, rows, nodeKey('orders'))).toBe(edgeKey('w', 'api'));
    expect(rowKeyForSelection({ nodes: ['missing'], edges: [] }, rows)).toBeNull();
    expect(rowKeyForSelection({ nodes: [], edges: [] }, rows)).toBeNull();
  });
});
