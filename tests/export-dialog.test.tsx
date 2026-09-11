import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftDocument } from '../src/document/types';

// Node's own experimental `globalThis.localStorage` shadows jsdom's in this environment — the
// same in-memory fake `tests/personality-preference.test.tsx` uses stands in for
// `lib/preferences.ts`, so a format choice made in one test can't leak into the next via the
// real global.
const prefs = new Map<string, string>();
vi.mock('../src/lib/preferences', () => ({
  readPreference: (key: string) => prefs.get(key) ?? null,
  writePreference: (key: string, value: string) => void prefs.set(key, value),
  removePreference: (key: string) => void prefs.delete(key),
}));

const { createDocument, createEdge, createNode } = await import('../src/document/factory');
const { createFlow } = await import('../src/document/flow');
const { useEditorStore } = await import('../src/store/editorStore');
const { useUiStore } = await import('../src/store/uiStore');
const { ExportDialog } = await import('../src/ui/Editor/ExportDialog');
const { PersonalityProvider } = await import('../src/ui/personality/PersonalityProvider');
const { ThemeProvider } = await import('../src/ui/theme/ThemeProvider');

function withFlow(): DraftDocument {
  const a = createNode({ type: 'service', x: 0, y: 0, text: 'A' });
  const b = createNode({ type: 'service', x: 200, y: 0, text: 'B' });
  const edge = createEdge({ source: a.id, target: b.id, label: 'Go' });
  const flow = createFlow({ title: 'Checkout' });
  flow.steps = [{ id: 'fs1', edgeId: edge.id }];
  return { ...createDocument('My Diagram'), nodes: [a, b], edges: [edge], flows: [flow] };
}

function withoutFlows(): DraftDocument {
  return createDocument('My Diagram');
}

function renderDialog() {
  return render(
    <ThemeProvider>
      <PersonalityProvider>
        <ExportDialog />
      </PersonalityProvider>
    </ThemeProvider>,
  );
}

beforeEach(() => {
  prefs.clear();
  useUiStore.setState({ exportOpen: true, exportSelectionRequested: false });
});

describe('ExportDialog — sectioned layout', () => {
  it('renders nothing when closed', () => {
    useUiStore.setState({ exportOpen: false });
    useEditorStore.setState({ document: withFlow(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    const { container } = renderDialog();
    expect(container).toBeEmptyDOMElement();
  });

  it('groups exports under Document, Image, and Diagram Source headings', () => {
    useEditorStore.setState({ document: withFlow(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    renderDialog();

    expect(screen.getByRole('heading', { name: 'Document' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Image' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Diagram Source' })).toBeInTheDocument();
    expect(screen.getByText('Editable document')).toBeInTheDocument();
    expect(screen.getByText('Vector image')).toBeInTheDocument();
    expect(screen.getByText('Sequence Diagram')).toBeInTheDocument();
  });
});

describe('ExportDialog — Sequence Diagram card', () => {
  it('is disabled with teaching copy when the diagram has no playable flows', () => {
    useEditorStore.setState({ document: withoutFlows(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    renderDialog();

    expect(screen.getByText('Add a Flow to export sequence diagram source.')).toBeInTheDocument();
    const exportButton = screen.getByRole('button', { name: /Export (Mermaid|PlantUML)/ });
    expect(exportButton).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Copy source' })).not.toBeInTheDocument();
  });

  it('is enabled, with Copy actions, when the diagram has a playable flow', () => {
    useEditorStore.setState({ document: withFlow(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    renderDialog();

    expect(
      screen.getByText('Mermaid or PlantUML source, built from your Flows — paste it into any diagram tool.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export Mermaid' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Copy source' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Copy as Markdown' })).toBeEnabled();
  });

  it('switches the export button label and hides "Copy as Markdown" for PlantUML', () => {
    useEditorStore.setState({ document: withFlow(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    renderDialog();

    const format = screen.getByLabelText('Format') as HTMLSelectElement;
    fireEvent.change(format, { target: { value: 'plantuml' } });

    expect(screen.getByRole('button', { name: 'Export PlantUML' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy as Markdown' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy source' })).toBeInTheDocument();
  });

  it('does not show a Flow picker, preview, or renderer for Sequence Diagram — Format is the only control', () => {
    useEditorStore.setState({ document: withFlow(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    renderDialog();

    const heading = screen.getByText('Sequence Diagram').closest('.dc-export-choice')!;
    const controls = within(heading as HTMLElement).getAllByRole('combobox');
    expect(controls).toHaveLength(1); // Format only
    expect(within(heading as HTMLElement).queryByRole('textbox')).not.toBeInTheDocument();
  });
});

describe('ExportDialog — keyboard navigation', () => {
  it('opens with focus on the dialog panel itself', () => {
    useEditorStore.setState({ document: withFlow(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    renderDialog();
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('closes on Escape without mutating the document', () => {
    useEditorStore.setState({ document: withFlow(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    renderDialog();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUiStore.getState().exportOpen).toBe(false);
  });

  it('reaches the Sequence Diagram Format select and its Export button via Tab, all keyboard-focusable', async () => {
    const user = userEvent.setup();
    useEditorStore.setState({ document: withFlow(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    renderDialog();

    const format = screen.getByLabelText('Format');
    format.focus();
    expect(document.activeElement).toBe(format);

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Copy source' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Copy as Markdown' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Export Mermaid' }));
  });
});
