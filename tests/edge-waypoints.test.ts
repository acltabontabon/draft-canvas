import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import {
  addEdges,
  addNodes,
  extractFragment,
  moveNodes,
  pasteFragment,
  reverseEdge,
  setEdgeWaypoints,
} from '../src/document/operations';
import { normalizeDocument } from '../src/document/validate';
import { CURRENT_VERSION, DRAFT_FORMAT, type DraftPoint } from '../src/document/types';
import { routingPlan } from '../src/edges/bundles';
import { endTangent, routeBetween, type Rect } from '../src/edges/routing';
import {
  bendsOf,
  orthogonalThrough,
  simplifyPolyline,
  slideSegment,
  stepPolyline,
} from '../src/edges/waypoints';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

const orthogonal = (points: readonly DraftPoint[]) =>
  points.every((p, i) => i === 0 || p.x === points[i - 1]!.x || p.y === points[i - 1]!.y);

const A: Rect = { x: 0, y: 0, width: 100, height: 60 };
const B: Rect = { x: 300, y: 200, width: 100, height: 60 };

describe('stepped lines through bends', () => {
  it('stays orthogonal and square to both shapes whatever the bends are', () => {
    const points = orthogonalThrough({ x: 100, y: 30 }, 'right', [{ x: 160, y: 120 }], { x: 300, y: 230 }, 'left');
    expect(orthogonal(points)).toBe(true);
    expect(points[0]).toEqual({ x: 100, y: 30 });
    // Leaves the right side going right, arrives on the left side going right.
    expect(points[1]!.y).toBe(30);
    expect(points[1]!.x).toBeGreaterThan(100);
    expect(points[points.length - 2]!.y).toBe(230);
    expect(points[points.length - 2]!.x).toBeLessThan(300);
  });

  it('keeps the elbow going the way the line already was, so no extra jog appears', () => {
    // A bend straight out to the right and down: one corner at (160, 30), one at (160, 230).
    const points = orthogonalThrough({ x: 100, y: 30 }, 'right', [{ x: 160, y: 120 }], { x: 300, y: 230 }, 'left');
    expect(points).toEqual([
      { x: 100, y: 30 },
      { x: 160, y: 30 },
      { x: 160, y: 230 },
      { x: 300, y: 230 },
    ]);
  });

  it('loops out of a shape whose bend sits behind it rather than cutting back through it', () => {
    const points = orthogonalThrough({ x: 100, y: 30 }, 'right', [{ x: 50, y: -40 }], { x: 300, y: 230 }, 'left');
    expect(orthogonal(points)).toBe(true);
    // The first run leaves rightwards before anything turns.
    expect(points[1]!.x).toBeGreaterThan(100);
    expect(points[1]!.y).toBe(30);
  });

  it('reads the corners back off a drawn stepped path', () => {
    const route = routeBetween(A, B, 'smoothstep');
    const corners = stepPolyline(route.d);
    expect(orthogonal(corners)).toBe(true);
    expect(corners[0]).toEqual({ x: route.source.x, y: route.source.y });
    expect(corners[corners.length - 1]).toEqual({ x: route.target.x, y: route.target.y });
    expect(corners.length).toBeGreaterThanOrEqual(3);
  });

  it('slides a middle run sideways, stretching its neighbours', () => {
    const line = [
      { x: 100, y: 30 },
      { x: 200, y: 30 },
      { x: 200, y: 230 },
      { x: 300, y: 230 },
    ];
    expect(slideSegment(line, 1, 250)).toEqual([
      { x: 100, y: 30 },
      { x: 250, y: 30 },
      { x: 250, y: 230 },
      { x: 300, y: 230 },
    ]);
  });

  it('keeps an end on its shape when the run touching it is slid, adding a jog instead', () => {
    const line = [
      { x: 100, y: 30 },
      { x: 300, y: 30 },
    ];
    const slid = slideSegment(line, 0, 80);
    expect(slid[0]).toEqual({ x: 100, y: 30 });
    expect(slid[slid.length - 1]).toEqual({ x: 300, y: 30 });
    expect(orthogonal(slid)).toBe(true);
    expect(slid.some((p) => p.y === 80)).toBe(true);
  });

  it('straightens out when a run is slid level with the next one', () => {
    const line = [
      { x: 100, y: 30 },
      { x: 200, y: 30 },
      { x: 200, y: 80 },
      { x: 300, y: 80 },
    ];
    // The last run is the target's; sliding it to y = 30 leaves a stub and a line with no bends
    // beyond the ones that keep the end on its shape.
    const slid = simplifyPolyline(slideSegment(line, 1, 300));
    expect(orthogonal(slid)).toBe(true);
    expect(bendsOf(simplifyPolyline([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }]))).toEqual([]);
  });
});

