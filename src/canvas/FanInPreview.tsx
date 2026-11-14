import { memo } from 'react';
import { useStore, type ReactFlowState } from '@xyflow/react';
import { useEditorStore } from '../store/editorStore';
import { nodeIndex } from '../store/selectors';
import { useUiStore } from '../store/uiStore';
import { useThemeValue } from '../theme/useTheme';

/** Where the live connection's end is, in flow space — `null` unless one is being drawn. React
 *  Flow keeps it in the pane's own pixels (`getEventPosition`), so it is taken back through the
 *  viewport here. Two selectors that answer a plain number each, so the store hands back the same
 *  value until it moves and no pair is built to be taken apart again. */
function selectConnectionEndX(state: ReactFlowState): number | null {
  const connection = state.connection;
  return connection.inProgress ? (connection.to.x - state.transform[0]) / state.transform[2] : null;
}

function selectConnectionEndY(state: ReactFlowState): number | null {
  const connection = state.connection;
  return connection.inProgress ? (connection.to.y - state.transform[1]) / state.transform[2] : null;
}

/**
 * While a connection is dragged from one of several selected shapes, a faint line from each of the
 * others to the pointer: the drop connects them all, and this says so before it happens. React
 * Flow draws the dragged shape's own line. Drag chrome only — never in an export.
 *
 * Split in two so a diagram at rest pays nothing for it: this half watches only whether a fan-in is
 * being dragged, and the lines — which follow the document's shapes and the pointer — exist only for
 * as long as it is.
 */
export const FanInPreview = memo(function FanInPreview() {
  const sources = useUiStore((state) => state.fanInSources);
  return sources && sources.length > 0 ? <FanInLines sources={sources} /> : null;
});

function FanInLines({ sources }: { sources: readonly string[] }) {
  const x = useStore(selectConnectionEndX);
  const y = useStore(selectConnectionEndY);
  const nodes = useEditorStore((state) => state.document.nodes);
  const theme = useThemeValue();
  if (x === null || y === null) return null;
  const byId = nodeIndex(nodes);
  return (
    <svg className="dc-fan-in-preview" aria-hidden="true">
      {sources.map((id) => {
        const node = byId.get(id);
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
