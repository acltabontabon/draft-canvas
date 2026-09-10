import { describe, expect, it } from 'vitest';
import { createEdge, createNode } from '../src/document/factory';
import {
  SHAPE_MAX_EDGES,
  SHAPE_MAX_NODES,
  isLibraryShape,
  libraryShapeOf,
  shapeKindOf,
} from '../src/document/shape';
import { SHAPE_VERSION, type DraftNode, type ShapeKind } from '../src/document/types';

/**
 * The library fingerprint is written into the plaintext summary store on
 * every autosave and drawn for every row of the home screen, so two things
 * matter more than usual: it must be byte-stable for unchanged input (no
 * churn), and it must never carry anything but silhouettes (no text).
 */

const node = (input: Partial<DraftNode> & Pick<DraftNode, 'type'>): DraftNode =>
  createNode({ x: 0, y: 0, width: 100, height: 50, ...input });

describe('shapeKindOf', () => {
  const cases: Array<[Partial<DraftNode> & Pick<DraftNode, 'type'>, ShapeKind | null]> = [
    [{ type: 'service' }, 'service'],
    [{ type: 'service', serviceKind: 'api' }, 'service'],
    [{ type: 'service', serviceKind: 'worker' }, 'service'],
    [{ type: 'service', serviceKind: 'scheduler' }, 'service'],
    [{ type: 'service', serviceKind: 'gateway' }, 'service'],
    [{ type: 'service', serviceKind: 'external' }, 'external'],
    [{ type: 'database' }, 'database'],
    [{ type: 'database', databaseKind: 'sql' }, 'database'],
    [{ type: 'database', databaseKind: 'cache' }, 'database'],
    [{ type: 'database', databaseKind: 'file-system' }, 'database'],
    [{ type: 'database', databaseKind: 'object-storage' }, 'database'],
    [{ type: 'database', databaseKind: 'search-index' }, 'database'],
    [{ type: 'queue' }, 'queue'],
    [{ type: 'queue', queueKind: 'stream' }, 'queue'],
    [{ type: 'queue', deliveryRole: 'dead-letter' }, 'queue'],
    [{ type: 'queue', queueKind: 'topic' }, 'topic'],
    [{ type: 'actor' }, 'actor'],
    [{ type: 'actor', actorKind: 'device' }, 'actor'],
    [{ type: 'component' }, 'component'],
    [{ type: 'component', componentKind: 'port' }, 'component'],
    [{ type: 'ellipse' }, 'junction'],
    [{ type: 'group' }, 'boundary'],
    [{ type: 'text' }, null],
    [{ type: 'note' }, null],
    [{ type: 'code' }, null],
  ];

  it.each(cases)('folds %o to %s', (input, expected) => {
    expect(shapeKindOf(node(input))).toBe(expected);
  });
});

