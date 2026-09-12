/**
 * Pure document transforms. Every function returns a new document that shares
 * structure with the old one — untouched nodes and edges keep their object
 * identity, which is what lets the canvas memoize per node and lets the history
 * stack keep whole snapshots cheaply.
 */
import { createId } from './ids';
import { defaultSizeFor } from './factory';
import { pruneFlowSteps } from './flow';
import { LIMITS } from './limits';
import type {
  Attachment,
  DraftDocument,
  DraftEdge,
  DraftNode,
  DraftViewport,
  DraftSettings,
  Side,
} from './types';

const clampCoord = (n: number) =>
  Number.isFinite(n)
    ? Math.max(-LIMITS.maxCoordinate, Math.min(LIMITS.maxCoordinate, Math.round(n)))
    : 0;

/**
 * Whether the canvas holds nothing at all — the one definition of "empty" the editor's empty
 * state is allowed to use.
 *
 * Nodes alone are sufficient, which looks like a shortcut and isn't. A document's content is
 * `nodes`, `edges` and `flows`; an edge cannot outlive its endpoints (`validate.ts` drops a
 * dangling one on load, `removeElements` prunes it on delete), and a flow step only ever points
 * at an edge — so a non-empty `edges` or `flows` implies a non-empty `nodes`. It is also what the
 * status bar already calls the truth when it counts *elements*.
 *
 * Named rather than inlined so that if some future element is ever stored outside `nodes`, there
 * is exactly one place that has to learn about it.
 */
export function isCanvasEmpty(doc: Pick<DraftDocument, 'nodes'>): boolean {
  return doc.nodes.length === 0;
}

const clampSize = (n: number) =>
  Number.isFinite(n)
    ? Math.max(LIMITS.minNodeSize, Math.min(LIMITS.maxNodeSize, Math.round(n)))
    : LIMITS.minNodeSize;

/** `attachment.width`/`height` should always be set by `createAttachment` — this is a safety
 *  net for attachments predating that guarantee (e.g. loaded from an older saved document). */
function sizeForDetach(attachment: Attachment): { width: number; height: number } {
  if (attachment.width !== undefined && attachment.height !== undefined) {
    return { width: attachment.width, height: attachment.height };
  }
  return defaultSizeFor(attachment.type);
}

function withNodes(doc: DraftDocument, nodes: DraftNode[]): DraftDocument {
  return nodes === doc.nodes ? doc : { ...doc, nodes };
}

function withEdges(doc: DraftDocument, edges: DraftEdge[]): DraftDocument {
  return edges === doc.edges ? doc : { ...doc, edges };
}

/**
 * Spreads `patch` onto `base`, but a key explicitly set to `undefined` in the
 * patch is deleted rather than kept as an own property with value
 * `undefined` — the difference matters for optional fields like an edge's
 * `semantic`, where "clear it" must leave no trace, not a dangling key.
 */
function applyPatch<T extends object>(base: T, patch: Partial<T>): T {
  const next: T = { ...base, ...patch };
  for (const key of Object.keys(patch) as (keyof T)[]) {
    if (patch[key] === undefined) delete next[key];
  }
  return next;
}

export function addNodes(doc: DraftDocument, nodes: DraftNode[]): DraftDocument {
  if (nodes.length === 0) return doc;
  return withNodes(doc, [...doc.nodes, ...nodes]);
}

export function addEdges(doc: DraftDocument, edges: DraftEdge[]): DraftDocument {
  if (edges.length === 0) return doc;
  const existing = new Set(doc.edges.map((e) => e.id));
  const known = new Set(doc.nodes.map((n) => n.id));
  const accepted = edges.filter(
    (e) => !existing.has(e.id) && known.has(e.source) && known.has(e.target),
  );
  if (accepted.length === 0) return doc;
  return withEdges(doc, [...doc.edges, ...accepted]);
}

export function updateNode(
  doc: DraftDocument,
  id: string,
  patch: Partial<Omit<DraftNode, 'id'>>,
): DraftDocument {
  let changed = false;
  const nodes = doc.nodes.map((node) => {
    if (node.id !== id) return node;
    const next: DraftNode = applyPatch<DraftNode>(node, patch);
    if (patch.x !== undefined) next.x = clampCoord(patch.x);
    if (patch.y !== undefined) next.y = clampCoord(patch.y);
    if (patch.width !== undefined) next.width = clampSize(patch.width);
    if (patch.height !== undefined) next.height = clampSize(patch.height);
    changed = true;
    return next;
  });
  return changed ? withNodes(doc, nodes) : doc;
}

export function updateEdge(
  doc: DraftDocument,
  id: string,
  patch: Partial<Omit<DraftEdge, 'id' | 'source' | 'target'>>,
): DraftDocument {
  let changed = false;
  const edges = doc.edges.map((edge) => {
    if (edge.id !== id) return edge;
    changed = true;
    return applyPatch<DraftEdge>(edge, patch);
  });
  return changed ? withEdges(doc, edges) : doc;
}

