import { useCallback, useEffect, useRef, useState } from 'react';
import { canEncryptLocally } from '../crypto/availability';
import { cloneDocumentAsNew, createDocument } from '../document/factory';
import { freeOriginFor, openingViewportFor } from '../document/geometry';
import { createId } from '../document/ids';
import type { DraftDocument, DraftSummary, Project } from '../document/types';
import { embeddedHost } from '../host/embeddedHost';
import { logDiagnostic } from '../lib/diagnostics';
import type { StarterId } from '../starters';
import { loadStarters } from '../starters/load';
import { Autosave } from '../storage/autosave';
import { getRepository, type DraftRepository } from '../storage';
import { IndexedDbRepository, onStorageSuperseded } from '../storage/IndexedDbRepository';
import { useUiStore } from './uiStore';

type EditorStoreModule = typeof import('./editorStore');

/**
 * The editor store — with the node renderer, routing, and starter builder it pulls in — is most of
 * the editor's code, and the Library never touches it. Loaded the first time a canvas opens (the
 * editor chunk warms it in the background anyway), then kept.
 */
let editorStoreModule: EditorStoreModule | null = null;
async function loadEditorStore(): Promise<EditorStoreModule> {
  editorStoreModule ??= await import('./editorStore');
  return editorStoreModule;
}

export interface DocumentSession {
  ready: boolean;
  repository: DraftRepository | null;
  /** False when the browser refused persistent storage; the UI says so plainly. */
  durable: boolean;
  library: DraftSummary[];
  refreshLibrary: () => Promise<void>;
  openDocument: (id: string) => Promise<void>;
  /** A blank canvas, or — given a `starterId` — one already holding that
   *  Architecture Starter, titled after it unless `title` says otherwise. */
  newDocument: (title?: string, starterId?: StarterId) => Promise<void>;
  adoptDocument: (document: DraftDocument) => Promise<void>;
  closeDocument: () => Promise<void>;
  /**
   * After another tab deleted or changed the open canvas: `keep` saves this tab's copy over it;
   * `discard` reloads the stored copy, or closes the canvas when it was deleted.
   */
  resolveConflict: (choice: 'keep' | 'discard') => Promise<void>;
  renameDocument: (id: string, title: string) => Promise<void>;
  duplicateDocument: (id: string) => Promise<void>;
  deleteDocument: (id: string) => Promise<void>;
  openId: string | null;
  /** Optional, flat canvas grouping — see `document/types.ts`'s `Project`. */
  projects: Project[];
  refreshProjects: () => Promise<void>;
  createProject: (name: string) => Promise<Project | undefined>;
  renameProject: (id: string, name: string) => Promise<void>;
  /** Removes the project; its canvases move to Unorganized, never deleted. */
  deleteProject: (id: string) => Promise<void>;
  moveDocumentToProject: (id: string, projectId: string | undefined) => Promise<void>;
}

/**
 * Owns the lifecycle of the locally stored document library and keeps the open
 * document saved.
 *
 * Every path here is local. There is no fetch, no sync, and no id that means
 * anything to anyone but this browser.
 */
