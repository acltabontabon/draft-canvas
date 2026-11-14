import { CONNECTOR_STYLE, connectorStrokePath, styledConnectorPath } from '../render/connectorStyle';
import type { DraftEdge, DraftNode, OpenPoint } from '../document/types';
import { MARKER_SIZE, describeMarker, type OccupiedRect } from '../openPoints/marker';
import type { Shape, TextAlign } from '../render/displayList';
import { PERSONALITY_PROFILES } from '../render/roughness/presets';
import { sketchArrowPath } from '../render/roughness/roughArrow';
import { markerRef } from '../render/svg/markers';
import type { Theme } from '../render/theme/tokens';
import { FONTS, LINE_HEIGHTS } from '../render/text/fonts';
import { baselineOf, layoutText, type TextLayout } from '../render/text/layout';
import type { TextMeasurer } from '../render/text/measure';
import type { PersonalityPreset } from '../theme/usePersonality';
import {
  LABEL_LINE_GAP,
  RESPONSE_SEED_SUFFIX,
  arrowSeed,
  captionAnchor as captionBaseline,
  captionAwayForLane,
  endTangent,
  labelChipSide,
  labelLaneOffset,
  labelSideAwayFromResponse,
  rectOf,
  responseAwayAt,
  responseLabelAnchor,
  strokeSeed,
  type EdgeSpine,
  type Rect,
  type RoutedEdge,
  type Side,
} from './routing';
import { RESPONSE_DASH, dashForEdge, markerVariantForEdge, resolveEdgeColor } from './kindStyle';
import { badgeCrowds, badgePoint } from './badgePoint';
import { describeAttachmentChips } from './attachmentChips';
import { connectorMarkRow, markRowAttachmentsWidth } from './connectorMarks';
import { bridgePath } from './bridge';
import { computeEdgeRoutes, routedCaption, type EdgeRoutes } from './edgeRoutes';

const captionOf = (caption: string | undefined) => (caption ? { caption } : {});
import type { EdgeSpread } from './endpoints';
import type { EdgeTracks } from './separation';
import type { Crossing } from './crossings';
import { categoryOf } from '../document/connectorSemantics';
import { connectorCaptionText } from './captionText';
import { CAPTION_PADDING_X, CAPTION_PADDING_Y, LABEL_PADDING_X, LABEL_PADDING_Y, RECOVERY_LABEL_GAP, fittedConnectorCaption, layoutEdgeLabel, layoutEdgeResponse, layoutRecoveryLabel } from './labelLayout';
import { compensationLabelParts } from './compensationMarker';
import { compensationDisplayLabel } from '../document/compensation';

export interface EdgeDescribeContext {
  theme: Theme;
  measurer: TextMeasurer;
  /** Step badges can be hidden document-wide. */
  showSequence: boolean;
  /** This edge's 1-based position within the flow currently selected for overlay, if any. */
  stepIndex?: number;
  /** This edge's parallel-lane slot — see `laneIndex` in `edges/routing.ts`. */
  lane?: number;
  /** Actions linked to this interaction, represented by one compact marker. */
  /**
   * The shared fan-out/fan-in trunk this connector travels along, if the
   * planner grouped it into one — see `edges/bundles.ts`. Absent means route
   * independently, exactly as every connector did before this field existed.
   */
  spine?: EdgeSpine;
  /** The nodes this connector may detour around. Omitted: every node but its endpoints and groups. */
  obstacles?: readonly Rect[];
  /**
   * Where this connector crosses another and so draws a small arc over it — see
   * `edges/crossings.ts`. Absent means draw none, exactly as every connector did before bridges
   * existed, which is what keeps the many callers that build a bare context unchanged.
   */
  crossings?: readonly Crossing[];
  /**
   * Set when this connector shares one label with others leaving alongside it — see
   * `edges/labelGroups.ts`. The member that `draws` it puts its label chip there; the rest draw
   * none. Absent means its own label, where its own route puts it.
   */
  sharedLabel?: { draws: boolean; x: number; y: number; side: Side };
  /** Intentional Roughness. Defaults to `'clean'` at call sites
   *  that construct this object directly without a preset. */
  preset?: PersonalityPreset;
  /**
   * The unresolved open points about this connector, when an export keeps them (`ExportOptions.
   * openPoints`). Absent draws no marker — every caller that builds a bare context is unchanged.
   */
  openPoints?: readonly OpenPoint[];
  /**
   * The connector's routes, when the caller already has them — the exporter reads them from the
   * same accessor the canvas does (`connectorRoutes`). Omitted: routed here from the fields above,
   * with the same inputs and so the same answer.
   */
  routes?: EdgeRoutes;
  /** Where `endpoints.ts` spread this connector's automatic ends, for routing it here. */
  spread?: EdgeSpread;
  /** Its runs moved onto their own tracks by `separation.ts`, for routing it here. */
  tracks?: EdgeTracks;
}

