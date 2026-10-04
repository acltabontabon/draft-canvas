import { useEffect } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { Button } from '../common/Button';

export function ExampleBanner({ onPresent }: { onPresent: (id?: string) => void }) {
  const exampleId = useUiStore((state) => state.exampleDocumentId);
  const documentId = useEditorStore((state) => state.document.metadata.id);
  const flowId = useEditorStore((state) => state.document.flows[0]?.id);
  useEffect(() => {
    const editor = useEditorStore.getState();
    if (exampleId === documentId && flowId && !editor.selectedFlowId) editor.setSelectedFlowId(flowId);
  }, [exampleId, documentId, flowId]);
  if (exampleId !== documentId) return null;
  return <div className="dc-read-only-banner">
    <span>This example is yours to edit.</span>
    <Button variant="quiet" disabled={!flowId} onClick={() => onPresent(flowId)}>Play explanation</Button>
    <Button variant="quiet" aria-label="Dismiss example hint" onClick={() => useUiStore.getState().setExampleDocumentId(null)}>Dismiss</Button>
  </div>;
}
