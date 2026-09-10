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

describe('useDocumentSession — newDocument', () => {
  it('seeds a canvas from an Architecture Starter, titled after it, with nothing to undo', async () => {
    const saved: DraftDocument[] = [];
    const repository = stubRepository({
      save: async (document) => {
        saved.push(document);
      },
    });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));

    await act(async () => {
      await session().newDocument(undefined, 'microservices');
    });

    const doc = saved[0]!;
    expect(doc.metadata.title).toBe('Microservices');
    expect(doc.nodes).toHaveLength(12);
    expect(doc.edges).toHaveLength(9);
    expect(doc.viewport.zoom).toBeGreaterThanOrEqual(0.1);
    expect(doc.viewport.zoom).toBeLessThanOrEqual(1);
    expect(useEditorStore.getState().document.nodes).toHaveLength(12);
    expect(useEditorStore.getState().canUndo()).toBe(false);
    expect(session().openId).toBe(doc.metadata.id);
  });

  it('keeps an explicit title, and an unknown starter id just means a blank canvas', async () => {
    const saved: DraftDocument[] = [];
    const repository = stubRepository({
      save: async (document) => {
        saved.push(document);
      },
    });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));

    await act(async () => {
      await session().newDocument('Checkout', 'monolith');
      await session().newDocument(undefined, 'not-a-starter' as never);
      await session().newDocument();
    });

    expect(saved[0]!.metadata.title).toBe('Checkout');
    expect(saved[0]!.nodes.length).toBeGreaterThan(0);
    expect(saved[1]!.metadata.title).toBe('Untitled canvas');
    expect(saved[1]!.nodes).toHaveLength(0);
    expect(saved[2]!.nodes).toHaveLength(0);
  });
});

describe('useDocumentSession — refresh on return', () => {
  it('re-reads the library when the tab becomes visible, but only while no canvas is open', async () => {
    let lists = 0;
    const repository = stubRepository({
      list: async () => {
        lists += 1;
        return [];
      },
    });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });

    const before = lists;
    await act(async () => {
      window.dispatchEvent(new Event('visibilitychange'));
    });
    await waitFor(() => expect(lists).toBe(before + 1));

    await act(async () => {
      await session().newDocument();
    });
    const whileOpen = lists;
    await act(async () => {
      window.dispatchEvent(new Event('visibilitychange'));
    });
    expect(lists).toBe(whileOpen);
  });
});