const BADGE_RADIUS = 8;
/** Space between the step circle and the label text inside a chip. */
const LABEL_GAP = 5;
const CONDITION_PADDING_X = 6;
const CONDITION_PADDING_Y = 2;
/** How far below the label point a condition chip's top sits, in canvas units — `conditionTransform`'s 16px. */
const CONDITION_OFFSET_Y = 16;

/**
 * The label chip's top-left corner, anchored to whichever side of the line `route.labelSide`
 * picked instead of centered on it — mirrors `labelChipTransform` in `DraftEdgeView.tsx`, computed
 * directly here since this renderer already knows the chip's exact `w`/`h` up front.
 */
export function labelChipRect(side: Side, x: number, y: number, w: number, h: number): { left: number; top: number } {
  // Set back by the chip's padding, so the text — not the chip — is `LABEL_LINE_GAP` from the line,
  // where a relationship caption's text sits (`captionAnchor`).
  switch (side) {
    case 'right':
      return { left: x + LABEL_LINE_GAP - LABEL_PADDING_X, top: y - h / 2 };
    case 'left':
      return { left: x - LABEL_LINE_GAP + LABEL_PADDING_X - w, top: y - h / 2 };
    case 'top':
      return { left: x - w / 2, top: y - LABEL_LINE_GAP + LABEL_PADDING_Y - h };
    case 'bottom':
      return { left: x - w / 2, top: y + LABEL_LINE_GAP - LABEL_PADDING_Y };
  }
}

/**
 * The caption's box, for the exporter and for anything that must know where the canvas's caption
 * sits: derived from `routing.ts`'s `captionAnchor` — the baseline the canvas draws at — so the two
 * can't disagree. They used to be two formulas (a baseline 14 off the line on screen, a box 6 off
 * it in the export), and a caption above its line exported several pixels lower than it showed.
 * A vertical line's caption sits beside it, centred on the point.
 */
export function captionAnchor(
  side: Side,
  x: number,
  y: number,
  layout: TextLayout,
  responseAway = 0,
): { x: number; y: number; align: TextAlign } {
  const height = layout.height;
  const at = labelSideAwayFromResponse(side, responseAway);
  if (at === 'right') return { x: x + LABEL_LINE_GAP, y: y - height / 2, align: 'start' };
  if (at === 'left') return { x: x - LABEL_LINE_GAP, y: y - height / 2, align: 'end' };
  const baseline = captionBaseline(side, x, y, responseAway).y;
  return { x, y: baseline - baselineOf(layout, 0), align: 'middle' };
}

/** The condition chip's one line, laid out once for both renderers. */
function layoutConditionChip(text: string, measurer?: TextMeasurer): TextLayout {
  return layoutText(text, {
    font: FONTS.presetTag,
    maxWidth: 220,
    lineHeight: FONTS.presetTag.size * LINE_HEIGHTS.label,
    maxLines: 1,
    measurer,
  });
}

