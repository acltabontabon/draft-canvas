import { useCallback, useEffect, useRef, useState } from 'react';
import { cloneDocumentAsNew, createDocument } from '../document/factory';
import { createId } from '../document/ids';
import type { DraftDocument, DraftSummary, Project } from '../document/types';
import { Autosave } from '../storage/autosave';
import { getRepository, type DraftRepository } from '../storage';
import { IndexedDbRepository } from '../storage/IndexedDbRepository';
import { useEditorStore } from './editorStore';
import { useUiStore } from './uiStore';

export interface DocumentSession {
  ready: boolean;
  repository: DraftRepository | null;
  /** False when the browser refused persistent storage; the UI says so plainly. */
  durable: boolean;
  library: DraftSummary[];
  refreshLibrary: () => Promise<void>;
  openDocument: (id: string) => Promise<void>;
  newDocument: (title?: string) => Promise<void>;
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
      setLibrary(await repo.list());
      setProjects(await repo.listProjects());
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
        void repo.migrateLegacyRecords().catch((error: unknown) => {
          console.warn('[draft-canvas] Background encryption sweep failed:', error);
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
      if (state.revision === previous.revision) return;
      if (state.document.metadata.id !== openId) return;
      autosave.current?.schedule(state.document);
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
      const loaded = await repository.load(id);
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
      await repository.save(incoming);
      useEditorStore.getState().setDocument(incoming);
      setOpenId(incoming.metadata.id);
      await refreshLibrary();
    },
    [refreshLibrary, repository],
  );

  const newDocument = useCallback(
    async (title?: string) => {
      await adoptDocument(createDocument(title ?? 'Untitled canvas'));
    },
    [adoptDocument],
  );

  const closeDocument = useCallback(async () => {
    await autosave.current?.flush();
    setOpenId(null);
    await refreshLibrary();
  }, [refreshLibrary]);

  const renameDocument = useCallback(
    async (id: string, title: string) => {
      if (!repository) return;
      await repository.rename(id, title);
      await refreshLibrary();
    },
    [refreshLibrary, repository],
  );

  const duplicateDocument = useCallback(
    async (id: string) => {
      if (!repository) return;
      const source = await repository.load(id);
      if (!source) return;
      const clone = cloneDocumentAsNew(source, `${source.metadata.title} copy`);
      await repository.save(clone);
      // A configured background is part of what the user set up for this
      // diagram — "Duplicate" should never silently drop it.
      if (source.settings.background.enabled) {
        const image = await repository.loadBackgroundImage(id);
        if (image) {
          await repository.saveBackgroundImage(clone.metadata.id, image.blob, {
            width: image.width,
            height: image.height,
          });
        }
      }
      await refreshLibrary();
    },
    [refreshLibrary, repository],
  );

  const deleteDocument = useCallback(
    async (id: string) => {
      if (!repository) return;
      await repository.remove(id);
      if (openId === id) setOpenId(null);
      await refreshLibrary();
    },
    [openId, refreshLibrary, repository],
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
      await repository.saveProject(project);
      await refreshProjects();
      return project;
    },
    [refreshProjects, repository],
  );

  const renameProject = useCallback(
    async (id: string, name: string) => {
      if (!repository) return;
      const existing = projects.find((project) => project.id === id);
      if (!existing) return;
      await repository.saveProject({ ...existing, name, updatedAt: Date.now() });
      await refreshProjects();
    },
    [projects, refreshProjects, repository],
  );

  const deleteProject = useCallback(
    async (id: string) => {
      if (!repository) return;
      await repository.deleteProject(id);
      await Promise.all([refreshProjects(), refreshLibrary()]);
    },
    [refreshLibrary, refreshProjects, repository],
  );

  const moveDocumentToProject = useCallback(
    async (id: string, projectId: string | undefined) => {
      if (!repository) return;
      await repository.moveDocumentToProject(id, projectId);
      await refreshLibrary();
    },
    [refreshLibrary, repository],
  );

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
