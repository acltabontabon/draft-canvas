import { render } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { describe, expect, it, vi } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import { addNodes } from '../src/document/operations';
import { DraftNodeView } from '../src/canvas/DraftNodeView';
import { useEditorStore } from '../src/store/editorStore';
import * as describeModule from '../src/nodes/describe';

/**
 * React Flow passes a fresh `positionAbsoluteX`/`positionAbsoluteY` prop into
 * every node component on every frame of a drag — this component never reads
 * them, since position is applied by React Flow's own transform on the
 * wrapper div. Without a memo boundary keyed on content (not position), the
 * display list — layout, text measurement, code tokenization lookups — would
 * rebuild on every dragged frame for content that never changed.
 */
describe('DraftNodeView does not rebuild its display list on position-only re-renders', () => {
  it('skips describeNode when only positionAbsoluteX/Y change', () => {
    const node = createNode({ type: 'note', x: 0, y: 0, text: 'Order Service' });
    const doc = addNodes(createDocument('Perf'), [node]);
    useEditorStore.getState().setDocument(doc, { resetHistory: true });

    const describeSpy = vi.spyOn(describeModule, 'describeNode');

    const { rerender } = render(
      <ReactFlowProvider>
        <DraftNodeView
          id={node.id}
          selected={false}
          width={node.width}
          height={node.height}
          positionAbsoluteX={0}
          positionAbsoluteY={0}
          dragging={true}
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

    expect(describeSpy).toHaveBeenCalledTimes(1);

    // Simulate 10 drag frames: only the position prop moves, nothing about
    // the node's own content or size changes.
    for (let frame = 1; frame <= 10; frame += 1) {
      rerender(
        <ReactFlowProvider>
          <DraftNodeView
            id={node.id}
            selected={false}
            width={node.width}
            height={node.height}
            positionAbsoluteX={frame * 4}
            positionAbsoluteY={frame * 2}
            dragging={true}
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
    }

    expect(describeSpy).toHaveBeenCalledTimes(1);

    describeSpy.mockRestore();
  });
});
