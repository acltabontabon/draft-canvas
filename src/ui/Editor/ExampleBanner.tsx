import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { Button } from '../common/Button';

export function ExampleBanner({ onPresent }: { onPresent: (id?: string) => void }) {
  const exampleId = useUiStore((state) => state.exampleDocumentId);
  const documentId = useEditorStore((state) => state.document.metadata.id);
  // Opening never selects a flow, the example included: it dimmed the canvas under the lens and
  // turned it back on after every room change. Play explanation names the flow it presents.
  const flowId = useEditorStore((state) => state.document.flows[0]?.id);
  if (exampleId !== documentId) return null;
  return <div className="dc-read-only-banner">
    <span>This example is yours to edit.</span>
    <Button variant="quiet" disabled={!flowId} onClick={() => onPresent(flowId)}>Play explanation</Button>
    <Button variant="quiet" aria-label="Dismiss example hint" onClick={() => useUiStore.getState().setExampleDocumentId(null)}>Dismiss</Button>
  </div>;
}
