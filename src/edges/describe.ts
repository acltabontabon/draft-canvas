import type { DraftEdge, DraftNode, EdgeRouting } from '../document/types';
import type { Shape, TextAlign } from '../render/displayList';
import { PERSONALITY_PROFILES } from '../render/roughness/presets';
import { roughenPath } from '../render/roughness/roughPath';
import { sketchArrowPath } from '../render/roughness/roughArrow';
import { markerRef } from '../render/svg/markers';
import type { Theme } from '../render/theme/tokens';
import { FONTS, LINE_HEIGHTS } from '../render/text/fonts';
import { layoutText } from '../render/text/layout';
import type { TextMeasurer } from '../render/text/measure';
import type { PersonalityPreset } from '../ui/personality/usePersonality';
import {
  LABEL_LINE_GAP,
  RESPONSE_SEED_SUFFIX,
  arrowSeed,
  endTangent,
  labelLaneOffset,
  rectOf,
  responseLaneFor,
  responseSpineFor,
  routeBetween,
  routeEdge,
  strokeSeed,
  type EdgeSpine,
  type RoutedEdge,
  type Side,
} from './routing';
import { RESPONSE_DASH, dashForEdge, markerVariantForEdge, resolveEdgeColor } from './kindStyle';
import { relationshipCaptionLabel } from '../document/edgeSemantics';
import { capabilityFor, categoryOf } from '../document/connectorSemantics';

