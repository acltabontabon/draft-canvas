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

const base = ({ flow = true } = {}) =>
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
    ...(flow ? { flows: [{ id: 'f', title: 'Order', steps: ['u', 'd'] }] } : {}),
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

  it('permits a cascade whose full descendant set — and every connector it takes — is inside the captured scope', () => {
    const file = base({ flow: false });
    const { file: next } = applyUpdate(file, [], [{ op: 'remove', ids: ['sys'], cascade: true }], undefined, { nodes: ['sys', 'api', 'db'], edges: ['u', 'd'] });
    expect(next.nodes.some((n) => n.id === 'sys')).toBe(false);
    expect(next.nodes.some((n) => n.id === 'api')).toBe(false);
  });

  it('refuses a remove whose connector cascade reaches outside the captured scope', () => {
    const file = base({ flow: false });
    // `u` runs from the customer to the API: removing the API alone would take it too.
    const error = refusal(() => applyUpdate(file, [], [{ op: 'remove', ids: ['api'] }], undefined, { nodes: ['api', 'db'], edges: ['d'] }));
    expect(error.code).toBe('OUT_OF_SCOPE');
    expect(error.message).toContain('"u" is outside the captured selection');
  });

  it('refuses a remove that would trim a flow, which is never in a captured scope', () => {
    const file = base();
    const error = refusal(() => applyUpdate(file, [], [{ op: 'remove', ids: ['d'] }], undefined, { nodes: ['api', 'db'], edges: ['u', 'd'] }));
    expect(error.code).toBe('OUT_OF_SCOPE');
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

  it('permits updating a flow when no scope is passed at all', () => {
    const file = base();
    const { file: next } = applyUpdate(file, [], [{ op: 'update', id: 'f', set: { title: 'Renamed' } }], undefined, undefined);
    expect(next.flows.find((f) => f.id === 'f')?.title).toBe('Renamed');
  });
});

describe('update_diagram scope and what a change carries along', () => {
  const junctions = () =>
    build({
      nodes: [
        { id: 'web', type: 'service', label: 'Web' },
        { id: 'out', type: 'junction', label: 'A', link: 'handoff' },
        { id: 'back', type: 'junction', label: 'A', link: 'handoff' },
        {
          id: 'api', type: 'service', label: 'API',
          inside: { nodes: [{ id: 'in', type: 'junction', label: 'A', link: 'handoff' }, { id: 'ctl', type: 'component', label: 'Controller' }], relationships: [{ id: 'r2', from: 'in', to: 'ctl' }] },
        },
      ],
      relationships: [{ id: 'r1', from: 'web', to: 'out' }, { id: 'r3', from: 'back', to: 'api' }],
    });

  it('refuses a linked-junction rename that reaches junctions outside the scope, in this view and another', () => {
    const error = refusal(() => applyUpdate(junctions(), [], [{ op: 'update', id: 'out', set: { label: 'Payments' } }], undefined, { nodes: ['out'], edges: [] }));
    expect(error.code).toBe('OUT_OF_SCOPE');
    expect(error.message).toContain('"back"');
    expect(JSON.stringify(error.details)).toContain('\\"in\\" (inside api)');
    // A scope can't hold a junction drawn in another view, so only an unscoped change renames the group.
    const free = applyUpdate(junctions(), [], [{ op: 'update', id: 'out', set: { label: 'Payments' } }], undefined).file;
    expect(free.nodes.find((n) => n.id === 'back')?.text).toBe('Payments');
  });

  it('refuses a retype that re-infers a connector outside the scope, and takes one inside it', () => {
    const file = build({ nodes: [{ id: 'a', type: 'service', label: 'A' }, { id: 'b', type: 'database', label: 'B' }], relationships: [{ id: 'w', from: 'a', to: 'b' }] });
    const retype = [{ op: 'update', id: 'b', set: { type: 'cache' } }];
    const error = refusal(() => applyUpdate(file, [], retype, undefined, { nodes: ['b'], edges: [] }));
    expect(error.code).toBe('OUT_OF_SCOPE');
    expect(error.message).toContain('"w"');
    const { file: next } = applyUpdate(file, [], retype, undefined, { nodes: ['b'], edges: ['w'] });
    expect(next.edges.find((e) => e.id === 'w')?.semantic).toBe('reads');
  });

  it('lets a boundary outside the scope grow to hold a shape moved into it: only where it is drawn changes', () => {
    const file = base({ flow: false });
    const { file: next } = applyUpdate(file, [], [{ op: 'update', id: 'user', set: { group: 'sys' } }], undefined, { nodes: ['user'], edges: [] });
    const was = file.nodes.find((n) => n.id === 'sys')!;
    const now = next.nodes.find((n) => n.id === 'sys')!;
    expect(next.nodes.find((n) => n.id === 'user')?.parentId).toBe('sys');
    expect(now.width * now.height).toBeGreaterThan(was.width * was.height);
    expect({ ...now, x: 0, y: 0, width: 0, height: 0 }).toEqual({ ...was, x: 0, y: 0, width: 0, height: 0 });
  });

  it('still permits an add that attaches a note to a shape outside the scope', () => {
    const file = base();
    const { file: next } = applyUpdate(file, [], [{ op: 'add', notes: [{ id: 'why', text: 'Keeps every order.', about: 'db' }] }], undefined, { nodes: ['api'], edges: [] });
    expect(next.nodes.find((n) => n.id === 'db')?.attachments?.map((a) => a.id)).toEqual(['why']);
  });
});

describe('update_diagram and what the person set', () => {
  const held = (file: DraftDocument, id: string): DraftDocument => ({ ...file, nodes: file.nodes.map((n) => (n.id === id ? { ...n, held: true } : n)) });
  const at = (file: DraftDocument, id: string) => {
    const node = file.nodes.find((n) => n.id === id)!;
    return { x: node.x, y: node.y, width: node.width, height: node.height };
  };

  it('arranges around a shape held in place', () => {
    const start = base({ flow: false });
    // Somewhere no arrangement would put it, so staying there is the hold and not a coincidence.
    const file = held({ ...start, nodes: start.nodes.map((n) => (n.id === 'user' ? { ...n, x: n.x + 900, y: n.y + 700 } : n)) }, 'user');
    const { file: next } = applyUpdate(file, [], [{ op: 'arrange' }], undefined);
    expect(at(next, 'user')).toEqual(at(file, 'user'));
    const free = applyUpdate({ ...file, nodes: file.nodes.map((n) => ({ ...n, held: undefined })) }, [], [{ op: 'arrange' }], undefined).file;
    expect(at(free, 'user')).not.toEqual(at(file, 'user'));
  });

  it('keeps a kind the agent names when the technology changes afterwards', () => {
    const file = build({ nodes: [{ id: 'edge', type: 'service', label: 'Edge', technology: 'NGINX' }] });
    expect(file.nodes[0]).toMatchObject({ serviceKind: 'proxy', kindOrigin: 'technology' });
    const named = applyUpdate(file, [], [{ op: 'update', id: 'edge', set: { type: 'gateway' } }], undefined).file;
    expect(named.nodes[0]).toMatchObject({ serviceKind: 'gateway' });
    expect(named.nodes[0]!.kindOrigin).toBeUndefined();
    const later = applyUpdate(named, [], [{ op: 'update', id: 'edge', set: { technology: 'NGINX 1.27' } }], undefined).file;
    expect(later.nodes[0]).toMatchObject({ serviceKind: 'gateway' });
  });
});