/**
 * Grabbing an existing connector's endpoint and dropping it somewhere else —
 * a new node, or a new side of the same node — is how a user explicitly
 * overrides a previously persisted anchor (see `EdgeAnchor` in `types.ts`).
 * Only the endpoint actually dragged changes; the other one, and its anchor,
 * are untouched. `newSide` absent (a body-hit, not a handle) clears that
 * endpoint's anchor instead of leaving it stale, so routing falls back to
 * `chooseSides` for it going forward — the same as a freshly drawn edge
 * whose drop wasn't aimed at a specific side.
 *
 * A separate function from `updateEdge`, not a cast around it: that patch
 * type deliberately excludes `source`/`target` so nothing else can rewire an
 * edge's endpoints by accident. This is the one place that's the point.
 */
export function reconnectEdge(
  doc: DraftDocument,
  id: string,
  endpoint: 'source' | 'target',
  newNodeId: string,
  newSide: Side | undefined,
  newOffset = 0.5,
): DraftDocument {
  // Mirrors `addEdges`' own guard: a reconnect racing a concurrent delete of the node being
  // dropped onto (or handed a stale id from any other caller) must never leave the edge pointing
  // at a node that no longer exists.
  if (!doc.nodes.some((node) => node.id === newNodeId)) return doc;
  const anchor = newSide ? { side: newSide, offset: newOffset } : undefined;
  let changed = false;
  const edges = doc.edges.map((edge) => {
    if (edge.id !== id) return edge;
    // Mirrors `connect()`'s own source === target guard: moving one endpoint onto the other,
    // untouched one would leave a self-loop routing/hit-testing never expects.
    const otherEndpoint = endpoint === 'source' ? edge.target : edge.source;
    if (newNodeId === otherEndpoint) return edge;
    changed = true;
    const next: DraftEdge =
      endpoint === 'source' ? { ...edge, source: newNodeId } : { ...edge, target: newNodeId };
    const anchorKey = endpoint === 'source' ? 'sourceAnchor' : 'targetAnchor';
    if (anchor) next[anchorKey] = anchor;
    else delete next[anchorKey];
    return next;
  });
  return changed ? withEdges(doc, edges) : doc;
}

/**
 * Swaps a connector's direction. Only the two endpoints and their anchors move — the label, the
 * semantic, the kind, the condition/response chips, attachments, and `semanticsOrigin` all stay
 * exactly as they were: reversing which way an arrow points never changes which node kinds are
 * on each end, so unlike `reconnectEdge` there is nothing for inference to re-derive. Flow steps
 * reference the edge by id, so they keep pointing at this connector too.
 */
export function reverseEdge(doc: DraftDocument, id: string): DraftDocument {
  let changed = false;
  const edges = doc.edges.map((edge) => {
    if (edge.id !== id) return edge;
    changed = true;
    const next: DraftEdge = { ...edge, source: edge.target, target: edge.source };
    // Absent stays absent — never write an `undefined` own-property a serializer would emit.
    if (edge.targetAnchor) next.sourceAnchor = edge.targetAnchor;
    else delete next.sourceAnchor;
    if (edge.sourceAnchor) next.targetAnchor = edge.sourceAnchor;
    else delete next.targetAnchor;
    return next;
  });
  return changed ? withEdges(doc, edges) : doc;
}

/** Applies a batch of positions in one pass — used to commit a drag gesture. */
export function moveNodes(
  doc: DraftDocument,
  positions: Map<string, { x: number; y: number }>,
): DraftDocument {
  if (positions.size === 0) return doc;
  let changed = false;
  const nodes = doc.nodes.map((node) => {
    const pos = positions.get(node.id);
    if (!pos) return node;
    const x = clampCoord(pos.x);
    const y = clampCoord(pos.y);
    if (x === node.x && y === node.y) return node;
    changed = true;
    return { ...node, x, y };
  });
  return changed ? withNodes(doc, nodes) : doc;
}

/**
 * Deletes nodes and edges, cascading the references that would otherwise dangle:
 * edges attached to a deleted node, and children of a deleted group.
 */
export function removeElements(
  doc: DraftDocument,
  nodeIds: Iterable<string>,
  edgeIds: Iterable<string> = [],
): DraftDocument {
  const removingNodes = new Set(nodeIds);
  const removingEdges = new Set(edgeIds);
  if (removingNodes.size === 0 && removingEdges.size === 0) return doc;

  // Deleting a boundary deletes what it contains, transitively.
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of doc.nodes) {
      if (node.parentId && removingNodes.has(node.parentId) && !removingNodes.has(node.id)) {
        removingNodes.add(node.id);
        grew = true;
      }
    }
  }

  const nodes = doc.nodes.filter((n) => !removingNodes.has(n.id));
  const edges = doc.edges.filter(
    (e) => !removingEdges.has(e.id) && !removingNodes.has(e.source) && !removingNodes.has(e.target),
  );
  if (nodes.length === doc.nodes.length && edges.length === doc.edges.length) return doc;

  const removedEdgeIds = new Set(
    doc.edges.filter((e) => !edges.includes(e)).map((e) => e.id),
  );
  return pruneFlowSteps({ ...doc, nodes, edges }, removedEdgeIds, removingNodes);
}

