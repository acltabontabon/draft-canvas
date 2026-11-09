import { describe, expect, it } from 'vitest';
import { createEdge, createNode } from '../src/document/factory';
import { categoryOf } from '../src/document/connectorSemantics';
import { relationshipCaptionLabel } from '../src/document/edgeSemantics';
import { connectorRoutes } from '../src/edges/connectorRoutes';
import { layoutConnectorCaption, layoutEdgeLabel } from '../src/edges/labelLayout';
import {
  LABEL_ARROW_CLEARANCE,
  LABEL_BEND_CLEARANCE,
  MIN_END_RUN,
  placeLabel,
  rectOf,
  relaxEndJogs,
  routeBetween,
} from '../src/edges/routing';
import { stepPolyline } from '../src/edges/waypoints';
import { starterDocument } from '../src/starters/document';
import { ORDER_PROCESSING } from '../src/starters/order-processing';

const far = { x: 900, y: 900, width: 10, height: 10 };
const near = { x: -90, y: -90, width: 10, height: 10 };

describe('captions sit on the longest straight stretch, clear of the arrowhead', () => {
  it('moves off a short jog onto the longest level stretch', () => {
    // Out level, a 20-unit jog, then level again into the head: the jog is a kink.
    const d = 'M 0,0 L 60,0 L 60,20 L 200,20';
    const placed = placeLabel(d, { x: 60, y: 10 }, near, far, 'top');
    expect(placed.y).toBe(20);
    expect(placed.x).toBeGreaterThan(60 + LABEL_BEND_CLEARANCE - 1e-6);
    expect(placed.x).toBeLessThanOrEqual(200 - LABEL_BEND_CLEARANCE - LABEL_ARROW_CLEARANCE);
    expect(placed.side).toBe('top');
  });

  it('does the same for a rounded S-bend, whose middle is on the jog', () => {
    const route = routeBetween({ x: 0, y: 0, width: 120, height: 60 }, { x: 300, y: 18, width: 120, height: 60 }, 'smoothstep', {
      anchors: { source: { side: 'right', offset: 0.5 }, target: { side: 'left', offset: 0.5 } },
    });
    // The two level stretches are at y 30 and 48; the label is on one of them, not between.
    expect([30, 48]).toContain(route.labelY);
  });

  it('keeps the arrowhead\'s length clear at the target end of a stretch', () => {
    const placed = placeLabel('M 0,0 L 100,0', { x: 98, y: 0 }, near, far, 'top');
    expect(placed.x).toBe(100 - LABEL_BEND_CLEARANCE - LABEL_ARROW_CLEARANCE);
    // The start has no head: only the bend clearance.
    expect(placeLabel('M 0,0 L 100,0', { x: 1, y: 0 }, near, far, 'top').x).toBe(LABEL_BEND_CLEARANCE);
  });

  it('measures the room a caption has before it reaches either end of the line', () => {
    const placed = placeLabel('M 0,0 L 100,0', { x: 40, y: 0 }, near, far, 'top');
    expect(placed.room).toBe(2 * Math.min(40, 100 - 40 - LABEL_ARROW_CLEARANCE));
    // An interior stretch, between two bends, is no limit: the caption sits beside the line.
    expect(placeLabel('M 0,0 L 0,50 L 200,50 L 200,100', { x: 100, y: 50 }, near, far, 'top').room).toBeUndefined();
  });

  it('truncates a caption past that room, in both renderers\' shared layout', () => {
    const text = 'sends command to';
    expect(layoutConnectorCaption(text).truncated).toBe(false);
    const tight = layoutConnectorCaption(text, undefined, 60);
    expect(tight.truncated).toBe(true);
    expect(tight.width).toBeLessThanOrEqual(60);
    expect(layoutEdgeLabel('A long relationship label that will not fit', undefined, 90).width).toBeLessThanOrEqual(90);
  });
});

describe('a line never bends right into its arrowhead', () => {
  it('moves a jog just before the target back, keeping every corner', () => {
    const points = [{ x: 176, y: 34 }, { x: 196, y: 34 }, { x: 196, y: 96 }, { x: 425, y: 96 }, { x: 425, y: 109 }, { x: 445, y: 109 }];
    const relaxed = relaxEndJogs(points, [{ x: 200, y: 40, width: 100, height: 40 }]);
    expect(relaxed).toHaveLength(points.length);
    expect(relaxed[0]).toEqual(points[0]);
    expect(relaxed.at(-1)).toEqual(points.at(-1));
    expect(relaxed.at(-1)!.x - relaxed.at(-2)!.x).toBeGreaterThanOrEqual(MIN_END_RUN);
  });

  it('leaves it alone where the move would run into a shape', () => {
    const points = [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 60 }, { x: 200, y: 60 }, { x: 200, y: 70 }, { x: 220, y: 70 }];
    expect(relaxEndJogs(points, [{ x: 100, y: 62, width: 99, height: 20 }])).toBe(points);
  });

  it('holds for a line detouring round a shape into a Data Store', () => {
    const api = createNode({ type: 'service', x: 0, y: 0, text: 'API' });
    const db = createNode({ type: 'database', x: 420, y: 70, text: 'DB' });
    const blocker = createNode({ type: 'service', x: 200, y: 40, text: 'B', width: 100, height: 40 });
    const edge = createEdge({ source: api.id, target: db.id });
    const route = connectorRoutes(edge, { nodes: [api, db, blocker], edges: [edge] }, 'canvas')!.request;
    const corners = stepPolyline(route.d);
    const [end, before] = [corners.at(-1)!, corners.at(-2)!];
    expect(Math.hypot(end.x - before.x, end.y - before.y)).toBeGreaterThanOrEqual(MIN_END_RUN - 0.01);
    // The detour runs at the Data Store's own level: two bends, no step before the head.
    expect(corners).toHaveLength(4);
  });
});

describe('the example diagram', () => {
  const doc = starterDocument(ORDER_PROCESSING);
  const byId = new Map(doc.nodes.map((node) => [node.id, node]));

  it('lines its row up by the arrows: every connector runs straight', () => {
    for (const edge of doc.edges) {
      const route = connectorRoutes(edge, doc, 'canvas')!.request;
      const ys = stepPolyline(route.d).map((point) => point.y);
      expect(Math.max(...ys) - Math.min(...ys), edge.id).toBeLessThan(0.5);
    }
  });

  it('shows every caption whole, clear of the shapes and arrowheads', () => {
    for (const edge of doc.edges) {
      const route = connectorRoutes(edge, doc, 'canvas')!.request;
      const source = byId.get(edge.source)!;
      const target = byId.get(edge.target)!;
      const caption = relationshipCaptionLabel(edge.semantic!, { hasResponse: edge.hasResponse, source: categoryOf(source), target: categoryOf(target) });
      const layout = layoutConnectorCaption(caption, undefined, route.labelRoom);
      expect(layout.truncated, caption).toBe(false);
      // Centred on the label point, the caption ends before the shapes it joins.
      expect(route.labelX - layout.width / 2).toBeGreaterThan(rectOf(source).x + source.width);
      expect(route.labelX + layout.width / 2).toBeLessThan(route.target.x - LABEL_ARROW_CLEARANCE);
    }
  });
});
