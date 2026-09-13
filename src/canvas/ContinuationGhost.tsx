import { memo, useMemo } from 'react';
import { relationshipCaptionLabel } from '../document/edgeSemantics';
import type { DraftEdge, DraftNode } from '../document/types';
import { dashForEdge, markerVariantForEdge } from '../edges/kindStyle';
import { captionAnchor, rectOf, routeBetween, type Rect } from '../edges/routing';
import { describeContext, describeNode } from '../nodes/describe';
import { markerRef } from '../render/svg/markers';
import { beginClipScope, emitDisplayList } from '../render/svg/emit';
import { FONTS, cssFont } from '../render/text/fonts';
import { useEditorStore } from '../store/editorStore';
import { useUiStore, type ContinuationOffer } from '../store/uiStore';
import { usePersonality } from '../ui/personality/usePersonality';
import { useThemeValue } from '../ui/theme/useTheme';
import { SvgSurface } from './SvgSurface';

/** Gap between the ghost's box and its pill — the same breathing room a connector caption keeps
 *  from its line, so the two never read as different systems. */
const PILL_GAP = 8;

/** How far the outline marking an existing target sits outside that node's box. */
const TARGET_OUTSET = 6;

/**
 * Intent Continuation's preview: the nodes and connectors an offer would add, drawn in flow space
 * inside `Canvas`'s `<ViewportPortal>` so they pan and zoom with the diagram but never enter the
 * document, projection, history or an export. Every picture comes from the same
 * `describeNode → emitDisplayList` pipeline the real node uses, and every connector from the
 * same `routeBetween`/`dashForEdge`/marker the real edge will get — a ghost is the real thing at
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
  const learn = useUiStore((state) => state.learnModeActive);
  const anchor = useEditorStore((state) => (offer ? state.document.nodes.find((n) => n.id === offer.anchorId) : undefined));
  if (!offer || !anchor) return null;
  return <GhostBody offer={offer} anchor={anchor} learn={learn} />;
});

function GhostBody({ offer, anchor, learn }: { offer: ContinuationOffer; anchor: DraftNode; learn: boolean }) {
  const theme = useThemeValue();
  const { preset } = usePersonality();
  const showPill = offer.trigger === 'select';

  const accept = () => useEditorStore.getState().acceptContinuation(offer);
  const next = () => useUiStore.getState().cycleContinuation(1);

  // One subscription and one `rectOf` pass for the whole ghost, shared by every `GhostEdge` below,
  // instead of each edge independently subscribing to the full node array and re-deriving rects —
  // the dominant cost behind unrelated document edits re-rendering every ghost edge. Includes the
  // offer's *other* fragment nodes too (not just the real document's), so a multi-node fragment's
  // ghost edges see the same obstacles the real edges will see once accepted.
  const nodes = useEditorStore((state) => state.document.nodes);
  const obstacleRects = useMemo(
    () => [
      ...nodes.filter((n) => n.type !== 'group').map((n) => ({ id: n.id, rect: rectOf(n) })),
      ...offer.nodes.map((n) => ({ id: n.id, rect: rectOf(n) })),
    ],
    [nodes, offer.nodes],
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
        {offer.edges.map((edge) => (
          <GhostEdge key={edge.id} edge={edge} endpoints={endpoints} obstacleRects={obstacleRects} />
        ))}
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
            {learn && offer.reason && <span className="dc-ghost-reason">{offer.reason}</span>}
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

function GhostNode({
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
  const shapes = useMemo(() => {
    // Its own clip scope, so a ghost's clip-path ids can never collide with a real node's.
    beginClipScope(`ghost-${node.id}`);
    return emitDisplayList(describeNode(node, describeContext(theme, preset)));
  }, [node, theme, preset]);
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

function GhostEdge({
  edge,
  endpoints,
  obstacleRects,
}: {
  edge: DraftEdge;
  endpoints: ReadonlyMap<string, DraftNode>;
  obstacleRects: { id: string; rect: Rect }[];
}) {
  const theme = useThemeValue();
  const source = endpoints.get(edge.source);
  const target = endpoints.get(edge.target);
  if (!source || !target) return null;
  const obstacles = obstacleRects.filter((n) => n.id !== source.id && n.id !== target.id).map((n) => n.rect);
  const route = routeBetween(rectOf(source), rectOf(target), edge.routing, {
    anchors: { source: edge.sourceAnchor, target: edge.targetAnchor },
    obstacles,
  });
  const caption = edge.semantic ? relationshipCaptionLabel(edge.semantic, edge.hasResponse, edge.deliveryAttempts) : undefined;
  const at = captionAnchor(route.labelSide, route.labelX, route.labelY);
  // Always the theme's plain connector colour: `Markers` mints an arrowhead for it unconditionally,
  // whereas an accent's marker only exists once a real edge of that colour does.
  const color = theme.edge;
  return (
    <g>
      <path
        d={route.d}
        fill="none"
        stroke={color}
        strokeWidth={1.6}
        strokeLinecap="round"
        strokeDasharray={dashForEdge(edge)?.join(' ')}
        markerEnd={edge.directed ? markerRef(color, markerVariantForEdge(edge)) : undefined}
      />
      {caption && (
        <text
          x={at.x}
          y={at.y}
          textAnchor={at.textAnchor}
          dominantBaseline={at.dominantBaseline}
          fill={theme.textFaint}
          style={{ font: cssFont(FONTS.connectorCaption) }}
        >
          {caption}
        </text>
      )}
    </g>
  );
}
