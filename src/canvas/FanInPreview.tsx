import { useStore, type ReactFlowState } from '@xyflow/react';
import { useEditorStore } from '../store/editorStore';
import { useUiStore } from '../store/uiStore';
import { useThemeValue } from '../theme/useTheme';

/** Where the live connection's end is, in flow space — `null` unless one is being drawn. React
 *  Flow keeps it in the pane's own pixels (`getEventPosition`), so it is taken back through the
 *  viewport here. A plain primitive pair joined into a string, so the store hands back the same
 *  value until it moves. */
function selectConnectionEnd(state: ReactFlowState): string | null {
  const connection = state.connection;
  if (!connection.inProgress) return null;
  const [tx, ty, zoom] = state.transform;
  return `${(connection.to.x - tx) / zoom},${(connection.to.y - ty) / zoom}`;
}

/**
 * While a connection is dragged from one of several selected shapes, a faint line from each of the
 * others to the pointer: the drop connects them all, and this says so before it happens. React
 * Flow draws the dragged shape's own line. Drag chrome only — never in an export.
 */
export function FanInPreview() {
  const sources = useUiStore((state) => state.fanInSources);
  const end = useStore(selectConnectionEnd);
  const theme = useThemeValue();
  if (!sources || sources.length === 0 || !end) return null;
  const [x, y] = end.split(',').map(Number) as [number, number];
  const nodes = useEditorStore.getState().document.nodes;
  return (
    <svg className="dc-fan-in-preview" aria-hidden="true">
      {sources.map((id) => {
        const node = nodes.find((n) => n.id === id);
        if (!node) return null;
        return (
          <line
            key={id}
            x1={node.x + node.width / 2}
            y1={node.y + node.height / 2}
            x2={x}
            y2={y}
            stroke={theme.selection}
            strokeWidth={1.4}
            strokeDasharray="4 4"
            strokeOpacity={0.7}
          />
        );
      })}
    </svg>
  );
}
