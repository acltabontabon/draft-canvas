import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument } from '../src/document/factory';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';

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
    selectedFlowId: null,
  });
}

/**
 * Regression coverage: opening a different diagram right after presenting one used to carry
 * `mode: 'present'` forward, so the newly opened diagram appeared with all editing chrome hidden
 * instead of landing in edit mode. `setDocument` resets every other per-session mode (selection,
 * focus, playback) but was missing `mode` itself.
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

describe('per-canvas UI state does not leak', () => {
  beforeEach(reset);

  it('an armed tool is disarmed when another document opens', () => {
    useUiStore.getState().arm({ id: 'service', label: 'Service', type: 'service' } as never);
    store.getState().setDocument(createDocument('B'));
    expect(useUiStore.getState().armed).toBeNull();
  });

  it('presenting closes an attachment card left open from editing', () => {
    useUiStore.getState().setOpenAttachmentDetail({ hostKind: 'node', hostId: 'n1', attachmentId: null });
    store.getState().setMode('present');
    expect(useUiStore.getState().openAttachmentDetail).toBeNull();
  });
});
