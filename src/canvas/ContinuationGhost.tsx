import { memo, useMemo } from 'react';
import { categoryOf } from '../document/connectorSemantics';
import { relationshipCaptionLabel } from '../document/edgeSemantics';
import type { DraftEdge, DraftNode } from '../document/types';
import { edgeRoutes } from '../edges/edgeRoutes';
import { RESPONSE_DASH, dashForEdge, markerVariantForEdge } from '../edges/kindStyle';
import { captionAnchor, labelLaneOffset, responseAwayFor } from '../edges/routing';
import { describeContext, describeNode } from '../nodes/describe';
import { markerRef } from '../render/svg/markers';
import { beginClipScope, emitDisplayList } from '../render/svg/emit';
import { FONTS, cssFont } from '../render/text/fonts';
import { useEditorStore } from '../store/editorStore';
import { useUiStore, type ContinuationOffer } from '../store/uiStore';
import { usePersonality } from '../ui/personality/usePersonality';
import { useThemeValue } from '../ui/theme/useTheme';
import { ghostGraph, ghostRouteFor, ghostRouteInputs, type GhostRoute } from './ghostRoutes';
import { SvgSurface } from './SvgSurface';
import { useTechnologyIcon } from './useTechnologyIcon';

/** Gap between the ghost's box and its pill — the same breathing room a connector caption keeps
 *  from its line, so the two never read as different systems. */
const PILL_GAP = 8;

/** How far the outline marking an existing target sits outside that node's box. */
const TARGET_OUTSET = 6;

/**
 * Intent Continuation's preview: the nodes and connectors an offer would add, drawn in flow space
 * inside `Canvas`'s `<ViewportLayer>` so they pan and zoom with the diagram but never enter the
 * document, projection, history or an export. Every picture comes from the same
 * `describeNode → emitDisplayList` pipeline the real node uses, and every connector from the
 * same `edgeRoutes`/`dashForEdge`/marker the real edge will get — a ghost is the real thing at
 * reduced opacity, not an approximation of it. A compound offer (Queue → Worker) draws all of
 * its nodes and connectors; an offer to connect to something already drawn draws only the
 * connector and a quiet outline around that node — never a copy of it.
 *
 * A `'select'` offer carries its own affordance (the pill; the box itself is clickable too) and
 * is what Tab accepts. A `'drop'` offer is the Quick Connect menu's live preview of its
 * highlighted row — the menu is the affordance, so no pill.
 */
export const ContinuationGhost = memo(function ContinuationGhost() {
  const offer = useUiStore((state) => state.continuation);
  const anchor = useEditorStore((state) => (offer ? state.document.nodes.find((n) => n.id === offer.anchorId) : undefined));
  if (!offer || !anchor) return null;
  return <GhostBody offer={offer} anchor={anchor} />;
});

