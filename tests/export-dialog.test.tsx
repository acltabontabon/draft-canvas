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

  it('shows the generated text itself, read-only, with Copy beside the export — never a rendered diagram', async () => {
    const user = userEvent.setup();
    useEditorStore.setState({ document: withFlow(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    renderDialog();
    await switchMode(user, /Source/);

    const dialog = screen.getByRole('dialog');
    const preview = within(dialog).getByTestId('export-source-preview');
    expect(preview.querySelector('pre')!.textContent).toContain('sequenceDiagram');
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Copy' })).toBeEnabled();
    // The artifact is the file tile, never a rendered diagram.
    expect(dialog.querySelector('.dc-export-file')).not.toBeNull();
    expect(dialog.querySelector('.dc-export-stage img')).toBeNull();
  });

  it('offers the architecture formats without needing a Flow, and remembers the choice', async () => {
    const user = userEvent.setup();
    useEditorStore.setState({ document: withoutFlows(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    const { unmount } = renderDialog();
    await switchMode(user, /Source/);
    expect(screen.getByRole('button', { name: 'Export Mermaid' })).toBeDisabled();

    await user.click(screen.getByRole('radio', { name: 'Architecture' }));
    expect(screen.getByRole('radio', { name: 'Mermaid flowchart' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Export Mermaid flowchart' })).toBeEnabled();
    expect(screen.getByTestId('export-source-preview').textContent).toContain('flowchart LR');
    expect(screen.getByTitle('my-diagram.mmd')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'draw.io' }));
    expect(screen.getByTitle('my-diagram.drawio')).toBeInTheDocument();
    expect(screen.getByTestId('export-source-preview').textContent).toContain('<mxfile');
    await user.click(screen.getByRole('radio', { name: 'Structurizr DSL' }));
    expect(screen.getByTitle('my-diagram.dsl')).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: 'C4-PlantUML' }));
    expect(screen.getByTitle('my-diagram.puml')).toBeInTheDocument();
    expect(prefs.get('sequence-export-format')).toBe('c4-plantuml');

    unmount();
    renderDialog();
    expect(screen.getByRole('radio', { name: 'C4-PlantUML' })).toBeChecked();
  });

  it('caps the preview at 200 lines and says how many more there are', async () => {
    const user = userEvent.setup();
    const nodes = Array.from({ length: 220 }, (_, i) => createNode({ type: 'service', x: i * 10, y: 0, text: `Service ${i}` }));
    useEditorStore.setState({ document: { ...createDocument('Big'), nodes }, selection: { nodes: [], edges: [] }, selectedFlowId: null });
    prefs.set('sequence-export-format', 'mermaid-flowchart');
    renderDialog();
    await switchMode(user, /Source/);
    const preview = screen.getByTestId('export-source-preview');
    expect(preview.querySelector('pre')!.textContent!.split('\n')).toHaveLength(200);
    expect(preview.textContent).toMatch(/… \d+ more lines/);
  });

  it('copies the source text and says so', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn<(text: string) => Promise<void>>(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    useEditorStore.setState({ document: withFlow(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    renderDialog();
    await switchMode(user, /Source/);
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(writeText).toHaveBeenCalledOnce();
    expect(writeText.mock.calls[0]![0]).toContain('sequenceDiagram');
    expect(useUiStore.getState().toasts.some((toast) => toast.message === 'Mermaid source copied.')).toBe(true);
    // Copying keeps the dialog open: it is often the first of several.
    expect(useUiStore.getState().exportOpen).toBe(true);
  });
});

describe('ExportDialog — editable images', () => {
  it('is on by default for SVG and off for PNG, remembered per format, and noted on the tile', async () => {
    const user = userEvent.setup();
    useEditorStore.setState({ document: withFlow(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    const { unmount } = renderDialog();

    const editable = () => screen.getByRole('checkbox', { name: /Editable/ });
    const meta = () => document.querySelector('.dc-export-meta')!.textContent;
    expect(editable()).not.toBeChecked();
    expect(meta()).not.toContain('diagram inside');
    await user.click(screen.getByRole('radio', { name: 'SVG' }));
    expect(editable()).toBeChecked();
    expect(meta()).toMatch(/· diagram inside$/);

    await user.click(editable());
    expect(prefs.get('export-editable-svg')).toBe('off');
    await user.click(screen.getByRole('radio', { name: 'PNG' }));
    await user.click(editable());
    expect(prefs.get('export-editable-png')).toBe('on');

    unmount();
    renderDialog();
    expect(editable()).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'SVG' }));
    expect(editable()).not.toBeChecked();
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

  it('offers 1×/2×/3× for PNG only, reports the chosen scale, and remembers it', async () => {
    const user = userEvent.setup();
    useEditorStore.setState({ document: withFlow(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    const { unmount } = renderDialog();

    const scale = screen.getByRole('radiogroup', { name: 'Scale' });
    expect(within(scale).getByRole('radio', { name: '2×' })).toBeChecked();
    const before = screen.getByText(/^\d+ × \d+ px · 2×$/).textContent!.match(/^(\d+) × (\d+)/)!;

    await user.click(within(scale).getByRole('radio', { name: '3×' }));
    const after = screen.getByText(/^\d+ × \d+ px · 3×$/).textContent!.match(/^(\d+) × (\d+)/)!;
    expect(Number(after[1])).toBe(Math.round((Number(before[1]) / 2) * 3));
    expect(Number(after[2])).toBe(Math.round((Number(before[2]) / 2) * 3));
    expect(prefs.get('export-png-scale')).toBe('3');

    // An SVG has no pixels to multiply.
    await user.click(screen.getByRole('radio', { name: 'SVG' }));
    expect(screen.queryByRole('radiogroup', { name: 'Scale' })).not.toBeInTheDocument();
    expect(screen.getByText(/^\d+ × \d+ · vector/)).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'PNG' }));
    unmount();
    renderDialog();
    expect(within(screen.getByRole('radiogroup', { name: 'Scale' })).getByRole('radio', { name: '3×' })).toBeChecked();
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

    // Format, then the preview (scrollable, so it takes focus), then Copy, then the CTA.
    await user.tab();
    expect(document.activeElement).toBe(screen.getByLabelText('Mermaid source'));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Copy' }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Export Mermaid' }));
  });
});

/**
 * A picture of "the canvas" means two different things once you are standing inside a shape, and
 * the dialog used to answer silently — you got the room, with nothing saying so. A canvas *file*
 * has never been ambiguous: it always carries every room.
 */
describe('ExportDialog — which canvas', () => {
  function insideAShape() {
    const platform = createNode({ type: 'service', x: 0, y: 0, text: 'Lending Platform' });
    const inner = createNode({ type: 'component', x: 10, y: 10, text: 'Controller' });
    useEditorStore.setState({
      document: { ...createDocument('Lending'), nodes: [platform] },
      path: [],
      outer: null,
      selection: { nodes: [], edges: [] },
      liveViewport: null,
    });
    useEditorStore.getState().enterInside(platform.id);
    useEditorStore.getState().addNode({ type: inner.type, x: 10, y: 10, text: 'Controller' });
  }

  it('asks nothing at the top level', () => {
    useEditorStore.setState({ document: withFlow(), path: [], outer: null, liveViewport: null });
    renderDialog();
    expect(screen.queryByText('The whole canvas')).toBeNull();
  });

  it('offers the room or the whole canvas once you are inside one', async () => {
    const user = userEvent.setup();
    insideAShape();
    renderDialog();

    // The room is what you are looking at, so it is what the dialog starts on.
    expect(screen.getByRole('radio', { name: /Inside Lending Platform/ })).toBeChecked();
    await user.click(screen.getByRole('radio', { name: 'The whole canvas' }));
    expect(screen.getByRole('radio', { name: 'The whole canvas' })).toBeChecked();
    expect(screen.getByRole('radio', { name: /Inside Lending Platform/ })).not.toBeChecked();
  });

  it('never asks about a canvas file, which is always all of it', async () => {
    const user = userEvent.setup();
    insideAShape();
    renderDialog();
    await switchMode(user, /Document/);
    expect(screen.queryByText('The whole canvas')).toBeNull();
  });
});

describe('ExportDialog — every level', () => {
  function withRoom(): DraftDocument {
    const inner = createNode({ type: 'component', x: 0, y: 0, text: 'Handler' });
    const owner = {
      ...createNode({ type: 'service', x: 0, y: 0, text: 'Orders API' }),
      inside: { nodes: [inner], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } },
    };
    return { ...createDocument('My Diagram'), nodes: [owner] };
  }

  it('is not offered on a flat canvas', () => {
    useEditorStore.setState({ document: withFlow(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    renderDialog();
    expect(screen.queryByRole('checkbox', { name: /Every level/ })).not.toBeInTheDocument();
  });

  it('turns the image export into a ZIP of every room, and the CTA and file name follow', async () => {
    const user = userEvent.setup();
    useEditorStore.setState({ document: withRoom(), selection: { nodes: [], edges: [] }, selectedFlowId: null });
    renderDialog();

    const every = screen.getByRole('checkbox', { name: /Every level/ });
    expect(every).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Export PNG' })).toBeInTheDocument();

    await user.click(every);
    expect(screen.getByRole('button', { name: 'Export every level' })).toBeEnabled();
    expect(screen.getByTitle('my-diagram-levels.zip')).toBeInTheDocument();
    expect(screen.getByText('2 images · PNG')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'SVG' }));
    expect(screen.getByText('2 images · SVG')).toBeInTheDocument();
    expect(screen.getByTitle('my-diagram-levels.zip')).toBeInTheDocument();

    await user.click(every);
    expect(screen.getByRole('button', { name: 'Export SVG' })).toBeInTheDocument();
    expect(screen.getByTitle('my-diagram.svg')).toBeInTheDocument();
  });

  it('counts Flows across rooms for the Source export', async () => {
    const user = userEvent.setup();
    const doc = withRoom();
    const inner = doc.nodes[0]!.inside!;
    const other = createNode({ type: 'component', x: 200, y: 0, text: 'Writer' });
    const edge = createEdge({ source: inner.nodes[0]!.id, target: other.id, label: 'Persist' });
    const flow = createFlow({ title: 'Inside' });
    flow.steps = [{ id: 'fs9', edgeId: edge.id }];
    const withInnerFlow = { ...doc, nodes: [{ ...doc.nodes[0]!, inside: { ...inner, nodes: [...inner.nodes, other], edges: [edge], flows: [flow] } }] };
    useEditorStore.setState({ document: withInnerFlow, selection: { nodes: [], edges: [] }, selectedFlowId: null });
    renderDialog();
    await switchMode(user, /Source/);

    expect(screen.getByRole('button', { name: 'Export Mermaid' })).toBeEnabled();
    expect(screen.getByText('1 Flow · plain text')).toBeInTheDocument();
  });
});