export interface Clipboard {
  nodes: DraftNode[];
  edges: DraftEdge[];
}

/** Extracts a self-contained fragment: only edges whose endpoints are both copied. */
export function extractFragment(doc: DraftDocument, nodeIds: Iterable<string>): Clipboard {
  const ids = new Set(nodeIds);
  const nodes = doc.nodes.filter((n) => ids.has(n.id));
  const edges = doc.edges.filter((e) => ids.has(e.source) && ids.has(e.target));
  return { nodes: structuredClone(nodes), edges: structuredClone(edges) };
}

/** Re-identifies a fragment and offsets it, so paste never collides with the original. */
export function instantiateFragment(
  fragment: Clipboard,
  offset: { x: number; y: number },
): Clipboard {
  const idMap = new Map<string, string>();
  for (const node of fragment.nodes) idMap.set(node.id, createId('n'));

  const nodes = fragment.nodes.map((node) => {
    const next: DraftNode = {
      ...node,
      id: idMap.get(node.id)!,
      x: clampCoord(node.x + offset.x),
      y: clampCoord(node.y + offset.y),
    };
    // A parent outside the fragment would dangle, so the copy is un-parented.
    if (node.parentId) {
      const mapped = idMap.get(node.parentId);
      if (mapped) next.parentId = mapped;
      else delete next.parentId;
    }
    // Attachments are cloned with the node, so they need fresh ids too —
    // otherwise every paste/duplicate of a node with a note or code card
    // would share that attachment's id with the original.
    if (node.attachments) {
      next.attachments = node.attachments.map((a) => ({ ...a, id: createId('a') }));
    }
    return next;
  });

  const edges = fragment.edges.map((edge) => {
    const next: DraftEdge = {
      ...edge,
      id: createId('e'),
      source: idMap.get(edge.source)!,
      target: idMap.get(edge.target)!,
    };
    if (edge.attachments) {
      next.attachments = edge.attachments.map((a) => ({ ...a, id: createId('a') }));
    }
    return next;
  });

  return { nodes, edges };
}

export function pasteFragment(
  doc: DraftDocument,
  fragment: Clipboard,
  offset: { x: number; y: number },
): { doc: DraftDocument; nodeIds: string[]; edgeIds: string[]; truncated: boolean } {
  const instantiated = instantiateFragment(fragment, offset);
  // `LIMITS.maxNodes`/`maxEdges` are otherwise only enforced on a document taken as a whole (file
  // import, clipboard decode) — pasting/duplicating repeatedly into an already-open document has
  // no other choke point, so cap the *result* here rather than let a document grow without bound.
  const nodeRoom = Math.max(0, LIMITS.maxNodes - doc.nodes.length);
  const edgeRoom = Math.max(0, LIMITS.maxEdges - doc.edges.length);
  const truncated = instantiated.nodes.length > nodeRoom || instantiated.edges.length > edgeRoom;
  const keptNodeIds = new Set(instantiated.nodes.slice(0, nodeRoom).map((n) => n.id));
  const created = {
    nodes: instantiated.nodes.slice(0, nodeRoom),
    // An edge kept past the node cap would dangle, so it's dropped along with whatever edge-count
    // truncation removes — both filters collapse to one pass.
    edges: instantiated.edges
      .filter((e) => keptNodeIds.has(e.source) && keptNodeIds.has(e.target))
      .slice(0, edgeRoom),
  };
  const next = addEdges(addNodes(doc, created.nodes), created.edges);
  return {
    doc: next,
    nodeIds: created.nodes.map((n) => n.id),
    edgeIds: created.edges.map((e) => e.id),
    truncated,
  };
}

/* ---------------------------------------------------------------- z-order -- */

export function bringForward(doc: DraftDocument, ids: Iterable<string>): DraftDocument {
  const set = new Set(ids);
  const max = doc.nodes.reduce((m, n) => Math.max(m, n.z), 0);
  let changed = false;
  const nodes = doc.nodes.map((n) => {
    if (!set.has(n.id)) return n;
    changed = true;
    return { ...n, z: Math.min(max + 1, n.z + 1) };
  });
  return changed ? withNodes(doc, nodes) : doc;
}

export function sendBackward(doc: DraftDocument, ids: Iterable<string>): DraftDocument {
  const set = new Set(ids);
  const min = doc.nodes.reduce((m, n) => Math.min(m, n.z), 0);
  let changed = false;
  const nodes = doc.nodes.map((n) => {
    if (!set.has(n.id)) return n;
    changed = true;
    return { ...n, z: Math.max(min - 1, n.z - 1) };
  });
  return changed ? withNodes(doc, nodes) : doc;
}

