import type { DraftEdge, DraftNode, EdgeRouting } from '../document/types';
import type { Shape, TextAlign } from '../render/displayList';
import { PRESET_AMPLITUDE } from '../render/roughness/presets';
import { roughenPath } from '../render/roughness/roughPath';
import { markerRef } from '../render/svg/markers';
import type { Theme } from '../render/theme/tokens';
import { FONTS, LINE_HEIGHTS } from '../render/text/fonts';
import { layoutText } from '../render/text/layout';
import type { TextMeasurer } from '../render/text/measure';
import type { PersonalityPreset } from '../ui/personality/usePersonality';
import {
  LABEL_LINE_GAP,
  RESPONSE_LANE_DELTA,
  labelLaneOffset,
  rectOf,
  routeBetween,
  routeEdge,
  type RoutedEdge,
  type Side,
} from './routing';
import { dashForEdge, markerVariantForEdge, resolveEdgeColor } from './kindStyle';
import { SEMANTIC_DEFAULTS } from '../document/edgeSemantics';

export interface EdgeDescribeContext {
  theme: Theme;
  measurer: TextMeasurer;
  /** Step badges can be hidden document-wide. */
  showSequence: boolean;
  /** This edge's 1-based position within the flow currently selected for overlay, if any. */
  stepIndex?: number;
  /** This edge's parallel-lane slot — see `laneIndex` in `store/selectors.ts`. */
  lane?: number;
  /** Phase 5.2 — Intentional Roughness. Defaults to `'clean'` at call sites
   *  that construct this object directly without a preset. */
  preset?: PersonalityPreset;
}

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

/**
 * The label chip's top-left corner, anchored to whichever side of the line `route.labelSide`
 * picked instead of centered on it — mirrors `labelChipTransform` in `DraftEdgeView.tsx`, computed
 * directly here since this renderer already knows the chip's exact `w`/`h` up front.
 */
function labelChipRect(side: Side, x: number, y: number, w: number, h: number): { left: number; top: number } {
  switch (side) {
    case 'right':
      return { left: x + LABEL_LINE_GAP, top: y - h / 2 };
    case 'left':
      return { left: x - LABEL_LINE_GAP - w, top: y - h / 2 };
    case 'top':
      return { left: x - w / 2, top: y - LABEL_LINE_GAP - h };
    case 'bottom':
      return { left: x - w / 2, top: y + LABEL_LINE_GAP };
  }
}

/**
 * Mirrors `captionAnchor` in `DraftEdgeView.tsx`: a horizontal line's caption already clears it
 * with the pre-existing fixed downward offset; a vertical line needs the caption moved beside it
 * instead, since a y-only offset never leaves the line's own x-coordinate.
 */
function captionAnchor(side: Side, x: number, y: number, height: number): { x: number; y: number; align: TextAlign } {
  if (side === 'right') return { x: x + LABEL_LINE_GAP, y: y - height / 2, align: 'start' };
  if (side === 'left') return { x: x - LABEL_LINE_GAP, y: y - height / 2, align: 'end' };
  return { x, y: y + 6, align: 'middle' };
}

/** Mirrors `conditionTransform` in `DraftEdgeView.tsx` — stacked below the label for a horizontal
 *  line (unchanged), stacked beside the line for a vertical one. */
function conditionChipRect(side: Side, x: number, y: number, w: number, h: number): { left: number; top: number } {
  switch (side) {
    case 'right':
      return { left: x + LABEL_LINE_GAP, top: y - h / 2 + CONDITION_OFFSET_Y };
    case 'left':
      return { left: x - LABEL_LINE_GAP - w, top: y - h / 2 + CONDITION_OFFSET_Y };
    case 'top':
    case 'bottom':
      return { left: x - w / 2, top: y + CONDITION_OFFSET_Y };
  }
}

