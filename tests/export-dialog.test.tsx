import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DraftDocument } from '../src/document/types';

// Node's own experimental `globalThis.localStorage` shadows jsdom's in this environment — the
// same in-memory fake `tests/personality-preference.test.tsx` uses stands in for
// `lib/preferences.ts`, so a mode/format choice made in one test can't leak into the next via the
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

async function switchMode(user: ReturnType<typeof userEvent.setup>, name: RegExp) {
  await user.click(screen.getByRole('radio', { name }));
}

beforeEach(() => {
  prefs.clear();
  useUiStore.setState({ exportOpen: true, exportSelectionRequested: false });
});

describe('ExportDialog — mode picker', () => {
  it('renders nothing when closed', () => {
    useUiStore.setState({ exportOpen: false });
    useEditorStore.setState({ document: withFlow(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    const { container } = renderDialog();
    expect(container).toBeEmptyDOMElement();
  });

  it('opens on Image/PNG by default, with a single dominant CTA', () => {
    useEditorStore.setState({ document: withFlow(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    renderDialog();

    expect(screen.getByRole('radiogroup', { name: 'Export type' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Image/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'PNG' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Export PNG' })).toBeEnabled();
  });

  it('switches the visible panel and CTA when a different mode is chosen', async () => {
    const user = userEvent.setup();
    useEditorStore.setState({ document: withFlow(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    renderDialog();

    await switchMode(user, /Document/);
    expect(screen.getByRole('button', { name: 'Export document' })).toBeInTheDocument();

    await switchMode(user, /Animated/);
    expect(screen.getByRole('button', { name: 'Export GIF' })).toBeInTheDocument();

    await switchMode(user, /Source/);
    expect(screen.getByRole('button', { name: 'Export Mermaid' })).toBeInTheDocument();
  });
});

describe('ExportDialog — Document panel', () => {
  it('switches the CTA between Editable and Encrypted', async () => {
    const user = userEvent.setup();
    useEditorStore.setState({ document: withFlow(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    renderDialog();
    await switchMode(user, /Document/);

    expect(screen.getByRole('button', { name: 'Export document' })).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Encrypted' }));
    expect(screen.getByRole('button', { name: 'Export securely…' })).toBeInTheDocument();
  });

  it('opens the passphrase prompt from the Encrypted CTA', async () => {
    const user = userEvent.setup();
    useEditorStore.setState({ document: withFlow(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    renderDialog();
    await switchMode(user, /Document/);
    await user.click(screen.getByRole('radio', { name: 'Encrypted' }));
    await user.click(screen.getByRole('button', { name: 'Export securely…' }));

    expect(screen.getByRole('dialog', { name: 'Export securely' })).toBeInTheDocument();
  });
});

describe('ExportDialog — Animated panel', () => {
  it('is disabled with teaching copy when the diagram has no Flows', async () => {
    const user = userEvent.setup();
    useEditorStore.setState({ document: withoutFlows(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    renderDialog();
    await switchMode(user, /Animated/);

    expect(screen.getByText('Add a Flow to enable this export.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export GIF' })).toBeDisabled();
  });

  it('exposes Speed and Loop once a Flow exists', async () => {
    const user = userEvent.setup();
    useEditorStore.setState({ document: withFlow(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    renderDialog();
    await switchMode(user, /Animated/);

    expect(screen.getByLabelText('Speed')).toBeInTheDocument();
    expect(screen.getByText('Loop continuously')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export GIF' })).toBeEnabled();
  });
});

describe('ExportDialog — Source (Sequence) panel', () => {
  it('is disabled with teaching copy when the diagram has no playable Flows', async () => {
    const user = userEvent.setup();
    useEditorStore.setState({ document: withoutFlows(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    renderDialog();
    await switchMode(user, /Source/);

    expect(screen.getByText('Add a Flow to export sequence diagram source.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Export (Mermaid|PlantUML)/ })).toBeDisabled();
  });

  it('is enabled once the diagram has a playable Flow', async () => {
    const user = userEvent.setup();
    useEditorStore.setState({ document: withFlow(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    renderDialog();
    await switchMode(user, /Source/);

    expect(screen.getByText('Sequence diagram source generated from your Flows.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export Mermaid' })).toBeEnabled();
  });

  it('switches the CTA for PlantUML', async () => {
    const user = userEvent.setup();
    useEditorStore.setState({ document: withFlow(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    renderDialog();
    await switchMode(user, /Source/);
    await user.click(screen.getByRole('radio', { name: 'PlantUML' }));

    expect(screen.getByRole('button', { name: 'Export PlantUML' })).toBeInTheDocument();
  });

  it('does not show a rendered preview or clipboard actions — Format is the only control', async () => {
    const user = userEvent.setup();
    useEditorStore.setState({ document: withFlow(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    renderDialog();
    await switchMode(user, /Source/);

    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy source' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy as Markdown' })).not.toBeInTheDocument();
    expect(dialog.querySelector('svg.dc-sequence-svg, .dc-sequence-preview-scroll')).toBeNull();
  });
});

describe('ExportDialog — output artifact', () => {
  it('names the exact file each export will download', async () => {
    const user = userEvent.setup();
    useEditorStore.setState({ document: withFlow(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    renderDialog();

    expect(screen.getByTitle('my-diagram.png')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'SVG' }));
    expect(screen.getByTitle('my-diagram.svg')).toBeInTheDocument();

    await switchMode(user, /Document/);
    expect(screen.getByTitle('my-diagram.draftcanvas')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'Encrypted' }));
    expect(screen.getByTitle('my-diagram.dcenc')).toBeInTheDocument();

    await switchMode(user, /Animated/);
    expect(screen.getByTitle('my-diagram.gif')).toBeInTheDocument();

    await switchMode(user, /Source/);
    expect(screen.getByTitle('my-diagram.mmd')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'PlantUML' }));
    expect(screen.getByTitle('my-diagram.puml')).toBeInTheDocument();
  });

  it('renders a live thumbnail for Image, reporting the real 2× PNG size', () => {
    useEditorStore.setState({ document: withFlow(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    const { container } = renderDialog();

    const thumbnail = container.querySelector('.dc-export-stage img');
    expect(thumbnail?.getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    expect(screen.getByText(/^\d+ × \d+ px · 2×$/)).toBeInTheDocument();
  });
});

describe('ExportDialog — persistence', () => {
  it('remembers the last-used mode and format across a reopen', async () => {
    const user = userEvent.setup();
    useEditorStore.setState({ document: withFlow(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    const { unmount } = renderDialog();
    await switchMode(user, /Source/);
    await user.click(screen.getByRole('radio', { name: 'PlantUML' }));
    unmount();

    renderDialog();
    expect(screen.getByRole('radio', { name: /Source/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: 'PlantUML' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Export PlantUML' })).toBeInTheDocument();
  });
});

describe('ExportDialog — "Export selection…"', () => {
  it('forces Image mode with Selection only pre-checked, without persisting the override', async () => {
    useEditorStore.setState({
      document: withFlow(),
      selection: { nodes: ['n1'], edges: [] },
      selectedFlowId: null,
    });
    useUiStore.setState({ exportOpen: true, exportSelectionRequested: true });
    renderDialog();

    expect(screen.getByRole('radio', { name: /Image/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Selection only/ })).toBeChecked();
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

  it('reaches the footer CTA via Tab, in visual order', async () => {
    const user = userEvent.setup();
    useEditorStore.setState({ document: withFlow(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    renderDialog();
    await switchMode(user, /Source/);

    screen.getByRole('radio', { name: 'Mermaid' }).focus();
    expect(document.activeElement).toBe(screen.getByRole('radio', { name: 'Mermaid' }));

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Export Mermaid' }));
  });
});
