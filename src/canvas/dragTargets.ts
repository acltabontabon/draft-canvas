import { ATTACHABLE_TYPES, type DraftDocument, type DraftNodeType } from '../document/types';
import type { Rect } from '../edges/routing';

/** A drop must feel intentional — see the drag-to-attach wiring in `Canvas.tsx`. */
export const ATTACH_OVERLAP_RATIO = 0.65;
export const ATTACH_DWELL_MS = 250;

function rectArea(rect: Rect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function overlapArea(a: Rect, b: Rect): number {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

function centerInside(rect: Rect, target: Rect): boolean {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return cx >= target.x && cx <= target.x + target.width && cy >= target.y && cy <= target.y + target.height;
}

export interface AttachCandidates {
  /** Overlap alone is decisive enough to arm immediately, no dwell needed. */
  overlapId: string | null;
  /** The dragged node's centre is over this node — arms after a dwell. */
  centerHitId: string | null;
}

/**
 * Finds this frame's attach candidates for a dragged attachable node. Pure
 * and dwell-unaware on purpose: dwell is a *timer*, not something that can be
 * decided from a single frame — while the pointer sits still no further drag
 * events fire at all, so the caller (`Canvas.tsx`) owns a real `setTimeout`
 * keyed off `centerHitId` rather than re-checking elapsed time here.
 *
 * Two independent, sufficient rules decide `overlapId`: a strong overlap
 * measured against the *smaller* of the two areas, so the same threshold
 * works whether a large card lands on a small node or a small note lands on
 * a large one.
 */
export function evaluateAttachCandidates(
  draggedRect: Rect,
  draggedType: DraftNodeType,
  doc: DraftDocument,
  excludeIds: ReadonlySet<string>,
): AttachCandidates {
  if (!(ATTACHABLE_TYPES as readonly string[]).includes(draggedType)) {
    return { overlapId: null, centerHitId: null };
  }

  const candidates = doc.nodes.filter((node) => node.type !== 'group' && !excludeIds.has(node.id));

  let overlapId: string | null = null;
  let bestOverlap = 0;
  let centerHitId: string | null = null;

  for (const node of candidates) {
    const rect: Rect = { x: node.x, y: node.y, width: node.width, height: node.height };
    const overlap = overlapArea(draggedRect, rect);
    if (overlap > bestOverlap) {
      const ratio = overlap / Math.min(rectArea(draggedRect), rectArea(rect));
      if (ratio >= ATTACH_OVERLAP_RATIO) {
        bestOverlap = overlap;
        overlapId = node.id;
      }
    }
    if (centerHitId === null && centerInside(draggedRect, rect)) centerHitId = node.id;
  }

  return { overlapId, centerHitId };
}

/**
 * The deepest (most specific) boundary containing `point` — nested boundaries
 * resolve to the smallest one that still contains the point, not whichever
 * happens to appear first in the document.
 */
export function deepestBoundaryAt(
  point: { x: number; y: number },
  doc: DraftDocument,
  excludeIds: ReadonlySet<string>,
): string | null {
  let best: { id: string; area: number } | null = null;
  for (const node of doc.nodes) {
    if (node.type !== 'group' || excludeIds.has(node.id)) continue;
    const inside =
      point.x >= node.x &&
      point.x <= node.x + node.width &&
      point.y >= node.y &&
      point.y <= node.y + node.height;
    if (!inside) continue;
    const area = node.width * node.height;
    if (!best || area < best.area) best = { id: node.id, area };
  }
  return best?.id ?? null;
}
