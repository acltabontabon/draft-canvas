import { useEffect } from 'react';
import { useEditorStore } from '../../store/editorStore';
import { useUiStore } from '../../store/uiStore';
import { isEditableTarget } from '../../lib/isEditableTarget';
import { LIMITS } from '../../document/limits';
import { displayNameFor } from '../../document/factory';
import { Button } from '../common/Button';

export function FlowTraceBar() {
  const trace = useUiStore((state) => state.flowTrace);
  const active = trace !== null;
  const room = useEditorStore((state) => trace ? state.document : null);
  useEffect(() => {
    if (!active) return;
    const check = () => {
      const current = useUiStore.getState().flowTrace;
      if (!current) return;
      const editor = useEditorStore.getState();
      if (current.revision !== editor.revision || current.documentId !== editor.document.metadata.id || JSON.stringify(current.path) !== JSON.stringify(editor.path) || editor.mode !== 'edit') {
        useUiStore.getState().setFlowTrace(null);
        useUiStore.getState().notify('Tracing cancelled because the diagram or level changed.');
      }
    };
    check();
    return useEditorStore.subscribe(check);
  }, [active]);
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      const current = useUiStore.getState().flowTrace;
      if (!current) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        useUiStore.getState().setFlowTrace(null);
      } else if (event.key === 'Backspace' && !isEditableTarget(event.target)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        removeLast();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active]);
  if (!trace || !room) return null;
  const flow = room.flows.find((item) => item.id === trace.flowId);
  const stepCount = (flow?.steps.length ?? 0) + trace.edgeIds.length;
  const labelFor = (id: string) => {
    const edge = room.edges.find((item) => item.id === id);
    const source = room.nodes.find((item) => item.id === edge?.source);
    const target = room.nodes.find((item) => item.id === edge?.target);
    return `${source ? displayNameFor(source) : 'Shape'} → ${target ? displayNameFor(target) : 'Shape'}${edge?.label ? `: ${edge.label}` : ''}`;
  };
  return (
    <section className="dc-trace-bar" aria-label="Trace a flow" data-dc-keyboard-region="">
      <div className="dc-trace-controls">
        {flow ? <strong>{flow.title}</strong> : <input aria-label="Flow name" placeholder="Name this flow" maxLength={LIMITS.maxFlowTitleLength} value={trace.title} onChange={(event) => useUiStore.getState().setFlowTrace({ ...trace, title: event.target.value })} />}
        <span>{stepCount} {stepCount === 1 ? 'step' : 'steps'}</span>
        <Button variant="quiet" disabled={!trace.edgeIds.length} onClick={removeLast}>Remove last</Button>
        <Button variant="solid" disabled={!trace.edgeIds.length} onClick={() => useEditorStore.getState().finishFlowTrace()}>Finish</Button>
        <Button variant="quiet" onClick={() => useUiStore.getState().setFlowTrace(null)}>Cancel</Button>
        <Button variant="quiet" onClick={() => useUiStore.getState().setOutlinePanelOpen(true)}>Outline</Button>
      </div>
      <p role="status">{trace.message}</p>
      {trace.choices.length > 0 && <div role="group" aria-label="Choose a connector">
        <p>Which connector?</p>
        {trace.choices.map((id) => <Button key={id} variant="quiet" onClick={() => useEditorStore.getState().traceEdge(id)}>{labelFor(id)}</Button>)}
      </div>}
    </section>
  );
}

function removeLast() {
  const ui = useUiStore.getState();
  const trace = ui.flowTrace;
  if (trace?.edgeIds.length) ui.setFlowTrace({ ...trace, edgeIds: trace.edgeIds.slice(0, -1), choices: [], message: 'Removed the last provisional step.' });
}
