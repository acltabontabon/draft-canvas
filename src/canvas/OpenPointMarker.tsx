import { memo, useId, useMemo, type CSSProperties } from 'react';
import type { OpenPoint, OpenPointTarget } from '../document/types';
import { OPEN_POINT_LABELS } from '../document/openPoints';
import { MARKER_SIZE, describeMarker, describeMarkerText } from '../openPoints/marker';
import { beginClipScope, emitDisplayList } from '../render/svg/emit';
import { useUiStore } from '../store/uiStore';
import { useThemeValue } from '../ui/theme/useTheme';
import { SvgSurface } from './SvgSurface';

/**
 * The tab an element wears while something about it is still open — the interactive half of
 * `openPoints/marker.ts`, which draws the picture for both the canvas and the exporter.
 *
 * Chrome, never exported: a real button, so a keyboard reaches it once its element is selected (or
 * while presenting, where nothing is selected), with a hover/focus preview that says the kind and
 * the context without a click, and a click that opens the one popover where a point is edited,
 * resolved or removed. Presenting opens the same popover read-only. Rendered by `DraftNodeView`
 * (positioned in the node's own box) and `DraftEdgeView` (in the label layer, beside the label).
 */
export const OpenPointMarker = memo(function OpenPointMarker({
  target,
  points,
  tabbable,
  variant,
  style,
  dim,
}: {
  target: OpenPointTarget;
  /** The unresolved points about this element — never empty; the caller renders nothing otherwise. */
  points: readonly OpenPoint[];
  tabbable: boolean;
  variant: 'node' | 'edge';
  style: CSSProperties;
  /** Dimming flags passed straight through as data attributes, so the marker fades with its host. */
  dim?: { dimmed?: boolean; focusDimmed?: boolean; lensDimmed?: boolean; explainTier?: string };
}) {
  const theme = useThemeValue();
  const previewId = useId();
  const open = useUiStore(
    (state) => state.openPointPopover?.anchor.kind === target.kind && state.openPointPopover.anchor.id === target.id,
  );
  // Re-described only when the points or the theme change — never per pan frame.
  const shapes = useMemo(() => {
    beginClipScope(`open-point-${target.kind}-${target.id}`);
    return emitDisplayList({ width: MARKER_SIZE, height: MARKER_SIZE, shapes: describeMarker(points, { theme }) });
  }, [points, theme, target.kind, target.id]);
  const label = describeMarkerText(points);

  return (
    <button
      type="button"
      // `nodrag`: a press on the tab must not start dragging the shape it sits on.
      className="dc-open-point-marker nodrag"
      data-variant={variant}
      data-anchor={`${target.kind}:${target.id}`}
      data-kind={points.length === 1 ? points[0]!.kind : 'several'}
      data-open={open ? 'true' : undefined}
      data-dimmed={dim?.dimmed ? 'true' : undefined}
      data-focus-dimmed={dim?.focusDimmed ? 'true' : undefined}
      data-lens-dimmed={dim?.lensDimmed ? 'true' : undefined}
      data-explain-tier={dim?.explainTier}
      aria-label={label}
      aria-describedby={previewId}
      aria-expanded={open}
      tabIndex={tabbable ? 0 : -1}
      style={style}
      onPointerDown={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        const ui = useUiStore.getState();
        ui.setOpenPointPopover(open ? null : { anchor: target, targets: [target], creating: false });
      }}
    >
      <SvgSurface className="dc-open-point-glyph" width={MARKER_SIZE} height={MARKER_SIZE}>
        {shapes}
      </SvgSurface>
      {/* The preview: what is open here, readable on hover or focus without committing to a click.
          No controls live in it — everything actionable is in the popover a click opens. */}
      <span className="dc-open-point-preview" id={previewId} role="tooltip">
        {points.map((point) => (
          <span key={point.id} className="dc-open-point-preview-row">
            <span className="dc-open-point-preview-kind" data-kind={point.kind}>
              {OPEN_POINT_LABELS[point.kind]}
            </span>
            {point.context && <span className="dc-open-point-preview-text">{point.context}</span>}
          </span>
        ))}
        {points.length === 1 && points[0]!.targets.length > 1 && (
          <span className="dc-open-point-preview-shared">Also about {points[0]!.targets.length - 1} other {points[0]!.targets.length === 2 ? 'element' : 'elements'}</span>
        )}
      </span>
    </button>
  );
});
