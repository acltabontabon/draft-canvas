import { describeEdge } from '../../edges/describe';
import { obstaclesForEdge } from '../../edges/obstacles';
import { describeNode, describeContext } from '../../nodes/describe';
import { findFlow, stepIndexOf } from '../../document/flow';
import { boundsOf } from '../../document/operations';
import type { BackgroundFit, DraftDocument, DraftEdge, DraftFlow, DraftNode, OpenPoint } from '../../document/types';
import { unresolvedOpenPoints, unresolvedOpenPointsFor } from '../../document/openPoints';
import { MARKER_SIZE, describeMarker, describeMarkerKey, nodeMarkerOrigin } from '../../openPoints/marker';
import { laneIndex } from '../../edges/routing';
import { routingPlan } from '../../edges/bundles';
import { crossingPlan, withoutMoving } from '../../edges/crossings';
import { labelGroupPlan } from '../../edges/labelGroups';
import { blurRadiusFor } from '../backgroundAnchor';
import { themeFor, type Theme, type ThemeName } from '../theme/tokens';
import { getMeasurer } from '../text/measure';
import { el, serialize, n, type SvgEl } from './element';
import { beginClipScope, emitDisplayList, emitShape, shadowFilter } from './emit';
import { markerDefs } from './markers';
import { PERSONALITY_PROFILES } from '../roughness/presets';
import type { PersonalityPreset } from '../../ui/personality/usePersonality';
import type { Shape } from '../displayList';

const BACKGROUND_BLUR_FILTER_ID = 'dc-bg-blur';

/** An already-resolved background — the image loaded and base64-encoded, so
 *  every renderer here stays synchronous/pure. See `export/background.ts`. */
export interface ResolvedBackground {
  dataUri: string;
  fit: BackgroundFit;
  dim: number;
  blur: number;
  /** Natural pixel dimensions — only used to size one repeat of a `tile` fit. */
  naturalWidth: number;
  naturalHeight: number;
}

export interface ExportOptions {
  theme?: ThemeName;
  /** Blank margin around the content, in canvas units. */
  padding?: number;
  transparent?: boolean;
  /** Restrict the export to these node ids (plus the edges between them). */
  only?: ReadonlySet<string>;
  /** The flow currently selected for step-badge overlay, if any — "what you see is what you export". */
  selectedFlowId?: string;
  /** Whether to draw a configured background — see `ResolvedBackground`. Defaults to `true`. */
  includeBackground?: boolean;
  background?: ResolvedBackground;
  /** Intentional Roughness preset. Defaults to `'clean'`. */
  preset?: PersonalityPreset;
  /**
   * Whether the picture keeps the open-point markers, with a key naming the kinds that appear.
   * Defaults to `true`: an image that silently dropped them would make every unsettled assumption
   * look decided. `false` is the deliberate choice to leave them out — nothing about it is an
   * approval.
   */
  openPoints?: boolean;
}

/**
 * Builds the `<image>`/scrim (and, for `blur`, an SVG filter) for a resolved
 * background, sized to fill `frame` — the export's own visible bounds (the
 * whole canvas for `renderDocumentSvg`, or any camera-cropped viewBox a
 * caller passes) — the same "always fills the visible screen" behavior
 * `CanvasBackground.tsx` gives the live canvas, so panning/zooming and
 * exporting never disagree about how much of the image is showing.
 * `preserveAspectRatio` does the cover/contain fitting; `<image>` clips to
 * its own box by default, so no manual geometry is needed for anything but
 * `tile`, which repeats the image at its natural pixel size.
 */
