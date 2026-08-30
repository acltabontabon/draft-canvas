import { create } from 'zustand';
import type { Preset } from '../canvas/presets';

export type Toast = { id: number; message: string; tone: 'info' | 'error' };

/**
 * A drag from a connection handle released on empty canvas — the source node,
 * where the new node should land (flow coordinates, for creation) and where
 * the menu itself should appear (screen coordinates, fixed for the life of
 * the menu so it does not drift if the user pans while choosing).
 */
export interface QuickConnectState {
  source: string;
  flowPosition: { x: number; y: number };
  screenPosition: { x: number; y: number };
}

interface UiStore {
  /** The preset a canvas click will place, or null for plain selection. */
  armed: Preset | null;
  shortcutsOpen: boolean;
  exportOpen: boolean;
  toasts: Toast[];
  quickConnect: QuickConnectState | null;
  /** The node id a dragged attachable node is currently armed against. */
  attachArmedTarget: string | null;
  /** The host node whose attachment popover is open, if any. */
  openAttachmentPopover: string | null;
  /**
   * A node or edge id that `Enter` just asked to start editing. There is no
   * ref-based imperative API into the memoized node/edge components, so this
   * is the simplest hook: they watch it via an effect and clear it once
   * editing has actually started.
   */
  editRequestId: string | null;

  arm: (preset: Preset | null) => void;
  setShortcutsOpen: (open: boolean) => void;
  setExportOpen: (open: boolean) => void;
  setQuickConnect: (state: QuickConnectState | null) => void;
  setAttachArmedTarget: (nodeId: string | null) => void;
  setOpenAttachmentPopover: (hostId: string | null) => void;
  requestEdit: (id: string | null) => void;
  notify: (message: string, tone?: Toast['tone']) => void;
  dismiss: (id: number) => void;
}

let toastId = 0;

export const useUiStore = create<UiStore>((set) => ({
  armed: null,
  shortcutsOpen: false,
  exportOpen: false,
  toasts: [],
  quickConnect: null,
  attachArmedTarget: null,
  openAttachmentPopover: null,
  editRequestId: null,

  arm: (armed) => set({ armed }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setExportOpen: (exportOpen) => set({ exportOpen }),
  setQuickConnect: (quickConnect) => set({ quickConnect }),
  setAttachArmedTarget: (attachArmedTarget) =>
    set((state) => (state.attachArmedTarget === attachArmedTarget ? state : { attachArmedTarget })),
  setOpenAttachmentPopover: (openAttachmentPopover) => set({ openAttachmentPopover }),
  requestEdit: (editRequestId) => set({ editRequestId }),

  notify(message, tone = 'info') {
    toastId += 1;
    const toast = { id: toastId, message, tone };
    set((state) => ({ toasts: [...state.toasts, toast] }));
    setTimeout(() => {
      set((state) => ({ toasts: state.toasts.filter((t) => t.id !== toast.id) }));
    }, tone === 'error' ? 8000 : 3500);
  },

  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));

/**
 * The last pointer position in canvas coordinates.
 *
 * Kept outside React deliberately: keyboard shortcuts need to know where the
 * cursor is so a new note appears under it, and re-rendering the canvas on
 * every mouse move to track that would be absurd.
 */
export const pointer = { x: 0, y: 0, known: false };
