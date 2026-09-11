import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument } from '../src/document/factory';
import { SequenceDiagramDialog } from '../src/ui/Editor/SequenceDiagramDialog';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';

function reset() {
  __resetInteraction();
  useEditorStore.setState({
    document: createDocument('Sequence dialog'),
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    clipboard: null,
    revision: 0,
    mode: 'edit',
    flowPlayback: { active: false, flowId: null, step: 0 },
    selectedFlowId: null,
  });
  useUiStore.setState({ sequenceDiagramOpen: false });
}

/** A real, playable flow with one interaction — A calls B. */
function seedFlow(): string {
  const state = useEditorStore.getState();
  const a = state.addNode({ type: 'service', x: 0, y: 0, text: 'A' });
  const b = state.addNode({ type: 'service', x: 200, y: 0, text: 'B' });
  const edge = state.connect(a.id, b.id)!;
  const flowId = state.createFlow('Checkout')!;
  state.addEdgeToFlow(flowId, edge.id);
  return flowId;
}

describe('SequenceDiagramDialog', () => {
  beforeEach(reset);

  it('renders nothing when closed', () => {
    const { container } = render(<SequenceDiagramDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when open but no flow is selected', () => {
    useUiStore.setState({ sequenceDiagramOpen: true });
    const { container } = render(<SequenceDiagramDialog />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows an empty state for a playable flow with no interactions (a frame-only step)', () => {
    // Playable (a pinned viewport keeps `flowIsPlayable` true) but contributes zero sequence
    // messages — a frame step has no primary connector, matching `flatten.ts`'s own V1 rule.
    const state = useEditorStore.getState();
    const doc = state.document;
    const flow = {
      id: 'f-frame-only',
      title: 'Overview',
      steps: [{ id: 'fs1', viewport: { x: 0, y: 0, zoom: 1 } }],
    };
    useEditorStore.setState({ document: { ...doc, flows: [...doc.flows, flow] }, selectedFlowId: flow.id });
    useUiStore.setState({ sequenceDiagramOpen: true });
    render(<SequenceDiagramDialog />);
    expect(screen.getByText(/doesn't have enough interactions/i)).toBeTruthy();
  });

  it('renders the preview by default, and switches to source on toggle', () => {
    const flowId = seedFlow();
    useEditorStore.setState({ selectedFlowId: flowId });
    useUiStore.setState({ sequenceDiagramOpen: true });
    render(<SequenceDiagramDialog />);

    expect(document.querySelector('.dc-sequence-svg')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();

    fireEvent.change(screen.getByLabelText('View'), { target: { value: 'source' } });
    expect(document.querySelector('.dc-sequence-source')).toBeTruthy();
    expect(document.querySelector('.dc-sequence-svg')).toBeNull();
  });

  it('the format toggle switches between Mermaid and PlantUML source', () => {
    const flowId = seedFlow();
    useEditorStore.setState({ selectedFlowId: flowId });
    useUiStore.setState({ sequenceDiagramOpen: true });
    render(<SequenceDiagramDialog />);
    fireEvent.change(screen.getByLabelText('View'), { target: { value: 'source' } });

    expect(document.querySelector('.dc-sequence-source code')?.textContent).toContain('sequenceDiagram');
    fireEvent.change(screen.getByLabelText('Format'), { target: { value: 'plantuml' } });
    expect(document.querySelector('.dc-sequence-source code')?.textContent).toContain('@startuml');
  });

  describe('copy', () => {
    beforeEach(() => {
      vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn().mockResolvedValue(undefined) } });
    });
    afterEach(() => vi.unstubAllGlobals());

    it('copies the current source format to the clipboard and notifies', async () => {
      const flowId = seedFlow();
      useEditorStore.setState({ selectedFlowId: flowId });
      useUiStore.setState({ sequenceDiagramOpen: true });
      render(<SequenceDiagramDialog />);
      fireEvent.change(screen.getByLabelText('View'), { target: { value: 'source' } });

      fireEvent.click(screen.getByRole('button', { name: /Copy Mermaid/i }));
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('sequenceDiagram'));
      await Promise.resolve();
      expect(useUiStore.getState().toasts.some((t) => /Copied as Mermaid/i.test(t.message))).toBe(true);
    });
  });

  it('closes on Escape without mutating the document', () => {
    const flowId = seedFlow();
    useEditorStore.setState({ selectedFlowId: flowId });
    useUiStore.setState({ sequenceDiagramOpen: true });
    render(<SequenceDiagramDialog />);

    const nodeCountBefore = useEditorStore.getState().document.nodes.length;
    const historyBefore = useEditorStore.getState().history;
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(useUiStore.getState().sequenceDiagramOpen).toBe(false);
    expect(useEditorStore.getState().document.nodes).toHaveLength(nodeCountBefore);
    expect(useEditorStore.getState().history).toBe(historyBefore);
  });

  it('auto-closes if the active flow is deleted while open', () => {
    const flowId = seedFlow();
    useEditorStore.setState({ selectedFlowId: flowId });
    useUiStore.setState({ sequenceDiagramOpen: true });
    render(<SequenceDiagramDialog />);

    act(() => {
      useEditorStore.getState().deleteFlow(flowId);
    });

    expect(useUiStore.getState().sequenceDiagramOpen).toBe(false);
  });
});
