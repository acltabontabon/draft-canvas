import { create } from 'zustand';
import type { Preset } from '../canvas/presets';
import type { Side } from '../document/types';

export type Toast = { id: number; message: string; tone: 'info' | 'error' };

/**
 * Drives the small type-picker menu (`QuickConnectMenu`) for the two
 * gestures that need to ask "what should appear here?" rather than guessing:
 * a connection handle dragged onto empty canvas (`source` present — the
 * chosen type is created *and* wired to `source`), and a double-click on
 * empty canvas with no tool armed (`source` absent — the chosen type is
 * simply created at `flowPosition`). Screen coordinates are fixed for the
 * life of the menu so it does not drift if the user pans while choosing.
 */
export interface QuickConnectState {
  /** Absent for a plain double-click-to-create; present for a connector dropped on empty canvas. */
  source?: string;
  /** The side of the source node the user actually dragged from, if known. */
  sourceSide?: Side;
  /** How far along that side, if known — one of `ANCHOR_OFFSETS` (`edges/routing.ts`). */
  sourceOffset?: number;
  flowPosition: { x: number; y: number };
  screenPosition: { x: number; y: number };
}

/** The specific anchor (side + offset, one of `ANCHOR_OFFSETS`) a reconnect
 *  drag is currently hovering, and which node it's on — see `armedAnchor`. */
export interface ArmedAnchor {
  nodeId: string;
  side: Side;
  offset: number;
}

interface UiStore {
  /** The preset a canvas click will place, or null for plain selection. */
  armed: Preset | null;
  shortcutsOpen: boolean;
  exportOpen: boolean;
  aboutOpen: boolean;
  /** Canvas Settings — background image and personality preset (Phase 5). */
  settingsOpen: boolean;
  /** Bumped whenever the background image blob is replaced, so `CanvasBackground`
   *  knows to reload it even when `enabled` itself didn't change (e.g. "Replace image…"
   *  while already enabled) — see `CanvasSettingsDialog.tsx`/`CanvasBackground.tsx`. */
  backgroundImageVersion: number;
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
  /**
   * True for the duration of a reconnect drag (dragging an existing
   * connector's endpoint) — distinct from `reconnectHoverTarget` (which node,
   * if any, it's currently over): this is "is one happening at all,"
   * regardless of node, so every node's handles can reveal for it the same
   * way they already do for React Flow's own `.react-flow.connecting` during
   * a fresh connection drag. See `DraftEdgeView.tsx`'s `EdgeEndpointHandle`.
   */
  reconnectDragActive: boolean;
  /**
   * The specific anchor (not just the node) a reconnect drag is currently
   * hovering, so the one matching handle can highlight as "release here" —
   * the hand-rolled counterpart to React Flow's own `.connectingto.valid`,
   * which only exists for its native connection-creation drag.
   */
  armedAnchor: ArmedAnchor | null;
  /**
   * The attachment UI currently open, shared by both node and edge hosts — see `AttachmentChip`/
   * `AttachmentChipRow` in `AttachmentPresentation.tsx`. For an edge, `attachmentId` is always
   * non-null when this is set (one click pins one specific chip's card open for editing). For a
   * node, `attachmentId: null` means "the badge was clicked, the chip row is open, nothing pinned
   * yet"; non-null means a specific chip is additionally pinned open — a node's badge click and an
   * edge's chip click both write here, just at different granularity.
   */
  openAttachmentDetail: { hostKind: 'node' | 'edge'; hostId: string; attachmentId: string | null } | null;
  /**
   * The single attachment a presenter has intentionally revealed for the
   * current step — a read-only counterpart to `openAttachmentDetail`, kept as a
   * separate field rather than overloading that one: `openAttachmentDetail` also
   * unlocks the attachment's edit textarea, which presentation must never
   * do. Cleared automatically on every step change (see `FlowBar.tsx`) —
   * there is no persistent pin across steps in this pass, so a revealed
   * attachment never survives into an unrelated later step. Edge-only: there is no analogous
   * "current step" reveal for a node attachment.
   */
  presentationReveal: { edgeId: string; attachmentId: string } | null;
  /** Whether the Flow list drawer is visible. */
  flowPanelOpen: boolean;
  /** Whether the compact toolbar flow switcher's dropdown is open — see `FlowSwitcher.tsx`. */
  flowSwitcherOpen: boolean;
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
  /** True once a newer app build has finished downloading in the background
   *  and is waiting to be activated (Phase 6.2/6.3) — see `serviceWorker.ts`
   *  and `AboutDialog.tsx`'s update-ready state. */
  updateReady: boolean;

