import { create } from 'zustand';
import type { Preset } from '../canvas/presets';

export type Toast = { id: number; message: string; tone: 'info' | 'error' };

interface UiStore {
  /** The preset a canvas click will place, or null for plain selection. */
  armed: Preset | null;
  shortcutsOpen: boolean;
  exportOpen: boolean;
  toasts: Toast[];

  arm: (preset: Preset | null) => void;
  setShortcutsOpen: (open: boolean) => void;
  setExportOpen: (open: boolean) => void;
  notify: (message: string, tone?: Toast['tone']) => void;
  dismiss: (id: number) => void;
}

let toastId = 0;

export const useUiStore = create<UiStore>((set) => ({
  armed: null,
  shortcutsOpen: false,
  exportOpen: false,
  toasts: [],

  arm: (armed) => set({ armed }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setExportOpen: (exportOpen) => set({ exportOpen }),

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
