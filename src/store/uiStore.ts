import { create } from 'zustand';
import type { Preset } from '../canvas/presets';
import { dismissalKey, type ContinuationTrigger, type DismissalKey, type MaterializedContinuation } from '../continuation';
import type { Side } from '../document/types';
import { readPreference, writePreference } from '../lib/preferences';
import { PRODUCT } from '../product';
import { markLastSeenRelease, readLastSeenRelease } from '../releases/productReleases';

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
  /** The raw drop point in flow coordinates (`flowPosition` is that point already offset for a
   *  default-sized box) — so a picker row of any size can be centred on where the user let go. */
  center?: { x: number; y: number };
}

/** The specific anchor (side + offset, one of `ANCHOR_OFFSETS`) a reconnect
 *  drag is currently hovering, and which node it's on — see `armedAnchor`. */
export interface ArmedAnchor {
  nodeId: string;
  side: Side;
  offset: number;
}

/** What was right-clicked (or Shift+F10'd) to open the context menu — `id` is absent for `pane`
 *  (nothing under the pointer) and `selection` (the target is "whatever's currently selected", not
 *  one specific id, since a multi-selection has no single owner). */
export type ContextMenuTarget =
  | { kind: 'pane' }
  | { kind: 'node'; id: string }
  | { kind: 'edge'; id: string }
  | { kind: 'selection' };

/**
 * Drives the right-click context menu — mirrors `QuickConnectState`'s shape and reasoning exactly.
 * `screenPosition` is fixed for the life of the menu (it does not track pan/zoom); `flowPosition` is
 * the same click converted to document coordinates, used by the pane menu's "Add …"/"Paste" rows —
 * meaningless for `node`/`edge`/`selection` targets, which act on the target itself, not a point.
 */
export interface ContextMenuState {
  target: ContextMenuTarget;
  screenPosition: { x: number; y: number };
  flowPosition: { x: number; y: number };
}

/**
 * The one continuation Draft Canvas is currently offering — see `src/continuation/` for how it is
 * chosen and `canvas/ContinuationGhost.tsx` for how it is shown. `trigger` records which moment
 * produced it: a `'select'` offer is owned by `useContinuation` (recomputed as the document and
 * selection move); a `'drop'` offer is owned by the Quick Connect menu for as long as it is open.
 * Ephemeral by construction — never persisted, never in history, never in the document.
 */
export interface ContinuationOffer extends MaterializedContinuation {
  trigger: ContinuationTrigger;
}

const CONTINUATION_PREFERENCE = 'continuation';

/** On unless the device says otherwise. Read once at startup; a preference store that is not
 *  usable at that moment (blocked storage, a test harness still wiring up) means "on". */
function initialContinuationsEnabled(): boolean {
  try {
    return readPreference(CONTINUATION_PREFERENCE) !== 'off';
  } catch {
    return true;
  }
}


