import { canvasFromStarter } from '../src/gallery/canvas';
import { starterById, starterDocument } from './fixtures/starters-v1';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocument, createNode } from '../src/document/factory';
import type { DraftDocument } from '../src/document/types';
import { useEditorStore } from '../src/store/editorStore';
import { useUiStore } from '../src/store/uiStore';
import { useDocumentSession, type DocumentSession } from '../src/store/useDocumentSession';
import { __setRepository, QuotaExceededError, type DraftRepository } from '../src/storage';
import { setFileSaver } from '../src/export/download';
import { deserializeDocument } from '../src/export/project';
import { stashForReload } from '../src/storage/reloadStash';
import { encodeShareLink } from '../src/share/link';
import { docIdFromLocation } from '../src/lib/documentUrl';

/** A minimal, fully-stubbed `DraftRepository` — every method resolves with a
 *  harmless default; a test overrides only the method it needs to control or
 *  make fail. */
function stubRepository(overrides: Partial<DraftRepository> = {}): DraftRepository {
  return {
    kind: 'memory',
    durable: true,
    list: async () => [],
    load: async () => null,
    has: async () => false,
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
    pruneBackgroundImages: async () => {},
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

describe('protected shared diagram lifecycle', () => {
  afterEach(() => { window.history.replaceState(null, '', '/'); useUiStore.getState().setReadOnly(null); });

  it('reveals nothing before unlock, never saves the snapshot, and discards the decrypted diagram when locked', async () => {
    const source = { ...createDocument('Private architecture'), nodes: [createNode({ type: 'database', x: 0, y: 0, text: 'Private orders' })] };
    const encoded = await encodeShareLink(source, window.location.href, undefined, 'separate copper river phrase');
    if (!('url' in encoded)) throw new Error('Expected link');
    window.history.replaceState(null, '', encoded.url);
    useEditorStore.getState().setDocument(createDocument());
    const save = vi.fn(async () => {});
    const session = renderSession(stubRepository({ save }));
    await waitFor(() => expect(session().ready).toBe(true));
    expect(session().sharedLink?.locked).toBe(true);
    expect(session().openId).toBeNull();
    expect(useEditorStore.getState().document.nodes).toHaveLength(0);
    await act(async () => { expect(await session().sharedLink!.unlock('wrong phrase')).toMatch(/Incorrect passphrase/); });
    expect(session().sharedLink?.locked).toBe(true);
    await act(async () => { expect(await session().sharedLink!.unlock('separate copper river phrase')).toBeNull(); });
    expect(session().sharedLink?.locked).toBe(false);
    expect(useEditorStore.getState().document.nodes[0]?.text).toBe('Private orders');
    expect(useEditorStore.getState().mode).toBe('present');
    expect(useUiStore.getState().readOnly).not.toBeNull();
    expect(save).not.toHaveBeenCalled();
    act(() => session().sharedLink!.lock());
    expect(session().sharedLink?.locked).toBe(true);
    expect(session().openId).toBeNull();
    expect(useEditorStore.getState().document.nodes).toHaveLength(0);
    expect(useEditorStore.getState().history.past).toHaveLength(0);
    expect(window.location.hash).toMatch(/^#d=2\./);
    await act(async () => { await session().sharedLink!.unlock('separate copper river phrase'); });
    expect(useEditorStore.getState().document.nodes[0]?.text).toBe('Private orders');
    expect(save).not.toHaveBeenCalled();
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

  it('puts a new canvas made from a project view in that project', async () => {
    const saved: DraftDocument[] = [];
    const repository = stubRepository({
      listProjects: async () => [{ id: 'real-project', name: 'Real', createdAt: 0, updatedAt: 0 }],
      save: async (document) => {
        saved.push(document);
      },
    });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));
    await act(async () => {
      await session().newDocument(undefined, undefined, 'real-project');
    });
    expect(saved[0]!.metadata.projectId).toBe('real-project');
  });

  it('imports a file whose id already exists here as a new canvas, never over the local one', async () => {
    const local = createDocument('Local, newer');
    const saved: DraftDocument[] = [];
    const repository = stubRepository({
      has: async (id) => id === local.metadata.id,
      save: async (document) => {
        saved.push(document);
      },
    });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));

    const incoming = { ...local, metadata: { ...local.metadata, title: 'Old export' } };
    await act(async () => {
      await session().adoptDocument(incoming);
    });

    expect(saved).toHaveLength(1);
    expect(saved[0]!.metadata.id).not.toBe(local.metadata.id);
    // A copy beside its twin says so, rather than carrying the identical title.
    expect(saved[0]!.metadata.title).toBe('Old export copy');
    expect(useEditorStore.getState().document.metadata.id).toBe(saved[0]!.metadata.id);
  });
});

describe('useDocumentSession — overlapping opens', () => {
  // The address is the page's, not a test's: a canvas one test left open is in it, and the next test's
  // session would arrive at that address and try to open it beside whatever the test opens itself.
  afterEach(() => window.history.replaceState(null, '', '/'));

  it('a slow open that resolves after a later one does not replace it', async () => {
    const slow = createDocument('Slow A');
    const fast = createDocument('Fast B');
    let releaseSlow: () => void = () => {};
    const repository = stubRepository({
      load: async (id) => {
        if (id === slow.metadata.id) {
          await new Promise<void>((resolve) => (releaseSlow = resolve));
          return slow;
        }
        return id === fast.metadata.id ? fast : null;
      },
    });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));

    let openingSlow!: Promise<void>;
    await act(async () => {
      openingSlow = session().openDocument(slow.metadata.id);
      await session().openDocument(fast.metadata.id);
    });
    await act(async () => {
      releaseSlow();
      await openingSlow;
    });

    expect(useEditorStore.getState().document.metadata.id).toBe(fast.metadata.id);
    expect(session().openId).toBe(fast.metadata.id);
  });

  it('a slow open that resolves after going home does not bring its canvas up', async () => {
    // Back pressed twice quickly: the first asks for the previous diagram, the second for home.
    const current = createDocument('On screen');
    const slow = createDocument('Slow A');
    let releaseSlow: () => void = () => {};
    const repository = stubRepository({
      load: async (id) => {
        if (id === slow.metadata.id) {
          await new Promise<void>((resolve) => (releaseSlow = resolve));
          return slow;
        }
        return id === current.metadata.id ? current : null;
      },
    });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));
    await act(async () => {
      await session().openDocument(current.metadata.id);
    });

    let openingSlow!: Promise<void>;
    await act(async () => {
      openingSlow = session().openDocument(slow.metadata.id);
      // Let the open reach its read, so the close below is the later of the two.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(await session().closeDocument()).toBe(true);
    });
    expect(session().openId).toBeNull();
    await act(async () => {
      releaseSlow();
      await openingSlow;
    });

    expect(session().openId).toBeNull();
    expect(useEditorStore.getState().document.metadata.id).not.toBe(slow.metadata.id);
  });

  it('an open asked for while going home is still saving is the one that happens', async () => {
    // The other order: Home first, its last save still being written, then another diagram.
    const current = createDocument('On screen');
    const next = createDocument('Asked for next');
    let releaseSave: () => void = () => {};
    let holdSaves = false;
    const repository = stubRepository({
      load: async (id) => (id === current.metadata.id ? structuredClone(current) : id === next.metadata.id ? next : null),
      save: async () => {
        if (holdSaves) await new Promise<void>((resolve) => (releaseSave = resolve));
      },
    });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));
    await act(async () => {
      await session().openDocument(current.metadata.id);
    });
    // An unsaved edit, so going home has something to write first.
    act(() => useEditorStore.getState().rename('On screen, edited'));
    holdSaves = true;

    let closing!: Promise<boolean>;
    let opening!: Promise<void>;
    await act(async () => {
      closing = session().closeDocument();
      await new Promise((resolve) => setTimeout(resolve, 0));
      opening = session().openDocument(next.metadata.id);
      await new Promise((resolve) => setTimeout(resolve, 0));
      holdSaves = false;
      releaseSave();
      await closing;
      await opening;
    });

    expect(session().openId).toBe(next.metadata.id);
    expect(useEditorStore.getState().document.metadata.id).toBe(next.metadata.id);
  });

  /** A canvas open with an unsaved edit, and saves that wait until `release` is called. */
  async function openWithPendingSave(others: DraftDocument[] = []) {
    const current = createDocument('On screen');
    let releaseSave: () => void = () => {};
    let holdSaves = false;
    let held = 0;
    const repository = stubRepository({
      load: async (id) => (id === current.metadata.id ? structuredClone(current) : (others.find((doc) => doc.metadata.id === id) ?? null)),
      save: async () => {
        if (!holdSaves) return;
        held += 1;
        await new Promise<void>((resolve) => (releaseSave = resolve));
      },
    });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));
    await act(async () => {
      await session().openDocument(current.metadata.id);
    });
    act(() => useEditorStore.getState().rename('On screen, edited'));
    holdSaves = true;
    const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
    const release = () => {
      holdSaves = false;
      releaseSave();
    };
    /** Resolves once a save is really waiting: what makes "while it is still saving" true, not assumed. */
    const saving = () => waitFor(() => expect(held).toBeGreaterThan(0));
    return { current, session, tick, release, saving };
  }

  it('a new canvas asked for first does not take the place of a diagram asked for after it', async () => {
    // "Try an example" while the last save is still being written, then another diagram.
    const next = createDocument('Asked for next');
    const { session, tick, release, saving } = await openWithPendingSave([next]);

    await act(async () => {
      const replacing = session().replaceWithNew('example');
      await saving();
      const opening = session().openDocument(next.metadata.id);
      await tick();
      release();
      await replacing;
      await opening;
    });

    expect(session().openId).toBe(next.metadata.id);
    expect(useEditorStore.getState().document.metadata.id).toBe(next.metadata.id);
  });

  it('a new canvas takes the place of the one on screen when nothing newer is asked for', async () => {
    const { current, session, release, saving } = await openWithPendingSave();
    await act(async () => {
      const replacing = session().replaceWithNew();
      await saving();
      release();
      await replacing;
    });
    expect(session().openId).not.toBeNull();
    expect(session().openId).not.toBe(current.metadata.id);
  });

  it('a new canvas is still made when the address stepping back to Home is heard before the close has finished', async () => {
    // Closing a canvas steps the address back itself, which arrives as a `popstate` a moment later.
    // Here it arrives while the close is still re-reading the Library, before the new canvas is made.
    const current = createDocument('On screen');
    let releaseList: () => void = () => {};
    let holdList = false;
    const repository = stubRepository({
      load: async (id) => (id === current.metadata.id ? structuredClone(current) : null),
      list: async () => {
        if (holdList) await new Promise<void>((resolve) => (releaseList = resolve));
        return [];
      },
    });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));
    await act(async () => {
      await session().openDocument(current.metadata.id);
    });
    expect(docIdFromLocation()).toBe(current.metadata.id);

    let heard = 0;
    const onPopState = () => (heard += 1);
    window.addEventListener('popstate', onPopState);
    holdList = true;
    // Not inside one `act`: React must render the close for the address to follow it, as it does
    // in a browser, and an `act` that is still open holds that render back.
    let replacing!: Promise<void>;
    act(() => {
      replacing = session().replaceWithNew('example');
    });
    await waitFor(() => expect(heard).toBeGreaterThan(0));
    expect(docIdFromLocation()).toBeNull();
    expect(session().openId).toBeNull();
    await act(async () => {
      holdList = false;
      releaseList();
      await replacing;
    });
    window.removeEventListener('popstate', onPopState);

    expect(session().openId).not.toBeNull();
    expect(session().openId).not.toBe(current.metadata.id);
  });

  it('a diagram opened straight after going home opens, whenever the address stepping back is heard', async () => {
    const current = createDocument('On screen');
    const next = createDocument('Asked for next');
    let releaseNext: () => void = () => {};
    const repository = stubRepository({
      load: async (id) => {
        if (id === current.metadata.id) return structuredClone(current);
        if (id !== next.metadata.id) return null;
        await new Promise<void>((resolve) => (releaseNext = resolve));
        return next;
      },
    });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));
    await act(async () => {
      await session().openDocument(current.metadata.id);
    });

    let heard = 0;
    const onPopState = () => (heard += 1);
    window.addEventListener('popstate', onPopState);
    await act(async () => {
      expect(await session().closeDocument()).toBe(true);
    });
    let opening!: Promise<void>;
    act(() => {
      opening = session().openDocument(next.metadata.id);
    });
    // The address stepping back to Home is heard while the next diagram is still being read.
    await waitFor(() => expect(heard).toBeGreaterThan(0));
    await act(async () => {
      releaseNext();
      await opening;
    });
    window.removeEventListener('popstate', onPopState);

    expect(session().openId).toBe(next.metadata.id);
  });

  it('going home from a diagram opened over another leaves the address naming no diagram', async () => {
    const first = createDocument('Opened first');
    const second = createDocument('Opened over it');
    const repository = stubRepository({
      load: async (id) => (id === first.metadata.id ? structuredClone(first) : id === second.metadata.id ? structuredClone(second) : null),
    });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));
    await act(async () => {
      await session().openDocument(first.metadata.id);
    });
    await act(async () => {
      await session().openDocument(second.metadata.id);
    });
    expect(docIdFromLocation()).toBe(second.metadata.id);

    let heard = 0;
    const onPopState = () => (heard += 1);
    window.addEventListener('popstate', onPopState);
    await act(async () => {
      expect(await session().closeDocument()).toBe(true);
    });
    await waitFor(() => expect(heard).toBeGreaterThan(0));
    window.removeEventListener('popstate', onPopState);

    // The step back landed on the first diagram's entry. Home is showing, so a reload must not reopen it.
    expect(session().openId).toBeNull();
    expect(docIdFromLocation()).toBeNull();
  });

  it('Back then Forward while the last save is still being written leaves the canvas open', async () => {
    const { current, session, release, saving } = await openWithPendingSave();
    expect(docIdFromLocation()).toBe(current.metadata.id);
    const loads = vi.spyOn(session().repository!, 'load');

    // Back, as the browser does it: the address names no diagram, so the canvas starts to close,
    // and waits on its save.
    act(() => window.history.back());
    await saving();
    expect(docIdFromLocation()).toBeNull();
    expect(session().openId).toBe(current.metadata.id);
    // Forward: the address names the diagram on screen again.
    act(() => window.history.forward());
    await waitFor(() => expect(docIdFromLocation()).toBe(current.metadata.id));
    await act(async () => {
      release();
      await settled();
    });

    expect(session().openId).toBe(current.metadata.id);
    expect(docIdFromLocation()).toBe(current.metadata.id);
    // Still open because the close stood down, not because it closed and the diagram was read again.
    expect(loads).not.toHaveBeenCalled();
  });

  /** Long enough for a step through the history, which the browser makes in a later task, to be heard. */
  const settled = () => new Promise((resolve) => setTimeout(resolve, 60));

  /** Two stored diagrams, the first open, with nothing held back: every read and write answers at once. */
  async function openFirstOfTwo() {
    const first = createDocument('First');
    const second = createDocument('Second');
    const session = renderSession(
      stubRepository({ load: async (id) => (id === first.metadata.id ? structuredClone(first) : id === second.metadata.id ? structuredClone(second) : null) }),
    );
    await waitFor(() => expect(session().ready).toBe(true));
    await act(async () => {
      await session().openDocument(first.metadata.id);
    });
    await act(settled);
    expect(docIdFromLocation()).toBe(first.metadata.id);
    return { first, second, session };
  }

  // Closing a canvas steps the address back, and the browser makes that step a task later. With a
  // repository that answers at once, the next thing asked for is on screen before the step is heard.
  describe('what is asked for straight after going home, before the address has stepped back', () => {
    it('another diagram opens and stays open, and the address names it', async () => {
      const { second, session } = await openFirstOfTwo();
      await act(async () => {
        await session().closeDocument();
      });
      act(() => void session().openDocument(second.metadata.id));
      await act(settled);
      await act(settled);
      expect(session().openId).toBe(second.metadata.id);
      expect(docIdFromLocation()).toBe(second.metadata.id);
    });

    it('the same diagram reopens and stays open, and the address names it', async () => {
      const { first, session } = await openFirstOfTwo();
      await act(async () => {
        await session().closeDocument();
      });
      act(() => void session().openDocument(first.metadata.id));
      await act(settled);
      await act(settled);
      expect(session().openId).toBe(first.metadata.id);
      expect(docIdFromLocation()).toBe(first.metadata.id);
    });

    it('a new canvas takes the place of the one on screen, and the address names it', async () => {
      const { first, session } = await openFirstOfTwo();
      await act(async () => {
        await session().replaceWithNew();
      });
      await act(settled);
      await act(settled);
      expect(session().openId).not.toBeNull();
      expect(session().openId).not.toBe(first.metadata.id);
      expect(docIdFromLocation()).toBe(session().openId);
    });

    it('going home and nothing else leaves Home showing, and Back from there is still the person’s', async () => {
      const { first, session } = await openFirstOfTwo();
      await act(async () => {
        await session().closeDocument();
      });
      await act(settled);
      expect(session().openId).toBeNull();
      expect(docIdFromLocation()).toBeNull();
      // Forward is theirs: it reopens the diagram, as it always has.
      act(() => window.history.forward());
      await act(settled);
      await act(settled);
      expect(session().openId).toBe(first.metadata.id);
    });
  });

  it('a new canvas asked for while a diagram is still being read is the one that arrives', async () => {
    const slow = createDocument('Slow');
    let releaseSlow: () => void = () => {};
    const session = renderSession(
      stubRepository({
        load: async (id) => {
          if (id !== slow.metadata.id) return null;
          await new Promise<void>((resolve) => (releaseSlow = resolve));
          return slow;
        },
      }),
    );
    await waitFor(() => expect(session().ready).toBe(true));
    await act(async () => {
      const opening = session().openDocument(slow.metadata.id);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await session().replaceWithNew();
      releaseSlow();
      await opening;
    });
    await act(settled);
    expect(session().openId).not.toBeNull();
    expect(session().openId).not.toBe(slow.metadata.id);
  });

  it('keeps a reload stash over a rename made elsewhere, and opens it unsaved when writing it fails', async () => {
    const original = createDocument('Draft');
    const edited: DraftDocument = { ...original, metadata: { ...original.metadata, title: 'Draft edited', updatedAt: 1_000 } };
    // Another tab renamed it since: a later `updatedAt`, the same content stamp.
    const stored: DraftDocument = { ...original, metadata: { ...original.metadata, title: 'Renamed', updatedAt: 2_000 } };
    const saves: string[] = [];
    let failNext = true;
    const repository = stubRepository({
      load: async () => structuredClone(stored),
      knownContentStamp: () => 's_same',
      save: async (document) => {
        saves.push(document.metadata.title);
        if (failNext) {
          failNext = false;
          throw new Error('transient');
        }
      },
    });
    stashForReload(edited, { base: { title: 'Draft' }, stamp: 's_same' });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));

    await act(async () => {
      await session().openDocument(edited.metadata.id);
    });
    // The stash is on screen, not "could not be read", and still there for a refresh.
    expect(errorToastShown()).toBe(false);
    expect(useEditorStore.getState().document.metadata.title).toBe('Draft edited');
    expect(window.sessionStorage.getItem(`draft-canvas:reload:${edited.metadata.id}`)).not.toBeNull();
    // Autosave retries the write it owes.
    await waitFor(() => expect(saves).toHaveLength(2), { timeout: 3000 });
    window.sessionStorage.clear();
  });

  it("raises the cross-tab conflict for a stash made over content another tab replaced, even one newer by the clock", async () => {
    const original = createDocument('Draft');
    // This tab's edits, stashed over `s_mine` — later by the clock than the other tab's save.
    const at = original.metadata.createdAt;
    const edited: DraftDocument = { ...original, metadata: { ...original.metadata, title: 'Mine', updatedAt: at + 3_000 } };
    const stored: DraftDocument = { ...original, metadata: { ...original.metadata, title: 'Theirs', updatedAt: at + 2_000 } };
    const save = vi.fn(async () => {});
    const repository = stubRepository({
      load: async () => structuredClone(stored),
      has: async () => true,
      knownContentStamp: () => 's_theirs',
      save,
    });
    stashForReload(edited, { base: { title: 'Draft' }, stamp: 's_mine', writing: 's_mine_inflight' });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));

    await act(async () => {
      await session().openDocument(edited.metadata.id);
    });
    // Nothing written over the other tab's content; this tab's edits are on screen, held for a choice.
    expect(save).not.toHaveBeenCalled();
    expect(useEditorStore.getState().document.metadata.title).toBe('Mine');
    expect(useEditorStore.getState().save.conflict).toBe('changed');
    expect(errorToastShown()).toBe(true);

    // Taking the other tab's copy opens it, and the stash doesn't bring the edits back.
    await act(async () => {
      await session().resolveConflict('discard');
    });
    expect(useEditorStore.getState().document.metadata.title).toBe('Theirs');
    expect(useEditorStore.getState().save.conflict).toBeUndefined();
    expect(save).not.toHaveBeenCalled();
    expect(window.sessionStorage.getItem(`draft-canvas:reload:${edited.metadata.id}`)).toBeNull();
  });

  it('applies a stash whose own interrupted write landed after all', async () => {
    const original = createDocument('Draft');
    // Older by the clock than what's stored — which is this very write, stamped as it started.
    const at = original.metadata.createdAt;
    const edited: DraftDocument = { ...original, metadata: { ...original.metadata, title: 'Mine', updatedAt: at + 1_000 } };
    const stored: DraftDocument = { ...original, metadata: { ...original.metadata, title: 'Draft', updatedAt: at + 2_000 } };
    const saved: string[] = [];
    const repository = stubRepository({
      load: async () => structuredClone(stored),
      knownContentStamp: () => 's_mine_inflight',
      save: async (document) => {
        saved.push(document.metadata.title);
      },
    });
    stashForReload(edited, { base: { title: 'Draft' }, stamp: 's_mine', writing: 's_mine_inflight' });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));

    await act(async () => {
      await session().openDocument(edited.metadata.id);
    });
    expect(saved[0]).toBe('Mine');
    expect(useEditorStore.getState().document.metadata.title).toBe('Mine');
    expect(useEditorStore.getState().save.conflict).toBeUndefined();
  });

  /**
   * Stepping into or out of a shape is navigation, not an edit. Saving for it would rewrite the
   * file's content stamp — which is how another tab is told the file changed underneath it — so
   * merely looking around would start reporting conflicts with yourself.
   */
  it('saves what is inside a shape, and never saves for merely stepping into one', async () => {
    const saved: DraftDocument[] = [];
    const repository = stubRepository({
      save: async (document) => {
        saved.push(structuredClone(document));
      },
    });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));
    await act(async () => {
      await session().newDocument('Lending');
    });
    const store = useEditorStore.getState();
    const platform = store.addNode({ type: 'service', x: 0, y: 0, text: 'Lending Platform' });
    await waitFor(() => expect(saved.length).toBeGreaterThan(0));

    const before = saved.length;
    act(() => {
      useEditorStore.getState().enterInside(platform.id);
    });
    // A moment of real time, so a debounced save would have landed if one had been scheduled.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 60));
    });
    expect(saved).toHaveLength(before);

    act(() => {
      useEditorStore.getState().addNode({ type: 'service', x: 20, y: 20, text: 'Lending API' });
    });
    await waitFor(() => expect(saved.length).toBeGreaterThan(before));
    // What is written is the whole file, from wherever in it the editor happens to be standing.
    const last = saved.at(-1)!;
    expect(last.nodes).toHaveLength(1);
    expect(last.nodes[0]!.inside?.nodes[0]?.text).toBe('Lending API');
  });

  /**
   * An undo of something done in another room both writes and moves you. Telling navigation from
   * an edit by watching which room you are in answered "navigation" for this, so the undo showed
   * on screen and was never written: reload, and the change it took back was still there.
   */
  it('saves an undo of a change made in another room, from wherever you are standing', async () => {
    const saved: DraftDocument[] = [];
    const repository = stubRepository({
      save: async (document) => {
        saved.push(structuredClone(document));
      },
    });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));
    await act(async () => {
      await session().newDocument('Lending');
    });
    const platform = useEditorStore.getState().addNode({ type: 'service', x: 0, y: 0, text: 'Lending Platform' });
    await waitFor(() => expect(saved.length).toBeGreaterThan(0));

    act(() => {
      useEditorStore.getState().enterInside(platform.id);
      useEditorStore.getState().addNode({ type: 'service', x: 20, y: 20, text: 'Lending API' });
    });
    await waitFor(() => expect(saved.at(-1)!.nodes[0]!.inside?.nodes).toHaveLength(1));

    act(() => {
      useEditorStore.getState().exitTo(0);
    });
    const beforeUndo = saved.length;
    act(() => {
      useEditorStore.getState().undo();
    });
    // The undo took the room's only shape away, so the room goes with it — and that has to reach
    // disk, not just the screen.
    await waitFor(() => expect(saved.length).toBeGreaterThan(beforeUndo));
    expect(saved.at(-1)!.nodes[0]!.inside).toBeUndefined();
  });

  it('a double-activated New canvas creates one canvas', async () => {
    const saved: DraftDocument[] = [];
    const repository = stubRepository({
      save: async (document) => {
        saved.push(document);
      },
    });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));

    await act(async () => {
      await Promise.all([session().newDocument(), session().newDocument()]);
    });

    expect(saved).toHaveLength(1);
  });
});

