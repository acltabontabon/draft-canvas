/**
 * Explicit placement and routing: an agent saying exactly where something goes and how a connector
 * runs, instead of leaving it to the layout.
 *
 * - `place` puts an element (or group, or free note) at an exact top-left, or beside another one —
 *   `rightOf`/`leftOf`/`above`/`below`, `gap` apart, aligned `start`/`center`/`end` along the other
 *   axis — and may size it, never below what its text needs. An `x` or `y` given beside a relation
 *   wins on its own axis.
 * - `route` picks the side each end of a relationship uses and the points it passes through
 *   (`DraftEdge.waypoints`: the same bends a person drags in the editor, drawn by the same router).
 *
 * What is given is kept as given. The quality gate still refuses what is broken outright — shapes on
 * top of each other, clipped text — but a line or caption problem on something placed or routed by
 * hand is reported rather than refused (`checkQuality`'s `explicit`): the agent asked for exactly
 * that, and the receipt tells it what it costs.
 *
 * This module reads requests and applies routes; `placeExplicit.ts` applies placements, which need the
 * layout's own helpers.
 */

import { LIMITS } from '../document/limits';
import { SIDES, type DraftDocument, type DraftEdge, type DraftPoint, type EdgeAnchor, type Side } from '../document/types';
import { AgentError } from './errors';
import type { Reader } from './input';

export const RELATIONS = ['rightOf', 'leftOf', 'above', 'below'] as const;
type Relation = (typeof RELATIONS)[number];

export interface PlaceSpec {
  x?: number;
  y?: number;
  beside?: { relation: Relation; id: string };
  gap?: number;
  align?: 'start' | 'center' | 'end';
  width?: number;
  height?: number;
}

/**
 * One end of a hand route: a side (pinned at its middle), an exact pin, or `'auto'` — no pin, so the
 * end faces the other shape and follows it as shapes move (the pin contract in `edges/routing.ts`).
 */
export type RouteEnd = Side | EdgeAnchor | 'auto';

export interface RouteSpec {
  from?: RouteEnd;
  to?: RouteEnd;
  via?: DraftPoint[];
}

const PLACE_FIELDS = ['x', 'y', ...RELATIONS, 'gap', 'align', 'width', 'height'];
const ROUTE_FIELDS = ['from', 'to', 'via'];

function coordinate(r: Reader, value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= LIMITS.maxCoordinate) return Math.round(value);
  r.problems.add('INVALID_INPUT', path, `must be a number within ±${LIMITS.maxCoordinate}`);
  return undefined;
}

function length(r: Reader, value: unknown, path: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max) return Math.round(value);
  r.problems.add('INVALID_INPUT', path, `must be a number from ${min} to ${max}`);
  return undefined;
}

export function readPlace(r: Reader, value: unknown, path: string): PlaceSpec | undefined {
  const raw = r.object(value, path, PLACE_FIELDS);
  if (!raw) return undefined;
  const relations = RELATIONS.filter((relation) => raw[relation] !== undefined);
  if (relations.length > 1) r.problems.add('INVALID_INPUT', path, `give one of ${RELATIONS.join(', ')}, not ${relations.length}`);
  const relation = relations[0];
  const target = relation ? raw[relation] : undefined;
  if (relation && typeof target !== 'string') r.problems.add('INVALID_INPUT', `${path}/${relation}`, 'must be an id');
  const spec: PlaceSpec = {};
  const x = coordinate(r, raw.x, `${path}/x`);
  const y = coordinate(r, raw.y, `${path}/y`);
  if (x !== undefined) spec.x = x;
  if (y !== undefined) spec.y = y;
  if (relation && typeof target === 'string') spec.beside = { relation, id: target };
  const gap = length(r, raw.gap, `${path}/gap`, 0, 2000);
  if (gap !== undefined) spec.gap = gap;
  const align = r.oneOf(raw.align, `${path}/align`, ['start', 'center', 'end'] as const);
  if (align) spec.align = align;
  const width = length(r, raw.width, `${path}/width`, LIMITS.minNodeSize, LIMITS.maxNodeSize);
  const height = length(r, raw.height, `${path}/height`, LIMITS.minNodeSize, LIMITS.maxNodeSize);
  if (width !== undefined) spec.width = width;
  if (height !== undefined) spec.height = height;
  if (!spec.beside && spec.x === undefined && spec.y === undefined && spec.width === undefined && spec.height === undefined) {
    r.problems.add('INVALID_INPUT', path, `give x/y, one of ${RELATIONS.join(', ')}, or a width/height`);
  }
  return spec;
}