export interface UiStore {
  /** The preset a canvas click will place, or null for plain selection. */
  armed: Preset | null;
  shortcutsOpen: boolean;
  exportOpen: boolean;
  aboutOpen: boolean;
  /** Canvas Settings — background image and personality preset (Phase 5). */
  settingsOpen: boolean;
  toasts: Toast[];
  quickConnect: QuickConnectState | null;
  contextMenu: ContextMenuState | null;
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
  /** Whether the Flows panel — the one surface for flows (`FlowPanel.tsx`) — is visible. */
  flowPanelOpen: boolean;
  /**
   * A flow id the panel should open in rename mode, with its title selected — set by every
   * "new flow" entry point so naming is part of creating, not a separate errand. One-shot, like
   * `editRequestId`: `FlowPanel` consumes and clears it, so a remount (leaving present mode) or a
   * document switch never re-enters rename mode on its own.
   */
  flowRenameRequestId: string | null;
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
  /** The version whose About → What's New notes this device has acknowledged — see
   *  `releases/productReleases.ts`'s `readLastSeenRelease`/`markLastSeenRelease`. */
  lastSeenProductRelease: string;
  /** Phase 8 — whether the ⌘K command palette is showing. See `CommandPalette.tsx`. */
  commandPaletteOpen: boolean;
  /**
   * The node or edge id the palette's "Jump to" just landed on (Phase 8.3), so its view can flash
   * once. Cleared by the palette itself a moment later — the same shape as `editRequestId`: a
   * one-shot request into memoized views that have no imperative API.
   */
  jumpFlashId: string | null;
  /**
   * A one-shot request for the Export dialog to open with "Selection only" already checked —
   * how the palette's "Export selection…" reaches a dialog that otherwise owns that toggle
   * locally. Consumed (cleared) by `ExportDialog` the moment it opens.
   */
  exportSelectionRequested: boolean;
  /** Intent Continuation's current offer, if any. */
  continuation: ContinuationOffer | null;
  /**
   * Offers the user has waved away this session, pinned to the exact neighborhood they were made
   * in (`dismissalKey`): Escape on a ghost keeps it away for that node until something about that
   * node's connections changes, and no longer. Session-only — cleared on document switch, never
   * saved, never profiled.
   */
  continuationDismissals: ReadonlySet<DismissalKey>;
  /** The device preference for Intent Continuation — on unless switched off in Canvas Settings. */
  continuationsEnabled: boolean;
  /**
   * The node an accepted continuation just created, so its view can play the one-shot "settle"
   * (ghost → real) animation. Same shape and lifecycle as `jumpFlashId`: consumed and cleared by
   * the view itself.
   */
  settleNodeId: string | null;
  /** Phase 7.4 — "Learn Draft Canvas" mode. Deliberately not persisted: an opt-in pass a user
   *  asks for each time, never a saved setting — see `HintStrip.tsx`, which shows a hint
   *  regardless of its own retired state while this is true. */
  learnModeActive: boolean;

  /** The homepage search box's current query — see `LibraryScreen.tsx`. Matches
   *  against canvas title and project name (see that file's search-filter comment
   *  for the future, content-indexing extension point this deliberately defers). */
  librarySearchQuery: string;
  /** The homepage's chosen sort for the visible canvas list. */
  librarySort: 'updatedAt' | 'createdAt' | 'name';
  /** Which slice of the library the homepage is showing — the sidebar's selection. */
  libraryView: { kind: 'recent' | 'all' | 'unorganized' | 'project'; projectId?: string };
  /** The canvas id whose "move to project" popover is open, if any — see `MoveToProjectMenu.tsx`. */
  moveMenuOpenFor: string | null;
  /**
   * A pending "may we read your clipboard?" ask — see `ClipboardPermissionDialog.tsx` and
   * `lib/clipboardPermission.ts`'s `requestClipboardRead`, the only caller. Holds the resolver for
   * the promise that call is awaiting, since the dialog's outcome (Allow / Not now / dismissed) is
   * necessarily async and there is exactly one such ask in flight at a time.
   */
  clipboardPermissionRequest: { resolve: (allowed: boolean) => void } | null;

