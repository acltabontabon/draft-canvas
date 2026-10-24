import { render } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { ProposalPreviewLayer } from '../src/canvas/AgentPreviewLayer';
import { createDocument, createNode } from '../src/document/factory';
import { useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';

/**
 * A proposal that moves shapes is shown as tracing paper over the diagram: the whole proposed
 * diagram on one sheet, moved shapes trailing back to where they stand, never each shape twice.
 * One that only adds keeps the light overlay.
 */

const api = createNode({ id: 'api', type: 'service', x: 0, y: 0, text: 'Orders API' });
const db = createNode({ id: 'db', type: 'service', x: 300, y: 0, text: 'Orders database' });

function show(nodes: ReturnType<typeof createNode>[]) {
  useUiStore.setState({ proposalPreview: { proposalId: 'p1', path: [], nodes, edges: [], visible: true, owner: 'companion' } });
  return render(
    <ReactFlowProvider>
      <ProposalPreviewLayer />
    </ReactFlowProvider>,
  );
}

beforeEach(() => {
  useEditorStore.setState({ document: { ...createDocument('Orders'), nodes: [api, db] }, path: [], outer: null });
});

describe('the proposal preview', () => {
  it('lays a rearranging change on a tracing sheet, with trails from where shapes stand', () => {
    const { container } = show([{ ...api, x: 0, y: 200, text: 'Orders gateway' }, db]);
    const layer = container.querySelector('.dc-agent-preview');
    expect(layer?.getAttribute('data-mode')).toBe('sheet');
    expect(container.querySelector('.dc-preview-sheet')).not.toBeNull();
    expect(container.querySelectorAll('.dc-preview-was')).toHaveLength(1);
    expect(container.querySelectorAll('.dc-preview-trails line')).toHaveLength(1);
    // The whole proposed diagram is on the sheet: the renamed shape in ink, the one that stays plain.
    const inks = [...container.querySelectorAll('.dc-preview-ink')].map((el) => el.getAttribute('data-ink'));
    expect(inks.sort()).toEqual(['changed', 'plain']);
  });

  it('draws a shape that only moves plain: its trail says it moved', () => {
    const { container } = show([{ ...api, x: 0, y: 200 }, db]);
    const inks = [...container.querySelectorAll('.dc-preview-ink')].map((el) => el.getAttribute('data-ink'));
    expect(inks).toEqual(['plain', 'plain']);
    expect(container.querySelectorAll('.dc-preview-trails line')).toHaveLength(1);
  });

  it('keeps the light overlay for a change that only adds', () => {
    const cache = createNode({ id: 'cache', type: 'service', x: 300, y: 200, text: 'Orders cache' });
    const { container } = show([api, db, cache]);
    expect(container.querySelector('.dc-agent-preview')?.getAttribute('data-mode')).toBeNull();
    expect(container.querySelector('.dc-preview-sheet')).toBeNull();
  });

  it('lifts the sheet when the person looks at the diagram as it is now', () => {
    useUiStore.setState({ proposalPreview: { proposalId: 'p1', path: [], nodes: [{ ...api, x: 0, y: 200 }, db], edges: [], visible: false } });
    const { container } = render(
      <ReactFlowProvider>
        <ProposalPreviewLayer />
      </ReactFlowProvider>,
    );
    expect(container.querySelector('.dc-preview-sheet')).toBeNull();
  });
});
