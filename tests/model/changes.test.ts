import { describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../../src/document/factory';
import type { DraftDocument, DraftEdge, DraftNode } from '../../src/document/types';
import { architectureChanges, modelOf } from '../../src/model';

type NodeInput = Parameters<typeof createNode>[0];
type EdgeInput = Parameters<typeof createEdge>[0];

const at = { x: 0, y: 0 };
const service = (id: string, text: string, extra: Partial<NodeInput> = {}) => createNode({ id, type: 'service', text, ...at, ...extra });
const database = (id: string, text: string, extra: Partial<NodeInput> = {}) => createNode({ id, type: 'database', databaseKind: 'sql', text, ...at, ...extra });
const boundary = (id: string, text: string, extra: Partial<NodeInput> = {}) => createNode({ id, type: 'group', text, ...at, ...extra });
const edge = (id: string, source: string, target: string, extra: Partial<EdgeInput> = {}) => createEdge({ id, source, target, semantic: 'calls', semanticsOrigin: 'explicit', ...extra });
const file = (nodes: DraftNode[], edges: DraftEdge[] = []): DraftDocument => ({ ...createDocument('Shop'), nodes, edges });
const changes = (before: DraftDocument, after: DraftDocument) => architectureChanges(modelOf(before), modelOf(after)).map((change) => [change.kind, change.text]);

const base = () => [boundary('pay', 'Payments', { boundaryPreset: 'domain' }), service('api', 'Orders API'), service('billing', 'Billing', { parentId: 'pay' }), database('db', 'Orders DB')];
const wired = () => [edge('1', 'api', 'db', { semantic: 'writes' }), edge('2', 'api', 'billing')];

describe('architecture changes', () => {
  it('say nothing when a diagram is only rearranged or restyled', () => {
    const before = file(base(), wired());
    const after = file(
      base().map((node) => ({ ...node, x: node.x + 500, y: 90, accent: 'blue' as const })),
      wired().map((item) => ({ ...item, routing: 'straight' as const, label: 'renamed caption' })),
    );
    expect(changes(before, after)).toEqual([]);
  });

  it('say what was added and removed, and when a store gains a user', () => {
    const before = file(base(), wired());
    const after = file([...base().filter((node) => node.id !== 'billing'), service('audit', 'Audit', { serviceKind: 'worker', technology: 'Go' })], [wired()[0]!, edge('3', 'audit', 'db', { semantic: 'writes' })]);
    expect(changes(before, after)).toEqual([
      ['part-added', 'Added worker "Audit" (Go).'],
      ['part-removed', 'Removed service "Billing".'],
      ['relation-added', '"Audit" now has a relation to "Orders DB" (writes). "Orders DB" now has 2 users.'],
    ]);
  });

  it('say what a part or a relation now means', () => {
    const before = file(base(), wired());
    const after = file(
      base().map((node) => (node.id === 'api' ? { ...node, text: 'Order Service', serviceKind: 'gateway' as const, technology: 'Kong' } : node.id === 'pay' ? { ...node, boundaryPreset: 'system' as const } : node)),
      [edge('1', 'api', 'db', { semantic: 'reads' }), { ...edge('2', 'api', 'billing', { semantic: 'publishes' }), async: true }],
    );
    expect(changes(before, after)).toEqual([
      ['part-renamed', '"Orders API" is now called "Order Service".'],
      ['part-retyped', '"Order Service" changed from service to gateway.'],
      ['technology-changed', '"Order Service": technology set to Kong.'],
      ['boundary-retyped', '"Payments" changed from a domain boundary to a system boundary.'],
      ['relation-changed', 'The relation from "Order Service" to "Orders DB" changed from writes to reads.'],
      ['relation-changed', 'The relation from "Order Service" to "Billing" changed from calls to publishes and became asynchronous.'],
    ]);
  });

  it('say when a relation starts or stops crossing a boundary', () => {
    const before = file(base(), [edge('1', 'api', 'db')]);
    const moved = file(base().map((node) => (node.id === 'db' ? { ...node, parentId: 'pay' } : node)), [edge('1', 'api', 'db')]);
    expect(changes(before, moved)).toEqual([
      ['part-moved', '"Orders DB" moved into "Payments".'],
      ['crossing-added', 'The relation from "Orders API" to "Orders DB" now crosses "Payments".'],
    ]);
    expect(changes(moved, before).map(([kind]) => kind)).toEqual(['part-moved', 'crossing-removed']);
    const added = file(base(), [edge('1', 'api', 'db'), edge('9', 'api', 'billing')]);
    expect(changes(before, added).map(([kind]) => kind)).toEqual(['relation-added', 'crossing-added']);
  });

  it('reads a diagram drawn again with new ids as the same parts', () => {
    const before = file(base(), wired());
    const rename = (id: string) => `new-${id}`;
    const after = file(
      [...base().map((node) => ({ ...node, id: rename(node.id), ...(node.parentId ? { parentId: rename(node.parentId) } : {}) })), service('new-audit', 'Audit')],
      wired().map((item) => ({ ...item, id: rename(item.id), source: rename(item.source), target: rename(item.target) })),
    );
    expect(changes(before, after)).toEqual([['part-added', 'Added service "Audit".']]);
  });

  it('does not guess between two parts with the same name', () => {
    const before = file([service('a', 'Worker'), service('b', 'Worker')]);
    const after = file([service('c', 'Worker'), service('d', 'Worker')]);
    expect(changes(before, after).map(([kind]) => kind)).toEqual(['part-added', 'part-added', 'part-removed', 'part-removed']);
  });
});