describe('libraryShapeOf', () => {
  it('scales the longer axis to 1000 and keeps the aspect ratio, as integers', () => {
    const shape = libraryShapeOf(
      [node({ type: 'service', x: 10, y: 20, width: 100, height: 50 }), node({ type: 'database', x: 310, y: 20, width: 90, height: 60 })],
      [],
    );
    expect(shape.v).toBe(SHAPE_VERSION);
    expect(shape.w).toBe(1000);
    // Content spans x 10..400 (390 wide) and y 20..80 (60 tall).
    expect(shape.h).toBe(Math.round((60 / 390) * 1000));
    for (const [, ...box] of shape.nodes) {
      for (const value of box) expect(Number.isInteger(value)).toBe(true);
    }
    const service = shape.nodes.find((entry) => entry[0] === 'service');
    expect(service).toEqual(['service', 0, 0, Math.round((100 / 390) * 1000), Math.round((50 / 390) * 1000)]);
  });

  it('measures bounds over the kept nodes only, so a far-away note cannot shrink the diagram', () => {
    const withNote = libraryShapeOf(
      [node({ type: 'service', x: 0, y: 0 }), node({ type: 'note', x: 5000, y: 5000 })],
      [],
    );
    const without = libraryShapeOf([node({ type: 'service', x: 0, y: 0 })], []);
    expect(withNote).toEqual(without);
    expect(withNote.nodes).toHaveLength(1);
  });

  it('returns an empty (but present) shape for a canvas of nothing but notes', () => {
    expect(libraryShapeOf([node({ type: 'note' }), node({ type: 'text' })], [])).toEqual({
      v: SHAPE_VERSION,
      w: 0,
      h: 0,
      nodes: [],
      edges: [],
    });
  });

  it('is deterministic regardless of input order when areas differ', () => {
    const a = node({ type: 'service', id: 'a', x: 0, y: 0, width: 100, height: 50 });
    const b = node({ type: 'database', id: 'b', x: 200, y: 0, width: 90, height: 60 });
    const c = node({ type: 'queue', id: 'c', x: 400, y: 0, width: 80, height: 30 });
    const edge = createEdge({ source: 'a', target: 'c' });
    expect(libraryShapeOf([a, b, c], [edge])).toEqual(libraryShapeOf([c, a, b], [edge]));
  });

  it('tie-breaks equal areas by id so an unchanged canvas re-summarises byte-identically', () => {
    const a = node({ type: 'service', id: 'n-a', x: 0, y: 0 });
    const b = node({ type: 'service', id: 'n-b', x: 200, y: 0 });
    expect(JSON.stringify(libraryShapeOf([b, a], []))).toBe(JSON.stringify(libraryShapeOf([a, b], [])));
  });

  it('keeps boundaries first (outermost by z), then the largest nodes, up to the cap', () => {
    const boundaries = [
      node({ type: 'group', id: 'g-inner', z: 1, x: 10, y: 10, width: 200, height: 200 }),
      node({ type: 'group', id: 'g-outer', z: 0, x: 0, y: 0, width: 400, height: 400 }),
    ];
    const others = Array.from({ length: 30 }, (_, i) =>
      node({ type: 'service', id: `s-${String(i).padStart(2, '0')}`, x: i * 10, y: 0, width: 10 + i, height: 10 }),
    );
    const shape = libraryShapeOf([...others, ...boundaries], []);
    expect(shape.nodes).toHaveLength(SHAPE_MAX_NODES);
    expect(shape.nodes[0]![0]).toBe('boundary');
    expect(shape.nodes[1]![0]).toBe('boundary');
    // Outer (z 0) before inner (z 1): its box starts at the origin.
    expect(shape.nodes[0]!.slice(1, 3)).toEqual([0, 0]);
    // The smallest services are the ones dropped.
    const widths = shape.nodes.slice(2).map((entry) => entry[3]);
    expect(widths).toEqual([...widths].sort((x, y) => y - x));
  });

  it('records edges as index pairs, dropping ones to excluded nodes, self-loops, and past the cap', () => {
    const a = node({ type: 'service', id: 'a', x: 0, y: 0 });
    const b = node({ type: 'database', id: 'b', x: 200, y: 0, width: 90, height: 60 });
    const note = node({ type: 'note', id: 'note', x: 400, y: 0 });
    const edges = [
      createEdge({ source: 'a', target: 'b' }),
      createEdge({ source: 'a', target: 'note' }),
      createEdge({ source: 'b', target: 'b' }),
      createEdge({ source: 'b', target: 'a' }),
    ];
    const shape = libraryShapeOf([a, b, note], edges);
    const ia = shape.nodes.findIndex((entry) => entry[0] === 'service');
    const ib = shape.nodes.findIndex((entry) => entry[0] === 'database');
    expect(shape.edges).toEqual([
      [ia, ib],
      [ib, ia],
    ]);

    const many = Array.from({ length: SHAPE_MAX_EDGES + 5 }, () => createEdge({ source: 'a', target: 'b' }));
    expect(libraryShapeOf([a, b], many).edges).toHaveLength(SHAPE_MAX_EDGES);
  });
});

describe('isLibraryShape', () => {
  const valid = libraryShapeOf([node({ type: 'service' }), node({ type: 'queue', x: 200 })], [
    createEdge({ source: 'x', target: 'y' }),
  ]);

  it('accepts what libraryShapeOf produces', () => {
    expect(isLibraryShape(valid)).toBe(true);
  });

  it('rejects missing, mis-versioned, and malformed values', () => {
    expect(isLibraryShape(undefined)).toBe(false);
    expect(isLibraryShape(null)).toBe(false);
    expect(isLibraryShape({ ...valid, v: SHAPE_VERSION + 1 })).toBe(false);
    expect(isLibraryShape({ ...valid, nodes: [['service', 0, 0, 1]] })).toBe(false);
    expect(isLibraryShape({ ...valid, nodes: [['spaceship', 0, 0, 1, 1]] })).toBe(false);
    expect(isLibraryShape({ ...valid, edges: [[0, 7]] })).toBe(false);
    expect(isLibraryShape({ ...valid, edges: [[0]] })).toBe(false);
    expect(isLibraryShape({ ...valid, w: Number.NaN })).toBe(false);
  });
});
