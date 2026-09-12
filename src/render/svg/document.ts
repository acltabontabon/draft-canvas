import { describeEdge } from '../../edges/describe';
import { describeNode, describeContext } from '../../nodes/describe';
import { findFlow, stepIndexOf } from '../../document/flow';
import { boundsOf } from '../../document/operations';
import type { BackgroundFit, DraftDocument, DraftEdge, DraftFlow, DraftNode } from '../../document/types';
import { laneIndex } from '../../edges/routing';
import { routingPlan } from '../../edges/bundles';
import { blurRadiusFor } from '../backgroundAnchor';
import { themeFor, type Theme, type ThemeName } from '../theme/tokens';
import { getMeasurer } from '../text/measure';
import { el, serialize, n, type SvgEl } from './element';
import { beginClipScope, emitDisplayList, emitShape, shadowFilter } from './emit';
import { markerDefs } from './markers';
import { PERSONALITY_PROFILES } from '../roughness/presets';
import type { PersonalityPreset } from '../../ui/personality/usePersonality';

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
  /** Phase 5.2 — Intentional Roughness preset. Defaults to `'clean'`. */
  preset?: PersonalityPreset;
}

/**
 * Builds the `<image>`/scrim (and, for `blur`, an SVG filter) for a resolved
 * background, sized to fill `frame` — the export's own visible bounds (the
 * whole canvas for `renderDocumentSvg`, the camera-cropped viewBox for
 * `renderFlowFrameSvg`) — the same "always fills the visible screen" behavior
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
  decorateNode?: (node: DraftNode) => Decoration | undefined;
  /** `pulseTarget` picks which of a request/response connector's two lines the pulse animates —
   *  see `DescribedEdge.responseLine` in `edges/describe.ts`. Defaults to `'request'` (the primary
   *  line) when omitted, i.e. every existing caller's behavior is unchanged. */
  decorateEdge?: (
    edge: DraftEdge,
  ) => (Decoration & { pulsePhase?: number; pulseTarget?: 'request' | 'response' }) | undefined;
}

export interface Scene {
  nodes: DraftNode[];
  /** Boundary ("group") nodes, painted behind connectors so lines stay readable across a group. */
  backdropEls: SvgEl[];
  nodeEls: SvgEl[];
  edgeLines: SvgEl[];
  edgeOverlays: SvgEl[];
  arrowColors: Set<string>;
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
 * bounds-fit whole-document export (`renderDocumentSvg`) and the
 * camera-framed, tier-decorated single flow-step frame
 * (`renderFlowFrameSvg`, Phase 4.3). Both funnel through the same
 * `describeNode`/`describeEdge` calls; only the surrounding viewBox/root and
 * any tier decoration differ.
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
  const edges = document.edges.filter(
    (edge) => visible.has(edge.source) && visible.has(edge.target),
  );

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  const lanes = laneIndex(edges);
  // Planned over the *filtered* arrays on purpose. A "selection only" export
  // that leaves out part of a fan-out should route what remains as the smaller
  // group it now is — re-expanding to independent lines if it drops below a
  // bundle's floor — rather than drawing branches off a trunk whose other
  // members aren't in the picture.
  const plan = routingPlan(nodes, edges);

  beginClipScope('export');

  const edgeLines: SvgEl[] = [];
  const edgeOverlays: SvgEl[] = [];
  const arrowColors = new Set<string>();

  for (const edge of edges) {
    const stepIndex = stepIndexOf(options.selectedFlow, edge.id);
    const lane = lanes.get(edge.id)?.offset ?? 0;
    const described = describeEdge(edge, nodeMap, { ...edgeCtx, stepIndex, lane, spine: plan.spineFor(edge.id) });
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
    const groupAttrs = decorateGroupAttrs(decoration);

    edgeLines.push(...(groupAttrs ? [el('g', groupAttrs, lineEls)] : lineEls));
    edgeOverlays.push(...(groupAttrs ? [el('g', groupAttrs, overlayEls)] : overlayEls));
  }

  // Boundaries sit behind connectors so lines stay readable across a group.
  const ordered = [...nodes].sort(paintOrder);
  const nodeEls: SvgEl[] = [];
  const backdropEls: SvgEl[] = [];

  for (const node of ordered) {
    const list = describeNode(node, nodeCtx);
    const decoration = options.decorateNode?.(node);
    const group = el(
      'g',
      { transform: `translate(${n(node.x)} ${n(node.y)})`, ...decorateGroupAttrs(decoration) },
      emitDisplayList(list),
    );
    if (node.type === 'group') backdropEls.push(group);
    else nodeEls.push(group);
  }

  return { nodes, backdropEls, nodeEls, edgeLines, edgeOverlays, arrowColors };
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

  const scene = buildScene(document, nodeCtx, edgeCtx, { only: options.only, selectedFlow });

  const bounds = boundsOf(scene.nodes) ?? { x: 0, y: 0, width: 320, height: 160 };
  const width = Math.max(1, Math.round(bounds.width + padding * 2));
  const height = Math.max(1, Math.round(bounds.height + padding * 2));
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
    ]),
  );

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