describe('routing through bends', () => {
  it('draws a stepped connector through every bend', () => {
    const waypoints = [
      { x: 200, y: -60 },
      { x: 450, y: -60 },
    ];
    const route = routeBetween(A, B, 'smoothstep', { waypoints });
    expect(route.points).toBeDefined();
    expect(orthogonal(route.points!)).toBe(true);
    for (const bend of waypoints) expect(route.points!.some((p) => p.x === bend.x && p.y === bend.y)).toBe(true);
  });

  it('turns each end towards its nearest bend when no anchor was chosen', () => {
    // A bend above both shapes: the line leaves A's top and enters B's top.
    const route = routeBetween(A, B, 'smoothstep', { waypoints: [{ x: 50, y: -80 }, { x: 350, y: -80 }] });
    expect(route.source.side).toBe('top');
    expect(route.target.side).toBe('top');
  });

  it('keeps a persisted anchor even when the bends are elsewhere', () => {
    const route = routeBetween(A, B, 'smoothstep', {
      anchors: { source: { side: 'right', offset: 0.5 } },
      waypoints: [{ x: 50, y: -80 }],
    });
    expect(route.source.side).toBe('right');
  });

  it('draws straight and curved connectors through their bends too', () => {
    const waypoints = [{ x: 200, y: 300 }];
    const straight = routeBetween(A, B, 'straight', { waypoints });
    expect(straight.d).toContain('L200 300');
    // The arrowhead follows the last leg, not the line between the two ends.
    const tangent = endTangent(straight, 'straight', 'target');
    expect(tangent.y).toBeLessThan(0);
    const curved = routeBetween(A, B, 'bezier', { waypoints });
    expect(curved.d).toContain(' 200 300');
  });

  it('leaves a bent connector out of any shared trunk', () => {
    let doc = createDocument('Bundle');
    const hub = createNode({ type: 'service', x: 0, y: 200 });
    const targets = [0, 1, 2].map((i) => createNode({ type: 'service', x: 400, y: i * 160 }));
    doc = addNodes(doc, [hub, ...targets]);
    const edges = targets.map((t) => createEdge({ source: hub.id, target: t.id }));
    doc = addEdges(doc, edges);
    expect(routingPlan(doc.nodes, doc.edges).spineFor(edges[0]!.id)).toBeDefined();
    doc = setEdgeWaypoints(doc, edges[0]!.id, [{ x: 300, y: 40 }]);
    expect(routingPlan(doc.nodes, doc.edges).spineFor(edges[0]!.id)).toBeUndefined();
  });
});

describe('bends in the document', () => {
  function bent() {
    let doc = createDocument('Bends');
    const a = createNode({ type: 'service', x: 0, y: 0 });
    const b = createNode({ type: 'service', x: 400, y: 200 });
    doc = addNodes(doc, [a, b]);
    const edge = createEdge({ source: a.id, target: b.id });
    doc = addEdges(doc, [edge]);
    doc = setEdgeWaypoints(doc, edge.id, [{ x: 250, y: -40 }, { x: 250.4, y: 120 }]);
    return { doc, a, b, edge };
  }

  it('stores rounded bends, and none clears them', () => {
    const { doc, edge } = bent();
    expect(doc.edges[0]!.waypoints).toEqual([{ x: 250, y: -40 }, { x: 250, y: 120 }]);
    expect(setEdgeWaypoints(doc, edge.id, [{ x: 250, y: -40 }, { x: 250, y: 120 }])).toBe(doc);
    expect('waypoints' in setEdgeWaypoints(doc, edge.id, undefined).edges[0]!).toBe(false);
  });

  it('carries bends with both shapes, and leaves them when only one moves', () => {
    const { doc, a, b } = bent();
    const both = moveNodes(doc, new Map([[a.id, { x: 10, y: 20 }], [b.id, { x: 410, y: 220 }]]));
    expect(both.edges[0]!.waypoints).toEqual([{ x: 260, y: -20 }, { x: 260, y: 140 }]);
    const one = moveNodes(doc, new Map([[b.id, { x: 500, y: 200 }]]));
    expect(one.edges[0]!.waypoints).toEqual(doc.edges[0]!.waypoints);
  });

  it('pastes bends where the copied shapes land', () => {
    const { doc, a, b } = bent();
    const pasted = pasteFragment(doc, extractFragment(doc, [a.id, b.id]), { x: 30, y: 30 });
    const copy = pasted.doc.edges.find((e) => e.id === pasted.edgeIds[0]);
    expect(copy?.waypoints).toEqual([{ x: 280, y: -10 }, { x: 280, y: 150 }]);
  });

  it('reverses bends with the connector', () => {
    const { doc, edge } = bent();
    expect(reverseEdge(doc, edge.id).edges[0]!.waypoints).toEqual([{ x: 250, y: 120 }, { x: 250, y: -40 }]);
  });

  it('survives a save and load, and drops unreadable points', () => {
    const { doc } = bent();
    const raw = JSON.parse(JSON.stringify(doc));
    raw.edges[0].waypoints.push({ x: 'nope', y: 1 }, null);
    const result = normalizeDocument({ ...raw, format: DRAFT_FORMAT, version: CURRENT_VERSION });
    if (!result.ok) throw new Error(result.error);
    expect(result.document.edges[0]!.waypoints).toEqual([{ x: 250, y: -40 }, { x: 250, y: 120 }]);
  });
});

describe('bend actions', () => {
  const store = useEditorStore;

  beforeEach(() => {
    __resetInteraction();
    store.setState({
      document: createDocument('Bend actions'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      clipboard: null,
      revision: 0,
    });
  });

  it('bends and resets as single undo steps, and Tidy connectors clears bends', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'service', x: 400, y: 200 });
    const edge = store.getState().connect(a.id, b.id)!;
    store.getState().setEdgeWaypoints(edge.id, [{ x: 250, y: -40 }]);
    expect(store.getState().document.edges[0]!.waypoints).toEqual([{ x: 250, y: -40 }]);
    store.getState().undo();
    expect(store.getState().document.edges[0]!.waypoints).toBeUndefined();
    store.getState().redo();
    store.getState().tidyConnections();
    expect(store.getState().document.edges[0]!.waypoints).toBeUndefined();
  });
});