export function useDocumentSession(): DocumentSession {
  const [repository, setRepository] = useState<DraftRepository | null>(null);
  const [library, setLibrary] = useState<DraftSummary[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const autosave = useRef<Autosave | null>(null);
  /** Bumped by every open/create: an earlier one still loading when a later one started must not
   *  land on top of it (a slow decrypt resolving after the user already opened something else). */
  const navigation = useRef(0);
  /** A New canvas already on its way — a double-click must not make two. */
  const creating = useRef(false);
  const notify = useUiStore((state) => state.notify);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const repo = await getRepository();
      if (cancelled) return;
      setRepository(repo);
      try {
        setLibrary(await repo.list());
        setProjects(await repo.listProjects());
      } catch (error) {
        // Without this, a thrown `list()`/`listProjects()` left `ready`
        // false forever — the Library screen shows "Opening local
        // storage…" indefinitely, with no error and no way to retry.
        logDiagnostic(error, { operation: 'library-startup' });
        notify('Could not read your local diagrams. Try reloading the page.', 'error');
      }
      setReady(true);
      if (!repo.durable && !embeddedHost) {
        notify(
          'This browser is not allowing local storage, so diagrams are kept in memory only. Export before closing the tab.',
          'error',
        );
      }
      // Encrypts any record still left over from before encryption existed —
      // not just documents the user happens to open this session. Kicked off
      // once, fire-and-forget: it never blocks opening or editing anything,
      // and a diagram it hasn't reached yet is just still plaintext, not
      // broken (`load()` migrates it lazily the moment it is opened anyway).
      if (repo instanceof IndexedDbRepository) {
        void repo
          .migrateLegacyRecords()
          .catch((error: unknown) => logDiagnostic(error, { operation: 'encryption-sweep' }))
          // Chained, not parallel: both sweeps decrypt bodies, and running
          // them together would decrypt the oldest records twice at once.
          // The library re-reads only when a row actually changed — the
          // common case, every launch after the first, changes nothing.
          .then(() => repo.backfillSummaries())
          .then(async ({ updated }) => {
            if (updated > 0 && !cancelled) setLibrary(await repo.list());
          })
          .catch((error: unknown) => logDiagnostic(error, { operation: 'library-backfill' }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [notify]);

  // This tab's database connection is gone — let go so a newer build in another tab can upgrade the
  // database, or closed by the browser — and nothing here saves any more until a reload.
  useEffect(
    () =>
      onStorageSuperseded((reason) =>
        notify(
          reason === 'lost'
            ? "Lost the connection to this browser's storage, so this tab can't save any more. Export recent changes, then reload."
            : "Draft Canvas was updated in another tab, so this tab can't save any more. Export recent changes, then reload.",
          'error',
        ),
      ),
    [notify],
  );

  // One autosave controller per repository, torn down with it.
  useEffect(() => {
    if (!repository) return;
    const controller = new Autosave({
      repository,
      // Saves only ever run for an open canvas, so the store is loaded by the time one reports.
      onStateChange: (state) => editorStoreModule?.useEditorStore.getState().setSaveState(state),
      onMetadataAdopted: (id, metadata) => editorStoreModule?.useEditorStore.getState().adoptStoredMetadata(id, metadata),
      // The status bar keeps the choice on screen; this makes sure it's noticed.
      onConflict: (_id, kind) =>
        notify(
          kind === 'deleted'
            ? 'This canvas was deleted in another tab. Your changes here aren’t saved — keep them from the status bar, or export.'
            : 'This canvas was changed in another tab. Choose which copy to keep from the status bar.',
          'error',
        ),
    });
    autosave.current = controller;
    return () => {
      controller.dispose();
      autosave.current = null;
    };
  }, [notify, repository]);

  /**
   * Watches the document revision rather than the document itself, so a save is
   * scheduled by an actual edit and never by a re-render.
   */
  useEffect(() => {
    if (!openId) return;
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;
    // Already loaded — `openId` is only ever set after the document went into the store — so this
    // subscribes a microtask later, before any edit can happen.
    void loadEditorStore().then(({ useEditorStore, fileWithLiveViewport }) => {
      if (cancelled) return;
      // What's on disk right now, so a later save can tell a rename made here from one made in
      // another tab's Library.
      autosave.current?.track(fileWithLiveViewport(useEditorStore.getState()));
      unsubscribe = useEditorStore.subscribe((state, previous) => {
        if (state.revision === previous.revision && state.liveViewport === previous.liveViewport) return;
        // Stepping into or out of a shape is navigation, not an edit: it clears `liveViewport`
        // (folding the camera into the room being left) without bumping `revision`, and saving
        // there would rewrite the file's stamp and tell every other tab it had changed. It is the
        // move itself that must stay quiet, not every change of room: an undo of an edit made
        // somewhere else both writes and moves you, and skipping that one left the undo on screen
        // and absent from disk until some later edit happened to flush it.
        if (state.navigation !== previous.navigation) return;
        if (state.document.metadata.id !== openId) return;
        autosave.current?.schedule(fileWithLiveViewport(state));
      });
    });
    return () => {
      cancelled = true;
      unsubscribe?.();
      autosave.current?.untrack(openId);
    };
  }, [openId]);

  // A closed tab must not cost the user their last few seconds of work.
  // `beforeunload` is avoided deliberately: it disables the back/forward cache.
  useEffect(() => {
    const flush = () => {
      if (document.visibilityState === 'hidden') void autosave.current?.flush();
    };
    const flushNow = () => void autosave.current?.flush();
    window.addEventListener('visibilitychange', flush);
    window.addEventListener('pagehide', flushNow);
    return () => {
      window.removeEventListener('visibilitychange', flush);
      window.removeEventListener('pagehide', flushNow);
    };
  }, []);

  const refreshLibrary = useCallback(async () => {
    if (!repository) return;
    setLibrary(await repository.list());
  }, [repository]);

  const openDocument = useCallback(
    async (id: string) => {
      if (!repository) return;
      const request = (navigation.current += 1);
      let loaded: DraftDocument | null;
      try {
        loaded = await repository.load(id);
      } catch (error) {
        logDiagnostic(error, { operation: 'open-document', documentId: id });
        loaded = null;
      }
      if (request !== navigation.current) return;
      if (!loaded) {
        notify('That diagram could not be read from local storage.', 'error');
        await refreshLibrary().catch((error: unknown) => {
          logDiagnostic(error, { operation: 'open-document-refresh', documentId: id });
        });
        return;
      }
      let editorStore: EditorStoreModule;
      try {
        editorStore = await loadEditorStore();
      } catch (error) {
        // The editor's chunk didn't arrive (offline, or a deploy replaced it): say so rather than
        // leaving the click to do nothing.
        logDiagnostic(error, { operation: 'load-editor', documentId: id });
        notify('The editor could not be loaded. Check your connection and try again.', 'error');
        return;
      }
      if (request !== navigation.current) return;
      // Reopening the canvas already open (taking another tab's copy) keeps `openId`, so the effect
      // that tracks a newly opened document doesn't run again. Tracked before `setDocument`: the
      // still-live autosave subscription sees that revision bump, and must recognise the copy it
      // hands over as the stored one rather than write it again.
      autosave.current?.track(loaded);
      // Reopening the same canvas — VS Code reloading the file after an outside edit, or taking
      // another tab's copy — should leave you standing in the room you were in, as long as the
      // shape you were inside is still there. Opening a *different* canvas always starts at the
      // top, the same way it never opens into a flow.
      const reopening = editorStore.useEditorStore.getState().document.metadata.id === loaded.metadata.id;
      editorStore.useEditorStore.getState().setDocument(loaded, { keepPath: reopening });
      setOpenId(loaded.metadata.id);
    },
    [notify, refreshLibrary, repository],
  );

  const adoptDocument = useCallback(
    async (incoming: DraftDocument) => {
      if (!repository) return;
      const request = (navigation.current += 1);
      // A `projectId` from a document authored in a different browser
      // profile (or whose project was deleted here) would make the canvas
      // invisible in the Library — excluded from Unorganized, with no
      // reachable project view to move it out of. Repair, don't reject: the
      // same discipline `document/validate.ts` already applies to every
      // other unresolvable reference, just one layer up (a pure function has
      // no repository to check the real project list against).
      let document = incoming;
      if (incoming.metadata.projectId && !projects.some((p) => p.id === incoming.metadata.projectId)) {
        const metadata = { ...incoming.metadata };
        delete metadata.projectId;
        document = { ...incoming, metadata };
      }
      try {
        // An imported file keeps the id it was exported with, so re-importing an
        // older export of a canvas that still lives here would `put` straight
        // over the newer local copy. Keep both instead: the import becomes a new
        // canvas. An unreadable existing row counts as taken, never as free — so this asks whether
        // anything is stored under the id, not whether it can be read.
        const taken = await repository.has(document.metadata.id).catch(() => true);
        if (taken) document = cloneDocumentAsNew(document, document.metadata.title);
        await repository.save(document);
        const { useEditorStore } = await loadEditorStore();
        // Saved either way — it's in the Library — but only the latest open/create takes the editor.
        if (request === navigation.current) {
          useEditorStore.getState().setDocument(document);
          setOpenId(document.metadata.id);
        }
        await refreshLibrary();
      } catch (error) {
        logDiagnostic(error, { operation: 'adopt-document', documentId: document.metadata.id });
        notify(
          canEncryptLocally()
            ? 'Could not save that diagram — local storage may be full or unavailable.'
            : 'Could not save that diagram — Draft Canvas needs HTTPS or localhost to save anything.',
          'error',
        );
      }
    },
    [notify, projects, refreshLibrary, repository],
  );

  const newDocument = useCallback(
    async (title?: string, starterId?: StarterId) => {
      if (creating.current) return;
      creating.current = true;
      const request = (navigation.current += 1);
      try {
        let catalog: Awaited<ReturnType<typeof loadStarters>> | undefined;
        try {
          catalog = starterId ? await loadStarters() : undefined;
          // Something else was opened while the starters chunk arrived.
          if (request !== navigation.current) return;
        } catch (error) {
          // The starters chunk didn't arrive (offline, or a deploy replaced it) — say so, the way
          // `openDocument` does for the editor chunk, rather than leaving the click to do nothing.
          logDiagnostic(error, { operation: 'load-starters' });
          notify('That starter could not be loaded. Check your connection and try again.', 'error');
          return;
        }
        const starter = starterId ? catalog?.starterById(starterId) : undefined;
        let document = createDocument(title ?? starter?.name ?? 'Untitled canvas');
        if (starter) {
          // The starter is the canvas's initial state, not an edit: there is
          // nothing to undo, exactly as with an imported file. Same origin the
          // palette uses for an empty canvas, plus a viewport that shows it —
          // see `openingViewportFor` for why the editor won't do that itself.
          const size = catalog!.starterSize(starter);
          const { nodes, edges, flows } = catalog!.buildStarter(starter, freeOriginFor(document, size));
          const screen =
            typeof window === 'undefined' ? null : { width: window.innerWidth, height: window.innerHeight };
          document = { ...document, nodes, edges, flows, ...(screen ? { viewport: openingViewportFor(size, screen) } : {}) };
        }
        await adoptDocument(document);
      } finally {
        creating.current = false;
      }
    },
    [adoptDocument, notify],
  );

  const closeDocument = useCallback(async () => {
    const saved = (await autosave.current?.flush()) ?? true;
    if (!saved) {
      // Leaving now would drop the only copy of the unsaved edits — the editor
      // still holds them, so stay there where Export can rescue them. A pending
      // cross-tab conflict isn't a storage failure: it's a choice still to make.
      const conflict = editorStoreModule?.useEditorStore.getState().save.conflict;
      notify(
        conflict
          ? 'Choose which copy to keep in the status bar before leaving this canvas.'
          : 'Your latest changes could not be saved to this browser. Export the diagram to keep a copy.',
        'error',
      );
      return;
    }
    // Replaced and removed backgrounds kept their images only so undo could bring them back. Undo
    // history ends here, so everything but the image actually showing goes — the one the *stored*
    // copy shows, which another tab may have changed since this one last looked.
    const closing = (await loadEditorStore()).useEditorStore.getState().document;
    if (repository && closing.metadata.id === openId) {
      const id = closing.metadata.id;
      void repository
        .load(id)
        .then((stored) => {
          if (!stored) return;
          const { background } = stored.settings;
          return repository.pruneBackgroundImages(id, background.enabled ? background : null);
        })
        .catch((error: unknown) => {
          logDiagnostic(error, { operation: 'remove-background-image', documentId: id });
        });
    }
    setOpenId(null);
    // Home is already showing; a list that can't be re-read just stays as it was.
    await refreshLibrary().catch((error: unknown) => logDiagnostic(error, { operation: 'refresh-library' }));
  }, [notify, openId, refreshLibrary, repository]);

  const resolveConflict = useCallback(
    async (choice: 'keep' | 'discard') => {
      const controller = autosave.current;
      if (!controller || !openId) return;
      const { useEditorStore, fileWithLiveViewport } = await loadEditorStore();
      if (choice === 'keep') {
        const saved = await controller.resolveConflict('keep', fileWithLiveViewport(useEditorStore.getState()));
        if (!saved) notify('Your changes still could not be saved to this browser. Export the diagram to keep a copy.', 'error');
        return;
      }
      await controller.resolveConflict('discard');
      const stillStored = await repository?.has(openId).catch(() => false);
      if (stillStored) {
        await openDocument(openId);
        return;
      }
      setOpenId(null);
      await refreshLibrary().catch((error: unknown) => logDiagnostic(error, { operation: 'refresh-library' }));
    },
    [notify, openDocument, openId, refreshLibrary, repository],
  );

  const renameDocument = useCallback(
    async (id: string, title: string) => {
      if (!repository) return;
      try {
        await repository.rename(id, title);
        await refreshLibrary();
      } catch (error) {
        logDiagnostic(error, { operation: 'rename-document', documentId: id });
        notify('Could not rename that diagram — local storage may be full or unavailable.', 'error');
      }
    },
    [notify, refreshLibrary, repository],
  );

  const duplicateDocument = useCallback(
    async (id: string) => {
      if (!repository) return;
      try {
        const source = await repository.load(id);
        if (!source) {
          notify("Couldn't duplicate — that canvas can't be read.", 'error');
          return;
        }
        const clone = cloneDocumentAsNew(source, `${source.metadata.title} copy`);
        await repository.save(clone);
        // A configured background is part of what the user set up for this
        // diagram — "Duplicate" should never silently drop it.
        if (source.settings.background.enabled) {
          const { imageId } = source.settings.background;
          try {
            const image = await repository.loadBackgroundImage(id, imageId);
            if (image) {
              await repository.saveBackgroundImage(
                clone.metadata.id,
                image.blob,
                { width: image.width, height: image.height },
                imageId,
              );
            }
          } catch (error) {
            // The failure below is reported as "could not duplicate", so no copy may be left behind:
            // it would turn up in the list on the next refresh, pointing at an image that was never stored.
            await repository.remove(clone.metadata.id).catch(() => {});
            throw error;
          }
        }
        await refreshLibrary();
      } catch (error) {
        logDiagnostic(error, { operation: 'duplicate-document', documentId: id });
        notify('Could not duplicate that diagram — local storage may be full or unavailable.', 'error');
      }
    },
    [notify, refreshLibrary, repository],
  );

  const deleteDocument = useCallback(
    async (id: string) => {
      if (!repository) return;
      try {
        await repository.remove(id);
        if (openId === id) setOpenId(null);
        await refreshLibrary();
      } catch (error) {
        logDiagnostic(error, { operation: 'delete-document', documentId: id });
        notify('Could not delete that diagram — local storage may be full or unavailable.', 'error');
      }
    },
    [notify, openId, refreshLibrary, repository],
  );

  const refreshProjects = useCallback(async () => {
    if (!repository) return;
    setProjects(await repository.listProjects());
  }, [repository]);

  const createProject = useCallback(
    async (name: string) => {
      if (!repository) return undefined;
      const now = Date.now();
      const project: Project = { id: createId('p'), name, createdAt: now, updatedAt: now };
      try {
        await repository.saveProject(project);
        await refreshProjects();
        return project;
      } catch (error) {
        logDiagnostic(error, { operation: 'create-project' });
        notify('Could not create that project — local storage may be full or unavailable.', 'error');
        return undefined;
      }
    },
    [notify, refreshProjects, repository],
  );

  const renameProject = useCallback(
    async (id: string, name: string) => {
      if (!repository) return;
      const existing = projects.find((project) => project.id === id);
      if (!existing) return;
      try {
        await repository.saveProject({ ...existing, name, updatedAt: Date.now() });
        await refreshProjects();
      } catch (error) {
        logDiagnostic(error, { operation: 'rename-project' });
        notify('Could not rename that project — local storage may be full or unavailable.', 'error');
      }
    },
    [notify, projects, refreshProjects, repository],
  );

  const deleteProject = useCallback(
    async (id: string) => {
      if (!repository) return;
      try {
        await repository.deleteProject(id);
      } catch (error) {
        logDiagnostic(error, { operation: 'delete-project' });
        notify('Some canvases couldn’t be moved out, so the project was kept.', 'error');
      }
      await Promise.all([refreshProjects(), refreshLibrary()]).catch((error: unknown) => {
        logDiagnostic(error, { operation: 'delete-project-refresh' });
      });
    },
    [notify, refreshLibrary, refreshProjects, repository],
  );

  const moveDocumentToProject = useCallback(
    async (id: string, projectId: string | undefined) => {
      if (!repository) return;
      try {
        await repository.moveDocumentToProject(id, projectId);
        await refreshLibrary();
      } catch (error) {
        logDiagnostic(error, { operation: 'move-document-to-project', documentId: id });
        notify('Could not move that diagram — local storage may be full or unavailable.', 'error');
      }
    },
    [notify, refreshLibrary, repository],
  );

  // The library can change under this tab — a canvas created, renamed, or
  // deleted in another one. One read on return is cheap, and it only runs
  // while the list is what is on screen.
  useEffect(() => {
    if (!repository || openId) return;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void Promise.all([refreshLibrary(), refreshProjects()]).catch((error: unknown) => {
        logDiagnostic(error, { operation: 'library-visibility-refresh' });
      });
    };
    window.addEventListener('visibilitychange', onVisible);
    return () => window.removeEventListener('visibilitychange', onVisible);
  }, [openId, refreshLibrary, refreshProjects, repository]);

  return {
    ready,
    repository,
    durable: repository?.durable ?? true,
    library,
    refreshLibrary,
    openDocument,
    newDocument,
    adoptDocument,
    closeDocument,
    resolveConflict,
    renameDocument,
    duplicateDocument,
    deleteDocument,
    openId,
    projects,
    refreshProjects,
    createProject,
    renameProject,
    deleteProject,
    moveDocumentToProject,
  };
}
