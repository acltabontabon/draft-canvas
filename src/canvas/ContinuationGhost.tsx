import { memo, useMemo } from 'react';
import { relationshipCaptionLabel } from '../document/edgeSemantics';
import type { DraftEdge, DraftNode } from '../document/types';
import { dashForEdge, markerVariantForEdge } from '../edges/kindStyle';
import { captionAnchor, rectOf, routeBetween } from '../edges/routing';
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

/**
 * Intent Continuation's preview: the nodes and connectors an offer would add, drawn in flow space
 * inside `Canvas`'s `<ViewportPortal>` so they pan and zoom with the diagram but never enter the
 * document, projection, history or an export. Every picture comes from the same
 * `describeNode → emitDisplayList` pipeline the real node uses, and every connector from the
 * same `routeBetween`/`dashForEdge`/marker the real edge will get — a ghost is the real thing at
 * reduced opacity, not an approximation of it.
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
  const primary = offer.nodes[0]!;
  const showPill = offer.trigger === 'select';

  const accept = () => useEditorStore.getState().acceptContinuation(offer);

  return (
    <div className="dc-ghost" data-trigger={offer.trigger} aria-hidden={showPill ? undefined : 'true'}>
      <svg className="dc-ghost-edges" width={1} height={1} aria-hidden="true" focusable="false">
        {offer.edges.map((edge) => (
          <GhostEdge key={edge.id} edge={edge} offer={offer} anchor={anchor} />
        ))}
      </svg>
      {offer.nodes.map((node) => (
        <GhostNode key={node.id} node={node} theme={theme} preset={preset} onClick={showPill ? accept : undefined} />
      ))}
      {showPill && (
        <button
          type="button"
          className="dc-ghost-pill"
          style={{ transform: `translate(${primary.x}px, ${primary.y + primary.height + PILL_GAP}px)` }}
          onClick={accept}
          aria-label={`Add ${offer.label} after ${anchor.text || anchor.type} (Tab)`}
        >
          <span className="dc-ghost-pill-main">
            <span>{offer.label}</span>
            <kbd>Tab</kbd>
          </span>
          {learn && offer.reason && <span className="dc-ghost-reason">{offer.reason}</span>}
        </button>
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
    <div
      className="dc-ghost-node"
      data-type={node.type}
      style={{ transform: `translate(${node.x}px, ${node.y}px)`, width: node.width, height: node.height }}
      onClick={onClick}
    >
      <SvgSurface className="dc-ghost-surface" width={node.width} height={node.height}>
        {shapes}
      </SvgSurface>
    </div>
  );
}

function GhostEdge({ edge, offer, anchor }: { edge: DraftEdge; offer: ContinuationOffer; anchor: DraftNode }) {
  const theme = useThemeValue();
  const nodes = useEditorStore((state) => state.document.nodes);
  const byId = new Map<string, DraftNode>([[anchor.id, anchor], ...offer.nodes.map((n) => [n.id, n] as const)]);
  const source = byId.get(edge.source);
  const target = byId.get(edge.target);
  if (!source || !target) return null;
  const obstacles = nodes.filter((n) => n.id !== source.id && n.id !== target.id && n.type !== 'group').map(rectOf);
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
