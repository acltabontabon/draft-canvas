import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import { isInOwnKeyboardRegion } from '../src/lib/isEditableTarget';

// The in-memory stand-in every store-touching test uses — see `tests/command-palette.test.tsx`.
const prefs = new Map<string, string>();
vi.mock('../src/lib/preferences', () => ({
  readPreference: (key: string) => prefs.get(key) ?? null,
  writePreference: (key: string, value: string) => void prefs.set(key, value),
  removePreference: (key: string) => void prefs.delete(key),
}));

const { useEditorStore } = await import('../src/store/editorStore');
const { useUiStore } = await import('../src/store/uiStore');
const { LearnDrawer } = await import('../src/ui/learn/LearnDrawer');

function resetStores() {
  useEditorStore.setState({ document: createDocument('Learn'), selection: { nodes: [], edges: [] }, mode: 'edit' });
  useUiStore.setState({ learnOpen: false, learnRecipeId: null, learnQuery: '', learnCategory: null, learnFocusPending: false, shortcutsOpen: false });
  prefs.clear();
}

const drawer = () => screen.getByRole('complementary', { name: 'Learn Draft Canvas' });
const search = () => screen.getByRole('searchbox', { name: 'Search Learn' });
const open = (recipeId?: string) => act(() => useUiStore.getState().openLearn(recipeId));

