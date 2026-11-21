import { memo, useMemo } from 'react';
import { describeLegend } from '../edges/legend';
import { emitDisplayList } from '../render/svg/emit';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import { useThemeValue } from '../theme/useTheme';
import { SvgSurface } from './SvgSurface';

/**
 * The legend on the canvas: the same row an export draws (`edges/legend.ts`), set in the corner of
 * the pane where it stays put while the diagram pans and zooms. Shown only when asked for and only
 * when the room draws more than one kind of line; worked out again only when its connectors change.
 */
export const CanvasLegend = memo(function CanvasLegend() {
  const shown = useUiStore((state) => state.legendShown);
  const edges = useEditorStore((state) => state.document.edges);
  const theme = useThemeValue();
  const legend = useMemo(() => (shown ? describeLegend(edges, { theme }) : null), [shown, edges, theme]);
  if (!legend) return null;
  return (
    <div className="dc-canvas-legend" role="img" aria-label="Legend: the kinds of line in this diagram">
      <SvgSurface width={Math.ceil(legend.width)} height={legend.height}>
        {emitDisplayList({ width: legend.width, height: legend.height, shapes: legend.shapes })}
      </SvgSurface>
    </div>
  );
});