export function readRoute(r: Reader, value: unknown, path: string): RouteSpec | undefined {
  const raw = r.object(value, path, ROUTE_FIELDS);
  if (!raw) return undefined;
  const spec: RouteSpec = {};
  const from = readEnd(r, raw.from, `${path}/from`);
  const to = readEnd(r, raw.to, `${path}/to`);
  if (from) spec.from = from;
  if (to) spec.to = to;
  if (raw.via !== undefined) {
    const points = r.array(raw.via, `${path}/via`, LIMITS.maxWaypointsPerEdge);
    const via: DraftPoint[] = [];
    points.forEach((point, i) => {
      const at = `${path}/via/${i}`;
      if (!Array.isArray(point) || point.length !== 2) {
        r.problems.add('INVALID_INPUT', at, 'must be a point: [x, y]');
        return;
      }
      const x = coordinate(r, point[0], `${at}/0`);
      const y = coordinate(r, point[1], `${at}/1`);
      if (x !== undefined && y !== undefined) via.push({ x, y });
    });
    spec.via = via;
  }
  if (!spec.from && !spec.to && spec.via === undefined) r.problems.add('INVALID_INPUT', path, 'give from, to or via');
  return spec;
}

/** A route end: a side, `{side, offset}` with the offset from 0 to 1, or `"auto"`. */
function readEnd(r: Reader, value: unknown, path: string): RouteEnd | undefined {
  if (value === undefined) return undefined;
  if (value === 'auto') return 'auto';
  if (typeof value === 'string') return r.oneOf(value, path, SIDES);
  const raw = r.object(value, path, ['side', 'offset']);
  if (!raw) return undefined;
  const side = r.oneOf(raw.side, `${path}/side`, SIDES);
  if (!side) {
    if (raw.side === undefined) r.problems.add('INVALID_INPUT', `${path}/side`, `give one of ${SIDES.join(', ')}`);
    return undefined;
  }
  if (raw.offset === undefined) return { side, offset: 0.5 };
  if (typeof raw.offset !== 'number' || !Number.isFinite(raw.offset) || raw.offset < 0 || raw.offset > 1) {
    r.problems.add('INVALID_INPUT', `${path}/offset`, 'must be a number from 0 to 1 (0 is the top or left corner of the side)');
    return undefined;
  }
  return { side, offset: Math.round(raw.offset * 1000) / 1000 };
}

/** The anchor a route end stores: a pin, or none for `"auto"`. */
function anchorOf(end: RouteEnd): EdgeAnchor | undefined {
  if (end === 'auto') return undefined;
  return typeof end === 'string' ? { side: end, offset: 0.5 } : { ...end };
}

/** One connector routed by hand: the ends given — pinned, or automatic for `"auto"` — and the bends
 *  given (`via: []` drops them). */
export function routed(edge: DraftEdge, route: RouteSpec): DraftEdge {
  const next: DraftEdge = { ...edge };
  for (const [end, key] of [[route.from, 'sourceAnchor'], [route.to, 'targetAnchor']] as const) {
    if (end === undefined) continue;
    const anchor = anchorOf(end);
    if (anchor) next[key] = anchor;
    else delete next[key];
  }
  if (route.via !== undefined) {
    if (route.via.length) next.waypoints = route.via.map((p) => ({ ...p }));
    else delete next.waypoints;
  }
  return next;
}

/** Every hand route in `routes` applied to its connector. */
export function applyRoutes(view: DraftDocument, routes: ReadonlyMap<string, RouteSpec>, at = '/route'): DraftDocument {
  if (routes.size === 0) return view;
  for (const id of routes.keys()) {
    if (!view.edges.some((e) => e.id === id)) throw new AgentError('INVALID_REFERENCE', `${at}: no relationship "${id}" in this view to route.`);
  }
  return { ...view, edges: view.edges.map((edge) => (routes.has(edge.id) ? routed(edge, routes.get(edge.id)!) : edge)) };
}
