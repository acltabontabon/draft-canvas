import type { Bounds } from '../document/geometry';
import { categoryOf } from '../document/connectorSemantics';
import { relationshipCaptionLabel } from '../document/edgeSemantics';
import type { DraftDocument, DraftEdge, DraftNode } from '../document/types';
import { LABEL_PADDING_X, LABEL_PADDING_Y, layoutEdgeLabel } from './labelLayout';
import { obstaclesForEdge } from './obstacles';
import { LABEL_LINE_GAP, flattenPath, routeEdge } from './routing';

/**
 * Where the connectors already drawn in a region are, as plain boxes.
 *
 * Placement (`document/operations.ts`'s `tryPlaceNear`) knows about nodes and boundaries and
 * nothing else, so a generated node could land squarely on a connector or on its caption. That is
 * only ever a *preference* to avoid — a caller weighs these boxes against its other candidates and
 * still places the node if every one of them is crossed — which is why this module is allowed to
 * approximate, to give up early, and to cost nothing at all when there is nothing nearby.
 *
 * Deliberately not a spatial index or a cache: the region asked about is one node's worth of
 * canvas, the answer is wanted once per placement, and `obstaclesForEdge` and `laneIndex` already
 * memoize the parts that are worth memoizing.
 */

/** Half the width of the band a connector is treated as occupying. A stroke is 1.5px, but a line
 *  a node's edge merely grazes still reads as touched. */
const STROKE_HALF = 6;

/**
 * How far outside its two endpoints a connector may stray. A smooth-step route detours around
 * obstacles and a caption sits off to one side, so the box spanning a connector's endpoints is not
 * quite the box it is drawn in — this pads the cheap test that decides whether routing it is worth
 * doing at all.
 */
const STRAY_MARGIN = 120;

/** Connectors this will route before giving up and ignoring the rest. Dodging is a preference, so
 *  a region dense enough to blow through this is one where stepping aside was never going to help
 *  anyway — and the cost of looking has to stay bounded. */
const DEFAULT_LIMIT = 12;

export interface ClearanceOptions {
  /** Most connectors to route (default 12). */
  limit?: number;
}

const overlaps = (a: Bounds, b: Bounds): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/**
 * One connector, with the box its endpoints span already padded by `STRAY_MARGIN` — everything the
 * cheap gate needs, as bare numbers, so deciding "could this one be drawn in here at all" is four
 * comparisons and no lookups.
 */
interface EdgeSpan {
  edge: DraftEdge;
  source: DraftNode;
  target: DraftNode;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * The spans for a document, computed once per (nodes, edges) pair. Placement asks about the same
 * document repeatedly — once per suggestion offered, and the hook re-derives on every selection —
 * while the document itself only changes when it is edited. Keyed on array identity, nested the
 * same way `bundles.ts`'s plan cache is, so an edit to either drops it.
 */
const spanCache = new WeakMap<readonly DraftNode[], WeakMap<readonly DraftEdge[], EdgeSpan[]>>();

function spansOf(nodes: readonly DraftNode[], edges: readonly DraftEdge[]): EdgeSpan[] {
  let byEdges = spanCache.get(nodes);
  if (!byEdges) {
    byEdges = new WeakMap();
    spanCache.set(nodes, byEdges);
  }
  const cached = byEdges.get(edges);
  if (cached) return cached;

  const byId = new Map<string, DraftNode>(nodes.map((node) => [node.id, node]));
  const spans: EdgeSpan[] = [];
  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    spans.push({
      edge,
      source,
      target,
      left: Math.min(source.x, target.x) - STRAY_MARGIN,
      right: Math.max(source.x + source.width, target.x + target.width) + STRAY_MARGIN,
      top: Math.min(source.y, target.y) - STRAY_MARGIN,
      bottom: Math.max(source.y + source.height, target.y + target.height) + STRAY_MARGIN,
    });
  }
  byEdges.set(edges, spans);
  return spans;
}

/** The box a connector's own caption occupies, wherever `labelSideFor` ends up putting it: sized
 *  from the text actually drawn, then grown by the line gap on every side so it covers the label
 *  on either side of the line without having to know which side won. */
function labelBox(
  edge: DraftEdge,
  ends: { source: DraftNode; target: DraftNode },
  at: { x: number; y: number },
): Bounds | undefined {
  const caption = edge.semantic
    ? relationshipCaptionLabel(edge.semantic, {
        hasResponse: edge.hasResponse,
        deliveryAttempts: edge.deliveryAttempts,
        source: categoryOf(ends.source),
        target: categoryOf(ends.target),
      })
    : '';
  const text = edge.label?.trim() || caption;
  if (!text) return undefined;
  const layout = layoutEdgeLabel(text);
  const width = layout.width + LABEL_PADDING_X * 2 + LABEL_LINE_GAP * 2;
  const height = layout.height + LABEL_PADDING_Y * 2 + LABEL_LINE_GAP * 2;
  return { x: at.x - width / 2, y: at.y - height / 2, width, height };
}

/**
 * Boxes covering the connectors and connector captions drawn inside `region`. Empty when nothing is
 * near, which is the common case and costs one pass over the document's connectors with no routing
 * at all.
 */
export function connectorClearance(
  doc: Pick<DraftDocument, 'nodes' | 'edges'>,
  region: Bounds,
  options: ClearanceOptions = {},
): Bounds[] {
  if (doc.edges.length === 0) return [];
  const limit = options.limit ?? DEFAULT_LIMIT;
  const regionRight = region.x + region.width;
  const regionBottom = region.y + region.height;

  // Cheap gate first: which connectors could possibly be drawn in here at all. Nothing is routed
  // until this says so, which is what makes the common case — an empty stretch of canvas — free.
  const nearby: EdgeSpan[] = [];
  for (const span of spansOf(doc.nodes, doc.edges)) {
    if (span.right <= region.x || span.left >= regionRight) continue;
    if (span.bottom <= region.y || span.top >= regionBottom) continue;
    nearby.push(span);
    if (nearby.length >= limit) break;
  }
  if (nearby.length === 0) return [];

  const boxes: Bounds[] = [];
  // `routeEdge` looks its endpoints up by id; the spans already hold them, so this is the handful
  // of connectors that got through the gate, never the whole document.
  const byId = new Map<string, DraftNode>();
  for (const { source, target } of nearby) {
    byId.set(source.id, source);
    byId.set(target.id, target);
  }
  for (const { edge, source, target } of nearby) {
    const route = routeEdge(edge, byId, { obstacles: obstaclesForEdge(doc.nodes, edge.source, edge.target) });
    if (!route) continue;
    const points = flattenPath(route.d);
    for (let i = 1; i < points.length; i += 1) {
      const a = points[i - 1]!;
      const b = points[i]!;
      const box = {
        x: Math.min(a.x, b.x) - STROKE_HALF,
        y: Math.min(a.y, b.y) - STROKE_HALF,
        width: Math.abs(b.x - a.x) + STROKE_HALF * 2,
        height: Math.abs(b.y - a.y) + STROKE_HALF * 2,
      };
      if (overlaps(box, region)) boxes.push(box);
    }
    const label = labelBox(edge, { source, target }, { x: route.labelX, y: route.labelY });
    if (label && overlaps(label, region)) boxes.push(label);
  }
  return boxes;
}