/** The condition chip's box size, with its padding — `.dc-edge-meta`'s. */
export function conditionChipSize(text: string, measurer?: TextMeasurer): { width: number; height: number } {
  const layout = layoutConditionChip(text, measurer);
  return { width: layout.width + CONDITION_PADDING_X * 2, height: layout.height + CONDITION_PADDING_Y * 2 };
}

/** Between a connector's words and the condition chip stacked under them. */
const CONDITION_STACK_GAP = 2;

/**
 * Where the condition chip sits: below the label point (beside the line for a vertical one), or — when
 * the connector's words already hang there (a label or caption under its line, or words beside an
 * upright run that reach that far down) — stacked just under them, never on them. Mirrors
 * `conditionTransform` in `DraftEdgeView.tsx`; `words` is the box both renderers draw the words in.
 */
export function conditionChipRect(side: Side, x: number, y: number, w: number, h: number, words?: OccupiedRect): { left: number; top: number } {
  const left = side === 'right' ? x + LABEL_LINE_GAP : side === 'left' ? x - LABEL_LINE_GAP - w : x - w / 2;
  const top = y + CONDITION_OFFSET_Y;
  const hits = words !== undefined
    && left < words.left + words.width && words.left < left + w && top < words.top + words.height && words.top < top + h;
  return { left, top: hits ? words.top + words.height + CONDITION_STACK_GAP : top };
}

export interface DescribedEdge {
  route: RoutedEdge;
  /** The connector line. Painted underneath every node. */
  line: Shape[];
  /**
   * A request/response connector's own reply line — present only when `edge.hasResponse` is set.
   * Kept separate from `line` (never merged into it) specifically so a two-phase Presentation
   * pulse (see `pulseTarget` in `render/svg/document.ts`) can animate one without the other.
   * Unlike the live canvas (compact by default, revealed on hover/selection), a static export has
   * no hover concept, so this always renders when present — quieter than the primary line (thinner,
   * lower opacity, hollow arrowhead), never hidden.
   */
  responseLine?: Shape[];
  /** The label chip and step badge. Painted on top of everything. */
  overlay: Shape[];
  color: string;
  /**
   * Where this connector's words (label chip, caption, reply chip, condition chip) and marks
   * (attachment chips, open-point tab) landed, as plain boxes. Nothing draws these: they are what
   * the routing quality corpus measures for collisions, read off the very picture it exports.
   */
  boxes: { words: Rect[]; marks: Rect[] };
}

const boxOf = (left: number, top: number, width: number, height: number): Rect => ({ x: left, y: top, width, height });
const rectOfOccupied = (occupied: OccupiedRect): Rect => boxOf(occupied.left, occupied.top, occupied.width, occupied.height);

/** A connector's routes from a describe context: the inputs `connectorRouteInputs` builds, given here. */
function routesOf(edge: DraftEdge, nodes: Map<string, DraftNode>, ctx: EdgeDescribeContext, obstacles: readonly Rect[]): EdgeRoutes | null {
  const source = nodes.get(edge.source);
  const target = nodes.get(edge.target);
  if (!source || !target) return null;
  return computeEdgeRoutes({
    source: rectOf(source),
    target: rectOf(target),
    routing: edge.routing,
    label: edge.label,
    ...captionOf(routedCaption(edge, categoryOf(source), categoryOf(target))),
    sourceAnchor: edge.sourceAnchor,
    targetAnchor: edge.targetAnchor,
    hasResponse: edge.hasResponse,
    lane: ctx.lane ?? 0,
    spine: ctx.spine,
    obstacles,
    waypoints: edge.waypoints,
    ...(ctx.spread ? { spread: ctx.spread } : {}),
    ...(ctx.tracks ? { tracks: ctx.tracks } : {}),
  });
}

