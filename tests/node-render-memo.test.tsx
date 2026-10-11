import { act, render } from '@testing-library/react';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { describe, expect, it, vi } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import { addNodes } from '../src/document/operations';
import { DraftNodeView } from '../src/canvas/DraftNodeView';
import { useEditorStore } from '../src/store/editorStore';
import * as describeModule from '../src/nodes/describe';
import * as readingsModule from '../src/nodes/readings';

/** Placement belongs to React Flow's wrapper, while selection, live size and store content must
 *  still reach the shape even when its position-only prop updates are skipped. */
describe('DraftNodeView memo boundary', () => {
  it('skips position-only frames and still renders selection, resize and content changes', () => {
    const node = createNode({ type: 'note', x: 0, y: 0, text: 'Order Service' });
    useEditorStore.getState().setDocument(addNodes(createDocument('Perf'), [node]), { resetHistory: true });
    const describeSpy = vi.spyOn(describeModule, 'describeNode');
    const readingSpy = vi.spyOn(readingsModule, 'nodeReading');
    const props: NodeProps = {
      id: node.id, selected: false, width: node.width, height: node.height,
      positionAbsoluteX: 0, positionAbsoluteY: 0, dragging: true, type: 'draft',
      data: { id: node.id }, zIndex: 0, isConnectable: true, selectable: true,
      draggable: true, deletable: true,
    };
    const view = (patch: Partial<NodeProps> = {}) => (
      <ReactFlowProvider><DraftNodeView {...props} {...patch} /></ReactFlowProvider>
    );
    const { rerender, container } = render(view());
    try {
      for (let frame = 1; frame <= 10; frame += 1) {
        rerender(view({ positionAbsoluteX: frame * 4, positionAbsoluteY: frame * 2 }));
      }
      expect(describeSpy).toHaveBeenCalledTimes(1);
      expect(readingSpy).toHaveBeenCalledTimes(1);

      rerender(view({ selected: true }));
      expect(container.querySelector('.dc-node')).toHaveAttribute('data-selected', 'true');
      expect(describeSpy).toHaveBeenCalledTimes(1);
      expect(readingSpy).toHaveBeenCalledTimes(2);

      rerender(view({ selected: true, width: node.width + 100 }));
      expect(container.querySelector<HTMLElement>('.dc-node')!.style.width).toBe(`${node.width + 100}px`);
      expect(describeSpy).toHaveBeenCalledTimes(2);

      act(() => useEditorStore.getState().updateNodeText(node.id, 'New content'));
      expect(container.querySelector('.dc-node')).toHaveTextContent('New content');
      expect(describeSpy).toHaveBeenCalledTimes(3);
    } finally {
      readingSpy.mockRestore();
      describeSpy.mockRestore();
    }
  });
});
