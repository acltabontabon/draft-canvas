import { create } from 'zustand';
import type { Preset } from '../canvas/presets';
import { ANY_CANDIDATE, dismissalKey } from '../continuation/dismissal';
import type { DismissalKey, MaterializedContinuation } from '../continuation';
import type { Side } from '../document/types';
import type { RecipeCategory } from '../learn/types';
import type { PresentationReveal } from '../presentation/presentationAttachments';
import { readPreference, writePreference } from '../lib/preferences';
import { PRODUCT } from '../product';
import { markLastSeenRelease, readLastSeenRelease } from '../releases/seen';

/** A toast's one optional button — e.g. "Undo" for something that was just removed. */
export type ToastAction = { label: string; run: () => void };
export type Toast = { id: number; message: string; tone: 'info' | 'error'; action?: ToastAction };

/**
 * Drives the small type-picker menu (`QuickConnectMenu`) for the two
 * gestures that need to ask "what should appear here?" rather than guessing:
 * a connection handle dragged onto empty canvas (`source` present — the
 * chosen type is created *and* wired to `source`), and a double-click on
 * empty canvas with no tool armed (`source` absent — the chosen type is
 * simply created at `flowPosition`) — plus `]` on a shape continuation has
 * no suggestion for (`asked`), which asks the same question back instead of
 * doing nothing. Screen coordinates are fixed for the life of the menu so it
 * does not drift if the user pans while choosing.
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
  /**
   * Opened by `]` on a shape Draft Canvas won't guess for, rather than by a drop: there is no
   * point anyone let go of, so a row is placed beside `source` the way a `]` suggestion would be
   * (`flowPosition` only when nothing fits) — see `offerFor`.
   */
  asked?: boolean;
  /** One line above the rows saying why there is no suggestion (`continuation/ambiguity.ts`). */
  note?: string;
}

/** The specific anchor (side + offset, one of `ANCHOR_OFFSETS`) a reconnect
 *  drag is currently hovering, and which node it's on — see `armedAnchor`. */
export interface ArmedAnchor {
  nodeId: string;
  side: Side;
  offset: number;
}

/** A Note/Code card standing in as its own capsule mid-drag — see `dragCapsule` below and
 *  `src/canvas/dragCapsule.ts` for when a card collapses into one. */
export interface DragCapsuleState {
  nodeId: string;
  /** Where the grab landed on the card, in flow units from its top-left. The capsule is drawn
   *  from here, so it stays under the cursor no matter which corner of a large card was grabbed. */
  offsetX: number;
  offsetY: number;
  /** A small lean toward an armed connector's landing point, in screen pixels. Zero otherwise. */
  nudgeX: number;
  nudgeY: number;
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
  trigger: 'select' | 'drop';
  /**
   * Every candidate id the user could cycle to from here, best first (this offer's own `id`
   * included). Only `'select'` offers carry it; one entry or none means there is nothing to cycle.
   */
  alternatives?: readonly string[];
}

/**
 * The candidate the user cycled to (or asked for with `]`) at one anchor. Pinned to the
 * neighborhood it was chosen in: once that changes — an accept, a new connector — the choice no
 * longer applies and the quiet suggestion takes over again.
 */
export interface ContinuationCycle {
  anchorId: string;
  neighborhoodKey: string;
  candidateId: string;
}

/** How many accepted continuations the session remembers for ranking. */
const RECENT_LIMIT = 12;

/** How long accepted nodes keep their one-shot settle marker — just past the 180 ms animation. */
const SETTLE_MS = 240;
let settleTimer: ReturnType<typeof setTimeout> | undefined;

const CONTINUATION_PREFERENCE = 'continuation';
const NO_MOVING_NODES: ReadonlySet<string> = new Set();

/** The change that puts the arrival note away — nothing at all when it was not up, so opening
 *  Takeaways never pulses the chip for a note that was never there. */
