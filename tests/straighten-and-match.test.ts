import { beforeEach, describe, expect, it } from 'vitest';
import { commandsFor } from '../src/commands/registry';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { matchNodeSizes } from '../src/document/operations';
import { anchorBandOf } from '../src/document/queueGeometry';
import type { DraftDocument, DraftEdge, DraftNode } from '../src/document/types';
import { rectOf } from '../src/edges/routing';
import { straightOffset } from '../src/edges/straight';
import { STRAIGHTEN_LIMIT, straightenPositions } from '../src/edges/straighten';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { stubContext } from './commandStubs';

const service = (id: string, x: number, y: number, extra: Partial<DraftNode> = {}): DraftNode =>
  ({ ...createNode({ type: 'service', x, y, text: id }), id, ...extra });
const link = (source: string, target: string, extra: Partial<DraftEdge> = {}): DraftEdge =>
  ({ ...createEdge({ source, target }), id: `${source}-${target}`, ...extra });
const docOf = (nodes: DraftNode[], edges: DraftEdge[]): DraftDocument => ({ ...createDocument('Test'), nodes, edges });

function kinkOf(doc: DraftDocument, edgeId: string): number {
  const edge = doc.edges.find((e) => e.id === edgeId)!;
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  return Math.abs(straightOffset(edge, rectOf(byId.get(edge.source)!), rectOf(byId.get(edge.target)!))!.delta);
}

function reset(document: DraftDocument) {
  __resetInteraction();
  useEditorStore.setState({
    document,
    path: [],
    outer: null,
    liveViewport: null,
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    revision: 0,
  });
}

describe('straightenPositions', () => {
  it('nudges a shape a few pixels so its connector runs straight', () => {
    const doc = docOf([service('a', 0, 0), service('b', 300, 7)], [link('a', 'b')]);
    const moved = straightenPositions(doc);
    expect(moved.get('b')).toEqual({ x: 300, y: 0 });
    expect(moved.has('a')).toBe(false);
  });

  it('lines a queue up on its tube, not its box', () => {
    // Its tube 8 below the service's middle line.
    const queue = { ...createNode({ type: 'queue', x: 300, y: 0, text: 'q' }), id: 'q' };
    const band = anchorBandOf(queue)!;
    queue.y = 34 + 8 - (band.top + band.bottom) / 2;
    const doc = docOf([service('a', 0, 0), queue], [link('a', 'q')]);
    expect(kinkOf(doc, 'a-q')).toBeCloseTo(8, 6);
    const moved = straightenPositions(doc);
    const next = { ...doc, nodes: doc.nodes.map((n) => ({ ...n, ...moved.get(n.id) })) };
    expect(kinkOf(next, 'a-q')).toBeLessThan(0.01);
  });

  it('leaves a misalignment past the limit alone: that is the layout, not a slip', () => {
    const doc = docOf([service('a', 0, 0), service('b', 300, STRAIGHTEN_LIMIT + 4)], [link('a', 'b')]);
    expect(straightenPositions(doc).size).toBe(0);
  });

  it('moves shapes joined by a straight line together, so no other connector kinks', () => {
    // b—c already straight; a—b off by 6. The lone shape moves, not the pair.
    const doc = docOf([service('a', 0, 6), service('b', 300, 0), service('c', 600, 0)], [link('a', 'b'), link('b', 'c')]);
    const moved = straightenPositions(doc);
    expect([...moved.keys()]).toEqual(['a']);
    const next = { ...doc, nodes: doc.nodes.map((n) => ({ ...n, ...moved.get(n.id) })) };
    expect(kinkOf(next, 'a-b')).toBeLessThan(0.01);
    expect(kinkOf(next, 'b-c')).toBeLessThan(0.01);
  });

  it('straightens a whole chain of small kinks without breaking an earlier one', () => {
    const doc = docOf([service('a', 0, 0), service('b', 300, 5), service('c', 600, -4), service('d', 900, 9)], [link('a', 'b'), link('b', 'c'), link('c', 'd')]);
    const moved = straightenPositions(doc);
    const next = { ...doc, nodes: doc.nodes.map((n) => ({ ...n, ...moved.get(n.id) })) };
    for (const id of ['a-b', 'b-c', 'c-d']) expect(kinkOf(next, id)).toBeLessThan(0.01);
  });

  it('straightens an upright connector on x', () => {
    const doc = docOf([service('a', 0, 0), service('b', 9, 300)], [link('a', 'b')]);
    expect(straightenPositions(doc).get('b')).toEqual({ x: 0, y: 300 });
  });

  it('will not push a shape onto another', () => {
    // b would have to move up 10 onto `wall`; a moves down instead.
    const doc = docOf([service('a', 0, 0), service('b', 300, 10), service('wall', 300, -60)], [link('a', 'b')]);
    const moved = straightenPositions(doc);
    expect(moved.has('b')).toBe(false);
    expect(moved.get('a')).toEqual({ x: 0, y: 10 });
  });

  it('moves only the shapes it may', () => {
    const doc = docOf([service('a', 0, 0), service('b', 300, 7)], [link('a', 'b')]);
    expect(straightenPositions(doc, { movable: new Set(['a']) }).get('a')).toEqual({ x: 0, y: 7 });
    expect(straightenPositions(doc, { movable: new Set<string>() }).size).toBe(0);
  });

  it('keeps hand-bent connectors and shapes that would leave their boundary', () => {
    const bent = docOf([service('a', 0, 0), service('b', 300, 7)], [link('a', 'b', { waypoints: [{ x: 200, y: 200 }] })]);
    expect(straightenPositions(bent).size).toBe(0);
    const frame = { ...createNode({ type: 'group', x: 280, y: 2, width: 220, height: 76 }), id: 'g' };
    const held = docOf([service('a', 0, 0), frame, service('b', 300, 4, { parentId: 'g' })], [link('a', 'b')]);
    // b can't go up 4 and stay inside; a goes down to meet it instead.
    const moved = straightenPositions(held);
    expect(moved.has('b')).toBe(false);
    expect(moved.get('a')).toEqual({ x: 0, y: 4 });
  });
});

