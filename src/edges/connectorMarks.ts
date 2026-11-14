/**
 * A connector's marks — its attachment chips and its open-point tab — as one row, placed from its
 * words.
 *
 * They used to be placed by two rules that knew nothing of each other or of the words: the chip row
 * hung a fixed gap off the bare label point, centred on the line (so beside an upright run it sat on
 * the line, away from the words to its side), and the tab went beside the words in reading direction.
 * Each looked like a pill floating near the connector rather than a note on it, and the two could
 * land on each other.
 *
 * Now they read outward from the line in one order: line, words, marks. The row holds the chips and
 * then the tab, the order a shape's marker rail keeps (`document/markerRail.ts`), and sits one gap
 * beyond the words — above a label over a level run, below a caption under one, under the words
 * beside an upright run, aligned to the edge they start from. A connector with no words gets the row
 * where its words would be. A row that would land on either of the connector's own shapes moves to
 * the other side of the line (or above the words beside an upright run).
 *
 * Pure geometry, shared by the canvas (`DraftEdgeView`), the exporter (`describe.ts`) and Presentation
 * Mode's callout anchor, so the three can never disagree about where a mark is.
 */
import type { Attachment, Side } from '../document/types';
import { MARKER_GAP, MARKER_SIZE } from '../openPoints/marker';
import type { TextMeasurer } from '../render/text/measure';
import { ATTACHMENT_CHIP_HEIGHT, attachmentRowWidth } from './attachmentChips';
import { LABEL_LINE_GAP, type Rect } from './routing';

/** Between a connector's words (or its condition chip) and its row of marks. */
export const MARK_ROW_GAP = 4;

export interface MarkRowInput {
  /** The label point the words and marks are placed from (lane-nudged, as both renderers draw it). */
  point: { x: number; y: number };
  /** Whether the stretch at the point is upright: words then sit beside it, not over or under it. */
  upright: boolean;
  /** The side a chip would take there when the connector has no words (`labelChipSide`). */
  side: Side;
  /** The words drawn at this point: label chip, recovery label or relationship caption. */
  words?: Rect;
  /** The condition/cadence chip, which stacks under the point. */
  condition?: Rect;
  /** The connector's resting chip row width (`attachmentRowWidth`); 0 when it has none. */
  attachmentsWidth: number;
  openPoint: boolean;
  source: Rect;
  target: Rect;
}

export interface MarkRow {
  /** The whole row. */
  box: Rect;
  /** Where the chip row goes: its box, and the edge the canvas anchors it by — a chip row there is
   *  measured by the browser, so it is pinned at the side that must not move (the tab's, or the
   *  words'), and its width may differ by a pixel from the measured one without touching either. */
  attachments?: { box: Rect; anchor: 'start' | 'middle' | 'end'; anchorX: number };
  /** The open-point tab's centre. */
  openPoint?: { x: number; y: number };
  /** Whether the row is below its line (or under its words beside an upright one): attachment cards
   *  then open downward, away from the line. */
  below: boolean;
}

const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Where the row goes, or `null` when the connector has no marks. */
export function connectorMarkRow(input: MarkRowInput): MarkRow | null {
  const { attachmentsWidth, openPoint } = input;
  if (attachmentsWidth <= 0 && !openPoint) return null;
  const width = attachmentsWidth + (openPoint ? MARKER_SIZE : 0) + (attachmentsWidth > 0 && openPoint ? MARKER_GAP : 0);
  const height = attachmentsWidth > 0 ? Math.max(ATTACHMENT_CHIP_HEIGHT, MARKER_SIZE) : MARKER_SIZE;

  const place = (flip: boolean) => (input.upright ? besideUpright(input, width, height, flip) : overLevel(input, width, height, flip));
  let row = place(false);
  const own = [input.source, input.target];
  if (own.some((rect) => overlaps(row.box, rect))) {
    const flipped = place(true);
    if (!own.some((rect) => overlaps(flipped.box, rect))) row = flipped;
  }
  return layoutRow(row.box, row.anchor, row.below, attachmentsWidth, openPoint);
}

