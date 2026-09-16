/**
 * Architectural depth: a shape can have an inside.
 *
 * A `.draftcanvas` file is a tree of rooms. The document itself is the outermost one, and any
 * architectural node may own another — the shapes that run *inside* it. Only one room is ever
 * edited at a time, so the rest of the app keeps working on a plain `DraftDocument`: this module
 * is the single seam that turns a file plus a path into the room you are standing in
 * (`viewOf`), and a changed room back into the whole file (`embed`).
 *
 * Two invariants hold everywhere, and both live here rather than in the callers:
 *
 * - **A room exists exactly when it holds at least one shape.** Entering a shape that has no
 *   inside yet writes nothing; the first shape drawn there creates the room, and removing the
 *   last one takes it away again. There is no such thing as a saved empty room, so "create a
 *   view" is never a step the user has to take, and undoing the first shape undoes the room.
 * - **Depth only ever points inward.** An inside is owned by its node, so a cycle is impossible,
 *   a reference can never dangle, and deleting or copying a shape takes its rooms with it.
 *
 * Free of React and of the store, like the rest of `document/`'s neighbourhood — it imports the
 * model and nothing else.
 */

import type { DraftDocument, DraftEdge, DraftFlow, DraftInside, DraftNode, DraftViewport } from '../document/types';

/** Owner node ids from the document outward-in: `[]` is the document itself. */
export type DepthPath = readonly string[];

export const ROOT_PATH: DepthPath = [];

/** Where an empty room's camera starts before anything has been drawn in it. */
const EMPTY_ROOM_VIEWPORT: DraftViewport = { x: 0, y: 0, zoom: 1 };

const EMPTY_NODES: DraftNode[] = [];
const EMPTY_EDGES: DraftEdge[] = [];
const EMPTY_FLOWS: DraftFlow[] = [];

/** Whether this node already has shapes inside it. */
export function hasInside(node: DraftNode): boolean {
  return (node.inside?.nodes.length ?? 0) > 0;
}

/**
 * Whether "Look inside" is offered for this node. Deliberately narrower than what the format
 * allows: a room is only *created* under the two types whose internals are architecture in their
 * own right, while an inside that already exists stays reachable whatever the node became later
 * (see `hasInside`) — a kind change must never strand content.
 */
export function canCreateInside(node: DraftNode): boolean {
  if (node.type === 'service') return true;
  return node.type === 'component' && (node.componentKind ?? 'generic') !== 'port';
}

/** The node a path names, or `undefined` if the path no longer resolves. */
export function ownerAt(file: DraftDocument, path: DepthPath): DraftNode | undefined {
  let nodes: readonly DraftNode[] = file.nodes;
  let owner: DraftNode | undefined;
  for (const id of path) {
    owner = nodes.find((node) => node.id === id);
    if (!owner) return undefined;
    nodes = owner.inside?.nodes ?? EMPTY_NODES;
  }
  return owner;
}

/**
 * The longest prefix of `path` that still resolves. Undo restoring an older file, a VS Code
 * reload and a discarded conflict can all land on a file where the room you were in no longer
 * exists; the answer is to surface at the nearest room that does, never to fail.
 */
export function resolvePath(file: DraftDocument, path: DepthPath): DepthPath {
  let nodes: readonly DraftNode[] = file.nodes;
  let depth = 0;
  for (const id of path) {
    const owner = nodes.find((node) => node.id === id);
    if (!owner) break;
    nodes = owner.inside?.nodes ?? EMPTY_NODES;
    depth += 1;
  }
  return depth === path.length ? path : path.slice(0, depth);
}

/** Every graph in the file, outermost first — the document, then each room, depth-first. */
export function walkGraphs(file: DraftDocument, visit: (graph: Graph, path: DepthPath) => void): void {
  visit(file, ROOT_PATH);
  const descend = (nodes: readonly DraftNode[], path: DepthPath) => {
    for (const node of nodes) {
      if (!node.inside) continue;
      const here = [...path, node.id];
      visit(node.inside, here);
      descend(node.inside.nodes, here);
    }
  };
  descend(file.nodes, ROOT_PATH);
}

/** Node and edge counts across every room — what the document limits are spent against. */
export function totals(file: DraftDocument): { nodes: number; edges: number } {
  let nodes = 0;
  let edges = 0;
  walkGraphs(file, (graph) => {
    nodes += graph.nodes.length;
    edges += graph.edges.length;
  });
  return { nodes, edges };
}

/** The graph shape a room and a document have in common. */
export interface Graph {
  nodes: DraftNode[];
  edges: DraftEdge[];
  flows: DraftFlow[];
  viewport: DraftViewport;
}

/**
 * The room at `path`, as an ordinary document the whole app can edit.
 *
 * At the root this is the file itself — by identity, so a canvas that never goes inside anything
 * pays nothing at all for depth. Deeper, it borrows the file's `metadata` and `settings` (one
 * title, one set of canvas settings, however deep you are) and carries the room's own graph.
 * A path whose room does not exist yet is not an error: it yields an empty room, which is exactly
 * what standing inside a shape you haven't drawn in yet should feel like.
 *
 * Returns `undefined` only when the path itself no longer resolves — callers hold a resolved path
 * (see `resolvePath`), so this is the "should never happen" branch rather than a routine one.
 */
