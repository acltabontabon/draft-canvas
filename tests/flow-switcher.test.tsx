import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { FlowSwitcher } from '../src/ui/Editor/FlowSwitcher';
import { createDocument } from '../src/document/factory';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';

/**
 * Regression coverage for a keyboard-accessibility bug: each flow row in the dropdown was a bare
 * `<div role="menuitemradio">` with no `tabIndex`, so keyboard/screen-reader users could reach the
 * "Diagram" option (a real `<button>`) but never an actual flow. The fix makes `tabIndex`/the
 * existing `highlight` state follow real DOM focus and extends the component's single capture-
 * phase keydown handler (instead of adding a second, racing one per row) to accept Space as well
 * as Enter.
 */
function reset() {
  __resetInteraction();
  useEditorStore.setState({
    document: createDocument('Flow switcher'),
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
  useUiStore.setState({ flowSwitcherOpen: true, flowPanelOpen: false });
}

describe('FlowSwitcher keyboard access', () => {
  beforeEach(reset);

  it('selects a focused flow row on Enter and closes the menu', () => {
    const flowId = useEditorStore.getState().createFlow('Checkout');
    render(<FlowSwitcher />);

    const row = screen.getByText('Checkout').closest('[role="menuitemradio"]') as HTMLElement;
    act(() => row.focus());
    fireEvent.keyDown(row, { key: 'Enter' });

    expect(useEditorStore.getState().selectedFlowId).toBe(flowId);
    expect(useUiStore.getState().flowSwitcherOpen).toBe(false);
  });

  it('selects a focused flow row on Space', () => {
    const flowId = useEditorStore.getState().createFlow('Refund');
    render(<FlowSwitcher />);

    const row = screen.getByText('Refund').closest('[role="menuitemradio"]') as HTMLElement;
    act(() => row.focus());
    fireEvent.keyDown(row, { key: ' ' });

    expect(useEditorStore.getState().selectedFlowId).toBe(flowId);
  });

  it('lets the nested Edit button own its own Enter/Space instead of just selecting the row', () => {
    useEditorStore.getState().createFlow('Checkout');
    render(<FlowSwitcher />);

    const editButton = screen.getByRole('button', { name: 'Edit Checkout' });
    act(() => editButton.focus());
    fireEvent.keyDown(editButton, { key: 'Enter' });

    // The row-select branch must not have fired for a keydown targeting the Edit button.
    expect(useUiStore.getState().flowSwitcherOpen).toBe(true);
  });
});
