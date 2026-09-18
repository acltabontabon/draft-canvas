import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import {
  addNodes,
  moveNodes,
  reconcileMembership,
  removeElements,
} from '../src/document/operations';
import type { DraftDocument, DraftNode } from '../src/document/types';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

/**
 * Membership is what a delete cascades along and what a boundary drag carries, so it has to agree
 * with where things are drawn. These cases are the ways a gesture leaves the two disagreeing.
 */

const shape = (id: string, x: number, y: number, parentId?: string) =>
  createNode({ id, type: 'service', x, y, width: 100, height: 60, z: 1, ...(parentId ? { parentId } : {}) });

const boundary = (id: string, x: number, y: number, width: number, height: number, parentId?: string) =>
  createNode({ id, type: 'group', x, y, width, height, z: 0, ...(parentId ? { parentId } : {}) });

function build(nodes: DraftNode[]): DraftDocument {
  return addNodes(createDocument('Membership'), nodes);
}

const parentOf = (doc: DraftDocument, id: string) => doc.nodes.find((n) => n.id === id)?.parentId;

describe('reconcileMembership', () => {
  it('lets a shape carried out of its boundary go, so deleting the boundary no longer takes it', () => {
    // Two members in a boundary; both are dragged clear of it together (a marquee, so no single-drop).
    const doc = build([boundary('b', 0, 0, 400, 300), shape('a', 20, 40, 'b'), shape('c', 20, 140, 'b')]);
    const moved = moveNodes(
      doc,
      new Map([
        ['a', { x: 700, y: 40 }],
        ['c', { x: 700, y: 140 }],
      ]),
    );

    const reconciled = reconcileMembership(moved, ['a', 'c']);

    expect(parentOf(reconciled, 'a')).toBeUndefined();
    expect(parentOf(reconciled, 'c')).toBeUndefined();
    // The consequence that matters: they survive the boundary being deleted.
    const afterDelete = removeElements(reconciled, ['b']);
    expect(afterDelete.nodes.map((n) => n.id).sort()).toEqual(['a', 'c']);
  });

  it('would have deleted them without it (the bug this guards)', () => {
    const doc = build([boundary('b', 0, 0, 400, 300), shape('a', 20, 40, 'b')]);
    const moved = moveNodes(doc, new Map([['a', { x: 700, y: 40 }]]));
    expect(removeElements(moved, ['b']).nodes).toHaveLength(0);
  });

  it('adopts each shape of a multi-selection into the boundary its centre landed in', () => {
    const doc = build([boundary('b', 0, 0, 400, 300), shape('a', 600, 40), shape('c', 600, 140)]);
    const moved = moveNodes(
      doc,
      new Map([
        ['a', { x: 60, y: 40 }],
        ['c', { x: 60, y: 140 }],
      ]),
    );

    const reconciled = reconcileMembership(moved, ['a', 'c']);

    expect(parentOf(reconciled, 'a')).toBe('b');
    expect(parentOf(reconciled, 'c')).toBe('b');
  });

  it('resolves to the deepest boundary, per shape', () => {
    const doc = build([
      boundary('outer', 0, 0, 600, 400),
      boundary('inner', 50, 50, 200, 200, 'outer'),
      shape('a', 800, 40),
      shape('c', 800, 140),
    ]);
    const moved = moveNodes(
      doc,
      new Map([
        ['a', { x: 100, y: 100 }], // centre (150, 130): inside inner
        ['c', { x: 400, y: 300 }], // centre (450, 330): inside outer only
      ]),
    );

    const reconciled = reconcileMembership(moved, ['a', 'c']);

    expect(parentOf(reconciled, 'a')).toBe('inner');
    expect(parentOf(reconciled, 'c')).toBe('outer');
  });

  it('leaves a shape carried along by a boundary that is moving too', () => {
    // The whole boundary and its member move together: nothing about their relationship changed.
    const doc = build([boundary('b', 0, 0, 400, 300), shape('a', 20, 40, 'b')]);
    const moved = moveNodes(
      doc,
      new Map([
        ['b', { x: 900, y: 500 }],
        ['a', { x: 920, y: 540 }],
      ]),
    );

    const reconciled = reconcileMembership(moved, ['b', 'a']);

    expect(reconciled).toBe(moved);
    expect(parentOf(reconciled, 'a')).toBe('b');
  });

  it('lets a nested boundary leave the boundary it was carried out of', () => {
    const doc = build([
      boundary('outer', 0, 0, 600, 400),
      boundary('inner', 50, 50, 200, 200, 'outer'),
      shape('a', 80, 80, 'inner'),
    ]);
    // Drag the inner boundary (and, as a sweep would, its member) well clear of the outer one.
    const moved = moveNodes(
      doc,
      new Map([
        ['inner', { x: 1000, y: 50 }],
        ['a', { x: 1030, y: 80 }],
      ]),
    );

    const reconciled = reconcileMembership(moved, ['inner', 'a']);

    expect(parentOf(reconciled, 'inner')).toBeUndefined();
    // Its member travelled with it, so it is still a member of it.
    expect(parentOf(reconciled, 'a')).toBe('inner');
    // Deleting the outer boundary now leaves the moved one alone.
    const afterDelete = removeElements(reconciled, ['outer']);
    expect(afterDelete.nodes.map((n) => n.id).sort()).toEqual(['a', 'inner']);
  });

  it('never nests a boundary just because it was dropped over another', () => {
    const doc = build([boundary('big', 0, 0, 800, 600), boundary('small', 1000, 0, 200, 150)]);
    const moved = moveNodes(doc, new Map([['small', { x: 100, y: 100 }]]));

    const reconciled = reconcileMembership(moved, ['small']);

    expect(parentOf(reconciled, 'small')).toBeUndefined();
    expect(reconciled).toBe(moved);
  });

  it('rehomes a boundary that left its parent into the boundary it now sits in', () => {
    const doc = build([
      boundary('a', 0, 0, 500, 400),
      boundary('b', 700, 0, 500, 400),
      boundary('mover', 50, 50, 200, 150, 'a'),
    ]);
    const moved = moveNodes(doc, new Map([['mover', { x: 800, y: 80 }]]));

    expect(parentOf(reconcileMembership(moved, ['mover']), 'mover')).toBe('b');
  });

  it('is a no-op (same document) when everything already agrees, so it never adds an undo step', () => {
    const doc = build([boundary('b', 0, 0, 400, 300), shape('a', 20, 40, 'b'), shape('free', 900, 40)]);
    expect(reconcileMembership(doc, ['a', 'free'])).toBe(doc);
    expect(reconcileMembership(doc, [])).toBe(doc);
    expect(reconcileMembership(doc, ['nope'])).toBe(doc);
  });

  it('cannot create a cycle by re-homing a boundary into its own descendant', () => {
    // Contrived on purpose: `outer` lands with its centre inside `inner`, which is *its own child*
    // and, in this synthetic document, was left behind. Excluding descendants is what stops it
    // choosing `inner` as its new parent, which would make a boundary its own ancestor.
    const doc = build([
      boundary('root', 0, 0, 2000, 2000),
      boundary('outer', 100, 100, 800, 600, 'root'),
      boundary('inner', 2100, 2100, 900, 700, 'outer'),
    ]);
    const moved = moveNodes(doc, new Map([['outer', { x: 2100, y: 2100 }]]));

    const reconciled = reconcileMembership(moved, ['outer']);

    expect(parentOf(reconciled, 'outer')).toBeUndefined();
    expect(parentOf(reconciled, 'inner')).toBe('outer');
  });
});