describe('useDocumentSession — repository failures surface a toast, not an unhandled rejection', () => {
  it('adoptDocument says local storage failed, whatever the repository threw', async () => {
    const repository = stubRepository({
      save: async () => {
        throw new TypeError('simulated storage failure');
      },
    });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));

    await act(async () => {
      await session().adoptDocument(createDocument('Blank'));
    });
    const messages = useUiStore.getState().toasts.map((toast) => toast.message);
    expect(messages).toContainEqual(expect.stringMatching(/^Couldn’t save that diagram\. This browser’s storage didn’t accept it/));
  });

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

  it('duplicateDocument that fails copying the background leaves no half-made copy behind', async () => {
    const source = createDocument('Original');
    source.settings = { ...source.settings, background: { ...source.settings.background, enabled: true, imageId: 'bg_1' } };
    const saved: string[] = [];
    const removed: string[] = [];
    const repository = stubRepository({
      load: async () => source,
      save: async (document) => void saved.push(document.metadata.id),
      remove: async (id) => void removed.push(id),
      loadBackgroundImage: async () => ({ blob: new Blob(['x']), width: 10, height: 10 }),
      saveBackgroundImage: async () => {
        throw new Error('quota');
      },
    });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));

    await act(async () => {
      await session().duplicateDocument(source.metadata.id);
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]).not.toBe(source.metadata.id);
    expect(removed).toEqual(saved);
    expect(errorToastShown()).toBe(true);
  });

  it('a duplicate or import that was saved is not reported as failed when only the list re-read fails', async () => {
    let lists = 0;
    const repository = stubRepository({
      list: async () => {
        lists += 1;
        if (lists > 1) throw new Error('list failed');
        return [];
      },
      load: async () => createDocument('Original'),
    });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));

    await act(async () => {
      await session().duplicateDocument('id1');
      await session().adoptDocument(createDocument('Imported'));
    });
    expect(lists).toBeGreaterThan(1);
    expect(errorToastShown()).toBe(false);
    expect(useEditorStore.getState().document.metadata.title).toBe('Imported');
  });

  it('duplicateDocument of a canvas that cannot be read says so instead of doing nothing', async () => {
    const session = renderSession(stubRepository({ load: async () => null }));
    await waitFor(() => expect(session().ready).toBe(true));

    await act(async () => {
      await session().duplicateDocument('unreadable');
    });
    expect(useUiStore.getState().toasts.at(-1)?.message).toMatch(/Couldn’t duplicate/);
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
  it('opens a canvas already holding a starter, with nothing to undo', async () => {
    const saved: DraftDocument[] = [];
    const repository = stubRepository({
      save: async (document) => {
        saved.push(document);
      },
    });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));
    const starter = canvasFromStarter({ id: 'microservices', name: 'Microservices', sha256: 'a'.repeat(64) }, starterDocument(starterById('microservices')!));

    await act(async () => {
      await session().newDocument(undefined, starter);
    });

    const doc = saved[0]!;
    expect(doc.metadata.title).toBe('Microservices');
    expect(doc.metadata.origin).toEqual({ starter: 'microservices', sha256: 'a'.repeat(64) });
    expect(doc.nodes).toHaveLength(14);
    expect(doc.edges).toHaveLength(8);
    expect(doc.viewport.zoom).toBeGreaterThanOrEqual(0.1);
    expect(doc.viewport.zoom).toBeLessThanOrEqual(1);
    expect(useEditorStore.getState().document.nodes).toHaveLength(14);
    expect(useEditorStore.getState().canUndo()).toBe(false);
    expect(session().openId).toBe(doc.metadata.id);
  });

  it('opens the bundled example, offline, and marks it as the example', async () => {
    const saved: DraftDocument[] = [];
    const repository = stubRepository({
      save: async (document) => {
        saved.push(document);
      },
    });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));

    await act(async () => {
      await session().newDocument(undefined, 'example');
      await session().newDocument();
    });

    expect(saved[0]!.metadata.title).toBe('Order processing');
    expect(saved[0]!.nodes).toHaveLength(4);
    expect(saved[0]!.flows).toHaveLength(1);
    expect(useUiStore.getState().exampleDocumentId).toBe(saved[0]!.metadata.id);
    expect(saved[1]!.metadata.title).toBe('Untitled diagram');
    expect(saved[1]!.nodes).toHaveLength(0);
  });
});

