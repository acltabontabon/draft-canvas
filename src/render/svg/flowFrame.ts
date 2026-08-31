/**
 * Renders one frame of a Phase 4.3 animated flow (GIF) export: the whole
 * document, camera-cropped to a step's viewport, with the same active/shown/
 * hidden opacity tiers and connector pulse Presentation Mode itself shows —
 * see `explainNodeTier`/`explainEdgeTier` in `document/flow.ts` and the
 * `dc-flow-pulse` keyframes in `styles/canvas.css`, both mirrored here rather
 * than re-derived, so a GIF frame can never quietly drift from what
 * Presentation Mode looks like live.
 */
import { explainEdgeTier, explainNodeTier, stepIndexOf, type ExplainTier } from '../../document/flow';
import type { DraftDocument, DraftEdge, DraftFlow, DraftNode, DraftViewport } from '../../document/types';
import { themeFor, type ThemeName } from '../theme/tokens';
import { getMeasurer } from '../text/measure';
import { el, serialize, n } from './element';
import { shadowFilter } from './emit';
import { markerDefs } from './markers';
import { buildScene, type Decoration } from './document';
import type { RenderedSvg } from './document';

export interface FlowFrameOptions {
  theme?: ThemeName;
}

/** Mirrors `.react-flow__node`'s explain-mode opacity/filter in `canvas.css`. */
const NODE_TIER_DECORATION: Record<ExplainTier, Decoration> = {
  active: { opacity: 1 },
  shown: { opacity: 0.65, filter: 'grayscale(0.2)' },
  hidden: { opacity: 0.3, filter: 'grayscale(0.5)' },
};

/** Mirrors `.dc-edge[data-active/shown/dimmed]`'s opacity in `canvas.css`. */
const EDGE_TIER_DECORATION: Record<ExplainTier, Decoration> = {
  active: { opacity: 1 },
  shown: { opacity: 0.55 },
  hidden: { opacity: 0.22 },
};

/**
 * Renders a single animation frame: `document`, camera-cropped to `camera`
 * at `canvasSize` pixels, with `flow`'s tiers for `step` and the active
 * connector's pulse at `pulsePhase` (0–1, wrapping).
 */
export function renderFlowFrameSvg(
  document: DraftDocument,
  flow: DraftFlow,
  step: number,
  camera: DraftViewport,
  canvasSize: { width: number; height: number },
  pulsePhase: number,
  options: FlowFrameOptions = {},
): RenderedSvg {
  const theme = themeFor(options.theme ?? 'dark');
  const measurer = getMeasurer();
  const nodeCtx = { theme, measurer };
  const edgeCtx = { theme, measurer, showSequence: document.settings.showSequence };

  const decorateNode = (node: DraftNode): Decoration =>
    NODE_TIER_DECORATION[explainNodeTier(flow, document.edges, node.id, step)];

  const decorateEdge = (edge: DraftEdge): Decoration & { pulsePhase?: number } => {
    const tier = explainEdgeTier(stepIndexOf(flow, edge.id), step);
    const decoration = EDGE_TIER_DECORATION[tier];
    return tier === 'active' ? { ...decoration, pulsePhase } : decoration;
  };

  const scene = buildScene(document, nodeCtx, edgeCtx, {
    selectedFlow: flow,
    decorateNode,
    decorateEdge,
  });

  const defs = [el('defs', undefined, [shadowFilter(theme.shadow), ...markerDefs(scene.arrowColors)])];

  // The camera viewBox is the whole story: unlike `renderDocumentSvg`'s
  // bounds-fit export, nothing here is translated to a local origin — every
  // node/edge is already emitted in absolute document coordinates, and the
  // viewBox alone crops and zooms them into "what the camera sees".
  const camX = -camera.x / camera.zoom;
  const camY = -camera.y / camera.zoom;
  const camW = canvasSize.width / camera.zoom;
  const camH = canvasSize.height / camera.zoom;

  const children = [
    ...defs,
    el('rect', { x: n(camX), y: n(camY), width: n(camW), height: n(camH), fill: theme.canvas }),
    ...scene.backdropEls,
    ...scene.edgeLines,
    ...scene.nodeEls,
    ...scene.edgeOverlays,
  ];

  const root = el(
    'svg',
    {
      xmlns: 'http://www.w3.org/2000/svg',
      width: canvasSize.width,
      height: canvasSize.height,
      viewBox: `${n(camX)} ${n(camY)} ${n(camW)} ${n(camH)}`,
    },
    children,
  );

  return { svg: serialize(root), width: canvasSize.width, height: canvasSize.height };
}
