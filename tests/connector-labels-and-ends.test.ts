import { describe, expect, it } from 'vitest';
import { createEdge, createNode } from '../src/document/factory';
import { categoryOf } from '../src/document/connectorSemantics';
import { relationshipCaptionLabel } from '../src/document/edgeSemantics';
import { connectorRoutes } from '../src/edges/connectorRoutes';
import { labelChipBox } from '../src/edges/labelGroups';
import { LABEL_PADDING_X, LABEL_PADDING_Y, edgeLabelSize, fittedConnectorCaption, layoutConnectorCaption, layoutEdgeLabel } from '../src/edges/labelLayout';
import {
  LABEL_ARROW_CLEARANCE,
  LABEL_BEND_CLEARANCE,
  MIN_END_RUN,
  labelChipSide,
  placeLabel,
  rectOf,
  relaxEndJogs,
  routeBetween,
} from '../src/edges/routing';
import { stepPolyline } from '../src/edges/waypoints';
import { exampleCanvas } from '../src/gallery/example';

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

  it('puts the words over the middle of a short hop with a jog in it, not beside the jog', () => {
    // A Queue and the Worker suggested beside it: the tube sits above the box's middle, so the line
    // goes out, drops 17, and comes in. Neither half is long enough to carry "consumed by".
    const queue = { x: 300, y: 200, width: 140, height: 72 };
    const worker = { x: 530, y: 200, width: 176, height: 68 };
    const d = 'M 440,216.75 L 485,216.75 L 485,234 L 530,234';
    const caption = placeLabel(d, { x: 485, y: 225 }, queue, worker, 'top');
    // Under the lower half, centred in what the arrowhead leaves, with the whole hop as its room.
    expect(caption).toEqual({ x: 440 + (90 - LABEL_ARROW_CLEARANCE) / 2, y: 234, side: 'bottom', room: 90 - LABEL_ARROW_CLEARANCE });
    expect(fittedConnectorCaption('consumed by', undefined, caption.room)).not.toBeNull();
    // A label's chip sits above its line, so it takes the upper half instead.
    expect(placeLabel(d, { x: 485, y: 225 }, queue, worker, 'top', true)).toMatchObject({ y: 216.75, side: 'top' });
    // A hop too short for any words keeps the old point: nothing over the middle would fit either.
    expect(placeLabel('M 0,0 L 20,0 L 20,10 L 40,10', { x: 20, y: 5 }, near, far, 'top').room).toBeUndefined();
  });

  it('measures both sides of an upright run for the room a shape leaves beside it', () => {
    const d = 'M 0,0 L 0,200';
    // Nothing level with the label on either side: the right, as always.
    expect(placeLabel(d, { x: 0, y: 100 }, near, far, 'right')).toEqual({ x: 0, y: 100, side: 'right' });
    // A shape a short way to the right, level with the label: only the left has room.
    const beside = { x: 30, y: 60, width: 120, height: 80 };
    expect(placeLabel(d, { x: 0, y: 100 }, beside, far, 'right')).toEqual({ x: 0, y: 100, side: 'left' });
    // Shapes close on both sides: the roomier side, and how wide the words may be there.
    const left = { x: -160, y: 60, width: 120, height: 80 };
    const squeezed = placeLabel(d, { x: 0, y: 100 }, beside, left, 'right');
    expect(squeezed.side).toBe('left');
    expect(squeezed.room).toBe(40 - 8);
  });

  it('leaves a caption out of a line with no room for it, rather than running it under a shape', () => {
    expect(fittedConnectorCaption('consumed by')).not.toBeNull();
    expect(fittedConnectorCaption('consumed by', undefined, 80)).not.toBeNull();
    // Fitted to the narrowest it may be laid out, it would still be wider than the line allows.
    expect(fittedConnectorCaption('consumed by', undefined, 20)).toBeNull();
    // A short word fits a short line.
    expect(fittedConnectorCaption('calls', undefined, 30)).not.toBeNull();
  });

  it('gives a fan\'s shared caption the length of its stem, less the trunk\'s corner', () => {
    const hub = { x: 0, y: 100, width: 120, height: 60 };
    const spine = { hub: 'source' as const, hubSide: 'right' as const, trunkGap: 40, corridor: 80, id: 's', count: 2 };
    const route = routeBetween(hub, { x: 200, y: 0, width: 120, height: 60 }, 'smoothstep', { spine });
    expect(route.trunkLabel).toBeDefined();
    expect(route.trunkLabelRoom).toBe(Math.abs(route.trunkLabel!.x - route.source.x) * 2 - LABEL_BEND_CLEARANCE);
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
  // The copy that ships with the app, as "Try an example" opens it.
  const doc = exampleCanvas();
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

describe('words kept off their own lines', () => {
  const crosses = (a: { x: number; y: number }, b: { x: number; y: number }, box: { x: number; y: number; width: number; height: number }) => {
    // Axis-aligned segments only: every line here is stepped.
    const [x0, x1] = [Math.min(a.x, b.x), Math.max(a.x, b.x)];
    const [y0, y1] = [Math.min(a.y, b.y), Math.max(a.y, b.y)];
    return x0 < box.x + box.width && x1 > box.x && y0 < box.y + box.height && y1 > box.y;
  };
  const chipOf = (route: ReturnType<typeof routeBetween>, text: string, away = 0) => {
    const layout = layoutEdgeLabel(text);
    return labelChipBox(labelChipSide(route.labelSide, away), route.labelX, route.labelY, layout.width + LABEL_PADDING_X * 2, layout.height + LABEL_PADDING_Y * 2);
  };

  it('moves a label off a jog too short for it, where the legs at both ends run through it', () => {
    // Down, a short step left, down again: the step is long enough for a caption by length alone,
    // but each leg turns up into the words sitting above it.
    const source = { x: 100, y: 184, width: 156, height: 80 };
    const target = { x: 48, y: 395, width: 156, height: 80 };
    const text = 'Prices each line';
    const route = routeBetween(source, target, 'smoothstep', {
      anchors: { source: { side: 'bottom', offset: 0.5 }, target: { side: 'top', offset: 0.5 } },
      label: { ...edgeLabelSize(text) },
    });
    const box = chipOf(route, text);
    const corners = stepPolyline(route.d);
    for (let i = 1; i < corners.length; i += 1) {
      const [a, b] = [corners[i - 1]!, corners[i]!];
      const along = Math.abs(a.y - b.y) < 0.5 ? Math.abs(a.y - route.labelY) < 0.5 : Math.abs(a.x - route.labelX) < 0.5;
      if (!along) expect(crosses(a, b, box), `leg ${i} through the words`).toBe(false);
    }
  });

});