export function describeEdge(
  edge: DraftEdge,
  nodes: Map<string, DraftNode>,
  ctx: EdgeDescribeContext,
): DescribedEdge | null {
  // Every other real node counts as an obstacle to route around; group
  // boundaries are big translucent containers, not something a connector
  // should detour around. Same rule the live canvas uses — see `DraftEdgeView.tsx`.
  // A caller routing many connectors passes the scoped set (`obstaclesForEdge`) instead, which
  // draws the same path without checking every node for every connector.
  const obstacles =
    ctx.obstacles ??
    [...nodes.values()]
      .filter((node) => node.id !== edge.source && node.id !== edge.target && node.type !== 'group')
      .map(rectOf);
  const routes = ctx.routes ?? routesOf(edge, nodes, ctx, obstacles);
  if (!routes) return null;
  const route = routes.request;

  // A label chip is far taller than the line's own lane nudge — extra
  // separation on top of it is what keeps parallel labels from stacking.
  // Matches `DraftEdgeView.tsx` — the dual-renderer contract this module
  // shares with it.
  const labelNudge = labelLaneOffset(route.source.side, route.target.side, ctx.lane ?? 0);
  const labelX = route.labelX + labelNudge.x;
  const labelY = route.labelY + labelNudge.y;
  // Everything that sits beside the label point takes the side away from the reply line, so the
  // reply's own chip has the outer side of its line to itself — see `labelChipSide`.
  const responseAway = responseAwayAt(route, routes.response, ctx.lane ?? 0);
  const labelSide = labelChipSide(route.labelSide, responseAway);
  const recoveryParts = compensationLabelParts(edge);
  const recoveryChipSide = recoveryParts && (labelSide === 'top' || labelSide === 'bottom') ? 'bottom' : labelSide;

  const color = resolveEdgeColor(edge, nodes.get(edge.source), ctx.theme);

  // Geometry (`route`, `labelX`/`labelY`/every overlay below) always reads
  // from the unperturbed `route` object — only the drawn stroke wobbles, so
  // label placement, direction, and attachment points stay exactly as legible
  // as Clean at every preset, and topology/routing never changes.
  const profile = PERSONALITY_PROFILES[ctx.preset ?? 'clean'];
  const styledPath = styledConnectorPath(route.d, edge);
  const strokeBase = { color, width: CONNECTOR_STYLE.lineWidth, linecap: 'round' as const, dash: dashForEdge(edge) };
  const variant = markerVariantForEdge(edge);
  // A bundle's members each draw the whole shared trunk, so they must wobble
  // it identically or it frays into a rope — see `strokeSeed`.
  const seed = strokeSeed(edge.id, ctx.spine);
  // Sketch draws its own arrowhead inline instead of referencing the shared marker — see
  // `render/roughness/roughArrow.ts`. `roughenPath` is the identity function at
  // `outline === 0 && bow === 0` (Clean), so the base line needs no separate branch.
  const usesHandDrawnArrow = edge.directed && profile.arrowStyle === 'per-edge-hand';
  const markerEnd = edge.directed && !usesHandDrawnArrow ? markerRef(color, variant) : undefined;
  // Crossing bridges go on *after* the wobble — see the matching note in `DraftEdgeView.tsx`.
  // `bridgePath` is the identity with no crossings, so a connector that crosses nothing keeps the
  // exact path string it always had.
  const crossings = ctx.crossings ?? [];
  const drawn = (suffix: string) =>
    bridgePath(connectorStrokePath(styledPath, `${seed}:${suffix}`, profile, true, crossings.length > 0), crossings);
  const line: Shape[] = [
    {
      t: 'path',
      d: drawn('0'),
      fill: 'none',
      stroke: strokeBase,
      markerEnd,
    },
    ...(profile.strokes === 2
      ? ([
          {
            t: 'path',
            d: drawn('1'),
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
            stroke: variant === 'open' ? { color, width: CONNECTOR_STYLE.openArrowWidth, linecap: 'round' } : undefined,
          },
        ] as Shape[])
      : []),
  ];

  const overlay: Shape[] = [];
  const boxes: DescribedEdge['boxes'] = { words: [], marks: [] };
  // What already sits at the label point, for the open-point marker to take its place beside.
  let markerOccupied: OccupiedRect | undefined;

  // The reply half of a request/response connector — routed by `computeEdgeRoutes` with
  // source/target (and their anchors) swapped, so the path naturally runs target → source, plus a
  // small addition to this edge's own lane slot: the same route `DraftEdgeView.tsx` draws.
  // `responseRoute.target` lands on the *original source* node — see `responseLaneFor`'s own doc
  // comment in `edges/routing.ts` — which is what makes its `markerEnd` correctly point back at A.
  let responseLine: Shape[] | undefined;
  if (edge.hasResponse) {
    const sourceNode = nodes.get(edge.source);
    const targetNode = nodes.get(edge.target);
    const responseRoute = routes.response;
    if (sourceNode && targetNode && responseRoute) {
      // Roughened exactly like the primary line — this used to draw `responseRoute.d` straight,
      // which meant the reply line stayed perfectly crisp in every export while the live canvas
      // (`DraftEdgeView.tsx`) already wobbled it; fixed to match, using the same shared seed
      // suffix so the two renderers can't quietly disagree on it again.
      const responseD = connectorStrokePath(styledConnectorPath(responseRoute.d, edge), `${seed}${RESPONSE_SEED_SUFFIX}`, profile);
      const responseHandDrawnArrow = edge.directed && profile.arrowStyle === 'per-edge-hand';
      responseLine = [
        {
          t: 'path',
          d: responseD,
          fill: 'none',
          stroke: { color, width: Math.max(1.1, CONNECTOR_STYLE.lineWidth * 0.6), linecap: 'round', dash: RESPONSE_DASH },
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
                stroke: { color, width: CONNECTOR_STYLE.openArrowWidth, linecap: 'round' },
                opacity: 0.8,
              },
            ] as Shape[])
          : []),
      ];

      // A textless response line (auto-defaulted, nothing typed yet) draws only the line above —
      // no label chip, same as the live renderer.
      if (edge.response) {
        // Share the live canvas's paired anchor, not an independent longest-run midpoint or
        // the real-sibling label nudge, which would separate these words from their own arrow.
        const responseLabel = responseLabelAnchor(route, responseRoute, rectOf(sourceNode), rectOf(targetNode), ctx.lane);
        const responseLayout = layoutEdgeResponse(edge.response, ctx.measurer);
        const w = responseLayout.width + LABEL_PADDING_X * 2;
        const h = responseLayout.height + LABEL_PADDING_Y * 2;
        const { left, top } = labelChipRect(responseLabel.side, responseLabel.x, responseLabel.y, w, h);
        boxes.words.push(boxOf(left, top, w, h));
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
            fill: ctx.theme.edgeText,
            align: 'start',
            opacity: 0.8,
          },
        );
      }
    }
  }

  const hasStep = ctx.showSequence && typeof ctx.stepIndex === 'number';
  // The very point the canvas draws it at — one function, so the two can't drift apart.
  const badgeAt = hasStep ? badgePoint(route, edge.routing) : null;
  // Being a numbered step must never cost a connector its words; only the badge physically landing
  // on them may. Mirrors `DraftEdgeView.tsx` — see `badgeCrowds`.
  const badgeOverMidpoint = badgeAt !== null && badgeCrowds(badgeAt, { x: labelX, y: labelY });

  // A small glyph at the path's midpoint — event's dotted line alone doesn't
  // read as "an event" the way a tiny circle at the crossing point does, and
  // conditional's diamond is deliberately distinct from the free-text
  // `condition` chip (which is display-only and orthogonal to `kind`). Only
  // when nothing else already occupies that spot: the dash pattern is the
  // one differentiator that always applies, this is a bonus for the plain
  // connector case, not something worth fighting a label over. A step badge
  // only wins the spot when it is actually on it — see `badgeCrowds`.
  const displayLabel = compensationDisplayLabel(edge);
  if (!displayLabel) {
    if (!badgeOverMidpoint) {
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
      // Worded once for both renderers and routing (`connectorCaptionText`).
      const { text, unusual: isUnusual } = connectorCaptionText(
        edge,
        sourceNode ? categoryOf(sourceNode) : undefined,
        targetNode ? categoryOf(targetNode) : undefined,
      )!;
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
      // A collapsed caption sits on the shared trunk, well clear of any member's own badge, so it
      // is measured where it actually lands rather than at this connector's midpoint.
      // On the trunk the caption is clear of every member's ends; at its own point it fits the room
      // its line leaves before a shape or the arrowhead, and is left out of a line with no room for
      // it at all (`fittedConnectorCaption`), exactly as the canvas leaves it out.
      const captionLayout = fittedConnectorCaption(text, ctx.measurer, collapsed ? route.trunkLabelRoom : route.labelRoom);
      if (captionLayout && !(badgeAt !== null && badgeCrowds(badgeAt, captionAt))) {
        const captionSide = collapsed ? (route.trunkLabelSide ?? route.labelSide) : route.labelSide;
        const caption = captionAnchor(captionSide, captionAt.x, captionAt.y, captionLayout, collapsed ? responseAway : captionAwayForLane(ctx.lane ?? 0, responseAway));
        const captionLeft = caption.align === 'start' ? caption.x : caption.align === 'end' ? caption.x - captionLayout.width : caption.x - captionLayout.width / 2;
        // Mirrors `.dc-edge-caption`: the label's quiet canvas-toned mask, close around the text, so a
        // line running under the words is erased there instead of striking through them.
        overlay.push({
          t: 'rect',
          x: captionLeft - CAPTION_PADDING_X,
          y: caption.y - CAPTION_PADDING_Y,
          w: captionLayout.width + CAPTION_PADDING_X * 2,
          h: captionLayout.height + CAPTION_PADDING_Y * 2,
          r: 4,
          fill: ctx.theme.canvas,
          opacity: 0.82,
        });
        overlay.push({
          t: 'text',
          x: caption.x,
          y: caption.y,
          layout: captionLayout,
          font: FONTS.connectorCaption,
          fill: isUnusual ? ctx.theme.accents.amber.text : ctx.theme.edgeText,
          align: caption.align,
        });
        boxes.words.push(boxOf(captionLeft, caption.y, captionLayout.width, captionLayout.height));
        // A caption on a shared trunk belongs to every member; a marker beside it would too, so a
        // bundled connector's marker sits at its own label point instead.
        if (!collapsed) {
          markerOccupied = { left: captionLeft, top: caption.y, width: captionLayout.width, height: captionLayout.height };
        }
      }
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

  if (displayLabel && ctx.sharedLabel?.draws !== false) {
    // A label shared by a group sits at the group's point, not this line's: no room of its own.
    const layout = layoutEdgeLabel(displayLabel, ctx.measurer, ctx.sharedLabel ? undefined : route.labelRoom);
    const recoveryLayout = recoveryParts ? layoutRecoveryLabel(recoveryParts.name, recoveryParts.operation, ctx.measurer) : null;

    // A numbered connector carries its step inside the label chip. Drawing the
    // two separately puts them on top of each other on any short connector.
    const stepWidth = hasStep ? BADGE_RADIUS * 2 + LABEL_GAP : 0;
    const contentWidth = recoveryLayout?.width ?? layout.width;
    const contentHeight = recoveryLayout?.height ?? layout.height;
    const w = contentWidth + stepWidth + LABEL_PADDING_X * 2;
    const h = Math.max(contentHeight, hasStep ? BADGE_RADIUS * 2 : 0) + LABEL_PADDING_Y * 2;
    const chip = ctx.sharedLabel ?? { side: recoveryChipSide, x: labelX, y: labelY };
    const { left, top } = labelChipRect(chip.side, chip.x, chip.y, w, h);
    const centerY = top + h / 2;
    boxes.words.push(boxOf(left, top, w, h));
    // A shared label is drawn once, so only the member drawing it has a chip to sit beside.
    if (!ctx.sharedLabel) markerOccupied = { left, top, width: w, height: h };

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

    const textX = left + LABEL_PADDING_X + stepWidth + contentWidth / 2;
    if (recoveryLayout) {
      const textTop = centerY - contentHeight / 2;
      overlay.push(
        {
          t: 'text', x: textX, y: textTop, layout: recoveryLayout.primary,
          font: FONTS.recoveryName, fill: ctx.theme.edgeText, align: 'middle',
        },
        {
          t: 'text', x: textX, y: textTop + recoveryLayout.primary.height + RECOVERY_LABEL_GAP,
          layout: recoveryLayout.secondary, font: FONTS.connectorCaption,
          fill: ctx.theme.edgeText, opacity: 0.75, align: 'middle',
        },
      );
    } else {
      overlay.push({
        t: 'text', x: textX, y: centerY - layout.height / 2, layout,
        font: FONTS.edgeLabel,
        // The caption's own tone, as on screen (full-strength only while hovered or edited).
        fill: ctx.theme.edgeText, align: 'middle',
      });
    }
  } else if (hasStep) {
    // Non-null by construction: `badgeAt` is computed from this same `hasStep`.
    const at = badgeAt!;
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
  // anchor — a small, secondary tag, never competing with the label. A cadence ("hourly") shares
  // the chip, after the condition: both say when the connector carries anything.
  const meta = edgeMetaText(edge);
  let conditionBox: Rect | undefined;
  if (meta) {
    const layout = layoutConditionChip(meta, ctx.measurer);
    const w = layout.width + CONDITION_PADDING_X * 2;
    const h = layout.height + CONDITION_PADDING_Y * 2;
    const { left, top } = conditionChipRect(labelSide, labelX, labelY, w, h, markerOccupied);
    conditionBox = boxOf(left, top, w, h);
    boxes.words.push(conditionBox);
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

  // The connector's marks — its attachment chips, then its open-point tab — in one row beyond its
  // words, where the canvas puts them (`connectorMarks.ts`). Last, so they paint over anything they
  // must sit beside.
  const source = nodes.get(edge.source);
  const target = nodes.get(edge.target);
  const row = source && target
    ? connectorMarkRow({
        point: { x: labelX, y: labelY },
        upright: route.labelSide === 'left' || route.labelSide === 'right',
        side: labelSide,
        ...(markerOccupied ? { words: rectOfOccupied(markerOccupied) } : {}),
        ...(conditionBox ? { condition: conditionBox } : {}),
        attachmentsWidth: markRowAttachmentsWidth(edge.attachments, ctx.measurer),
        openPoint: Boolean(ctx.openPoints?.length),
        source: rectOf(source),
        target: rectOf(target),
      })
    : null;
  if (row?.attachments && edge.attachments?.length) {
    const chips = describeAttachmentChips(edge.attachments, row.attachments.box.x, row.attachments.box.y, { theme: ctx.theme, measurer: ctx.measurer });
    for (const chip of chips) if (chip.t === 'rect') boxes.marks.push(boxOf(chip.x, chip.y, chip.w, chip.h));
    overlay.push(...chips);
  }
  if (row?.openPoint && ctx.openPoints?.length) {
    const center = row.openPoint;
    boxes.marks.push(boxOf(center.x - MARKER_SIZE / 2, center.y - MARKER_SIZE / 2, MARKER_SIZE, MARKER_SIZE));
    overlay.push({
      t: 'group',
      translate: { x: center.x - MARKER_SIZE / 2, y: center.y - MARKER_SIZE / 2 },
      children: describeMarker(ctx.openPoints, { theme: ctx.theme, measurer: ctx.measurer }),
    });
  }

  return { route, line, responseLine, overlay, color, boxes };
}


/** The secondary chip under a connector's caption: its condition in brackets, then its cadence —
 *  one string for both renderers, so the canvas and an export can't word it differently. */
export function edgeMetaText(edge: Pick<DraftEdge, 'condition' | 'cadence'>): string | null {
  const parts = [edge.condition ? `[${edge.condition}]` : null, edge.cadence ?? null].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}
