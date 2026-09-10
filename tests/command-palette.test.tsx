import { ReactFlowProvider } from '@xyflow/react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument } from '../src/document/factory';
import { __resetInteraction, useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';
import { stubContext, stubPlayback } from './commandStubs';

// Node's own experimental `globalThis.localStorage` shadows jsdom's in this environment — the
// same in-memory fake `tests/personality-preference.test.tsx` uses stands in for
// `lib/preferences.ts`, including its 64-character cap, so the history's own key scheme is what
// gets exercised.
const prefs = new Map<string, string>();
vi.mock('../src/lib/preferences', () => ({
  readPreference: (key: string) => prefs.get(key) ?? null,
  writePreference: (key: string, value: string) => {
    if (value.length > 64) return;
    prefs.set(key, value);
  },
  removePreference: (key: string) => void prefs.delete(key),
}));

const { CommandPalette } = await import('../src/ui/Editor/CommandPalette');
const { HintsProvider } = await import('../src/learning/HintsProvider');

function reset() {
  __resetInteraction();
  useEditorStore.setState({
    document: createDocument('Palette'),
    history: { past: [], future: [] },
    selection: { nodes: [], edges: [] },
    clipboard: null,
    revision: 0,
    mode: 'edit',
    flowPlayback: { active: false, flowId: null, step: 0 },
    focus: { active: false, nodeIds: [], edgeIds: [] },
    flowEdit: { active: false, flowId: null },
    selectedFlowId: null,
  });
  useUiStore.setState({
    commandPaletteOpen: true,
    flowSwitcherOpen: false,
    quickConnect: null,
    learnModeActive: false,
  });
  prefs.clear();
}

function mount(playback = stubPlayback()) {
  const stubs = stubContext({ playback });
  return render(
    <ReactFlowProvider>
      <CommandPalette createAt={stubs.createAt} createAtPointer={stubs.createAtPointer} playback={playback} />
    </ReactFlowProvider>,
  );
}

const input = () => screen.getByRole('textbox') as HTMLInputElement;
const options = () => screen.getAllByRole('option');
const highlighted = () => screen.getByRole('option', { selected: true });
const key = (key: string, init: KeyboardEventInit = {}) => fireEvent.keyDown(window, { key, ...init });

describe('CommandPalette', () => {
  beforeEach(reset);

  it('renders nothing while closed', () => {
    useUiStore.setState({ commandPaletteOpen: false });
    mount();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('lists grouped commands with the first one highlighted', () => {
    mount();
    expect(screen.getByRole('dialog', { name: 'Commands' })).toBeInTheDocument();
    expect(options().length).toBeGreaterThan(8);
    expect(highlighted()).toHaveTextContent('Add Text');
  });

  it('filters as you type and runs the highlighted command on Enter', () => {
    mount();
    fireEvent.change(input(), { target: { value: 'serv' } });
    expect(highlighted()).toHaveTextContent('Add Service');

    key('Enter');
    const state = useEditorStore.getState();
    expect(state.document.nodes).toHaveLength(1);
    expect(state.document.nodes[0]!.type).toBe('service');
    expect(state.selection.nodes).toEqual([state.document.nodes[0]!.id]);
    expect(useUiStore.getState().commandPaletteOpen).toBe(false);
  });

  it('arrow keys move the highlight and clamp at both ends', () => {
    mount();
    fireEvent.change(input(), { target: { value: 'add' } });
    const count = options().length;
    key('ArrowUp');
    expect(highlighted()).toHaveTextContent(options()[0]!.textContent!);
    for (let i = 0; i < count + 3; i += 1) key('ArrowDown');
    expect(highlighted()).toHaveTextContent(options()[count - 1]!.textContent!);
  });

  it('Escape closes without touching the document', () => {
    useEditorStore.getState().addNode({ type: 'note', x: 10, y: 10, text: 'keep me' });
    const before = JSON.stringify(useEditorStore.getState().document);
    const history = useEditorStore.getState().history.past.length;
    mount();
    fireEvent.change(input(), { target: { value: 'delete' } });
    key('Escape');
    expect(useUiStore.getState().commandPaletteOpen).toBe(false);
    expect(JSON.stringify(useEditorStore.getState().document)).toBe(before);
    expect(useEditorStore.getState().history.past.length).toBe(history);
  });

  it('Cmd/Ctrl+K while open closes it again', () => {
    mount();
    key('k', { metaKey: true });
    expect(useUiStore.getState().commandPaletteOpen).toBe(false);
  });

  it('a two-step command shows a breadcrumb, and Backspace on an empty query steps back', () => {
    useEditorStore.getState().createFlow('Checkout');
    mount();
    fireEvent.change(input(), { target: { value: 'switch' } });
    expect(highlighted()).toHaveTextContent('Switch to flow');
    key('Enter');

    expect(useUiStore.getState().commandPaletteOpen).toBe(true);
    expect(screen.getByText('Switch to')).toHaveClass('dc-palette-stage');
    expect(options().map((o) => o.textContent)).toEqual([expect.stringContaining('Diagram'), expect.stringContaining('Checkout')]);

    key('Backspace');
    expect(screen.queryByText('Switch to')).toBeNull();
    expect(options().length).toBeGreaterThan(2);
  });

  it('picking a stage option runs it and closes', () => {
    const flowId = useEditorStore.getState().createFlow('Checkout')!;
    mount();
    fireEvent.change(input(), { target: { value: 'switch' } });
    key('Enter');
    key('ArrowDown');
    key('Enter');
    expect(useEditorStore.getState().selectedFlowId).toBe(flowId);
    expect(useUiStore.getState().commandPaletteOpen).toBe(false);
  });

  it('reopening after running a command starts from an empty query', () => {
    mount();
    fireEvent.change(input(), { target: { value: 'theme' } });
    key('Enter');
    expect(useUiStore.getState().commandPaletteOpen).toBe(false);
    act(() => useUiStore.getState().setCommandPaletteOpen(true));
    expect(input().value).toBe('');
    // …and, having just run it, the theme toggle now leads under Recent.
    expect(highlighted()).toHaveTextContent('Toggle light / dark theme');
    expect(screen.getByText('Recent')).toBeInTheDocument();
  });

  it('runs a contextual two-step command end to end: Connect to… → pick a node', () => {
    const state = useEditorStore.getState();
    const api = state.addNode({ type: 'service', x: 0, y: 0, text: 'Payment API' });
    const ledger = state.addNode({ type: 'database', x: 300, y: 0, text: 'Ledger' });
    state.setSelection({ nodes: [api.id], edges: [] });
    mount();
    fireEvent.change(input(), { target: { value: 'conn' } });
    expect(highlighted()).toHaveTextContent('Connect to…');
    key('Enter');
    expect(screen.getByText('Connect to')).toHaveClass('dc-palette-stage');
    fireEvent.change(input(), { target: { value: 'led' } });
    expect(highlighted()).toHaveTextContent('Ledger');
    key('Enter');
    const edges = useEditorStore.getState().document.edges;
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: api.id, target: ledger.id });
    expect(useUiStore.getState().commandPaletteOpen).toBe(false);
  });

  it('typing a name lists it under Jump to, after any command matches, and Enter jumps there', () => {
    const state = useEditorStore.getState();
    state.addNode({ type: 'service', x: 0, y: 0, text: 'Payment API' });
    const ledger = state.addNode({ type: 'database', x: 800, y: 0, text: 'Ledger' });
    state.setSelection({ nodes: [], edges: [] });
    mount();
    expect(screen.queryByRole('option', { name: /Ledger/ })).toBeNull(); // no index while the query is empty
    // An exact element name beats a scattered command match, but a good command match still
    // leads: "Add Data Store" the command sits above "Data Store" the node for "add data".
    fireEvent.change(input(), { target: { value: 'add data' } });
    expect(highlighted()).toHaveTextContent('Add Data Store');
    fireEvent.change(input(), { target: { value: 'ledg' } });
    expect(highlighted()).toHaveTextContent('Ledger');
    key('Enter');
    expect(useEditorStore.getState().selection.nodes).toEqual([ledger.id]);
    expect(useUiStore.getState().jumpFlashId).toBe(ledger.id);
    expect(useUiStore.getState().commandPaletteOpen).toBe(false);
  });

  it('remembers what ran: reopening leads with Recent, so Enter repeats the last command', () => {
    mount();
    fireEvent.change(input(), { target: { value: 'add serv' } });
    key('Enter');
    act(() => useUiStore.getState().setCommandPaletteOpen(true));
    expect(screen.getByText('Recent')).toBeInTheDocument();
    expect(highlighted()).toHaveTextContent('Add Service');
    key('Enter');
    expect(useEditorStore.getState().document.nodes.filter((n) => n.type === 'service')).toHaveLength(2);
  });

  it('records a two-step command under its own id, not the option picked inside it', () => {
    const state = useEditorStore.getState();
    const api = state.addNode({ type: 'service', x: 0, y: 0, text: 'API' });
    state.addNode({ type: 'database', x: 300, y: 0, text: 'Ledger' });
    state.setSelection({ nodes: [api.id], edges: [] });
    mount();
    fireEvent.change(input(), { target: { value: 'conn' } });
    key('Enter');
    fireEvent.change(input(), { target: { value: 'ledg' } });
    key('Enter');
    expect(prefs.get('command-recent.0')).toBe('connect-to');
    expect(prefs.get('command-use.connect-to')).toBe('1');
  });

  it('never records a jump as a command', () => {
    const state = useEditorStore.getState();
    state.addNode({ type: 'service', x: 0, y: 0, text: 'Payment API' });
    state.setSelection({ nodes: [], edges: [] });
    mount();
    fireEvent.change(input(), { target: { value: 'payment' } });
    key('Enter');
    expect(prefs.get('command-recent.0')).toBeUndefined();
  });

  it('opening it once retires the "press ⌘K" hint (Phase 7.2)', () => {
    useUiStore.setState({ commandPaletteOpen: false });
    const playback = stubPlayback();
    const stubs = stubContext({ playback });
    render(
      <ReactFlowProvider>
        <HintsProvider>
          <CommandPalette createAt={stubs.createAt} createAtPointer={stubs.createAtPointer} playback={playback} />
        </HintsProvider>
      </ReactFlowProvider>,
    );
    expect(prefs.get('hint.command-palette')).toBeUndefined();
    act(() => useUiStore.getState().setCommandPaletteOpen(true));
    expect(prefs.get('hint.command-palette')).toBe('1');
  });

  it('shows "No matching commands." for a query nothing matches', () => {
    mount();
    fireEvent.change(input(), { target: { value: 'zzzzqq' } });
    expect(screen.getByText('No matching commands.')).toBeInTheDocument();
    key('Enter'); // nothing to run — must not throw or close
    expect(useUiStore.getState().commandPaletteOpen).toBe(true);
  });

  it('re-lists live as the world changes while it is open', () => {
    mount();
    expect(screen.queryByText('Undo')).toBeNull();
    act(() => {
      useEditorStore.getState().addNode({ type: 'note', x: 0, y: 0, text: 'x' });
    });
    expect(screen.getByText('Undo')).toBeInTheDocument();
  });

  it('closes the flow switcher and any quick-connect menu when it opens', () => {
    useUiStore.setState({
      commandPaletteOpen: false,
      flowSwitcherOpen: true,
      quickConnect: { flowPosition: { x: 0, y: 0 }, screenPosition: { x: 0, y: 0 } },
    });
    mount();
    act(() => useUiStore.getState().setCommandPaletteOpen(true));
    expect(useUiStore.getState().flowSwitcherOpen).toBe(false);
    expect(useUiStore.getState().quickConnect).toBeNull();
  });
});
