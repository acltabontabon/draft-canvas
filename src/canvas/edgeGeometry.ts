/**
 * Small geometry helpers shared between `DraftEdgeView` and
 * `EdgeInspectorPopover` — split out into their own module (rather than
 * exported from a component file) purely so both keep fast refresh working;
 * neither of these is itself a component.
 */
import type { useInternalNode } from '@xyflow/react';
import { anchorBandOf } from '../document/queueGeometry';
import type { DraftNodeType } from '../document/types';
import type { Rect } from '../edges/routing';

export type InternalNode = NonNullable<ReturnType<typeof useInternalNode>>;

/**
 * `type` opts the rect into its node kind's anchor band (a queue-family node's tube) — routing
 * callers pass it; popover-placement callers, which only want the box, leave it out.
 */
export function rectOfInternal(node: InternalNode, type?: DraftNodeType): Rect | null {
  const width = node.measured?.width ?? node.width;
  const height = node.measured?.height ?? node.height;
  if (width == null || height == null) return null;
  const rect: Rect = {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    width,
    height,
  };
  const band = type ? anchorBandOf({ type, y: rect.y, height }) : undefined;
  return band ? { ...rect, anchorBand: band } : rect;
}

/**
 * Whether a UI element floating above `(x, y)` at roughly `ATTACHMENT_ROW_NOMINAL_REACH`
 * pixels tall would land inside the connector's own source or target node — the
 * short-connector failure mode both `EdgeAttachmentRow` and `EdgeInspectorPopover`
 * avoid by flipping to sit below the connector instead. See `EdgeAttachmentRow`'s
 * fuller comment in `DraftEdgeView.tsx` for why this is a single-point check, not a
 * real box-overlap test.
 */
const NOMINAL_REACH = 150;
const GAP = 12;

export function attachmentRowBelowsSourceOrTarget(x: number, y: number, sourceRect: Rect, targetRect: Rect): boolean {
  const bottom = y - GAP;
  const top = bottom - NOMINAL_REACH;
  const overlapsRect = (rect: Rect) =>
    x > rect.x && x < rect.x + rect.width && rect.y < bottom && rect.y + rect.height > top;
  return overlapsRect(sourceRect) || overlapsRect(targetRect);
}

export interface ScreenRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/**
 * Shifts a popover's desired horizontal center just far enough to clear any obstacle it would
 * otherwise overlap — `EdgeInspectorPopover`'s guard for a short connector whose label point sits
 * in open canvas (so `attachmentRowBelowsSourceOrTarget`'s single-point check passes) while the
 * popover itself, several times wider than the gap between two nearby nodes, still reaches into
 * one of them. All rects are screen space. An obstacle only constrains the result if it vertically
 * overlaps the popover's own span; whichever side of `desiredCenterX` it falls on becomes a
 * one-sided bound. If both sides end up constrained past each other (nodes too close together for
 * the popover to ever fit between them, or a diagonal connector whose obstacle straddles the
 * center), the desired center is returned unclamped rather than fighting for a position that
 * doesn't exist.
 */
export function clampPopoverCenterX(
  desiredCenterX: number,
  halfWidth: number,
  gap: number,
  popoverTop: number,
  popoverBottom: number,
  obstacles: ScreenRect[],
): number {
  let left = -Infinity;
  let right = Infinity;
  for (const o of obstacles) {
    if (o.top >= popoverBottom || o.bottom <= popoverTop) continue;
    if (o.right <= desiredCenterX) left = Math.max(left, o.right + gap + halfWidth);
    else if (o.left >= desiredCenterX) right = Math.min(right, o.left - gap - halfWidth);
  }
  if (left > right) return desiredCenterX;
  return Math.min(Math.max(desiredCenterX, left), right);
}