describe('useDocumentSession — opening viewport fit request', () => {
  beforeEach(() => {
    useUiStore.setState({ openFitDocumentId: null });
  });

  it('asks Canvas to fit the view when opening an existing document', async () => {
    const doc = createDocument('Existing');
    const repository = stubRepository({ load: async (id) => (id === doc.metadata.id ? doc : null) });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));

    await act(async () => {
      await session().openDocument(doc.metadata.id);
    });

    expect(useUiStore.getState().openFitDocumentId).toBe(doc.metadata.id);
  });

  it('asks for a fit when adopting an imported document, but not a freshly created one', async () => {
    const imported = createDocument('Imported');
    const repository = stubRepository({ save: async () => {} });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));

    await act(async () => {
      await session().adoptDocument(imported);
    });
    expect(useUiStore.getState().openFitDocumentId).toBe(imported.metadata.id);

    useUiStore.setState({ openFitDocumentId: null });
    await act(async () => {
      await session().newDocument(undefined, 'example');
    });
    expect(useUiStore.getState().openFitDocumentId).toBeNull();
  });

  it('does not re-ask, and clears a still-unresolved request, when reopening the canvas already on screen', async () => {
    const doc = createDocument('Existing');
    const repository = stubRepository({ load: async (id) => (id === doc.metadata.id ? doc : null) });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));

    await act(async () => {
      await session().openDocument(doc.metadata.id);
    });
    expect(useUiStore.getState().openFitDocumentId).toBe(doc.metadata.id);

    // Canvas hasn't consumed it yet (say, still mid-load) when the same file is opened again —
    // taking another tab's copy, or a host reloading it after an outside edit.
    await act(async () => {
      await session().openDocument(doc.metadata.id);
    });
    expect(useUiStore.getState().openFitDocumentId).toBeNull();
  });
});