export function backgroundEls(
  background: ResolvedBackground,
  canvasColor: string,
  frame: { x: number; y: number; width: number; height: number },
  extraDim = 0,
): { defs: SvgEl[]; els: SvgEl[] } {
  const { x, y, width, height } = frame;
  const defs: SvgEl[] = [];
  let imageEl: SvgEl;

  if (background.fit === 'tile') {
    const patternId = 'dc-bg-pattern';
    const tileW = Math.max(1, background.naturalWidth);
    const tileH = Math.max(1, background.naturalHeight);
    defs.push(
      el('pattern', { id: patternId, x, y, width: tileW, height: tileH, patternUnits: 'userSpaceOnUse' }, [
        el('image', { x: 0, y: 0, width: tileW, height: tileH, href: background.dataUri, preserveAspectRatio: 'none' }),
      ]),
    );
    imageEl = el('rect', { x, y, width, height, fill: `url(#${patternId})` });
  } else {
    imageEl = el('image', {
      x,
      y,
      width,
      height,
      href: background.dataUri,
      preserveAspectRatio: background.fit === 'contain' ? 'xMidYMid meet' : 'xMidYMid slice',
    });
  }

  if (background.blur > 0) {
    defs.push(
      el('filter', { id: BACKGROUND_BLUR_FILTER_ID, x: '-20%', y: '-20%', width: '140%', height: '140%' }, [
        el('feGaussianBlur', { stdDeviation: n(blurRadiusFor(background.blur)) }),
      ]),
    );
    imageEl = el('g', { filter: `url(#${BACKGROUND_BLUR_FILTER_ID})` }, [imageEl]);
  }

  const dim = Math.min(1, background.dim + extraDim);
  const scrim = el('rect', { x, y, width, height, fill: canvasColor, opacity: n(dim) });
  return { defs, els: [imageEl, scrim] };
}

export interface RenderedSvg {
  svg: string;
  width: number;
  height: number;
}

const DEFAULT_PADDING = 32;
/** Clear space between the bottom of the architecture and the open-point key beneath it. */
const KEY_GAP = 18;

/** A node or edge's visual decoration beyond its own describer — opacity/filter tiering, plus a
 *  connector's pulse phase. `undefined` from a decorator means "no change from the plain export". */
export interface Decoration {
  opacity?: number;
  /** A literal SVG `filter` CSS value, e.g. `grayscale(0.5)`. */
  filter?: string;
}

export interface SceneOptions {
  only?: ReadonlySet<string>;
  selectedFlow?: DraftFlow;
  /** Clip-path id scope (see `beginClipScope`). Defaults to `'export'`; anything drawn into the
   *  live page beside the canvas needs its own. */
  clipScope?: string;
  /** Nodes mid-drag: connectors don't route around them, the same as on the live canvas while a
   *  gesture is in flight (`uiStore.movingNodeIds`). */
  movingNodeIds?: ReadonlySet<string>;
  decorateNode?: (node: DraftNode) => Decoration | undefined;
  /** `pulseTarget` picks which of a request/response connector's two lines the pulse animates —
   *  see `DescribedEdge.responseLine` in `edges/describe.ts`. Defaults to `'request'` (the primary
   *  line) when omitted, i.e. every existing caller's behavior is unchanged. */
  decorateEdge?: (
    edge: DraftEdge,
  ) => (Decoration & { pulsePhase?: number; pulseTarget?: 'request' | 'response' }) | undefined;
  /** The unresolved points whose markers the scene draws. Absent or empty draws none. */
  openPoints?: readonly OpenPoint[];
}

export interface Scene {
  nodes: DraftNode[];
  /** Boundary ("group") nodes, painted behind connectors so lines stay readable across a group. */
  backdropEls: SvgEl[];
  nodeEls: SvgEl[];
  edgeLines: SvgEl[];
  edgeOverlays: SvgEl[];
  /** Open-point tabs on nodes, painted over everything; a connector's ride in its own overlay. */
  markerEls: SvgEl[];
  arrowColors: Set<string>;
  /**
   * The same elements again, kept per id and in paint order, for a renderer that needs to address
   * one node or connector at a time. Node children are
   * in node-local coordinates — no `translate` — so the caller positions them.
   */
  nodeEntries: { node: DraftNode; els: SvgEl[] }[];
  edgeEntries: { edge: DraftEdge; lineEls: SvgEl[]; overlayEls: SvgEl[] }[];
  /** Where connector labels and chips sit — they can reach past every node box (a reply label on
   *  the outer side of the leftmost column), so an export's extent has to include them. */
  overlayRects: Rect[];
}

type Rect = { x: number; y: number; width: number; height: number };

/** The boxes a display list's filled shapes cover. Lines and text are left out: text always sits
 *  on a chip, and a line's ends are at nodes the extent already includes. */
function shapeRects(shapes: readonly Shape[], dx = 0, dy = 0, out: Rect[] = [], scale = 1): Rect[] {
  for (const shape of shapes) {
    if (shape.t === 'rect') out.push({ x: shape.x * scale + dx, y: shape.y * scale + dy, width: shape.w * scale, height: shape.h * scale });
    else if (shape.t === 'ellipse') {
      out.push({
        x: (shape.cx - shape.rx) * scale + dx,
        y: (shape.cy - shape.ry) * scale + dy,
        width: shape.rx * 2 * scale,
        height: shape.ry * 2 * scale,
      });
    } else if (shape.t === 'group') {
      // A point in the group lands at `group.scale * p + group.translate`, then the parent's own.
      shapeRects(
        shape.children,
        dx + scale * (shape.translate?.x ?? 0),
        dy + scale * (shape.translate?.y ?? 0),
        out,
        scale * (shape.scale ?? 1),
      );
    }
  }
  return out;
}