export interface DescribedEdge {
  route: RoutedEdge;
  /** The connector line. Painted underneath every node. */
  line: Shape[];
  /**
   * A request/response connector's own reply line — present only when `edge.response` is set.
   * Kept separate from `line` (never merged into it) specifically so a two-phase Presentation/GIF
   * pulse (see `pulseTarget` in `render/svg/document.ts`) can animate one without the other.
   * Unlike the live canvas (compact by default, revealed on hover/selection), a static export has
   * no hover concept, so this always renders when present — quieter than the primary line (thinner,
   * lower opacity, hollow arrowhead), never hidden.
   */
  responseLine?: Shape[];
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

  const color = resolveEdgeColor(edge, nodes.get(edge.source), ctx.theme);

  // Geometry (`route`, `labelX`/`labelY`/every overlay below) always reads
  // from the unperturbed `route` object — only the drawn stroke wobbles, so
  // label placement, direction, and attachment points stay exactly as legible
  // as Clean at every preset, and topology/routing never changes.
  const amplitude = PRESET_AMPLITUDE[ctx.preset ?? 'clean'];
  const strokeBase = { color, width: 1.6, linecap: 'round' as const, dash: dashForEdge(edge) };
  const markerEnd = edge.directed ? markerRef(color, markerVariantForEdge(edge)) : undefined;
  const line: Shape[] =
    amplitude.outline === 0
      ? [{ t: 'path', d: route.d, fill: 'none', stroke: strokeBase, markerEnd }]
      : [
          {
            t: 'path',
            d: roughenPath(route.d, `${edge.id}:0`, amplitude.outline),
            fill: 'none',
            stroke: strokeBase,
            markerEnd,
          },
          ...(amplitude.strokes === 2
            ? ([
                {
                  t: 'path',
                  d: roughenPath(route.d, `${edge.id}:1`, amplitude.outline),
                  fill: 'none',
                  stroke: { ...strokeBase, width: 1 },
                  opacity: 0.5,
                },
              ] as Shape[])
            : []),
        ];

  const overlay: Shape[] = [];

  // The reply half of a request/response connector — reuses `routeBetween` a second time with
  // source/target (and their anchors) swapped, so the path naturally runs target → source, plus a
  // small addition to this edge's own lane slot, exactly mirroring `DraftEdgeView.tsx`'s live
  // rendering. `responseRoute.target` lands on the *original source* node — see
  // `RESPONSE_LANE_DELTA`'s own doc comment in `edges/routing.ts` — which is what makes its
  // `markerEnd` correctly point back at A.
  let responseLine: Shape[] | undefined;
  if (edge.response) {
    const sourceNode = nodes.get(edge.source);
    const targetNode = nodes.get(edge.target);
    if (sourceNode && targetNode) {
      const responseLane = (ctx.lane ?? 0) + RESPONSE_LANE_DELTA;
      const responseRoute = routeBetween(rectOf(targetNode), rectOf(sourceNode), edge.routing, {
        anchors: { source: edge.targetAnchor, target: edge.sourceAnchor },
        lane: responseLane,
        obstacles,
      });
      responseLine = [
        {
          t: 'path',
          d: responseRoute.d,
          fill: 'none',
          stroke: { color, width: 1, linecap: 'round', dash: dashForEdge(edge) },
          markerEnd: edge.directed ? markerRef(color, 'open') : undefined,
          opacity: 0.8,
        },
      ];

      const responseLabelNudge = labelLaneOffset(responseRoute.source.side, responseRoute.target.side, responseLane);
      const responseLabelX = responseRoute.labelX + responseLabelNudge.x;
      const responseLabelY = responseRoute.labelY + responseLabelNudge.y;
      const responseLayout = layoutText(edge.response, {
        font: FONTS.edgeLabel,
        maxWidth: 220,
        lineHeight: FONTS.edgeLabel.size * LINE_HEIGHTS.label,
        maxLines: 1,
        measurer: ctx.measurer,
      });
      const w = responseLayout.width + LABEL_PADDING_X * 2;
      const h = responseLayout.height + LABEL_PADDING_Y * 2;
      const { left, top } = labelChipRect(responseRoute.labelSide, responseLabelX, responseLabelY, w, h);
      overlay.push(
        {
          t: 'rect',
          x: left,
          y: top,
          w,
          h,
          r: 4,
          fill: ctx.theme.edgeLabelBg,
          stroke: { color: ctx.theme.border, width: 1 },
          opacity: 0.8,
        },
        {
          t: 'text',
          x: left + LABEL_PADDING_X,
          y: top + h / 2 - responseLayout.height / 2,
          layout: responseLayout,
          font: FONTS.edgeLabel,
          fill: ctx.theme.textFaint,
          align: 'start',
          opacity: 0.8,
        },
      );
    }
  }

