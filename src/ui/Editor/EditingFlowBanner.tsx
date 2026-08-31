import { useEditorStore } from '../../store/editorStore';

/**
 * A small, temporary state indicator shown only while intentionally editing
 * a flow's membership — mirrors `FocusIndicator`'s shape and reasoning.
 * Normal connector selection never mutates flow membership; this banner is
 * the visible proof that the user deliberately entered a state where it's
 * safe to do so (see `FlowEditState` in `editorStore.ts`).
 */
export function EditingFlowBanner() {
  const flowEdit = useEditorStore((state) => state.flowEdit);
  const flow = useEditorStore((state) =>
    flowEdit.flowId ? state.document.flows.find((f) => f.id === flowEdit.flowId) : undefined,
  );
  const exitFlowEdit = useEditorStore((state) => state.exitFlowEdit);

  if (!flowEdit.active || !flow) return null;

  return (
    <div className="dc-editing-flow-banner" role="status">
      <span>Editing: {flow.title}</span>
      <button
        type="button"
        className="dc-editing-flow-banner-done"
        title="Stop editing this flow (Esc)"
        onClick={exitFlowEdit}
      >
        Done
      </button>
    </div>
  );
}
