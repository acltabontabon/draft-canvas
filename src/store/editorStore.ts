import { create } from 'zustand';
import {
  createAttachment,
  createDocument,
  createEdge,
  createNode,
  type CreateNodeInput,
} from '../document/factory';
import {
  addEdges,
  addNodes,
  alignNodes,
  attachToEdge as attachToEdgeOp,
  attachToNode as attachToNodeOp,
  bringForward,
  bringToFront,
  detachFromNode,
  distributeNodes,
  extractFragment,
  moveNodes,
  pasteFragment,
  reconnectEdge as reconnectEdgeOp,
  removeAttachment as removeAttachmentOp,
  removeEdgeAttachment as removeEdgeAttachmentOp,
  removeElements,
  reorderAttachment as reorderAttachmentOp,
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
import {
  addFlow,
  createFlow as createFlowEntity,
  addStepToFlow,
  addStepExtraEdge,
  addStepExtraNode,
  deleteFlow,
  moveStepInFlow,
  removeStepExtraEdge,
  removeStepExtraNode,
  removeStepFromFlow,
  renameFlow,
  setFlowAccent as setFlowAccentOp,
  setStepViewport,
  updateFlowStepCaption as updateFlowStepCaptionOp,
} from '../document/flow';
import { SEMANTIC_DEFAULTS } from '../document/edgeSemantics';
import {
  inferRelationship,
  isEligibleForReinference,
} from '../document/connectorSemantics';
import type {
  Accent,
  AttachableType,
  Attachment,
  DraftDocument,
  DraftEdge,
  DraftNode,
  ConnectorKind,
  DraftSettings,
  DraftViewport,
  EdgeSemantic,
  Side,
} from '../document/types';
import {
  EMPTY_HISTORY,
  EMPTY_SELECTION,
  canRedo,
  canUndo,
  pushEntry,
  redo as redoStack,
  undo as undoStack,
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
  if (focus.edgeIds.includes(edge.id)) return true;
  return focus.nodeIds.includes(edge.source) && focus.nodeIds.includes(edge.target);
}

/**
 * The deliberate, entered-on-purpose state for editing a specific flow's
 * membership/order — distinct from merely *selecting* a flow to inspect it
 * (`selectedFlowId`, which never mutates anything). Mutually exclusive with
 * both `flowPlayback` and `focus`, the same way those two already exclude
 * each other: entering any one of the three exits whichever of the other two
 * was active. Never persisted, never pushed to history — the document
 * mutations it enables go through `apply()` and are undoable individually;
 * this flag itself is pure UI state.
 */
export interface FlowEditState {
  active: boolean;
  flowId: string | null;
}

interface Interaction {
  label: string;
  document: DraftDocument;
  selection: Selection;
}

export interface EditorStore {
  document: DraftDocument;
  history: HistoryState;
  selection: Selection;
  clipboard: Clipboard | null;
  save: SaveState;
  mode: EditorMode;
  flowPlayback: FlowPlaybackState;
  focus: FocusState;
  flowEdit: FlowEditState;
  /** Which flow's step badges show on the canvas (independent of playback). */
  selectedFlowId: string | null;
  /** Bumped on every document write; autosave watches this rather than deep-diffing. */
  revision: number;

  /* Document access */
  setDocument: (document: DraftDocument, options?: { resetHistory?: boolean }) => void;
  apply: (label: string, recipe: (doc: DraftDocument) => DraftDocument, options?: ApplyOptions) => void;

  /* Interactions (drag, resize) collapse into one undo entry */
  beginInteraction: (label: string) => void;
  endInteraction: () => void;

  /* Editing commands */
  addNode: (input: CreateNodeInput) => DraftNode;
  addNodesWithEdges: (nodes: DraftNode[], edges: DraftEdge[], label: string) => void;
  connect: (
    source: string,
    target: string,
    sourceSide?: Side,
    targetSide?: Side,
    sourceOffset?: number,
    targetOffset?: number,
  ) => DraftEdge | null;
  updateNodeById: (id: string, patch: Partial<Omit<DraftNode, 'id'>>, label?: string) => void;
  updateNodeText: (id: string, text: string) => void;
  updateEdgeById: (id: string, patch: Partial<Omit<DraftEdge, 'id' | 'source' | 'target'>>, label?: string) => void;
  /** Dragging an existing connector's endpoint to a new node/side. */
  reconnectEdge: (
    id: string,
    endpoint: 'source' | 'target',
    newNodeId: string,
    newSide: Side | undefined,
    newOffset?: number,
  ) => void;
  updateEdgeLabel: (id: string, label: string) => void;
  /** Sets (or clears) a semantic type — fills the default label only if the
   *  edge has none, and never touches `accent`. See `document/edgeSemantics.ts`. */
  setEdgeSemantic: (id: string, semantic: EdgeSemantic | undefined) => void;
  /** Free-text condition chip, e.g. "approved" — display only, never evaluated. */
  setEdgeCondition: (id: string, condition: string) => void;
  toggleEdgeAsync: (id: string) => void;
  /** Sets (or clears) a connector's flow-behaviour kind — see `ConnectorKind`. */
  setEdgeKind: (id: string, kind: ConnectorKind | undefined) => void;
  commitPositions: (positions: Map<string, { x: number; y: number }>) => void;
  /** Moves every selected node by a pixel delta — repeated taps coalesce. */
  nudgeSelection: (dx: number, dy: number) => void;
  deleteSelection: () => void;
  duplicateSelection: () => void;
  copySelection: () => void;
  paste: (offset?: { x: number; y: number }) => void;
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

  /* Boundary containment */
  /** Sets or clears (`boundaryId: null`) a node's containing boundary. */
  reparentNode: (nodeId: string, boundaryId: string | null) => void;

  /* Flows */
  createFlow: (title?: string) => string;
  renameFlow: (flowId: string, title: string) => void;
  /** Sets, or clears (`accent: null`), a flow's lens accent — see `DraftFlow.accent`. */
  setFlowAccent: (flowId: string, accent: Accent | null) => void;
  deleteFlow: (flowId: string) => void;
  addEdgeToFlow: (flowId: string, edgeId: string, caption?: string) => void;
  removeFlowStep: (flowId: string, stepId: string) => void;
  moveFlowStep: (flowId: string, stepId: string, direction: -1 | 1) => void;
  updateFlowStepCaption: (flowId: string, stepId: string, caption: string) => void;
  /** Enters intentional flow-editing mode — see `FlowEditState`'s own comment. */
  enterFlowEdit: (flowId: string) => void;
  exitFlowEdit: () => void;
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
  updateSettings: (patch: Partial<DraftSettings>) => void;
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
}

let interaction: Interaction | null = null;

export const useEditorStore = create<EditorStore>((set, get) => ({
  document: createDocument(),
  history: EMPTY_HISTORY,
  selection: EMPTY_SELECTION,
  clipboard: null,
  save: { status: 'idle' },
  mode: 'edit',
  flowPlayback: { active: false, flowId: null, step: 0 },
  focus: { active: false, nodeIds: [], edgeIds: [] },
  flowEdit: { active: false, flowId: null },
  selectedFlowId: null,
  revision: 0,

  setDocument(document, options) {
    interaction = null;
    set((state) => ({
      document,
      history: options?.resetHistory === false ? state.history : EMPTY_HISTORY,
      selection: EMPTY_SELECTION,
      flowPlayback: { active: false, flowId: null, step: 0 },
      focus: { active: false, nodeIds: [], edgeIds: [] },
      flowEdit: { active: false, flowId: null },
      // With exactly one flow there's no ambiguity about which one's step
      // badges to show, so a freshly opened diagram isn't blank of them.
      // With several, none is auto-selected — guessing wrong would be worse
      // than showing none until the user picks.
      selectedFlowId: document.flows.length === 1 ? document.flows[0]!.id : null,
      revision: state.revision + 1,
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
      }));
      return;
    }

    const selectionAfter = options?.selection ?? state.selection;
    set((s) => ({
      document: next,
      selection: selectionAfter,
      revision: s.revision + 1,
      history: pushEntry(s.history, {
        label,
        before,
        after: next,
        selectionBefore: state.selection,
        selectionAfter,
        at: Date.now(),
        coalesceKey: options?.coalesceKey,
      }),
    }));
  },

  beginInteraction(label) {
    const state = get();
    interaction = { label, document: state.document, selection: state.selection };
  },

  endInteraction() {
    const active = interaction;
    interaction = null;
    if (!active) return;
    const state = get();
    // A click that moved nothing leaves the document identical; no entry.
    if (state.document === active.document) return;
    set((s) => ({
      history: pushEntry(s.history, {
        label: active.label,
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

  addNodesWithEdges(nodes, edges, label) {
    get().apply(label, (doc) => addEdges(addNodes(doc, nodes), edges), {
      selection: { nodes: nodes.map((n) => n.id), edges: [] },
    });
  },

  connect(source, target, sourceSide, targetSide, sourceOffset = 0.5, targetOffset = 0.5) {
    const state = get();
    if (source === target) return null;
    const exists = state.document.edges.some((e) => e.source === source && e.target === target);
    if (exists) return null;
    // Infer a relationship from what's actually being connected — see
    // `inferRelationship`'s doc comment for exactly which pairings apply.
    const sourceNode = state.document.nodes.find((n) => n.id === source);
    const targetNode = state.document.nodes.find((n) => n.id === target);
    const relationship = sourceNode && targetNode ? inferRelationship(sourceNode, targetNode) : undefined;
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
      semanticsOrigin: relationship ? 'inferred' : undefined,
    });
    state.apply('Connect', (doc) => addEdges(doc, [edge]), {
      selection: { nodes: [], edges: [edge.id] },
    });
    return edge;
  },

  updateNodeById(id, patch, label = 'Change node') {
    get().apply(label, (doc) => updateNode(doc, id, patch));
  },

  updateNodeText(id, text) {
    get().apply('Edit text', (doc) => updateNode(doc, id, { text }), {
      coalesceKey: `text:${id}`,
    });
  },

  updateEdgeById(id, patch, label = 'Change connection') {
    get().apply(label, (doc) => updateEdge(doc, id, patch));
  },

  reconnectEdge(id, endpoint, newNodeId, newSide, newOffset = 0.5) {
    get().apply('Reconnect', (doc) => {
      const reconnected = reconnectEdgeOp(doc, id, endpoint, newNodeId, newSide, newOffset);
      const edge = reconnected.edges.find((e) => e.id === id);
      if (!edge || !isEligibleForReinference(edge)) return reconnected;
      const sourceNode = reconnected.nodes.find((n) => n.id === edge.source);
      const targetNode = reconnected.nodes.find((n) => n.id === edge.target);
      if (!sourceNode || !targetNode) return reconnected;
      // Only an edge inference already claimed, or one nothing has ever
      // touched, gets reclassified here — an explicit user choice survives a
      // reconnect untouched. See `isEligibleForReinference`.
      const relationship = inferRelationship(sourceNode, targetNode);
      return updateEdge(reconnected, id, {
        semantic: relationship?.semantic,
        kind: relationship?.kind,
        semanticsOrigin: relationship ? 'inferred' : undefined,
      });
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
    // Only a fill-in-the-blank convenience: never overrides a label the user
    // already gave the connection, and never touches `accent` at all.
    if (semantic && !edge.label) patch.label = SEMANTIC_DEFAULTS[semantic].label;
    state.apply('Set connection type', (doc) => updateEdge(doc, id, patch));
  },

  setEdgeCondition(id, condition) {
    get().apply('Set condition', (doc) => updateEdge(doc, id, { condition: condition.trim() || undefined }), {
      coalesceKey: `edge-condition:${id}`,
    });
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
    state.apply('Nudge', (doc) => moveNodes(doc, positions), { coalesceKey: 'nudge' });
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
  },

  copySelection() {
    const state = get();
    if (state.selection.nodes.length === 0) return;
    set({ clipboard: extractFragment(state.document, state.selection.nodes) });
  },

  paste(offset = { x: 32, y: 32 }) {
    const state = get();
    const fragment = state.clipboard;
    if (!fragment || fragment.nodes.length === 0) return;
    const result = pasteFragment(state.document, fragment, offset);
    state.apply('Paste', () => result.doc, {
      selection: { nodes: result.nodeIds, edges: result.edgeIds },
    });
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
    const members = state.document.nodes.filter((n) => state.selection.nodes.includes(n.id));
    if (members.length < 2) return;

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
      z: minZ - 1,
      text: 'Boundary',
    });

    state.apply(
      'Group',
      (doc) => setParent(addNodes(doc, [boundary]), state.selection.nodes, boundary.id),
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
    const children = state.document.nodes
      .filter((n) => n.parentId && boundaryIds.has(n.parentId))
      .map((n) => n.id);

    state.apply(
      'Ungroup',
      (doc) => {
        const detached = setParent(doc, children, undefined);
        // Remove only the boundary; `removeElements` would take the contents too.
        return { ...detached, nodes: detached.nodes.filter((n) => !boundaryIds.has(n.id)) };
      },
      { selection: { nodes: children, edges: [] } },
    );
  },

  attachToNode(hostId, attachment, insertIndex) {
    get().apply('Attach', (doc) => attachToNodeOp(doc, hostId, attachment, insertIndex));
  },

  attachExistingNode(nodeId, hostId) {
    const state = get();
    const node = state.document.nodes.find((n) => n.id === nodeId);
    if (!node) return;
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
    if (!node) return;
    // Callers only invoke this for a note/code node — checked before the drag is even armed.
    const attachment = createAttachment({
      type: node.type as AttachableType,
      text: node.text,
      accent: node.accent,
      noteKind: node.noteKind,
      language: node.language,
      code: node.code,
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
    const flow = createFlowEntity({ title });
    get().apply('Create flow', (doc) => addFlow(doc, flow));
    return flow.id;
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
    get().apply('Delete flow', (doc) => deleteFlow(doc, flowId));
    set((s) => ({
      selectedFlowId: s.selectedFlowId === flowId ? null : s.selectedFlowId,
      flowPlayback: s.flowPlayback.flowId === flowId ? { active: false, flowId: null, step: 0 } : s.flowPlayback,
      flowEdit: s.flowEdit.flowId === flowId ? { active: false, flowId: null } : s.flowEdit,
    }));
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

  updateSettings(patch) {
    get().apply('Change settings', (doc) => setSettings(doc, patch));
  },

  persistViewport(viewport) {
    // The viewport is saved but is not an editorial action, so it stays out of
    // the undo stack — nobody wants Ctrl+Z to undo a scroll.
    get().apply('Viewport', (doc) => setViewport(doc, viewport), { transient: true });
  },

  undo() {
    const state = get();
    const { history, entry } = undoStack(state.history);
    if (!entry) return;
    set((s) => ({
      history,
      document: entry.before,
      selection: entry.selectionBefore,
      revision: s.revision + 1,
    }));
  },

  redo() {
    const state = get();
    const { history, entry } = redoStack(state.history);
    if (!entry) return;
    set((s) => ({
      history,
      document: entry.after,
      selection: entry.selectionAfter,
      revision: s.revision + 1,
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
      // Flow-editing is an edit-mode-only concept — presenting exits it, the
      // same way it exits playback's own picker state.
      flowEdit: mode === 'present' ? { active: false, flowId: null } : s.flowEdit,
      // A selection ring left over from editing has no meaning in a
      // read-only presentation — nothing there can show why it is
      // highlighted, so it just reads as a stray mark on one box.
      selection: mode === 'present' ? EMPTY_SELECTION : s.selection,
    }));
  },

  setFlowPlayback(playback) {
    set((s) => ({
      flowPlayback: { ...s.flowPlayback, ...playback },
      // Mutually exclusive with Focus and flow-editing — starting playback
      // exits both, rather than any two of the three dimming/editing systems
      // ever needing to combine.
      focus: playback.active ? { active: false, nodeIds: [], edgeIds: [] } : s.focus,
      flowEdit: playback.active ? { active: false, flowId: null } : s.flowEdit,
    }));
  },

  enterFocus(nodeIds, edgeIds) {
    set((s) => ({
      focus: { active: true, nodeIds, edgeIds },
      flowPlayback: s.flowPlayback.active ? { active: false, flowId: null, step: 0 } : s.flowPlayback,
      flowEdit: s.flowEdit.active ? { active: false, flowId: null } : s.flowEdit,
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

  enterFlowEdit(flowId) {
    set((s) => ({
      flowEdit: { active: true, flowId },
      focus: s.focus.active ? { active: false, nodeIds: [], edgeIds: [] } : s.focus,
      flowPlayback: s.flowPlayback.active ? { active: false, flowId: null, step: 0 } : s.flowPlayback,
    }));
  },

  exitFlowEdit() {
    set({ flowEdit: { active: false, flowId: null } });
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
