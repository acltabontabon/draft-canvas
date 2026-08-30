import type { DraftEdge, DraftNode, EdgeRouting } from '../document/types';
import type { Shape } from '../render/displayList';
import { markerRef } from '../render/svg/markers';
import { accentOf, type Theme } from '../render/theme/tokens';
import { FONTS, LINE_HEIGHTS } from '../render/text/fonts';
import { layoutText } from '../render/text/layout';
import type { TextMeasurer } from '../render/text/measure';
import { labelLaneOffset, rectOf, routeEdge, type RoutedEdge, type Side } from './routing';

export interface EdgeDescribeContext {
  theme: Theme;
  measurer: TextMeasurer;
  /** Step badges can be hidden document-wide. */
  showSequence: boolean;
  /** This edge's 1-based position within the flow currently selected for overlay, if any. */
  stepIndex?: number;
  /** This edge's parallel-lane slot — see `laneIndex` in `store/selectors.ts`. */
  lane?: number;
}

/** Dashes an asynchronous connector — the one visual distinction sync/async gets. */
const ASYNC_DASH = [6, 4];

const LABEL_PADDING_X = 6;
const LABEL_PADDING_Y = 3;
const BADGE_RADIUS = 8;
/** Space between the step circle and the label text inside a chip. */
const LABEL_GAP = 5;
/** How far from the source anchor the step badge sits, in canvas units. */
const BADGE_OFFSET = 22;
const CONDITION_PADDING_X = 6;
const CONDITION_PADDING_Y = 2;
/** How far below the label chip a condition chip sits, in canvas units. */
const CONDITION_OFFSET_Y = 18;

export interface DescribedEdge {
  route: RoutedEdge;
  /** The connector line. Painted underneath every node. */
  line: Shape[];
  /** The label chip and step badge. Painted on top of everything. */
  overlay: Shape[];
  color: string;
}

