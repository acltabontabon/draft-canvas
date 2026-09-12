import { create } from 'zustand';
import { decodeClipboard, encodeClipboard } from '../document/clipboardCodec';
// Only used for the one-off "pasted/duplicated content was capped" toast (`notify`) — paste and
// duplicate are the only place a document-size limit can be hit from a trusted, in-app action
// rather than at import, and there's no other place in the app that already surfaces that.
import { useUiStore } from './uiStore';
import {
  createAttachment,
  createDocument,
  createEdge,
  createNode,
  defaultSizeFor,
  defaultTextFor,
  type CreateNodeInput,
} from '../document/factory';
import { gapForCaption, horizontalAnchorsFor, type MaterializedContinuation } from '../continuation';
import { getMeasurer } from '../render/text/measure';
import { naturalNoteHeight, naturalTextHeight } from '../nodes/describe';
import {
  addEdges,
  addNodes,
  alignNodes,
  attachToEdge as attachToEdgeOp,
  attachToNode as attachToNodeOp,
  boundsOf,
  bringForward,
  bringToFront,
  detachFromEdge as detachFromEdgeOp,
  detachFromNode,
  distributeNodes,
  extractFragment,
  freeOriginFor,
  hasAttachmentRoom,
  moveNodes,
  pasteFragment,
  placeNear,
  reconnectEdge as reconnectEdgeOp,
  reverseEdge as reverseEdgeOp,
  removeAttachment as removeAttachmentOp,
  removeEdgeAttachment as removeEdgeAttachmentOp,
  removeElements,
  reorderAttachment as reorderAttachmentOp,
  reorderEdgeAttachment as reorderEdgeAttachmentOp,
  sendBackward,
  sendToBack,
  setParent,
  setSettings,
  setTitle,
  setViewport,
  touch,
  updateAttachment as updateAttachmentOp,
  updateEdge,
  updateEdgeAttachment as updateEdgeAttachmentOp,
  updateNode,
  type AlignEdge,
  type Clipboard,
} from '../document/operations';
import { buildStarter, starterSize } from '../starters/build';
import type { ArchitectureStarter } from '../starters/types';
import {
  addFlow,
  createFlow as createFlowEntity,
  addStepToFlow,
  addStepExtraEdge,
  addStepExtraNode,
  deleteFlow,
  findFlow,
  flowHasMembers,
  flowMemberNodeIds,
  moveStepInFlow,
  nextFlowTitle,
  pruneFlowSteps,
  spliceEdgeInFlows,
  removeStepExtraEdge,
  removeStepExtraNode,
  removeStepFromFlow,
  renameFlow,
  setFlowAccent as setFlowAccentOp,
  setStepViewport,
  updateFlowStepCaption as updateFlowStepCaptionOp,
} from '../document/flow';
import { relationshipCaptionLabel, SEMANTIC_DEFAULTS } from '../document/edgeSemantics';
import { DEFAULTS } from '../document/limits';
import {
  capabilityFor,
  categoryOf,
  inferredJunctionSemantic,
  inferRelationship,
  isEligibleForReinference,
  resolveTransparentCategory,
} from '../document/connectorSemantics';
import type {
  Accent,
  AttachableType,
  Attachment,
  DraftDocument,
  DraftEdge,
  DraftFlow,
  DraftNode,
  ConnectorKind,
  DatabaseKind,
  DraftSettings,
  DraftViewport,
  EdgeSemantic,
  QueueKind,
  RouteMode,
  ServiceKind,
  Side,
} from '../document/types';
import { routingPlan } from '../edges/bundles';
import { anchorPoint, rectOf, trunkCoordinate } from '../edges/routing';
import { centerOf, clamp } from '../lib/math';
import {
  EMPTY_HISTORY,
  EMPTY_SELECTION,
  canRedo,
  canUndo,
  pushEntry,
  redo as redoStack,
  undo as undoStack,
  type FlowSessionSnapshot,
  type HistoryState,
  type Selection,
} from '../history/HistoryStack';
import type { SaveState } from '../storage/autosave';

export type EditorMode = 'edit' | 'present';

/**
 * Presentation Mode's playback state: which flow is being narrated (`null`
 * while a picker is shown, when playback is active but no flow is chosen
 * yet) and which step it is on. Never persisted, never pushed to history —
 * playing a flow is not an editorial action.
 */
export interface FlowPlaybackState {
  active: boolean;
  flowId: string | null;
  step: number;
  /**
   * Which half of the current step's exchange is animating — irrelevant (and never read) unless
   * the step's primary edge has a `response` (see `DraftEdge.response`). Reset to `'request'` by
   * `useFlowPlayback`'s own effect on every step/flow/active change, regardless of what triggered
   * it — `setFlowPlayback`'s shallow merge means a caller that patches `step` without also patching
   * `phase` would otherwise leave a stale `'response'` bleeding into the next step, so no other call
   * site sets this directly. Absent reads exactly like `'request'`.
   */
  phase?: 'request' | 'response';
}

/**
 * An arbitrary, freely-edited set of nodes/edges to keep lit while everything
 * else fades — a sibling of `FlowPlaybackState`, not a variant of it. Flow
 * playback is ordered and step-indexed; Focus has no ordering and is just as
 * usable in edit mode as in present mode, so folding the two together would
 * force playback's single-current-step shape to also express an arbitrary
 * set. Never persisted, never pushed to history — the same treatment as
 * `flowPlayback`.
 */
export interface FocusState {
  active: boolean;
  nodeIds: string[];
  edgeIds: string[];
}

/**
 * An edge counts as focused if it was explicitly added, or if both of its
 * endpoints are focused nodes — inferred automatically so a user tracing a
 * path through Focus Mode does not have to click every connecting arrow one
 * by one. A kept-separate function (rather than folding inferred membership
 * into `focus.edgeIds` itself) so explicit and inferred membership never get
 * confused when toggling or exiting.
 */
export function isEdgeFocused(
  focus: FocusState,
  edge: { id: string; source: string; target: string },
): boolean {
  if (!focus.active) return false;
  const ids = focusIdSets(focus);
  if (ids.edges.has(edge.id)) return true;
  return ids.nodes.has(edge.source) && ids.nodes.has(edge.target);
}

/** Whether a node is lit by Focus — see `isEdgeFocused`. */
export function isNodeFocused(focus: FocusState, nodeId: string): boolean {
  return focus.active && focusIdSets(focus).nodes.has(nodeId);
}

/** Every node and edge selector asks on every store update while Focus is on; the id lists become
 *  Sets once per focus state rather than being scanned per element. */
const focusSetCache = new WeakMap<FocusState, { nodes: ReadonlySet<string>; edges: ReadonlySet<string> }>();

function focusIdSets(focus: FocusState) {
  let sets = focusSetCache.get(focus);
  if (!sets) focusSetCache.set(focus, (sets = { nodes: new Set(focus.nodeIds), edges: new Set(focus.edgeIds) }));
  return sets;
}

interface Interaction {
  label: string;
  document: DraftDocument;
  selection: Selection;
}

/** The kind of node an "Add <companion>" quick action creates — type plus its sub-kind. */
export type CompanionSpec =
  | { type: 'service'; serviceKind: ServiceKind }
  | { type: 'database'; databaseKind: DatabaseKind }
  | { type: 'queue'; queueKind: QueueKind };

/**
 * Which Service kinds own data of their own — the ones "Add Data Store" makes sense for. An
 * external system's storage is not ours to draw; a scheduler fires jobs and a gateway routes —
 * neither should be shown writing to a store of its own (`service>database`'s own `gateway` row
 * calls that unusual). One list, so the popover and the store can't disagree.
 */
export function ownsData(node: Pick<DraftNode, 'type' | 'serviceKind'>): boolean {
  if (node.type !== 'service') return false;
  const kind = node.serviceKind ?? 'generic';
  return kind === 'generic' || kind === 'api' || kind === 'worker';
}

export interface EditorStore {
  document: DraftDocument;
  history: HistoryState;
  selection: Selection;
  clipboard: Clipboard | null;
  /** Consecutive pastes of unchanged clipboard content, so repeats step
   *  diagonally instead of stacking exactly — see `paste`. */
  pasteRepeat: number;
  save: SaveState;
  mode: EditorMode;
  flowPlayback: FlowPlaybackState;
  focus: FocusState;
  /** The active flow: which flow's step badges show on the canvas, which the Flows panel
   *  highlights, and which a connector's "Add to …" chip appends to. Independent of playback;
   *  never mutates anything by itself. See `lensFlow` for when it also dims the canvas. */
  selectedFlowId: string | null;
  /** Bumped on every document write; autosave watches this rather than deep-diffing. */
  revision: number;
  /**
   * Where the camera actually is, once the user has panned or zoomed since the document was set —
   * `null` until then. Kept out of `document` on purpose: every scroll gesture writing a new
   * document re-rendered everything subscribed to it, stamped `updatedAt` (reordering the
   * Library), and counted as an edit. It is folded back in only where the document leaves the
   * editor — autosave and export — via `documentWithLiveViewport`.
   */
  liveViewport: DraftViewport | null;

  /* Document access */
  setDocument: (document: DraftDocument, options?: { resetHistory?: boolean }) => void;
  apply: (label: string, recipe: (doc: DraftDocument) => DraftDocument, options?: ApplyOptions) => void;

  /* Interactions (drag, resize) collapse into one undo entry */
  beginInteraction: (label: string) => void;
  /** `label` overrides the one `beginInteraction` opened with, when the gesture turned out to be
   *  something else (a drag that ended as an attach). */
  endInteraction: (label?: string) => void;