describe('useDocumentSession — closing prunes background images', () => {
  /** Just enough of the Web Locks API: shared holds counted per name, `ifAvailable` probes. */
  function fakeLocks() {
    const held = new Map<string, number>();
    return {
      async request(name: string, options: LockOptions, callback: (lock: { name: string } | null) => unknown) {
        if (options.ifAvailable) return callback(held.get(name) ? null : { name });
        held.set(name, (held.get(name) ?? 0) + 1);
        try {
          return await callback({ name });
        } finally {
          held.set(name, held.get(name)! - 1);
        }
      },
    };
  }

  afterEach(() => {
    Reflect.deleteProperty(navigator, 'locks');
  });

  it('leaves them alone while another tab has the canvas open, and prunes once none does', async () => {
    Object.defineProperty(navigator, 'locks', { value: fakeLocks(), configurable: true });
    const { holdOpen } = await import('../src/storage/openPresence');
    const doc = createDocument('Backdrop');
    const pruned: string[] = [];
    const repository = stubRepository({
      load: async () => doc,
      pruneBackgroundImages: async (id) => void pruned.push(id),
    });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));
    const elsewhere = holdOpen(doc.metadata.id);

    const openAndClose = async () => {
      await act(async () => {
        await session().openDocument(doc.metadata.id);
      });
      await act(async () => {
        await session().closeDocument();
      });
    };
    await openAndClose();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(pruned).toEqual([]);

    await elsewhere();
    await openAndClose();
    await waitFor(() => expect(pruned).toEqual([doc.metadata.id]));
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

describe('useDocumentSession — a save that failed is not a dead end', () => {
  const unsaved = createDocument('Unsaved');

  /** An open diagram whose store refuses every write, with one edit that could not be kept. */
  async function openWithFailingSave(failure: unknown = new QuotaExceededError()) {
    let failing = true;
    const saves: string[] = [];
    const repository = stubRepository({
      load: async () => structuredClone(unsaved),
      has: async () => true,
      save: async (document) => {
        if (failing) throw failure;
        saves.push(document.metadata.title);
      },
    });
    const session = renderSession(repository);
    await waitFor(() => expect(session().ready).toBe(true));
    await act(async () => {
      await session().openDocument(unsaved.metadata.id);
    });
    await act(async () => {
      useEditorStore.getState().addNode({ type: 'note', x: 10, y: 10, text: 'Not stored yet' });
    });
    await waitFor(() => expect(useEditorStore.getState().save.status).toBe('error'), { timeout: 4000 });
    return { session, saves, heal: () => (failing = false) };
  }

  afterEach(() => {
    setFileSaver(null);
    window.sessionStorage.clear();
  });

  it('says why: a full browser is told to export, then free space from the Library', async () => {
    await openWithFailingSave();
    const save = useEditorStore.getState().save;
    expect(save.failure).toBe('full');
    expect(save.message).toMatch(/out of storage space/);
    expect(save.message).toMatch(/Export it, then free space by deleting diagrams in the Library/);
  });

  it('retries on request, and clears the error once the write lands', async () => {
    const { session, saves, heal } = await openWithFailingSave();
    await act(async () => {
      expect(await session().retrySave()).toBe(false);
    });
    expect(useUiStore.getState().toasts.at(-1)?.message).toMatch(/Still couldn’t save/);
    heal();
    await act(async () => {
      expect(await session().retrySave()).toBe(true);
    });
    expect(saves).toHaveLength(1);
    expect(useEditorStore.getState().save.status).toMatch(/saved|idle/);
    expect(useEditorStore.getState().save.failure).toBeUndefined();
  });

  it('exports the diagram on screen, edits that never reached storage included', async () => {
    const { session } = await openWithFailingSave();
    const exported: Array<{ blob: Blob; name: string }> = [];
    setFileSaver(async (blob, name) => {
      exported.push({ blob, name });
    });
    await act(async () => {
      await session().exportUnsaved();
    });
    expect(exported).toHaveLength(1);
    expect(exported[0]!.name).toBe('unsaved.draftcanvas');
    const parsed = deserializeDocument(await exported[0]!.blob.text());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.document.nodes.map((node) => node.text)).toContain('Not stored yet');
    expect(useUiStore.getState().toasts.at(-1)?.message).toBe('Exported a copy of this diagram.');
  });

  it('says so when the copy could not be made, and says nothing when the Save dialog is dismissed', async () => {
    const { session } = await openWithFailingSave();
    setFileSaver(async () => {
      throw new DOMException('dismissed', 'AbortError');
    });
    useUiStore.setState({ toasts: [] });
    await act(async () => {
      await session().exportUnsaved();
    });
    expect(useUiStore.getState().toasts).toEqual([]);
    setFileSaver(async () => {
      throw new Error('disk full');
    });
    await act(async () => {
      await session().exportUnsaved();
    });
    expect(useUiStore.getState().toasts.at(-1)?.message).toMatch(/Couldn’t export a copy/);
  });

  it('refuses to close with unsaved changes, pointing at the status bar — and leaves when asked to give them up', async () => {
    const { session } = await openWithFailingSave();
    await act(async () => {
      expect(await session().closeDocument()).toBe(false);
    });
    expect(useUiStore.getState().toasts.at(-1)?.message).toMatch(/Use the status bar to retry, export a copy, or leave without saving/);
    expect(session().openId).toBe(unsaved.metadata.id);

    stashForReload(useEditorStore.getState().document, { base: { title: 'Unsaved' } });
    await act(async () => {
      await session().leaveWithoutSaving();
    });
    expect(session().openId).toBeNull();
    expect(useEditorStore.getState().save.status).toBe('idle');
    expect(window.sessionStorage.getItem(`draft-canvas:reload:${unsaved.metadata.id}`)).toBeNull();
  });
});

describe('useDocumentSession — a diagram that cannot be opened says why', () => {
  it('names a newer Draft Canvas, and that the diagram is kept', async () => {
    const session = renderSession(stubRepository({ load: async () => null, takeLoadFailure: () => 'newer' }));
    await waitFor(() => expect(session().ready).toBe(true));
    await act(async () => {
      await session().openDocument('from-the-future');
    });
    const message = useUiStore.getState().toasts.at(-1)?.message ?? '';
    expect(message).toMatch(/newer version of Draft Canvas/);
    expect(message).toMatch(/kept untouched/);
    expect(message).toMatch(/update Draft Canvas/i);
    // The same refusal twice is one toast, not a stack.
    await act(async () => {
      await session().openDocument('from-the-future');
    });
    expect(useUiStore.getState().toasts.filter((toast) => toast.message === message)).toHaveLength(1);
  });

  it('keeps the plain message for a diagram that is simply damaged', async () => {
    const session = renderSession(stubRepository({ load: async () => null }));
    await waitFor(() => expect(session().ready).toBe(true));
    await act(async () => {
      await session().openDocument('damaged');
    });
    expect(useUiStore.getState().toasts.at(-1)?.message).toBe('Couldn’t read that diagram from this browser’s storage.');
  });
});