const settledRecall = (state: Pick<UiStore, 'takeawaysRecall' | 'takeawaysChipPulse'>) =>
  state.takeawaysRecall ? { takeawaysRecall: false, takeawaysChipPulse: state.takeawaysChipPulse + 1 } : {};

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
  /** Canvas Settings — background image and personality preset. */
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
   * The Note/Code card currently collapsed into its drag capsule, and where on that card the
   * grab started (`offsetX`/`offsetY`, in flow units from its own top-left — the aim point).
   *
   * Written twice per gesture, not per frame: the capsule is rendered *inside* the dragged node
   * (`DraftNodeView.tsx`), so React Flow's own transform is what moves it and nothing re-renders
   * while the pointer travels. Every other node's selector reads a stable `null`.
   */
  dragCapsule: DragCapsuleState | null;
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
   * The element a presenter clicked open while presenting — a chip on a connector, or a node's
   * attachment badge. Presentation Mode's callout shows that element's attachments instead of
   * whatever the step would say on its own (`resolvePresentationSubject`). A read-only counterpart
   * to `openAttachmentDetail`, kept separate because that one also unlocks editing, which
   * presentation must never do. Scoped to the step it was made on (`presentationScope`), so it
   * never speaks for an unrelated later step; clicking the same element again, or Escape, lets it go.
   */
  presentationReveal: PresentationReveal | null;
  /** Whether the Flows panel — the one surface for flows (`FlowPanel.tsx`) — is visible. */
  flowPanelOpen: boolean;
  /**
   * Whether the Takeaways surface (`TakeawaysPanel.tsx`) is showing, and which of its two faces.
   * `'actions'` is the working list during the meeting; `'readout'` is everything the discussion
   * produced, for the end of it. One surface, two states, rather than two panels.
   */
  takeawaysOpen: boolean;
  takeawaysView: 'actions' | 'readout';
  /**
   * Whether the one-line action capture is open. Deliberately separate from `takeawaysOpen`: the
   * whole point is that capturing costs one key and doesn't make you look at a list, so the line
   * can be up with the panel shut — and, unlike every other panel, while presenting.
   */
  actionCaptureOpen: boolean;
  /**
   * Whether the arrival card is up — the third face of the Takeaways surface, shown once when a
   * canvas that still owes something is opened (`takeaways/recall.ts`). Set *after* `setDocument`,
   * which clears this alongside the rest of the per-document UI state.
   */
  takeawaysRecall: boolean;
  /**
   * Bumped when the arrival card settles, so `TakeawaysChip` can pulse once as it receives it.
   * A counter rather than a boolean: two recalls in a row must both be visible, and a flag that is
   * already `true` would animate nothing the second time.
   */
  takeawaysChipPulse: number;
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
   * The nodes the in-flight gesture is moving or resizing (empty otherwise). Their committed rects
   * are stale until it ends, so a connector touching one skips obstacle avoidance for the gesture
   * and every other connector just leaves them out — instead of every connector on the canvas
   * dropping its detours the moment anything moves.
   */
  movingNodeIds: ReadonlySet<string>;
  /**
   * A node or edge id that `Enter` just asked to start editing. There is no
   * ref-based imperative API into the memoized node/edge components, so this
   * is the simplest hook: they watch it via an effect and clear it once
   * editing has actually started.
   */
  editRequestId: string | null;
  /** True once a newer app build has finished downloading in the background
   *  and is waiting to be activated — see `serviceWorker.ts`
   *  and `AboutDialog.tsx`'s update-ready state. */
  updateReady: boolean;
  /** The version whose About → What's New notes this device has acknowledged — see
   *  `releases/seen.ts`'s `readLastSeenRelease`/`markLastSeenRelease`. */
  lastSeenProductRelease: string;
  /** Whether the ⌘K command palette is showing. See `CommandPalette.tsx`. */
  commandPaletteOpen: boolean;
  /**
   * What the palette should already have typed in it when it opens, so a surface that knows which
   * command it means can hand the user straight to it rather than to a blank search. Cleared by
   * every ordinary open, so ⌘K is always a fresh start.
   */
  commandPaletteQuery: string;
  /**
   * The node or edge id the palette's "Jump to" just landed on, so its view can flash
   * once. Cleared by the palette itself a moment later — the same shape as `editRequestId`: a
   * one-shot request into memoized views that have no imperative API.
   */
  jumpFlashId: string | null;
  /**
   * The id of a document that has just arrived and still needs its opening viewport computed —
   * set once as it arrives (see `arriveWith` in `useDocumentSession.ts`) for a genuine new open,
   * never for reopening the canvas already on screen or for a freshly created one (which already
   * carries the right viewport, or none is needed). `Canvas.tsx` consumes it — clears it back to
   * `null` — the moment it can measure the pane and fit the diagram, so it can never re-fire from
   * an edit, an autosave, or an ordinary rerender.
   */
  openFitDocumentId: string | null;
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
  /** The alternative the user cycled to at the selected node, if they did. */
  continuationCycle: ContinuationCycle | null;
  /**
   * Rule ids of recently accepted continuations, newest last — a light ranking hint ("you keep
   * adding Data Stores") and nothing more. Session-only: cleared on document switch, never saved.
   */
  continuationRecent: readonly string[];
  /**
   * The nodes an accepted continuation just created, so their views can play the one-shot "settle"
   * (ghost → real) animation. Each view consumes and clears its own id.
   */
  settleNodeIds: readonly string[];
  /**
   * The one-shot "the shape opened into a room" (or closed back into a shape) animation: which way
   * it goes, the shape it belongs to, and the screen rectangle it starts from — the room in the
   * shape's depth glyph going in, the room's frame coming out (null: the room had no frame, so the
   * canvas). Where it ends is measured live, frame by frame, since the camera is still gliding.
   *
   * Purely visual, and deliberately set *after* the navigation it illustrates: the editor is
   * already showing the new room by the time this arrives, so nothing about being in the right
   * place waits on an animation, and mashing ⌘↓/⌘↑ can only ever replace one token with the next.
   */
  /**
   * The two directions of one link between the depth map (`DepthStack`) and the canvas.
   * `depthPlateFocusId`: a shape whose plate is hovered or focused in the panel — the canvas shows
   * that shape's layer, so "which one is that?" is answered on the drawing. `depthShapeHoverId`: a
   * shape with an inside the pointer is over on the canvas — an open panel lights its plate. Both
   * purely visual and never persisted.
   */
  depthPlateFocusId: string | null;
  depthShapeHoverId: string | null;
  /** "No thanks" to treating a canvas as a system overview — put away for the rest of the session. */
  overviewOfferDismissed: boolean;

  dismissOverviewOffer: () => void;
  depthTransition: {
    id: number;
    direction: 'in' | 'out';
    nodeId: string;
    from: { x: number; y: number; width: number; height: number } | null;
  } | null;
  /**
   * The Learn drawer (`ui/learn/LearnDrawer.tsx`) and where it was left. Session memory only:
   * reopening Learn returns to the recipe or search you were on, a reload starts at its home.
   * `learnRecipeId` null means the home view; `learnCategory` is the Explore filter, if any.
   */
  learnOpen: boolean;
  learnRecipeId: string | null;
  learnQuery: string;
  learnCategory: RecipeCategory | null;
  /** Bumped by every `openLearn`, so a drawer that is already open still takes focus. */
  learnFocusRequest: number;
  /** Whether the latest `openLearn` still wants focus. Consumed by the drawer, so a drawer that merely
   *  remounts (after a presentation, or on the next document) doesn't pull focus off the canvas. */
  learnFocusPending: boolean;

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
  setDragCapsule: (dragCapsule: DragCapsuleState | null) => void;
  setReconnectHoverTarget: (nodeId: string | null) => void;
  setReconnectDragActive: (active: boolean) => void;
  setArmedAnchor: (anchor: ArmedAnchor | null) => void;
  setOpenAttachmentDetail: (
    target: { hostKind: 'node' | 'edge'; hostId: string; attachmentId: string | null } | null,
  ) => void;
  setPresentationReveal: (target: PresentationReveal | null) => void;
  setFlowPanelOpen: (open: boolean) => void;
  requestFlowRename: (flowId: string | null) => void;
  /** Opens Takeaways on one of its two faces, or closes it. */
  setTakeawaysOpen: (open: boolean, view?: 'actions' | 'readout') => void;
  setTakeawaysView: (view: 'actions' | 'readout') => void;
  /** Opens or closes the capture line. Opening always shows the actions face behind it, so the
   *  thing you just captured is where you'd look for it. */
  setActionCaptureOpen: (open: boolean) => void;
  /** Raises the arrival card, or settles it — settling also pulses the chip it returns to. */
  setTakeawaysRecall: (open: boolean) => void;
  setInteractionActive: (active: boolean, movingNodeIds?: Iterable<string>) => void;
  requestEdit: (id: string | null) => void;
  notify: (message: string, tone?: Toast['tone'], action?: ToastAction) => void;
  dismiss: (id: number) => void;
  /** Holds every toast's auto-dismiss while the pointer or focus is on them, so there's time to
   *  read one — or reach its action — and restarts the countdowns once it leaves. */
  pauseToasts: () => void;
  resumeToasts: () => void;
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
   *  open. */
  markProductReleaseSeen: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
  openCommandPaletteAt: (query: string) => void;
  requestExportSelection: (requested: boolean) => void;
  setJumpFlashId: (id: string | null) => void;
  /** Marks `documentId` as just arrived and awaiting its opening viewport fit. */
  requestOpenFit: (documentId: string) => void;
  /** Consumes the pending fit for `documentId` — a no-op if a newer request has already replaced
   *  it, so a stale caller can never clear a request that isn't its own. */
  clearOpenFit: (documentId: string) => void;
  /** Opens Learn — on `recipeId` when given (a deep link always wins), else where it was left. */
  openLearn: (recipeId?: string) => void;
  closeLearn: () => void;
  /** Reads and clears `learnFocusPending`. */
  takeLearnFocus: () => boolean;
  /** Home (`null`) or one recipe, inside the drawer. */
  showLearnRecipe: (recipeId: string | null) => void;
  setLearnQuery: (query: string) => void;
  setLearnCategory: (category: RecipeCategory | null) => void;
  /** Identity-preserving: an offer equal in trigger, rule, anchor and neighborhood keeps the node
   *  and edge ids already held (re-keying the fresh geometry onto them), so unrelated document
   *  changes never re-mint a ghost's React keys. */
  setContinuation: (offer: ContinuationOffer | null) => void;
  /**
   * Waves continuation away at the offer's anchor — every candidate, not just the one showing —
   * for as long as that anchor's neighborhood stays the same. Asking again with `]` still works.
   */
  dismissContinuation: () => void;
  /** Moves the showing offer to the next (`+1`) or previous (`-1`) alternative, wrapping. */
  cycleContinuation: (delta: 1 | -1) => void;
  /** Pins a chosen candidate (or clears the choice with `null`). */
  setContinuationCycle: (cycle: ContinuationCycle | null) => void;
  /** Remembers an accepted continuation's rule for ranking. */
  recordContinuationAccepted: (ruleId: string) => void;
  /** On document switch: nothing about the previous diagram's offers applies to the next. */
  resetContinuation: () => void;
  setContinuationsEnabled: (enabled: boolean) => void;
  setDepthPlateFocusId: (id: string | null) => void;
  setDepthShapeHoverId: (id: string | null) => void;
  /** Plays (or clears) the depth transition — see `depthTransition`. */
  setDepthTransition: (transition: UiStore['depthTransition']) => void;
  /** Marks freshly accepted nodes for their settle animation; the marker expires on its own. */
  setSettleNodeIds: (ids: readonly string[]) => void;
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
/** The most toasts on screen at once; a new one past this retires the oldest. */
const MAX_TOASTS = 3;
/** Remaining display time per toast, with the running timer when not paused. */
const toastTimers = new Map<number, { remaining: number; startedAt: number; handle: ReturnType<typeof setTimeout> | null }>();
let toastsPaused = false;

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
  dragCapsule: null,
  reconnectHoverTarget: null,
  reconnectDragActive: false,
  armedAnchor: null,
  openAttachmentDetail: null,
  presentationReveal: null,
  flowPanelOpen: false,
  flowRenameRequestId: null,
  takeawaysOpen: false,
  takeawaysView: 'actions',
  actionCaptureOpen: false,
  takeawaysRecall: false,
  takeawaysChipPulse: 0,
  interactionActive: false,
  movingNodeIds: NO_MOVING_NODES,
  editRequestId: null,
  updateReady: false,
  lastSeenProductRelease: readLastSeenRelease(),
  commandPaletteOpen: false,
  commandPaletteQuery: '',
  exportSelectionRequested: false,
  jumpFlashId: null,
  openFitDocumentId: null,
  learnOpen: false,
  learnRecipeId: null,
  learnQuery: '',
  learnCategory: null,
  learnFocusRequest: 0,
  learnFocusPending: false,
  continuation: null,
  continuationDismissals: new Set<DismissalKey>(),
  continuationsEnabled: initialContinuationsEnabled(),
  continuationCycle: null,
  continuationRecent: [],
  settleNodeIds: [],
  depthTransition: null,
  depthPlateFocusId: null,
  depthShapeHoverId: null,
  overviewOfferDismissed: false,
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
  setDragCapsule: (dragCapsule) =>
    set((state) => {
      const current = state.dragCapsule;
      if (current === dragCapsule) return state;
      // The nudge changes while an edge stays armed, so identity alone isn't enough to tell a
      // real change from a repeat — but every field matching still means nothing to re-render.
      if (
        current &&
        dragCapsule &&
        current.nodeId === dragCapsule.nodeId &&
        current.offsetX === dragCapsule.offsetX &&
        current.offsetY === dragCapsule.offsetY &&
        current.nudgeX === dragCapsule.nudgeX &&
        current.nudgeY === dragCapsule.nudgeY
      ) {
        return state;
      }
      return { dragCapsule };
    }),
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
  // Opening Takeaways, or the capture line, by any route means the arrival note has done its job —
  // it exists to teach where they live — and both are drawn over the very corner it hangs in, so
  // leaving it up would stack the note under the thing it was pointing at. Settled the same way
  // `setTakeawaysRecall(false)` does, pulse included.
  setTakeawaysOpen: (takeawaysOpen, view) =>
    // Closing also puts the surface back on its working face: reopening it mid-meeting should
    // show the list you are still adding to, not the summary you read once at the end.
    set((state) =>
      takeawaysOpen
        ? { takeawaysOpen, ...(view ? { takeawaysView: view } : {}), ...settledRecall(state) }
        : { takeawaysOpen: false, takeawaysView: 'actions' },
    ),
  setTakeawaysView: (takeawaysView) => set({ takeawaysView }),
  setActionCaptureOpen: (actionCaptureOpen) =>
    set((state) =>
      actionCaptureOpen
        ? { actionCaptureOpen, takeawaysView: 'actions', ...settledRecall(state) }
        : { actionCaptureOpen: false },
    ),
  setTakeawaysRecall: (takeawaysRecall) =>
    // Settling is what teaches where the thing lives, so the pulse is part of closing rather than
    // a second call a caller could forget to make.
    set((state) =>
      takeawaysRecall
        ? { takeawaysRecall: true }
        : // Only a card that was actually up has something to settle back: pulsing on a close that
          // closed nothing would blink the chip every time a document was swapped.
          { takeawaysRecall: false, takeawaysChipPulse: state.takeawaysChipPulse + (state.takeawaysRecall ? 1 : 0) },
    ),
  setInteractionActive: (interactionActive, movingNodeIds) =>
    set((state) => {
      const moving = interactionActive && movingNodeIds ? new Set(movingNodeIds) : NO_MOVING_NODES;
      if (state.interactionActive === interactionActive && moving.size === 0 && state.movingNodeIds.size === 0) {
        return state;
      }
      return { interactionActive, movingNodeIds: moving.size === 0 ? NO_MOVING_NODES : moving };
    }),
  requestEdit: (editRequestId) => set({ editRequestId }),

  notify(message, tone = 'info', action) {
    // The same message again (a paste refused twice in a row) restarts the one already showing
    // rather than stacking a copy; and only the newest few stay, so a burst can't bury the canvas.
    const repeat = get().toasts.find((t) => t.message === message && t.tone === tone && t.action?.label === action?.label);
    if (repeat) get().dismiss(repeat.id);
    const overflow = get().toasts.slice(0, Math.max(0, get().toasts.length - (MAX_TOASTS - 1)));
    for (const old of overflow) get().dismiss(old.id);
    toastId += 1;
    const toast: Toast = { id: toastId, message, tone, ...(action ? { action } : {}) };
    set((state) => ({ toasts: [...state.toasts, toast] }));
    // An action needs time to be reached, not just read.
    const remaining = tone === 'error' ? 8000 : action ? 6000 : 3500;
    const timer = { remaining, startedAt: Date.now(), handle: null as ReturnType<typeof setTimeout> | null };
    toastTimers.set(toast.id, timer);
    if (!toastsPaused) timer.handle = setTimeout(() => get().dismiss(toast.id), remaining);
  },

  dismiss: (id) => {
    const timer = toastTimers.get(id);
    if (timer?.handle) clearTimeout(timer.handle);
    toastTimers.delete(id);
    // The last toast leaving from under a still pointer may never fire a pointer-leave; nothing
    // is left to hold open, so the next toast must count down normally.
    if (toastTimers.size === 0) toastsPaused = false;
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },

  pauseToasts: () => {
    if (toastsPaused) return;
    toastsPaused = true;
    const now = Date.now();
    for (const timer of toastTimers.values()) {
      if (!timer.handle) continue;
      clearTimeout(timer.handle);
      timer.handle = null;
      timer.remaining = Math.max(0, timer.remaining - (now - timer.startedAt));
    }
  },

  resumeToasts: () => {
    if (!toastsPaused) return;
    toastsPaused = false;
    const now = Date.now();
    for (const [id, timer] of toastTimers) {
      timer.startedAt = now;
      // Never snatched away the instant the pointer leaves.
      timer.handle = setTimeout(() => get().dismiss(id), Math.max(timer.remaining, 1500));
    }
  },

  setUpdateReady: () => set({ updateReady: true }),
  registerActivateUpdate: (activate) => {
    activateFn = activate;
  },
  activateUpdate: () => activateFn?.(),
  markProductReleaseSeen: () => {
    markLastSeenRelease();
    set({ lastSeenProductRelease: PRODUCT.version });
  },
  setCommandPaletteOpen: (commandPaletteOpen) => set({ commandPaletteOpen, commandPaletteQuery: '' }),
  openCommandPaletteAt: (commandPaletteQuery) => set({ commandPaletteOpen: true, commandPaletteQuery }),
  requestExportSelection: (exportSelectionRequested) => set({ exportSelectionRequested }),
  setJumpFlashId: (jumpFlashId) =>
    set((state) => (state.jumpFlashId === jumpFlashId ? state : { jumpFlashId })),
  requestOpenFit: (documentId) => set({ openFitDocumentId: documentId }),
  clearOpenFit: (documentId) =>
    set((state) => (state.openFitDocumentId === documentId ? { openFitDocumentId: null } : state)),
  openLearn: (recipeId) =>
    set((state) => ({
      learnOpen: true,
      learnFocusRequest: state.learnFocusRequest + 1,
      learnFocusPending: true,
      ...(recipeId ? { learnRecipeId: recipeId } : {}),
    })),
  closeLearn: () => set({ learnOpen: false }),
  takeLearnFocus: () => {
    const pending = get().learnFocusPending;
    if (pending) set({ learnFocusPending: false });
    return pending;
  },
  showLearnRecipe: (learnRecipeId) => set({ learnRecipeId }),
  setLearnQuery: (learnQuery) => set({ learnQuery }),
  setLearnCategory: (learnCategory) => set({ learnCategory }),
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
      continuationDismissals.add(dismissalKey(offer.anchorId, ANY_CANDIDATE, offer.neighborhoodKey));
      return { continuation: null, continuationDismissals, continuationCycle: null };
    }),
  cycleContinuation: (delta) =>
    set((state) => {
      const offer = state.continuation;
      const ids = offer?.alternatives ?? [];
      if (!offer || offer.trigger !== 'select' || ids.length < 2) return state;
      const index = Math.max(0, ids.indexOf(offer.id));
      const candidateId = ids[(index + delta + ids.length) % ids.length]!;
      return {
        continuationCycle: { anchorId: offer.anchorId, neighborhoodKey: offer.neighborhoodKey, candidateId },
      };
    }),
  setContinuationCycle: (continuationCycle) =>
    set((state) => (sameCycle(state.continuationCycle, continuationCycle) ? state : { continuationCycle })),
  recordContinuationAccepted: (ruleId) =>
    set((state) => ({ continuationRecent: [...state.continuationRecent, ruleId].slice(-RECENT_LIMIT) })),
  resetContinuation: () => {
    clearTimeout(settleTimer);
    set({
      continuation: null,
      continuationDismissals: new Set<DismissalKey>(),
      continuationCycle: null,
      continuationRecent: [],
      settleNodeIds: [],
    });
  },
  setContinuationsEnabled: (continuationsEnabled) => {
    writePreference(CONTINUATION_PREFERENCE, continuationsEnabled ? 'on' : 'off');
    set((state) => ({
      continuationsEnabled,
      continuation: continuationsEnabled ? state.continuation : null,
      continuationCycle: continuationsEnabled ? state.continuationCycle : null,
    }));
  },
  setDepthTransition: (depthTransition) => set({ depthTransition }),
  setDepthPlateFocusId: (depthPlateFocusId) => set({ depthPlateFocusId }),
  // Guarded: a hover fires on every entry and exit, and every write re-runs every subscriber's
  // selector — a few thousand of them on a large diagram — whether or not anything changed.
  setDepthShapeHoverId: (depthShapeHoverId) =>
    set((state) => (state.depthShapeHoverId === depthShapeHoverId ? state : { depthShapeHoverId })),
  dismissOverviewOffer: () => set({ overviewOfferDismissed: true }),
  setSettleNodeIds: (settleNodeIds) => {
    clearTimeout(settleTimer);
    set((state) => (settleNodeIds.length === 0 && state.settleNodeIds.length === 0 ? state : { settleNodeIds }));
    if (settleNodeIds.length === 0) return;
    // One expiry for the whole fragment, owned here rather than by each node's view: a node undone
    // mid-animation unmounts without a chance to clear itself, and would replay on redo.
    settleTimer = setTimeout(() => {
      if (get().settleNodeIds === settleNodeIds) set({ settleNodeIds: [] });
    }, SETTLE_MS);
  },
  setLibrarySearchQuery: (librarySearchQuery) => set({ librarySearchQuery }),
  setLibrarySort: (librarySort) => set({ librarySort }),
  setLibraryView: (libraryView) => set({ libraryView }),
  setMoveMenuOpenFor: (moveMenuOpenFor) => set({ moveMenuOpenFor }),
  requestClipboardPermission: () =>
    new Promise<boolean>((resolve) => {
      // A second ask while the dialog is already up waits on the same answer — replacing the
      // pending resolver would leave the first caller's promise unsettled forever.
      const pending = get().clipboardPermissionRequest;
      set({
        clipboardPermissionRequest: {
          resolve: pending
            ? (allowed) => {
                pending.resolve(allowed);
                resolve(allowed);
              }
            : resolve,
        },
      });
    }),
  resolveClipboardPermissionRequest: (allowed) => {
    get().clipboardPermissionRequest?.resolve(allowed);
    set({ clipboardPermissionRequest: null });
  },
}));

function sameCycle(a: ContinuationCycle | null, b: ContinuationCycle | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.anchorId === b.anchorId && a.neighborhoodKey === b.neighborhoodKey && a.candidateId === b.candidateId;
}

/**
 * Whether two offers are *the same suggestion* — same trigger, same candidate, same anchor, same
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
    a.id === b.id &&
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
 *
 * When nothing changed at all (the common case: an edit somewhere else), `previous` itself comes
 * back, so the ghost doesn't redraw for an edit that isn't about it. Offers are a handful of small
 * plain objects, so comparing their serialized form is cheap and exhaustive.
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
  const continueFromId = idMap.get(next.continueFromId) ?? next.continueFromId;
  const merged = { ...next, nodes, edges, continueFromId };
  return JSON.stringify(merged) === JSON.stringify(previous) ? previous : merged;
}

/**
 * The last pointer position in canvas coordinates.
 *
 * Kept outside React deliberately: keyboard shortcuts need to know where the
 * cursor is so a new note appears under it, and re-rendering the canvas on
 * every mouse move to track that would be absurd.
 */
export const pointer = { x: 0, y: 0, known: false };
