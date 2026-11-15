import { ATTACHABLE_TYPES, type DraftDocument, type DraftNode, type DraftNodeType } from '../document/types';
import { centerOf, overlapArea, pointInBox } from '../lib/math';
import { hasAttachmentRoom } from '../document/operations';
import type { Rect } from '../edges/routing';

/** A drop must feel intentional — see the drag-to-attach wiring in `Canvas.tsx`. */
const ATTACH_OVERLAP_RATIO = 0.65;
const ATTACHABLE_SET: ReadonlySet<string> = new Set(ATTACHABLE_TYPES);
export const ATTACH_DWELL_MS = 250;

function rectArea(rect: Rect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function centerInside(rect: Rect, target: Rect): boolean {
  return pointInBox(centerOf(rect), target);
}

export interface AttachCandidates {
  /** Overlap alone is decisive enough to arm immediately, no dwell needed. */
  overlapId: string | null;
  /** The dragged node's centre is over this node — arms after a dwell. */
  centerHitId: string | null;
}

// Evaluated on every pointer-move frame of a drag, while the committed `nodes` array stays the same
// object until the drop — so the filtered, z-sorted list is built once per (nodes, exclusion) pair.
// A caller that holds one exclusion set for the whole gesture (`Canvas.tsx` does) is answered from the
// set itself; any other is keyed by its ids, which costs a sorted join per call.
interface Candidates {
  byKey: Map<string, DraftNode[]>;
  bySet: WeakMap<ReadonlySet<string>, DraftNode[]>;
}
const candidateCache = new WeakMap<readonly DraftNode[], Candidates>();

function attachCandidatesFor(nodes: readonly DraftNode[], excludeIds: ReadonlySet<string>): DraftNode[] {
  let cache = candidateCache.get(nodes);
  if (!cache) candidateCache.set(nodes, (cache = { byKey: new Map(), bySet: new WeakMap() }));
  const held = cache.bySet.get(excludeIds);
  if (held) return held;
  const key = [...excludeIds].sort().join('|');
  let candidates = cache.byKey.get(key);
  if (!candidates) {
    // A full host never arms: dropping there could only refuse (or, worse, lose content).
    candidates = nodes
      // A sequence is too large a thing to drop a note "onto": it would arm wherever the note went.
      .filter((node) => node.type !== 'group' && node.type !== 'sequence' && !excludeIds.has(node.id) && hasAttachmentRoom(node, 'node'))
      .sort((a, b) => b.z - a.z);
    cache.byKey.set(key, candidates);
  }
  cache.bySet.set(excludeIds, candidates);
  return candidates;
}

/** Whether a dragged shape of this type can be folded into another's attachments at all — the one
 *  question that decides whether a frame needs the rest of this file. */
export function isAttachableType(type: DraftNodeType): boolean {
  return ATTACHABLE_SET.has(type);
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
 *
 * A dragged Note/Code card passes a **zero-size rect at its aim point** rather than its own
 * rectangle: while its capsule stands in for it (`capsuleCollapse.ts`) that rectangle is not on
 * screen, so arming off it would highlight a target nowhere near what the pointer is over. The
 * arithmetic here already yields exactly the right semantics for that case with no special
 * casing — no area means no `overlapId`, so every shape arms through the deliberate dwell, and
 * `centerInside` reduces to "is the aim point in this node". `tests/drag-targets.test.ts` pins it.
 */
export function evaluateAttachCandidates(
  draggedRect: Rect,
  draggedType: DraftNodeType,
  doc: DraftDocument,
  excludeIds: ReadonlySet<string>,
): AttachCandidates {
  if (!isAttachableType(draggedType)) {
    return { overlapId: null, centerHitId: null };
  }

  // Sorted topmost-first: `doc.nodes`' array order tracks insertion, not stacking — bringToFront/
  // sendToBack mutate only `z`, never reorder the array — so an unsorted scan can hit an occluded
  // node before the one actually rendered under the cursor. Matches the z-ordering `Canvas.tsx`'s
  // `onConnectEnd` and `DraftEdgeView`'s `findDropNode` already apply to their own hit-testing.
  const candidates = attachCandidatesFor(doc.nodes, excludeIds);

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