function decorateGroupAttrs(decoration: Decoration | undefined): SvgEl['attrs'] {
  if (!decoration) return undefined;
  const attrs: Record<string, string | number | undefined> = {};
  if (decoration.opacity !== undefined) attrs.opacity = n(decoration.opacity);
  if (decoration.filter !== undefined) attrs.filter = decoration.filter;
  return Object.keys(attrs).length > 0 ? attrs : undefined;
}

/** The active edge's line pulses — see `dc-flow-pulse` in `canvas.css`, mirrored exactly here. */
const PULSE_DASH = '3 9';
const PULSE_TRAVEL = 24;

function applyPulse(lineEls: SvgEl[], pulsePhase: number): void {
  const offset = n(-PULSE_TRAVEL * (((pulsePhase % 1) + 1) % 1));
  for (const lineEl of lineEls) {
    if (lineEl.tag !== 'path' || !lineEl.attrs) continue;
    lineEl.attrs['stroke-dasharray'] = PULSE_DASH;
    lineEl.attrs['stroke-dashoffset'] = offset;
  }
}

/**
 * Builds the node/edge SVG elements shared by every scene renderer — the
 * bounds-fit whole-document export (`renderDocumentSvg`) and any other
 * framing a caller wants (a camera-cropped viewBox, say). Everything funnels
 * through the same `describeNode`/`describeEdge` calls; only the surrounding
 * viewBox/root differs.
 */
