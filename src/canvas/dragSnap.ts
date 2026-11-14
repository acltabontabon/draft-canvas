import type { NodeChange } from '@xyflow/react';
import { maxSizeFor } from '../document/factory';
import { boundsOf } from '../document/operations';
import type { DraftEdge, DraftNode } from '../document/types';
import { rectOf, type Rect } from '../edges/routing';
import { straightOffset } from '../edges/straight';
import type { DraftRfNode } from './projection';
import { minResizeSizeFor, snapResize } from './resizeSnap';
import { computeSnap, snapReach, type Guide, type SnapLink } from './snapping';

/**
 * Alignment snapping for the gestures React Flow streams into `onNodesChange` — a drag's position
 * changes and a resize's dimension changes. Kept apart from `Canvas.tsx` and free of the store, so
 * the one place that decides how far a shape is pulled (`snapReach`) is tested at every zoom.
 */

/** Stable empty array, so `sameGuides` keeps short-circuiting rather than seeing a new `[]`. */
export const NO_GUIDES: Guide[] = [];

const NO_SNAP = { changes: [] as NodeChange<DraftRfNode>[], guides: NO_GUIDES };

/** A connector between a dragged shape and a resting one: what drag snapping straightens. */
export interface DragLink {
  edge: DraftEdge;
  /** The dragged end's shape as it was when the gesture began. */
  moving: DraftNode;
  /** The resting end, with its anchor band. */
  fixed: Rect;
  movingIsSource: boolean;
}

/** What a drag snaps against, gathered once when the gesture begins. */
export interface DragSnapContext {
  statics: Rect[];
  /** The resting shapes less boundaries, for even spacing. */
  spacing: Rect[];
  links: DragLink[];
  /** Where each dragged shape began, so a frame's move is known from any of them. */
  origin: Map<string, { x: number; y: number }>;
}

export const NO_DRAG_SNAP: DragSnapContext = { statics: [], spacing: [], links: [], origin: new Map() };

/** What a frame's snapping depends on besides the changes themselves. */
export interface SnapFrame {
  /** The camera's zoom: the pull is the same distance on screen at every zoom. */
  zoom: number;
  /** Alt is held: nothing snaps (`snapBypass.ts`). */
  bypass: boolean;
}

/** Each connector's straight line, measured with the dragged shapes moved by `shift`. */
function linksAt(links: readonly DragLink[], shift: { x: number; y: number }): SnapLink[] {
  const out: SnapLink[] = [];
  for (const link of links) {
    const live = rectOf({ ...link.moving, x: link.moving.x + shift.x, y: link.moving.y + shift.y });
    const offset = link.movingIsSource ? straightOffset(link.edge, live, link.fixed) : straightOffset(link.edge, link.fixed, live);
    if (!offset) continue;
    const fixedEnd = link.movingIsSource ? offset.to : offset.from;
    const movingEnd = link.movingIsSource ? offset.from : offset.to;
    const across = offset.axis === 'y' ? 'x' : 'y';
    out.push({
      axis: offset.axis,
      // `delta` moves the target; when the dragged shape is the source it moves the other way.
      delta: link.movingIsSource ? -offset.delta : offset.delta,
      at: fixedEnd[offset.axis],
      from: Math.min(fixedEnd[across], movingEnd[across]),
      to: Math.max(fixedEnd[across], movingEnd[across]),
    });
  }
  return out;
}

/** A React Flow node by id — its live position and measured size mid-gesture. */
export type NodeLookup = (id: string) => Pick<DraftRfNode, 'position' | 'width' | 'height' | 'measured'> | undefined;

/**
 * Nudges an in-flight drag onto alignment with its neighbours, and reports the
 * guides to draw. Returns the changes untouched when nothing is close enough.
 */