  /* Editing commands */
  addNode: (input: CreateNodeInput) => DraftNode;
  /** One undoable bulk add. `flows` (a starter's predefined walkthroughs) join the same entry, so
   *  a single ⌘Z takes the whole composition back out — nodes, edges and flows together. */
  addNodesWithEdges: (nodes: DraftNode[], edges: DraftEdge[], label: string, flows?: DraftFlow[]) => void;
  /**
   * Inserts a Starter — a composed opening diagram — as one undoable action, clear of
   * whatever is already on the canvas, and leaves it selected. Returns the nodes it created, the
   * way `addNode` returns the one it created: a caller that wants to move the camera onto them
   * cannot find them in its own `CommandContext`, whose document predates this call. See
   * `src/starters/`.
   */
  insertStarter: (starter: ArchitectureStarter) => DraftNode[];
  /**
   * Accepts an Intent Continuation offer (see `src/continuation/`): the previewed nodes and
   * connectors become real in one undoable step, the offer's primary node is selected (so the
   * next offer can chain from it) and marked to settle in. The offer itself is cleared here, not
   * by the caller, so every accept path — Tab, click, ⌘K — leaves the UI in the same state.
   */
  acceptContinuation: (offer: MaterializedContinuation) => void;
  connect: (
    source: string,
    target: string,
    sourceSide?: Side,
    targetSide?: Side,
    sourceOffset?: number,
    targetOffset?: number,
  ) => DraftEdge | null;
  updateNodeById: (id: string, patch: Partial<Omit<DraftNode, 'id'>>, label?: string) => void;
  /** `height` lets a note commit its grown-to-fit box in the same undo step as the text. */
  updateNodeText: (id: string, text: string, options?: { height?: number }) => void;
  /**
   * Call at every exit from editing a `text` node, with the resulting text — the just-committed
   * value on blur/Enter, or the node's own already-committed `text` on an Escape-revert (which
   * never commits). Deletes the node, as its own undo step, only when it's empty *and* has never
   * received a real commit (`textOrigin` still `'auto'`) — the fix for an abandoned, never-typed
   * Text element that would otherwise sit on the canvas invisible forever. A node whose content was
   * typed and later deliberately cleared (`textOrigin: 'explicit'`) is left alone. No-op for every
   * other node type, and for a `text` node that isn't actually empty.
   */
  finishTextEdit: (id: string, resultingText: string) => void;
  updateEdgeById: (id: string, patch: Partial<Omit<DraftEdge, 'id' | 'source' | 'target'>>, label?: string) => void;
  /** Dragging an existing connector's endpoint to a new node/side. */
  reconnectEdge: (
    id: string,
    endpoint: 'source' | 'target',
    newNodeId: string,
    newSide: Side | undefined,
    newOffset?: number,
  ) => void;
  /** Swaps a connector's source and target (and their anchors) — nothing else. See `reverseEdge`. */
  reverseEdge: (id: string) => void;
  /** The "Insert Worker" quick fix (see `document/connectorSemantics.ts`'s `RelationshipQuickFix`):
   *  replaces one edge with a new Worker service node and two new edges (source→worker,
   *  worker→target), their semantics drawn from the same capability matrix as everywhere else —
   *  one undo step. A no-op if the edge or either endpoint no longer resolves. */
  insertWorkerOnEdge: (edgeId: string) => void;
  /** "Add DLQ" — creates a compact, connected Dead Letter Queue companion for a plain Queue. A
   *  no-op if the node isn't a plain queue, is itself a generated DLQ, or already has one. */
  addDeadLetterQueue: (queueId: string) => void;
  /** Removes a generated DLQ and its connecting edge — never deletes a node the edge was manually
   *  reconnected onto (see `deliveryRole` guard in the implementation). A no-op if there's no
   *  outgoing `deadLetters` edge. */
  removeDeadLetterQueue: (queueId: string) => void;
  /** "Add Consumer" — creates a Worker service connected with whatever semantic/kind the
   *  capability matrix already resolves for this pairing (`consumes` for a queue/stream,
   *  `deliversTo` for a topic — though this is never offered for a topic; see
   *  `commands/registry.ts`). */
  addConsumer: (sourceId: string) => void;
  /** "Add Subscriber" — a Topic's own fan-out companion: creates a Queue connected with the
   *  matrix's `topic>queue` relation (`fansOut`). Repeatable, unlike the DLQ toggle — a topic
   *  fanning out to several queues is normal, so this never becomes "Remove Subscriber"; the
   *  created queue deletes like any other node. A no-op if the node isn't a Topic. */
  addSubscriber: (topicId: string) => void;
  /** "Add Data Store" — a Service's own companion: a Data Store connected with the matrix's
   *  `service>database` relation (`writes`). Repeatable; a no-op for a kind that doesn't own data
   *  (an external system, a scheduler, a gateway — see `commands/registry.ts`). */
  addDataStore: (serviceId: string) => void;
  /** "Add Service" — a Gateway's own companion: a Service it `routes` to. A no-op for a
   *  non-gateway. */
  addRoutedService: (gatewayId: string) => void;
  /**
   * The one motion behind every "Add <companion>" quick action: a new node of `companion`'s kind
   * placed beside `sourceId`, connected with whatever semantic/kind the capability matrix already
   * resolves for the pairing — exactly what a hand-drawn connector between the two would read —
   * as one undo entry that selects the companion. `addConsumer`/`addSubscriber`/`addDataStore`/
   * `addRoutedService` are this with their kind filled in.
   */
  addCompanion: (sourceId: string, companion: CompanionSpec, label: string) => void;
  /** Sets a `deadLetters` edge's delivery-attempts count, clamped to a sane range. */
  setEdgeDeliveryAttempts: (id: string, attempts: number) => void;
  updateEdgeLabel: (id: string, label: string) => void;
  /** Sets (or clears) a semantic type — fills the default label only if the
   *  edge has none, and never touches `accent`. See `document/edgeSemantics.ts`. */
  setEdgeSemantic: (id: string, semantic: EdgeSemantic | undefined) => void;
  /** Free-text condition chip, e.g. "approved" — display only, never evaluated. */
  setEdgeCondition: (id: string, condition: string) => void;
  /** Free-text response chip, e.g. "200 Customer" — display only, see `DraftEdge.response`. */
  setEdgeResponse: (id: string, response: string) => void;
  /** Toggles the reply line's existence, independent of `response`'s text — see `DraftEdge.hasResponse`. */
  setEdgeHasResponse: (id: string, hasResponse: boolean) => void;
  /** Takes one connector's routing out of the router's hands, or hands it back
   *  — see `DraftEdge.routeMode`. */
  setEdgeRouteMode: (id: string, mode: RouteMode | undefined) => void;
  /** Hands every manually-routed connector back to Smart Routing, in one undo
   *  step. Never moves a node, and never touches an anchor. */
  tidyConnections: () => void;
  /** Materializes a real Junction where a connector's shared routing trunk
   *  already appears to branch, and re-points that bundle's members through
   *  it — the deliberate step from automatic routing to explicit control. */
  convertBundleToJunction: (edgeId: string) => void;
  toggleEdgeAsync: (id: string) => void;
  /** Sets (or clears) a connector's flow-behaviour kind — see `ConnectorKind`. */
  setEdgeKind: (id: string, kind: ConnectorKind | undefined) => void;
  commitPositions: (positions: Map<string, { x: number; y: number }>) => void;
  /** Moves every selected node by a pixel delta — repeated taps coalesce. */
  nudgeSelection: (dx: number, dy: number) => void;
  deleteSelection: () => void;
  duplicateSelection: () => void;
  copySelection: () => void;
  /** Copies the selection, then deletes it — one undo entry (the delete). */
  cutSelection: () => void;
  /** `targetCenter` is where the pasted fragment's center should land, in
   *  document coordinates — typically the pointer or current viewport
   *  center. Omitted falls back to a small offset from the fragment's own
   *  original position. `exact: true` (the right-click menu's "Paste at this
   *  point") skips the repeated-paste diagonal stagger `targetCenter` alone
   *  would otherwise still pick up — a deliberate "land exactly here" click
   *  should never drift because an earlier, unrelated paste happened first. */
  paste: (targetCenter?: { x: number; y: number }, options?: { exact?: boolean }) => void;
  /** Decodes clipboard text obtained some other way (a native `paste` event's
   *  `clipboardData`, or `syncClipboardFromSystem`'s own OS read) and, if it's
   *  a Draft Canvas fragment, adopts it as the in-memory clipboard. Returns
   *  whether it actually was Draft Canvas content — foreign text is a silent
   *  no-op, not an error. */
  applyExternalClipboardText: (text: string) => boolean;
  /** Best-effort pull from the OS clipboard into the in-memory one via the
   *  async Clipboard API — never throws. Resolves `true` iff the read itself
   *  succeeded (permission granted), regardless of whether the clipboard
   *  happened to hold Draft Canvas content; `false` means denied,
   *  unavailable, or otherwise blocked. Call before `paste()` for the
   *  freshest cross-tab content; `paste()` itself stays synchronous and never
   *  calls this on its own. */
  syncClipboardFromSystem: () => Promise<boolean>;
  align: (edge: AlignEdge) => void;
  distribute: (axis: 'x' | 'y') => void;
  groupSelection: () => void;
  ungroupSelection: () => void;
  raise: (toFront?: boolean) => void;
  lower: (toBack?: boolean) => void;

  /* Attachments */
  attachToNode: (hostId: string, attachment: Attachment, insertIndex?: number) => void;
  /** Folds an existing canvas node into a host's attachments (drag-to-attach). */
  attachExistingNode: (nodeId: string, hostId: string) => void;
  detachAttachment: (hostId: string, attachmentId: string) => void;
  updateAttachment: (hostId: string, attachmentId: string, patch: Partial<Omit<Attachment, 'id'>>) => void;
  removeAttachment: (hostId: string, attachmentId: string) => void;
  reorderAttachment: (hostId: string, attachmentId: string, direction: -1 | 1) => void;

  /* Edge attachments — see `EdgeAttachmentReveal` in `DraftEdgeView.tsx`. */
  attachToEdge: (edgeId: string, attachment: Attachment) => void;
  /** Dragging an existing Note/Code node onto a connector folds it into that connector's
   *  attachment — the same idea as `attachExistingNode`, mirrored for an edge target. */
  attachExistingNodeToEdge: (nodeId: string, edgeId: string) => void;
  updateEdgeAttachment: (edgeId: string, attachmentId: string, patch: Partial<Omit<Attachment, 'id'>>) => void;
  removeEdgeAttachment: (edgeId: string, attachmentId: string) => void;
  detachEdgeAttachment: (edgeId: string, attachmentId: string) => void;
  reorderEdgeAttachment: (edgeId: string, attachmentId: string, direction: -1 | 1) => void;

  /* Boundary containment */
  /** Sets or clears (`boundaryId: null`) a node's containing boundary. */
  reparentNode: (nodeId: string, boundaryId: string | null) => void;

