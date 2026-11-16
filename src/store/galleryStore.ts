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
import { useEditorStore } from './editorStore';
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

export const useGalleryStore = create<GalleryState>()((set, get) => ({
  enabled: readPreference(PREFERENCE) === 'on',
  status: 'idle',
  snapshot: null,
  failure: null,
  dialog: { open: false },

  async load(options = {}) {
    if (!get().snapshot) {
      set({ status: 'loading' });
      const cached = await loadGallery();
      set({ snapshot: cached, status: 'idle' });
    }
    const { enabled, snapshot } = get();
    if (options.refresh === false) return;
    if (enabled && (!snapshot || Date.now() - snapshot.fetchedAt > STALE_AFTER_MS)) await get().refresh();
  },

  refresh() {
    if (!get().enabled) return Promise.resolve();
    inFlight ??= (async () => {
      set({ status: 'refreshing' });
      try {
        const snapshot = await refreshGallery();
        set({ snapshot, failure: null });
      } catch (error) {
        set({ failure: error instanceof GalleryRefreshError ? error.reason : 'offline' });
      } finally {
        set({ status: 'idle' });
        inFlight = null;
      }
    })();
    return inFlight;
  },

  async enable() {
    writePreference(PREFERENCE, 'on');
    set({ enabled: true });
    await get().refresh();
  },

  async disable() {
    removePreference(PREFERENCE);
    set({ enabled: false, snapshot: null, failure: null });
    await clearGalleryCache();
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
    const starter = get().snapshot?.starters.find((s) => s.id === id);
    const file = starter?.availability === 'ready' ? await starterFile(starter) : null;
    if (!starter || !file) {
      useUiStore.getState().notify('That starter isn’t downloaded yet. Refresh the gallery and try again.', 'error');
      return [];
    }
    const editor = useEditorStore.getState();
    // Added to a blank canvas, the starter is what the canvas began as: it can say when it changes.
    const origin = editor.path.length === 0 && isCanvasEmpty(editor.document) ? { starter: starter.id, sha256: starter.sha256 } : undefined;
    const added = editor.insertStarterDocument(file, starter.name, { origin, title: options.title });
    get().markSeen(starter);
    return added;
  },

  async openAsCanvas(id) {
    const starter = get().snapshot?.starters.find((s) => s.id === id);
    const file = starter?.availability === 'ready' ? await starterFile(starter) : null;
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