export function bringToFront(doc: DraftDocument, ids: Iterable<string>): DraftDocument {
  const set = new Set(ids);
  const max = doc.nodes.reduce((m, n) => Math.max(m, n.z), 0);
  let changed = false;
  const nodes = doc.nodes.map((n) => {
    if (!set.has(n.id)) return n;
    changed = true;
    return { ...n, z: max + 1 };
  });
  return changed ? withNodes(doc, nodes) : doc;
}

export function sendToBack(doc: DraftDocument, ids: Iterable<string>): DraftDocument {
  const set = new Set(ids);
  const min = doc.nodes.reduce((m, n) => Math.min(m, n.z), 0);
  let changed = false;
  const nodes = doc.nodes.map((n) => {
    if (!set.has(n.id)) return n;
    changed = true;
    return { ...n, z: min - 1 };
  });
  return changed ? withNodes(doc, nodes) : doc;
}

/* -------------------------------------------------------------- alignment -- */

export type AlignEdge = 'left' | 'right' | 'top' | 'bottom' | 'centerX' | 'centerY';

export function alignNodes(
  doc: DraftDocument,
  ids: Iterable<string>,
  edge: AlignEdge,
): DraftDocument {
  const set = new Set(ids);
  const targets = doc.nodes.filter((n) => set.has(n.id));
  if (targets.length < 2) return doc;

  const lefts = targets.map((n) => n.x);
  const rights = targets.map((n) => n.x + n.width);
  const tops = targets.map((n) => n.y);
  const bottoms = targets.map((n) => n.y + n.height);

  const positions = new Map<string, { x: number; y: number }>();
  for (const node of targets) {
    let { x, y } = node;
    switch (edge) {
      case 'left':
        x = Math.min(...lefts);
        break;
      case 'right':
        x = Math.max(...rights) - node.width;
        break;
      case 'top':
        y = Math.min(...tops);
        break;
      case 'bottom':
        y = Math.max(...bottoms) - node.height;
        break;
      case 'centerX':
        x = (Math.min(...lefts) + Math.max(...rights)) / 2 - node.width / 2;
        break;
      case 'centerY':
        y = (Math.min(...tops) + Math.max(...bottoms)) / 2 - node.height / 2;
        break;
    }
    positions.set(node.id, { x, y });
  }
  return moveNodes(doc, positions);
}

export function distributeNodes(
  doc: DraftDocument,
  ids: Iterable<string>,
  axis: 'x' | 'y',
): DraftDocument {
  const set = new Set(ids);
  const targets = doc.nodes.filter((n) => set.has(n.id));
  if (targets.length < 3) return doc;

  const size = (n: DraftNode) => (axis === 'x' ? n.width : n.height);
  const start = (n: DraftNode) => (axis === 'x' ? n.x : n.y);
  const sorted = [...targets].sort((a, b) => start(a) - start(b));

  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const span = start(last) + size(last) - start(first);
  const occupied = sorted.reduce((sum, n) => sum + size(n), 0);
  const gap = (span - occupied) / (sorted.length - 1);

  const positions = new Map<string, { x: number; y: number }>();
  let cursor = start(first);
  for (const node of sorted) {
    positions.set(node.id, axis === 'x' ? { x: cursor, y: node.y } : { x: node.x, y: cursor });
    cursor += size(node) + gap;
  }
  return moveNodes(doc, positions);
}

/* ----------------------------------------------------------- attachments --- */

function withAttachments(doc: DraftDocument, hostId: string, attachments: Attachment[]): DraftDocument {
  let changed = false;
  const nodes = doc.nodes.map((node) => {
    if (node.id !== hostId) return node;
    changed = true;
    return attachments.length > 0 ? { ...node, attachments } : withoutAttachmentsField(node);
  });
  return changed ? withNodes(doc, nodes) : doc;
}

function withoutAttachmentsField(node: DraftNode): DraftNode {
  if (!node.attachments) return node;
  const { attachments: _dropped, ...rest } = node;
  return rest;
}

/** Whether a node or connector can take one more attachment. */
export function hasAttachmentRoom(host: { attachments?: readonly Attachment[] }, kind: 'node' | 'edge'): boolean {
  const cap = kind === 'node' ? LIMITS.maxAttachmentsPerNode : LIMITS.maxAttachmentsPerEdge;
  return (host.attachments?.length ?? 0) < cap;
}

/** Folds an attachment onto a host node. `insertIndex` defaults to the end. */
export function attachToNode(
  doc: DraftDocument,
  hostId: string,
  attachment: Attachment,
  insertIndex?: number,
): DraftDocument {
  const host = doc.nodes.find((n) => n.id === hostId);
  if (!host) return doc;
  const existing = host.attachments ?? [];
  // Full is a refusal, never a trim: slicing after the insert would silently push an existing
  // attachment (or the new one) off the end.
  if (existing.length >= LIMITS.maxAttachmentsPerNode) return doc;
  const capped = Math.max(0, Math.min(insertIndex ?? existing.length, existing.length));
  const next = [...existing.slice(0, capped), attachment, ...existing.slice(capped)];
  return withAttachments(doc, hostId, next);
}

