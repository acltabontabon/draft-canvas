import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument, createEdge, createNode } from '../src/document/factory';
import { libraryShapeOf } from '../src/document/shape';
import type { DraftSummary } from '../src/document/types';
import { useUiStore } from '../src/store/uiStore';
import type { DocumentSession } from '../src/store/useDocumentSession';
import { LibraryScreen } from '../src/ui/Library/LibraryScreen';

/**
 * The home screen has to work in every shape a workspace can be in — brand
 * new, a few canvases, many, searched to nothing — and it has to keep the
 * handful of names the e2e suite (and any screen reader) finds it by.
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
    makeEditableCopy: async () => {},
    closeDocument: async () => true,
    resolveConflict: async () => {},
    renameDocument: async () => {},
    duplicateDocument: async () => {},
    deleteDocument: async () => {},
    openId: null,
    projects: [],
    refreshProjects: async () => {},
    createProject: vi.fn(async () => undefined),
    renameProject: async () => {},
    deleteProject: async () => {},
    moveDocumentToProject: async () => {},
    ...overrides,
  };
}

function summary(title: string, extra: Partial<DraftSummary> = {}): DraftSummary {
  return { id: `d-${title}`, title, createdAt: 1, updatedAt: 1, nodeCount: 0, edgeCount: 0, ...extra };
}

const shaped = (): DraftSummary => {
  const a = createNode({ type: 'service', id: 'a', x: 0, y: 0 });
  const b = createNode({ type: 'database', id: 'b', x: 300, y: 0 });
  return summary('Checkout', {
    nodeCount: 2,
    edgeCount: 1,
    shape: libraryShapeOf([a, b], [createEdge({ source: 'a', target: 'b' })]),
  });
};


beforeEach(() => {
  useUiStore.setState({
    librarySearchQuery: '',
    libraryBrowsing: true,
    libraryView: { kind: 'recent' },
    librarySort: 'updatedAt',
    moveMenuOpenFor: null,
  });
});

describe('LibraryScreen — Home', () => {
  beforeEach(() => useUiStore.setState({ libraryBrowsing: false }));

  it('keeps the web sketchbook, separator and project invitation without empty navigation or search', () => {
    const { container } = render(<LibraryScreen session={stubSession()} />);
    expect(screen.getByRole('heading', { name: /A little space.*A clearer picture/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try an example' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'New project' })).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Find a diagram' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Starters' })).not.toBeInTheDocument();
    expect(container.querySelector('.dc-home-shelf-head')).not.toBeNull();
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(1);
  });

  it('starts a blank canvas on Enter and ignores held, modified, or focused Enter', async () => {
    const session = stubSession();
    render(<LibraryScreen session={session} />);
    fireEvent.keyDown(document.body, { key: 'Enter', repeat: true });
    fireEvent.keyDown(document.body, { key: 'Enter', metaKey: true });
    fireEvent.keyDown(screen.getByRole('button', { name: 'About Draft Canvas' }), { key: 'Enter' });
    expect(session.newDocument).not.toHaveBeenCalled();
    await userEvent.keyboard('{Enter}');
    expect(session.newDocument).toHaveBeenCalledWith();
  });

  it('starts the retained example directly', async () => {
    const session = stubSession();
    render(<LibraryScreen session={session} />);
    await userEvent.click(screen.getByRole('button', { name: 'Try an example' }));
    expect(session.newDocument).toHaveBeenCalledWith(undefined, 'order-processing');
  });

  it('shows views and search with the first draft, hides them with the last, and walks the shelf', async () => {
    const { rerender } = render(<LibraryScreen session={stubSession()} />);
    rerender(<LibraryScreen session={stubSession({ library: [shaped()] })} />);
    expect(screen.getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Drafts', 'Recent', 'Projects']);
    screen.getByRole('button', { name: 'New canvas' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('tab', { name: 'Drafts' })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}{ArrowDown}');
    expect(screen.getByRole('button', { name: 'Open Checkout' })).toHaveFocus();
    rerender(<LibraryScreen session={stubSession()} />);
    expect(screen.queryByRole('tab')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Find a diagram' })).not.toBeInTheDocument();
  });

  it('opens the complete gallery from View all and returns to Home', async () => {
    render(<LibraryScreen session={stubSession({ library: [shaped()] })} />);
    await userEvent.click(screen.getByRole('button', { name: /View all/ }));
    expect(screen.getByRole('searchbox', { name: 'Search diagrams' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(screen.getByRole('button', { name: 'Open Checkout' })).toBeInTheDocument();
  });

  it('creates a browser project from the empty invitation', async () => {
    const session = stubSession();
    render(<LibraryScreen session={session} />);
    screen.getByRole('button', { name: 'New canvas' }).focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('button', { name: 'New project' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    const dialog = await screen.findByRole('dialog', { name: 'New project' });
    await userEvent.type(within(dialog).getByRole('textbox'), 'Payments');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    expect(session.createProject).toHaveBeenCalledWith('Payments');
  });
});

describe('LibraryScreen — gallery', () => {
  it('draws a topology preview for a summary with a shape, and an empty frame without one', () => {
    const session = stubSession({ library: [shaped(), summary('Blank')] });
    const { container } = render(<LibraryScreen session={session} />);

    const rows = container.querySelectorAll('.dc-library-list li');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('.dc-fingerprint-service')).not.toBeNull();
    expect(rows[0]!.querySelector('.dc-fingerprint-database')).not.toBeNull();
    expect(rows[0]!.querySelector('.dc-starter-edge-line')).not.toBeNull();
    expect(rows[1]!.querySelector('.dc-fingerprint-empty')).not.toBeNull();
  });

  it('opens a canvas from its row and keeps the per-row action names', async () => {
    const session = stubSession({ library: [shaped()] });
    render(<LibraryScreen session={session} />);

    await userEvent.click(screen.getByRole('button', { name: /^Checkout/ }));
    expect(session.openDocument).toHaveBeenCalledWith('d-Checkout');
    for (const name of ['Rename Checkout', 'Duplicate Checkout', 'Move Checkout to a project', 'Delete Checkout']) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  it('puts the full title on a long row so a truncated one is still readable', () => {
    const long = 'A'.repeat(60);
    render(<LibraryScreen session={stubSession({ library: [summary(long), summary('Short')] })} />);
    expect(screen.getByRole('button', { name: new RegExp(`^${long}`) })).toHaveAttribute('title', long);
    expect(screen.getByRole('button', { name: /^Short/ })).not.toHaveAttribute('title');
  });
});

describe('LibraryScreen — search', () => {
  it('counts matches, names a miss, and clears in one click', async () => {
    const session = stubSession({ library: [shaped(), summary('Ledger')] });
    render(<LibraryScreen session={session} />);

    const input = screen.getByRole('searchbox', { name: 'Search diagrams' });
    await userEvent.type(input, 'led');
    expect(screen.getByRole('heading', { name: 'Search results' })).toBeInTheDocument();
    expect(screen.getByText('1 of 2')).toBeInTheDocument();

    await userEvent.type(input, 'xx');
    expect(screen.getByText('No diagrams match “ledxx”.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(input).toHaveValue('');
    expect(screen.getByRole('heading', { name: 'Recently edited' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Ledger/ })).toBeInTheDocument();
  });

  it('focuses the search box on `/` unless something else is taking keys', async () => {
    render(<LibraryScreen session={stubSession({ library: [shaped()] })} />);
    const input = screen.getByRole('searchbox', { name: 'Search diagrams' });

    await userEvent.keyboard('/');
    expect(input).toHaveFocus();
    expect(input).toHaveValue('');

    await userEvent.type(input, 'a/b');
    expect(input).toHaveValue('a/b');
  });

  it('leaves `/` alone while a Move menu is open, so typing never reaches the menu', async () => {
    const moveDocumentToProject = vi.fn(async () => {});
    render(<LibraryScreen session={stubSession({ library: [shaped()], moveDocumentToProject })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Move Checkout to a project' }));
    expect(screen.getByRole('menu', { name: 'Move to project' })).toBeInTheDocument();

    await userEvent.keyboard('/');
    expect(screen.getByRole('searchbox', { name: 'Search diagrams' })).not.toHaveFocus();
    expect(moveDocumentToProject).not.toHaveBeenCalled();
  });

  it('closes the Move menu when the Library goes away', async () => {
    const { unmount } = render(<LibraryScreen session={stubSession({ library: [shaped()] })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Move Checkout to a project' }));
    expect(useUiStore.getState().moveMenuOpenFor).toBe('d-Checkout');
    unmount();
    expect(useUiStore.getState().moveMenuOpenFor).toBeNull();
  });
});

describe('LibraryScreen — dropped files', () => {
  const dropped = () => {
    const file = new File([JSON.stringify(createDocument('Dropped'))], 'dropped.draftcanvas', { type: 'application/json' });
    return { dataTransfer: { types: ['Files'], files: [file] } };
  };

  it('imports a file dropped on the gallery but not one let go over a dialog', async () => {
    const adoptDocument = vi.fn(async () => {});
    render(<LibraryScreen session={stubSession({ library: [shaped()], adoptDocument })} />);

    await userEvent.click(screen.getByRole('button', { name: 'Delete Checkout' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.drop(dialog, dropped());
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(adoptDocument).not.toHaveBeenCalled();

    fireEvent.drop(screen.getByRole('heading', { name: 'Recently edited', hidden: true }), dropped());
    await vi.waitFor(() => expect(adoptDocument).toHaveBeenCalledTimes(1));
  });
});

describe('LibraryScreen — the local-first line', () => {
  it('is one line until asked, then says the honest part', async () => {
    render(<LibraryScreen session={stubSession({ library: [shaped()] })} />);

    const toggle = screen.getByRole('button', { name: /Stored on this device/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(/Clearing this browser/)).not.toBeInTheDocument();

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/Clearing this browser/)).toBeInTheDocument();
    expect(screen.getByText(/works offline/)).toBeInTheDocument();
  });

  it('becomes the warning, already open, when storage is not durable', () => {
    render(<LibraryScreen session={stubSession({ durable: false })} />);
    const toggle = screen.getByRole('button', { name: /blocking local storage/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/lost when this tab closes/)).toBeInTheDocument();
  });

  it('says nothing about storage before storage is known', () => {
    render(<LibraryScreen session={stubSession({ ready: false })} />);
    expect(screen.getByText('Opening local storage…')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stored on this device/ })).not.toBeInTheDocument();
  });
});