interface Placed {
  box: Rect;
  /** How the row lines up: centred on the words, or from the edge nearest the line. */
  anchor: 'start' | 'middle' | 'end';
  below: boolean;
}

/** Over or under a level run: centred on the words, one gap beyond them (and the condition chip, when
 *  it stacks on that side). `flip` takes the other side of the line. */
function overLevel(input: MarkRowInput, width: number, height: number, flip: boolean): Placed {
  const { point, words, condition } = input;
  const wordsSide: 'top' | 'bottom' = words ? (words.y + words.height / 2 < point.y ? 'top' : 'bottom') : input.side === 'bottom' ? 'bottom' : 'top';
  const side = flip ? (wordsSide === 'top' ? 'bottom' : 'top') : wordsSide;
  const centerX = words && !flip ? words.x + words.width / 2 : point.x;
  // Everything already stacked on this side of the line, nearest first.
  const stack = [words && !flip ? words : undefined, condition].filter((rect): rect is Rect => rect !== undefined)
    .filter((rect) => (side === 'top' ? rect.y + rect.height <= point.y + 0.5 : rect.y >= point.y - 0.5));
  let y: number;
  if (side === 'top') {
    const edge = stack.length ? Math.min(...stack.map((rect) => rect.y)) - MARK_ROW_GAP : point.y - LABEL_LINE_GAP;
    y = edge - height;
  } else {
    y = stack.length ? Math.max(...stack.map((rect) => rect.y + rect.height)) + MARK_ROW_GAP : point.y + LABEL_LINE_GAP;
  }
  return { box: { x: centerX - width / 2, y, width, height }, anchor: 'middle', below: side === 'bottom' };
}

/** Beside an upright run: on the words' side, under them (and the condition chip), starting where
 *  their text starts. `flip` puts it above the words instead. */
function besideUpright(input: MarkRowInput, width: number, height: number, flip: boolean): Placed {
  const { point, words, condition } = input;
  const side: 'left' | 'right' = words ? (words.x + words.width / 2 < point.x ? 'left' : 'right') : input.side === 'left' ? 'left' : 'right';
  const x = side === 'right' ? point.x + LABEL_LINE_GAP : point.x - LABEL_LINE_GAP - width;
  const anchor = side === 'right' ? 'start' : 'end';
  const stack = [words, condition].filter((rect): rect is Rect => rect !== undefined);
  if (flip) {
    const top = stack.length ? Math.min(...stack.map((rect) => rect.y)) : point.y - height / 2;
    return { box: { x, y: top - MARK_ROW_GAP - height, width, height }, anchor, below: false };
  }
  // No words: level with the point, where the words would have been.
  const y = stack.length ? Math.max(...stack.map((rect) => rect.y + rect.height)) + MARK_ROW_GAP : point.y - height / 2;
  return { box: { x, y, width, height }, anchor, below: true };
}

/** The chips then the tab, each centred on the row's height. */
function layoutRow(box: Rect, anchor: Placed['anchor'], below: boolean, attachmentsWidth: number, openPoint: boolean): MarkRow {
  const middle = box.y + box.height / 2;
  const row: MarkRow = { box, below };
  if (openPoint) row.openPoint = { x: box.x + box.width - MARKER_SIZE / 2, y: middle };
  if (attachmentsWidth > 0) {
    const chips: Rect = { x: box.x, y: middle - ATTACHMENT_CHIP_HEIGHT / 2, width: attachmentsWidth, height: ATTACHMENT_CHIP_HEIGHT };
    // Pinned at the tab when there is one, so a chip a pixel wider on screen never reaches it.
    row.attachments = openPoint
      ? { box: chips, anchor: 'end', anchorX: chips.x + chips.width }
      : { box: chips, anchor, anchorX: anchor === 'start' ? chips.x : anchor === 'end' ? chips.x + chips.width : chips.x + chips.width / 2 };
  }
  return row;
}

/** The resting width of a connector's chip row, measured as both renderers draw it. */
export function markRowAttachmentsWidth(attachments: readonly Attachment[] | undefined, measurer: TextMeasurer): number {
  return attachments?.length ? attachmentRowWidth(attachments, measurer) : 0;
}
