import { create } from 'zustand';
import { isCanvasEmpty } from '../document/operations';
import {
  GalleryRefreshError,
  canvasFromStarter,
  starterFile,
  STALE_AFTER_MS,
  clearGalleryCache,
  loadGallery,
  markStarterSeen,
  refreshGallery,
  type GallerySnapshot,
  type GalleryStarter,
  type RefreshFailure,
} from '../gallery';
import { readPreference, removePreference, writePreference } from '../lib/preferences';
import { documentLoadCount, useEditorStore } from './editorStore';
import { useUiStore } from './uiStore';

/**
 * The starters gallery as the interface sees it. Transient: the downloaded gallery itself lives in
 * `gallery/cache.ts`, and the only thing remembered here is the person's choice to load it.
 *
 * Nothing reaches the network until `enable` — the "Load starters" consent — and after that only
 * on Refresh, or when the gallery is opened more than a day after it was last read.
 */

const PREFERENCE = 'starters-gallery';

export type GalleryStatus = 'idle' | 'loading' | 'refreshing';

export interface GalleryState {
  /** Whether the person chose to load starters from GitHub. */
  enabled: boolean;
  status: GalleryStatus;
  /** What was last downloaded; `null` before the first load. */
  snapshot: GallerySnapshot | null;
  /** Why the last refresh failed, while its copy (if any) is shown instead. */
  failure: RefreshFailure | null;
  /** The Starters dialog: open, and the starter it opens on. */
  dialog: { open: boolean; focus?: string };
  /** Reads the cached gallery (no network), then refreshes it if it is a day old. */
  load: (options?: { refresh?: boolean }) => Promise<void>;
  /** Reads the gallery from GitHub now. */
  refresh: () => Promise<void>;
  /** "Load starters": remembers the choice and reads the gallery. */
  enable: () => Promise<void>;
  /** Turns loading off and forgets everything downloaded. */
  disable: () => Promise<void>;
  markSeen: (starter: GalleryStarter) => void;
  /** Adds a downloaded starter to the canvas on screen, as one undo step; returns the new shapes'
   *  ids. `title` names a still-untitled canvas after it. */
  addToCanvas: (id: string, options?: { title?: string }) => Promise<string[]>;
  /** Opens a downloaded starter as a new canvas of its own. */
  openAsCanvas: (id: string) => Promise<boolean>;
  openDialog: (focus?: string) => void;
  closeDialog: () => void;
}

let inFlight: Promise<void> | null = null;
let refreshController: AbortController | null = null;
let clearing = Promise.resolve();

export const useGalleryStore = create<GalleryState>()((set, get) => ({
  enabled: readPreference(PREFERENCE) === 'on',
  status: 'idle',
  snapshot: null,
  failure: null,
  dialog: { open: false },

  async load(options = {}) {
    if (!get().enabled) return;
    if (!get().snapshot) {
      // A refresh may already be on its way ("Load starters" starts one, and the list it opens
      // calls this): its status and whatever it brings stand. Saying "idle" over it, with nothing
      // downloaded yet, is what the list read as "couldn't reach GitHub" until the refresh landed.
      if (!inFlight) set({ status: 'loading' });
      const pendingClear = clearing;
      await pendingClear;
      const cached = await loadGallery();
      if (pendingClear !== clearing) return;
      if (!get().snapshot && cached) set({ snapshot: cached });
      if (!inFlight) set({ status: 'idle' });
    }
    const { enabled, snapshot } = get();
    if (options.refresh === false) return;
    if (enabled && (!snapshot || Date.now() - snapshot.fetchedAt > STALE_AFTER_MS)) await get().refresh();
  },

  refresh() {
    if (!get().enabled) return Promise.resolve();
    if (inFlight) return inFlight;
    const controller = new AbortController();
    refreshController = controller;
    inFlight = (async () => {
      try {
        await clearing;
        controller.signal.throwIfAborted();
        const snapshot = await refreshGallery(controller.signal);
        if (!controller.signal.aborted) set({ snapshot, failure: null });
      } catch (error) {
        if (!controller.signal.aborted) set({ failure: error instanceof GalleryRefreshError ? error.reason : 'offline' });
      } finally {
        if (refreshController === controller) {
          refreshController = null;
          inFlight = null;
          set({ status: 'idle' });
        }
      }
    })();
    set({ status: 'refreshing' });
    return inFlight;
  },

  async enable() {
    writePreference(PREFERENCE, 'on');
    // On and busy in one step: on, idle and empty-handed, even for a moment, is what a list shows
    // as a failure to reach GitHub.
    set({ enabled: true, status: 'refreshing', failure: null });
    await get().refresh();
  },

  async disable() {
    removePreference(PREFERENCE);
    refreshController?.abort();
    // Wait out any cache writes already started. A later opt-in waits for this deletion in turn.
    clearing = Promise.all([clearing, inFlight]).then(() => clearGalleryCache());
    refreshController = null;
    inFlight = null;
    set({ enabled: false, status: 'idle', snapshot: null, failure: null });
    await clearing;
  },

  markSeen(starter) {
    if (!starter.mark) return;
    void markStarterSeen(starter);
    const snapshot = get().snapshot;
    if (!snapshot) return;
    set({
      snapshot: {
        ...snapshot,
        starters: snapshot.starters.map((s) => {
          if (s.id !== starter.id) return s;
          const { mark: _cleared, ...rest } = s;
          return rest;
        }),
      },
    });
  },

  async addToCanvas(id, options = {}) {
    const loading = documentLoadCount('all');
    const { path } = useEditorStore.getState();
    const pendingClear = clearing;
    const starter = get().snapshot?.starters.find((s) => s.id === id);
    const file = starter?.availability === 'ready' ? await starterFile(starter) : null;
    const editor = useEditorStore.getState();
    if (pendingClear !== clearing || loading !== documentLoadCount('all') || editor.path !== path) return [];
    if (!starter || !file) {
      useUiStore.getState().notify('That starter isn’t downloaded yet. Refresh the gallery and try again.', 'error');
      return [];
    }
    // Added to a blank canvas, the starter is what the canvas began as: it can say when it changes.
    const origin = editor.path.length === 0 && isCanvasEmpty(editor.document) ? { starter: starter.id, sha256: starter.sha256 } : undefined;
    const added = editor.insertStarterDocument(file, starter.name, { origin, title: options.title });
    get().markSeen(starter);
    return added;
  },

  async openAsCanvas(id) {
    const pendingClear = clearing;
    const starter = get().snapshot?.starters.find((s) => s.id === id);
    const file = starter?.availability === 'ready' ? await starterFile(starter) : null;
    if (pendingClear !== clearing) return false;
    if (!starter || !file) {
      useUiStore.getState().notify('That starter isn’t downloaded yet. Refresh the gallery and try again.', 'error');
      return false;
    }
    get().markSeen(starter);
    useUiStore.getState().requestCanvas(canvasFromStarter(starter, file));
    return true;
  },

  openDialog(focus) {
    set({ dialog: focus ? { open: true, focus } : { open: true } });
    void get().load();
  },

  closeDialog() {
    set({ dialog: { open: false } });
  },
}));
