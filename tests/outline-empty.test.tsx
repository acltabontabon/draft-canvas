import { ReactFlowProvider } from '@xyflow/react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const preferences = vi.hoisted(() => new Map<string, string>());
vi.mock('../src/lib/preferences', () => ({
  readPreference: (key: string) => preferences.get(key) ?? null,
  writePreference: (key: string, value: string) => void preferences.set(key, value),
}));

import { createDocument } from '../src/document/factory';
import { ALL_PRESETS } from '../src/lib/presets';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';
import { OutlinePanel } from '../src/ui/Editor/OutlinePanel';
import { stubContext } from './commandStubs';

/**
 * An empty Outline used to be a bare panel (and an empty `role="tree"`, which owns nothing). It says
 * how to put the first shape in instead, with the keys that exist.
 */
describe('OutlinePanel, empty', () => {
  Element.prototype.scrollIntoView = vi.fn();
  beforeEach(() => {
    preferences.clear();
    __resetInteraction();
    useEditorStore.setState({
      document: createDocument('Outline'),
      history: { past: [], future: [] },
      selection: { nodes: [], edges: [] },
      mode: 'edit',
      path: [],
    });
    useUiStore.setState({ outlinePanelOpen: true });
  });

  it('says how to add a shape instead of drawing an empty tree', () => {
    render(<ReactFlowProvider><OutlinePanel buildCommandContext={() => stubContext()} /></ReactFlowProvider>);
    expect(screen.queryByRole('tree')).toBeNull();
    const hint = screen.getByText(/Nothing in this view yet/);
    expect(hint).toHaveTextContent(/Press S to add a Service/);
    expect(ALL_PRESETS.find((preset) => preset.shortcut === 'S')?.label).toBe('Service');
    expect(hint).toHaveTextContent(/double-click the canvas/);
  });

  it('is the tree again once there is something to list', () => {
    useEditorStore.getState().addNode({ type: 'service', x: 0, y: 0, text: 'Orders API' });
    render(<ReactFlowProvider><OutlinePanel buildCommandContext={() => stubContext()} /></ReactFlowProvider>);
    expect(screen.getByRole('tree', { name: /Shapes and connectors/ })).toBeInTheDocument();
    expect(screen.queryByText(/Nothing in this view yet/)).toBeNull();
  });
});
