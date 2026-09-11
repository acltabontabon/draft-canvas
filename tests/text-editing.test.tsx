import { fireEvent, render } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import { addNodes } from '../src/document/operations';
import { DraftNodeView } from '../src/canvas/DraftNodeView';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';

/**
 * Multiline is first-class for Text (not a rare Shift+Enter escape hatch): plain Enter inserts a
 * newline and stays in editing, the same Cmd/Ctrl+Enter-commits convention Note already uses.
 * These exercise the real `DraftNodeView` keydown handler, not just the store, since the bug this
 * guards is specifically about which key exits editing.
 */
function mount(node: ReturnType<typeof createNode>) {
  const doc = addNodes(createDocument('Text editing'), [node]);
  useEditorStore.getState().setDocument(doc, { resetHistory: true });
  useUiStore.getState().requestEdit(node.id);
  const utils = render(
    <ReactFlowProvider>
      <DraftNodeView
        id={node.id}
        selected={true}
        width={node.width}
        height={node.height}
        positionAbsoluteX={0}
        positionAbsoluteY={0}
        dragging={false}
        type="draft"
        data={{ id: node.id }}
        zIndex={0}
        isConnectable
        selectable
        draggable
        deletable
      />
    </ReactFlowProvider>,
  );
  const editor = () => utils.container.querySelector('textarea.dc-node-editor');
  return { ...utils, editor };
}

describe('Text editing — Enter is a newline, Cmd/Ctrl+Enter commits', () => {
  beforeEach(() => {
    __resetInteraction();
    useUiStore.setState({ editRequestId: null });
  });

  it('plain Enter stays in editing and does not commit', () => {
    const node = createNode({ type: 'text', x: 0, y: 0, text: '' });
    const { editor } = mount(node);
    expect(editor()).not.toBeNull();

    fireEvent.change(editor()!, { target: { value: 'First line' } });
    fireEvent.keyDown(editor()!, { key: 'Enter' });

    expect(editor()).not.toBeNull(); // still editing
    expect(useEditorStore.getState().document.nodes[0]!.text).toBe('');
  });

  it('Cmd/Ctrl+Enter commits and exits editing', () => {
    const node = createNode({ type: 'text', x: 0, y: 0, text: '' });
    const { editor } = mount(node);

    fireEvent.change(editor()!, { target: { value: 'First line\nSecond line' } });
    fireEvent.keyDown(editor()!, { key: 'Enter', metaKey: true });

    expect(editor()).toBeNull(); // exited editing
    expect(useEditorStore.getState().document.nodes[0]!.text).toBe('First line\nSecond line');
  });

  it('a node/service label is untouched: plain Enter still commits, Shift+Enter still newlines', () => {
    const node = createNode({ type: 'service', x: 0, y: 0, text: 'API' });
    const { editor } = mount(node);

    fireEvent.change(editor()!, { target: { value: 'Renamed' } });
    fireEvent.keyDown(editor()!, { key: 'Enter', shiftKey: true });
    expect(editor()).not.toBeNull(); // Shift+Enter still stays in editing for a label

    fireEvent.keyDown(editor()!, { key: 'Enter' });
    expect(editor()).toBeNull(); // plain Enter still commits for a label
    expect(useEditorStore.getState().document.nodes[0]!.text).toBe('Renamed');
  });
});
