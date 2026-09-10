import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument } from '../src/document/factory';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

const store = useEditorStore;

function reset() {
  __resetInteraction();
  store.setState({
    document: createDocument('Flow edit'),
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    clipboard: null,
    revision: 0,
    mode: 'edit',
    flowPlayback: { active: false, flowId: null, step: 0 },
    focus: { active: false, nodeIds: [], edgeIds: [] },
    flowEdit: { active: false, flowId: null },
    selectedFlowId: null,
  });
}

/**
 * `FlowEditState` — the deliberate, entered-on-purpose state for editing a
 * specific flow's membership, distinct from merely selecting one. Mutually
 * exclusive with Focus and Presentation the same way those two already
 * exclude each other.
 */
describe('flow-edit mode', () => {
  beforeEach(reset);

  it('enters and exits flow-edit mode for a given flow', () => {
    const flowId = store.getState().createFlow('Checkout')!;
    store.getState().enterFlowEdit(flowId);
    expect(store.getState().flowEdit).toEqual({ active: true, flowId });

    store.getState().exitFlowEdit();
    expect(store.getState().flowEdit).toEqual({ active: false, flowId: null });
  });

  it('entering flow-edit exits an active Focus session', () => {
    store.getState().enterFocus(['n1'], []);
    expect(store.getState().focus.active).toBe(true);

    const flowId = store.getState().createFlow('Checkout')!;
    store.getState().enterFlowEdit(flowId);
    expect(store.getState().flowEdit.active).toBe(true);
    expect(store.getState().focus.active).toBe(false);
  });

  it('entering flow-edit exits active playback', () => {
    const flowId = store.getState().createFlow('Checkout')!;
    store.getState().setFlowPlayback({ active: true, flowId, step: 1 });
    expect(store.getState().flowPlayback.active).toBe(true);

    store.getState().enterFlowEdit(flowId);
    expect(store.getState().flowEdit.active).toBe(true);
    expect(store.getState().flowPlayback.active).toBe(false);
  });

  it('starting playback exits an active flow-edit session', () => {
    const flowId = store.getState().createFlow('Checkout')!;
    store.getState().enterFlowEdit(flowId);
    expect(store.getState().flowEdit.active).toBe(true);

    store.getState().setFlowPlayback({ active: true, flowId, step: 1 });
    expect(store.getState().flowPlayback.active).toBe(true);
    expect(store.getState().flowEdit).toEqual({ active: false, flowId: null });
  });

  it('entering Focus exits an active flow-edit session', () => {
    const flowId = store.getState().createFlow('Checkout')!;
    store.getState().enterFlowEdit(flowId);

    store.getState().enterFocus(['n1'], []);
    expect(store.getState().focus.active).toBe(true);
    expect(store.getState().flowEdit).toEqual({ active: false, flowId: null });
  });

  it('switching to present mode exits an active flow-edit session', () => {
    const flowId = store.getState().createFlow('Checkout')!;
    store.getState().enterFlowEdit(flowId);

    store.getState().setMode('present');
    expect(store.getState().flowEdit).toEqual({ active: false, flowId: null });
  });

  it('deleting the flow currently being edited exits flow-edit, mirroring selectedFlowId/flowPlayback cleanup', () => {
    const flowId = store.getState().createFlow('Checkout')!;
    store.getState().setSelectedFlowId(flowId);
    store.getState().enterFlowEdit(flowId);

    store.getState().deleteFlow(flowId);
    expect(store.getState().flowEdit).toEqual({ active: false, flowId: null });
    expect(store.getState().selectedFlowId).toBeNull();
  });

  it('deleting an unrelated flow leaves an active flow-edit session untouched', () => {
    const flowId = store.getState().createFlow('Checkout')!;
    const otherId = store.getState().createFlow('Refund')!;
    store.getState().enterFlowEdit(flowId);

    store.getState().deleteFlow(otherId);
    expect(store.getState().flowEdit).toEqual({ active: true, flowId });
  });
});
