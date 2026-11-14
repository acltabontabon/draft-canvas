import { CONNECTOR_STYLE, styledConnectorPath } from '../render/connectorStyle';
import { memo, useMemo } from 'react';
import { categoryOf } from '../document/connectorSemantics';
import { displayNameFor } from '../document/factory';
import { relationshipCaptionLabel } from '../document/edgeSemantics';
import type { DraftEdge, DraftNode } from '../document/types';
import { edgeRoutes } from '../edges/edgeRoutes';
import { RESPONSE_DASH, dashForEdge, markerVariantForEdge } from '../edges/kindStyle';
import { LABEL_LINE_GAP, captionAnchor, labelChipSide, labelLaneOffset, responseAwayAt, type Side } from '../edges/routing';
import { fittedConnectorCaption, layoutEdgeLabel } from '../edges/labelLayout';
import { baselineOf, type TextLayout } from '../render/text/layout';
import { describeContext, describeNode } from '../nodes/describe';
import { markerRef } from '../render/svg/markers';
import { beginClipScope, emitDisplayList } from '../render/svg/emit';
import { FONTS, cssFont } from '../render/text/fonts';
import { useEditorStore } from '../store/editorStore';
import { useUiStore, type ContinuationOffer } from '../store/uiStore';
import { usePersonality } from '../theme/usePersonality';
import { useThemeValue } from '../theme/useTheme';
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
  const dismiss = () => useUiStore.getState().dismissContinuation();
  const notice = useUiStore((state) => state.continuationNotice);

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
  const index = alternatives.indexOf(offer.id) + 1;
  const position = alternatives.length > 1 ? `${index}/${alternatives.length}` : undefined;
  // Said the way the announcer says it: what accepting does, to whom, and the key — a connection to
  // a shape already drawn runs *from* the anchor, it does not follow it.
  const anchorName = displayNameFor(anchor);
  const acceptLabel = `${offer.actionLabel} ${offer.nodes.length === 0 ? 'from' : 'after'} ${anchorName} (Tab)`;

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
          // Why it is on offer, and how to wave it away — the key is otherwise hinted nowhere on the canvas.
          title={[offer.reason, 'Esc to dismiss'].filter(Boolean).join('\n')}
          // Positioned here and animated on opacity alone: a running `transform` animation replaces the
          // inline one, which parked the pill at the layer's origin for the length of the fade. The
          // scale keeps its words readable zoomed out (`--dc-ghost-pill-scale` in `canvas.css`).
          style={{ transform: `translate(${pillHost.x}px, ${pillHost.y + pillHost.height + PILL_GAP}px) scale(var(--dc-ghost-pill-scale, 1))` }}
        >
          <button type="button" className="dc-ghost-pill-accept" onClick={accept} aria-label={acceptLabel}>
            {/* Keyed so a cycle fades its words in with the ghost it names, rather than swapping them under it. */}
            <span className="dc-ghost-pill-main" key={offer.id}>
              <span>{offer.label}</span>
              <kbd>Tab</kbd>
            </span>
          </button>
          {position && (
            <button
              type="button"
              className="dc-ghost-pill-next"
              onClick={next}
              aria-label={`Next suggestion, ${index} of ${alternatives.length} (])`}
            >
              <span aria-hidden="true">{position}</span>
              <span aria-hidden="true">›</span>
            </button>
          )}
          {notice && (
            <span className="dc-ghost-pill-note" aria-hidden="true">
              {notice}
            </span>
          )}
          {/* Touch has no Tab and no Esc: the dismiss is a button there (and only there — `canvas.css`). */}
          <button type="button" className="dc-ghost-pill-dismiss" onClick={dismiss} aria-label="Dismiss suggestion (Esc)">
            <span aria-hidden="true">✕</span>
          </button>
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
  spread,
  tracks,
  caption: routedCaptionText,
  removed,
}: GhostRoute & {
  edge: DraftEdge;
  removed?: boolean;
}) {
  const theme = useThemeValue();
  // The same inputs, and the same cache, as the real connector (`edges/edgeRoutes.ts`) — read, never
  // written: `'transient'`, so a preview's routes never push out the ones on screen.
  const routes = useMemo(
    () => edgeRoutes(ghostRouteInputs(edge, { source, target, lane, spine, obstacles, spread, tracks, caption: routedCaptionText }), 'transient'),
    [edge, source, target, lane, spine, obstacles, spread, tracks, routedCaptionText],
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
  // Placed the way both renderers place it: nudged off its parallel siblings, on the side away
  // from its reply line, and laid out by the same functions. A label wraps to the room its line
  // leaves and sits where its chip would; a caption shared by a fan is drawn once, on the stem,
  // and one its line has no room for is left out. Drawn by simpler rules, a preview showed words
  // running under shapes that the diagram it previews would never draw there.
  const nudge = labelLaneOffset(route.source.side, route.target.side, lane);
  const away = responseAwayAt(route, routes.response, lane);
  const onStem = !edge.label && Boolean(route.trunkLabel);
  const point = onStem ? route.trunkLabel! : { x: route.labelX + nudge.x, y: route.labelY + nudge.y };
  const words = !caption
    ? null
    : edge.label
    ? layoutEdgeLabel(edge.label, undefined, route.labelRoom)
    : fittedConnectorCaption(caption, undefined, onStem ? route.trunkLabelRoom : route.labelRoom);
  const at = captionAnchor(onStem ? (route.trunkLabelSide ?? route.labelSide) : route.labelSide, point.x, point.y, away);
  const chip = edge.label && words ? ghostLabelLines(words, labelChipSide(route.labelSide, away), point) : null;
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
        d={styledConnectorPath(route.d, edge)}
        fill="none"
        stroke={color}
        strokeWidth={CONNECTOR_STYLE.lineWidth}
        strokeLinecap="round"
        strokeDasharray={removed ? REMOVED_EDGE_DASH : dashForEdge(edge)?.join(' ')}
        markerEnd={edge.directed ? markerRef(color, markerVariantForEdge(edge)) : undefined}
      />
      {/* A request/response connector's reply — its own lane, back to the source, as both renderers
          draw it. */}
      {response && (
        <path
          d={styledConnectorPath(response.d, edge)}
          fill="none"
          stroke={color}
          strokeWidth={1}
          strokeLinecap="round"
          strokeDasharray={RESPONSE_DASH.join(' ')}
          opacity={0.8}
          markerEnd={edge.directed ? markerRef(color, 'open') : undefined}
        />
      )}
      {chip ? (
        <text textAnchor={chip.textAnchor} fill={color} style={{ font: cssFont(FONTS.edgeLabel), textDecoration: removed ? 'line-through' : undefined }}>
          {chip.lines.map((line) => (
            <tspan key={line.y} x={chip.x} y={line.y}>
              {line.text}
            </tspan>
          ))}
        </text>
      ) : words && (
        <text
          x={at.x}
          y={at.y}
          textAnchor={at.textAnchor}
          dominantBaseline={at.dominantBaseline}
          fill={color}
          style={{ font: cssFont(FONTS.connectorCaption), textDecoration: removed ? 'line-through' : undefined }}
        >
          {words.lines[0]?.text ?? caption}
        </text>
      )}
    </g>
  );
}, sameGhostEdge);