  /* Flows */
  /** Returns the new flow's id, or `null` when the document is already at `LIMITS.maxFlows`. */
  createFlow: (title?: string) => string | null;
  renameFlow: (flowId: string, title: string) => void;
  /** Sets, or clears (`accent: null`), a flow's lens accent — see `DraftFlow.accent`. */
  setFlowAccent: (flowId: string, accent: Accent | null) => void;
  deleteFlow: (flowId: string) => void;
  addEdgeToFlow: (flowId: string, edgeId: string, caption?: string) => void;
  removeFlowStep: (flowId: string, stepId: string) => void;
  moveFlowStep: (flowId: string, stepId: string, direction: -1 | 1) => void;
  updateFlowStepCaption: (flowId: string, stepId: string, caption: string) => void;
  /** Adds/removes a node from a step's `extraNodeIds` — a "frame" step's spotlight beyond its primary connector. */
  addFlowStepExtraNode: (flowId: string, stepId: string, nodeId: string) => void;
  removeFlowStepExtraNode: (flowId: string, stepId: string, nodeId: string) => void;
  addFlowStepExtraEdge: (flowId: string, stepId: string, edgeId: string) => void;
  removeFlowStepExtraEdge: (flowId: string, stepId: string, edgeId: string) => void;
  /** Sets, or clears (`viewport: null`), a step's explicit playback viewport. */
  setFlowStepViewport: (flowId: string, stepId: string, viewport: DraftViewport | null) => void;
  /** Which flow's step badges show on the canvas. `null` shows none. */
  setSelectedFlowId: (flowId: string | null) => void;

  /* Document-level */
  rename: (title: string) => void;
  /** `coalesceKey` folds a continuous control (a slider drag) into one undo step. */
  updateSettings: (patch: Partial<DraftSettings>, options?: { coalesceKey?: string }) => void;
  persistViewport: (viewport: DraftViewport) => void;

  /* History */
  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  /* Selection and modes */
  setSelection: (selection: Selection) => void;
  setSaveState: (state: SaveState) => void;
  setMode: (mode: EditorMode) => void;
  setFlowPlayback: (playback: Partial<FlowPlaybackState>) => void;

  /* Focus mode */
  enterFocus: (nodeIds: string[], edgeIds: string[]) => void;
  toggleFocusMember: (id: string, kind: 'node' | 'edge') => void;
  exitFocus: () => void;
}

export interface ApplyOptions {
  /** Entries with the same key merge, so text editing is one undo step. */
  coalesceKey?: string;
  /** Skips the history entry — used for viewport and other non-editorial state. */
  transient?: boolean;
  selection?: Selection;
  /** See `FlowSessionSnapshot` in `history/HistoryStack.ts`. Only `deleteFlow` sets these. */
  flowSessionBefore?: FlowSessionSnapshot;
  flowSessionAfter?: FlowSessionSnapshot;
}

/**
 * `inferRelationship`'s own default-relation logic, wrapped so a Junction on either end resolves
 * transparently to whatever it actually connects (`resolveTransparentCategory`) instead of ending
 * inference dead at the Junction itself — the Junction connection spec's "smart inheritance": a
 * Junction sourcing a fresh edge whose incoming edges converge on one clear `semantic`
 * (`inferredJunctionSemantic`) defaults the new edge to that same semantic (as long as it's still
 * valid for the resolved pairing), falling back to the ordinary capability default — and to no
 * default at all, same as any other unclassified pairing — when the convergence is ambiguous.
 * Used by both `connect()` and `reconnectEdge()` so a connector's semantics always resolve the
 * same way regardless of how it came to exist.
 */
function inferRelationshipThroughJunctions(
  graph: DraftDocument,
  sourceNode: DraftNode,
  targetNode: DraftNode,
): ReturnType<typeof inferRelationship> {
  const sourceCategory = resolveTransparentCategory(graph, sourceNode.id, 'source');
  const targetCategory = resolveTransparentCategory(graph, targetNode.id, 'target');
  const capability = capabilityFor(sourceCategory, targetCategory);
  const inherited =
    categoryOf(sourceNode) === 'junction' ? inferredJunctionSemantic(graph, sourceNode.id) : undefined;
  if (inherited !== undefined && (!capability || capability.relations.includes(inherited))) {
    return { semantic: inherited, kind: capability?.defaultBehavior, async: capability?.defaultAsync };
  }
  if (!capability?.defaultRelation) return undefined;
  return { semantic: capability.defaultRelation, kind: capability.defaultBehavior, async: capability.defaultAsync };
}

/**
 * Reclassifies one edge's `semantic`/`kind` from what it now actually connects, but only when
 * `isEligibleForReinference` says nothing has explicitly claimed them — extracted from
 * `reconnectEdge`'s original post-swap block so `reverseEdge` (which changes source/target exactly
 * the same way, just both endpoints at once) can reuse the identical rule instead of leaving its own
 * copy to drift. A no-op for an edge id that no longer resolves, or one whose endpoints don't (both
 * genuinely impossible via `apply`'s own recipes, but a pure function shouldn't assume its caller
 * always hands it a fully-linked graph).
 */
function reinferIfEligible(doc: DraftDocument, edgeId: string): DraftDocument {
  const edge = doc.edges.find((e) => e.id === edgeId);
  if (!edge || !isEligibleForReinference(edge)) return doc;
  const sourceNode = doc.nodes.find((n) => n.id === edge.source);
  const targetNode = doc.nodes.find((n) => n.id === edge.target);
  if (!sourceNode || !targetNode) return doc;
  const relationship = inferRelationshipThroughJunctions(doc, sourceNode, targetNode);
  // `hasResponse` is deliberately *absent* from this patch rather than passed
  // as `undefined`: `applyPatch` deletes keys whose value is undefined, so
  // naming it here at all would strip an explicit "Show response path" every
  // time the connector was reversed or re-pointed. Re-inference is about
  // `semantic`/`kind`; the reply line is the user's own call.
  // `async` likewise only ever *joins* the patch, never as `undefined`: the matrix asks for a
  // dashed line on a handful of pairings and has no opinion on the rest, and "no opinion" must
  // not read as "switch the user's own dashing off."
  return updateEdge(doc, edgeId, {
    semantic: relationship?.semantic,
    kind: relationship?.kind,
    semanticsOrigin: relationship ? 'inferred' : undefined,
    ...(relationship?.async ? { async: true } : {}),
  });
}

/** The node fields whose value changes a node's `categoryOf` result (see
 *  `document/connectorSemantics.ts`) — a change to any of these can make an incident edge's
 *  inferred relationship stale, so `updateNodeById` re-runs `reinferIfEligible` on every edge
 *  touching the node whenever a patch touches one of these. */
const KIND_FIELDS = ['serviceKind', 'databaseKind', 'queueKind', 'actorKind', 'componentKind'] as const;

/**
 * Re-evaluates every edge incident to a node after a patch changes one of `KIND_FIELDS` — the same
 * "don't silently keep an obviously stale relationship, don't silently delete the edge either"
 * correction `reinferIfEligible` already gives a reconnected/reversed edge, generalized to a plain
 * subtype change (switching a Service node from Generic to Worker, a Data Store from Generic to
 * Cache, etc.). Reuses `reinferIfEligible` unchanged: an edge with an explicit (user-picked)
 * semantic is never touched; one whose semantic was inferred or never set gets recomputed against
 * the node's new category.
 */
function reinferIncidentEdges(doc: DraftDocument, nodeId: string): DraftDocument {
  const incidentIds = doc.edges.filter((e) => e.source === nodeId || e.target === nodeId).map((e) => e.id);
  return incidentIds.reduce((d, edgeId) => reinferIfEligible(d, edgeId), doc);
}

/**
 * Follows a Service node's primary label to its new `serviceKind` — "Generic" becomes "Service",
 * "API" becomes "API", etc. — but only while the label is still system-managed. `before` is the
 * node as it stood *before* this patch (so a caller-supplied `text` in the same patch, however
 * unlikely alongside a `serviceKind` change, is respected — this only steps in when the patch
 * itself left `text` untouched). Reuses `defaultTextFor` — the exact function `createNode` itself
 * calls — so a node created with a subtype and one that later changes to it always land on the
 * same name, never a second, drifting copy of the naming table.
 */
function applyServiceAutoLabel(doc: DraftDocument, nodeId: string, before: DraftNode, patch: Partial<DraftNode>): DraftDocument {
  if (before.type !== 'service' || before.textOrigin !== 'auto' || patch.text !== undefined) return doc;
  const node = doc.nodes.find((n) => n.id === nodeId);
  if (!node) return doc;
  return updateNode(doc, nodeId, { text: defaultTextFor('service', node.serviceKind) });
}

/**
 * The same idea as `applyServiceAutoLabel`, for Component's own subtype/label pairing — kept as a
 * separate function rather than one shared, parameterized helper so each stays a plain, obviously
 * correct three-line check, not a body threading two different field names through one signature.
 */
function applyComponentAutoLabel(doc: DraftDocument, nodeId: string, before: DraftNode, patch: Partial<DraftNode>): DraftDocument {
  if (before.type !== 'component' || before.textOrigin !== 'auto' || patch.text !== undefined) return doc;
  const node = doc.nodes.find((n) => n.id === nodeId);
  if (!node) return doc;
  return updateNode(doc, nodeId, { text: defaultTextFor('component', undefined, node.componentKind) });
}

let interaction: Interaction | null = null;
/** The last system-clipboard text `syncClipboardFromSystem` has already
 *  applied, so an unchanged clipboard doesn't keep resetting `pasteRepeat`. */
let lastSystemClipboardText: string | null = null;
const PASTE_STAGGER_STEP = 16;

/**
 * `undo`/`redo` swap `document` without going through `setDocument` (which
 * intentionally resets everything for an unrelated document) — so unlike a
 * fresh open, they need to keep whatever of `selectedFlowId`/`focus` still
 * resolves against the *restored* document, and drop only what doesn't.
 * `flowPlayback` already self-heals this way via its own effect
 * (`useFlowPlayback.ts`) for the same reason: landing on a document where the
 * flow/nodes/edges you had selected no longer exist shouldn't strand you in a
 * mode with no visible way out.
 */
function reconcileSessionState(
  document: DraftDocument,
  state: Pick<EditorStore, 'selectedFlowId' | 'focus'>,
): Partial<EditorStore> {
  const patch: Partial<EditorStore> = {};

  if (state.selectedFlowId && !document.flows.some((flow) => flow.id === state.selectedFlowId)) {
    patch.selectedFlowId = null;
  }

  if (state.focus.active) {
    const nodeIds = new Set(document.nodes.map((node) => node.id));
    const edgeIds = new Set(document.edges.map((edge) => edge.id));
    const survivingNodeIds = state.focus.nodeIds.filter((id) => nodeIds.has(id));
    const survivingEdgeIds = state.focus.edgeIds.filter((id) => edgeIds.has(id));
    if (
      survivingNodeIds.length !== state.focus.nodeIds.length ||
      survivingEdgeIds.length !== state.focus.edgeIds.length
    ) {
      patch.focus =
        survivingNodeIds.length + survivingEdgeIds.length === 0
          ? { active: false, nodeIds: [], edgeIds: [] }
          : { active: true, nodeIds: survivingNodeIds, edgeIds: survivingEdgeIds };
    }
  }

  return patch;
}

