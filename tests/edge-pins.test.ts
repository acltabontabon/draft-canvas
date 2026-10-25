import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { autoAttachEnds, pinEnds } from '../src/document/operations';
import type { DraftDocument, DraftEdge, EdgeAnchor } from '../src/document/types';
import { connectorRoutes } from '../src/edges/connectorRoutes';
import { anchorPoint, routeBetween, type Rect } from '../src/edges/routing';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

/** Pinned and automatic connector ends: existing pins are kept; new ends follow their shapes. */

const a: Rect = { x: 0, y: 0, width: 160, height: 80 };
const b: Rect = { x: 480, y: 0, width: 160, height: 80 };
const pin = (side: EdgeAnchor['side'], offset = 0.5): EdgeAnchor => ({ side, offset });

describe('the pin contract', () => {
  it('draws a pinned end exactly at its anchor, however the shapes move', () => {
    const anchors = { source: pin('bottom', 0.25), target: pin('top', 0.75) };
    for (const [x, y] of [[480, 300], [-400, 300], [0, 400], [480, -300], [20, 160]]) {
      const target = { x: x!, y: y!, width: 160, height: 80 };
      const route = routeBetween(a, target, 'smoothstep', { anchors, obstacles: [] });
      expect(route.source).toEqual({ ...anchorPoint(a, 'bottom', 0.25), side: 'bottom' });
      expect(route.target).toEqual({ ...anchorPoint(target, 'top', 0.75), side: 'top' });
    }
  });

  it('lets an automatic end face the other shape wherever it goes', () => {
    expect(routeBetween(a, b, 'smoothstep').source.side).toBe('right');
    expect(routeBetween(a, { ...b, x: -600 }, 'smoothstep').source.side).toBe('left');
    expect(routeBetween(a, { ...b, x: 0, y: 400 }, 'smoothstep').source.side).toBe('bottom');
  });

  it('spreads connectors pinned to one point only within a handle\'s band', () => {
    const anchors = { source: pin('right'), target: pin('left') };
    const band = a.height * 0.25 * 0.375;
    for (const lane of [-3, -1, 1, 3]) {
      const route = routeBetween(a, b, 'smoothstep', { anchors, lane });
      expect(Math.abs(route.source.y - anchorPoint(a, 'right').y)).toBeLessThanOrEqual(band + 1e-9);
      expect(Math.abs(route.target.y - anchorPoint(b, 'left').y)).toBeLessThanOrEqual(band + 1e-9);
    }
  });

  it('gives a pinned end\'s reply line its whole step beside it', () => {
    const anchors = { source: pin('right'), target: pin('left') };
    const request = routeBetween(a, b, 'smoothstep', { anchors });
    const reply = routeBetween(b, a, 'smoothstep', { anchors: { source: anchors.target, target: anchors.source }, replyStep: 1.8 });
    expect(Math.abs(reply.target.y - request.source.y)).toBeCloseTo(18);
  });
});

describe('auto attach and pin, end by end', () => {
  const doc = (): DraftDocument => ({
    ...createDocument('Pins'),
    nodes: [createNode({ id: 'a', type: 'service', x: 0, y: 0 }), createNode({ id: 'b', type: 'service', x: 480, y: 120 })],
    edges: [createEdge({ id: 'ab', source: 'a', target: 'b', sourceAnchor: pin('bottom'), targetAnchor: pin('top', 0.25) })],
  });
  const only = (d: DraftDocument): DraftEdge => d.edges[0]!;

  it('unpins the start, the end or both, leaving the other end as it was', () => {
    expect(only(autoAttachEnds(doc(), new Set(['ab']), 'source'))).toMatchObject({ targetAnchor: pin('top', 0.25) });
    expect(only(autoAttachEnds(doc(), new Set(['ab']), 'source')).sourceAnchor).toBeUndefined();
    expect(only(autoAttachEnds(doc(), new Set(['ab']), 'target'))).toMatchObject({ sourceAnchor: pin('bottom') });
    expect(only(autoAttachEnds(doc(), new Set(['ab']), 'target')).targetAnchor).toBeUndefined();
    const both = only(autoAttachEnds(doc(), new Set(['ab']), 'both'));
    expect([both.sourceAnchor, both.targetAnchor]).toEqual([undefined, undefined]);
    // Nothing to unpin: the same document.
    const clear = autoAttachEnds(doc(), new Set(['ab']), 'both');
    expect(autoAttachEnds(clear, new Set(['ab']), 'both')).toBe(clear);
  });

  it('pins as given and leaves an end with no pin given alone', () => {
    const unpinned = autoAttachEnds(doc(), new Set(['ab']), 'both');
    const pinned = only(pinEnds(unpinned, new Map([['ab', { source: pin('right', 0.75) }]])));
    expect(pinned.sourceAnchor).toEqual(pin('right', 0.75));
    expect(pinned.targetAnchor).toBeUndefined();
  });
});

describe('Pin ends here', () => {
  beforeEach(() => {
    __resetInteraction();
    useEditorStore.setState({
      document: createDocument('Pins'),
      path: [],
      outer: null,
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      revision: 0,
      mode: 'edit',
    });
  });

  it('pins each automatic end exactly where it is drawn, so nothing moves', () => {
    const state = useEditorStore.getState();
    const api = state.addNode({ type: 'service', x: 0, y: 0, text: 'API' });
    const db = state.addNode({ type: 'database', x: 360, y: 140, text: 'DB' });
    const edge = state.connect(api.id, db.id)!;
    expect([edge.sourceAnchor, edge.targetAnchor]).toEqual([undefined, undefined]);
    const before = connectorRoutes(edge, useEditorStore.getState().document, 'transient')!.request;
    useEditorStore.getState().pinEnds([edge.id], 'both');
    const document = useEditorStore.getState().document;
    const pinned = document.edges.find((e) => e.id === edge.id)!;
    expect(pinned.sourceAnchor?.side).toBe(before.source.side);
    expect(pinned.targetAnchor?.side).toBe(before.target.side);
    const after = connectorRoutes(pinned, document, 'transient')!.request;
    expect(after.d).toBe(before.d);
    // One undo step back to automatic.
    useEditorStore.getState().undo();
    const undone = useEditorStore.getState().document.edges.find((e) => e.id === edge.id)!;
    expect([undone.sourceAnchor, undone.targetAnchor]).toEqual([undefined, undefined]);
  });
});