export function buildScene(
  document: DraftDocument,
  nodeCtx: { theme: Theme; measurer: ReturnType<typeof getMeasurer>; preset: PersonalityPreset },
  edgeCtx: {
    theme: Theme;
    measurer: ReturnType<typeof getMeasurer>;
    showSequence: boolean;
    preset: PersonalityPreset;
  },
  options: SceneOptions = {},
): Scene {
  const nodes = options.only
    ? document.nodes.filter((node) => options.only!.has(node.id))
    : document.nodes;
  const visible = new Set(nodes.map((node) => node.id));
  const isVisible = (edge: DraftEdge) => visible.has(edge.source) && visible.has(edge.target);
  // The document's own array whenever every connector is in the picture (the usual case — only a
  // "selection only" export leaves some out). `routingPlan` and `crossingPlan` are memoized on
  // array identity, so a fresh copy here made every call re-plan the whole diagram: an animated
  // export builds one scene per frame, and paid for the full crossing analysis on each of them.
  const edges = document.edges.every(isVisible) ? document.edges : document.edges.filter(isVisible);

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const lanes = laneIndex(edges);
  // Planned over the *filtered* arrays on purpose. A "selection only" export
  // that leaves out part of a fan-out should route what remains as the smaller
  // group it now is — re-expanding to independent lines if it drops below a
  // bundle's floor — rather than drawing branches off a trunk whose other
  // members aren't in the picture.
  const plan = routingPlan(nodes, edges);
  const moving = options.movingNodeIds;
  const obstacleNodes = moving?.size ? nodes.filter((node) => !moving.has(node.id)) : nodes;
  // Planned over the same filtered arrays, and against the same obstacle set actually routed
  // against — otherwise it would place arcs on routes nobody draws. Mid-gesture, the crossings
  // against a connector attached to a moving node are dropped exactly as the live canvas drops
  // them, so a frame rendered mid-drag looks like the canvas mid-drag.
  const crossings = crossingPlan(nodes, edges, obstacleNodes);
  // Connectors that leave together under one label draw it once, as on the canvas — unless a flow's
  // numbered steps are showing, which ride inside each connector's own label.
  const labels = labelGroupPlan(nodes, edges);
  const sharedLabelOf = (edgeId: string) => {
    const group = labels.groupFor(edgeId);
    if (!group || group.members.some((member) => stepIndexOf(options.selectedFlow, member) !== undefined)) return undefined;
    return { draws: group.members[0] === edgeId, x: group.x, y: group.y, side: group.side };
  };

  beginClipScope(options.clipScope ?? 'export');

  const edgeLines: SvgEl[] = [];
  const edgeOverlays: SvgEl[] = [];
  const arrowColors = new Set<string>();
  const nodeEntries: Scene['nodeEntries'] = [];
  const edgeEntries: Scene['edgeEntries'] = [];
  const overlayRects: Rect[] = [];

  const points = options.openPoints ?? [];
  const markerEls: SvgEl[] = [];

  for (const edge of edges) {
    const stepIndex = stepIndexOf(options.selectedFlow, edge.id);
    const lane = lanes.get(edge.id)?.offset ?? 0;
    const edgePoints = points.length ? unresolvedOpenPointsFor(points, { kind: 'edge', id: edge.id }) : [];
    const described = describeEdge(edge, nodeMap, {
      ...edgeCtx,
      stepIndex,
      lane,
      ...(edgePoints.length ? { openPoints: edgePoints } : {}),
      spine: plan.spineFor(edge.id),
      sharedLabel: sharedLabelOf(edge.id),
      obstacles: obstaclesForEdge(obstacleNodes, edge.source, edge.target),
      crossings: moving?.size
        ? withoutMoving(crossings.crossingsFor(edge.id), moving)
        : crossings.crossingsFor(edge.id),
    });
    if (!described) continue;
    if (edge.directed) arrowColors.add(described.color);

    const decoration = options.decorateEdge?.(edge);
    const primaryEls = described.line.flatMap(emitShape);
    const responseEls = described.responseLine?.flatMap(emitShape) ?? [];
    // Kept as two separate element groups, not one merged pulse target: a request/response
    // connector's two-phase Presentation/GIF pulse (see `pulseTarget`) needs to animate the
    // primary or the response line independently, never both at once for the wrong phase.
    if (decoration?.pulsePhase !== undefined) {
      applyPulse(decoration.pulseTarget === 'response' ? responseEls : primaryEls, decoration.pulsePhase);
    }
    const lineEls = [...primaryEls, ...responseEls];
    const overlayEls = described.overlay.flatMap(emitShape);
    shapeRects(described.overlay, 0, 0, overlayRects);
    const groupAttrs = decorateGroupAttrs(decoration);

    edgeLines.push(...(groupAttrs ? [el('g', groupAttrs, lineEls)] : lineEls));
    edgeOverlays.push(...(groupAttrs ? [el('g', groupAttrs, overlayEls)] : overlayEls));
    edgeEntries.push({ edge, lineEls, overlayEls });
  }

  // Boundaries sit behind connectors so lines stay readable across a group.
  const ordered = [...nodes].sort(paintOrder);
  const nodeEls: SvgEl[] = [];
  const backdropEls: SvgEl[] = [];

  for (const node of ordered) {
    const list = describeNode(node, nodeCtx);
    const decoration = options.decorateNode?.(node);
    const els = emitDisplayList(list);
    const group = el(
      'g',
      { transform: `translate(${n(node.x)} ${n(node.y)})`, ...decorateGroupAttrs(decoration) },
      els,
    );
    if (node.type === 'group') backdropEls.push(group);
    else nodeEls.push(group);
    nodeEntries.push({ node, els });

    // The same tab, at the same place, `DraftNodeView` puts it — from the same two functions.
    const nodePoints = points.length ? unresolvedOpenPointsFor(points, { kind: 'node', id: node.id }) : [];
    if (nodePoints.length) {
      const origin = nodeMarkerOrigin(node);
      const x = node.x + origin.x;
      const y = node.y + origin.y;
      markerEls.push(
        el('g', { transform: `translate(${n(x)} ${n(y)})`, ...decorateGroupAttrs(decoration) }, emitDisplayList({
          width: MARKER_SIZE,
          height: MARKER_SIZE,
          shapes: describeMarker(nodePoints, { theme: nodeCtx.theme, measurer: nodeCtx.measurer }),
        })),
      );
      overlayRects.push({ x, y, width: MARKER_SIZE, height: MARKER_SIZE });
    }
  }

  return { nodes, backdropEls, nodeEls, edgeLines, edgeOverlays, markerEls, arrowColors, nodeEntries, edgeEntries, overlayRects };
}

/**
 * Renders a document to a standalone SVG.
 *
 * The output contains only real SVG primitives — no `foreignObject` — because
 * `foreignObject` does not render in GitHub READMEs, in most documentation
 * tools, or in vector editors, which is exactly where these exports are meant
 * to end up.
 */
