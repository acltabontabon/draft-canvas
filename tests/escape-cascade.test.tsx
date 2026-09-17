import { ReactFlowProvider } from '@xyflow/react';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDocument } from '../src/document/factory';
import { useKeyboard } from '../src/ui/Editor/EditorScreen';
import { useFlowPlayback } from '../src/presentation/useFlowPlayback';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { useUiStore, type ContinuationOffer } from '../src/store/uiStore';

/**
 * Escape is Draft Canvas's one "back out of what I'm doing" key, and it means something different
 * depending on what's currently showing — a layered, ~20-listener design (see `EditorScreen.tsx`'s
 * own comments at its ghost-capture effect and its bubble-phase `Escape` case) that is easy to
 * regress silently, one branch at a time, without a test ever noticing. This file pins down the
 * priority order for the highest-value cases end to end: a continuation suggestion beats clearing
 * the selection, a presentation reveal beats leaving Presentation Mode, and an open dialog stands
 * the rest of the editor's shortcuts down entirely rather than reaching past it.
 */

const FAKE_OFFER = {
  id: 'fixture-candidate',
  anchorId: 'fixture-anchor',
  neighborhoodKey: 'fixture-neighborhood',
  trigger: 'select',
  nodes: [],
  edges: [],
  continueFromId: 'fixture-anchor',
} as unknown as ContinuationOffer;

function reset() {
  __resetInteraction();
  useEditorStore.setState({
    document: createDocument('Escape cascade'),
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    clipboard: null,
    revision: 0,
    mode: 'edit',
    flowPlayback: { active: false, flowId: null, step: 0 },
    focus: { active: false, nodeIds: [], edgeIds: [] },
    selectedFlowId: null,
    path: [],
  });
  useUiStore.setState({
    armed: null,
    exportOpen: false,
    quickConnect: null,
    contextMenu: null,
    interactionActive: false,
    commandPaletteOpen: false,
    continuation: null,
    continuationDismissals: new Set(),
    continuationCycle: null,
    presentationReveal: null,
    reconnectDragActive: false,
    openAttachmentDetail: null,
  });
}

function mount() {
  return renderHook(
    () => {
      const playback = useFlowPlayback();
      useKeyboard({ createAtPointer: () => null, playback });
      return playback;
    },
    { wrapper: ({ children }) => <ReactFlowProvider>{children}</ReactFlowProvider> },
  );
}

const escape = () => {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true }));
  });
};

describe('Escape cascade', () => {
  beforeEach(reset);
  afterEach(() => {
    document.querySelectorAll('[data-escape-fixture]').forEach((el) => el.remove());
  });

  it('dismisses a showing continuation suggestion first, leaving the selection untouched', () => {
    mount();
    const node = useEditorStore.getState().addNode({ type: 'service', x: 0, y: 0, text: 'A' });
    useEditorStore.getState().setSelection({ nodes: [node.id], edges: [] });
    useUiStore.setState({ continuation: FAKE_OFFER });

    escape();

    expect(useUiStore.getState().continuation).toBeNull();
    // The bubble-phase Escape case never ran — its "clear selection" branch would otherwise have
    // fired on this same press, since a node was selected.
    expect(useEditorStore.getState().selection.nodes).toEqual([node.id]);
  });

  it('with nothing else active, clears the selection', () => {
    mount();
    const node = useEditorStore.getState().addNode({ type: 'service', x: 0, y: 0, text: 'A' });
    useEditorStore.getState().setSelection({ nodes: [node.id], edges: [] });

    escape();

    expect(useEditorStore.getState().selection).toEqual({ nodes: [], edges: [] });
  });

  it('while presenting with a reveal open for this step, closes only the reveal', () => {
    mount();
    useEditorStore.setState({ mode: 'present', flowPlayback: { active: false, flowId: null, step: 0 } });
    useUiStore.setState({ presentationReveal: { hostKind: 'node', hostId: 'n1', scope: 'present' } });

    escape();

    expect(useUiStore.getState().presentationReveal).toBeNull();
    expect(useEditorStore.getState().mode).toBe('present');
  });

  it('while presenting with no reveal open, exits back to edit mode', () => {
    mount();
    useEditorStore.setState({ mode: 'present', flowPlayback: { active: false, flowId: null, step: 0 } });

    escape();

    expect(useEditorStore.getState().mode).toBe('edit');
  });

  it('stands the rest of the editor down while a dialog is open, rather than reaching past it', () => {
    mount();
    const dialog = document.createElement('div');
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('data-escape-fixture', 'true');
    document.body.appendChild(dialog);

    useEditorStore.setState({ mode: 'present', flowPlayback: { active: false, flowId: null, step: 0 } });
    const node = useEditorStore.getState().addNode({ type: 'service', x: 0, y: 0, text: 'A' });
    useEditorStore.getState().setSelection({ nodes: [node.id], edges: [] });

    escape();

    // Neither branch Escape would otherwise take (closing present mode, clearing the selection)
    // fires — the dialog's own Escape handler (untested here; see `tests/modal.test.tsx`) is the
    // only thing that should react to this press.
    expect(useEditorStore.getState().mode).toBe('present');
    expect(useEditorStore.getState().selection.nodes).toEqual([node.id]);
  });
});