/**
 * Removes an attachment and materializes it back into a real, freestanding
 * node — placed deterministically beside the host, never at its old canvas
 * position (an attachment has none once it is folded in).
 */
export function detachFromNode(
  doc: DraftDocument,
  hostId: string,
  attachmentId: string,
): { doc: DraftDocument; extractedNode: DraftNode | null } {
  const host = doc.nodes.find((n) => n.id === hostId);
  const attachment = host?.attachments?.find((a) => a.id === attachmentId);
  if (!host || !attachment) return { doc, extractedNode: null };

  const size = sizeForDetach(attachment);
  let x = host.x + host.width + 32;
  let y = host.y;
  if (x + size.width > LIMITS.maxCoordinate) {
    x = host.x;
    y = host.y + host.height + 32;
  }

  const extractedNode: DraftNode = {
    id: createId('n'),
    type: attachment.type,
    x: clampCoord(x),
    y: clampCoord(y),
    width: clampSize(size.width),
    height: clampSize(size.height),
    z: host.z,
  };
  if (attachment.text !== undefined) extractedNode.text = attachment.text;
  if (attachment.accent) extractedNode.accent = attachment.accent;
  if (attachment.noteKind) extractedNode.noteKind = attachment.noteKind;
  if (attachment.language) extractedNode.language = attachment.language;
  if (attachment.code !== undefined) extractedNode.code = attachment.code;

  const remaining = (host.attachments ?? []).filter((a) => a.id !== attachmentId);
  const next = addNodes(withAttachments(doc, hostId, remaining), [extractedNode]);
  return { doc: next, extractedNode };
}

export function updateAttachment(
  doc: DraftDocument,
  hostId: string,
  attachmentId: string,
  patch: Partial<Omit<Attachment, 'id'>>,
): DraftDocument {
  const host = doc.nodes.find((n) => n.id === hostId);
  if (!host?.attachments) return doc;
  let changed = false;
  const next = host.attachments.map((a) => {
    if (a.id !== attachmentId) return a;
    changed = true;
    return { ...a, ...patch };
  });
  return changed ? withAttachments(doc, hostId, next) : doc;
}

export function removeAttachment(doc: DraftDocument, hostId: string, attachmentId: string): DraftDocument {
  const host = doc.nodes.find((n) => n.id === hostId);
  if (!host?.attachments) return doc;
  const next = host.attachments.filter((a) => a.id !== attachmentId);
  return next.length === host.attachments.length ? doc : withAttachments(doc, hostId, next);
}

export function reorderAttachment(
  doc: DraftDocument,
  hostId: string,
  attachmentId: string,
  direction: -1 | 1,
): DraftDocument {
  const host = doc.nodes.find((n) => n.id === hostId);
  if (!host?.attachments) return doc;
  const index = host.attachments.findIndex((a) => a.id === attachmentId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= host.attachments.length) return doc;
  const next = [...host.attachments];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return withAttachments(doc, hostId, next);
}

/* ------------------------------------------------------- edge attachments --- */

function withEdgeAttachments(doc: DraftDocument, edgeId: string, attachments: Attachment[]): DraftDocument {
  let changed = false;
  const edges = doc.edges.map((edge) => {
    if (edge.id !== edgeId) return edge;
    changed = true;
    return attachments.length > 0 ? { ...edge, attachments } : withoutEdgeAttachmentsField(edge);
  });
  return changed ? withEdges(doc, edges) : doc;
}

function withoutEdgeAttachmentsField(edge: DraftEdge): DraftEdge {
  if (!edge.attachments) return edge;
  const { attachments: _dropped, ...rest } = edge;
  return rest;
}

/** Folds an attachment onto a connector. Mirrors `attachToNode` — see its own comment for why an
 *  edge attachment is the same `Attachment` type, not a parallel one. */
export function attachToEdge(doc: DraftDocument, edgeId: string, attachment: Attachment): DraftDocument {
  const edge = doc.edges.find((e) => e.id === edgeId);
  if (!edge) return doc;
  const existing = edge.attachments ?? [];
  if (existing.length >= LIMITS.maxAttachmentsPerEdge) return doc;
  return withEdgeAttachments(doc, edgeId, [...existing, attachment]);
}

export function updateEdgeAttachment(
  doc: DraftDocument,
  edgeId: string,
  attachmentId: string,
  patch: Partial<Omit<Attachment, 'id'>>,
): DraftDocument {
  const edge = doc.edges.find((e) => e.id === edgeId);
  if (!edge?.attachments) return doc;
  let changed = false;
  const next = edge.attachments.map((a) => {
    if (a.id !== attachmentId) return a;
    changed = true;
    return { ...a, ...patch };
  });
  return changed ? withEdgeAttachments(doc, edgeId, next) : doc;
}

