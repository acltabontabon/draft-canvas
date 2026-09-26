import { describe, expect, it } from 'vitest';
import { compose } from '../../src/agent/compile';
import { AgentError } from '../../src/agent/errors';
import { applyUpdate } from '../../src/agent/patch';
import { deserializeDocument } from '../../src/export/project';
import type { DraftDocument } from '../../src/document/types';

function build(raw: Record<string, unknown>): DraftDocument {
  const parsed = deserializeDocument(compose({ title: 'T', ...raw }, 'd_scopetest00').text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
}

const base = () =>
  build({
    groups: [{ id: 'sys', label: 'Orders', kind: 'system' }],
    nodes: [
      { id: 'api', type: 'api', label: 'Orders API', group: 'sys' },
      { id: 'db', type: 'database', label: 'Orders DB', group: 'sys' },
      { id: 'user', type: 'person', label: 'Customer' },
    ],
    relationships: [
      { id: 'u', from: 'user', to: 'api', label: 'Places orders' },
      { id: 'd', from: 'api', to: 'db' },
    ],
    flows: [{ id: 'f', title: 'Order', steps: ['u', 'd'] }],
    actions: [{ id: 'act', text: 'Confirm retention with legal', about: 'db' }],
  });

const refusal = (run: () => unknown): AgentError => {
  try {
    run();
  } catch (error) {
    if (error instanceof AgentError) return error;
    throw error;
  }
  throw new Error('expected a refusal');
};

describe('update_diagram scope enforcement', () => {
  it('refuses to update an id outside the captured scope', () => {
    const file = base();
    const error = refusal(() => applyUpdate(file, [], [{ op: 'update', id: 'db', set: { label: 'New name' } }], undefined, { nodes: ['api'], edges: [] }));
    expect(error.code).toBe('OUT_OF_SCOPE');
  });

  it('permits an update to an id inside the captured scope', () => {
    const file = base();
    const { file: next } = applyUpdate(file, [], [{ op: 'update', id: 'api', set: { label: 'Renamed' } }], undefined, { nodes: ['api'], edges: [] });
    expect(next.nodes.find((n) => n.id === 'api')?.text).toBe('Renamed');
  });

  it('refuses to remove an id outside the captured scope', () => {
    const file = base();
    const error = refusal(() => applyUpdate(file, [], [{ op: 'remove', ids: ['db'] }], undefined, { nodes: ['api'], edges: [] }));
    expect(error.code).toBe('OUT_OF_SCOPE');
  });

  it('permits an add that connects a new element to something outside scope (the boundary-connection carve-out)', () => {
    const file = base();
    const { file: next } = applyUpdate(
      file,
      [],
      [{ op: 'add', nodes: [{ id: 'mail', type: 'worker', label: 'Mailer' }], relationships: [{ id: 'm', from: 'db', to: 'mail', label: 'Notifies' }] }],
      undefined,
      { nodes: ['api'], edges: [] },
    );
    expect(next.nodes.some((n) => n.id === 'mail')).toBe(true);
    expect(next.edges.some((e) => e.id === 'm' && e.source === 'db')).toBe(true);
  });

  it('refuses a cascade that would reach a child outside the captured scope', () => {
    const file = base();
    const error = refusal(() => applyUpdate(file, [], [{ op: 'remove', ids: ['sys'], cascade: true }], undefined, { nodes: ['sys', 'api'], edges: [] }));
    expect(error.code).toBe('OUT_OF_SCOPE');
    expect(error.details?.problems).toBeDefined();
  });

  it('permits a cascade whose full descendant set is inside the captured scope', () => {
    const file = base();
    const { file: next } = applyUpdate(file, [], [{ op: 'remove', ids: ['sys'], cascade: true }], undefined, { nodes: ['sys', 'api', 'db'], edges: [] });
    expect(next.nodes.some((n) => n.id === 'sys')).toBe(false);
    expect(next.nodes.some((n) => n.id === 'api')).toBe(false);
  });

  it('refuses a bare (whole-view) arrange while a scope is active', () => {
    const file = base();
    const error = refusal(() => applyUpdate(file, [], [{ op: 'arrange' }], undefined, { nodes: ['api'], edges: [] }));
    expect(error.code).toBe('OUT_OF_SCOPE');
  });

  it("refuses an arrange whose own scope reaches outside the captured scope", () => {
    const file = base();
    const error = refusal(() => applyUpdate(file, [], [{ op: 'arrange', scope: { group: 'sys' } }], undefined, { nodes: ['api'], edges: [] }));
    expect(error.code).toBe('OUT_OF_SCOPE');
  });

  it('permits an arrange whose own scope is a subset of the captured scope', () => {
    const file = base();
    const { file: next } = applyUpdate(file, [], [{ op: 'arrange', scope: { nodes: ['api'] } }], undefined, { nodes: ['api', 'db'], edges: [] });
    expect(next).toBeDefined();
  });

  it('refuses when the captured scope names an id no longer in the view', () => {
    const file = base();
    const error = refusal(() => applyUpdate(file, [], [{ op: 'update', id: 'api', set: { label: 'x' } }], undefined, { nodes: ['api', 'deleted-node'], edges: [] }));
    expect(error.code).toBe('SCOPE_TARGET_MISSING');
  });

  it('is a no-op restriction when no scope is passed at all', () => {
    const file = base();
    const { file: next } = applyUpdate(file, [], [{ op: 'update', id: 'db', set: { label: 'Renamed' } }], undefined, undefined);
    expect(next.nodes.find((n) => n.id === 'db')?.text).toBe('Renamed');
  });

  // `read_selection` never returns flow or action ids, so a captured scope can never contain one —
  // any request that restricts itself to a selection is, by construction, reaching outside it if it
  // touches either. See docs/reference/agent-integration.md#selection-aware-editing.
  it('refuses to update a flow while a scope is active, even one that names no flow at all', () => {
    const file = base();
    const error = refusal(() => applyUpdate(file, [], [{ op: 'update', id: 'f', set: { title: 'Renamed' } }], undefined, { nodes: ['api', 'db'], edges: ['u', 'd'] }));
    expect(error.code).toBe('OUT_OF_SCOPE');
  });

  it('refuses to remove a flow while a scope is active', () => {
    const file = base();
    const error = refusal(() => applyUpdate(file, [], [{ op: 'remove', ids: ['f'] }], undefined, { nodes: ['api', 'db'], edges: ['u', 'd'] }));
    expect(error.code).toBe('OUT_OF_SCOPE');
  });

  it('refuses to update an action while a scope is active', () => {
    const file = base();
    const error = refusal(() => applyUpdate(file, [], [{ op: 'update', id: 'act', set: { done: true } }], undefined, { nodes: ['api', 'db'], edges: ['u', 'd'] }));
    expect(error.code).toBe('OUT_OF_SCOPE');
  });

  it('refuses to remove an action while a scope is active', () => {
    const file = base();
    const error = refusal(() => applyUpdate(file, [], [{ op: 'remove', ids: ['act'] }], undefined, { nodes: ['api', 'db'], edges: ['u', 'd'] }));
    expect(error.code).toBe('OUT_OF_SCOPE');
  });

  it('permits updating a flow and an action when no scope is passed at all', () => {
    const file = base();
    const { file: next } = applyUpdate(file, [], [{ op: 'update', id: 'f', set: { title: 'Renamed' } }, { op: 'update', id: 'act', set: { done: true } }], undefined, undefined);
    expect(next.flows.find((f) => f.id === 'f')?.title).toBe('Renamed');
    expect(next.actions.find((a) => a.id === 'act')?.done).toBe(true);
  });
});
