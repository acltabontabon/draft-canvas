import { describeEdge } from '../../edges/describe';
import { describeNode, describeContext } from '../../nodes/describe';
import { findFlow, stepIndexOf } from '../../document/flow';
import { boundsOf } from '../../document/operations';
import type { DraftDocument, DraftEdge, DraftFlow, DraftNode } from '../../document/types';
import { laneIndex } from '../../edges/routing';
import { themeFor, type Theme, type ThemeName } from '../theme/tokens';
import { getMeasurer } from '../text/measure';
import { el, serialize, n, type SvgEl } from './element';
import { beginClipScope, emitDisplayList, emitShape, shadowFilter } from './emit';
import { markerDefs } from './markers';

export interface ExportOptions {
  theme?: ThemeName;
  /** Blank margin around the content, in canvas units. */
  padding?: number;
  transparent?: boolean;
  /** Restrict the export to these node ids (plus the edges between them). */
  only?: ReadonlySet<string>;
  /** The flow currently selected for step-badge overlay, if any — "what you see is what you export". */
  selectedFlowId?: string;
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
  decorateEdge?: (edge: DraftEdge) => (Decoration & { pulsePhase?: number }) | undefined;
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
  nodeCtx: { theme: Theme; measurer: ReturnType<typeof getMeasurer> },
  edgeCtx: { theme: Theme; measurer: ReturnType<typeof getMeasurer>; showSequence: boolean },
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

  beginClipScope('export');

  const edgeLines: SvgEl[] = [];
  const edgeOverlays: SvgEl[] = [];
  const arrowColors = new Set<string>();

  for (const edge of edges) {
    const stepIndex = stepIndexOf(options.selectedFlow, edge.id);
    const lane = lanes.get(edge.id)?.offset ?? 0;
    const described = describeEdge(edge, nodeMap, { ...edgeCtx, stepIndex, lane });
    if (!described) continue;
    if (edge.directed) arrowColors.add(described.color);

    const decoration = options.decorateEdge?.(edge);
    const lineEls = described.line.flatMap(emitShape);
    if (decoration?.pulsePhase !== undefined) applyPulse(lineEls, decoration.pulsePhase);
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
  const nodeCtx = { theme, measurer };
  const edgeCtx = { theme, measurer, showSequence: document.settings.showSequence };
  const selectedFlow = options.selectedFlowId ? findFlow(document, options.selectedFlowId) : undefined;

  const scene = buildScene(document, nodeCtx, edgeCtx, { only: options.only, selectedFlow });

  const bounds = boundsOf(scene.nodes) ?? { x: 0, y: 0, width: 320, height: 160 };
  const width = Math.max(1, Math.round(bounds.width + padding * 2));
  const height = Math.max(1, Math.round(bounds.height + padding * 2));
  const originX = bounds.x - padding;
  const originY = bounds.y - padding;

  const defs: SvgEl[] = [shadowFilter(theme.shadow), ...markerDefs(scene.arrowColors)];

  const children: SvgEl[] = [el('defs', undefined, defs)];
  if (!options.transparent) {
    children.push(el('rect', { x: 0, y: 0, width, height, fill: theme.canvas }));
  }
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
 * Renders one node in isolation, in node-local coordinates. Used by the canvas
 * so that what is on screen comes out of exactly the same emitter as the export.
 */
export function renderNodeSvgChildren(node: DraftNode, themeName: ThemeName): SvgEl[] {
  beginClipScope(node.id);
  return emitDisplayList(describeNode(node, describeContext(themeFor(themeName))));
}