function GhostBody({ offer, anchor }: { offer: ContinuationOffer; anchor: DraftNode }) {
  const theme = useThemeValue();
  const { preset } = usePersonality();
  const showPill = offer.trigger === 'select';

  const accept = () => useEditorStore.getState().acceptContinuation(offer);
  const next = () => useUiStore.getState().cycleContinuation(1);

  // One subscription and one routing graph for the whole ghost, shared by every `GhostEdge` below:
  // the document as it will be once the offer is accepted — its nodes *and* the fragment's, its
  // connectors and the fragment's — so a ghost connector takes the lane, trunk and obstacles the
  // real one will (see `ghostRoutes.ts`).
  const nodes = useEditorStore((state) => state.document.nodes);
  const edges = useEditorStore((state) => state.document.edges);
  const graph = useMemo(
    () => ghostGraph([...nodes, ...offer.nodes], [...edges, ...offer.edges]),
    [nodes, edges, offer.nodes, offer.edges],
  );
  // Endpoints a ghost connector can reach: the anchor, the fragment's own new nodes, and — for a
  // connect-to-existing offer — nodes already drawn, read live so the preview follows them.
  const endpoints = useMemo(() => {
    const byId = new Map<string, DraftNode>([[anchor.id, anchor]]);
    for (const ref of offer.fragment.existing ?? []) {
      const node = nodes.find((n) => n.id === ref.nodeId);
      if (node) byId.set(node.id, node);
    }
    for (const node of offer.nodes) byId.set(node.id, node);
    return byId;
  }, [anchor, nodes, offer.fragment.existing, offer.nodes]);
  const targets = (offer.fragment.existing ?? []).flatMap((ref) => endpoints.get(ref.nodeId) ?? []);

  // The pill sits under what the offer adds — the first new node, or the existing node it reaches.
  const pillHost = offer.nodes[0] ?? endpoints.get(offer.continueFromId) ?? anchor;
  const alternatives = offer.alternatives ?? [];
  const position = alternatives.length > 1 ? `${alternatives.indexOf(offer.id) + 1}/${alternatives.length}` : undefined;

  return (
    <div className="dc-ghost" data-trigger={offer.trigger} aria-hidden={showPill ? undefined : 'true'}>
      {targets.map((target) => (
        <div
          key={target.id}
          className="dc-ghost-target"
          data-type={target.type}
          style={{
            transform: `translate(${target.x - TARGET_OUTSET}px, ${target.y - TARGET_OUTSET}px)`,
            width: target.width + TARGET_OUTSET * 2,
            height: target.height + TARGET_OUTSET * 2,
          }}
        />
      ))}
      <svg className="dc-ghost-edges" width={1} height={1} aria-hidden="true" focusable="false">
        {offer.edges.map((edge) => {
          const route = ghostRouteFor(graph, edge);
          return route && <GhostEdge key={edge.id} edge={edge} {...route} />;
        })}
      </svg>
      {offer.nodes.map((node) => (
        <GhostNode key={node.id} node={node} theme={theme} preset={preset} onClick={showPill ? accept : undefined} />
      ))}
      {showPill && (
        <div
          className="dc-ghost-pill"
          style={{ transform: `translate(${pillHost.x}px, ${pillHost.y + pillHost.height + PILL_GAP}px)` }}
        >
          <button
            type="button"
            className="dc-ghost-pill-accept"
            onClick={accept}
            aria-label={`${offer.actionLabel} after ${anchor.text || anchor.type} (Tab)`}
          >
            <span className="dc-ghost-pill-main">
              <span>{offer.label}</span>
              <kbd>Tab</kbd>
            </span>
          </button>
          {position && (
            <button type="button" className="dc-ghost-pill-next" onClick={next} aria-label="Next suggestion (])">
              <span>{position}</span>
              <span aria-hidden="true">›</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/** A node drawn exactly as the canvas draws it, at a ghost's opacity — shared with `AgentPreviewLayer`. */
export function GhostNode({
  node,
  theme,
  preset,
  onClick,
}: {
  node: DraftNode;
  theme: ReturnType<typeof useThemeValue>;
  preset: ReturnType<typeof usePersonality>['preset'];
  onClick?: () => void;
}) {
  const technologyIcon = useTechnologyIcon(node.technology);
  const shapes = useMemo(() => {
    // Its own clip scope, so a ghost's clip-path ids can never collide with a real node's.
    beginClipScope(`ghost-${node.id}`);
    return emitDisplayList(describeNode(node, describeContext(theme, preset)));
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- Artwork can finish loading without a document change.
  }, [node, theme, preset, technologyIcon]);
  return (
    // Position lives on this outer element alone, so it can glide smoothly (`transition:
    // transform`) when a same-identity offer's placement shifts. The mount-in scale/fade
    // `animation` below lives on `.dc-ghost-node-body` instead of here for the same reason
    // `dc-attachment-card-in` already does elsewhere in this file's stylesheet: a CSS animation
    // replaces the whole `transform` property for its duration, so animating scale on the same
    // element that positions itself via `transform: translate(...)` would clobber that position
    // for the animation's length.
    <div
      className="dc-ghost-node"
      data-type={node.type}
      style={{ transform: `translate(${node.x}px, ${node.y}px)`, width: node.width, height: node.height }}
    >
      <div className="dc-ghost-node-body" onClick={onClick}>
        <SvgSurface className="dc-ghost-surface" width={node.width} height={node.height}>
          {shapes}
        </SvgSurface>
      </div>
    </div>
  );
}

/** The tight, even dash `AgentPreviewLayer` draws a connector's removal with — distinct from any
 *  ordinary dash pattern `dashForEdge` mints for a real (or added/modified) connector. */
const REMOVED_EDGE_DASH = '3 3';

/** A connector routed exactly as the canvas routes it, at a ghost's opacity — shared with `AgentPreviewLayer`.
 *  `removed` draws it in the same danger colour as `.dc-agent-preview-removed`'s crossed-out box,
 *  for a connector the change takes away rather than adds or rewires. Its route context (lane,
 *  trunk, obstacles — see `ghostRoutes.ts`) arrives as stable values, so a ghost whose own route
 *  can't have changed skips the render. */
export const GhostEdge = memo(function GhostEdge({
  edge,
  source,
  target,
  lane,
  spine,
  obstacles,
  removed,
}: GhostRoute & {
  edge: DraftEdge;
  removed?: boolean;
}) {
  const theme = useThemeValue();
  // The same inputs, and the same cache, as the real connector (`edges/edgeRoutes.ts`) — read, never
  // written: `'transient'`, so a preview's routes never push out the ones on screen.
  const routes = useMemo(
    () => edgeRoutes(ghostRouteInputs(edge, { source, target, lane, spine, obstacles }), 'transient'),
    [edge, source, target, lane, spine, obstacles],
  );
  const route = routes.request;
  // Its own words when it has them (a connector an agent is proposing usually does), else the
  // relationship's caption.
  const caption = edge.label
    ? edge.label
    : edge.semantic
    ? relationshipCaptionLabel(edge.semantic, {
        hasResponse: edge.hasResponse,
        deliveryAttempts: edge.deliveryAttempts,
        source: categoryOf(source),
        target: categoryOf(target),
      })
    : undefined;
  // Placed the way both renderers place it: nudged off its parallel siblings, and on the side away
  // from its reply line.
  const nudge = labelLaneOffset(route.source.side, route.target.side, lane);
  const at = captionAnchor(route.labelSide, route.labelX + nudge.x, route.labelY + nudge.y, responseAwayFor(edge.hasResponse, lane));
  const response = routes.response;
  // Always a literal colour from `theme`, on both branches: `Markers` mints every arrowhead once,
  // as static SVG markup keyed by exact colour string (`Markers.tsx`'s `colors` Set) — a CSS custom
  // property string here would mint a `marker-end` reference nothing in `<defs>` ever defines, and
  // the browser silently drops an unresolvable marker reference (no arrowhead, not a fallback one).
  // `theme.danger` matches the CSS `--dc-danger` `.dc-agent-preview-removed` uses, so the two
  // treatments still read as one system in both themes — just via the same literal-colour route
  // every other connector on screen already takes.
  const color = removed ? theme.danger : theme.edge;
  return (
    <g>
      <path
        d={route.d}
        fill="none"
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeDasharray={removed ? REMOVED_EDGE_DASH : dashForEdge(edge)?.join(' ')}
        markerEnd={edge.directed ? markerRef(color, markerVariantForEdge(edge)) : undefined}
      />
      {/* A request/response connector's reply — its own lane, back to the source, as both renderers
          draw it. */}
      {response && (
        <path
          d={response.d}
          fill="none"
          stroke={color}
          strokeWidth={1}
          strokeLinecap="round"
          strokeDasharray={RESPONSE_DASH.join(' ')}
          opacity={0.8}
          markerEnd={edge.directed ? markerRef(color, 'open') : undefined}
        />
      )}
      {caption && (
        <text
          x={at.x}
          y={at.y}
          textAnchor={at.textAnchor}
          dominantBaseline={at.dominantBaseline}
          fill={color}
          style={{ font: cssFont(FONTS.connectorCaption), textDecoration: removed ? 'line-through' : undefined }}
        >
          {caption}
        </text>
      )}
    </g>
  );
}, sameGhostEdge);

/** Every prop by identity, except the obstacle list: rebuilt with each graph, but of rects that keep
 *  their identity while their node does (`obstaclesForEdge`) — so compared element by element. */
function sameGhostEdge(a: GhostRoute & { edge: DraftEdge; removed?: boolean }, b: GhostRoute & { edge: DraftEdge; removed?: boolean }): boolean {
  return (
    a.edge === b.edge &&
    a.source === b.source &&
    a.target === b.target &&
    a.lane === b.lane &&
    a.spine === b.spine &&
    a.removed === b.removed &&
    (a.obstacles === b.obstacles ||
      (a.obstacles.length === b.obstacles.length && a.obstacles.every((rect, index) => rect === b.obstacles[index])))
  );
}