  arm: (preset: Preset | null) => void;
  setShortcutsOpen: (open: boolean) => void;
  setExportOpen: (open: boolean) => void;
  setAboutOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  bumpBackgroundImageVersion: () => void;
  setQuickConnect: (state: QuickConnectState | null) => void;
  setAttachArmedTarget: (nodeId: string | null) => void;
  setAttachArmedEdgeTarget: (edgeId: string | null) => void;
  setReconnectHoverTarget: (nodeId: string | null) => void;
  setReconnectDragActive: (active: boolean) => void;
  setArmedAnchor: (anchor: ArmedAnchor | null) => void;
  setOpenAttachmentDetail: (
    target: { hostKind: 'node' | 'edge'; hostId: string; attachmentId: string | null } | null,
  ) => void;
  setPresentationReveal: (target: { edgeId: string; attachmentId: string } | null) => void;
  setFlowPanelOpen: (open: boolean) => void;
  setFlowSwitcherOpen: (open: boolean) => void;
  setInteractionActive: (active: boolean) => void;
  requestEdit: (id: string | null) => void;
  notify: (message: string, tone?: Toast['tone']) => void;
  dismiss: (id: number) => void;
  /** Marks an update as downloaded and ready to activate on the next reload. */
  setUpdateReady: () => void;
  /** Wired once by `main.tsx` at startup to the Service Worker's own
   *  activate-and-reload function — see `serviceWorker.ts`. */
  registerActivateUpdate: (activate: (() => void) | null) => void;
  /** Reloads onto the downloaded update. A no-op until `registerActivateUpdate`
   *  has run (e.g. unsupported browser, or no update staged). */
  activateUpdate: () => void;
}

let toastId = 0;

/** Set by `registerActivateUpdate`; kept outside the store's own state since
 *  it's a function reference, not something a component should re-render on. */
let activateFn: (() => void) | null = null;

export const useUiStore = create<UiStore>((set) => ({
  armed: null,
  shortcutsOpen: false,
  exportOpen: false,
  aboutOpen: false,
  settingsOpen: false,
  backgroundImageVersion: 0,
  toasts: [],
  quickConnect: null,
  attachArmedTarget: null,
  attachArmedEdgeTarget: null,
  reconnectHoverTarget: null,
  reconnectDragActive: false,
  armedAnchor: null,
  openAttachmentDetail: null,
  presentationReveal: null,
  flowPanelOpen: false,
  flowSwitcherOpen: false,
  interactionActive: false,
  editRequestId: null,
  updateReady: false,

  arm: (armed) => set({ armed }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setExportOpen: (exportOpen) => set({ exportOpen }),
  setAboutOpen: (aboutOpen) => set({ aboutOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  bumpBackgroundImageVersion: () => set((state) => ({ backgroundImageVersion: state.backgroundImageVersion + 1 })),
  setQuickConnect: (quickConnect) => set({ quickConnect }),
  setAttachArmedTarget: (attachArmedTarget) =>
    set((state) => (state.attachArmedTarget === attachArmedTarget ? state : { attachArmedTarget })),
  setAttachArmedEdgeTarget: (attachArmedEdgeTarget) =>
    set((state) => (state.attachArmedEdgeTarget === attachArmedEdgeTarget ? state : { attachArmedEdgeTarget })),
  setReconnectHoverTarget: (reconnectHoverTarget) =>
    set((state) => (state.reconnectHoverTarget === reconnectHoverTarget ? state : { reconnectHoverTarget })),
  setReconnectDragActive: (reconnectDragActive) =>
    set((state) => (state.reconnectDragActive === reconnectDragActive ? state : { reconnectDragActive })),
  setArmedAnchor: (next) =>
    set((state) => {
      const current = state.armedAnchor;
      const same =
        current === next ||
        (current !== null &&
          next !== null &&
          current.nodeId === next.nodeId &&
          current.side === next.side &&
          current.offset === next.offset);
      return same ? state : { armedAnchor: next };
    }),
  setOpenAttachmentDetail: (openAttachmentDetail) => set({ openAttachmentDetail }),
  setPresentationReveal: (presentationReveal) => set({ presentationReveal }),
  setFlowPanelOpen: (flowPanelOpen) => set({ flowPanelOpen }),
  setFlowSwitcherOpen: (flowSwitcherOpen) => set({ flowSwitcherOpen }),
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

  setUpdateReady: () => set({ updateReady: true }),
  registerActivateUpdate: (activate) => {
    activateFn = activate;
  },
  activateUpdate: () => activateFn?.(),
}));

/**
 * The last pointer position in canvas coordinates.
 *
 * Kept outside React deliberately: keyboard shortcuts need to know where the
 * cursor is so a new note appears under it, and re-rendering the canvas on
 * every mouse move to track that would be absurd.
 */
export const pointer = { x: 0, y: 0, known: false };