describe('Straighten, through the store and the palette', () => {
  beforeEach(() => reset(docOf([service('a', 0, 0), service('b', 300, 7), service('c', 600, 12)], [link('a', 'b'), link('b', 'c')])));

  it('is one undo step', () => {
    expect(useEditorStore.getState().straighten()).toBe(true);
    expect(useEditorStore.getState().history.past).toHaveLength(1);
    const doc = useEditorStore.getState().document;
    expect(kinkOf(doc, 'a-b')).toBeLessThan(0.01);
    expect(kinkOf(doc, 'b-c')).toBeLessThan(0.01);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().document.nodes.map((n) => n.y)).toEqual([0, 7, 12]);
  });

  it('reports nothing to do on an already straight diagram, and adds no history', () => {
    useEditorStore.getState().straighten();
    expect(useEditorStore.getState().straighten()).toBe(false);
    expect(useEditorStore.getState().history.past).toHaveLength(1);
  });

  it('is in the palette under the words people use', () => {
    const command = commandsFor(stubContext()).find((c) => c.id === 'straighten');
    expect(command?.title).toBe('Straighten connectors');
    expect(command?.keywords).toEqual(expect.arrayContaining(['kinks', 'straight lines']));
  });
});

describe('Same width / Same height', () => {
  it('takes the largest, keeps each top-left corner, and leaves a Junction round', () => {
    const junction = { ...createNode({ type: 'ellipse', x: 0, y: 300 }), id: 'j' };
    const doc = docOf([service('a', 0, 0, { width: 120 }), service('b', 300, 40, { width: 200, height: 90 }), junction], []);
    const wide = matchNodeSizes(doc, ['a', 'b', 'j'], 'width');
    expect(wide.nodes.map((n) => [n.id, n.x, n.y, n.width])).toEqual([
      ['a', 0, 0, 200],
      ['b', 300, 40, 200],
      ['j', 0, 300, junction.width],
    ]);
    const tall = matchNodeSizes(doc, ['a', 'b'], 'height');
    expect(tall.nodes.find((n) => n.id === 'a')!.height).toBe(90);
    expect(matchNodeSizes(tall, ['a', 'b'], 'height')).toBe(tall);
  });

  it('is one undo step each, offered for a selection of two or more', () => {
    reset(docOf([service('a', 0, 0, { width: 120 }), service('b', 300, 40, { width: 200, height: 90 })], []));
    useEditorStore.getState().setSelection({ nodes: ['a', 'b'], edges: [] });
    const list = commandsFor(stubContext()).map((c) => c.id);
    expect(list).toEqual(expect.arrayContaining(['match-width', 'match-height']));
    useEditorStore.getState().matchSize('width');
    useEditorStore.getState().matchSize('height');
    expect(useEditorStore.getState().history.past).toHaveLength(2);
    expect(useEditorStore.getState().document.nodes.map((n) => [n.width, n.height])).toEqual([[200, 90], [200, 90]]);
    useEditorStore.getState().undo();
    expect(useEditorStore.getState().document.nodes.map((n) => [n.width, n.height])).toEqual([[200, 68], [200, 90]]);
  });
});
