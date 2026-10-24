import { lensFlow, useEditorStore } from '../../store/editorStore';
import { Button } from '../common/Button';
import { Icon } from '../common/Icon';

/**
 * Says so whenever a chosen flow is dimming the canvas, and is the way back out of it — the same
 * small pill Focus uses, for the same reason: a view that hides part of the diagram must name
 * itself and show its exit. Before this, leaving a flow meant opening the Flows panel and finding
 * its "Diagram" row, and at narrower widths, where the toolbar drops the flow's name, nothing on
 * screen said why most of the diagram had gone grey.
 *
 * Follows `lensFlow`, the one answer to "is the lens on": an empty flow just created dims nothing,
 * so it gets no pill. Escape on the canvas does the same as the button (`EditorScreen`'s cascade).
 */
export function FlowLensIndicator() {
  // A string (or undefined), so the selector is stable across unrelated store updates.
  const title = useEditorStore((state) => lensFlow(state)?.title);
  const setSelectedFlowId = useEditorStore((state) => state.setSelectedFlowId);

  if (title === undefined) return null;

  return (
    <div className="dc-focus-indicator dc-flow-lens-indicator" role="status" aria-label={`Showing the ${title} flow`}>
      <Icon name="flow" size={13} />
      <span className="dc-flow-lens-title" title={title}>
        {title}
      </span>
      <Button
        variant="quiet"
        className="dc-flow-lens-exit"
        title="Show the whole diagram (Esc)"
        onClick={() => setSelectedFlowId(null)}
      >
        Whole diagram
        <kbd aria-hidden="true">Esc</kbd>
      </Button>
    </div>
  );
}