  arm: (preset: Preset | null) => void;
  setShortcutsOpen: (open: boolean) => void;
  setExportOpen: (open: boolean) => void;
  setAboutOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setQuickConnect: (state: QuickConnectState | null) => void;
  setContextMenu: (state: ContextMenuState | null) => void;
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
  requestFlowRename: (flowId: string | null) => void;
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
  /** Records that this device has now seen every currently-applicable release's notes —
   *  called only when About → What's New is actually opened, never just from having the app
   *  open (unlike `learning/useNewFeature.ts`'s similar-looking but deliberately different
   *  `last-seen-version`, which re-stamps on every mount). */
  markProductReleaseSeen: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  requestExportSelection: (requested: boolean) => void;
  setJumpFlashId: (id: string | null) => void;
  setLearnModeActive: (active: boolean) => void;
  /** Identity-preserving: an offer equal in trigger, rule, anchor and neighborhood keeps the node
   *  and edge ids already held (re-keying the fresh geometry onto them), so unrelated document
   *  changes never re-mint a ghost's React keys. */
  setContinuation: (offer: ContinuationOffer | null) => void;
  /** Waves the current offer away for as long as its anchor's neighborhood stays the same. */
  dismissContinuation: () => void;
  /** On document switch: nothing about the previous diagram's offers applies to the next. */
  resetContinuation: () => void;
  setContinuationsEnabled: (enabled: boolean) => void;
  setSettleNodeId: (id: string | null) => void;
  setLibrarySearchQuery: (query: string) => void;
  setLibrarySort: (sort: UiStore['librarySort']) => void;
  setLibraryView: (view: UiStore['libraryView']) => void;
  setMoveMenuOpenFor: (id: string | null) => void;
  /** Opens the pre-permission dialog and resolves once the user answers — `true` for "Allow
   *  clipboard access", `false` for "Not now" or a dismissal (Escape/outside click). */
  requestClipboardPermission: () => Promise<boolean>;
  /** Answers the pending request from `requestClipboardPermission`, if any, and closes the dialog. */
  resolveClipboardPermissionRequest: (allowed: boolean) => void;
}

let toastId = 0;

/** Set by `registerActivateUpdate`; kept outside the store's own state since
 *  it's a function reference, not something a component should re-render on. */
let activateFn: (() => void) | null = null;

export const useUiStore = create<UiStore>((set, get) => ({
  armed: null,
  shortcutsOpen: false,
  exportOpen: false,
  aboutOpen: false,
  settingsOpen: false,
  toasts: [],
  quickConnect: null,
  contextMenu: null,
  attachArmedTarget: null,
  attachArmedEdgeTarget: null,
  reconnectHoverTarget: null,
  reconnectDragActive: false,
  armedAnchor: null,
  openAttachmentDetail: null,
  presentationReveal: null,
  flowPanelOpen: false,
  flowRenameRequestId: null,
  interactionActive: false,
  editRequestId: null,
  updateReady: false,
  lastSeenProductRelease: readLastSeenRelease(),
  commandPaletteOpen: false,
  exportSelectionRequested: false,
  jumpFlashId: null,
  learnModeActive: false,
  continuation: null,
  continuationDismissals: new Set<DismissalKey>(),
  continuationsEnabled: initialContinuationsEnabled(),
  settleNodeId: null,
  librarySearchQuery: '',
  librarySort: 'updatedAt',
  libraryView: { kind: 'recent' },
  moveMenuOpenFor: null,
  clipboardPermissionRequest: null,

  arm: (armed) => set({ armed }),
  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),
  setExportOpen: (exportOpen) => set({ exportOpen }),
  setAboutOpen: (aboutOpen) => set({ aboutOpen }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setQuickConnect: (quickConnect) => set({ quickConnect }),
  setContextMenu: (contextMenu) => set({ contextMenu }),
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
  requestFlowRename: (flowRenameRequestId) => set({ flowRenameRequestId }),
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
  markProductReleaseSeen: () => {
    markLastSeenRelease();
    set({ lastSeenProductRelease: PRODUCT.version });
  },
  setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen }),
  requestExportSelection: (exportSelectionRequested) => set({ exportSelectionRequested }),
  setJumpFlashId: (jumpFlashId) =>
    set((state) => (state.jumpFlashId === jumpFlashId ? state : { jumpFlashId })),
  setLearnModeActive: (learnModeActive) => set({ learnModeActive }),
  setContinuation: (next) =>
    set((state) => {
      const previous = state.continuation;
      if (previous === next) return state;
      if (!sameOffer(previous, next)) return { continuation: next };
      if (!previous || !next) return { continuation: next };
      return { continuation: reidentify(previous, next) };
    }),
  dismissContinuation: () =>
    set((state) => {
      const offer = state.continuation;
      if (!offer) return state;
      const continuationDismissals = new Set(state.continuationDismissals);
      continuationDismissals.add(dismissalKey(offer.anchorId, offer.ruleId, offer.neighborhoodKey));
      return { continuation: null, continuationDismissals };
    }),
  resetContinuation: () => set({ continuation: null, continuationDismissals: new Set<DismissalKey>(), settleNodeId: null }),
  setContinuationsEnabled: (continuationsEnabled) => {
    writePreference(CONTINUATION_PREFERENCE, continuationsEnabled ? 'on' : 'off');
    set((state) => ({ continuationsEnabled, continuation: continuationsEnabled ? state.continuation : null }));
  },
  setSettleNodeId: (settleNodeId) => set((state) => (state.settleNodeId === settleNodeId ? state : { settleNodeId })),
  setLibrarySearchQuery: (librarySearchQuery) => set({ librarySearchQuery }),
  setLibrarySort: (librarySort) => set({ librarySort }),
  setLibraryView: (libraryView) => set({ libraryView }),
  setMoveMenuOpenFor: (moveMenuOpenFor) => set({ moveMenuOpenFor }),
  requestClipboardPermission: () =>
    new Promise<boolean>((resolve) => set({ clipboardPermissionRequest: { resolve } })),
  resolveClipboardPermissionRequest: (allowed) => {
    get().clipboardPermissionRequest?.resolve(allowed);
    set({ clipboardPermissionRequest: null });
  },
}));

