/**
 * Small geometry helpers shared between `DraftEdgeView` and
 * `EdgeInspectorPopover` — split out into their own module (rather than
 * exported from a component file) purely so both keep fast refresh working;
 * neither of these is itself a component.
 */
import type { useInternalNode } from '@xyflow/react';
import type { Rect } from '../edges/routing';

export type InternalNode = NonNullable<ReturnType<typeof useInternalNode>>;

export function rectOfInternal(node: InternalNode): Rect | null {
  const width = node.measured?.width ?? node.width;
  const height = node.measured?.height ?? node.height;
  if (width == null || height == null) return null;
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    width,
    height,
  };
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