export function removeEdgeAttachment(doc: DraftDocument, edgeId: string, attachmentId: string): DraftDocument {
  const edge = doc.edges.find((e) => e.id === edgeId);
  if (!edge?.attachments) return doc;
  const next = edge.attachments.filter((a) => a.id !== attachmentId);
  return next.length === edge.attachments.length ? doc : withEdgeAttachments(doc, edgeId, next);
}

/** Mirrors `reorderAttachment` — see its own comment for why an edge attachment shares the node
 *  version's exact logic, just against `edge.attachments`/`withEdgeAttachments`. */
export function reorderEdgeAttachment(
  doc: DraftDocument,
  edgeId: string,
  attachmentId: string,
  direction: -1 | 1,
): DraftDocument {
  const edge = doc.edges.find((e) => e.id === edgeId);
  if (!edge?.attachments) return doc;
  const index = edge.attachments.findIndex((a) => a.id === attachmentId);
  const target = index + direction;
  if (index < 0 || target < 0 || target >= edge.attachments.length) return doc;
  const next = [...edge.attachments];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return withEdgeAttachments(doc, edgeId, next);
}

/**
 * Removes an attachment and materializes it back into a real, freestanding node — mirrors
 * `detachFromNode`'s shape and field-copy logic exactly, but placement differs: an edge has no
 * single host rect to sit "beside," so this uses the midpoint between the source and target
 * nodes' own rect centers instead, offset up slightly off the line. Deliberately not
 * `routeBetween`'s live label point — pulling the full routing engine (anchors, lanes, obstacle
 * avoidance) into a pure document op for a one-time placement heuristic isn't worth the coupling.
 */
export function detachFromEdge(
  doc: DraftDocument,
  edgeId: string,
  attachmentId: string,
): { doc: DraftDocument; extractedNode: DraftNode | null } {
  const edge = doc.edges.find((e) => e.id === edgeId);
  const attachment = edge?.attachments?.find((a) => a.id === attachmentId);
  const source = edge ? doc.nodes.find((n) => n.id === edge.source) : undefined;
  const target = edge ? doc.nodes.find((n) => n.id === edge.target) : undefined;
  if (!edge || !attachment || !source || !target) return { doc, extractedNode: null };

  const size = sizeForDetach(attachment);
  const midX = (source.x + source.width / 2 + target.x + target.width / 2) / 2;
  const midY = (source.y + source.height / 2 + target.y + target.height / 2) / 2;
  const x = midX - size.width / 2;
  const y = midY - size.height / 2 - 60;

  const extractedNode: DraftNode = {
    id: createId('n'),
    type: attachment.type,
    x: clampCoord(x),
    y: clampCoord(y),
    width: clampSize(size.width),
    height: clampSize(size.height),
    z: Math.max(source.z, target.z),
  };
  if (attachment.text !== undefined) extractedNode.text = attachment.text;
  if (attachment.accent) extractedNode.accent = attachment.accent;
  if (attachment.noteKind) extractedNode.noteKind = attachment.noteKind;
  if (attachment.language) extractedNode.language = attachment.language;
  if (attachment.code !== undefined) extractedNode.code = attachment.code;

  const remaining = edge.attachments!.filter((a) => a.id !== attachmentId);
  const next = addNodes(withEdgeAttachments(doc, edgeId, remaining), [extractedNode]);
  return { doc: next, extractedNode };
}

/** Spacing between a generated companion node (a DLQ, a consumer) and the node that spawned it —
 *  the same value `detachFromNode`'s own unconditional offset already uses. Exported so a caller
 *  that needs a *larger* gap (e.g. to fit a connector's own caption text — see
 *  `store/editorStore.ts`'s `gapForCaption`) has a floor to widen from, rather than a second,
 *  independently-drifting magic number. */
export const COMPANION_GAP = 32;

function rectsOverlap(a: Bounds, b: Bounds): boolean {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

/** Whether `inner` fits entirely within `outer` — a companion that fits inside its host's own
 *  boundary stays there rather than implying it left. Shared by placement (which boundary-contained
 *  candidates to prefer) and by whoever assigns the resulting node's `parentId`. */
export function containsRect(
  outer: Pick<DraftNode, 'x' | 'y' | 'width' | 'height'>,
  inner: Bounds,
): boolean {
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width &&
    inner.y + inner.height <= outer.y + outer.height
  );
}

/** Which of the two "primary" companion candidates — directly right, or directly below — a search
 *  should try first. The rest of the fixed candidate list stays in its existing order regardless. */
export type CompanionDirection = 'right' | 'below';

export interface PlaceNearOptions {
  /** Try this primary direction's candidate first (default `'right'`, today's only behaviour). */
  direction?: CompanionDirection;
  /** When given, candidates that land fully inside this boundary are tried before ones that
   *  don't — a companion prefers to stay inside its host's boundary when there is room, without
   *  ever being forced there (a boundary is still never an obstacle; see `tryPlaceNear`). */
  parent?: Pick<DraftNode, 'x' | 'y' | 'width' | 'height'>;
}

