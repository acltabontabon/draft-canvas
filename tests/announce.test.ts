import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ANNOUNCE_DEBOUNCE_MS, announce, resetAnnouncements, subscribeAnnouncements, type Announcement } from '../src/lib/announce';
import { createNode } from '../src/document/factory';
import type { DraftDocument, DraftEdge } from '../src/document/types';
import { connectorReading, kindReading, nodeLookupOf, nodeReading } from '../src/nodes/readings';
import { selectionAnnouncement } from '../src/ui/Editor/useSelectionAnnouncements';

describe('announce', () => {
  let spoken: Announcement[];
  beforeEach(() => {
    vi.useFakeTimers();
    resetAnnouncements();
    spoken = [];
    subscribeAnnouncements((a) => spoken.push(a));
  });
  afterEach(() => {
    resetAnnouncements();
    vi.useRealTimers();
  });

  it('speaks only the last message of a burst, once the burst settles', () => {
    announce('Orders API, service, 2 connectors');
    announce('Payments, service, 1 connector');
    announce('Ledger, data store, 1 connector');
    expect(spoken).toHaveLength(0);
    vi.advanceTimersByTime(ANNOUNCE_DEBOUNCE_MS);
    expect(spoken.map((a) => a.text)).toEqual(['Ledger, data store, 1 connector']);
  });

  it('repeats the same words with a new sequence number, so a region re-reads them', () => {
    announce('Selection cleared');
    vi.advanceTimersByTime(ANNOUNCE_DEBOUNCE_MS);
    announce('Selection cleared');
    vi.advanceTimersByTime(ANNOUNCE_DEBOUNCE_MS);
    expect(spoken).toHaveLength(2);
    expect(spoken[0]!.seq).not.toBe(spoken[1]!.seq);
  });

  it('carries the politeness and drops empty text', () => {
    announce('   ');
    announce('Could not save', { assertive: true });
    vi.advanceTimersByTime(ANNOUNCE_DEBOUNCE_MS);
    expect(spoken).toEqual([{ text: 'Could not save', assertive: true, seq: expect.any(Number) }]);
  });
});

describe('readings', () => {
  const api = { ...createNode({ type: 'service', x: 0, y: 0 }), id: 'api', text: 'Orders API', serviceKind: 'api' as const };
  const orders = { ...createNode({ type: 'database', x: 300, y: 0 }), id: 'orders', text: 'Orders', databaseKind: 'sql' as const };
  const topic = { ...createNode({ type: 'queue', x: 600, y: 0 }), id: 'topic', queueKind: 'topic' as const };
  const edge: DraftEdge = { id: 'e1', source: 'api', target: 'orders', directed: true, routing: 'smoothstep', semantic: 'writes' };
  const lookup = nodeLookupOf([api, orders, topic]);

  it('names a shape by what it is called and what it is', () => {
    expect(nodeReading(api)).toBe('Orders API, API service');
    expect(nodeReading(orders)).toBe('Orders, SQL data store');
    expect(kindReading(topic)).toBe('topic');
    expect(nodeReading(topic)).toBe('Topic, topic');
  });

  it('reads a connector as the sentence the canvas captions', () => {
    expect(connectorReading(edge, lookup)).toBe('Orders API writes to Orders');
    expect(connectorReading({ ...edge, label: 'saves order' }, lookup)).toBe('Orders API saves order Orders');
    expect(connectorReading({ ...edge, semantic: undefined }, lookup)).toBe('Orders API to Orders');
    expect(connectorReading({ ...edge, semantic: undefined, directed: false }, lookup)).toBe('Orders API and Orders');
  });

  it('announces a selection as one shape, one connector, or a count', () => {
    const document = { nodes: [api, orders, topic], edges: [edge] } as unknown as DraftDocument;
    const none = { nodes: [], edges: [] };
    expect(selectionAnnouncement(document, { nodes: ['api'], edges: [] }, none)).toBe('Orders API, API service, 1 connector');
    expect(selectionAnnouncement(document, { nodes: ['topic'], edges: [] }, none)).toBe('Topic, topic, 0 connectors');
    expect(selectionAnnouncement(document, { nodes: [], edges: ['e1'] }, none)).toBe('Orders API writes to Orders');
    expect(selectionAnnouncement(document, { nodes: ['api', 'orders'], edges: ['e1'] }, none)).toBe('3 elements selected');
    expect(selectionAnnouncement(document, none, { nodes: ['api'], edges: [] })).toBe('Selection cleared');
    expect(selectionAnnouncement(document, none, none)).toBeNull();
  });
});
