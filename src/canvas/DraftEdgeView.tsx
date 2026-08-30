import { memo, useCallback, useEffect, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, useInternalNode, type EdgeProps } from '@xyflow/react';
import { explainEdgeTier } from '../document/sequence';
import { markerRef } from '../render/svg/markers';
import { accentOf } from '../render/theme/tokens';
import { routeBetween, type Rect } from '../edges/routing';
import { isEdgeFocused, useEditorStore } from '../store/editorStore';
import { selectEdge } from '../store/selectors';
import { useUiStore } from '../store/uiStore';
import { useThemeValue } from '../ui/theme/useTheme';

/**
 * Connector rendering.
 *
 * Geometry comes from `routeBetween` — the same function the SVG exporter
 * calls — so an exported connector traces exactly the path drawn here. The
 * rectangles it is given come from React Flow's live node measurements rather
 * than from the document, which is what lets a connector follow a node smoothly
 * while it is being dragged, before anything has been committed.
 */
export const DraftEdgeView = memo(function DraftEdgeView({ id, selected }: EdgeProps) {
  const edge = useEditorStore((state) => selectEdge(state.document, id));
  const showSequence = useEditorStore((state) => state.document.settings.showSequence);
  const explain = useEditorStore((state) => state.explain);
  const focus = useEditorStore((state) => state.focus);
  const mode = useEditorStore((state) => state.mode);
  const updateEdgeLabel = useEditorStore((state) => state.updateEdgeLabel);
  const theme = useThemeValue();

  const sourceNode = useInternalNode(edge?.source ?? '');
  const targetNode = useInternalNode(edge?.target ?? '');

  const [editing, setEditing] = useState(false);
  const stopEditing = useCallback(() => setEditing(false), []);
  const editRequested = useUiStore((state) => state.editRequestId === id);

  // Same transient-id hook `DraftNodeView` uses for `Enter` — no ref-based
  // imperative API exists into this memoized component either.
  useEffect(() => {
    if (!editRequested) return;
    useUiStore.getState().requestEdit(null);
    // oxlint-disable-next-line set-state-in-effect -- one-shot external command, see comment above.
    if (mode !== 'present') setEditing(true);
  }, [editRequested, mode]);

  if (!edge || !sourceNode || !targetNode) return null;

  const sourceRect = rectOfInternal(sourceNode);
  const targetRect = rectOfInternal(targetNode);
  if (!sourceRect || !targetRect) return null;

  const route = routeBetween(sourceRect, targetRect, edge.routing);
  const palette = accentOf(theme, edge.accent);
  const color = edge.accent && edge.accent !== 'neutral' ? palette.chip : theme.edge;

  const tier = explain.active ? explainEdgeTier(edge.sequence, explain.step) : 'hidden';
  const isActiveStep = explain.active && tier === 'active';
  const isShownStep = explain.active && tier === 'shown';
  const dimmed = explain.active && tier === 'hidden';
  const focusDimmed = focus.active && !isEdgeFocused(focus, edge);

  const hasLabel = Boolean(edge.label);
  const hasStep = showSequence && typeof edge.sequence === 'number';
  // The step being explained is the one thing that should stand out.
  const strokeColor = isActiveStep ? theme.selection : color;

  return (
    <g
      className="dc-edge"
      data-selected={selected ? 'true' : undefined}
      data-active={isActiveStep ? 'true' : undefined}
      data-shown={isShownStep ? 'true' : undefined}
      data-dimmed={dimmed ? 'true' : undefined}
      data-focus-dimmed={focusDimmed ? 'true' : undefined}
    >
{/*
        `BaseEdge` draws the path and, through `interactionWidth`, a second
        invisible one wide enough to click. Hand-rolling that stroke is not
        enough: React Flow keys selection off its own interaction path.
      */}
      <BaseEdge
        className="dc-edge-line"
        path={route.d}
        markerEnd={edge.directed ? markerRef(strokeColor) : undefined}
        interactionWidth={18}
        style={{
          stroke: strokeColor,
          strokeWidth: isActiveStep ? 2.6 : 1.6,
          strokeLinecap: 'round',
        }}
      />

      <EdgeLabelRenderer>
        {(hasLabel || editing) && (
          <div
            className="dc-edge-label"
            data-editing={editing ? 'true' : undefined}
            data-dimmed={dimmed ? 'true' : undefined}
            data-focus-dimmed={focusDimmed ? 'true' : undefined}
            data-shown={isShownStep ? 'true' : undefined}
            data-active={isActiveStep ? 'true' : undefined}
            style={{ transform: `translate(-50%, -50%) translate(${route.labelX}px, ${route.labelY}px)` }}
            onDoubleClick={() => mode === 'edit' && setEditing(true)}
          >
            {hasStep && (
              <span className="dc-edge-label-step" style={{ color }}>
                {edge.sequence}
              </span>
            )}
            {editing ? (
              <input
                autoFocus
                className="dc-edge-label-input"
                defaultValue={edge.label ?? ''}
                spellCheck={false}
                onBlur={(event) => {
                  updateEdgeLabel(edge.id, event.currentTarget.value.trim());
                  stopEditing();
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Enter') {
                    updateEdgeLabel(edge.id, event.currentTarget.value.trim());
                    stopEditing();
                  }
                  if (event.key === 'Escape') stopEditing();
                }}
              />
            ) : (
              edge.label
            )}
          </div>
        )}

        {/*
          A standalone badge only when there is no label to carry it. On a short
          connector the two would otherwise sit on top of each other.
        */}
        {hasStep && !hasLabel && !editing && (
          <div
            className="dc-edge-step"
            data-active={isActiveStep ? 'true' : undefined}
            data-shown={isShownStep ? 'true' : undefined}
            data-dimmed={dimmed ? 'true' : undefined}
            data-focus-dimmed={focusDimmed ? 'true' : undefined}
            style={{
              transform: `translate(-50%, -50%) translate(${badgeX(route)}px, ${badgeY(route)}px)`,
              borderColor: color,
              color,
            }}
          >
            {edge.sequence}
          </div>
        )}
      </EdgeLabelRenderer>
    </g>
  );
});

/** Mirrors `badgePoint` in `edges/describe.ts`, in screen coordinates. */
const BADGE_OFFSET = 22;

function badgeX(route: ReturnType<typeof routeBetween>): number {
  const side = route.source.side;
  if (side === 'left') return route.source.x - BADGE_OFFSET;
  if (side === 'right') return route.source.x + BADGE_OFFSET;
  return route.source.x;
}

function badgeY(route: ReturnType<typeof routeBetween>): number {
  const side = route.source.side;
  if (side === 'top') return route.source.y - BADGE_OFFSET;
  if (side === 'bottom') return route.source.y + BADGE_OFFSET;
  return route.source.y;
}

type InternalNode = NonNullable<ReturnType<typeof useInternalNode>>;

function rectOfInternal(node: InternalNode): Rect | null {
  const width = node.measured?.width ?? node.width;
  const height = node.measured?.height ?? node.height;
  if (width == null || height == null) return null;
  return {
    x: node.internals.positionAbsolute.x,
    y: node.internals.positionAbsolute.y,
    width,
    height,
  };
}