/**
 * Whether two offers are *the same suggestion* — same trigger, same rule, same anchor, same
 * neighborhood. That quadruple is already a deterministic fingerprint of "what this offer is"
 * (see `continuation/context.ts`'s `neighborhoodKey`), so it alone decides identity. Position is
 * deliberately excluded: a fresh `materialize()` can legitimately place the same logical offer a
 * few pixels differently as unrelated nodes move, and treating that as a *different* offer was the
 * flicker — a new object, with new random node/edge ids from `materialize`, remounted the ghost's
 * whole DOM subtree and replayed its mount-in animation on every unrelated edit.
 */
function sameOffer(a: ContinuationOffer | null, b: ContinuationOffer | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.trigger === b.trigger &&
    a.ruleId === b.ruleId &&
    a.anchorId === b.anchorId &&
    a.neighborhoodKey === b.neighborhoodKey
  );
}

/**
 * Re-keys a freshly materialized offer onto the ids of the offer it is replacing. `materialize()`
 * mints fresh node/edge ids on every call, so without this, every recompute of the *same* offer
 * (per `sameOffer`) would still hand the ghost a brand-new key set. Fragment order is deterministic
 * for a given rule, so pairing by index is safe. Falls back to `next` unmerged if the shapes ever
 * disagree — should not happen for equal `neighborhoodKey`s, but a rule's fragment must never be
 * able to crash the store.
 */
function reidentify(previous: ContinuationOffer, next: ContinuationOffer): ContinuationOffer {
  if (previous.nodes.length !== next.nodes.length || previous.edges.length !== next.edges.length) return next;
  const idMap = new Map(next.nodes.map((node, i) => [node.id, previous.nodes[i]!.id]));
  const nodes = next.nodes.map((node, i) => ({ ...node, id: previous.nodes[i]!.id }));
  const edges = next.edges.map((edge, i) => ({
    ...edge,
    id: previous.edges[i]!.id,
    source: idMap.get(edge.source) ?? edge.source,
    target: idMap.get(edge.target) ?? edge.target,
  }));
  return { ...next, nodes, edges, primaryNodeId: nodes[0]!.id };
}

/**
 * The last pointer position in canvas coordinates.
 *
 * Kept outside React deliberately: keyboard shortcuts need to know where the
 * cursor is so a new note appears under it, and re-rendering the canvas on
 * every mouse move to track that would be absurd.
 */
export const pointer = { x: 0, y: 0, known: false };