export function snapChanges(
  changes: NodeChange<DraftRfNode>[],
  nodeById: NodeLookup,
  context: DragSnapContext,
  frame: SnapFrame,
): { changes: NodeChange<DraftRfNode>[]; guides: Guide[] } {
  if (frame.bypass) return { ...NO_SNAP, changes };
  const moves = changes.filter(
    (change) => change.type === 'position' && change.dragging === true && change.position,
  );
  if (moves.length === 0 || (context.statics.length === 0 && context.links.length === 0)) return { ...NO_SNAP, changes };

  const rects: Rect[] = [];
  for (const change of moves) {
    if (change.type !== 'position' || !change.position) continue;
    const node = nodeById(change.id);
    rects.push({
      x: change.position.x,
      y: change.position.y,
      width: node?.width ?? node?.measured?.width ?? 0,
      height: node?.height ?? node?.measured?.height ?? 0,
    });
  }

  const bounds = boundsOf(rects);
  if (!bounds) return { ...NO_SNAP, changes };

  // The whole selection moves rigidly, so any one dragged shape tells how far this frame has it.
  let shift: { x: number; y: number } | null = null;
  for (const change of moves) {
    const origin = change.type === 'position' && change.position ? context.origin.get(change.id) : undefined;
    if (origin && change.type === 'position' && change.position) {
      shift = { x: change.position.x - origin.x, y: change.position.y - origin.y };
      break;
    }
  }
  const links = shift && context.links.length > 0 ? linksAt(context.links, shift) : [];
  const reach = snapReach(frame.zoom);
  const snap = computeSnap(bounds, context.statics, reach.threshold, { links, spacing: context.spacing, connectorThreshold: reach.connectorThreshold });
  if (snap.dx === 0 && snap.dy === 0) return { changes, guides: snap.guides };

  return {
    guides: snap.guides,
    changes: changes.map((change) =>
      change.type === 'position' && change.dragging === true && change.position
        ? { ...change, position: { x: change.position.x + snap.dx, y: change.position.y + snap.dy } }
        : change,
    ),
  };
}

/**
 * The resize counterpart to `snapChanges` — see `snapResize` for which edges snap. The rect the node
 * started the gesture with is the document's: nothing is written to it until the gesture ends.
 *
 * The terminal frame (`resizing: false`) isn't snapped again: React Flow reports its own raw,
 * unsnapped size there, so it's replaced with the rect the last live frame actually showed —
 * otherwise the far edge of a snapped top/left resize would commit off by the snap. That holds with
 * Alt down too: the live frames were then unsnapped, and the terminal one commits what they showed.
 */
export function snapResizeChanges(
  changes: NodeChange<DraftRfNode>[],
  nodeById: NodeLookup,
  statics: readonly Rect[],
  documentNodes: ReadonlyMap<string, DraftNode>,
  frame: SnapFrame,
): { changes: NodeChange<DraftRfNode>[]; guides: Guide[] } {
  // Snapping applies equally to the terminal (`resizing: false`) frame —
  // that one commits to the document, so skipping it would mean the guide
  // shown mid-gesture never actually took effect. `resizing` is only ever
  // present (true or false) on a change dispatched by NodeResizer itself;
  // React Flow's own ResizeObserver fires dimension changes with no
  // `resizing` field at all whenever a node is first measured (on mount, or
  // whenever its DOM size changes for any other reason) — those must never
  // be mistaken for a live resize, or opening a diagram whose nodes happen
  // to already be aligned shows guides for a gesture that never happened.
  const resizing = changes.filter(
    (change) => change.type === 'dimensions' && change.dimensions && change.resizing !== undefined,
  );
  if (resizing.length === 0) return { ...NO_SNAP, changes };

  let result = changes;
  const guides: Guide[] = [];
  const reach = snapReach(frame.zoom);

  for (const change of resizing) {
    if (change.type !== 'dimensions' || !change.dimensions) continue;
    const live = nodeById(change.id);
    const node = documentNodes.get(change.id);
    if (!live || !node) continue;

    if (change.resizing === false) {
      const width = live.width ?? live.measured?.width;
      const height = live.height ?? live.measured?.height;
      if (width === undefined || height === undefined) continue;
      result = result.map((c) => (c === change ? { ...change, dimensions: { width, height } } : c));
      continue;
    }

    // A proportional resize (a Junction stays round) would need both axes snapped together.
    if (frame.bypass || statics.length === 0 || node.type === 'ellipse') continue;
    const posChange = changes.find((c) => c.type === 'position' && c.id === change.id && c.position);
    const position = (posChange?.type === 'position' ? posChange.position : undefined) ?? live.position;
    const min = minResizeSizeFor(node);
    const snap = snapResize(
      { x: node.x, y: node.y, width: node.width, height: node.height },
      { ...position, width: change.dimensions.width, height: change.dimensions.height },
      statics,
      { min, max: maxSizeFor(node.type) ?? { width: Infinity, height: Infinity } },
      reach.threshold,
    );
    guides.push(...snap.guides);
    if (snap.guides.length === 0) continue;

    const { x, y, width, height } = snap.rect;
    result = result.map((c) => {
      if (c === change) return { ...change, dimensions: { width, height } };
      if (c === posChange) return { ...posChange, position: { x, y } };
      return c;
    });
    // A top or left edge that snapped moves the node even on a frame React Flow sent no position for.
    if (!posChange && (x !== position.x || y !== position.y)) {
      result = [...result, { type: 'position', id: change.id, position: { x, y } }];
    }
  }

  return { changes: result, guides };
}
