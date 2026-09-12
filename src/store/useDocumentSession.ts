import { useCallback, useEffect, useRef, useState } from 'react';
import { cloneDocumentAsNew, createDocument } from '../document/factory';
import { freeOriginFor, openingViewportFor } from '../document/operations';
import { createId } from '../document/ids';
import type { DraftDocument, DraftSummary, Project } from '../document/types';
import { logDiagnostic } from '../lib/diagnostics';
import type { StarterId } from '../starters';
import { loadStarters } from '../starters/load';
import { Autosave } from '../storage/autosave';
import { getRepository, type DraftRepository } from '../storage';
import { IndexedDbRepository } from '../storage/IndexedDbRepository';
import { documentWithLiveViewport, useEditorStore } from './editorStore';
import { useUiStore } from './uiStore';

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
      if (!repo.durable) {
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
          .catch((error: unknown) => {
            console.warn('[draft-canvas] Background encryption sweep failed:', error);
          })
          // Chained, not parallel: both sweeps decrypt bodies, and running
          // them together would decrypt the oldest records twice at once.
          // The library re-reads only when a row actually changed — the
          // common case, every launch after the first, changes nothing.
          .then(() => repo.backfillSummaries())
          .then(async ({ updated }) => {
            if (updated > 0 && !cancelled) setLibrary(await repo.list());
          })
          .catch((error: unknown) => {
            console.warn('[draft-canvas] Library fingerprint backfill failed:', error);
          });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [notify]);

  // One autosave controller per repository, torn down with it.
  useEffect(() => {
    if (!repository) return;
    const controller = new Autosave({
      repository,
      onStateChange: (state) => useEditorStore.getState().setSaveState(state),
    });
    autosave.current = controller;
    return () => {
      controller.dispose();
      autosave.current = null;
    };
  }, [repository]);

  /**
   * Watches the document revision rather than the document itself, so a save is
   * scheduled by an actual edit and never by a re-render.
   */
  useEffect(() => {
    if (!openId) return;
    return useEditorStore.subscribe((state, previous) => {
      if (state.revision === previous.revision && state.liveViewport === previous.liveViewport) return;
      if (state.document.metadata.id !== openId) return;
      autosave.current?.schedule(documentWithLiveViewport(state));
    });
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
      let loaded: DraftDocument | null;
      try {
        loaded = await repository.load(id);
      } catch (error) {
        logDiagnostic(error, { operation: 'open-document', documentId: id });
        loaded = null;
      }
      if (!loaded) {
        notify('That diagram could not be read from local storage.', 'error');
        await refreshLibrary();
        return;
      }
      useEditorStore.getState().setDocument(loaded);
      setOpenId(loaded.metadata.id);
    },
    [notify, refreshLibrary, repository],
  );

  const adoptDocument = useCallback(
    async (incoming: DraftDocument) => {
      if (!repository) return;
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
        // canvas. An unreadable existing row counts as taken, never as free.
        const taken = await repository.load(document.metadata.id).then(
          (existing) => existing !== null,
          () => true,
        );
        if (taken) document = cloneDocumentAsNew(document, document.metadata.title);
        await repository.save(document);
        useEditorStore.getState().setDocument(document);
        setOpenId(document.metadata.id);
        await refreshLibrary();
      } catch (error) {
        logDiagnostic(error, { operation: 'adopt-document', documentId: document.metadata.id });
        notify('Could not save that diagram — local storage may be full or unavailable.', 'error');
      }
    },
    [notify, projects, refreshLibrary, repository],
  );

  const newDocument = useCallback(
    async (title?: string, starterId?: StarterId) => {
      const catalog = starterId ? await loadStarters() : undefined;
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
    },
    [adoptDocument],
  );

  const closeDocument = useCallback(async () => {
    const saved = (await autosave.current?.flush()) ?? true;
    if (!saved) {
      // Leaving now would drop the only copy of the unsaved edits — the editor
      // still holds them, so stay there where Export can rescue them.
      notify('Your latest changes could not be saved to this browser. Export the diagram to keep a copy.', 'error');
      return;
    }
    // Replaced and removed backgrounds kept their images only so undo could bring them back. Undo
    // history ends here, so everything but the image actually showing goes.
    const closing = useEditorStore.getState().document;
    if (repository && closing.metadata.id === openId) {
      const { background } = closing.settings;
      void repository.pruneBackgroundImages(closing.metadata.id, background.enabled ? background : null).catch((error: unknown) => {
        logDiagnostic(error, { operation: 'remove-background-image', documentId: closing.metadata.id });
      });
    }
    setOpenId(null);
    await refreshLibrary();
  }, [notify, openId, refreshLibrary, repository]);

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
        if (!source) return;
        const clone = cloneDocumentAsNew(source, `${source.metadata.title} copy`);
        await repository.save(clone);
        // A configured background is part of what the user set up for this
        // diagram — "Duplicate" should never silently drop it.
        if (source.settings.background.enabled) {
          const { imageId } = source.settings.background;
          const image = await repository.loadBackgroundImage(id, imageId);
          if (image) {
            await repository.saveBackgroundImage(
              clone.metadata.id,
              image.blob,
              { width: image.width, height: image.height },
              imageId,
            );
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
        notify('Could not delete that project — its canvases were left where they were.', 'error');
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