describe('carrying shapes out of a boundary, through the store', () => {
  beforeEach(() => {
    __resetInteraction();
    useEditorStore.setState({
      document: build([boundary('b', 0, 0, 400, 300), shape('a', 20, 40, 'b'), shape('c', 20, 140, 'b')]),
      path: [],
      outer: null,
      liveViewport: null,
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      revision: 0,
    });
  });

  it('is one undo step: the move and the change of membership come back together', () => {
    const store = useEditorStore.getState();
    // What `Canvas.tsx`'s drop does: the positions, then the membership, inside one gesture.
    store.beginInteraction('Move');
    useEditorStore.getState().commitMove(
      new Map([
        ['a', { x: 700, y: 40 }],
        ['c', { x: 700, y: 140 }],
      ]),
      ['a', 'c'],
    );
    useEditorStore.getState().endInteraction();

    expect(useEditorStore.getState().history.past).toHaveLength(1);
    expect(parentOf(useEditorStore.getState().document, 'a')).toBeUndefined();

    useEditorStore.getState().undo();
    const restored = useEditorStore.getState().document;
    expect(parentOf(restored, 'a')).toBe('b');
    expect(parentOf(restored, 'c')).toBe('b');
    expect(restored.nodes.find((n) => n.id === 'a')).toMatchObject({ x: 20, y: 40 });
  });

  it('adds nothing to history when the move changed nobody\'s boundary', () => {
    const store = useEditorStore.getState();
    store.beginInteraction('Move');
    useEditorStore.getState().commitMove(new Map([['a', { x: 60, y: 60 }]]), ['a']);
    useEditorStore.getState().endInteraction();

    // One entry: the move, with nothing extra for a membership that did not change.
    expect(useEditorStore.getState().history.past).toHaveLength(1);
    expect(parentOf(useEditorStore.getState().document, 'a')).toBe('b');
  });
});
