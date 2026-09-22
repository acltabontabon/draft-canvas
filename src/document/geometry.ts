import { LIMITS } from './limits';
import { clamp } from '../lib/math';
import type { DraftDocument } from './types';

/**
 * Plain rectangle arithmetic over a document: no React, no node creation, nothing that edits.
 *
 * Split out of `operations.ts` so the Library — which only needs to decide where a new canvas's
 * starter goes and what viewport it opens at — doesn't carry the whole editing module in its chunk.
 * `operations.ts` re-exports what editing code reaches for (`boundsOf`, `freeOriginFor`, `INSERT_GAP`).
 */

export const clampCoord = (n: number) =>
  Number.isFinite(n)
    ? clamp(Math.round(n), -LIMITS.maxCoordinate, LIMITS.maxCoordinate)
    : 0;

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The union box of any rects — nodes, or the live drag rects `canvas/Canvas.tsx` snaps with. */
export function boundsOf(nodes: readonly Bounds[]): Bounds | null {
  if (nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Breathing room between a block of elements being inserted and whatever is already on the
 *  canvas — larger than `COMPANION_GAP`, because this separates two *diagrams*, not a node from
 *  the node that spawned it. */
export const INSERT_GAP = 96;

/**
 * Where to put the top-left corner of an incoming block of `size` so it lands clear of everything
 * already on the canvas — what an Architecture Starter needs, and deliberately not what
 * `placeNear` does.
 *
 * Two differences from `placeNear` matter. It never treats a boundary as transparent: dropping a
 * whole architecture inside somebody's existing boundary would silently reparent nothing but would
 * read as a mistake, so a `group` is an obstacle here even though it is a legitimate landing spot
 * for a single companion node. And it does not search: right of the existing bounds is *provably*
 * free, which is worth more than a cleverer position that has to be verified. An empty canvas gets
 * the block centred on the origin instead, so the very first thing a user inserts sits where the
 * viewport already is.
 *
 * Nothing already on the canvas is ever moved. Cost is one pass over the nodes — no global layout.
 */
export function freeOriginFor(
  doc: DraftDocument,
  size: { width: number; height: number },
  gap: number = INSERT_GAP,
): { x: number; y: number } {
  const bounds = boundsOf(doc.nodes);
  if (!bounds) return { x: clampCoord(-size.width / 2), y: clampCoord(-size.height / 2) };
  const right = bounds.x + bounds.width + gap;
  // Only when the canvas has genuinely been dragged out to the coordinate limit does going right
  // stop being an option; below the existing content is the same guarantee on the other axis.
  if (right + size.width <= LIMITS.maxCoordinate) return { x: clampCoord(right), y: clampCoord(bounds.y) };
  return { x: clampCoord(bounds.x), y: clampCoord(bounds.y + bounds.height + gap) };
}

/**
 * The viewport that shows a block of `size` centred on the origin — where
 * `freeOriginFor` puts the first thing inserted on an empty canvas.
 *
 * Needed when a canvas is *created* already holding an Architecture Starter.
 * The editor opens at `document.viewport` verbatim and never fits on open (so
 * a returning user lands exactly where they left off), which means a seeded
 * canvas has to carry the right viewport before the editor ever mounts.
 * `padding` leaves air around the block; zoom is capped at 1 so a small
 * starter is not blown up to fill a large screen.
 */
export function openingViewportFor(
  size: { width: number; height: number },
  screen: { width: number; height: number },
  padding = 0.8,
): { x: number; y: number; zoom: number } {
  const fit = Math.min(
    (padding * screen.width) / Math.max(size.width, 1),
    (padding * screen.height) / Math.max(size.height, 1),
  );
  const zoom = clamp(fit, 0.1, 1);
  return { x: screen.width / 2, y: screen.height / 2, zoom };
}

/** Breathing room around a diagram's content when it is fit to view on opening, in CSS pixels. */
export const OPEN_FIT_PADDING = 48;

/** The zoom floor `<ReactFlow>` itself enforces (`Canvas.tsx`'s `minZoom` prop) — a fit that asked
 *  for anything further out would just have `<ReactFlow>` clamp it there anyway. */
export const OPEN_FIT_MIN_ZOOM = 0.1;

/**
 * The viewport that shows all of `bounds` when an existing diagram is opened: centred, at 100% if
 * it already fits, or zoomed out just enough to show all of it with `padding` to spare otherwise —
 * never zoomed in past 100% for a diagram smaller than the screen. `null` when there is nothing to
 * fit (an empty diagram, or a screen not yet measured) — the caller's own starting viewport stands.
 *
 * Deliberately not `frameFor` (`Canvas.tsx`'s equivalent for stepping into a room): that one keeps
 * its own padding and zoom floor, chosen for a camera move the user is already mid-navigation for,
 * and the two are free to diverge from each other without either needing to change.
 */
export function openFitViewport(
  bounds: Bounds | null,
  screen: { width: number; height: number },
  padding = OPEN_FIT_PADDING,
): { x: number; y: number; zoom: number } | null {
  if (!bounds || screen.width <= 0 || screen.height <= 0) return null;
  const zoom = clamp(
    Math.min(
      (screen.width - padding * 2) / Math.max(bounds.width, 1),
      (screen.height - padding * 2) / Math.max(bounds.height, 1),
    ),
    OPEN_FIT_MIN_ZOOM,
    1,
  );
  return {
    x: (screen.width - bounds.width * zoom) / 2 - bounds.x * zoom,
    y: (screen.height - bounds.height * zoom) / 2 - bounds.y * zoom,
    zoom,
  };
}
