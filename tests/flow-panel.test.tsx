import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FlowPanel } from '../src/ui/Editor/FlowPanel';
import { createDocument } from '../src/document/factory';
import type { FlowPlaybackController } from '../src/presentation/useFlowPlayback';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';

/**
 * The Flows panel is the one surface for flows, so its interaction contract is pinned here:
 * creating a flow lands you in its name field, naming is Enter-to-commit / Escape-to-keep, rows
 * select on click and on Enter, F2 renames, Delete deletes, and an empty flow can't be presented.
 */
function reset() {
  __resetInteraction();
  useEditorStore.setState({
    document: createDocument('Flow panel'),
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    clipboard: null,
    revision: 0,
    mode: 'edit',
    flowPlayback: { active: false, flowId: null, step: 0 },
    focus: { active: false, nodeIds: [], edgeIds: [] },
    selectedFlowId: null,
  });
  useUiStore.setState({ flowPanelOpen: true, flowRenameRequestId: null });
}

function playbackStub(): FlowPlaybackController {
  return {
    flows: [],
    flow: null,
    steps: [],
    step: 0,
    current: null,
    active: false,
    picking: false,
    canStart: false,
    start: vi.fn(),
    pickFlow: vi.fn(),
    stop: vi.fn(),
    next: vi.fn(),
    previous: vi.fn(),
    goTo: vi.fn(),
  };
}

function mount() {
  return render(<FlowPanel playback={playbackStub()} />);
}

function addConnectedPair() {
  const state = useEditorStore.getState();
  const a = state.addNode({ type: 'service', x: 0, y: 0, text: 'A' });
  const b = state.addNode({ type: 'service', x: 300, y: 0, text: 'B' });
  return state.connect(a.id, b.id)!;
}

function rowFor(title: string): HTMLElement {
  return screen.getByText(title).closest('.dc-flow-item') as HTMLElement;
}

describe('FlowPanel', () => {
  beforeEach(reset);

  it('teaches the concept when there are no flows and offers New flow as the one action', () => {
    mount();
    expect(screen.getByText('Tell a story through your diagram.')).toBeTruthy();
    expect(screen.queryByLabelText('New flow')).toBeNull(); // no header "+" — the empty state's own button is enough
    expect(screen.getByRole('button', { name: 'New flow' })).toBeTruthy();
  });

  it('creating a flow selects it, expands it, and opens its name field with the default selected', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'New flow' }));

    const input = screen.getByLabelText('Flow name') as HTMLInputElement;
    expect(input.value).toBe('Untitled flow');
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe('Untitled flow'.length);
    const flowId = useEditorStore.getState().document.flows[0]!.id;
    expect(useEditorStore.getState().selectedFlowId).toBe(flowId);
    expect(screen.getByText(/No steps yet/)).toBeTruthy();
  });

  it('Enter commits the typed name and Escape keeps the old one', () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'New flow' }));
    const input = screen.getByLabelText('Flow name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Checkout' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    fireEvent.blur(input);
    expect(useEditorStore.getState().document.flows[0]!.title).toBe('Checkout');
    expect(screen.queryByLabelText('Flow name')).toBeNull();

    fireEvent.doubleClick(screen.getByText('Checkout'));
    const again = screen.getByLabelText('Flow name') as HTMLInputElement;
    fireEvent.change(again, { target: { value: 'Refund' } });
    fireEvent.keyDown(again, { key: 'Escape' });
    fireEvent.blur(again);
    expect(useEditorStore.getState().document.flows[0]!.title).toBe('Checkout');
    expect(screen.queryByLabelText('Flow name')).toBeNull();
  });

  it('a New flow request from elsewhere opens the panel row in rename mode, once', () => {
    const flowId = useEditorStore.getState().createFlow('Checkout')!;
    mount();
    act(() => useUiStore.getState().requestFlowRename(flowId));
    expect(screen.getByLabelText('Flow name')).toBeTruthy();
    expect(useUiStore.getState().flowRenameRequestId).toBeNull();
  });

  it('clicking a row makes it the active flow, and Diagram clears it', () => {
    const checkout = useEditorStore.getState().createFlow('Checkout')!;
    useEditorStore.getState().createFlow('Refund');
    mount();

    fireEvent.click(screen.getByText('Checkout'));
    expect(useEditorStore.getState().selectedFlowId).toBe(checkout);
    expect(rowFor('Checkout').dataset.selected).toBe('true');

    fireEvent.click(screen.getByText('Diagram'));
    expect(useEditorStore.getState().selectedFlowId).toBeNull();
  });

  it('is fully keyboard-driven: Enter selects, F2 renames, Delete deletes, Escape closes', () => {
    const checkout = useEditorStore.getState().createFlow('Checkout')!;
    mount();
    const row = rowFor('Checkout');

    act(() => row.focus());
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(useEditorStore.getState().selectedFlowId).toBe(checkout);

    fireEvent.keyDown(row, { key: 'F2' });
    expect(screen.getByLabelText('Flow name')).toBeTruthy();
    fireEvent.keyDown(screen.getByLabelText('Flow name'), { key: 'Escape' }); // blur() fires synchronously
    expect(screen.queryByLabelText('Flow name')).toBeNull();

    fireEvent.keyDown(rowFor('Checkout'), { key: 'Delete' });
    expect(useEditorStore.getState().document.flows).toHaveLength(0);
    expect(useEditorStore.getState().selectedFlowId).toBeNull();

    // Back in the empty state — Escape anywhere in the panel closes it.
    fireEvent.keyDown(screen.getByRole('button', { name: 'New flow' }), { key: 'Escape' });
    expect(useUiStore.getState().flowPanelOpen).toBe(false);
  });

  it('keys it consumes never reach the window, keys it does not still do', () => {
    useEditorStore.getState().createFlow('Checkout');
    mount();
    const seen: string[] = [];
    const listener = (event: KeyboardEvent) => seen.push(event.key);
    window.addEventListener('keydown', listener);
    const row = rowFor('Checkout');
    fireEvent.keyDown(row, { key: 'F2' });
    fireEvent.keyDown(row, { key: 's' });
    window.removeEventListener('keydown', listener);
    expect(seen).toEqual(['s']);
  });

  it('pluralizes step counts and only offers Present once a flow has a step', () => {
    const edge = addConnectedPair();
    const checkout = useEditorStore.getState().createFlow('Checkout')!;
    mount();

    expect(screen.getByText('no steps')).toBeTruthy();
    const present = screen.getByRole('button', { name: 'Present Checkout' }) as HTMLButtonElement;
    expect(present.disabled).toBe(true);
    expect(present.title).toBe('Add a step first');

    act(() => useEditorStore.getState().addEdgeToFlow(checkout, edge.id));
    expect(screen.getByText('1 step')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Present Checkout' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('lists steps as Source → Target with the connector label as a quiet detail', () => {
    const edge = addConnectedPair();
    useEditorStore.getState().updateEdgeLabel(edge.id, 'calls');
    const checkout = useEditorStore.getState().createFlow('Checkout')!;
    useEditorStore.getState().addEdgeToFlow(checkout, edge.id);
    mount();

    fireEvent.click(screen.getByLabelText('Expand'));
    const step = screen.getByRole('button', { name: /^A.*B.*calls$/ });
    expect(step.textContent).toBe('A→Bcalls');
    fireEvent.click(step);
    expect(useEditorStore.getState().selection.edges).toEqual([edge.id]);
  });
});
