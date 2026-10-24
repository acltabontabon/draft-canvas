import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { FlowLensIndicator } from '../src/ui/Editor/FlowLensIndicator';
import { createDocument } from '../src/document/factory';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

/**
 * A chosen flow dims most of the canvas, so whenever it does the canvas says which flow and offers
 * the way back to the whole diagram — and only then.
 */
function reset() {
  __resetInteraction();
  useEditorStore.setState({
    document: createDocument('Flow lens'),
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    revision: 0,
    mode: 'edit',
    flowPlayback: { active: false, flowId: null, step: 0 },
    focus: { active: false, nodeIds: [], edgeIds: [] },
    selectedFlowId: null,
  });
}

function flowWithAStep(title: string) {
  const state = useEditorStore.getState();
  const a = state.addNode({ type: 'service', x: 0, y: 0, text: 'A' });
  const b = state.addNode({ type: 'service', x: 300, y: 0, text: 'B' });
  const edge = state.connect(a.id, b.id)!;
  const id = state.createFlow(title)!;
  state.addEdgeToFlow(id, edge.id);
  return id;
}

describe('FlowLensIndicator', () => {
  beforeEach(reset);

  it('shows nothing on the plain diagram', () => {
    flowWithAStep('Checkout');
    render(<FlowLensIndicator />);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('names the chosen flow and its Whole diagram button clears it', () => {
    const id = flowWithAStep('Checkout');
    render(<FlowLensIndicator />);
    act(() => useEditorStore.getState().setSelectedFlowId(id));

    expect(screen.getByRole('status', { name: 'Showing the Checkout flow' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Whole diagram' }));
    expect(useEditorStore.getState().selectedFlowId).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('stays away for a chosen flow that dims nothing yet, and while Focus owns the dimming', () => {
    const empty = useEditorStore.getState().createFlow('Empty')!;
    render(<FlowLensIndicator />);
    act(() => useEditorStore.getState().setSelectedFlowId(empty));
    expect(screen.queryByRole('status')).toBeNull();

    const id = flowWithAStep('Checkout');
    act(() => {
      useEditorStore.getState().setSelectedFlowId(id);
      useEditorStore.setState({ focus: { active: true, nodeIds: [], edgeIds: [] } });
    });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