export function viewOf(file: DraftDocument, path: DepthPath): DraftDocument | undefined {
  if (path.length === 0) return file;

  const cached = viewCache.get(file)?.get(keyOf(path));
  if (cached) return cached;

  const owner = ownerAt(file, path);
  if (!owner) return undefined;

  const inside = owner.inside;
  const view: DraftDocument = {
    ...file,
    nodes: inside?.nodes ?? EMPTY_NODES,
    edges: inside?.edges ?? EMPTY_EDGES,
    flows: inside?.flows ?? EMPTY_FLOWS,
    viewport: inside?.viewport ?? EMPTY_ROOM_VIEWPORT,
    // The room's *own* level, if it was given one — never the one it inherits, which is worked
    // out where it is needed (`depth/level.ts`) rather than written into the file.
    ...(inside?.level === undefined ? {} : { level: inside.level }),
  };
  if (inside?.level === undefined) delete view.level;
  rememberView(file, path, view);
  return view;
}

/**
 * The file that results from `view` being the room at `path`.
 *
 * The room's graph is written into the owner chain; `metadata` and `settings` travel back to the
 * root, since a rename or a grid change made while inside belongs to the whole file. Returns the
 * same file object when nothing actually changed, so the store's "this operation was a no-op"
 * identity check keeps working at any depth, and refuses (returning the file untouched) if the
 * path stopped resolving rather than inventing a room somewhere else.
 */
export function embed(file: DraftDocument, path: DepthPath, view: DraftDocument): DraftDocument {
  if (path.length === 0) return view;

  const nodes = embedInto(file.nodes, path, 0, view);
  if (nodes === undefined) return file;

  const shared = view.metadata !== file.metadata || view.settings !== file.settings;
  if (nodes === file.nodes && !shared) return file;

  const next: DraftDocument = { ...file, nodes, metadata: view.metadata, settings: view.settings };
  // The view this file was just built from is the view it yields — recording that here keeps
  // `viewOf(embed(...))` identity-stable, which is what lets an unchanged room compare equal.
  rememberView(next, path, view);
  return next;
}

/** `nodes` with the owner at `path[index]` carrying `view`, or `undefined` if the path broke. */
function embedInto(
  nodes: DraftNode[],
  path: DepthPath,
  index: number,
  view: DraftDocument,
): DraftNode[] | undefined {
  const at = nodes.findIndex((node) => node.id === path[index]);
  if (at === -1) return undefined;
  const owner = nodes[at]!;
  const last = index === path.length - 1;

  let inside: DraftInside | undefined;
  if (last) {
    inside = insideFor(owner.inside, view);
  } else {
    const child = owner.inside;
    // A room on the way down that no longer exists means the path is stale, not that a new one
    // should be conjured here: the deeper room's own owner lived in it.
    if (!child) return undefined;
    const childNodes = embedInto(child.nodes, path, index + 1, view);
    if (childNodes === undefined) return undefined;
    inside = childNodes === child.nodes ? child : { ...child, nodes: childNodes };
  }

  if (inside === owner.inside) return nodes;
  const next = nodes.slice();
  next[at] = withInside(owner, inside);
  return next;
}

/** The room `view` describes, or `undefined` once its last shape is gone. */
function insideFor(current: DraftInside | undefined, view: DraftDocument): DraftInside | undefined {
  if (view.nodes.length === 0) return undefined;
  if (
    current &&
    current.nodes === view.nodes &&
    current.edges === view.edges &&
    current.flows === view.flows &&
    current.viewport === view.viewport &&
    current.level === view.level
  ) {
    return current;
  }
  const inside: DraftInside = {
    ...current,
    nodes: view.nodes,
    edges: view.edges,
    flows: view.flows,
    viewport: view.viewport,
  };
  if (view.level === undefined) delete inside.level;
  else inside.level = view.level;
  return inside;
}

function withInside(node: DraftNode, inside: DraftInside | undefined): DraftNode {
  if (inside) return { ...node, inside };
  const { inside: _dropped, ...rest } = node;
  return rest;
}

/**
 * Views are looked up on every render and compared by identity by everything downstream, so the
 * same file and path must always hand back the same object. Keyed weakly by the file, so a
 * superseded snapshot's views are collected with it.
 */
const viewCache = new WeakMap<DraftDocument, Map<string, DraftDocument>>();

function rememberView(file: DraftDocument, path: DepthPath, view: DraftDocument): void {
  let byPath = viewCache.get(file);
  if (!byPath) viewCache.set(file, (byPath = new Map()));
  byPath.set(keyOf(path), view);
}

function keyOf(path: DepthPath): string {
  return path.join(' ');
}

/** Two paths are the same room when their keys match — node ids can't contain the separator. */
export function pathKey(path: DepthPath): string {
  return keyOf(path);
}