/** Focus pruned to what still exists after an edit — deleting the focused elements must not
 *  leave Focus on with nothing lit and the whole canvas dimmed. Only the focus half of
 *  `reconcileSessionState`: an edit that removes the selected flow already clears it itself. */
function focusThatSurvives(document: DraftDocument, state: Pick<EditorStore, 'selectedFlowId' | 'focus'>) {
  if (!state.focus.active) return {};
  const { focus } = reconcileSessionState(document, { selectedFlowId: null, focus: state.focus });
  return focus ? { focus } : {};
}

/** The document as it should be saved or exported: `document` with the camera where it really is. */
export function documentWithLiveViewport(state: Pick<EditorStore, 'document' | 'liveViewport'>): DraftDocument {
  return state.liveViewport ? { ...state.document, viewport: state.liveViewport } : state.document;
}

/**
 * The flow currently acting as the canvas lens (members lit, everything else dimmed), or
 * `undefined` when there is none. The single source of truth for "is a lens on" — the canvas
 * container, every node and edge, and fit-to-view all ask this rather than each re-deriving it,
 * so they can never disagree. There is no lens during playback or Focus (those own dimming), and
 * — deliberately — none for a flow with nothing in it: a brand-new empty flow is the *selected*
 * flow (the panel highlights it, the connector chip offers "Add to it") but must not grey out the
 * entire diagram before it has a single step. Step badges follow `selectedFlowId` directly; they
 * are moot for an empty flow anyway.
 */
export function lensFlow(
  state: Pick<EditorStore, 'document' | 'selectedFlowId' | 'flowPlayback' | 'focus'>,
): DraftFlow | undefined {
  if (!state.selectedFlowId || state.flowPlayback.active || state.focus.active) return undefined;
  const flow = findFlow(state.document, state.selectedFlowId);
  return flow && flowHasMembers(state.document, flow) ? flow : undefined;
}

/** React Flow `fitView({ nodes })` input scoped to the lens flow, or `undefined` to fit everything. */
export function flowFitViewNodes(state: EditorStore): { id: string }[] | undefined {
  const flow = lensFlow(state);
  if (!flow) return undefined;
  const ids = flowMemberNodeIds(state.document, flow);
  return ids.length > 0 ? ids.map((id) => ({ id })) : undefined;
}

