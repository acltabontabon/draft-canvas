import type { Bounds } from '../document/geometry';
import { categoryOf } from '../document/connectorSemantics';
import { effectiveConnectorText } from '../document/edgeSemantics';
import type { DraftDocument, DraftEdge, DraftNode } from '../document/types';
import { LABEL_PADDING_X, LABEL_PADDING_Y, layoutEdgeLabel } from './labelLayout';
import { routingPlan } from './bundles';
import { obstaclesForEdge } from './obstacles';
import { LABEL_LINE_GAP, flattenPath, labelLaneOffset, laneIndex, routeEdge } from './routing';

/**
 * Where the connectors already drawn in a region are, as plain boxes.
 *
 * Placement (`document/operations.ts`'s `tryPlaceNear`) knows about nodes and boundaries and
 * nothing else, so a generated node could land squarely on a connector or on its caption. That is
 * only ever a *preference* to avoid — a caller weighs these boxes against its other candidates and
 * still places the node if every one of them is crossed — which is why this module is allowed to
 * approximate, to give up early, and to cost nothing at all when there is nothing nearby.
 *
 * Not a spatial index: the region asked about is one node's worth of canvas. But a connector's
 * drawn boxes are kept per document (see `Spans`): every continuation candidate around one anchor
 * asks about overlapping regions of the same document, and re-routing the same dozen connectors for
 * each of them cost hundreds of milliseconds per edit on a large diagram.
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

/** Where one connector is drawn, as the boxes `connectorClearance` tests: one per segment, and its
 *  caption's. Plain numbers only — nothing the router used to get there. */
interface RoutedBoxes {
  segments: Bounds[];
  label?: Bounds;
}

/** A document's spans, and the connectors routed so far for it, by id (`null`: it has no route). */
interface Spans {
  spans: EdgeSpan[];
  routed: Map<string, RoutedBoxes | null>;
}

/**
 * The spans for a document, computed once per (nodes, edges) pair. Placement asks about the same
 * document repeatedly — once per suggestion offered, and the hook re-derives on every selection —
 * while the document itself only changes when it is edited. Keyed on array identity, nested the
 * same way `bundles.ts`'s plan cache is, so an edit to either drops it.
 */
const spanCache = new WeakMap<readonly DraftNode[], WeakMap<readonly DraftEdge[], Spans>>();

function spansOf(nodes: readonly DraftNode[], edges: readonly DraftEdge[]): Spans {
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
  const entry: Spans = { spans, routed: new Map() };
  byEdges.set(edges, entry);
  return entry;
}

/**
 * Routes one connector the way the canvas draws it, lane and shared trunk included: without those a
 * parallel pair or a bundled fan was tested where neither line is. A module-level function so the
 * cached result holds the boxes and nothing of the router's working state (see AGENTS.md).
 */
function routeBoxes(doc: Pick<DraftDocument, 'nodes' | 'edges'>, { edge, source, target }: EdgeSpan): RoutedBoxes | null {
  // `routeEdge` looks its endpoints up by id; the span already holds them.
  const byId = new Map<string, DraftNode>([[source.id, source], [target.id, target]]);
  // Both memoized on the document's arrays. Not the canvas's own plan slot: the document asked
  // about may be one that never reaches the screen.
  const lane = laneIndex(doc.edges).get(edge.id)?.offset ?? 0;
  const route = routeEdge(edge, byId, {
    obstacles: obstaclesForEdge(doc.nodes, edge.source, edge.target, 'transient'),
    lane,
    spine: routingPlan(doc.nodes, doc.edges, 'transient').spineFor(edge.id),
  });
  if (!route) return null;
  const points = flattenPath(route.d);
  const segments: Bounds[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1]!;
    const b = points[i]!;
    segments.push({
      x: Math.min(a.x, b.x) - STROKE_HALF,
      y: Math.min(a.y, b.y) - STROKE_HALF,
      width: Math.abs(b.x - a.x) + STROKE_HALF * 2,
      height: Math.abs(b.y - a.y) + STROKE_HALF * 2,
    });
  }
  // At the lane-nudged point both renderers draw the label at, not at `route.labelX`.
  const nudge = labelLaneOffset(route.source.side, route.target.side, lane);
  const label = labelBox(edge, { source, target }, { x: route.labelX + nudge.x, y: route.labelY + nudge.y });
  return label ? { segments, label } : { segments };
}

/** The box a connector's own caption occupies, wherever `labelSideFor` ends up putting it: sized
 *  from the text actually drawn, then grown by the line gap on every side so it covers the label
 *  on either side of the line without having to know which side won. */
function labelBox(
  edge: DraftEdge,
  ends: { source: DraftNode; target: DraftNode },
  at: { x: number; y: number },
): Bounds | undefined {
  const text = effectiveConnectorText(edge, {
    source: categoryOf(ends.source),
    target: categoryOf(ends.target),
  });
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
  const { spans, routed } = spansOf(doc.nodes, doc.edges);
  const boxes: Bounds[] = [];
  let nearby = 0;
  for (const span of spans) {
    if (span.right <= region.x || span.left >= regionRight) continue;
    if (span.bottom <= region.y || span.top >= regionBottom) continue;
    let drawn = routed.get(span.edge.id);
    if (drawn === undefined) {
      drawn = routeBoxes(doc, span);
      routed.set(span.edge.id, drawn);
    }
    if (drawn) {
      for (const box of drawn.segments) if (overlaps(box, region)) boxes.push(box);
      if (drawn.label && overlaps(drawn.label, region)) boxes.push(drawn.label);
    }
    nearby += 1;
    if (nearby >= limit) break;
  }
  return boxes;
}