/**
 * A label's lines where its chip puts them (`labelChipTransform` in `DraftEdgeView`): the block of
 * text `LABEL_LINE_GAP` off the line on `side`, centred along a level run and beside an upright one.
 * A ghost has no chip to draw, only the words.
 */
function ghostLabelLines(layout: TextLayout, side: Side, point: { x: number; y: number }): { x: number; textAnchor: 'start' | 'middle' | 'end'; lines: { y: number; text: string }[] } {
  const top = side === 'top' ? point.y - LABEL_LINE_GAP - layout.height : side === 'bottom' ? point.y + LABEL_LINE_GAP : point.y - layout.height / 2;
  const x = side === 'right' ? point.x + LABEL_LINE_GAP : side === 'left' ? point.x - LABEL_LINE_GAP : point.x;
  return {
    x,
    textAnchor: side === 'right' ? 'start' : side === 'left' ? 'end' : 'middle',
    lines: layout.lines.map((line, index) => ({ y: top + baselineOf(layout, index), text: line.text })),
  };
}

/** Every prop by identity, except what is rebuilt with each graph: the obstacle list, of rects that
 *  keep their identity while their node does (`obstaclesForEdge`) — compared element by element — and
 *  the two plans' answers, which a transient plan does not intern (`endpoints.ts`, `separation.ts`):
 *  small values, compared by what they hold. */
function sameGhostEdge(a: GhostRoute & { edge: DraftEdge; removed?: boolean }, b: GhostRoute & { edge: DraftEdge; removed?: boolean }): boolean {
  return (
    a.edge === b.edge &&
    a.source === b.source &&
    a.target === b.target &&
    a.lane === b.lane &&
    a.spine === b.spine &&
    a.caption === b.caption &&
    a.removed === b.removed &&
    (a.spread === b.spread || JSON.stringify(a.spread) === JSON.stringify(b.spread)) &&
    (a.tracks === b.tracks || JSON.stringify(a.tracks) === JSON.stringify(b.tracks)) &&
    (a.obstacles === b.obstacles ||
      (a.obstacles.length === b.obstacles.length && a.obstacles.every((rect, index) => rect === b.obstacles[index])))
  );
}
