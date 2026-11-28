import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { DraftSummary } from '../src/document/types';
import { useUiStore } from '../src/store/uiStore';
import type { DocumentSession } from '../src/store/useDocumentSession';
import { LibraryScreen } from '../src/ui/Library/LibraryScreen';

/**
 * Where focus goes after a diagram is deleted from Home's shelf or the gallery. The delete here
 * finishes on its own clock and the list changes on another, because that is the order that lost
 * focus in a browser: `deleteDocument` had resolved, a frame was served, and only then did React
 * draw the list without the card.
 */

function summary(title: string, updatedAt: number): DraftSummary {
  return { id: `d-${title}`, title, createdAt: 1, updatedAt, nodeCount: 0, edgeCount: 0 };
}

/** What the test holds of a delete in flight: the list drops the diagram only when told to. */
const storage = { drop: () => {}, fail: false };

function Screen({ titles }: { titles: string[] }) {
  const [library, setLibrary] = useState(() => titles.map((title, index) => summary(title, 100 - index)));
  const nothing = async () => {};
  const session: DocumentSession = {
    ready: true,
    repository: null,
    durable: true,
    library,
    refreshLibrary: nothing,
    openDocument: nothing,
    newDocument: nothing,
    adoptDocument: nothing,
    openShared: nothing,
    openCollaborative: async () => false,
    makeEditableCopy: nothing,
    closeDocument: async () => true,
    replaceWithNew: nothing,
    resolveConflict: nothing,
    retrySave: async () => true,
    exportUnsaved: nothing,
    leaveWithoutSaving: nothing,
    renameDocument: nothing,
    duplicateDocument: nothing,
    // Resolves at once, as the real one does once the new list is handed to React; the list itself
    // changes when the test says so.
    deleteDocument: async (id) => {
      storage.drop = () => setLibrary((entries) => entries.filter((entry) => entry.id !== (storage.fail ? '' : id)));
    },
    openId: null,
    projects: [],
    refreshProjects: nothing,
    createProject: async () => undefined,
    renameProject: nothing,
    deleteProject: nothing,
    moveDocumentToProject: nothing,
  };
  return <LibraryScreen session={session} />;
}

const frame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

/** Confirms the delete of `title`, then lets frames pass before the list changes. */
async function confirmDelete(title: string) {
  const trash = screen.getByRole('button', { name: `Delete ${title}` });
  await userEvent.click(trash);
  const dialog = await screen.findByRole('dialog');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
  await frame();
  await frame();
  return trash;
}

beforeEach(() => {
  storage.drop = () => {};
  storage.fail = false;
  useUiStore.setState({
    librarySearchQuery: '',
    libraryBrowsing: false,
    libraryView: { kind: 'recent' },
    librarySort: 'updatedAt',
    moveMenuOpenFor: null,
  });
});

const tile = (title: string) => screen.getByText(title, { selector: '.dc-home-draft-name' }).closest('button');

describe('focus after deleting a diagram', () => {
  it('lands on the card that took its place when the shelf is drawn after the dialog gave focus back', async () => {
    render(<Screen titles={['Checkout', 'Orders', 'Billing']} />);
    const trash = await confirmDelete('Checkout');
    // The race's first half: the dialog has handed focus back to a button about to be removed.
    expect(document.activeElement).toBe(trash);

    act(() => storage.drop());
    expect(trash.isConnected).toBe(false);
    expect(document.activeElement).toBe(tile('Orders'));
  });

  it('lands on the last card when the deleted one was last', async () => {
    render(<Screen titles={['Checkout', 'Orders', 'Billing']} />);
    await confirmDelete('Billing');
    act(() => storage.drop());
    expect(document.activeElement).toBe(tile('Orders'));
  });

  it('lands on Quick Draft when the shelf is left empty', async () => {
    render(<Screen titles={['Checkout']} />);
    await confirmDelete('Checkout');
    act(() => storage.drop());
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Quick Draft/ }));
  });

  it('leaves focus where the person has put it since', async () => {
    render(<Screen titles={['Checkout', 'Orders']} />);
    await confirmDelete('Checkout');
    const find = screen.getByRole('button', { name: 'Find a diagram' });
    act(() => find.focus());
    act(() => storage.drop());
    expect(document.activeElement).toBe(find);
  });

  it('keeps the dialog’s own focus return when the delete failed, and forgets it', async () => {
    render(<Screen titles={['Checkout', 'Orders', 'Billing']} />);
    storage.fail = true;
    const trash = await confirmDelete('Checkout');
    // The list is read again, with the diagram still in it.
    act(() => storage.drop());
    expect(document.activeElement).toBe(trash);

    // Much later the diagram does go (another tab deleted it) while nothing is focused: that is not
    // this screen's delete, and focus is not moved for it.
    act(() => trash.blur());
    storage.fail = false;
    act(() => storage.drop());
    expect(trash.isConnected).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it('lands on the row that took its place in the gallery', async () => {
    useUiStore.setState({ libraryBrowsing: true });
    render(<Screen titles={['Checkout', 'Orders', 'Billing']} />);
    const trash = await confirmDelete('Checkout');
    expect(document.activeElement).toBe(trash);

    act(() => storage.drop());
    const rows = document.querySelectorAll('.dc-library-item');
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('Orders');
    expect(document.activeElement).toBe(rows[0]);
  });
});