export const useEditorStore = create<EditorStore>((set, get) => ({
  document: createDocument(),
  history: EMPTY_HISTORY,
  selection: EMPTY_SELECTION,
  clipboard: null,
  pasteRepeat: 0,
  save: { status: 'idle' },
  mode: 'edit',
  flowPlayback: { active: false, flowId: null, step: 0 },
  focus: { active: false, nodeIds: [], edgeIds: [] },
  selectedFlowId: null,
  revision: 0,
  liveViewport: null,

  setDocument(document, options) {
    interaction = null;
    useUiStore.getState().resetContinuation();
    set((state) => ({
      document,
      history: options?.resetHistory === false ? state.history : EMPTY_HISTORY,
      // A presentation-mode selection ring or playback state from the diagram just closed has no
      // meaning for the one being opened — without this, opening a new diagram right after
      // presenting another lands you straight into presentation mode for it too.
      mode: 'edit',
      selection: EMPTY_SELECTION,
      flowPlayback: { active: false, flowId: null, step: 0 },
      focus: { active: false, nodeIds: [], edgeIds: [] },
      // With exactly one flow there's no ambiguity about which one's step
      // badges to show, so a freshly opened diagram isn't blank of them.
      // With several, none is auto-selected — guessing wrong would be worse
      // than showing none until the user picks.
      selectedFlowId: document.flows.length === 1 ? document.flows[0]!.id : null,
      revision: state.revision + 1,
      liveViewport: null,
    }));
  },

  apply(label, recipe, options) {
    const state = get();
    const before = state.document;
    const next = touch(recipe(before));
    // Structural sharing means an operation that changed nothing returns the
    // same object, so no-op commands never create a dead undo step.
    if (next === before || shallowEqualDocument(next, before)) return;

    if (interaction || options?.transient) {
      set((s) => ({
        document: next,
        selection: options?.selection ?? s.selection,
        revision: s.revision + 1,
        ...focusThatSurvives(next, s),
      }));
      return;
    }

    const selectionAfter = options?.selection ?? state.selection;
    set((s) => ({
      document: next,
      selection: selectionAfter,
      revision: s.revision + 1,
      ...focusThatSurvives(next, s),
      history: pushEntry(s.history, {
        label,
        before,
        after: next,
        selectionBefore: state.selection,
        selectionAfter,
        at: Date.now(),
        coalesceKey: options?.coalesceKey,
        flowSessionBefore: options?.flowSessionBefore,
        flowSessionAfter: options?.flowSessionAfter,
      }),
    }));
  },

  beginInteraction(label) {
    // A still-open interaction here means the gesture that should have called `endInteraction`
    // never did (e.g. a resize interrupted mid-drag by a new gesture starting on the same node
    // before its own end event fires). Closing it out first — rather than overwriting `interaction`
    // with a fresh baseline — keeps that earlier gesture's change on the undo stack as its own
    // entry instead of silently baking it into whatever comes next with no way to undo it alone.
    if (interaction) get().endInteraction();
    const state = get();
    interaction = { label, document: state.document, selection: state.selection };
  },

  endInteraction(label) {
    const active = interaction;
    interaction = null;
    if (!active) return;
    const state = get();
    // A click that moved nothing leaves the document identical; no entry.
    if (state.document === active.document) return;
    set((s) => ({
      history: pushEntry(s.history, {
        label: label ?? active.label,
        before: active.document,
        after: s.document,
        selectionBefore: active.selection,
        selectionAfter: s.selection,
        at: Date.now(),
      }),
    }));
  },

  addNode(input) {
    const node = createNode(input);
    get().apply(`Add ${input.type}`, (doc) => addNodes(doc, [node]), {
      selection: { nodes: [node.id], edges: [] },
    });
    return node;
  },

  addNodesWithEdges(nodes, edges, label, flows = []) {
    get().apply(
      label,
      (doc) => flows.reduce((next, flow) => addFlow(next, flow), addEdges(addNodes(doc, nodes), edges)),
      { selection: { nodes: nodes.map((n) => n.id), edges: [] } },
    );
  },

  acceptContinuation(offer) {
    const state = get();
    // A stale offer (its anchor was deleted underneath it) adds nothing.
    if (!state.document.nodes.some((n) => n.id === offer.anchorId)) return;
    state.addNodesWithEdges(offer.nodes, offer.edges, `Add ${offer.label}`);
    const ui = useUiStore.getState();
    ui.setContinuation(null);
    ui.setSettleNodeId(offer.primaryNodeId);
  },

  insertStarter(starter) {
    const state = get();
    // Everything a starter needs is decided before a single node exists: where it can land
    // (`freeOriginFor`, one pass over the document) and what it contains (`buildStarter`, pure).
    // The insert itself is then the plainest bulk add there is, which is what makes one ⌘Z undo
    // the whole architecture and one ⌘⇧Z bring it back.
    const { nodes, edges, flows } = buildStarter(starter, freeOriginFor(state.document, starterSize(starter)));
    state.addNodesWithEdges(nodes, edges, `Insert ${starter.name}`, flows);
    return nodes;
  },

  connect(source, target, sourceSide, targetSide, sourceOffset = 0.5, targetOffset = 0.5) {
    const state = get();
    if (source === target) return null;
    const exists = state.document.edges.some((e) => e.source === source && e.target === target);
    if (exists) return null;
    // Infer a relationship from what's actually being connected — see
    // `inferRelationshipThroughJunctions`'s doc comment for exactly which pairings apply, and how
    // a Junction on either end resolves transparently rather than blocking inference outright.
    const sourceNode = state.document.nodes.find((n) => n.id === source);
    const targetNode = state.document.nodes.find((n) => n.id === target);
    // Mirrors `addEdges`' own guard: a stale id (its node deleted since the caller looked it up —
    // e.g. a context-menu "Connect to" target picked before an intervening delete) must not return
    // a truthy edge that never actually gets persisted.
    if (!sourceNode || !targetNode) return null;
    const relationship = inferRelationshipThroughJunctions(state.document, sourceNode, targetNode);
    const edge = createEdge({
      source,
      target,
      // The side (and, along it, the position) the user actually dragged
      // from/dropped onto is intent — capture it so routing never has to
      // guess for this edge again. See `document/types.ts`'s `EdgeAnchor`
      // doc comment.
      sourceAnchor: sourceSide ? { side: sourceSide, offset: sourceOffset } : undefined,
      targetAnchor: targetSide ? { side: targetSide, offset: targetOffset } : undefined,
      kind: relationship?.kind,
      semantic: relationship?.semantic,
      async: relationship?.async,
      // No reply line by default, even between two services. At the altitude
      // an architecture diagram works at the return path is implied, and
      // drawing it unasked doubles the lines on the busiest kind of diagram.
      // It stays one click away in the connector's own editor ("Show response
      // path"), and any document that already persisted `hasResponse: true`
      // keeps rendering exactly as it did.
      semanticsOrigin: relationship ? 'inferred' : undefined,
    });
    state.apply('Connect', (doc) => addEdges(doc, [edge]), {
      selection: { nodes: [], edges: [edge.id] },
    });
    return edge;
  },

  updateNodeById(id, patch, label = 'Change node') {
    get().apply(label, (doc) => {
      const before = doc.nodes.find((n) => n.id === id);
      let next = updateNode(doc, id, patch);
      if (before && 'serviceKind' in patch) next = applyServiceAutoLabel(next, id, before, patch);
      if (before && 'componentKind' in patch) next = applyComponentAutoLabel(next, id, before, patch);
      if (before?.type === 'note' && 'noteKind' in patch) next = growNoteToFit(next, id);
      if (before?.type === 'text' && ('textRole' in patch || 'textBold' in patch || 'textItalic' in patch)) {
        next = growTextToFit(next, id);
      }
      const changesKind = KIND_FIELDS.some((field) => field in patch);
      return changesKind ? reinferIncidentEdges(next, id) : next;
    });
  },

  updateNodeText(id, text, options) {
    // A manual edit is permanent intent from this point on, even if the typed value happens to
    // match a subtype's own default (e.g. renaming an API to literally "API") — see
    // `DraftNode.textOrigin`'s doc comment. `updateNodeById`'s Service auto-relabeling never
    // touches a node once this is set.
    get().apply(
      'Edit text',
      (doc) => {
        const patch: Partial<DraftNode> = { text, textOrigin: 'explicit' };
        if (options?.height !== undefined) patch.height = options.height;
        // A queue-family node's name stacks above its kind caption under the tube, so naming one
        // moves it between the two default boxes (`DEFAULTS.queueHeight`/`queueNamedHeight`):
        // grow when a name first appears, shrink back only when the name is cleared from a box
        // still at exactly the named default — a box the user has sized by hand is never touched.
        const node = doc.nodes.find((n) => n.id === id);
        if (node?.type === 'queue') {
          const named = text.trim().length > 0;
          if (named && node.height < DEFAULTS.queueNamedHeight) patch.height = DEFAULTS.queueNamedHeight;
          else if (!named && node.height === DEFAULTS.queueNamedHeight) patch.height = DEFAULTS.queueHeight;
        }
        return updateNode(doc, id, patch);
      },
      { coalesceKey: `text:${id}` },
    );
  },

  finishTextEdit(id, resultingText) {
    if (resultingText.trim()) return;
    const node = get().document.nodes.find((n) => n.id === id);
    if (!node || node.type !== 'text' || node.textOrigin !== 'auto') return;
    // Abandoned straight after creation (nothing else happened in between): take back the "Add
    // text" step itself instead of recording a delete on top of it — otherwise one ⌘Z brings back
    // an empty, invisible node, the very thing this cleanup exists to prevent.
    const { document, history, revision } = get();
    const top = history.past[history.past.length - 1];
    // Only when that step added this one node and nothing else — a Duplicate/Paste that merely
    // *included* an empty auto-text must not be reverted wholesale along with it.
    const topAddedOnlyThisNode =
      top !== undefined &&
      top.after === document &&
      top.after.nodes.length === top.before.nodes.length + 1 &&
      top.after.edges.length === top.before.edges.length &&
      !top.before.nodes.some((n) => n.id === id);
    if (topAddedOnlyThisNode) {
      set({
        document: top.before,
        // Redo entries were recorded on top of a document that still had this node.
        history: { past: history.past.slice(0, -1), future: [] },
        selection: EMPTY_SELECTION,
        revision: revision + 1,
      });
      return;
    }
    get().apply('Delete empty text', (doc) => removeElements(doc, [id]), { selection: EMPTY_SELECTION });
  },

  updateEdgeById(id, patch, label = 'Change connection') {
    get().apply(label, (doc) => updateEdge(doc, id, patch));
  },

  // Swapping direction changes which node is source and which is target — exactly the same
  // structural change `reconnectEdge` makes to one endpoint, so it reuses the identical
  // re-inference rule: reclassify only when nothing has claimed the semantic yet (or inference
  // already owns it), never touch a user's explicit choice. Without this, reversing an inferred
  // `service→database` "writes" edge would leave it *still* labeled "writes" pointing the other
  // way — stale relative to what the matrix itself would infer for the reversed pairing.
  reverseEdge(id) {
    get().apply('Reverse direction', (doc) => reinferIfEligible(reverseEdgeOp(doc, id), id));
  },

  reconnectEdge(id, endpoint, newNodeId, newSide, newOffset = 0.5) {
    get().apply('Reconnect', (doc) => {
      const reconnected = reconnectEdgeOp(doc, id, endpoint, newNodeId, newSide, newOffset);
      // A refused reconnect (onto the other endpoint, or a vanished node) must stay a no-op:
      // re-inference always rebuilds the edges array, which would record a dead undo step.
      return reconnected === doc ? doc : reinferIfEligible(reconnected, id);
    });
  },

  insertWorkerOnEdge(edgeId) {
    const state = get();
    const edge = state.document.edges.find((e) => e.id === edgeId);
    const source = edge && state.document.nodes.find((n) => n.id === edge.source);
    const target = edge && state.document.nodes.find((n) => n.id === edge.target);
    if (!edge || !source || !target) return;

    // Same midpoint-of-both-centers placement `detachFromEdge` already uses for a connector's
    // own detached attachment — no independent placement heuristic invented for this.
    const size = defaultSizeFor('service');
    const worker = createNode({
      type: 'service',
      serviceKind: 'worker',
      x: Math.round((source.x + source.width / 2 + target.x + target.width / 2) / 2 - size.width / 2),
      y: Math.round((source.y + source.height / 2 + target.y + target.height / 2) / 2 - size.height / 2),
      z: Math.max(source.z, target.z),
    });

    // Both new edges' semantics come from the same capability matrix everything else reads —
    // never hardcoded — so `Queue → Worker`/`Worker → Topic` fall out as `consumes`/`publishes`
    // without this action needing to know that itself.
    const toWorker = capabilityFor(categoryOf(source), categoryOf(worker));
    const fromWorker = capabilityFor(categoryOf(worker), categoryOf(target));
    const edgeToWorker = createEdge({
      source: edge.source,
      target: worker.id,
      semantic: toWorker?.defaultRelation,
      kind: toWorker?.defaultBehavior,
      async: toWorker?.defaultAsync,
      semanticsOrigin: toWorker?.defaultRelation ? 'inferred' : undefined,
    });
    const edgeFromWorker = createEdge({
      source: worker.id,
      target: edge.target,
      semantic: fromWorker?.defaultRelation,
      kind: fromWorker?.defaultBehavior,
      async: fromWorker?.defaultAsync,
      semanticsOrigin: fromWorker?.defaultRelation ? 'inferred' : undefined,
    });

    state.apply(
      'Insert worker',
      // Replacements are added and spliced into any flow steps *before* the original connector
      // goes, so a flow that told `A → B` now tells `A → W`, `W → B` instead of losing the beat.
      (doc) =>
        removeElements(
          spliceEdgeInFlows(
            addEdges(addNodes(doc, [worker]), [edgeToWorker, edgeFromWorker]),
            edgeId,
            [edgeToWorker.id, edgeFromWorker.id],
          ),
          [],
          [edgeId],
        ),
      { selection: { nodes: [worker.id], edges: [] } },
    );
  },

  addDeadLetterQueue(queueId) {
    const state = get();
    const source = state.document.nodes.find((n) => n.id === queueId);
    // A DLQ belongs only to a plain Queue — never a Topic (real failure handling belongs to a
    // subscription/consumer path, which Draft Canvas doesn't model as a first-class concept yet),
    // never a Stream (its dead-letter destination is typically a separate topic, not a
    // queue-shaped DLQ), and never a node that is itself already a generated DLQ.
    if (!source || source.type !== 'queue' || source.queueKind !== 'queue' || source.deliveryRole === 'dead-letter') {
      return;
    }
    const alreadyHasDlq = state.document.edges.some((e) => e.source === queueId && e.semantic === 'deadLetters');
    if (alreadyHasDlq) return;

    const size = defaultSizeFor('queue');
    const caption = relationshipCaptionLabel('deadLetters', undefined, 3);
    const { x, y } = placeNear(state.document, source, size, gapForCaption(caption));
    const dlq = createNode({ type: 'queue', queueKind: 'queue', deliveryRole: 'dead-letter', x, y, z: source.z });
    // The relationship comes from the same capability matrix a hand-drawn Queue → DLQ connector
    // reads (`queue>deadLetter`: dead-letters, failure, dashed) — not restated here — and stays
    // `inferred` exactly like that hand-drawn one, so re-pointing it later re-reads it the same way.
    // Only the attempt count is this action's own opinion: three is the conventional default.
    const edge = createEdge({
      source: source.id,
      target: dlq.id,
      ...inferRelationship(source, dlq),
      semanticsOrigin: 'inferred',
      deliveryAttempts: 3,
      ...horizontalAnchorsFor(source, dlq),
    });
    state.apply('Add DLQ', (doc) => addEdges(addNodes(doc, [dlq]), [edge]), {
      selection: { nodes: [dlq.id], edges: [] },
    });
  },

  removeDeadLetterQueue(queueId) {
    const state = get();
    const edge = state.document.edges.find((e) => e.source === queueId && e.semantic === 'deadLetters');
    if (!edge) return;
    const dlqNode = state.document.nodes.find((n) => n.id === edge.target);
    // Since "has a DLQ" is derived purely from this edge's existence, a user could have manually
    // reconnected it (via the edge inspector's "Show all…" escape hatch) onto an unrelated,
    // important node — never delete that node, only one still marked as a generated DLQ.
    const nodeIdsToRemove = dlqNode?.deliveryRole === 'dead-letter' ? [dlqNode.id] : [];
    state.apply('Remove DLQ', (doc) => removeElements(doc, nodeIdsToRemove, [edge.id]));
  },

  addCompanion(sourceId, companion, label) {
    const state = get();
    const source = state.document.nodes.find((n) => n.id === sourceId);
    if (!source) return;

    const size = defaultSizeFor(companion.type);
    // Same capability matrix every other connection reads — it correctly differentiates a queue's
    // competing-consumer `consumes` from a topic's fan-out `deliversTo`, a service's `writes` from
    // a gateway's `routes`, with no special-casing here. Resolved ahead of placement (category only
    // needs the type/kind, not a real positioned node) so the caption it implies can size the gap
    // between source and companion.
    const capability = capabilityFor(categoryOf(source), categoryOf(companion));
    const caption = capability?.defaultRelation ? SEMANTIC_DEFAULTS[capability.defaultRelation].label : undefined;
    const { x, y } = placeNear(state.document, source, size, gapForCaption(caption));
    const node = createNode({ ...companion, x, y, z: source.z });
    // Not restated here, and stays `inferred` so re-pointing it later re-reads it the same way.
    const edge = createEdge({
      source: source.id,
      target: node.id,
      semantic: capability?.defaultRelation,
      kind: capability?.defaultBehavior,
      async: capability?.defaultAsync,
      semanticsOrigin: capability?.defaultRelation ? 'inferred' : undefined,
      ...horizontalAnchorsFor(source, node),
    });
    state.apply(label, (doc) => addEdges(addNodes(doc, [node]), [edge]), {
      selection: { nodes: [node.id], edges: [] },
    });
  },

  addConsumer(sourceId) {
    get().addCompanion(sourceId, { type: 'service', serviceKind: 'worker' }, 'Add Consumer');
  },

  addSubscriber(topicId) {
    const source = get().document.nodes.find((n) => n.id === topicId);
    if (!source || categoryOf(source) !== 'topic') return;
    get().addCompanion(topicId, { type: 'queue', queueKind: 'queue' }, 'Add Subscriber');
  },

  addDataStore(serviceId) {
    const source = get().document.nodes.find((n) => n.id === serviceId);
    if (!source || !ownsData(source)) return;
    get().addCompanion(serviceId, { type: 'database', databaseKind: 'generic' }, 'Add Data Store');
  },

  addRoutedService(gatewayId) {
    const source = get().document.nodes.find((n) => n.id === gatewayId);
    if (!source || categoryOf(source) !== 'gateway') return;
    get().addCompanion(gatewayId, { type: 'service', serviceKind: 'api' }, 'Add Service');
  },

  setEdgeDeliveryAttempts(id, attempts) {
    const clamped = clamp(Math.round(attempts), 1, 50);
    get().apply('Set delivery attempts', (doc) => updateEdge(doc, id, { deliveryAttempts: clamped }), {
      coalesceKey: `delivery-attempts:${id}`,
    });
  },

  updateEdgeLabel(id, label) {
    get().apply('Label connection', (doc) => updateEdge(doc, id, { label }), {
      coalesceKey: `edge-label:${id}`,
    });
  },

  setEdgeSemantic(id, semantic) {
    const state = get();
    const edge = state.document.edges.find((e) => e.id === id);
    if (!edge) return;
    const patch: Partial<Omit<DraftEdge, 'id' | 'source' | 'target'>> = { semantic, semanticsOrigin: 'explicit' };
    // Only a fill-in-the-blank convenience: never overrides a label the user already gave the
    // connection, and never touches `accent` at all. Also skipped for a pairing the matrix flags
    // as unusual/questionable — auto-filling a plain label there would silently replace the one
    // visual signal (the caption's own warning marker, see `DraftEdgeView.tsx`) that this
    // connection is worth a second look, at the exact moment a relation gets picked for it.
    const status = capabilityFor(
      resolveTransparentCategory(state.document, edge.source, 'source'),
      resolveTransparentCategory(state.document, edge.target, 'target'),
    )?.status;
    const isUnusual = status === 'unusual' || status === 'questionable';
    if (semantic && !edge.label && !isUnusual) patch.label = SEMANTIC_DEFAULTS[semantic].label;
    state.apply('Set connection type', (doc) => updateEdge(doc, id, patch));
  },

  setEdgeCondition(id, condition) {
    get().apply('Set condition', (doc) => updateEdge(doc, id, { condition: condition.trim() || undefined }), {
      coalesceKey: `edge-condition:${id}`,
    });
  },

  setEdgeResponse(id, response) {
    get().apply('Set response', (doc) => updateEdge(doc, id, { response: response.trim() || undefined }), {
      coalesceKey: `edge-response:${id}`,
    });
  },

  setEdgeHasResponse(id, hasResponse) {
    get().apply('Toggle response', (doc) =>
      updateEdge(doc, id, { hasResponse: hasResponse || undefined, semanticsOrigin: 'explicit' }),
    );
  },

  setEdgeRouteMode(id, mode) {
    get().apply(mode === 'direct' ? 'Use direct routing' : 'Use smart routing', (doc) =>
      updateEdge(doc, id, { routeMode: mode }),
    );
  },

  tidyConnections() {
    const state = get();
    // Deliberately the *only* thing this clears. An anchor is where the user
    // dragged a connector to attach, and `docs/ARCHITECTURE.md` is explicit
    // that routing never moves one — so "Tidy connections" stays safe to run
    // without first checking what it will do. Everything else Smart Routing
    // would tidy is derived per render and needs nothing persisted to undo.
    const manual = state.document.edges.filter((edge) => edge.routeMode);
    if (manual.length === 0) return;
    state.apply('Tidy connections', (doc) =>
      manual.reduce((next, edge) => updateEdge(next, edge.id, { routeMode: undefined }), doc),
    );
  },

  convertBundleToJunction(edgeId) {
    const state = get();
    const plan = routingPlan(state.document.nodes, state.document.edges);
    const spine = plan.spineFor(edgeId);
    if (!spine) return;
    const memberIds = plan.membersOf(spine.id);
    const members = memberIds
      .map((id: string) => state.document.edges.find((e: DraftEdge) => e.id === id))
      .filter((e): e is DraftEdge => Boolean(e));
    if (members.length === 0) return;

    const hubId = spine.hub === 'source' ? members[0]!.source : members[0]!.target;
    const hub = state.document.nodes.find((n) => n.id === hubId);
    if (!hub) return;

    // Placed exactly where the trunk already meets the stem, so materializing
    // the Junction is visually a no-op — the user gets a handle on the point
    // they were already looking at, not a diagram that jumps.
    const hubRect = rectOf(hub);
    const trunk = trunkCoordinate(hubRect, spine);
    const anchor = spine.hub === 'source' ? members[0]!.sourceAnchor : members[0]!.targetAnchor;
    const offset = anchor?.offset ?? 0.5;
    const vertical = spine.hubSide === 'left' || spine.hubSide === 'right';
    const stemPoint = anchorPoint(hubRect, spine.hubSide, offset);
    const cross = vertical ? stemPoint.y : stemPoint.x;
    const size = defaultSizeFor('ellipse');
    const junction = createNode({
      type: 'ellipse',
      x: Math.round((vertical ? trunk : cross) - size.width / 2),
      y: Math.round((vertical ? cross : trunk) - size.height / 2),
      z: Math.max(hub.z, ...members.map((edge: DraftEdge) => {
        const far = state.document.nodes.find((n) => n.id === (spine.hub === 'source' ? edge.target : edge.source));
        return far?.z ?? 0;
      })),
    });

    // The compatibility gate that formed this bundle already guarantees every
    // member agrees on all of these, so the shared leg can carry them without
    // having to reconcile anything.
    const template = members[0]!;
    const shared = createEdge({
      source: spine.hub === 'source' ? hubId : junction.id,
      target: spine.hub === 'source' ? junction.id : hubId,
      semantic: template.semantic,
      kind: template.kind,
      directed: template.directed,
      async: template.async,
      hasResponse: template.hasResponse,
      accent: template.accent,
      semanticsOrigin: template.semanticsOrigin,
      // The hub end keeps exactly the anchor the members already used; the
      // Junction end gets none — it only has four handles, all at a side's
      // midpoint, so a 0.25/0.75 offset would be meaningless there.
      sourceAnchor: spine.hub === 'source' ? template.sourceAnchor : undefined,
      targetAnchor: spine.hub === 'source' ? undefined : template.targetAnchor,
    });

    // Everything that belongs to one specific relationship — its label, its
    // condition, its attachments — moves onto that member's own leg, never
    // onto the shared one.
    const legs = members.map((edge: DraftEdge) => {
      const leg = createEdge({
        source: spine.hub === 'source' ? junction.id : edge.source,
        target: spine.hub === 'source' ? edge.target : junction.id,
        label: edge.label,
        semantic: edge.semantic,
        kind: edge.kind,
        directed: edge.directed,
        async: edge.async,
        hasResponse: edge.hasResponse,
        accent: edge.accent,
        semanticsOrigin: edge.semanticsOrigin,
        deliveryAttempts: edge.deliveryAttempts,
        sourceAnchor: spine.hub === 'source' ? undefined : edge.sourceAnchor,
        targetAnchor: spine.hub === 'source' ? edge.targetAnchor : undefined,
      });
      if (edge.condition) leg.condition = edge.condition;
      if (edge.response) leg.response = edge.response;
      if (edge.attachments) leg.attachments = edge.attachments;
      return leg;
    });

    // One entry, exactly like `insertWorkerOnEdge` — undo restores the bundle
    // in a single step rather than unpicking six separate edits.
    // Each member's flow steps are spliced onto its new path — through the shared trunk and
    // then its own leg, in travel order — before the member goes, same as `insertWorkerOnEdge`;
    // `removeElements` alone would prune those steps and the flow would silently lose beats.
    state.apply(
      'Convert to junction',
      (doc) => {
        let next = addEdges(addNodes(doc, [junction]), [shared, ...legs]);
        members.forEach((member: DraftEdge, index: number) => {
          const leg = legs[index]!.id;
          next = spliceEdgeInFlows(next, member.id, spine.hub === 'source' ? [shared.id, leg] : [leg, shared.id]);
        });
        return removeElements(next, [], memberIds);
      },
      { selection: { nodes: [junction.id], edges: [] } },
    );
  },

  toggleEdgeAsync(id) {
    const state = get();
    const edge = state.document.edges.find((e) => e.id === id);
    if (!edge) return;
    state.apply('Toggle async', (doc) => updateEdge(doc, id, { async: edge.async ? undefined : true }));
  },

  setEdgeKind(id, kind) {
    const state = get();
    const edge = state.document.edges.find((e) => e.id === id);
    if (!edge) return;
    const patch: Partial<Omit<DraftEdge, 'id' | 'source' | 'target'>> = { kind, semanticsOrigin: 'explicit' };
    // A fill-in-the-blank default, same discipline as semantic→label: choosing
    // the 'async' kind gives the connector its dashed line via the existing
    // `async` flag, but never fights the user afterward if they turn it back
    // off independently, and never touches it for any other kind.
    if (kind === 'async' && !edge.async) patch.async = true;
    state.apply('Set connector kind', (doc) => updateEdge(doc, id, patch));
  },

  commitPositions(positions) {
    get().apply('Move', (doc) => moveNodes(doc, positions));
  },

  nudgeSelection(dx, dy) {
    const state = get();
    if (state.selection.nodes.length === 0) return;
    const positions = new Map(
      state.selection.nodes
        .map((id) => state.document.nodes.find((node) => node.id === id))
        .filter((node) => node !== undefined)
        .map((node) => [node.id, { x: node.x + dx, y: node.y + dy }] as const),
    );
    // Keyed on *which* nodes: nudging one selection and then another within the coalesce window
    // are two separate moves, and must undo separately.
    state.apply('Nudge', (doc) => moveNodes(doc, positions), {
      coalesceKey: `nudge:${[...positions.keys()].sort().join(',')}`,
    });
  },

  deleteSelection() {
    const { selection, apply } = get();
    if (selection.nodes.length === 0 && selection.edges.length === 0) return;
    apply('Delete', (doc) => removeElements(doc, selection.nodes, selection.edges), {
      selection: EMPTY_SELECTION,
    });
  },

  duplicateSelection() {
    const state = get();
    if (state.selection.nodes.length === 0) return;
    const fragment = extractFragment(state.document, state.selection.nodes);
    const result = pasteFragment(state.document, fragment, { x: 24, y: 24 });
    state.apply('Duplicate', () => result.doc, {
      selection: { nodes: result.nodeIds, edges: result.edgeIds },
    });
    if (result.truncated) {
      useUiStore.getState().notify("Duplicated the first part — the rest would make this diagram too large.");
    }
  },

  copySelection() {
    const state = get();
    if (state.selection.nodes.length === 0) return;
    const fragment = extractFragment(state.document, state.selection.nodes);
    set({ clipboard: fragment, pasteRepeat: 0 });
    // Best-effort — a missing/denied Clipboard API (insecure context, an
    // older browser, a test env) never breaks same-tab copy/paste, which
    // the in-memory `clipboard` above already covers on its own.
    try {
      void navigator.clipboard?.writeText?.(encodeClipboard(fragment))?.catch(() => {});
    } catch {
      // ignore
    }
  },

  cutSelection() {
    const state = get();
    const { selection } = state;
    if (selection.nodes.length === 0 && selection.edges.length === 0) return;
    // Only a node-bearing selection has a meaningful, self-contained
    // fragment to put on the clipboard — an edge-only cut, like an
    // edge-only copy, just removes what's selected. See `copySelection`.
    if (selection.nodes.length > 0) {
      const fragment = extractFragment(state.document, selection.nodes);
      set({ clipboard: fragment, pasteRepeat: 0 });
      try {
        void navigator.clipboard?.writeText?.(encodeClipboard(fragment))?.catch(() => {});
      } catch {
        // ignore
      }
    }
    state.apply('Cut', (doc) => removeElements(doc, selection.nodes, selection.edges), {
      selection: EMPTY_SELECTION,
    });
  },

  paste(targetCenter, options) {
    const state = get();
    const fragment = state.clipboard;
    if (!fragment || fragment.nodes.length === 0) return;
    const bounds = boundsOf(fragment.nodes);
    const fragmentCenter = bounds ? centerOf(bounds) : { x: 0, y: 0 };
    const target = targetCenter ?? { x: fragmentCenter.x + 32, y: fragmentCenter.y + 32 };
    // Consecutive pastes of the same clipboard content step diagonally so they don't perfectly
    // overlap; a fresh copy/cut resets the count. `exact` (a right-click "Paste" at a captured
    // point) opts out — that gesture means "land exactly here," not "here, plus whatever drift an
    // unrelated earlier paste happened to leave behind."
    const stagger = options?.exact ? 0 : state.pasteRepeat * PASTE_STAGGER_STEP;
    const offset = {
      x: target.x - fragmentCenter.x + stagger,
      y: target.y - fragmentCenter.y + stagger,
    };
    const result = pasteFragment(state.document, fragment, offset);
    state.apply('Paste', () => result.doc, {
      selection: { nodes: result.nodeIds, edges: result.edgeIds },
    });
    set((s) => ({ pasteRepeat: s.pasteRepeat + 1 }));
    if (result.truncated) {
      useUiStore.getState().notify("Pasted the first part — the rest would make this diagram too large.");
    }
  },

  applyExternalClipboardText(text) {
    if (!text) return false;
    const fragment = decodeClipboard(text);
    if (!fragment || fragment.nodes.length === 0) return false;
    // A repeat paste of unchanged text is still a real paste (still returns `true`) — this
    // dedup guard only decides whether to re-`set` identical content and reset the stagger.
    if (text !== lastSystemClipboardText) {
      lastSystemClipboardText = text;
      set({ clipboard: fragment, pasteRepeat: 0 });
    }
    return true;
  },

  async syncClipboardFromSystem() {
    try {
      const text = await navigator.clipboard?.readText?.();
      if (text === undefined) return false; // no Clipboard API, or a stub that returns nothing
      get().applyExternalClipboardText(text);
      return true; // the read itself succeeded — permission is granted, independent of payload
    } catch {
      // Permission denied, insecure context, or a rejecting stub.
      return false;
    }
  },

  align(edge) {
    const { selection, apply } = get();
    apply('Align', (doc) => alignNodes(doc, selection.nodes, edge));
  },

  distribute(axis) {
    const { selection, apply } = get();
    apply('Distribute', (doc) => distributeNodes(doc, selection.nodes, axis));
  },

  groupSelection() {
    const state = get();
    const selected = new Set(state.selection.nodes);
    const byId = new Map(state.document.nodes.map((n) => [n.id, n] as const));
    // Only the outermost selected nodes move into the new boundary. A marquee that also caught
    // a selected boundary's own children must not pull them out of it and leave it empty.
    const hasSelectedAncestor = (node: DraftNode) => {
      for (let p = node.parentId ? byId.get(node.parentId) : undefined; p; p = p.parentId ? byId.get(p.parentId) : undefined) {
        if (selected.has(p.id)) return true;
      }
      return false;
    };
    const members = state.document.nodes.filter((n) => selected.has(n.id) && !hasSelectedAncestor(n));
    if (members.length < 2) return;
    // Grouping inside an existing boundary keeps the new one nested there, so dragging or
    // deleting that outer boundary still carries everything it held.
    const sharedParent = members.every((n) => n.parentId === members[0]!.parentId) ? members[0]!.parentId : undefined;

    const padding = 28;
    const minX = Math.min(...members.map((n) => n.x)) - padding;
    const minY = Math.min(...members.map((n) => n.y)) - padding - 12;
    const maxX = Math.max(...members.map((n) => n.x + n.width)) + padding;
    const maxY = Math.max(...members.map((n) => n.y + n.height)) + padding;
    const minZ = Math.min(...members.map((n) => n.z));

    const boundary = createNode({
      type: 'group',
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      // Boundaries stack among themselves by z (see `projection.ts`), so a nested one must sit
      // above the boundary it lives in or it would render — and hit-test — underneath it.
      z: sharedParent ? Math.max(minZ - 1, (byId.get(sharedParent)?.z ?? 0) + 1) : minZ - 1,
      text: 'Boundary',
      ...(sharedParent ? { parentId: sharedParent } : {}),
    });

    state.apply(
      'Group',
      (doc) => setParent(addNodes(doc, [boundary]), members.map((n) => n.id), boundary.id),
      { selection: { nodes: [boundary.id], edges: [] } },
    );
  },

  ungroupSelection() {
    const state = get();
    const boundaries = state.document.nodes.filter(
      (n) => n.type === 'group' && state.selection.nodes.includes(n.id),
    );
    if (boundaries.length === 0) return;
    const boundaryIds = new Set(boundaries.map((b) => b.id));
    const byId = new Map(state.document.nodes.map((n) => [n.id, n] as const));
    // Children move up to the nearest ancestor that survives the ungroup — not to the top
    // level, which would also pull them out of any boundary the ungrouped one sat inside.
    const survivingParentOf = (id: string | undefined): string | undefined => {
      let current = id;
      while (current && boundaryIds.has(current)) current = byId.get(current)?.parentId;
      return current;
    };
    const children = state.document.nodes.filter((n) => n.parentId && boundaryIds.has(n.parentId));

    state.apply(
      'Ungroup',
      (doc) => {
        let detached = doc;
        for (const child of children) detached = setParent(detached, [child.id], survivingParentOf(child.parentId));
        // Remove only the boundary; `removeElements` would take the contents too — but that also
        // means skipping its flow cleanup, so a boundary spotlit by a flow step is pruned here.
        return pruneFlowSteps(
          { ...detached, nodes: detached.nodes.filter((n) => !boundaryIds.has(n.id)) },
          new Set(),
          boundaryIds,
        );
      },
      { selection: { nodes: children.map((child) => child.id), edges: [] } },
    );
  },

  attachToNode(hostId, attachment, insertIndex) {
    get().apply('Attach', (doc) => attachToNodeOp(doc, hostId, attachment, insertIndex));
  },

  attachExistingNode(nodeId, hostId) {
    const state = get();
    const node = state.document.nodes.find((n) => n.id === nodeId);
    const host = state.document.nodes.find((n) => n.id === hostId);
    // The node is deleted in the same step, so anything the attachment can't carry is refused
    // up front: a full host, or a card with attachments of its own.
    if (!node || !host || !hasAttachmentRoom(host, 'node') || node.attachments?.length) return;
    // Callers only invoke this for a node whose type is already attachable
    // (checked against ATTACHABLE_TYPES before the drag is even armed).
    const attachment = createAttachment({
      type: node.type as AttachableType,
      text: node.text,
      accent: node.accent,
      noteKind: node.noteKind,
      language: node.language,
      code: node.code,
      width: node.width,
      height: node.height,
    });
    state.apply(
      'Attach',
      (doc) => attachToNodeOp(removeElements(doc, [nodeId]), hostId, attachment),
      { selection: EMPTY_SELECTION },
    );
  },

  detachAttachment(hostId, attachmentId) {
    const state = get();
    const result = detachFromNode(state.document, hostId, attachmentId);
    if (!result.extractedNode) return;
    state.apply('Detach', () => result.doc, {
      selection: { nodes: [result.extractedNode!.id], edges: [] },
    });
  },

  updateAttachment(hostId, attachmentId, patch) {
    get().apply('Edit attachment', (doc) => updateAttachmentOp(doc, hostId, attachmentId, patch));
  },

  removeAttachment(hostId, attachmentId) {
    get().apply('Remove attachment', (doc) => removeAttachmentOp(doc, hostId, attachmentId));
  },

  reorderAttachment(hostId, attachmentId, direction) {
    get().apply('Reorder attachment', (doc) => reorderAttachmentOp(doc, hostId, attachmentId, direction));
  },

  attachToEdge(edgeId, attachment) {
    get().apply('Attach', (doc) => attachToEdgeOp(doc, edgeId, attachment));
  },

  attachExistingNodeToEdge(nodeId, edgeId) {
    const state = get();
    const node = state.document.nodes.find((n) => n.id === nodeId);
    const edge = state.document.edges.find((e) => e.id === edgeId);
    if (!node || !edge || !hasAttachmentRoom(edge, 'edge') || node.attachments?.length) return;
    // Removing the node below also removes its own connectors — this one included — so the
    // attachment would have nowhere to land and the card would simply be deleted.
    if (edge.source === nodeId || edge.target === nodeId) return;
    // Callers only invoke this for a note/code node — checked before the drag is even armed.
    const attachment = createAttachment({
      type: node.type as AttachableType,
      text: node.text,
      accent: node.accent,
      noteKind: node.noteKind,
      language: node.language,
      code: node.code,
      width: node.width,
      height: node.height,
    });
    state.apply(
      'Attach',
      (doc) => attachToEdgeOp(removeElements(doc, [nodeId]), edgeId, attachment),
      { selection: EMPTY_SELECTION },
    );
  },

  updateEdgeAttachment(edgeId, attachmentId, patch) {
    get().apply('Edit attachment', (doc) => updateEdgeAttachmentOp(doc, edgeId, attachmentId, patch));
  },

  removeEdgeAttachment(edgeId, attachmentId) {
    get().apply('Remove attachment', (doc) => removeEdgeAttachmentOp(doc, edgeId, attachmentId));
  },

  detachEdgeAttachment(edgeId, attachmentId) {
    const state = get();
    const result = detachFromEdgeOp(state.document, edgeId, attachmentId);
    if (!result.extractedNode) return;
    state.apply('Detach', () => result.doc, {
      selection: { nodes: [result.extractedNode!.id], edges: [] },
    });
  },

  reorderEdgeAttachment(edgeId, attachmentId, direction) {
    get().apply('Reorder attachment', (doc) => reorderEdgeAttachmentOp(doc, edgeId, attachmentId, direction));
  },

  reparentNode(nodeId, boundaryId) {
    get().apply('Reparent', (doc) => setParent(doc, [nodeId], boundaryId ?? undefined));
  },

  raise(toFront = false) {
    const { selection, apply } = get();
    apply('Bring forward', (doc) =>
      toFront ? bringToFront(doc, selection.nodes) : bringForward(doc, selection.nodes),
    );
  },

  lower(toBack = false) {
    const { selection, apply } = get();
    apply('Send backward', (doc) =>
      toBack ? sendToBack(doc, selection.nodes) : sendBackward(doc, selection.nodes),
    );
  },

  createFlow(title) {
    const flow = createFlowEntity({ title: title?.trim() || nextFlowTitle(get().document) });
    get().apply('Create flow', (doc) => addFlow(doc, flow));
    // `addFlow` silently refuses at the cap; without this check a caller would go on to select
    // and append steps to a flow that doesn't exist.
    return get().document.flows.some((f) => f.id === flow.id) ? flow.id : null;
  },

  renameFlow(flowId, title) {
    get().apply('Rename flow', (doc) => renameFlow(doc, flowId, title), {
      coalesceKey: `flow-title:${flowId}`,
    });
  },

  setFlowAccent(flowId, accent) {
    get().apply('Set flow colour', (doc) => setFlowAccentOp(doc, flowId, accent ?? undefined), {
      coalesceKey: `flow-accent:${flowId}`,
    });
  },

  deleteFlow(flowId) {
    const state = get();
    // Deleting a flow forcibly clears any session state that referenced it, outside the document
    // itself — captured here so undoing the delete can restore it too, rather than leave "which
    // flow's step badges were showing" reset with no way back. See `FlowSessionSnapshot`.
    const flowSessionBefore: FlowSessionSnapshot = {
      selectedFlowId: state.selectedFlowId,
      flowPlayback: state.flowPlayback,
    };
    const nextSelectedFlowId = state.selectedFlowId === flowId ? null : state.selectedFlowId;
    const nextFlowPlayback: FlowSessionSnapshot['flowPlayback'] =
      state.flowPlayback.flowId === flowId ? { active: false, flowId: null, step: 0 } : state.flowPlayback;
    const flowSessionAfter: FlowSessionSnapshot = {
      selectedFlowId: nextSelectedFlowId,
      flowPlayback: nextFlowPlayback,
    };
    get().apply('Delete flow', (doc) => deleteFlow(doc, flowId), { flowSessionBefore, flowSessionAfter });
    set({ selectedFlowId: nextSelectedFlowId, flowPlayback: nextFlowPlayback });
  },

  addEdgeToFlow(flowId, edgeId, caption) {
    get().apply('Add step', (doc) => addStepToFlow(doc, flowId, edgeId, caption));
  },

  removeFlowStep(flowId, stepId) {
    get().apply('Remove step', (doc) => removeStepFromFlow(doc, flowId, stepId));
  },

  moveFlowStep(flowId, stepId, direction) {
    get().apply('Reorder step', (doc) => moveStepInFlow(doc, flowId, stepId, direction));
  },

  updateFlowStepCaption(flowId, stepId, caption) {
    get().apply('Edit caption', (doc) => updateFlowStepCaptionOp(doc, flowId, stepId, caption), {
      coalesceKey: `flow-step-caption:${stepId}`,
    });
  },

  addFlowStepExtraNode(flowId, stepId, nodeId) {
    get().apply('Add to step', (doc) => addStepExtraNode(doc, flowId, stepId, nodeId));
  },

  removeFlowStepExtraNode(flowId, stepId, nodeId) {
    get().apply('Remove from step', (doc) => removeStepExtraNode(doc, flowId, stepId, nodeId));
  },

  addFlowStepExtraEdge(flowId, stepId, edgeId) {
    get().apply('Add to step', (doc) => addStepExtraEdge(doc, flowId, stepId, edgeId));
  },

  removeFlowStepExtraEdge(flowId, stepId, edgeId) {
    get().apply('Remove from step', (doc) => removeStepExtraEdge(doc, flowId, stepId, edgeId));
  },

  setFlowStepViewport(flowId, stepId, viewport) {
    get().apply('Set step view', (doc) => setStepViewport(doc, flowId, stepId, viewport ?? undefined));
  },

  setSelectedFlowId(flowId) {
    set({ selectedFlowId: flowId });
  },

  rename(title) {
    get().apply('Rename', (doc) => setTitle(doc, title), { coalesceKey: 'title' });
  },

  updateSettings(patch, options) {
    get().apply('Change settings', (doc) => setSettings(doc, patch), { coalesceKey: options?.coalesceKey });
  },

  persistViewport(viewport) {
    // Saved, but not an edit: no undo step (nobody wants ⌘Z to undo a scroll), no new document,
    // no `updatedAt`. See `liveViewport`.
    const state = get();
    const current = state.liveViewport ?? state.document.viewport;
    const next = setViewport(state.document, viewport).viewport;
    if (next.x === current.x && next.y === current.y && next.zoom === current.zoom) return;
    set({ liveViewport: next });
  },

  undo() {
    const state = get();
    // Mid-gesture (a drag or resize still held), swapping the document out from under it would
    // fold the restored state into the gesture's own entry and clear the redo stack.
    if (interaction) return;
    const { history, entry } = undoStack(state.history);
    if (!entry) return;
    set((s) => ({
      history,
      document: entry.before,
      selection: entry.selectionBefore,
      revision: s.revision + 1,
      ...reconcileSessionState(entry.before, s),
      // Overrides whatever reconcileSessionState just computed for selectedFlowId —
      // focus isn't part of the snapshot and still goes through the reconciler's own pruning
      // above regardless. See `FlowSessionSnapshot`.
      ...(entry.flowSessionBefore ?? {}),
    }));
  },

  redo() {
    const state = get();
    if (interaction) return;
    const { history, entry } = redoStack(state.history);
    if (!entry) return;
    set((s) => ({
      history,
      document: entry.after,
      selection: entry.selectionAfter,
      revision: s.revision + 1,
      ...reconcileSessionState(entry.after, s),
      ...(entry.flowSessionAfter ?? {}),
    }));
  },

  canUndo: () => canUndo(get().history),
  canRedo: () => canRedo(get().history),

  setSelection(selection) {
    set({ selection });
  },

  setSaveState(save) {
    set({ save });
  },

  setMode(mode) {
    set((s) => ({
      mode,
      flowPlayback: mode === 'edit' ? { active: false, flowId: null, step: 0 } : s.flowPlayback,
      // A selection ring left over from editing has no meaning in a
      // read-only presentation — nothing there can show why it is
      // highlighted, so it just reads as a stray mark on one box.
      selection: mode === 'present' ? EMPTY_SELECTION : s.selection,
    }));
  },

  setFlowPlayback(playback) {
    set((s) => ({
      flowPlayback: { ...s.flowPlayback, ...playback },
      // Mutually exclusive with Focus — starting playback exits it, rather
      // than the two dimming systems ever needing to combine.
      focus: playback.active ? { active: false, nodeIds: [], edgeIds: [] } : s.focus,
    }));
  },

  enterFocus(nodeIds, edgeIds) {
    set((s) => ({
      focus: { active: true, nodeIds, edgeIds },
      flowPlayback: s.flowPlayback.active ? { active: false, flowId: null, step: 0 } : s.flowPlayback,
    }));
  },

  toggleFocusMember(id, kind) {
    set((s) => {
      if (!s.focus.active) return s;
      const key = kind === 'node' ? 'nodeIds' : 'edgeIds';
      const current = s.focus[key];
      const next = current.includes(id) ? current.filter((memberId) => memberId !== id) : [...current, id];
      return { focus: { ...s.focus, [key]: next } };
    });
  },

  exitFocus() {
    set({ focus: { active: false, nodeIds: [], edgeIds: [] } });
  },
}));

