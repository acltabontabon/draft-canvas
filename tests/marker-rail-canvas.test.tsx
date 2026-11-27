import { render } from '@testing-library/react';
import { ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { describe, expect, it } from 'vitest';
import { DraftNodeView } from '../src/canvas/DraftNodeView';
import { createAttachment, createDocument, createNode } from '../src/document/factory';
import { markerRail } from '../src/document/markerRail';
import { addNodes } from '../src/document/operations';
import type { DraftNode } from '../src/document/types';
import { describeAttachmentBadge } from '../src/edges/attachmentChips';
import { getMeasurer } from '../src/render/text/measure';
import { LIGHT } from '../src/render/theme/tokens';
import { useEditorStore } from '../src/store/editorStore';

/** The canvas reads the marker rail with the shape's kind, so its tabs land where the export puts them. */
describe('the marker rail on the canvas', () => {
  const show = (node: DraftNode) => {
    useEditorStore.getState().setDocument(addNodes(createDocument('Rail'), [node]));
    const props: NodeProps = {
      id: node.id, selected: false, width: node.width, height: node.height,
      positionAbsoluteX: 0, positionAbsoluteY: 0, dragging: false, type: 'draft',
      data: { id: node.id }, zIndex: 0, isConnectable: true, selectable: true,
      draggable: true, deletable: true,
    };
    return render(<ReactFlowProvider><DraftNodeView {...props} /></ReactFlowProvider>).container;
  };
  const attachments = [createAttachment({ type: 'note', text: 'a' }), createAttachment({ type: 'note', text: 'b' })];

  it('puts a glyph Service\'s attachment tab at the corner, as the export does', () => {
    const node = { ...createNode({ type: 'service', serviceKind: 'worker', x: 0, y: 0, text: 'Fulfilment', technology: 'Kafka' }), attachments };
    const badge = show(node).querySelector<HTMLElement>('.dc-attachment-badge')!;
    const [tab] = describeAttachmentBadge(node, { theme: LIGHT, measurer: getMeasurer() }, true);
    const rail = markerRail(node, { technology: true, attachments: 2 }).attachments!;
    expect(rail.x + rail.width).toBe(node.width);
    expect(tab).toMatchObject({ translate: { x: rail.x, y: rail.y } });
    expect(badge.style.left).toBe(`${rail.x}px`);
    expect(badge.style.top).toBe(`${rail.y}px`);
  });

  it('keeps a card Service\'s tab one slot in from its technology mark', () => {
    const node = { ...createNode({ type: 'service', x: 0, y: 0, text: 'Orders', technology: 'Redis' }), attachments };
    const badge = show(node).querySelector<HTMLElement>('.dc-attachment-badge')!;
    const rail = markerRail(node, { technology: true, attachments: 2 });
    expect(rail.technology).toBeDefined();
    expect(badge.style.left).toBe(`${rail.attachments!.x}px`);
  });
});
