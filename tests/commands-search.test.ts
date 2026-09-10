import { beforeEach, describe, expect, it, vi } from 'vitest';
import { rank } from '../src/commands/fuzzy';
import { JUMP_FLASH_MS, JUMP_LIMIT, jumpCommands } from '../src/commands/search';
import { createDocument } from '../src/document/factory';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';
import { stubContext } from './commandStubs';

function reset() {
  __resetInteraction();
  useEditorStore.setState({
    document: createDocument('Search'),
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    clipboard: null,
    revision: 0,
    mode: 'edit',
    selectedFlowId: null,
  });
  useUiStore.setState({ jumpFlashId: null });
}

describe('jumpCommands', () => {
  beforeEach(reset);

  it('indexes nodes by display name, flows by title, and connectors by label', () => {
    const state = useEditorStore.getState();
    const api = state.addNode({ type: 'service', x: 0, y: 0, text: 'Payment API' });
    const ledger = state.addNode({ type: 'database', x: 300, y: 0, text: 'Ledger' });
    state.addNode({ type: 'queue', x: 600, y: 0 }); // no text — falls back to the kind name
    const edge = state.connect(api.id, ledger.id)!;
    state.updateEdgeLabel(edge.id, 'writes ledger entry');
    state.createFlow('Checkout');

    const rows = jumpCommands(useEditorStore.getState().document);
    expect(rows.map((row) => row.title)).toEqual(['Payment API', 'Ledger', 'Queue', 'Checkout', 'writes ledger entry']);
    expect(rows.every((row) => row.group === 'jump')).toBe(true);
    expect(rows.find((row) => row.title === 'Checkout')!.hint).toBe('Flow · 0 steps');
    expect(rows.find((row) => row.title === 'writes ledger entry')!.hint).toBe('Payment API → Ledger');
  });

  it('a connector with a semantic but no label is findable by the semantic default', () => {
    const state = useEditorStore.getState();
    const a = state.addNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = state.addNode({ type: 'queue', x: 300, y: 0, text: 'B' });
    const edge = state.connect(a.id, b.id)!;
    state.setEdgeSemantic(edge.id, 'publishes');
    const rows = jumpCommands(useEditorStore.getState().document);
    expect(rows.some((row) => row.title === 'publishes')).toBe(true);
  });

  it('jumping to a node selects it, pans to it, and flashes it once', () => {
    vi.useFakeTimers();
    try {
      const state = useEditorStore.getState();
      const api = state.addNode({ type: 'service', x: 0, y: 0, text: 'Payment API' });
      const ctx = stubContext();
      const row = rank('pay', jumpCommands(useEditorStore.getState().document))[0]!.entry;
      row.run(ctx);

      expect(useEditorStore.getState().selection.nodes).toEqual([api.id]);
      // Pans to the node, never zooming in past the cap — a single node must not fill the screen.
      const [viewport] = (ctx.camera.setViewport as ReturnType<typeof vi.fn>).mock.calls[0]!;
      expect(viewport.zoom).toBeLessThanOrEqual(1.2);
      const centerX = (-viewport.x + 1200 / 2) / viewport.zoom;
      expect(Math.abs(centerX - (api.x + api.width / 2))).toBeLessThan(1);
      expect(useUiStore.getState().jumpFlashId).toBe(api.id);
      vi.advanceTimersByTime(JUMP_FLASH_MS + 1);
      expect(useUiStore.getState().jumpFlashId).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('jumping to a flow selects its lens and frames its members', () => {
    const state = useEditorStore.getState();
    const a = state.addNode({ type: 'service', x: 0, y: 0, text: 'A' });
    const b = state.addNode({ type: 'service', x: 300, y: 0, text: 'B' });
    state.addNode({ type: 'service', x: 900, y: 0, text: 'Far away' });
    const edge = state.connect(a.id, b.id)!;
    const flowId = state.createFlow('Checkout')!;
    state.addEdgeToFlow(flowId, edge.id);
    const ctx = stubContext();
    jumpCommands(useEditorStore.getState().document).find((row) => row.title === 'Checkout')!.run(ctx);
    expect(useEditorStore.getState().selectedFlowId).toBe(flowId);
    // Frames A and B only — the far-away node is not part of the flow.
    const [viewport] = (ctx.camera.setViewport as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const centerX = (-viewport.x + 1200 / 2) / viewport.zoom;
    expect(Math.abs(centerX - (a.x + b.x + b.width) / 2)).toBeLessThan(1);
  });

  it('never grows past the cap once ranked', () => {
    const state = useEditorStore.getState();
    for (let i = 0; i < 20; i += 1) state.addNode({ type: 'service', x: i * 10, y: 0, text: `Service ${i}` });
    const rows = rank('service', jumpCommands(useEditorStore.getState().document)).slice(0, JUMP_LIMIT);
    expect(rows).toHaveLength(JUMP_LIMIT);
  });
});