  const hasStep = ctx.showSequence && typeof ctx.stepIndex === 'number';

  // A small glyph at the path's midpoint — event's dotted line alone doesn't
  // read as "an event" the way a tiny circle at the crossing point does, and
  // conditional's diamond is deliberately distinct from the free-text
  // `condition` chip (which is display-only and orthogonal to `kind`). Only
  // when nothing else already occupies that spot: the dash pattern is the
  // one differentiator that always applies, this is a bonus for the plain
  // connector case, not something worth fighting a label or step badge over.
  if (!edge.label && !hasStep) {
    if (edge.kind === 'event') {
      overlay.push({ t: 'ellipse', cx: labelX, cy: labelY, rx: 3, ry: 3, fill: color });
    } else if (edge.kind === 'conditional') {
      const s = 5;
      overlay.push({
        t: 'path',
        d: `M${labelX},${labelY - s} L${labelX + s},${labelY} L${labelX},${labelY + s} L${labelX - s},${labelY} Z`,
        fill: ctx.theme.edgeLabelBg,
        stroke: { color, width: 1.3 },
      });
    }
    // A subtle caption of the relationship — independent of `kind`'s glyph
    // above, so a plain call/read/write connector reads just as clearly as
    // an event one, without spending the connector's actual `label`
    // (reserved for something like an event's own name, e.g.
    // "OrderCreated") on a generic operation word. Yields entirely to a real
    // label the moment the user gives one (the `!edge.label` guard above).
    if (edge.semantic) {
      const captionLayout = layoutText(SEMANTIC_DEFAULTS[edge.semantic].label, {
        font: FONTS.connectorCaption,
        maxWidth: 120,
        lineHeight: FONTS.connectorCaption.size * LINE_HEIGHTS.label,
        maxLines: 1,
        measurer: ctx.measurer,
      });
      const caption = captionAnchor(route.labelSide, labelX, labelY, captionLayout.height);
      overlay.push({
        t: 'text',
        x: caption.x,
        y: caption.y,
        layout: captionLayout,
        font: FONTS.connectorCaption,
        fill: ctx.theme.textFaint,
        align: caption.align,
      });
    }
  }

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
    const { left, top } = labelChipRect(route.labelSide, labelX, labelY, w, h);
    const centerY = top + h / 2;

    overlay.push({
      t: 'rect',
      x: left,
      y: top,
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
          cy: centerY,
          rx: BADGE_RADIUS,
          ry: BADGE_RADIUS,
          fill: 'none',
          stroke: { color, width: 1.3 },
        },
        {
          t: 'text',
          x: cx,
          y: centerY - stepLayout.height / 2,
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
      y: centerY - layout.height / 2,
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
    const { left, top } = conditionChipRect(route.labelSide, labelX, labelY, w, h);
    overlay.push(
      {
        t: 'rect',
        x: left,
        y: top,
        w,
        h,
        r: 4,
        fill: ctx.theme.edgeLabelBg,
        stroke: { color: ctx.theme.border, width: 1 },
      },
      {
        t: 'text',
        x: left + w / 2,
        y: top + CONDITION_PADDING_Y,
        layout,
        font: FONTS.presetTag,
        fill: color,
        align: 'middle',
      },
    );
  }

  return { route, line, responseLine, overlay, color };
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