/**
 * A small, bounded search for where a generated companion node should land near `host` — never
 * stacked on top of an unrelated node it happens to fall on. Tries a short, fixed list of
 * candidate offsets (right, below, below-right, above-right, further below) and returns the first
 * whose rect doesn't overlap any existing node, or `undefined` when every candidate collides (a
 * genuinely crowded corner of the diagram). A boundary (`group`) is never treated as an obstacle —
 * landing inside one is normal, not a collision, the same rule node-drag-to-attach detection
 * already applies for the same reason. This is deliberately not a general free-space solver: the
 * candidate list is fixed and ordered, so the same inputs always resolve to the same choice.
 *
 * `placeNear` is the forgiving wrapper every *committed* companion uses; this is for a caller that
 * would rather show nothing than something on top of the user's content — a preview.
 */
export function tryPlaceNear(
  doc: DraftDocument,
  host: Pick<DraftNode, 'id' | 'x' | 'y' | 'width' | 'height'>,
  size: { width: number; height: number },
  gap: number = COMPANION_GAP,
  options: PlaceNearOptions = {},
): { x: number; y: number } | undefined {
  const obstacles = doc.nodes.filter((n) => n.id !== host.id && n.type !== 'group');
  const candidates = orderCandidates(companionCandidates(host, size, gap, options.direction), options.parent);
  const chosen = candidates.find((rect) => !obstacles.some((n) => rectsOverlap(rect, n)));
  if (!chosen) return undefined;
  return clampCompanion(chosen, host, size);
}

/**
 * `tryPlaceNear`, but if every candidate collides it falls back to the first candidate for the
 * requested direction anyway, same as `detachFromNode` always has, just having tried a few smarter
 * positions first.
 */
export function placeNear(
  doc: DraftDocument,
  host: Pick<DraftNode, 'id' | 'x' | 'y' | 'width' | 'height'>,
  size: { width: number; height: number },
  gap: number = COMPANION_GAP,
  options: PlaceNearOptions = {},
): { x: number; y: number } {
  return (
    tryPlaceNear(doc, host, size, gap, options) ??
    clampCompanion(companionCandidates(host, size, gap, options.direction)[0]!, host, size)
  );
}

/** Boundary-contained candidates first (their relative order otherwise preserved), then the rest —
 *  a no-op when `parent` is absent or nothing fits inside it. */
function orderCandidates(candidates: Bounds[], parent?: Pick<DraftNode, 'x' | 'y' | 'width' | 'height'>): Bounds[] {
  if (!parent) return candidates;
  const inside = candidates.filter((c) => containsRect(parent, c));
  if (inside.length === 0) return candidates;
  const outside = candidates.filter((c) => !containsRect(parent, c));
  return [...inside, ...outside];
}

function companionCandidates(
  host: Pick<DraftNode, 'x' | 'y' | 'width' | 'height'>,
  size: { width: number; height: number },
  gap: number,
  direction: CompanionDirection = 'right',
): Bounds[] {
  const right = { x: host.x + host.width + gap, y: host.y, ...size };
  const below = { x: host.x, y: host.y + host.height + COMPANION_GAP, ...size };
  const belowRight = { x: host.x + host.width + gap, y: host.y + host.height + COMPANION_GAP, ...size };
  const aboveRight = { x: host.x + host.width + gap, y: host.y - size.height - COMPANION_GAP, ...size };
  const furtherBelow = { x: host.x, y: host.y + host.height + COMPANION_GAP * 2 + size.height, ...size };
  return direction === 'below'
    ? [below, right, belowRight, aboveRight, furtherBelow]
    : [right, below, belowRight, aboveRight, furtherBelow];
}

function clampCompanion(
  chosen: Bounds,
  host: Pick<DraftNode, 'x' | 'y' | 'width' | 'height'>,
  size: { width: number; height: number },
): { x: number; y: number } {
  let { x, y } = chosen;
  if (x + size.width > LIMITS.maxCoordinate) {
    x = host.x;
    y = host.y + host.height + COMPANION_GAP;
  }
  return { x: clampCoord(x), y: clampCoord(y) };
}

/** Breathing room between a block of elements being inserted and whatever is already on the
 *  canvas — larger than `COMPANION_GAP`, because this separates two *diagrams*, not a node from
 *  the node that spawned it. */
export const INSERT_GAP = 96;

/**
 * Where to put the top-left corner of an incoming block of `size` so it lands clear of everything
 * already on the canvas — what an Architecture Starter needs, and deliberately not what
 * `placeNear` does.
 *
 * Two differences from `placeNear` matter. It never treats a boundary as transparent: dropping a
 * whole architecture inside somebody's existing boundary would silently reparent nothing but would
 * read as a mistake, so a `group` is an obstacle here even though it is a legitimate landing spot
 * for a single companion node. And it does not search: right of the existing bounds is *provably*
 * free, which is worth more than a cleverer position that has to be verified. An empty canvas gets
 * the block centred on the origin instead, so the very first thing a user inserts sits where the
 * viewport already is.
 *
 * Nothing already on the canvas is ever moved. Cost is one pass over the nodes — no global layout.
 */
