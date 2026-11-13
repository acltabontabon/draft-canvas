/**
 * The marker rail: the one row every small mark on a shape sits in, above its top-right corner.
 *
 * A shape can carry a technology mark, an attachment tab and an open-point tab. Each used to pick
 * its own spot around that corner without knowing about the others: the attachment badge above the
 * top edge, the open-point tab off the shoulder, the technology mark beside the right edge. With two
 * of them present they overlapped, and the two beside the right edge sat exactly where a connector
 * leaving that side puts its label.
 *
 * Here they share one row, the same height, read from the corner inward in a fixed order:
 * technology (what the shape is), attachments (what is filed on it), open points (what is still
 * unsettled about it). The row sits wholly above the top edge, so nothing in it touches the shape's
 * own outline, its connectors' side anchors or the label of a connector leaving its right side.
 *
 * Pure geometry in the shape's own coordinates, so the canvas, the exporter and the agent's extent
 * all place the marks from this one function. The rail never changes a shape's size, its handles or
 * routing.
 */

/** Every mark in the rail is this tall; the technology mark and a lone tab are this wide too. */
export const RAIL_SIZE = 16;
/** Between two marks in the rail. */
export const RAIL_GAP = 4;
/** Between the rail and the shape's top edge: clear of the outline and of a selected shape's corner handle. */
export const RAIL_LIFT = 5;

/** The room one digit of an attachment count takes. Fixed, so the rail needs no text measurer. */
const COUNT_DIGIT = 6;

/** An attachment tab is a square for one attachment and grows by its count for several. */
export function attachmentTabWidth(count: number): number {
  return count < 2 ? RAIL_SIZE : RAIL_SIZE + 2 + COUNT_DIGIT * String(count).length;
}

export interface RailContents {
  /** The shape shows a technology mark (see `nodes/technology.ts`). */
  technology?: boolean;
  /** How many attachments the shape carries. */
  attachments?: number;
  /** The shape has an unresolved open point. */
  openPoints?: boolean;
}

export interface MarkerRail {
  technology?: { x: number; y: number };
  attachments?: { x: number; y: number; width: number };
  openPoint?: { x: number; y: number };
}

/** A boundary's open-point tab sits inside its corner; see `openPoints/marker.ts`. */
const BOUNDARY_TAB_INSET = 8;

/**
 * Where each mark the shape carries sits, as top-left corners in the shape's own coordinates.
 *
 * Two shapes keep a mark out of the rail. A data store's technology mark belongs beside its
 * compact glyph, inside its own box, so it takes no room here. A boundary's open-point tab sits
 * inside its corner, which is empty and says "this area" more plainly than a tab above a dashed
 * line would.
 */
export function markerRail(node: { type: string; width: number }, contents: RailContents): MarkerRail {
  const y = -(RAIL_SIZE + RAIL_LIFT);
  const rail: MarkerRail = {};
  let right = node.width;
  const take = (width: number): number => {
    const x = right - width;
    right = x - RAIL_GAP;
    return x;
  };
  if (contents.technology && node.type !== 'database') rail.technology = { x: take(RAIL_SIZE), y };
  const count = contents.attachments ?? 0;
  if (count > 0) {
    const width = attachmentTabWidth(count);
    rail.attachments = { x: take(width), y, width };
  }
  if (contents.openPoints) {
    rail.openPoint =
      node.type === 'group'
        ? { x: node.width - RAIL_SIZE - BOUNDARY_TAB_INSET, y: BOUNDARY_TAB_INSET }
        : { x: take(RAIL_SIZE), y };
  }
  return rail;
}
