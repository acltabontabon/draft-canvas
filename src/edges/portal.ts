import type { DraftEdge, DraftNode } from '../document/types';
import type { PortalSlot } from './portalPlan';
import { anchorPoint, sideSpan, type Rect, type RoutedEdge } from './routing';

/**
 * A connector drawn as a portal (`DraftEdge.portal`): a short stub leaving its source and one arriving
 * at its target, each ending in a small ring and naming where the other end is, with nothing drawn
 * between them. Pure geometry, shared by the canvas and the export so the two cannot drift.
 *
 * Where each stub sits on its shape is `portalPlan.ts`'s call (a side clear of the real lines there);
 * `portalOf` takes the two points and draws from them. Nothing about the connector itself changes:
 * turning a portal back into a line draws exactly the line it had.
 */

/** Canvas units: the stub's length, the ring's radius, and the gap before the words. */
export const PORTAL_STUB = 26;
export const PORTAL_RING = 4;
const WORDS_GAP = 6;
/** A portal names the shape at its other end; a long name is cut so two portals on one side still fit. */
const NAME_MAX = 26;

type Side = RoutedEdge['source']['side'];

const NORMAL: Record<Side, { x: number; y: number }> = {
  top: { x: 0, y: -1 },
  right: { x: 1, y: 0 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
};

export interface PortalEnd {
  /** The stub: from the shape to the ring (out), or from the ring to the shape (in). */
  line: string;
  ring: { x: number; y: number };
  /** The shape's own side this end is on: which way the words sit. */
  side: Side;
  /** Where the words attach: beyond the ring, away from the shape. */
  at: { x: number; y: number };
  text: string;
}

export interface Portal {
  out: PortalEnd;
  into: PortalEnd;
  /** Both stubs as one path, the arriving one last, so an arrowhead at its end lands on the target. */
  d: string;
}

const round = (value: number) => Math.round(value * 100) / 100;

function end(anchor: RoutedEdge['source'], arriving: boolean, text: string): PortalEnd {
  const normal = NORMAL[anchor.side];
  const far = { x: round(anchor.x + normal.x * PORTAL_STUB), y: round(anchor.y + normal.y * PORTAL_STUB) };
  const ring = { x: round(far.x + normal.x * PORTAL_RING), y: round(far.y + normal.y * PORTAL_RING) };
  const at = { x: round(ring.x + normal.x * (PORTAL_RING + WORDS_GAP)), y: round(ring.y + normal.y * (PORTAL_RING + WORDS_GAP)) };
  const near = `${round(anchor.x)} ${round(anchor.y)}`;
  return { line: arriving ? `M${far.x} ${far.y}L${near}` : `M${near}L${far.x} ${far.y}`, ring, side: anchor.side, at, text };
}

/** A shape's name as a portal says it: its first line, cut short, or a plain word when it has none. */
export function portalName(node: Pick<DraftNode, 'text'> | undefined): string {
  const name = (node?.text ?? '').split('\n')[0]!.trim();
  if (!name) return 'shape';
  return name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1).trimEnd()}…` : name;
}

/**
 * Where a slot (`portalPlan.ts`) is on a shape's outline: the point a stub leaves from or arrives at.
 * Placed by the router's own rule (`anchorPoint`), so a stub meets a Data Store's or a Queue's drawn
 * glyph exactly where a line would, not the edge of the wider box its name makes.
 */
export function slotPoint(rect: Rect, slot: PortalSlot): RoutedEdge['source'] {
  const span = sideSpan(rect, slot.side).length;
  const offset = span > 0 ? Math.max(0.08, Math.min(0.92, 0.5 + slot.shift / span)) : 0.5;
  return { ...anchorPoint(rect, slot.side, offset), side: slot.side };
}

export function portalOf(
  route: Pick<RoutedEdge, 'source' | 'target'>,
  edge: Pick<DraftEdge, 'directed' | 'label'>,
  names: { source: string; target: string },
): Portal {
  const mark = edge.directed ? '→' : '–';
  const label = edge.label?.split('\n')[0]?.trim();
  // The connector's own label rides with the leaving stub: there is no line left to hang it on.
  const out = end(route.source, false, `${mark} ${names.target}${label ? ` · ${label}` : ''}`);
  const into = end(route.target, true, `${names.source} ${mark}`);
  return { out, into, d: `${out.line}${into.line}` };
}

/** Where a portal end's words go, as a box of the given size: beyond the ring, centred on the stub. */
export function portalWordsRect(end: PortalEnd, width: number, height: number): { left: number; top: number } {
  switch (end.side) {
    case 'right':
      return { left: end.at.x, top: end.at.y - height / 2 };
    case 'left':
      return { left: end.at.x - width, top: end.at.y - height / 2 };
    case 'top':
      return { left: end.at.x - width / 2, top: end.at.y - height };
    case 'bottom':
      return { left: end.at.x - width / 2, top: end.at.y };
  }
}