export function freeOriginFor(
  doc: DraftDocument,
  size: { width: number; height: number },
  gap: number = INSERT_GAP,
): { x: number; y: number } {
  const bounds = boundsOf(doc.nodes);
  if (!bounds) return { x: clampCoord(-size.width / 2), y: clampCoord(-size.height / 2) };
  const right = bounds.x + bounds.width + gap;
  // Only when the canvas has genuinely been dragged out to the coordinate limit does going right
  // stop being an option; below the existing content is the same guarantee on the other axis.
  if (right + size.width <= LIMITS.maxCoordinate) return { x: clampCoord(right), y: clampCoord(bounds.y) };
  return { x: clampCoord(bounds.x), y: clampCoord(bounds.y + bounds.height + gap) };
}

/**
 * The viewport that shows a block of `size` centred on the origin — where
 * `freeOriginFor` puts the first thing inserted on an empty canvas.
 *
 * Needed when a canvas is *created* already holding an Architecture Starter.
 * The editor opens at `document.viewport` verbatim and never fits on open (so
 * a returning user lands exactly where they left off), which means a seeded
 * canvas has to carry the right viewport before the editor ever mounts.
 * `padding` leaves air around the block; zoom is capped at 1 so a small
 * starter is not blown up to fill a large screen.
 */
export function openingViewportFor(
  size: { width: number; height: number },
  screen: { width: number; height: number },
  padding = 0.8,
): { x: number; y: number; zoom: number } {
  const fit = Math.min(
    (padding * screen.width) / Math.max(size.width, 1),
    (padding * screen.height) / Math.max(size.height, 1),
  );
  const zoom = Math.min(1, Math.max(0.1, fit));
  return { x: screen.width / 2, y: screen.height / 2, zoom };
}

/* ---------------------------------------------------------------- groups --- */

/** Every node transitively parented under `id` — used so dragging a boundary
 *  can carry its contents with it, and so a node cannot be reparented under
 *  its own descendant. */
export function descendantsOf(doc: DraftDocument, id: string): string[] {
  const result = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const node of doc.nodes) {
      if (node.parentId && (node.parentId === id || result.has(node.parentId)) && !result.has(node.id)) {
        result.add(node.id);
        grew = true;
      }
    }
  }
  return [...result];
}

export function setParent(
  doc: DraftDocument,
  childIds: Iterable<string>,
  parentId: string | undefined,
): DraftDocument {
  const set = new Set(childIds);
  let changed = false;
  const nodes = doc.nodes.map((node) => {
    if (!set.has(node.id) || node.id === parentId) return node;
    if (parentId === undefined) {
      if (!node.parentId) return node;
      changed = true;
      const { parentId: _drop, ...rest } = node;
      return rest;
    }
    if (node.parentId === parentId) return node;
    // A node cannot be reparented under its own descendant — that would
    // create a cycle `descendantsOf`'s own walk assumes can never exist.
    // The one caller today (`Canvas.tsx`'s drag-drop) already excludes
    // these targets before ever offering them as a drop candidate; the
    // guard lives here too so correctness doesn't depend on every future
    // caller remembering to pre-filter the same way.
    if (descendantsOf(doc, node.id).includes(parentId)) return node;
    changed = true;
    return { ...node, parentId };
  });
  return changed ? withNodes(doc, nodes) : doc;
}

/* ------------------------------------------------------------- document ---- */

export function setViewport(doc: DraftDocument, viewport: DraftViewport): DraftDocument {
  const zoom = Math.max(LIMITS.minZoom, Math.min(LIMITS.maxZoom, viewport.zoom));
  return { ...doc, viewport: { x: viewport.x, y: viewport.y, zoom } };
}

export function setTitle(doc: DraftDocument, title: string): DraftDocument {
  const trimmed = title.trim().slice(0, LIMITS.maxTitleLength) || 'Untitled canvas';
  if (trimmed === doc.metadata.title) return doc;
  return { ...doc, metadata: { ...doc.metadata, title: trimmed } };
}

export function setSettings(doc: DraftDocument, patch: Partial<DraftSettings>): DraftDocument {
  return { ...doc, settings: { ...doc.settings, ...patch } };
}

export function touch(doc: DraftDocument, at = Date.now()): DraftDocument {
  return { ...doc, metadata: { ...doc.metadata, updatedAt: at } };
}

/* --------------------------------------------------------------- bounds ---- */

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The union box of any rects — nodes, or the live drag rects `canvas/Canvas.tsx` snaps with. */
export function boundsOf(nodes: readonly Bounds[]): Bounds | null {
  if (nodes.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x + node.width);
    maxY = Math.max(maxY, node.y + node.height);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}