export function renderDocumentSvg(
  document: DraftDocument,
  options: ExportOptions = {},
): RenderedSvg {
  const theme = themeFor(options.theme ?? 'dark');
  const padding = options.padding ?? DEFAULT_PADDING;
  const measurer = getMeasurer();
  const preset = options.preset ?? 'clean';
  const nodeCtx = { theme, measurer, preset };
  const edgeCtx = { theme, measurer, showSequence: document.settings.showSequence, preset };
  const selectedFlow = options.selectedFlowId ? findFlow(document, options.selectedFlowId) : undefined;

  const openPoints = options.openPoints === false ? [] : unresolvedOpenPoints(document);
  const scene = buildScene(document, nodeCtx, edgeCtx, { only: options.only, selectedFlow, openPoints });

  const bounds = boundsOf([...scene.nodes, ...scene.overlayRects]) ?? { x: 0, y: 0, width: 320, height: 160 };
  // Only the kinds actually in the picture — a "selection only" export of an unmarked corner needs
  // no key at all. Below the architecture, inside the margin, so it never reads as part of it.
  const shown = scene.markerEls.length || scene.edgeEntries.some((entry) => unresolvedOpenPointsFor(openPoints, { kind: 'edge', id: entry.edge.id }).length);
  const key = shown
    ? describeMarkerKey(
        openPoints.filter((point) =>
          point.targets.some((target) =>
            target.kind === 'node' ? scene.nodes.some((node) => node.id === target.id) : scene.edgeEntries.some((entry) => entry.edge.id === target.id),
          ),
        ),
        { theme, measurer },
      )
    : null;
  const keyBlock = key ? key.height + KEY_GAP : 0;
  const width = Math.max(1, Math.round(Math.max(bounds.width, key?.width ?? 0) + padding * 2));
  const height = Math.max(1, Math.round(bounds.height + keyBlock + padding * 2));
  const originX = bounds.x - padding;
  const originY = bounds.y - padding;

  const defs: SvgEl[] = [
    shadowFilter(theme.shadow),
    ...markerDefs(scene.arrowColors, PERSONALITY_PROFILES[preset].arrowJitter),
  ];

  const showBackground = options.includeBackground !== false && options.background !== undefined;
  // Sized to the export's own visible bounds (0,0,width,height) — outside the
  // content's translated `<g>` below, so it fills the whole exported canvas
  // like a wallpaper rather than a rectangle pinned to document coordinates.
  const background = showBackground
    ? backgroundEls(options.background!, theme.canvas, { x: 0, y: 0, width, height })
    : undefined;
  if (background) defs.push(...background.defs);

  const children: SvgEl[] = [el('defs', undefined, defs)];
  if (!options.transparent) {
    children.push(el('rect', { x: 0, y: 0, width, height, fill: theme.canvas }));
  }
  children.push(...(background?.els ?? []));
  children.push(
    el('g', { transform: `translate(${n(-originX)} ${n(-originY)})` }, [
      ...scene.backdropEls,
      ...scene.edgeLines,
      ...scene.nodeEls,
      ...scene.edgeOverlays,
      ...scene.markerEls,
    ]),
  );
  if (key) {
    children.push(
      el('g', { transform: `translate(${n(padding)} ${n(bounds.height + padding + KEY_GAP)})` }, emitDisplayList({ width: key.width, height: key.height, shapes: key.shapes })),
    );
  }

  const root = el(
    'svg',
    {
      xmlns: 'http://www.w3.org/2000/svg',
      // Explicit pixel dimensions matter: without them some browsers rasterize
      // an SVG loaded into an Image at the wrong intrinsic size, or not at all.
      width,
      height,
      viewBox: `0 0 ${width} ${height}`,
    },
    children,
  );

  return { svg: serialize(root), width, height };
}

function paintOrder(a: DraftNode, b: DraftNode): number {
  if (a.type === 'group' && b.type !== 'group') return -1;
  if (b.type === 'group' && a.type !== 'group') return 1;
  return a.z - b.z;
}

/**
 * Renders one node in isolation, in node-local coordinates — the same emitter the export uses,
 * so tests can assert on a single node's output without building a whole document.
 */
export function renderNodeSvgChildren(node: DraftNode, themeName: ThemeName): SvgEl[] {
  beginClipScope(node.id);
  return emitDisplayList(describeNode(node, describeContext(themeFor(themeName))));
}
