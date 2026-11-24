import type { DraftNode, EdgeAnchor } from '../document/types';
import { sequenceLayoutFor, sizingContext } from '../nodes/describe';
import type { Rect } from './routing';

/** A participant attachment is a point on the current lifeline, including after a relayout. */
export function sequenceAnchorRect(node: DraftNode | undefined, frame: Rect, anchor: EdgeAnchor | undefined): Rect {
  if (node?.type !== 'sequence' || !anchor?.participantId) return frame;
  const layout = sequenceLayoutFor(frame.width === node.width && frame.height === node.height
    ? node
    : { ...node, width: frame.width, height: frame.height }, sizingContext());
  const column = layout.columns.find((entry) => entry.id === anchor.participantId);
  if (!column) return frame;
  return {
    x: frame.x + column.x,
    y: frame.y + column.lifeTop + Math.max(0, column.lifeBottom - column.lifeTop) * anchor.offset,
    width: 0,
    height: 0,
  };
}
