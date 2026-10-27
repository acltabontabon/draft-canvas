import { describe, expect, it } from 'vitest';
import { compose } from '../../src/agent/compile';
import { AgentError } from '../../src/agent/errors';
import { applyUpdate } from '../../src/agent/patch';
import { readDiagram } from '../../src/agent/read';
import { readSelectionContext } from '../../src/agent/selection';
import { runJob } from '../../src/agent/jobs';
import { viewOf } from '../../src/depth/tree';
import { capabilityFor, categoryOf } from '../../src/document/connectorSemantics';
import { CONNECTOR_KINDS, type DraftDocument } from '../../src/document/types';
import { deserializeDocument } from '../../src/export/project';

function build(raw: Record<string, unknown>): DraftDocument {
  const parsed = deserializeDocument(compose({ title: 'T', ...raw }, 'd_paritytest0').text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
}

const refusal = (run: () => unknown): AgentError => {
  try {
    run();
  } catch (error) {
    if (error instanceof AgentError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

const base = () =>
  build({
    level: 'context',
    groups: [{ id: 'sys', label: 'Orders', kind: 'system', color: 'violet' }],
    nodes: [
      { id: 'api', type: 'api', label: 'Orders API', group: 'sys', color: 'teal', inside: { nodes: [{ id: 'h', type: 'component', label: 'Handler' }] } },
      { id: 'billing', type: 'service', label: 'Billing' },
      { id: 'db', type: 'database', label: 'Orders DB', group: 'sys' },
    ],
    relationships: [
      { id: 'd', from: 'api', to: 'db' },
      { id: 'b', from: 'api', to: 'billing' },
    ],
    notes: [
      { id: 'free', text: 'Idempotent by client key.', about: 'api', attach: false, color: 'amber' },
      { id: 'chip', text: 'Retries twice.', about: 'billing', color: 'rose' },
    ],
  });

describe('parity with what a person sets by hand', () => {
  it('gives a boundary and a note their colour on create, and reads every colour back', () => {
    const file = base();
    expect(file.nodes.find((n) => n.id === 'sys')?.accent).toBe('violet');
    expect(file.nodes.find((n) => n.id === 'free')?.accent).toBe('amber');
    expect(file.nodes.find((n) => n.id === 'billing')?.attachments?.[0]).toMatchObject({ id: 'chip', accent: 'rose' });
    const read = readDiagram(file, {}, 'r1', 'd') as { elements: Record<string, unknown>[]; groups: Record<string, unknown>[]; notes: Record<string, unknown>[] };
    expect(read.elements.find((e) => e.id === 'api')).toMatchObject({ color: 'teal' });
    expect(read.groups.find((g) => g.id === 'sys')).toMatchObject({ color: 'violet' });
    expect(read.notes.find((n) => n.id === 'free')).toMatchObject({ color: 'amber' });
  });

  it('gives a boundary added by an update its colour', () => {
    const { file } = applyUpdate(base(), [], [{ op: 'add', groups: [{ id: 'ext', label: 'Partners', kind: 'group', color: 'green' }], nodes: [{ id: 'psp', type: 'external-system', label: 'PSP', group: 'ext' }], relationships: [{ id: 'p', from: 'billing', to: 'psp' }] }], undefined);
    expect(file.nodes.find((n) => n.id === 'ext')?.accent).toBe('green');
  });

  it('reads a selection with the colour and C4 scope read_diagram gives it', () => {
    const file = base();
    const selection = readSelectionContext(file, [], { nodes: ['db'], edges: [] }, 'r1', 'd') as { elements: Record<string, unknown>[] };
    const read = readDiagram(file, {}, 'r1', 'd') as { elements: Record<string, unknown>[] };
    const selected = selection.elements.find((e) => e.id === 'db') as { c4: unknown };
    expect(selected.c4).toEqual(read.elements.find((e) => e.id === 'db')?.c4);
    expect((selected.c4 as { scope: string }).scope).toBe('internal');
    const api = readSelectionContext(file, [], { nodes: ['api'], edges: [] }, 'r1', 'd') as { elements: Record<string, unknown>[] };
    expect(api.elements[0]).toMatchObject({ color: 'teal' });
  });
});

describe('update_diagram correctness', () => {
  it('refuses an added relationship beside an ordinary one already running the same way', () => {
    const error = refusal(() => applyUpdate(base(), [], [{ op: 'add', relationships: [{ id: 'd2', from: 'api', to: 'db', label: 'Reads' }] }], undefined));
    expect(error.code).toBe('UNSUPPORTED');
    expect(error.message).toContain('already runs from "api" to "db"');
    // The reverse direction is a different line, and a saga's undo may sit beside its step.
    expect(() => applyUpdate(base(), [], [{ op: 'add', relationships: [{ id: 'back', from: 'db', to: 'api' }] }], undefined)).not.toThrow();
    expect(() => applyUpdate(base(), [], [{ op: 'add', relationships: [{ id: 'undo', from: 'api', to: 'billing', semantic: 'compensates', compensationFor: 'b' }] }], undefined)).not.toThrow();
  });

  it('adds a new boundary inside an existing one, which grows to hold it', () => {
    const { file, quality } = applyUpdate(base(), [], [{ op: 'add', groups: [{ id: 'pay', label: 'Payments', kind: 'domain', parent: 'sys' }], nodes: [{ id: 'ledger', type: 'service', label: 'Ledger', group: 'pay' }], relationships: [{ id: 'l', from: 'billing', to: 'ledger' }] }], undefined);
    expect(quality.errors).toEqual([]);
    const at = (id: string) => file.nodes.find((n) => n.id === id)!;
    const inside = (inner: { x: number; y: number; width: number; height: number }, outer: typeof inner) =>
      inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
    expect(at('pay').parentId).toBe('sys');
    expect(at('ledger').parentId).toBe('pay');
    expect(inside(at('pay'), at('sys'))).toBe(true);
    expect(inside(at('ledger'), at('pay'))).toBe(true);
  });

  it('makes an inside view non-C4 when its outer view would hand it a level', () => {
    const file = base();
    expect((readDiagram(file, { view: { inside: ['api'] } }, 'r', 'd') as { view: { level: unknown } }).view.level).toBe('container');
    const { file: cleared } = applyUpdate(file, ['api'], [{ op: 'setLevel', level: null }], undefined);
    expect(viewOf(cleared, ['api'])?.level).toBe('none');
    expect((readDiagram(cleared, { view: { inside: ['api'] } }, 'r', 'd') as { view: { level: unknown } }).view.level).toBeNull();
    // At the top there is nothing to inherit: the field just goes.
    const { file: top } = applyUpdate(file, [], [{ op: 'setLevel', level: null }], undefined);
    expect(top.level).toBeUndefined();
  });

  it('refuses an arrange scope naming both a group and nodes instead of dropping the nodes', () => {
    const error = refusal(() => applyUpdate(base(), [], [{ op: 'arrange', scope: { group: 'sys', nodes: ['billing'] } }], undefined));
    expect(error.code).toBe('INVALID_INPUT');
    expect(error.message).toContain('/ops/0/scope');
  });

  it('answers unchanged for a level the view already has', () => {
    const result = runJob({ kind: 'update', file: base(), path: [], ops: [{ op: 'setLevel', level: 'context' }], layout: undefined }, performance.now() + 5_000);
    expect(result).toMatchObject({ kind: 'update', unchanged: true, counts: { updated: 0 } });
  });

  it('holds a renamed boundary to the length a new one may have', () => {
    expect(refusal(() => applyUpdate(base(), [], [{ op: 'update', id: 'sys', set: { label: 'x'.repeat(81) } }], undefined)).code).toBe('LIMIT_EXCEEDED');
    const { file } = applyUpdate(base(), [], [{ op: 'update', id: 'sys', set: { label: 'Order\nplatform' } }], undefined);
    expect(file.nodes.find((n) => n.id === 'sys')?.text).toBe('Order platform');
  });

  it('hands a direct-routed connector back to Smart Routing with route: null', () => {
    const file = base();
    const direct = { ...file, edges: file.edges.map((e) => (e.id === 'b' ? { ...e, routeMode: 'direct' as const, waypoints: [{ x: 1, y: 2 }] } : e)) };
    const { file: next } = applyUpdate(direct, [], [{ op: 'update', id: 'b', set: { route: null } }], undefined);
    const edge = next.edges.find((e) => e.id === 'b')!;
    expect(edge.routeMode).toBeUndefined();
    expect(edge.waypoints).toBeUndefined();
  });

  it('refuses a behaviour the pairing does not offer, as a new relationship would not keep it', () => {
    const file = base();
    const byId = new Map(file.nodes.map((n) => [n.id, n]));
    const offered = capabilityFor(categoryOf(byId.get('api')!), categoryOf(byId.get('billing')!))!;
    expect(offered.behaviors.length).toBeGreaterThan(0);
    const missing = CONNECTOR_KINDS.find((kind) => !offered.behaviors.includes(kind))!;
    expect(refusal(() => applyUpdate(file, [], [{ op: 'update', id: 'b', set: { kind: missing } }], undefined)).code).toBe('UNSUPPORTED');
    const { file: next } = applyUpdate(file, [], [{ op: 'update', id: 'b', set: { kind: offered.behaviors[0] } }], undefined);
    expect(next.edges.find((e) => e.id === 'b')?.kind).toBe(offered.behaviors[0]);
  });
});