describe('Learn drawer', () => {
  beforeEach(resetStores);
  afterEach(() => vi.unstubAllGlobals());

  it('is nothing until opened, then a docked field guide with the search box focused', () => {
    render(<LearnDrawer />);
    expect(screen.queryByRole('complementary')).toBeNull();
    open();
    expect(drawer()).toBeInTheDocument();
    expect(drawer()).not.toHaveAttribute('aria-modal');
    expect(search()).toHaveFocus();
    // The short version, as six numbered stops.
    const route = screen.getByRole('heading', { name: 'The short version' }).nextElementSibling as HTMLElement;
    expect(within(route).getAllByRole('listitem')).toHaveLength(6);
  });

  it('answers "async" with the async recipe first, and opens it in place', async () => {
    const user = userEvent.setup();
    render(<LearnDrawer />);
    open();
    await user.type(search(), 'async');
    const first = within(screen.getByRole('list', { name: 'Results' })).getAllByRole('button')[0]!;
    expect(first).toHaveTextContent('Make a call async');
    // The matched word is marked in the title.
    expect(first.querySelector('mark')).toHaveTextContent('async');

    await user.click(first);
    const heading = screen.getByRole('heading', { name: 'Make a call async' });
    expect(heading).toHaveFocus();
    expect(screen.getByRole('img', { name: /Interaction mode is switched from Sync to Async/ })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Steps' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('steps back with Escape: recipe → results (focus on the row it came from) → clear search → close', async () => {
    const user = userEvent.setup();
    render(<LearnDrawer />);
    open();
    await user.type(search(), 'dlq');
    await user.click(screen.getByRole('button', { name: /Add a dead-letter queue/ }));
    expect(screen.getByRole('heading', { name: 'Add a dead-letter queue' })).toHaveFocus();

    await user.keyboard('{Escape}');
    const row = screen.getByRole('button', { name: /Add a dead-letter queue/ });
    expect(row).toHaveFocus();

    // From the row, not only from the box: Escape clears the search first, wherever focus is in Learn.
    await user.keyboard('{Escape}');
    expect(search()).toHaveValue('');
    expect(search()).toHaveFocus();
    expect(useUiStore.getState().learnOpen).toBe(true);

    await user.keyboard('{Escape}');
    expect(useUiStore.getState().learnOpen).toBe(false);
    await waitFor(() => expect(screen.queryByRole('complementary')).toBeNull());
  });

  it('leads from the search box into its answers by keyboard', async () => {
    const user = userEvent.setup();
    render(<LearnDrawer />);
    open();
    await user.type(search(), 'dlq{Enter}');
    expect(screen.getByRole('heading', { name: 'Add a dead-letter queue' })).toHaveFocus();

    await user.keyboard('{Escape}');
    act(() => search().focus());
    await user.keyboard('{ArrowDown}');
    const rows = within(screen.getByRole('list', { name: 'Results' })).getAllByRole('button');
    expect(rows[0]).toHaveFocus();
    await user.keyboard('{ArrowUp}');
    expect(search()).toHaveFocus();
  });

  it('opens straight onto a recipe from a deep link, even when already open', () => {
    render(<LearnDrawer />);
    open();
    open('present-flow');
    expect(screen.getByRole('heading', { name: 'Present a flow' })).toHaveFocus();
  });

  it('remembers where you were for the session', () => {
    const { unmount } = render(<LearnDrawer />);
    open('junction');
    act(() => useUiStore.getState().closeLearn());
    unmount();
    render(<LearnDrawer />);
    open();
    expect(screen.getByRole('heading', { name: 'Branch with a junction' })).toBeInTheDocument();
  });

  it('never dead-ends an empty search', async () => {
    const user = userEvent.setup();
    render(<LearnDrawer />);
    open();
    await user.type(search(), 'zzqx');
    expect(screen.getByText('No recipe for that yet.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'async' }));
    expect(search()).toHaveValue('async');
    expect(screen.getByRole('button', { name: /Make a call\s*async/ })).toBeInTheDocument();
    // The pill pressed is gone; focus went with the answer, not to the page behind Learn.
    expect(search()).toHaveFocus();

    await user.clear(search());
    await user.type(search(), 'zzqx');
    await user.click(screen.getByRole('button', { name: 'Flows' }));
    expect(screen.getByRole('button', { name: /Flows/, pressed: true })).toHaveFocus();
  });

  it('filters by topic in place, and a second press returns to the short version', async () => {
    const user = userEvent.setup();
    render(<LearnDrawer />);
    open();
    const flows = screen.getByRole('button', { name: 'Flows' });
    await user.click(flows);
    expect(flows).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('heading', { name: 'Flows' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Export a flow as a sequence diagram/ })).toBeInTheDocument();
    await user.click(flows);
    expect(screen.getByRole('heading', { name: 'The short version' })).toBeInTheDocument();
  });

  it('quietly offers what applies to the canvas selection, without moving anything above it', () => {
    const queue = createNode({ id: 'q', type: 'queue', x: 0, y: 0 });
    useEditorStore.setState({ document: { ...createDocument('Learn'), nodes: [queue] }, selection: { nodes: ['q'], edges: [] } });
    render(<LearnDrawer />);
    open();
    const context = screen.getByRole('region', { name: 'About the selected Queue' });
    expect(context).toHaveTextContent('Selected · Queue');
    expect(within(context).getByRole('button', { name: 'Add a dead-letter queue' })).toBeInTheDocument();

    act(() => useEditorStore.setState({ selection: { nodes: [], edges: [] } }));
    expect(screen.queryByRole('region', { name: /About the selected/ })).toBeNull();
  });

  it('steps aside while presenting, and comes back after', () => {
    render(<LearnDrawer />);
    open();
    act(() => useEditorStore.setState({ mode: 'present' }));
    return waitFor(() => expect(screen.queryByRole('complementary')).toBeNull()).then(() => {
      act(() => useEditorStore.setState({ mode: 'edit' }));
      expect(drawer()).toBeInTheDocument();
      // Coming back isn't a request for focus: the next keystroke still belongs to the canvas.
      expect(drawer().contains(document.activeElement)).toBe(false);
    });
  });

  it('becomes a modal sheet when the window is too narrow to dock', () => {
    vi.stubGlobal('matchMedia', (media: string) => ({
      matches: media.includes('max-width'),
      media,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    render(<LearnDrawer />);
    open();
    const sheet = screen.getByRole('dialog', { name: 'Learn Draft Canvas' });
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    expect(sheet).toHaveAttribute('data-mode', 'sheet');
  });

  it('owns its keys: the editor’s bare shortcuts stand down inside it', () => {
    render(<LearnDrawer />);
    open();
    const button = screen.getByRole('button', { name: 'Close Learn' });
    expect(isInOwnKeyboardRegion(button)).toBe(true);
    expect(isInOwnKeyboardRegion(document.body)).toBe(false);
    // And the Keyboard shortcuts row hands over to the existing sheet rather than repeating it.
    fireEvent.click(screen.getByRole('button', { name: /Keyboard shortcuts/ }));
    expect(useUiStore.getState().shortcutsOpen).toBe(true);
  });
});
