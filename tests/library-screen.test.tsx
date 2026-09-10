import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEdge, createNode } from '../src/document/factory';
import { libraryShapeOf } from '../src/document/shape';
import type { DraftSummary, Project } from '../src/document/types';
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

const project: Project = { id: 'p1', name: 'Payments', createdAt: 1, updatedAt: 1 };

beforeEach(() => {
  useUiStore.setState({
    librarySearchQuery: '',
    libraryView: { kind: 'recent' },
    librarySort: 'updatedAt',
    moveMenuOpenFor: null,
  });
});

describe('LibraryScreen — an empty workspace', () => {
  it('offers the five starters, keeps the heading, and hides the nav there is nothing to navigate', () => {
    const session = stubSession();
    render(<LibraryScreen session={session} />);

    expect(screen.getByRole('heading', { name: 'Recently edited' })).toBeInTheDocument();
    expect(screen.getByText('Nothing here yet.')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Diagram views' })).not.toBeInTheDocument();
    const starters = within(screen.getByRole('group', { name: 'Architecture starters' })).getAllByRole('button');
    expect(starters.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Start from Monolith',
      'Start from Modular Monolith',
      'Start from Microservices',
      'Start from Event-Driven',
      'Start from Hexagonal',
    ]);
  });

  it('seeds a canvas from a starter, from the keyboard', async () => {
    const session = stubSession();
    render(<LibraryScreen session={session} />);

    screen.getByRole('button', { name: 'Start from Hexagonal' }).focus();
    await userEvent.keyboard('{Enter}');
    expect(session.newDocument).toHaveBeenCalledWith(undefined, 'hexagonal');
  });

  it('keeps exactly one button each for the names the rest of the app relies on', () => {
    render(<LibraryScreen session={stubSession()} />);
    expect(screen.getAllByRole('button', { name: /new canvas/i })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: /import/i })).toHaveLength(1);
  });

  it('still shows the nav when a project exists without canvases', () => {
    render(<LibraryScreen session={stubSession({ projects: [project] })} />);
    expect(screen.getByRole('navigation', { name: 'Diagram views' })).toBeInTheDocument();
    expect(screen.getByText('Nothing here yet.')).toBeInTheDocument();
  });
});

describe('LibraryScreen — rows', () => {
  it('draws a fingerprint for a summary with a shape, and an empty frame without one', () => {
    const session = stubSession({ library: [shaped(), summary('Blank')] });
    const { container } = render(<LibraryScreen session={session} />);

    const rows = container.querySelectorAll('.dc-library-list li');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.querySelector('.dc-fingerprint-service')).not.toBeNull();
    expect(rows[0]!.querySelector('.dc-fingerprint-database')).not.toBeNull();
    expect(rows[0]!.querySelector('.dc-fingerprint-edge')).not.toBeNull();
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