/**
 * Guards against writes that produce an equal-but-new document object, which
 * would otherwise fill the undo stack with entries that change nothing.
 */
function shallowEqualDocument(a: DraftDocument, b: DraftDocument): boolean {
  return (
    a.nodes === b.nodes &&
    a.edges === b.edges &&
    a.flows === b.flows &&
    a.settings === b.settings &&
    a.viewport === b.viewport &&
    a.metadata.title === b.metadata.title
  );
}

/** Test seam: interaction state lives outside the store, so it needs resetting. */
export function __resetInteraction(): void {
  interaction = null;
}

/** Test seam: the last-synced system-clipboard text lives outside the store too. */
export function __resetClipboardSync(): void {
  lastSystemClipboardText = null;
}

/**
 * Switching a note to a tagged kind (Question, Warning, Decision) pushes its body down by a tag
 * line; without this the last line of a note that fit exactly would turn into an ellipsis. The
 * same grow-only rule the canvas applies when text is committed — never shrinks.
 */
function growNoteToFit(doc: DraftDocument, id: string): DraftDocument {
  const node = doc.nodes.find((n) => n.id === id);
  if (!node || node.type !== 'note') return doc;
  const needed = naturalNoteHeight(node, node.text ?? '', { measurer: getMeasurer() });
  return needed > node.height ? updateNode(doc, id, { height: needed }) : doc;
}

/** Same idea as `growNoteToFit`: a role/bold/italic change can make the same text wrap onto more
 *  lines (a bigger font, a heavier — hence wider — weight), so the box has to be re-checked, not
 *  just the text re-rendered inside whatever height it already had. Grow-only, never shrinks a box
 *  sized by hand. */
function growTextToFit(doc: DraftDocument, id: string): DraftDocument {
  const node = doc.nodes.find((n) => n.id === id);
  if (!node || node.type !== 'text') return doc;
  const needed = naturalTextHeight(node, node.text ?? '', { measurer: getMeasurer() });
  return needed > node.height ? updateNode(doc, id, { height: needed }) : doc;
}
