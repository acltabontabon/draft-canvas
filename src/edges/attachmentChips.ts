/**
 * Attachments as a picture shows them: a connector's chip row at its label point, and a shape's
 * attachment tab in the marker rail above its top-right corner — the resting state of what `AttachmentPresentation.tsx`
 * and `DraftNodeView` draw on the canvas. Exports used to leave both out, so a note attached to a
 * connector simply wasn't in the PNG or SVG, with nothing to say it was ever there.
 *
 * Connectors are the one place with two renderers (see AGENTS.md): the geometry below is the
 * canvas's, restated from `canvas.css` — a change to the chip's look belongs in both.
 */
import type { Attachment, DraftEdge, DraftNode, Side } from '../document/types';
import type { Shape } from '../render/displayList';
import type { FontSpec } from '../render/text/fonts';
import { layoutText } from '../render/text/layout';
import type { TextMeasurer } from '../render/text/measure';
import type { Theme } from '../render/theme/tokens';
import { attachmentLookFor } from '../nodes/attachmentLook';
import type { Rect } from './routing';
import { RAIL_SIZE, attachmentTabWidth, markerRail } from '../document/markerRail';

/** How far a connector's attachment chip row floats off its label point, in flow units. */
export const ATTACHMENT_ROW_GAP = 12;

/**
 * Whether a UI element floating above `(x, y)` at roughly `NOMINAL_REACH`
 * pixels tall would land inside the connector's own source or target node — the
 * short-connector failure mode both a connector's attachment chip row and `EdgeInspectorPopover`
 * avoid by flipping to sit below the connector instead. A single-point check, not a real
 * box-overlap test: the row's own width is unknown until rendered, and its anchor point is what
 * decides which side reads as belonging to the connector.
 */
const NOMINAL_REACH = 150;

export function attachmentRowBelowsSourceOrTarget(x: number, y: number, sourceRect: Rect, targetRect: Rect, captionSide?: Side): boolean {
  // Words already above the line own that side: the row hangs below the line instead of on top of
  // them (a caption placed above a horizontal line was covered by its own connector's chip row).
  if (captionSide === 'top') return true;
  const bottom = y - ATTACHMENT_ROW_GAP;
  const top = bottom - NOMINAL_REACH;
  const overlapsRect = (rect: Rect) =>
    x > rect.x && x < rect.x + rect.width && rect.y < bottom && rect.y + rect.height > top;
  return overlapsRect(sourceRect) || overlapsRect(targetRect);
}

/** A label side, when the connector has a label that claims it — see `attachmentRowBelowsSourceOrTarget`. */
export function captionSideOf(edge: DraftEdge, labelSide: Side): Side | undefined {
  return edge.label ? labelSide : undefined;
}

interface ChipContext {
  theme: Theme;
  measurer: TextMeasurer;
}

// `.dc-attachment-chip`: 10px/700 uppercase, padding 3px 9px 3px 7px, 5px between icon and label
// and between chips; `.dc-attachment-chip[data-kind='note'] .dc-attachment-chip-icon` is a 6px dot.
const CHIP_FONT: FontSpec = { stack: 'sans', size: 10, weight: 700 };
const ICON_FONT: FontSpec = { stack: 'mono', size: 10, weight: 400 };
const CHIP_HEIGHT = 19;
const CHIP_GAP = 5;
const DOT = 6;

function chipWidth(attachment: Attachment, label: string, compact: boolean, measurer: TextMeasurer): number {
  const icon = attachment.type === 'code' ? measurer.width('{ }', ICON_FONT) : DOT;
  if (compact) return 5 + icon + 5;
  return 7 + icon + CHIP_GAP + measurer.width(label, CHIP_FONT) + 9;
}

/**
 * A connector's chip row, centred on `(x, y)` — its label point — and hung above it, or below when
 * `below`. More than one attachment rests compact (icons only), as the canvas does until reached for.
 */
