import { create } from 'zustand';
import type { Preset } from '../canvas/presets';
import type { Side } from '../document/types';

export type Toast = { id: number; message: string; tone: 'info' | 'error' };

/**
 * A drag from a connection handle released on empty canvas — the source node,
 * where the new node should land (flow coordinates, for creation) and where
 * the menu itself should appear (screen coordinates, fixed for the life of
 * the menu so it does not drift if the user pans while choosing).
 */
export interface QuickConnectState {
  source: string;
  /** The side of the source node the user actually dragged from, if known. */
  sourceSide?: Side;
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
  /** The edge id a dragged note/code node is currently armed against — see `Canvas.tsx`'s
   *  drag-to-attach wiring and `dragTargets.ts`'s `findEdgeDropCandidate`. */
  attachArmedEdgeTarget: string | null;
  /**
   * The node id a connector-endpoint drag (see `DraftEdgeView.tsx`) is
   * currently hovering as a candidate drop target. Node handles always keep
   * real pointer events (see their own CSS comment), which is what makes a
   * reconnect drag have to be driven by hand rather than through React
   * Flow's own reconnect machinery — this is that drag's one piece of
   * reactive state, kept to "which node" rather than a raw pointer position
   * so a drag does not re-render anything on every pointer-move frame.
   */
  reconnectHoverTarget: string | null;
  /** The host node whose attachment popover is open, if any. */
  openAttachmentPopover: string | null;
  /** The specific attachment (an edge can carry several) currently pinned open for editing, if
   *  any — see `EdgeAttachmentChip` in `DraftEdgeView.tsx`. Hover reveals a chip's card
   *  independently of this; only a click pins one open for editing. */
  openEdgeDetail: { edgeId: string; attachmentId: string } | null;
  /** Whether the Flow list drawer is visible. */
  flowPanelOpen: boolean;
  /**
   * True for the duration of a node drag or resize gesture. Distinct from
   * `editorStore`'s own `interaction` bracket, which only decides history
   * grouping and is not reactive — this exists so connector rendering can
   * skip obstacle avoidance (and any other route refinement heavier than a
   * direct path) while a gesture is in flight, and run it once the gesture
   * commits. See `edges/routing.ts`'s obstacle-avoidance notes.
   */
  interactionActive: boolean;
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
  setAttachArmedEdgeTarget: (edgeId: string | null) => void;
  setReconnectHoverTarget: (nodeId: string | null) => void;
  setOpenAttachmentPopover: (hostId: string | null) => void;
  setOpenEdgeDetail: (target: { edgeId: string; attachmentId: string } | null) => void;
  setFlowPanelOpen: (open: boolean) => void;
  setInteractionActive: (active: boolean) => void;
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
  attachArmedEdgeTarget: null,
  reconnectHoverTarget: null,
  openAttachmentPopover: null,
  openEdgeDetail: null,
  flowPanelOpen: false,
  interactionActive: false,
  editRequestId: null,

  arm: (armed) => set({ armed }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setExportOpen: (exportOpen) => set({ exportOpen }),
  setQuickConnect: (quickConnect) => set({ quickConnect }),
  setAttachArmedTarget: (attachArmedTarget) =>
    set((state) => (state.attachArmedTarget === attachArmedTarget ? state : { attachArmedTarget })),
  setAttachArmedEdgeTarget: (attachArmedEdgeTarget) =>
    set((state) => (state.attachArmedEdgeTarget === attachArmedEdgeTarget ? state : { attachArmedEdgeTarget })),
  setReconnectHoverTarget: (reconnectHoverTarget) =>
    set((state) => (state.reconnectHoverTarget === reconnectHoverTarget ? state : { reconnectHoverTarget })),
  setOpenAttachmentPopover: (openAttachmentPopover) => set({ openAttachmentPopover }),
  setOpenEdgeDetail: (openEdgeDetail) => set({ openEdgeDetail }),
  setFlowPanelOpen: (flowPanelOpen) => set({ flowPanelOpen }),
  setInteractionActive: (interactionActive) =>
    set((state) => (state.interactionActive === interactionActive ? state : { interactionActive })),
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
