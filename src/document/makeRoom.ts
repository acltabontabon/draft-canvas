import { inkAbsolutePoints, inkOf, translateInk } from './ink';
import type { DraftDocument, DraftNode } from './types';

/**
 * Making room: everything past a line across the view moves away from it (or back toward it), the
 * way pushing books along a shelf opens a gap without touching the ones before it. A boundary the
 * line passes through stretches with what it holds; a connector's own bends past the line go along.
 * Nothing before the line moves, and nothing is laid out again.
 */

export type RoomAxis = 'x' | 'y';

export interface RoomPush {
  /** `x`: the line is vertical and what is to its right moves. `y`: horizontal, what is below. */
  axis: RoomAxis;
  /** Where the line is, in room coordinates. */
  at: number;
  /** How far to move: positive opens room, negative closes it. */
  delta: number;
}

/** What is left of a boundary the line passes through when room is closed up inside it. */
const BOUNDARY_KEEPS = 48;

const startOf = (node: DraftNode, axis: RoomAxis) => (axis === 'x' ? node.x : node.y);
const sizeOf = (node: DraftNode, axis: RoomAxis) => (axis === 'x' ? node.width : node.height);

/**
 * How far room can be closed at this line before something would cross it: a distance, 0 or more.
 * Closing stops when the nearest shape past the line reaches it, so shapes never pile up or swap
 * sides — and with nothing past the line there is nothing to close.
 */
export function roomToClose(doc: Pick<DraftDocument, 'nodes'>, axis: RoomAxis, at: number): number {
  let room = Infinity;
  for (const node of doc.nodes) {
    const start = startOf(node, axis);
    const end = start + sizeOf(node, axis);
    if (start >= at) room = Math.min(room, start - at);
    else if (node.type === 'group' && end > at) room = Math.min(room, Math.max(0, end - at - BOUNDARY_KEEPS));
  }
  return Number.isFinite(room) ? room : 0;
}

export function makeRoom(doc: DraftDocument, push: RoomPush): DraftDocument {
  const { axis, at } = push;
  const delta = Math.round(Math.max(push.delta, -roomToClose(doc, axis, at)));
  if (delta === 0) return doc;
  let changed = false;
  const nodes = doc.nodes.map((node) => {
    const start = startOf(node, axis);
    if (start >= at) {
      changed = true;
      return axis === 'x' ? { ...node, x: node.x + delta } : { ...node, y: node.y + delta };
    }
    if (node.type === 'group' && start + sizeOf(node, axis) > at) {
      changed = true;
      return axis === 'x' ? { ...node, width: node.width + delta } : { ...node, height: node.height + delta };
    }
    return node;
  });
  const edges = doc.edges.map((edge) => {
    if (!edge.waypoints?.some((point) => point[axis] >= at)) return edge;
    changed = true;
    return { ...edge, waypoints: edge.waypoints.map((point) => (point[axis] >= at ? { ...point, [axis]: point[axis] + delta } : point)) };
  });
  // A sketch goes with what it was drawn beside: the strokes that lie wholly past the line.
  const strokes = inkOf(doc)
    .filter((stroke) => {
      const points = inkAbsolutePoints(stroke);
      return points.length > 0 && points.every((point) => point[axis] >= at);
    })
    .map((stroke) => stroke.id);
  if (!changed && strokes.length === 0) return doc;
  const moved: DraftDocument = changed ? { ...doc, nodes, edges } : doc;
  return translateInk(moved, strokes, axis === 'x' ? delta : 0, axis === 'y' ? delta : 0);
}
