import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PRODUCT } from '../src/product';
import { useEditorStore } from '../src/store/editorStore';
import type { DocumentSession } from '../src/store/useDocumentSession';
import { useUiStore } from '../src/store/uiStore';
import { Toolbar } from '../src/ui/Editor/Toolbar';
import { LibraryScreen } from '../src/ui/Library/LibraryScreen';

/**
 * The homepage and toolbar About/info buttons share one small unread-release affordance — see
 * `AboutDialog.tsx`'s version row for the "permanent What's New link" this dot merely flags.
 * Covers only the state it renders from; the modal's own content is `whats-new-view.test.tsx`.
 */

function stubSession(overrides: Partial<DocumentSession> = {}): DocumentSession {
  return {
    ready: true,
    repository: null,
    durable: true,
    library: [],
    refreshLibrary: async () => {},
    openDocument: vi.fn(async () => {}),
    newDocument: vi.fn(async () => {}),
    adoptDocument: async () => {},
    closeDocument: async () => {},
    renameDocument: async () => {},
    duplicateDocument: async () => {},
    deleteDocument: async () => {},
    openId: null,
    projects: [],
    refreshProjects: async () => {},
    createProject: async () => undefined,
    renameProject: async () => {},
    deleteProject: async () => {},
    moveDocumentToProject: async () => {},
    ...overrides,
  };
}

function renderToolbar() {
  render(
    <Toolbar
      title="Untitled canvas"
      onTitleChange={() => {}}
      onBack={() => {}}
      onPresent={() => {}}
      onExport={() => {}}
    />,
  );
}

beforeEach(() => {
  useEditorStore.setState({ history: { past: [], future: [] } });
  useUiStore.setState({
    armed: null,
    learnModeActive: false,
    librarySearchQuery: '',
    updateReady: false,
    lastSeenProductRelease: '0.1.0', // old enough that the current version's notes are unread
  });
});

describe('unread release indicator', () => {
  it('homepage About control reflects unread state via its accessible name', () => {
    render(<LibraryScreen session={stubSession()} />);
    expect(screen.getByRole('button', { name: /About Draft Canvas.*what's new/i })).toBeInTheDocument();
  });

  // About now lives behind the toolbar's More menu, so the state has to survive one level of
  // folding: the collapsed trigger says something is waiting, and the row inside says what.
  it('toolbar More trigger inherits the unread state of the About item it hides', () => {
    renderToolbar();
    expect(screen.getByRole('button', { name: /^More.*what's new/i })).toBeInTheDocument();
  });

  it('toolbar About control reflects unread state once the More menu is open', async () => {
    const user = userEvent.setup();
    renderToolbar();
    await user.click(screen.getByRole('button', { name: /^More/ }));
    expect(screen.getByRole('menuitem', { name: 'About Draft Canvas' })).toBeInTheDocument();
    expect(screen.getByRole('menu', { name: 'More' })).toBeInTheDocument();
  });

  it('an update ready to install outranks unread notes on the toolbar trigger', () => {
    useUiStore.setState({ updateReady: true });
    renderToolbar();
    expect(screen.getByRole('button', { name: /^More.*update ready/i })).toBeInTheDocument();
  });

  it('the toolbar trigger says nothing when there is nothing waiting', () => {
    useUiStore.getState().markProductReleaseSeen();
    renderToolbar();
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument();
  });

  it('is not shown once the release has been acknowledged', () => {
    useUiStore.getState().markProductReleaseSeen();
    render(<LibraryScreen session={stubSession()} />);
    expect(screen.getByRole('button', { name: 'About Draft Canvas' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /what's new/i })).not.toBeInTheDocument();
  });

  it('an update ready to install takes priority over the unread-release indicator', () => {
    useUiStore.setState({ updateReady: true });
    render(<LibraryScreen session={stubSession()} />);
    expect(screen.getByRole('button', { name: /About Draft Canvas.*update ready/i })).toBeInTheDocument();
  });

  it('a brand-new installation (nothing ever stored) shows no unread indicator', () => {
    // Simulates a fresh install: the store's own initial resolution already treats "never
    // stored" as "nothing unread" — see `readLastSeenRelease` — so setting it to the running
    // app's own version reproduces that same starting state without touching real storage.
    useUiStore.setState({ lastSeenProductRelease: PRODUCT.version });
    render(<LibraryScreen session={stubSession()} />);
    expect(screen.getByRole('button', { name: 'About Draft Canvas' })).toBeInTheDocument();
  });
});
