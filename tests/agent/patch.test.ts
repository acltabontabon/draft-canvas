import { describe, expect, it } from 'vitest';
import { compose } from '../../src/agent/compile';
import { AgentError } from '../../src/agent/errors';
import { applyUpdate } from '../../src/agent/patch';
import { readDiagram } from '../../src/agent/read';
import { createDocument, createEdge, createNode } from '../../src/document/factory';
import { viewOf } from '../../src/depth/tree';
import { deserializeDocument } from '../../src/export/project';
import type { DraftDocument } from '../../src/document/types';

function build(raw: Record<string, unknown>): DraftDocument {
  const parsed = deserializeDocument(compose({ title: 'T', ...raw }, 'd_patchtest00').text);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.document;
}

const base = () =>
  build({
    groups: [{ id: 'sys', label: 'Orders', kind: 'system' }],
    nodes: [
      { id: 'api', type: 'api', label: 'Orders API', group: 'sys' },
      { id: 'db', type: 'database', label: 'Orders DB', group: 'sys', technology: 'PostgreSQL' },
      { id: 'user', type: 'person', label: 'Customer' },
    ],
    relationships: [
      { id: 'u', from: 'user', to: 'api', label: 'Places orders' },
      { id: 'd', from: 'api', to: 'db' },
    ],
    flows: [{ id: 'f', title: 'Order', steps: ['u', 'd'] }],
    notes: [{ id: 'n1', text: 'Orders are idempotent by client key.', kind: 'decision', near: 'api' }],
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

describe('update_diagram operations', () => {
  it('adds beside what the new part connects to without moving anything that was there', () => {
    const file = base();
    const before = new Map(file.nodes.map((n) => [n.id, [n.x, n.y, n.width, n.height]]));
    const { file: next, touched } = applyUpdate(file, [], [{ op: 'add', nodes: [{ id: 'mail', type: 'worker', label: 'Mailer' }], relationships: [{ id: 'm', from: 'api', to: 'mail', label: 'Queues email' }] }], undefined);
    for (const [id, geometry] of before) {
      const n = next.nodes.find((x) => x.id === id)!;
      expect([n.x, n.y, n.width, n.height]).toEqual(geometry);
    }
    const mail = next.nodes.find((n) => n.id === 'mail')!;
    const sys = next.nodes.find((n) => n.id === 'sys')!;
    // Not a member, so not drawn inside the boundary either.
    expect(mail.parentId).toBeUndefined();
    expect(mail.x >= sys.x + sys.width || mail.x + mail.width <= sys.x || mail.y >= sys.y + sys.height || mail.y + mail.height <= sys.y).toBe(true);
    expect(touched.has('mail')).toBe(true);
  });

  it('grows the boundary a new member joins, and keeps flows, notes and actions it did not name', () => {
    const file = base();
    const sys = file.nodes.find((n) => n.id === 'sys')!;
    const { file: next } = applyUpdate(file, [], [{ op: 'add', nodes: [{ id: 'cache', type: 'cache', label: 'Session cache', group: 'sys' }], relationships: [{ id: 'c', from: 'api', to: 'cache' }] }], undefined);
    const grown = next.nodes.find((n) => n.id === 'sys')!;
    const cache = next.nodes.find((n) => n.id === 'cache')!;
    expect(cache.parentId).toBe('sys');
    expect(grown.width * grown.height).toBeGreaterThanOrEqual(sys.width * sys.height);
    expect(cache.x).toBeGreaterThanOrEqual(grown.x);
    expect(cache.x + cache.width).toBeLessThanOrEqual(grown.x + grown.width);
    expect(next.flows).toEqual(file.flows);
    expect(next.actions).toEqual(file.actions);
    expect(next.nodes.find((n) => n.id === 'n1')).toEqual(file.nodes.find((n) => n.id === 'n1'));
  });

  it('keeps omitted fields, clears with null', () => {
    const file = base();
    const { file: next } = applyUpdate(file, [], [{ op: 'update', id: 'db', set: { description: 'Every order, append-only.' } }], undefined);
    const db = next.nodes.find((n) => n.id === 'db')!;
    expect(db.technology).toBe('PostgreSQL');
    expect(db.description).toBe('Every order, append-only.');
    const { file: cleared } = applyUpdate(next, [], [{ op: 'update', id: 'db', set: { technology: null } }], undefined);
    expect(cleared.nodes.find((n) => n.id === 'db')!.technology).toBeUndefined();
  });

  it('removes an element with its connectors and flow steps; a boundary with members needs cascade', () => {
    const file = base();
    const { file: next } = applyUpdate(file, [], [{ op: 'remove', ids: ['db'] }], undefined);
    expect(next.edges.map((e) => e.id)).toEqual(['u']);
    expect(next.flows[0]?.steps.map((s) => s.edgeId)).toEqual(['u']);
    expect(refusal(() => applyUpdate(file, [], [{ op: 'remove', ids: ['sys'] }], undefined)).code).toBe('INVALID_INPUT');
    const { file: gone } = applyUpdate(file, [], [{ op: 'remove', ids: ['sys'], cascade: true }], undefined);
    expect(gone.nodes.map((n) => n.id).sort()).toEqual(['n1', 'user']);
  });

  it('refuses the whole batch when any op is wrong — nothing half-applied', () => {
    const file = base();
    const error = refusal(() =>
      applyUpdate(file, [], [
        { op: 'update', id: 'db', set: { technology: 'MySQL' } },
        { op: 'update', id: 'missing', set: { label: 'X' } },
      ], undefined),
    );
    expect(error.code).toBe('INVALID_REFERENCE');
    expect(file.nodes.find((n) => n.id === 'db')!.technology).toBe('PostgreSQL');
  });

  it('refuses a new id that is already used anywhere in the file', () => {
    expect(refusal(() => applyUpdate(base(), [], [{ op: 'add', nodes: [{ id: 'f', type: 'service', label: 'Clash with a flow id' }] }], undefined)).code).toBe('DUPLICATE_ID');
  });

  it('addresses the editor\'s own ids and edits inside a nested view', () => {
    const inner = createNode({ id: 'n_abc123def456', type: 'component', x: 0, y: 0, text: 'Ledger writer' });
    const owner = { ...createNode({ id: 'n_owner0000001', type: 'service', x: 0, y: 0, text: 'Payments' }), inside: { nodes: [inner], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 }, level: 'component' as const } };
    const other = createNode({ id: 'n_other0000001', type: 'database', x: 300, y: 0, text: 'Ledger' });
    const file: DraftDocument = { ...createDocument('Native'), nodes: [owner, other], edges: [createEdge({ id: 'e_native000001', source: owner.id, target: other.id })] };
    const { file: next } = applyUpdate(file, ['n_owner0000001'], [
      { op: 'update', id: 'n_abc123def456', set: { technology: 'Kotlin' } },
      { op: 'add', nodes: [{ id: 'validator', type: 'component', label: 'Validator' }], relationships: [{ id: 'v', from: 'validator', to: 'n_abc123def456' }] },
    ], undefined);
    const room = viewOf(next, ['n_owner0000001'])!;
    expect(room.nodes.find((n) => n.id === 'n_abc123def456')?.technology).toBe('Kotlin');
    expect(room.nodes.map((n) => n.id)).toContain('validator');
    expect(next.edges).toEqual(file.edges);
  });
});

describe('notes and flows through update_diagram', () => {
  const nodeIds = (doc: DraftDocument) => doc.nodes.map((n) => n.id);

  it('attaches a note natively to an element or a relationship, under the note\'s own id', () => {
    const { file: next, counts } = applyUpdate(
      base(),
      [],
      [{ op: 'add', notes: [{ id: 'why', text: 'Retries 5×, then parks.', about: 'api', attach: true }, { id: 'onEdge', text: 'Signed with HMAC.', kind: 'decision', about: 'd' }] }],
      undefined,
    );
    expect(next.nodes.find((n) => n.id === 'api')!.attachments?.map((a) => a.id)).toContain('why');
    expect(next.edges.find((e) => e.id === 'd')!.attachments?.[0]).toMatchObject({ id: 'onEdge', type: 'note', noteKind: 'decision' });
    expect(nodeIds(next)).not.toContain('why');
    expect(counts.added).toBe(2);
  });

  it('puts a note about a boundary inside it, and the boundary grows to hold it', () => {
    const file = base();
    const { file: next } = applyUpdate(file, [], [{ op: 'add', notes: [{ id: 'scope', text: 'Owned by the orders team.', about: 'sys' }] }], undefined);
    const note = next.nodes.find((n) => n.id === 'scope')!;
    const sys = next.nodes.find((n) => n.id === 'sys')!;
    expect(note.parentId).toBe('sys');
    expect(note.x >= sys.x && note.y >= sys.y && note.x + note.width <= sys.x + sys.width && note.y + note.height <= sys.y + sys.height).toBe(true);
  });

  it('refuses to attach a note to a boundary, and says so with the fix', () => {
    const error = refusal(() => applyUpdate(base(), [], [{ op: 'add', notes: [{ id: 'x', text: 'y', about: 'sys', attach: true }] }], undefined));
    expect(error.code).toBe('UNSUPPORTED');
    expect(error.message).toContain('leave attach out');
  });

  it('edits a note\'s text and kind in place, and moves it beside another element', () => {
    const { file: next } = applyUpdate(base(), [], [{ op: 'update', id: 'n1', set: { text: 'Idempotent by client key\nfor 24 h.', kind: 'warning', about: 'user' } }], undefined);
    const note = next.nodes.find((n) => n.id === 'n1')!;
    const user = next.nodes.find((n) => n.id === 'user')!;
    expect(note).toMatchObject({ text: 'Idempotent by client key\nfor 24 h.', noteKind: 'warning' });
    const gap = Math.max(user.x - (note.x + note.width), note.x - (user.x + user.width), user.y - (note.y + note.height), note.y - (user.y + user.height));
    expect(gap).toBeLessThan(200);
  });

  it('edits, moves and removes an attachment by its id', () => {
    const withNote = applyUpdate(base(), [], [{ op: 'add', notes: [{ id: 'why', text: 'first', about: 'api', attach: true }] }], undefined).file;
    const edited = applyUpdate(withNote, [], [{ op: 'update', id: 'why', set: { text: 'second', kind: 'question', about: 'db' } }], undefined).file;
    expect(edited.nodes.find((n) => n.id === 'api')!.attachments ?? []).toHaveLength(0);
    expect(edited.nodes.find((n) => n.id === 'db')!.attachments?.[0]).toMatchObject({ id: 'why', text: 'second', noteKind: 'question' });
    const removed = applyUpdate(edited, [], [{ op: 'remove', ids: ['why'] }], undefined).file;
    expect(removed.nodes.find((n) => n.id === 'db')!.attachments ?? []).toHaveLength(0);
  });

  it('renames a flow without touching its steps, and keeps each step\'s id and details when steps change', () => {
    const file = base();
    const flow = file.flows[0]!;
    // A person set a camera and extra highlights on the first step.
    file.flows[0] = { ...flow, steps: [{ ...flow.steps[0]!, caption: 'Customer orders', extraNodeIds: ['db'], viewport: { x: 1, y: 2, zoom: 1.5 } }, flow.steps[1]!] };
    const renamed = applyUpdate(file, [], [{ op: 'update', id: 'f', set: { title: 'Normal processing' } }], undefined).file.flows[0]!;
    expect(renamed.title).toBe('Normal processing');
    expect(renamed.steps).toEqual(file.flows[0]!.steps);
    const reordered = applyUpdate(file, [], [{ op: 'update', id: 'f', set: { steps: ['d', 'u'] } }], undefined).file.flows[0]!;
    expect(reordered.steps.map((s) => s.id)).toEqual([file.flows[0]!.steps[1]!.id, file.flows[0]!.steps[0]!.id]);
    expect(reordered.steps[1]).toMatchObject({ caption: 'Customer orders', extraNodeIds: ['db'], viewport: { x: 1, y: 2, zoom: 1.5 } });
    const cleared = applyUpdate(file, [], [{ op: 'update', id: 'f', set: { steps: [{ relationship: 'u', caption: null }] } }], undefined).file.flows[0]!;
    expect(cleared.steps).toHaveLength(1);
    expect(cleared.steps[0]!.caption).toBeUndefined();
  });

  it('keeps a frame step (no relationship) when the steps are sent back as read returns them', () => {
    const file = base();
    const flow = file.flows[0]!;
    file.flows[0] = { ...flow, steps: [{ id: 'f.frame', viewport: { x: 0, y: 0, zoom: 1 } }, ...flow.steps] };
    const read = readDiagram(file, {}, 'f:1', 'd').flows as { steps: unknown[] }[];
    expect(read[0]!.steps[0]).toEqual({ frame: 'f.frame' });
    const next = applyUpdate(file, [], [{ op: 'update', id: 'f', set: { steps: read[0]!.steps } }], undefined).file.flows[0]!;
    expect(next.steps).toEqual(file.flows[0]!.steps);
  });

  it('refuses a second flow with a title that is already there, naming the one to update', () => {
    const error = refusal(() => applyUpdate(base(), [], [{ op: 'add', flows: [{ id: 'g', title: ' order ', steps: ['u'] }] }], undefined));
    expect(error.code).toBe('DUPLICATE_FLOW');
    expect(error.message).toContain('"f"');
  });
});

describe('read_diagram', () => {
  it('is semantic and compact by default, with derived C4 detail', () => {
    const out = readDiagram(base(), {}, 'o:x.1', 'd_patchtest00');
    expect(out.elements).toContainEqual(expect.objectContaining({ id: 'db', type: 'database', technology: 'PostgreSQL', group: 'sys', c4: expect.objectContaining({ scope: 'internal', derived: true }) }));
    expect(JSON.stringify(out)).not.toContain('"x":');
    expect(out.actions).toEqual([{ id: 'act', text: 'Confirm retention with legal', about: 'db' }]);
    expect(out.partial).toBeUndefined();
  });

  it('marks a focused read partial and names the far ends of its relationships', () => {
    const out = readDiagram(base(), { focus: { nodes: ['db'] } }, 'o:x.1', 'd') as Record<string, unknown>;
    expect(out.partial).toBe(true);
    expect(out.outsideEndpoints).toEqual([{ id: 'api', type: 'api', label: 'Orders API' }]);
  });

  it('pages with a cursor bound to the revision it was read at', () => {
    const nodes = Array.from({ length: 250 }, (_, i) => ({ id: `s${i}`, type: 'service', label: `Service ${i}` }));
    const file = build({ nodes, layout: { spacing: 'compact' } });
    const first = readDiagram(file, {}, 'o:a.1', 'd') as Record<string, unknown>;
    expect(first.partial).toBe(true);
    expect(typeof first.cursor).toBe('string');
    const second = readDiagram(file, { cursor: first.cursor }, 'o:a.1', 'd') as Record<string, unknown>;
    expect((first.elements as unknown[]).length + (second.elements as unknown[]).length).toBe(250);
    expect(second.cursor).toBeUndefined();
    expect(refusal(() => readDiagram(file, { cursor: first.cursor }, 'o:a.2', 'd')).code).toBe('CURSOR_STALE');
  });
});
