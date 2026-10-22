import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PRODUCT } from '../src/product';
import { useEditorStore } from '../src/store/editorStore';
import type { DocumentSession } from '../src/store/useDocumentSession';
import { useUiStore } from '../src/store/uiStore';
import { HelpMenu } from '../src/ui/Editor/HelpMenu';
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
    openShared: async () => {},
    openCollaborative: async () => false,
    makeEditableCopy: async () => {},
    closeDocument: async () => true,
    resolveConflict: async () => {},
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

beforeEach(() => {
  useEditorStore.setState({ history: { past: [], future: [] } });
  useUiStore.setState({
    armed: null,
    librarySearchQuery: '',
    updateReady: false,
    lastSeenProductRelease: '0.1.0', // old enough that the current version's notes are unread
  });
});

describe('unread release indicator', () => {
  it('homepage About control reflects unread state via its accessible name', async () => {
    render(<LibraryScreen session={stubSession()} />);
    // The notes are fetched only after an upgrade, so the Library's first chunk doesn't carry them.
    expect(await screen.findByRole('button', { name: /About Draft Canvas.*what's new/i })).toBeInTheDocument();
  });

  // About now lives behind the toolbar's More menu, so the state has to survive one level of
  // folding: the collapsed trigger says something is waiting, and the row inside says what.
  it('the editor’s Help button inherits the unread state of the About item it holds', () => {
    render(<HelpMenu />);
    expect(screen.getByRole('button', { name: /^Help.*what's new/i })).toBeInTheDocument();
  });

  it('the About row reflects unread state once the Help menu is open', async () => {
    const user = userEvent.setup();
    render(<HelpMenu />);
    await user.click(screen.getByRole('button', { name: /^Help/ }));
    // The row names its own flag too, not only the collapsed trigger.
    expect(screen.getByRole('menuitem', { name: /^About Draft Canvas\s*— new$/ })).toBeInTheDocument();
    expect(screen.getByRole('menu', { name: 'Help' })).toBeInTheDocument();
  });

  it('an update ready to install outranks unread notes on the Help button', () => {
    useUiStore.setState({ updateReady: true });
    render(<HelpMenu />);
    expect(screen.getByRole('button', { name: /^Help.*update ready/i })).toBeInTheDocument();
  });

  it('the Help button says nothing when there is nothing waiting', () => {
    useUiStore.getState().markProductReleaseSeen();
    render(<HelpMenu />);
    expect(screen.getByRole('button', { name: 'Help' })).toBeInTheDocument();
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
