import { fireEvent, render } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { useUiStore, type ArrangePreview, type TidyPreview } from '../src/store/uiStore';
import { ArrangeBar } from '../src/ui/Editor/ArrangeBar';
import { TidyBar } from '../src/ui/Editor/TidyBar';

/**
 * A Tidy up or Arrange preview answers Enter (apply) and Escape (cancel) from anywhere on the canvas,
 * so it listens on `window` before anything else hears the key. A dialog, the palette or a menu
 * opened over the preview owns those keys while it is up.
 */
function setUp() {
  __resetInteraction();
  useUiStore.setState(useUiStore.getInitialState(), true);
  useEditorStore.setState(useEditorStore.getInitialState(), true);
  const base = { ...createDocument('Shop'), nodes: [createNode({ id: 'a', type: 'service', x: 0, y: 0, text: 'API' })] };
  useEditorStore.getState().setDocument(base);
  const room = useEditorStore.getState().document;
  const moved = { ...room, nodes: room.nodes.map((node) => ({ ...node, x: node.x + 40 })) };
  return { room, moved, path: useEditorStore.getState().path };
}

/** Something modal over the canvas, as `Modal` and the command palette mark themselves. */
function openDialog(): HTMLElement {
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.tabIndex = -1;
  document.body.append(dialog);
  dialog.focus();
  return dialog;
}

afterEach(() => {
  document.querySelectorAll('[aria-modal="true"]').forEach((dialog) => dialog.remove());
});

describe('Tidy up preview keys', () => {
  let preview: TidyPreview;
  let before: number;
  beforeEach(() => {
    const { room, moved, path } = setUp();
    preview = { path, base: room, view: moved, moved: 1, reattached: 0, scoped: false };
    useUiStore.getState().setTidyPreview(preview);
    before = useEditorStore.getState().document.nodes[0]!.x;
    render(<TidyBar />);
  });

  it('Escape cancels with nothing over the canvas, and changes nothing', () => {
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(useUiStore.getState().tidyPreview).toBeNull();
    expect(useEditorStore.getState().document.nodes[0]!.x).toBe(before);
  });

  it('Enter applies the cleanup as one step', () => {
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(useUiStore.getState().tidyPreview).toBeNull();
    expect(useEditorStore.getState().document.nodes[0]!.x).toBe(before + 40);
  });

  it('Enter in a dialog over the preview applies nothing', () => {
    const dialog = openDialog();
    fireEvent.keyDown(dialog, { key: 'Enter' });
    expect(useUiStore.getState().tidyPreview).toBe(preview);
    expect(useEditorStore.getState().document.nodes[0]!.x).toBe(before);
  });

  it('Escape in a dialog over the preview leaves the preview for when the dialog has closed', () => {
    const dialog = openDialog();
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(useUiStore.getState().tidyPreview).toBe(preview);
    dialog.remove();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(useUiStore.getState().tidyPreview).toBeNull();
  });

  it('an Enter that confirms an IME conversion applies nothing', () => {
    fireEvent.keyDown(document.body, { key: 'Enter', keyCode: 229 });
    expect(useUiStore.getState().tidyPreview).toBe(preview);
  });
});

describe('Arrange preview keys', () => {
  let preview: ArrangePreview;
  let before: number;
  beforeEach(() => {
    const { room, moved, path } = setUp();
    preview = { path, base: room, options: { right: moved }, direction: 'right', suggested: 'right', current: 'right', scoped: false, show: 'result' } as ArrangePreview;
    useUiStore.getState().setArrangePreview(preview);
    before = useEditorStore.getState().document.nodes[0]!.x;
    render(
      <ReactFlowProvider>
        <ArrangeBar />
      </ReactFlowProvider>,
    );
  });

  it('Escape cancels with nothing over the canvas', () => {
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(useUiStore.getState().arrangePreview).toBeNull();
  });

  it('Enter and Escape in a dialog over the preview leave it, and the diagram, alone', () => {
    const dialog = openDialog();
    fireEvent.keyDown(dialog, { key: 'Enter' });
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(useUiStore.getState().arrangePreview).toBe(preview);
    expect(useEditorStore.getState().document.nodes[0]!.x).toBe(before);
  });
});
