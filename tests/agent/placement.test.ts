import { describe, expect, it } from 'vitest';
import { compose } from '../../src/agent/compile';
import { AgentError } from '../../src/agent/errors';
import { applyUpdate } from '../../src/agent/patch';
import { readDiagram } from '../../src/agent/read';
import { validateToolInput } from '../../src/agent/contract';
import { deserializeDocument } from '../../src/export/project';
import type { DraftDocument } from '../../src/document/types';

function build(raw: Record<string, unknown>): DraftDocument {
  const parsed = deserializeDocument(compose({ title: 'T', ...raw }, 'd_placetest00').text);
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

const node = (file: DraftDocument, id: string) => file.nodes.find((n) => n.id === id)!;
const edge = (file: DraftDocument, id: string) => file.edges.find((e) => e.id === id)!;

const three = () =>
  build({
    nodes: [
      { id: 'web', type: 'service', label: 'Web' },
      { id: 'api', type: 'api', label: 'Orders API' },
      { id: 'db', type: 'database', label: 'Orders DB' },
    ],
    relationships: [
      { id: 'w', from: 'web', to: 'api' },
      { id: 'd', from: 'api', to: 'db' },
    ],
  });

describe('explicit placement on create', () => {
  it('puts an element at the exact top-left it was given, and beside another one', () => {
    const file = build({
      nodes: [
        { id: 'a', type: 'service', label: 'A', place: { x: 1000, y: 400 } },
        { id: 'b', type: 'service', label: 'B', place: { below: 'a', gap: 80, align: 'start' } },
        { id: 'c', type: 'service', label: 'C' },
      ],
      relationships: [{ id: 'ab', from: 'a', to: 'b' }, { id: 'bc', from: 'b', to: 'c' }],
    });
    const a = node(file, 'a');
    const b = node(file, 'b');
    expect([a.x, a.y]).toEqual([1000, 400]);
    expect(b.x).toBe(a.x);
    expect(b.y).toBe(a.y + a.height + 80);
  });

  it('sizes a shape as asked, but never below what its text needs', () => {
    const file = build({ nodes: [{ id: 'a', type: 'service', label: 'Payments Orchestrator', place: { width: 400, height: 30 } }], relationships: [] });
    const a = node(file, 'a');
    expect(a.width).toBe(400);
    expect(a.height).toBeGreaterThan(30);
  });

  it('routes a relationship through its bends and on the sides it names', () => {
    const file = build({
      nodes: [
        { id: 'a', type: 'service', label: 'A', place: { x: 0, y: 0 } },
        { id: 'b', type: 'service', label: 'B', place: { x: 400, y: 0 } },
      ],
      relationships: [{ id: 'ab', from: 'a', to: 'b', route: { from: 'top', to: 'top', via: [[100, -80], [480, -80]] } }],
    });
    const ab = edge(file, 'ab');
    expect(ab.sourceAnchor?.side).toBe('top');
    expect(ab.targetAnchor?.side).toBe('top');
    expect(ab.waypoints).toEqual([{ x: 100, y: -80 }, { x: 480, y: -80 }]);
    const read = readDiagram(file, { include: ['geometry'] }, 'r:1', 'd') as { relationships: { id: string; geometry: { from: string; to: string; path: number[][]; via: number[][] } }[] };
    const geometry = read.relationships.find((r) => r.id === 'ab')!.geometry;
    expect(geometry.from).toBe('top');
    expect(geometry.via).toEqual([[100, -80], [480, -80]]);
    // The drawn path runs along y = -80 past x = 100: a bend on a straight run is passed through.
    const runs = geometry.path.slice(1).map((p, i) => [geometry.path[i]!, p] as const);
    expect(runs.some(([p, q]) => p[1] === -80 && q[1] === -80 && Math.min(p[0]!, q[0]!) <= 100 && Math.max(p[0]!, q[0]!) >= 100)).toBe(true);
  });

  it('refuses overlapping shapes it was asked to place', () => {
    const error = refusal(() =>
      build({
        nodes: [
          { id: 'a', type: 'service', label: 'A', place: { x: 0, y: 0 } },
          { id: 'b', type: 'service', label: 'B', place: { x: 20, y: 10 } },
        ],
        relationships: [],
      }),
    );
    expect(error.code).toBe('LAYOUT_FAILED');
  });

  it('refuses a placement loop or an unknown neighbour by name', () => {
    expect(
      refusal(() =>
        build({
          nodes: [
            { id: 'a', type: 'service', label: 'A', place: { rightOf: 'b' } },
            { id: 'b', type: 'service', label: 'B', place: { rightOf: 'a' } },
          ],
          relationships: [],
        }),
      ).message,
    ).toMatch(/loop/);
    expect(refusal(() => build({ nodes: [{ id: 'a', type: 'service', label: 'A', place: { rightOf: 'zz' } }], relationships: [] })).code).toBe('INVALID_REFERENCE');
    expect(refusal(() => build({ nodes: [{ id: 'a', type: 'service', label: 'A', place: { rightOf: 'b', below: 'b' } }], relationships: [] })).code).toBe('INVALID_INPUT');
  });
});

describe('explicit placement on update', () => {
  it('moves an existing element exactly, carrying a note beside it', () => {
    const file = build({
      nodes: [
        { id: 'web', type: 'service', label: 'Web' },
        { id: 'api', type: 'api', label: 'Orders API' },
      ],
      relationships: [{ id: 'w', from: 'web', to: 'api' }],
      notes: [{ id: 'n', text: 'Idempotent by key.', about: 'api', attach: false }],
    });
    const api = node(file, 'api');
    const note = node(file, 'n');
    const { file: next, quality } = applyUpdate(file, [], [{ op: 'update', id: 'api', set: { place: { x: api.x + 200, y: api.y + 300 } } }], undefined);
    expect([node(next, 'api').x, node(next, 'api').y]).toEqual([api.x + 200, api.y + 300]);
    expect([node(next, 'n').x, node(next, 'n').y]).toEqual([note.x + 200, note.y + 300]);
    expect(quality.errors).toEqual([]);
  });

  it('moves a group with everything in it', () => {
    const file = build({
      groups: [{ id: 'sys', label: 'Orders', kind: 'system' }],
      nodes: [
        { id: 'api', type: 'api', label: 'Orders API', group: 'sys' },
        { id: 'db', type: 'database', label: 'Orders DB', group: 'sys' },
      ],
      relationships: [{ id: 'd', from: 'api', to: 'db' }],
    });
    const before = new Map(file.nodes.map((n) => [n.id, n]));
    const { file: next } = applyUpdate(file, [], [{ op: 'update', id: 'sys', set: { place: { x: before.get('sys')!.x + 500 } } }], undefined);
    for (const id of ['sys', 'api', 'db']) expect(node(next, id).x).toBe(before.get(id)!.x + 500);
  });

  it('places a new element beside an existing one', () => {
    const file = three();
    const db = node(file, 'db');
    const { file: next } = applyUpdate(file, [], [{ op: 'add', nodes: [{ id: 'cache', type: 'cache', label: 'Cache', place: { below: 'db', gap: 60 } }], relationships: [{ id: 'c', from: 'api', to: 'cache' }] }], undefined);
    expect(node(next, 'cache').y).toBe(Math.round(db.y + db.height + 60));
  });

  it('bends a connector by hand and hands it back to automatic', () => {
    const file = three();
    const { file: bent } = applyUpdate(file, [], [{ op: 'update', id: 'w', set: { route: { from: 'bottom', via: [[0, 500], [600, 500]] } } }], undefined);
    expect(edge(bent, 'w').waypoints).toEqual([{ x: 0, y: 500 }, { x: 600, y: 500 }]);
    expect(edge(bent, 'w').sourceAnchor?.side).toBe('bottom');
    const { file: back } = applyUpdate(bent, [], [{ op: 'update', id: 'w', set: { route: null } }], undefined);
    expect(edge(back, 'w').waypoints).toBeUndefined();
    expect(edge(back, 'w').sourceAnchor).toEqual(edge(file, 'w').sourceAnchor);
  });

  it('reports a line problem on a hand route instead of refusing it, but still refuses an overlap', () => {
    const file = three();
    const api = node(file, 'api');
    // Straight through the middle of the API: a line drawn through a shape it has nothing to do with.
    const through = applyUpdate(file, [], [{ op: 'update', id: 'd', set: { route: { via: [[api.x - 400, api.y + api.height / 2]] } } }], undefined);
    // A line through the API from its own connector isn't the case here — route `w` through the DB.
    const db = node(file, 'db');
    const crossed = applyUpdate(file, [], [{ op: 'update', id: 'w', set: { route: { via: [[db.x + db.width / 2, db.y - 60], [db.x + db.width / 2, db.y + db.height + 60]] } } }], undefined);
    expect(crossed.quality.errors.filter((e) => e.kind === 'through-node')).toEqual([]);
    expect(crossed.quality.warnings.some((w) => w.kind === 'through-node' && w.ids.includes('w'))).toBe(true);
    expect(through.quality.errors.filter((e) => e.ids.includes('d') && e.kind === 'through-node')).toEqual([]);
    const overlap = applyUpdate(file, [], [{ op: 'update', id: 'web', set: { place: { x: api.x + 10, y: api.y + 10 } } }], undefined);
    expect(overlap.quality.errors.some((e) => e.kind === 'overlap')).toBe(true);
  });

  it('is in the published schema for create and update', () => {
    expect(() =>
      validateToolInput('update_diagram', {
        requestId: 'r1',
        diagramId: 'd',
        expectedRevision: 'x',
        ops: [
          { op: 'update', id: 'api', set: { place: { rightOf: 'web', gap: 40, align: 'center' } } },
          { op: 'update', id: 'w', set: { route: { from: 'right', to: 'left', via: [[10, 20]] } } },
          { op: 'update', id: 'd', set: { route: null } },
        ],
      }),
    ).not.toThrow();
    expect(() =>
      validateToolInput('create_diagram', {
        requestId: 'r2',
        title: 'T',
        nodes: [{ id: 'a', type: 'service', label: 'A', place: { x: 0, y: 0 } }],
        relationships: [{ id: 'r', from: 'a', to: 'a', route: { via: [[1, 2]] } }],
      }),
    ).not.toThrow();
  });
});