export function describeAttachmentChips(attachments: readonly Attachment[], x: number, y: number, below: boolean, ctx: ChipContext): Shape[] {
  if (attachments.length === 0) return [];
  const compact = attachments.length > 1;
  const looks = attachments.map((attachment) => {
    const look = attachmentLookFor(ctx.theme, attachment);
    const label = look.label.toUpperCase();
    return { attachment, look, label, width: chipWidth(attachment, label, compact, ctx.measurer) };
  });
  const total = looks.reduce((sum, chip) => sum + chip.width, 0) + CHIP_GAP * (looks.length - 1);
  const top = below ? y + ATTACHMENT_ROW_GAP : y - ATTACHMENT_ROW_GAP - CHIP_HEIGHT;
  const shapes: Shape[] = [];
  let left = x - total / 2;
  for (const { attachment, look, label, width } of looks) {
    shapes.push({ t: 'rect', x: left, y: top, w: width, h: CHIP_HEIGHT, r: CHIP_HEIGHT / 2, fill: look.fill, stroke: { color: look.border, width: 1 } });
    const iconLeft = left + (compact ? 5 : 7);
    let iconWidth = DOT;
    if (attachment.type === 'code') {
      const icon = layoutText('{ }', { font: ICON_FONT, maxWidth: 40, lineHeight: CHIP_HEIGHT, measurer: ctx.measurer });
      iconWidth = icon.width;
      shapes.push({ t: 'text', x: iconLeft, y: top, layout: icon, font: ICON_FONT, fill: look.accent, align: 'start' });
    } else {
      shapes.push({ t: 'ellipse', cx: iconLeft + DOT / 2, cy: top + CHIP_HEIGHT / 2, rx: DOT / 2, ry: DOT / 2, fill: look.accent });
    }
    if (!compact) {
      const text = layoutText(label, { font: CHIP_FONT, maxWidth: 400, lineHeight: CHIP_HEIGHT, maxLines: 1, measurer: ctx.measurer });
      shapes.push({ t: 'text', x: iconLeft + iconWidth + CHIP_GAP, y: top, layout: text, font: CHIP_FONT, fill: look.accent, align: 'start' });
    }
    left += width + CHIP_GAP;
  }
  return shapes;
}

/** The count numeral beside the clip, when a shape carries several. The open-point tab's own numeral. */
const TAB_COUNT_FONT: FontSpec = { stack: 'sans', size: 9, weight: 700 };

/**
 * A shape's attachment tab, drawn in a box at the origin: a paperclip, and the count when there is
 * more than one. The same plate as an open-point tab (`openPoints/marker.ts`) in the canvas's
 * neutral ink, so the marks along a shape's rail read as one set and an open point's violet is the
 * only colour among them. It was a shadowed pill reading "<> 2", a second shape language next to
 * the square tab beside it. One function for the canvas and the exporter.
 */
export function describeAttachmentTab(count: number, ctx: { theme: Theme; measurer?: TextMeasurer }): Shape[] {
  const width = attachmentTabWidth(count);
  const ink = ctx.theme.textMuted;
  const several = count > 1;
  const shapes: Shape[] = [
    { t: 'rect', x: 0.5, y: 0.5, w: width - 1, h: RAIL_SIZE - 1, r: 4, fill: ctx.theme.edgeLabelBg, stroke: { color: ctx.theme.borderStrong, width: 1 } },
    {
      // One wire: down the outside, round the bottom, up and over, and down the inside. Three
      // strands, not a real clip's four: at this size a fourth closes the gaps and reads as a blob.
      t: 'group',
      translate: { x: several ? -1.5 : 0, y: 0 },
      children: [
        {
          t: 'path',
          d: 'M10.4 6.8 V10.6 a2.4 2.4 0 0 1 -4.8 0 V5.4 a1.4 1.4 0 0 1 2.8 0 V10.2',
          fill: 'none',
          stroke: { color: ink, width: 1.2, linecap: 'round' },
        },
      ],
    },
  ];
  if (several) {
    const layout = layoutText(String(count), {
      font: TAB_COUNT_FONT,
      maxWidth: width,
      lineHeight: TAB_COUNT_FONT.size * 1.35,
      maxLines: 1,
      measurer: ctx.measurer,
    });
    shapes.push({
      t: 'text',
      // Centred in what the clip leaves free.
      x: (11 + width - 3) / 2,
      y: RAIL_SIZE / 2 - layout.height / 2,
      layout,
      font: TAB_COUNT_FONT,
      fill: ink,
      align: 'middle',
    });
  }
  return shapes;
}

/**
 * A shape's attachment tab where the shape wears it: in its marker rail, in the shape's own
 * coordinates. `technology` says whether a technology mark sits at the corner ahead of it.
 */
export function describeAttachmentBadge(node: DraftNode, ctx: ChipContext, technology = false): Shape[] {
  const count = node.attachments?.length ?? 0;
  const at = markerRail(node, { technology, attachments: count }).attachments;
  if (!at) return [];
  return [{ t: 'group', translate: { x: at.x, y: at.y }, children: describeAttachmentTab(count, ctx) }];
}
