import { createDocument } from '../../document/factory';
import { boundsOf } from '../../document/operations';
import type { DraftDocument, DraftEdge, DraftFlow, DraftNode } from '../../document/types';
import type { ResolvedFrame } from '../../learn/frames';
import { buildScene } from '../../render/svg/document';
import { el, serialize, type SvgEl } from '../../render/svg/element';
import { shadowFilter } from '../../render/svg/emit';
import { markerDefs } from '../../render/svg/markers';
import { PERSONALITY_PROFILES } from '../../render/roughness/presets';
import { getMeasurer } from '../../render/text/measure';
import type { Theme } from '../../render/theme/tokens';
import type { PersonalityPreset } from '../personality/usePersonality';

/**
 * Turns a resolved scene frame into SVG markup through the exporter's own `buildScene` — the same
 * `describeNode`/`describeEdge` the canvas-accurate export uses, at the user's own theme and
 * personality. A scene can't drift from how Draft Canvas actually draws, because it isn't a second
 * drawing of it.
 *
 * The one thing the page needs that an export doesn't: ids. Arrowhead markers and the shadow filter
 * are addressed by document-wide id, and the live canvas already defines `dc-arrow-…`/`dc-shadow`,
 * so every scene rewrites its own to a private prefix and carries its own `<defs>`.
 */

export interface RenderedNode {
  node: DraftNode;
  html: string;
}

export interface RenderedEdge {
  edge: DraftEdge;
  lineHtml: string;
  overlayHtml: string;
}

export interface RenderedFrame {
  backdrops: RenderedNode[];
  nodes: RenderedNode[];
  edges: RenderedEdge[];
}

export interface RenderedScene {
  defs: string;
  frames: RenderedFrame[];
}

interface RenderContext {
  theme: Theme;
  preset: PersonalityPreset;
  /** Unique per mounted scene, so two scenes on one page never share an id. */
  key: string;
}

const LEARN_FLOW_ID = 'learn-flow';

function documentFor(frame: Pick<ResolvedFrame, 'nodes' | 'edges' | 'flow'>): { document: DraftDocument; flow?: DraftFlow } {
  const document = createDocument('Learn');
  document.nodes = [...frame.nodes];
  document.edges = [...frame.edges];
  if (frame.flow.length === 0) return { document };
  const flow: DraftFlow = {
    id: LEARN_FLOW_ID,
    title: 'Flow',
    steps: frame.flow.map((edgeId) => ({ id: `step-${edgeId}`, edgeId })),
  };
  document.flows = [flow];
  return { document, flow };
}

function scoped(markup: string, key: string): string {
  return markup.replace(/(["#])dc-(arrow|shadow)/g, `$1dc-learn-${key}-$2`);
}

function markup(els: SvgEl[], key: string): string {
  return scoped(els.map(serialize).join(''), key);
}

function build(
  frame: Pick<ResolvedFrame, 'nodes' | 'edges' | 'flow'> & { moving?: ReadonlySet<string> },
  ctx: RenderContext,
  clipScope: string,
) {
  const measurer = getMeasurer();
  const { document, flow } = documentFor(frame);
  return buildScene(
    document,
    { theme: ctx.theme, measurer, preset: ctx.preset },
    { theme: ctx.theme, measurer, showSequence: true, preset: ctx.preset },
    { selectedFlow: flow, clipScope, movingNodeIds: frame.moving },
  );
}

function defsFor(colors: Iterable<string>, ctx: RenderContext): string {
  const defs = [shadowFilter(ctx.theme.shadow), ...markerDefs(colors, PERSONALITY_PROFILES[ctx.preset].arrowJitter)];
  return markup(defs, ctx.key);
}

export function renderScene(frames: readonly ResolvedFrame[], ctx: RenderContext): RenderedScene {
  const colors = new Set<string>();
  const rendered = frames.map((frame, index) => {
    const scene = build(frame, ctx, `learn-${ctx.key}-${index}`);
    for (const color of scene.arrowColors) colors.add(color);
    const backdrops: RenderedNode[] = [];
    const nodes: RenderedNode[] = [];
    for (const entry of scene.nodeEntries) {
      const item = { node: entry.node, html: markup(entry.els, ctx.key) };
      (entry.node.type === 'group' ? backdrops : nodes).push(item);
    }
    const edges = scene.edgeEntries.map((entry) => ({
      edge: entry.edge,
      lineHtml: markup(entry.lineEls, ctx.key),
      overlayHtml: markup(entry.overlayEls, ctx.key),
    }));
    return { backdrops, nodes, edges };
  });
  return { defs: defsFor(colors, ctx), frames: rendered };
}

const POSTER_PADDING = 18;
const posterCache = new Map<string, string>();

/**
 * A still of a scene's last frame, cropped to what's on it, as a `data:` URI for an `<img>` — which
 * also walls its ids off from the page entirely. Cached per scene, theme and personality: the home
 * view shows several at once and none of them ever changes.
 */
export function scenePoster(
  sceneId: string,
  /** Only called on a cache miss — resolving a scene's frames is the expensive part. */
  lastFrame: () => Pick<ResolvedFrame, 'nodes' | 'edges' | 'flow'> | undefined,
  theme: Theme,
  themeName: string,
  preset: PersonalityPreset,
): string | null {
  const cacheKey = `${sceneId}|${themeName}|${preset}`;
  const cached = posterCache.get(cacheKey);
  if (cached) return cached;
  const frame = lastFrame();
  if (!frame) return null;

  const ctx = { theme, preset, key: `poster-${sceneId}` };
  const scene = build(frame, ctx, `learn-poster-${sceneId}`);
  const bounds = boundsOf(frame.nodes) ?? { x: 0, y: 0, width: 160, height: 100 };
  const x = bounds.x - POSTER_PADDING;
  const y = bounds.y - POSTER_PADDING;
  const width = bounds.width + POSTER_PADDING * 2;
  const height = bounds.height + POSTER_PADDING * 2;
  const root = el(
    'svg',
    { xmlns: 'http://www.w3.org/2000/svg', viewBox: `${x} ${y} ${width} ${height}`, width, height },
    [
      el('defs', undefined, [shadowFilter(theme.shadow), ...markerDefs(scene.arrowColors, PERSONALITY_PROFILES[preset].arrowJitter)]),
      ...scene.backdropEls,
      ...scene.edgeLines,
      ...scene.nodeEls,
      ...scene.edgeOverlays,
    ],
  );
  const uri = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialize(root))}`;
  posterCache.set(cacheKey, uri);
  return uri;
}
