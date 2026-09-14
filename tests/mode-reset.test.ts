import { beforeEach, describe, expect, it } from 'vitest';
import { createAttachment, createDocument } from '../src/document/factory';
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

  it('popovers, menus and pending requests close when the document is replaced', () => {
    useUiStore.setState({
      openAttachmentDetail: { hostKind: 'node', hostId: 'n1', attachmentId: null },
      quickConnect: { nodeId: 'n1' } as never,
      contextMenu: { kind: 'pane' } as never,
      presentationReveal: { attachmentId: 'a1' } as never,
      flowRenameRequestId: 'f1',
      jumpFlashId: 'n1',
    });
    store.getState().setDocument(createDocument('B'));
    const ui = useUiStore.getState();
    expect(ui.openAttachmentDetail).toBeNull();
    expect(ui.quickConnect).toBeNull();
    expect(ui.contextMenu).toBeNull();
    expect(ui.presentationReveal).toBeNull();
    expect(ui.flowRenameRequestId).toBeNull();
    expect(ui.jumpFlashId).toBeNull();
  });

  it('presenting closes an attachment card left open from editing', () => {
    useUiStore.getState().setOpenAttachmentDetail({ hostKind: 'node', hostId: 'n1', attachmentId: null });
    store.getState().setMode('present');
    expect(useUiStore.getState().openAttachmentDetail).toBeNull();
  });

  it('deleting the host of an open attachment card closes it, and redo does not reopen it', () => {
    const node = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const note = createAttachment({ type: 'note' });
    store.getState().attachToNode(node.id, note);
    useUiStore.getState().setOpenAttachmentDetail({ hostKind: 'node', hostId: node.id, attachmentId: note.id });

    store.getState().setSelection({ nodes: [node.id], edges: [] });
    store.getState().deleteSelection();
    expect(useUiStore.getState().openAttachmentDetail).toBeNull();

    store.getState().undo();
    store.getState().redo();
    expect(useUiStore.getState().openAttachmentDetail).toBeNull();
  });

  it('undoing the add of a connector’s pinned attachment closes its card', () => {
    const a = store.getState().addNode({ type: 'service', x: 0, y: 0 });
    const b = store.getState().addNode({ type: 'database', x: 300, y: 0 });
    const edge = store.getState().connect(a.id, b.id)!;
    const code = createAttachment({ type: 'code' });
    store.getState().attachToEdge(edge.id, code);
    useUiStore.getState().setOpenAttachmentDetail({ hostKind: 'edge', hostId: edge.id, attachmentId: code.id });

    // An unrelated edit leaves it open.
    store.getState().addNode({ type: 'note', x: 0, y: 300 });
    expect(useUiStore.getState().openAttachmentDetail).not.toBeNull();

    store.getState().undo();
    store.getState().undo();
    expect(useUiStore.getState().openAttachmentDetail).toBeNull();
  });
});
