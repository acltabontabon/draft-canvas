import { describeEdge } from '../../edges/describe';
import { describeNode, describeContext } from '../../nodes/describe';
import { boundsOf } from '../../document/operations';
import type { DraftDocument, DraftNode } from '../../document/types';
import { themeFor, type ThemeName } from '../theme/tokens';
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
}

export interface RenderedSvg {
  svg: string;
  width: number;
  height: number;
}

const DEFAULT_PADDING = 32;

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

  const nodes = options.only
    ? document.nodes.filter((node) => options.only!.has(node.id))
    : document.nodes;
  const visible = new Set(nodes.map((node) => node.id));
  const edges = document.edges.filter(
    (edge) => visible.has(edge.source) && visible.has(edge.target),
  );

  const bounds = boundsOf(nodes) ?? { x: 0, y: 0, width: 320, height: 160 };
  const width = Math.max(1, Math.round(bounds.width + padding * 2));
  const height = Math.max(1, Math.round(bounds.height + padding * 2));
  const originX = bounds.x - padding;
  const originY = bounds.y - padding;

  const nodeMap = new Map(nodes.map((node) => [node.id, node]));

  beginClipScope('export');

  const edgeLines: SvgEl[] = [];
  const edgeOverlays: SvgEl[] = [];
  const arrowColors = new Set<string>();

  for (const edge of edges) {
    const described = describeEdge(edge, nodeMap, edgeCtx);
    if (!described) continue;
    if (edge.directed) arrowColors.add(described.color);
    edgeLines.push(...described.line.flatMap(emitShape));
    edgeOverlays.push(...described.overlay.flatMap(emitShape));
  }

  // Boundaries sit behind connectors so lines stay readable across a group.
  const ordered = [...nodes].sort(paintOrder);
  const nodeEls: SvgEl[] = [];
  const backdropEls: SvgEl[] = [];

  for (const node of ordered) {
    const list = describeNode(node, nodeCtx);
    const group = el(
      'g',
      { transform: `translate(${n(node.x)} ${n(node.y)})` },
      emitDisplayList(list),
    );
    if (node.type === 'group') backdropEls.push(group);
    else nodeEls.push(group);
  }

  const defs: SvgEl[] = [shadowFilter(theme.shadow), ...markerDefs(arrowColors)];

  const children: SvgEl[] = [el('defs', undefined, defs)];
  if (!options.transparent) {
    children.push(el('rect', { x: 0, y: 0, width, height, fill: theme.canvas }));
  }
  children.push(
    el('g', { transform: `translate(${n(-originX)} ${n(-originY)})` }, [
      ...backdropEls,
      ...edgeLines,
      ...nodeEls,
      ...edgeOverlays,
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
