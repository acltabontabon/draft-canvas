import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDocument } from '../src/document/factory';
import type { DraftDocument } from '../src/document/types';
import { useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';
import { useDocumentSession, type DocumentSession } from '../src/store/useDocumentSession';
import { __setRepository, type DraftRepository } from '../src/storage';

/** A minimal, fully-stubbed `DraftRepository` — every method resolves with a
 *  harmless default; a test overrides only the method it needs to control or
 *  make fail. */
function stubRepository(overrides: Partial<DraftRepository> = {}): DraftRepository {
  return {
    kind: 'memory',
    durable: true,
    list: async () => [],
    load: async () => null,
    save: async () => {},
    remove: async () => {},
    rename: async () => {},
    usage: async () => null,
    listProjects: async () => [],
    saveProject: async () => {},
    deleteProject: async () => {},
    moveDocumentToProject: async () => {},
    saveBackgroundImage: async () => {},
    loadBackgroundImage: async () => null,
    removeBackgroundImage: async () => {},
    ...overrides,
  };
}

function Probe({ onReady }: { onReady: (session: DocumentSession) => void }) {
  const session = useDocumentSession();
  onReady(session);
  return null;
}

/** Mounts the hook via `__setRepository`'s test seam (see `src/storage/index.ts`)
 *  and returns a getter for its latest returned value, mirroring the
 *  `Probe`/`onReady` pattern `tests/personality-preference.test.tsx` uses for
 *  a plain-function hook. */
function renderSession(repository: DraftRepository) {
  __setRepository(repository);
  let latest!: DocumentSession;
  render(<Probe onReady={(session) => (latest = session)} />);
  return () => latest;
}

function errorToastShown(): boolean {
  return useUiStore.getState().toasts.some((toast) => toast.tone === 'error');
}

beforeEach(() => {
  useUiStore.setState({ toasts: [] });
});

afterEach(() => {
  __setRepository(null);
});

describe('useDocumentSession — startup failure', () => {
  it('still reaches ready, and surfaces a toast, when list()/listProjects() reject', async () => {
    const repository = stubRepository({
      list: async () => {
        throw new Error('boom');
      },
    });
    const session = renderSession(repository);

    await waitFor(() => expect(session().ready).toBe(true));
    expect(errorToastShown()).toBe(true);
  });

  it('reaches ready normally when nothing fails', async () => {
    const session = renderSession(stubRepository());
    await waitFor(() => expect(session().ready).toBe(true));
    expect(errorToastShown()).toBe(false);
  });
});

describe('useDocumentSession — adoptDocument stale projectId repair', () => {
  it('clears a projectId that does not resolve against the known projects', async () => {
    const saved: DraftDocument[] = [];
    const repository = stubRepository({
      listProjects: async () => [{ id: 'real-project', name: 'Real', createdAt: 0, updatedAt: 0 }],
      save: async (document) => {
        saved.push(document);
      },
    });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));

    const base = createDocument('Imported');
    const incoming = { ...base, metadata: { ...base.metadata, projectId: 'ghost-project' } };
    await act(async () => {
      await session().adoptDocument(incoming);
    });

    expect(saved[0]!.metadata.projectId).toBeUndefined();
    expect(useEditorStore.getState().document.metadata.projectId).toBeUndefined();
  });

  it('keeps a projectId that does resolve against the known projects', async () => {
    const saved: DraftDocument[] = [];
    const repository = stubRepository({
      listProjects: async () => [{ id: 'real-project', name: 'Real', createdAt: 0, updatedAt: 0 }],
      save: async (document) => {
        saved.push(document);
      },
    });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));

    const base = createDocument('Imported');
    const incoming = { ...base, metadata: { ...base.metadata, projectId: 'real-project' } };
    await act(async () => {
      await session().adoptDocument(incoming);
    });

    expect(saved[0]!.metadata.projectId).toBe('real-project');
  });
});

describe('useDocumentSession — repository failures surface a toast, not an unhandled rejection', () => {
  it('renameDocument', async () => {
    const repository = stubRepository({
      rename: async () => {
        throw new Error('boom');
      },
    });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));

    await act(async () => {
      await expect(session().renameDocument('id1', 'New title')).resolves.toBeUndefined();
    });
    expect(errorToastShown()).toBe(true);
  });

  it('duplicateDocument', async () => {
    const repository = stubRepository({
      load: async () => createDocument('Original'),
      save: async () => {
        throw new Error('boom');
      },
    });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));

    await act(async () => {
      await expect(session().duplicateDocument('id1')).resolves.toBeUndefined();
    });
    expect(errorToastShown()).toBe(true);
  });

  it('deleteDocument', async () => {
    const repository = stubRepository({
      remove: async () => {
        throw new Error('boom');
      },
    });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));

    await act(async () => {
      await expect(session().deleteDocument('id1')).resolves.toBeUndefined();
    });
    expect(errorToastShown()).toBe(true);
  });

  it('moveDocumentToProject', async () => {
    const repository = stubRepository({
      moveDocumentToProject: async () => {
        throw new Error('boom');
      },
    });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));

    await act(async () => {
      await expect(session().moveDocumentToProject('id1', 'p1')).resolves.toBeUndefined();
    });
    expect(errorToastShown()).toBe(true);
  });
});
