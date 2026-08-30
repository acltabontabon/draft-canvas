/**
 * Pure document transforms. Every function returns a new document that shares
 * structure with the old one — untouched nodes and edges keep their object
 * identity, which is what lets the canvas memoize per node and lets the history
 * stack keep whole snapshots cheaply.
 */
import { createId } from './ids';
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
  Math.max(-LIMITS.maxCoordinate, Math.min(LIMITS.maxCoordinate, Math.round(n)));

const clampSize = (n: number) =>
  Math.max(LIMITS.minNodeSize, Math.min(LIMITS.maxNodeSize, Math.round(n)));

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
): DraftDocument {
  const anchor = newSide ? { side: newSide, offset: 0.5 } : undefined;
  let changed = false;
  const edges = doc.edges.map((edge) => {
    if (edge.id !== id) return edge;
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
    return next;
  });

  const edges = fragment.edges.map((edge) => {
    return {
      ...edge,
      id: createId('e'),
      source: idMap.get(edge.source)!,
      target: idMap.get(edge.target)!,
    } satisfies DraftEdge;
  });

  return { nodes, edges };
}

export function pasteFragment(
  doc: DraftDocument,
  fragment: Clipboard,
  offset: { x: number; y: number },
): { doc: DraftDocument; nodeIds: string[]; edgeIds: string[] } {
  const created = instantiateFragment(fragment, offset);
  const next = addEdges(addNodes(doc, created.nodes), created.edges);
  return {
    doc: next,
    nodeIds: created.nodes.map((n) => n.id),
    edgeIds: created.edges.map((e) => e.id),
  };
}

/* ---------------------------------------------------------------- z-order -- */

export function bringForward(doc: DraftDocument, ids: Iterable<string>): DraftDocument {
  const set = new Set(ids);
  const max = doc.nodes.reduce((m, n) => Math.max(m, n.z), 0);
  return withNodes(
    doc,
    doc.nodes.map((n) => (set.has(n.id) ? { ...n, z: Math.min(max + 1, n.z + 1) } : n)),
  );
}

export function sendBackward(doc: DraftDocument, ids: Iterable<string>): DraftDocument {
  const set = new Set(ids);
  const min = doc.nodes.reduce((m, n) => Math.min(m, n.z), 0);
  return withNodes(
    doc,
    doc.nodes.map((n) => (set.has(n.id) ? { ...n, z: Math.max(min - 1, n.z - 1) } : n)),
  );
}

export function bringToFront(doc: DraftDocument, ids: Iterable<string>): DraftDocument {
  const set = new Set(ids);
  const max = doc.nodes.reduce((m, n) => Math.max(m, n.z), 0);
  return withNodes(doc, doc.nodes.map((n) => (set.has(n.id) ? { ...n, z: max + 1 } : n)));
}

export function sendToBack(doc: DraftDocument, ids: Iterable<string>): DraftDocument {
  const set = new Set(ids);
  const min = doc.nodes.reduce((m, n) => Math.min(m, n.z), 0);
  return withNodes(doc, doc.nodes.map((n) => (set.has(n.id) ? { ...n, z: min - 1 } : n)));
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
  const capped = Math.max(0, Math.min(insertIndex ?? existing.length, existing.length));
  const next = [...existing.slice(0, capped), attachment, ...existing.slice(capped)].slice(
    0,
    LIMITS.maxAttachmentsPerNode,
  );
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

  const size = {
    width: attachment.width ?? LIMITS.minNodeSize,
    height: attachment.height ?? LIMITS.minNodeSize,
  };
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
  return withNodes(
    doc,
    doc.nodes.map((node) => {
      if (!set.has(node.id) || node.id === parentId) return node;
      if (parentId === undefined) {
        if (!node.parentId) return node;
        const { parentId: _drop, ...rest } = node;
        return rest;
      }
      if (node.parentId === parentId) return node;
      return { ...node, parentId };
    }),
  );
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

export function boundsOf(nodes: readonly DraftNode[]): Bounds | null {
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
