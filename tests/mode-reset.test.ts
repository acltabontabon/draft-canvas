import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument } from '../src/document/factory';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';

const store = useEditorStore;

function reset() {
  __resetInteraction();
  store.setState({
    document: createDocument('A'),
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
 * Regression coverage: opening a different diagram right after presenting one used to carry
 * `mode: 'present'` forward, so the newly opened diagram appeared with all editing chrome hidden
 * instead of landing in edit mode. `setDocument` resets every other per-session mode (selection,
 * focus, flow-edit, playback) but was missing `mode` itself.
 */
describe('setDocument resets mode', () => {
  beforeEach(reset);

  it('returns to edit mode when a different document is opened while presenting', () => {
    store.getState().setMode('present');
    expect(store.getState().mode).toBe('present');

    store.getState().setDocument(createDocument('B'));
    expect(store.getState().mode).toBe('edit');
  });

  it('leaves edit mode untouched when already editing', () => {
    expect(store.getState().mode).toBe('edit');

    store.getState().setDocument(createDocument('C'));
    expect(store.getState().mode).toBe('edit');
  });
});