export function describeEdge(
  edge: DraftEdge,
  nodes: Map<string, DraftNode>,
  ctx: EdgeDescribeContext,
): DescribedEdge | null {
  // Every other real node counts as an obstacle to route around; group
  // boundaries are big translucent containers, not something a connector
  // should detour around. Same rule the live canvas uses — see `DraftEdgeView.tsx`.
  const obstacles = [...nodes.values()]
    .filter((node) => node.id !== edge.source && node.id !== edge.target && node.type !== 'group')
    .map(rectOf);
  const route = routeEdge(edge, nodes, { lane: ctx.lane, obstacles });
  if (!route) return null;

  // A label chip is far taller than the line's own lane nudge — extra
  // separation on top of it is what keeps parallel labels from stacking.
  // Matches `DraftEdgeView.tsx` — the dual-renderer contract this module
  // shares with it.
  const labelNudge = labelLaneOffset(route.source.side, route.target.side, ctx.lane ?? 0);
  const labelX = route.labelX + labelNudge.x;
  const labelY = route.labelY + labelNudge.y;

  const palette = accentOf(ctx.theme, edge.accent);
  const color = edge.accent && edge.accent !== 'neutral' ? palette.chip : ctx.theme.edge;

  const line: Shape[] = [
    {
      t: 'path',
      d: route.d,
      fill: 'none',
      stroke: { color, width: 1.6, linecap: 'round', dash: edge.async ? ASYNC_DASH : undefined },
      markerEnd: edge.directed ? markerRef(color) : undefined,
    },
  ];

  const overlay: Shape[] = [];

  const hasStep = ctx.showSequence && typeof ctx.stepIndex === 'number';

  if (edge.label) {
    const layout = layoutText(edge.label, {
      font: FONTS.edgeLabel,
      maxWidth: 220,
      lineHeight: FONTS.edgeLabel.size * LINE_HEIGHTS.label,
      maxLines: 2,
      measurer: ctx.measurer,
    });

    // A numbered connector carries its step inside the label chip. Drawing the
    // two separately puts them on top of each other on any short connector.
    const stepWidth = hasStep ? BADGE_RADIUS * 2 + LABEL_GAP : 0;
    const w = layout.width + stepWidth + LABEL_PADDING_X * 2;
    const h = Math.max(layout.height, hasStep ? BADGE_RADIUS * 2 : 0) + LABEL_PADDING_Y * 2;
    const left = labelX - w / 2;

    overlay.push({
      t: 'rect',
      x: left,
      y: labelY - h / 2,
      w,
      h,
      r: 4,
      fill: ctx.theme.edgeLabelBg,
      stroke: { color: ctx.theme.border, width: 1 },
    });

    if (hasStep) {
      const cx = left + LABEL_PADDING_X + BADGE_RADIUS;
      const stepLayout = layoutText(String(ctx.stepIndex), {
        font: FONTS.sequenceBadge,
        maxWidth: 40,
        lineHeight: FONTS.sequenceBadge.size * LINE_HEIGHTS.label,
        maxLines: 1,
        measurer: ctx.measurer,
      });
      overlay.push(
        {
          t: 'ellipse',
          cx,
          cy: labelY,
          rx: BADGE_RADIUS,
          ry: BADGE_RADIUS,
          fill: 'none',
          stroke: { color, width: 1.3 },
        },
        {
          t: 'text',
          x: cx,
          y: labelY - stepLayout.height / 2,
          layout: stepLayout,
          font: FONTS.sequenceBadge,
          fill: color,
          align: 'middle',
        },
      );
    }

    overlay.push({
      t: 'text',
      x: left + LABEL_PADDING_X + stepWidth + layout.width / 2,
      y: labelY - layout.height / 2,
      layout,
      font: FONTS.edgeLabel,
      fill: ctx.theme.text,
      align: 'middle',
    });
  } else if (hasStep) {
    const at = badgePoint(route, edge.routing);
    const layout = layoutText(String(ctx.stepIndex), {
      font: FONTS.sequenceBadge,
      maxWidth: 40,
      lineHeight: FONTS.sequenceBadge.size * LINE_HEIGHTS.label,
      maxLines: 1,
      measurer: ctx.measurer,
    });
    overlay.push(
      {
        t: 'ellipse',
        cx: at.x,
        cy: at.y,
        rx: BADGE_RADIUS,
        ry: BADGE_RADIUS,
        fill: ctx.theme.edgeLabelBg,
        stroke: { color, width: 1.4 },
      },
      {
        t: 'text',
        x: at.x,
        y: at.y - layout.height / 2,
        layout,
        font: FONTS.sequenceBadge,
        fill: color,
        align: 'middle',
      },
    );
  }

  // The condition chip sits below the label/badge, centered on the same
  // anchor — a small, secondary tag, never competing with the label.
  if (edge.condition) {
    const value = `[${edge.condition}]`;
    const layout = layoutText(value, {
      font: FONTS.presetTag,
      maxWidth: 220,
      lineHeight: FONTS.presetTag.size * LINE_HEIGHTS.label,
      maxLines: 1,
      measurer: ctx.measurer,
    });
    const w = layout.width + CONDITION_PADDING_X * 2;
    const h = layout.height + CONDITION_PADDING_Y * 2;
    const left = labelX - w / 2;
    const y = labelY + CONDITION_OFFSET_Y;
    overlay.push(
      {
        t: 'rect',
        x: left,
        y,
        w,
        h,
        r: 4,
        fill: ctx.theme.edgeLabelBg,
        stroke: { color: ctx.theme.border, width: 1 },
      },
      {
        t: 'text',
        x: labelX,
        y: y + CONDITION_PADDING_Y,
        layout,
        font: FONTS.presetTag,
        fill: color,
        align: 'middle',
      },
    );
  }

  return { route, line, overlay, color };
}

const OUTWARD: Record<Side, { x: number; y: number }> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

/**
 * Where the step number sits: just clear of the source node, on the line.
 *
 * Smooth-step and bezier paths both leave their anchor perpendicular to the
 * node edge, so walking out along that normal lands exactly on the drawn path.
 * A straight connector has no such segment, so it is interpolated instead.
 * Sampling the real geometry would need a live SVG element and would make this
 * unusable from the exporter.
 */
function badgePoint(route: RoutedEdge, routing: EdgeRouting): { x: number; y: number } {
  if (routing === 'straight') {
    const dx = route.target.x - route.source.x;
    const dy = route.target.y - route.source.y;
    const length = Math.hypot(dx, dy) || 1;
    const t = Math.min(0.4, BADGE_OFFSET / length);
    return { x: route.source.x + dx * t, y: route.source.y + dy * t };
  }
  const normal = OUTWARD[route.source.side];
  return {
    x: route.source.x + normal.x * BADGE_OFFSET,
    y: route.source.y + normal.y * BADGE_OFFSET,
  };
}