export interface EdgeDescribeContext {
  theme: Theme;
  measurer: TextMeasurer;
  /** Step badges can be hidden document-wide. */
  showSequence: boolean;
  /** This edge's 1-based position within the flow currently selected for overlay, if any. */
  stepIndex?: number;
  /** This edge's parallel-lane slot — see `laneIndex` in `edges/routing.ts`. */
  lane?: number;
  /**
   * The shared fan-out/fan-in trunk this connector travels along, if the
   * planner grouped it into one — see `edges/bundles.ts`. Absent means route
   * independently, exactly as every connector did before this field existed.
   */
  spine?: EdgeSpine;
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

/** Mirrors `OPPOSITE_SIDE` in `DraftEdgeView.tsx` — forces a request/response connector's reply
 *  label to the geometric opposite of the request label's own side. */
const OPPOSITE_SIDE: Record<Side, Side> = { top: 'bottom', bottom: 'top', left: 'right', right: 'left' };

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
 * with the pre-existing fixed offset; a vertical line needs the caption moved beside it instead,
 * since a y-only offset never leaves the line's own x-coordinate. `responseAway` is the signed
 * direction of this connector's own response line (0 when there is none) — see the live renderer's
 * own doc comment for why the flip is keyed off that sign rather than a single hardcoded side.
 */
function captionAnchor(
  side: Side,
  x: number,
  y: number,
  height: number,
  responseAway = 0,
): { x: number; y: number; align: TextAlign } {
  if (side === 'right') {
    return responseAway > 0
      ? { x: x - LABEL_LINE_GAP, y: y - height / 2, align: 'end' }
      : { x: x + LABEL_LINE_GAP, y: y - height / 2, align: 'start' };
  }
  if (side === 'left') {
    return responseAway < 0
      ? { x: x + LABEL_LINE_GAP, y: y - height / 2, align: 'start' }
      : { x: x - LABEL_LINE_GAP, y: y - height / 2, align: 'end' };
  }
  return responseAway > 0 ? { x, y: y - 6 - height, align: 'middle' } : { x, y: y + 6, align: 'middle' };
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
   * A request/response connector's own reply line — present only when `edge.hasResponse` is set.
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
  const route = routeEdge(edge, nodes, { lane: ctx.lane, obstacles, spine: ctx.spine });
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
  const profile = PERSONALITY_PROFILES[ctx.preset ?? 'clean'];
  const strokeBase = { color, width: 1.6, linecap: 'round' as const, dash: dashForEdge(edge) };
  const variant = markerVariantForEdge(edge);
  // A bundle's members each draw the whole shared trunk, so they must wobble
  // it identically or it frays into a rope — see `strokeSeed`.
  const seed = strokeSeed(edge.id, ctx.spine);
  // Sketch draws its own arrowhead inline instead of referencing the shared marker — see
  // `render/roughness/roughArrow.ts`. `roughenPath` is the identity function at
  // `outline === 0 && bow === 0` (Clean), so the base line needs no separate branch.
  const usesHandDrawnArrow = edge.directed && profile.arrowStyle === 'per-edge-hand';
  const markerEnd = edge.directed && !usesHandDrawnArrow ? markerRef(color, variant) : undefined;
  const line: Shape[] = [
    {
      t: 'path',
      d: roughenPath(route.d, `${seed}:0`, profile.outline, profile.bow),
      fill: 'none',
      stroke: strokeBase,
      markerEnd,
    },
    ...(profile.strokes === 2
      ? ([
          {
            t: 'path',
            d: roughenPath(route.d, `${seed}:1`, profile.outline, profile.bow),
            fill: 'none',
            stroke: { ...strokeBase, width: 1 },
            opacity: 0.5,
          },
        ] as Shape[])
      : []),
    ...(usesHandDrawnArrow
      ? ([
          {
            t: 'path',
            d: sketchArrowPath(
              route.target,
              endTangent(route, edge.routing, 'target'),
              arrowSeed(edge.id, ctx.spine),
              profile.arrowJitter,
              variant,
            ),
            fill: variant === 'closed' ? color : 'none',
            stroke: variant === 'open' ? { color, width: 1.3, linecap: 'round' } : undefined,
          },
        ] as Shape[])
      : []),
  ];

  const overlay: Shape[] = [];

  // The reply half of a request/response connector — reuses `routeBetween` a second time with
  // source/target (and their anchors) swapped, so the path naturally runs target → source, plus a
  // small addition to this edge's own lane slot, exactly mirroring `DraftEdgeView.tsx`'s live
  // rendering. `responseRoute.target` lands on the *original source* node — see
  // `responseLaneFor`'s own doc comment in `edges/routing.ts` — which is what makes its
  // `markerEnd` correctly point back at A.
  let responseLine: Shape[] | undefined;
  if (edge.hasResponse) {
    const sourceNode = nodes.get(edge.source);
    const targetNode = nodes.get(edge.target);
    if (sourceNode && targetNode) {
      const responseLane = responseLaneFor(ctx.lane ?? 0);
      const responseRoute = routeBetween(rectOf(targetNode), rectOf(sourceNode), edge.routing, {
        anchors: { source: edge.targetAnchor, target: edge.sourceAnchor },
        lane: responseLane,
        obstacles,
        spine: responseSpineFor(ctx.spine),
      });
      // Roughened exactly like the primary line — this used to draw `responseRoute.d` straight,
      // which meant the reply line stayed perfectly crisp in every export while the live canvas
      // (`DraftEdgeView.tsx`) already wobbled it; fixed to match, using the same shared seed
      // suffix so the two renderers can't quietly disagree on it again.
      const responseD = roughenPath(responseRoute.d, `${seed}${RESPONSE_SEED_SUFFIX}`, profile.outline, profile.bow);
      const responseHandDrawnArrow = edge.directed && profile.arrowStyle === 'per-edge-hand';
      responseLine = [
        {
          t: 'path',
          d: responseD,
          fill: 'none',
          stroke: { color, width: 1, linecap: 'round', dash: RESPONSE_DASH },
          markerEnd: edge.directed && !responseHandDrawnArrow ? markerRef(color, 'open') : undefined,
          opacity: 0.8,
        },
        ...(responseHandDrawnArrow
          ? ([
              {
                t: 'path',
                d: sketchArrowPath(
                  responseRoute.target,
                  endTangent(responseRoute, edge.routing, 'target'),
                  `${edge.id}:response-head`,
                  profile.arrowJitter,
                  'open',
                ),
                fill: 'none',
                stroke: { color, width: 1.3, linecap: 'round' },
                opacity: 0.8,
              },
            ] as Shape[])
          : []),
      ];

      // A textless response line (auto-defaulted, nothing typed yet) draws only the line above —
      // no label chip, same as the live renderer.
      if (edge.response) {
        // Deliberately *not* `labelLaneOffset` here — see the matching comment in
        // `DraftEdgeView.tsx`: that helper's extra clearance is for separating two different
        // *real* edges' label chips, not for spacing a response label off its own already
        // well-separated (`RESPONSE_LANE_DELTA`) line.
        const responseLabelSide = OPPOSITE_SIDE[route.labelSide];
        const responseLabelX = responseRoute.labelX;
        const responseLabelY = responseRoute.labelY;
        const responseLayout = layoutText(edge.response, {
          font: FONTS.edgeLabel,
          maxWidth: 220,
          lineHeight: FONTS.edgeLabel.size * LINE_HEIGHTS.label,
          maxLines: 1,
          measurer: ctx.measurer,
        });
        const w = responseLayout.width + LABEL_PADDING_X * 2;
        const h = responseLayout.height + LABEL_PADDING_Y * 2;
        const { left, top } = labelChipRect(responseLabelSide, responseLabelX, responseLabelY, w, h);
        overlay.push(
          {
            t: 'rect',
            x: left,
            y: top,
            w,
            h,
            r: 4,
            // The screen draws a canvas-toned mask, not a bordered chip — see `.dc-edge-label`.
            fill: ctx.theme.canvas,
            opacity: 0.82,
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
    // label the moment the user gives one (the `!edge.label` guard above). A
    // request/response connector gets one too now — see the matching comment
    // in `DraftEdgeView.tsx`.
    if (edge.semantic) {
      const sourceNode = nodes.get(edge.source);
      const targetNode = nodes.get(edge.target);
      const status =
        sourceNode && targetNode ? capabilityFor(categoryOf(sourceNode), categoryOf(targetNode))?.status : undefined;
      const isUnusual = status === 'unusual' || status === 'questionable';
      const label = relationshipCaptionLabel(edge.semantic, edge.hasResponse, edge.deliveryAttempts);
      const text = isUnusual ? `▲ ${label}` : label;
      const captionLayout = layoutText(text, {
        font: FONTS.connectorCaption,
        maxWidth: 120,
        lineHeight: FONTS.connectorCaption.size * LINE_HEIGHTS.label,
        maxLines: 1,
        measurer: ctx.measurer,
      });
      const captionResponseAway = edge.hasResponse ? Math.sign(responseLaneFor(ctx.lane ?? 0)) : 0;
      // A bundle's members all share one relationship, so repeating its
      // caption down every branch is pure noise — the exact "calls / calls /
      // calls / calls / calls" column this feature exists to remove. Every
      // member instead draws it at the same point on the shared stem, where
      // the N identical copies overdraw into one crisp label.
      //
      // A connector flagged as an architecturally unusual pairing keeps its
      // own caption on its own branch: that warning is about this specific
      // relationship, and hoisting it onto the trunk would attach it to
      // siblings it isn't true of.
      const collapsed = Boolean(route.trunkLabel) && !isUnusual;
      const captionAt = collapsed ? route.trunkLabel! : { x: labelX, y: labelY };
      const captionSide = collapsed ? (route.trunkLabelSide ?? route.labelSide) : route.labelSide;
      const caption = captionAnchor(captionSide, captionAt.x, captionAt.y, captionLayout.height, captionResponseAway);
      overlay.push({
        t: 'text',
        x: caption.x,
        y: caption.y,
        layout: captionLayout,
        font: FONTS.connectorCaption,
        fill: isUnusual ? ctx.theme.accents.amber.text : ctx.theme.textFaint,
        align: caption.align,
      });
    }
  }

  // Async's own visual cue — two short diagonal ticks at the path's midpoint, the
  // conventional "cable break" glyph, so an async call reads as one at a glance without
  // resorting to a dashed *request* line (that's `edge.async`'s own, deliberately separate,
  // concern). Unlike the event/conditional glyphs above, this shows *alongside* a real label —
  // it sits on the line itself, not in the label chip's own off-path spot — so, unlike those,
  // it's outside the `!edge.label` guard. Mirrors `DraftEdgeView.tsx`'s identical marker exactly;
  // see its own comment for why the tilt is fixed and why a vertical connector additionally gets
  // a small masked gap behind the ticks (`isVerticalConnector`, reusing `labelSideFor`'s own
  // vertical-vs-horizontal call via `route.labelSide` so the two can never disagree).
  if (edge.kind === 'async' && !edge.async) {
    const isVerticalConnector = route.labelSide === 'left' || route.labelSide === 'right';
    if (isVerticalConnector) {
      overlay.push({
        t: 'rect',
        x: labelX - 4,
        y: labelY - 8,
        w: 8,
        h: 16,
        fill: ctx.theme.canvas,
      });
    }
    overlay.push({
      t: 'path',
      d: `M${labelX - 5.5},${labelY + 5} L${labelX - 1.5},${labelY - 5} M${labelX + 1.5},${labelY + 5} L${labelX + 5.5},${labelY - 5}`,
      fill: 'none',
      stroke: { color, width: 1.6, linecap: 'round' },
    });
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
      // Mirrors `.dc-edge-label`: a translucent canvas-toned mask that erases the stroke under the
      // text, not a bordered chip.
      fill: ctx.theme.canvas,
      opacity: 0.82,
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
  // Every member of a fan-out leaves its hub from the *same* anchor, so
  // walking outward from `source` would stack all N step badges on one point.
  // `branchStart` is where this connector stops sharing and becomes its own
  // line, which is the first place a badge can identify which one it is.
  if (route.branchStart) {
    const dx = route.target.x - route.branchStart.x;
    const dy = route.target.y - route.branchStart.y;
    const length = Math.hypot(dx, dy) || 1;
    const t = Math.min(0.4, BADGE_OFFSET / length);
    return { x: route.branchStart.x + dx * t, y: route.branchStart.y + dy * t };
  }
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
