/**
 * Shared by the collaboration tests: a seeded random editor that changes a file the way the app's
 * own operations do — in any room, nesting shapes, wiring them, telling flows over them, raising open
 * points, reordering, renaming — and a way to compare two files the way collaborators share them.
 */
import { embed, roomsOf, viewOf, type DepthPath } from '../../src/depth/tree';
import { addFlow, addStepToFlow, createFlow, pruneFlowSteps } from '../../src/document/flow';
import { addOpenPoint, createOpenPoint, removeOpenPoint } from '../../src/document/openPoints';
import { addEdges, addNodes, insideHeight, removeElements, setParent, setSettings, setTitle, updateEdge, updateNode } from '../../src/document/operations';
import { createDocument, createEdge, createNode } from '../../src/document/factory';
import { LIMITS } from '../../src/document/limits';
import type { DraftDocument, DraftInside, DraftNode, ViewLevel } from '../../src/document/types';
import { canHoldInside } from '../../src/collab/apply';
import type { CollabTransport, TransportState } from '../../src/collab/transport/types';

export type Rng = () => number;

/** mulberry32 — small, fast and the same everywhere, so a failing seed replays exactly. */
export function rngFrom(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: Rng, items: readonly T[]): T | undefined {
  return items.length === 0 ? undefined : items[Math.floor(rng() * items.length)];
}

const TYPES = ['service', 'component', 'database', 'queue', 'note', 'group', 'actor'] as const;
const LEVELS: ViewLevel[] = ['context', 'container', 'component', 'none'];

/** Mostly a room that has shapes to work with; sometimes an empty one inside a shape that could hold one. */
function chooseRoom(file: DraftDocument, rng: Rng): DepthPath {
  const rooms = roomsOf(file);
  if (rng() < 0.75) return pick(rng, rooms.filter((room) => room.graph.nodes.length > 0).map((room) => room.path)) ?? [];
  const candidates: DepthPath[] = [];
  for (const room of rooms) {
    if (room.path.length >= LIMITS.maxInsideDepth) continue;
    for (const node of room.graph.nodes) if (!node.inside && canHoldInside(node)) candidates.push([...room.path, node.id]);
  }
  return pick(rng, candidates) ?? [];
}

function inRoom(file: DraftDocument, path: DepthPath, fn: (room: DraftDocument) => DraftDocument): DraftDocument {
  const view = viewOf(file, path);
  if (!view) return file;
  const next = fn(view);
  return next === view ? file : embed(file, path, next);
}

let counter = 0;

/** One random edit, made with the document's own operations. Returns the file unchanged when the dice pick something impossible. */
export function randomEdit(file: DraftDocument, rng: Rng): DraftDocument {
  const path = chooseRoom(file, rng);
  const room = viewOf(file, path)!;
  const node = pick(rng, room.nodes);
  const other = room.nodes.length > 1 ? room.nodes.filter((candidate) => candidate !== node)[Math.floor(rng() * (room.nodes.length - 1))] : undefined;
  const edge = pick(rng, room.edges);
  const flow = pick(rng, room.flows);
  counter += 1;

  switch (Math.floor(rng() * 18)) {
    case 16:
    case 17:
      if (!node || !other) return file;
      return inRoom(file, path, (view) => addEdges(view, [createEdge({ source: node.id, target: other.id, label: `call ${counter}` })]));
    case 0:
    case 1: {
      const type = pick(rng, TYPES)!;
      const created = createNode({ type, text: `${type} ${counter}`, x: Math.round(rng() * 800), y: Math.round(rng() * 600) });
      return inRoom(file, path, (view) => addNodes(view, [created]));
    }
    case 2:
      return node ? inRoom(file, path, (view) => updateNode(view, node.id, { text: `renamed ${counter}` })) : file;
    case 3:
      return node ? inRoom(file, path, (view) => updateNode(view, node.id, { x: node.x + 10, y: node.y - 5 })) : file;
    case 4:
      return node ? inRoom(file, path, (view) => removeElements(view, [node.id])) : file;
    case 5: {
      // A flow told over a fresh connector, so stories exist to collide with.
      if (!node || !other) return file;
      const created = createEdge({ source: node.id, target: other.id });
      const story = createFlow({ title: `Story ${counter}` });
      return inRoom(file, path, (view) => addStepToFlow(addFlow(addEdges(view, [created]), story), story.id, created.id));
    }
    case 6:
      return edge ? inRoom(file, path, (view) => updateEdge(view, edge.id, { label: `label ${counter}` })) : file;
    case 7:
      return edge ? inRoom(file, path, (view) => removeElements(view, [], [edge.id])) : file;
    case 8: {
      if (!edge) return file;
      const created = createFlow({ title: `Flow ${counter}` });
      return inRoom(file, path, (view) => addStepToFlow(addFlow(view, created), created.id, edge.id));
    }
    case 9:
      return flow && edge ? inRoom(file, path, (view) => addStepToFlow(view, flow.id, edge.id)) : file;
    case 10:
      // Reorders a room's flows or connectors, which only array position records.
      if (room.flows.length > 1 && rng() < 0.5) return inRoom(file, path, (view) => ({ ...view, flows: [...view.flows].reverse() }));
      return room.edges.length > 1 ? inRoom(file, path, (view) => ({ ...view, edges: [...view.edges].reverse() })) : file;
    case 11: {
      if (!node && !edge) return file;
      const target = node ? { kind: 'node' as const, id: node.id } : { kind: 'edge' as const, id: edge!.id };
      const point = createOpenPoint(pick(rng, ['tentative', 'awaiting', 'parked'] as const)!, [target], `point ${counter}`);
      if (point && rng() < 0.2 && file.openPoints.length > 0) return removeOpenPoint(file, file.openPoints[0]!.id);
      return point ? addOpenPoint(file, point) : file;
    }
    case 12:
      return rng() < 0.5 ? setTitle(file, `Title ${counter}`) : setSettings(file, { grid: rng() < 0.5 ? 'lines' : 'dots' });
    case 13:
      return room.nodes.length > 0 ? inRoom(file, path, (view) => ({ ...view, level: pick(rng, LEVELS)! })) : file;
    case 14: {
      const group = room.nodes.find((candidate) => candidate.type === 'group');
      return group && node ? inRoom(file, path, (view) => setParent(view, [node.id], group.id)) : file;
    }
    default:
      return moveIntoSibling(file, path, node, other);
  }
}

/** A shape and what is inside it, moved into a sibling's room — "Move inside", minus the layout. */
function moveIntoSibling(file: DraftDocument, path: DepthPath, node: DraftNode | undefined, owner: DraftNode | undefined): DraftDocument {
  if (!node || !owner || node.id === owner.id || !canHoldInside(owner)) return file;
  if (path.length + 1 + insideHeight(node) > LIMITS.maxInsideDepth) return file;
  return inRoom(file, path, (view) => {
    // What the editor's move does to what stays behind: the connectors to it go, flow steps and
    // boundary membership stop naming it.
    if (node.type === 'group' && view.nodes.some((candidate) => candidate.parentId === node.id)) return view;
    const attached = view.edges.filter((edge) => edge.source === node.id || edge.target === node.id).map((edge) => edge.id);
    const cleared = pruneFlowSteps(removeElements(view, [], attached), new Set(), new Set([node.id]));
    const { parentId: _parent, ...moved } = node;
    const current = cleared.nodes.find((candidate) => candidate.id === owner.id)!;
    const inside: DraftInside = current.inside
      ? { ...current.inside, nodes: [...current.inside.nodes, moved] }
      : { nodes: [moved], edges: [], flows: [], viewport: { x: 0, y: 0, zoom: 1 } };
    const nodes = cleared.nodes
      .filter((candidate) => candidate.id !== node.id)
      .map((candidate) => (candidate.id === owner.id ? { ...current, inside } : candidate));
    return { ...cleared, nodes };
  });
}

export function seededFile(rng: Rng, edits = 12): DraftDocument {
  let file = createDocument('Shared');
  for (let i = 0; i < edits; i += 1) file = randomEdit(file, rng);
  return file;
}

/** What collaborators share of a file: everything but cameras and bookkeeping. */
export function sharedContent(file: DraftDocument): unknown {
  const graph = (g: { nodes: DraftNode[]; edges: unknown[]; flows: unknown[]; level?: ViewLevel }): unknown => ({
    nodes: g.nodes.map((node) => {
      const { inside, ...own } = node;
      return inside ? { ...own, inside: graph(inside) } : own;
    }),
    edges: g.edges,
    flows: g.flows,
    level: g.level ?? null,
  });
  const { image: _image, ...background } = file.settings.background;
  return JSON.parse(JSON.stringify({
    title: file.metadata.title,
    settings: { ...file.settings, background },
    openPoints: file.openPoints,
    ...(graph(file) as object),
  }));
}

/* ------------------------------------------------------------- transport -- */


/**
 * Two connected ends whose messages wait until `pump` delivers them, in order — so a test decides
 * exactly when the other side hears anything, and nothing re-enters a session mid-call.
 */
export function loopbackPair(kind: CollabTransport['kind'] = 'loopback'): { a: CollabTransport; b: CollabTransport; pump: () => number; drop: () => void; sent: { a: string[]; b: string[] } } {
  const queue: { to: 'a' | 'b'; text: string }[] = [];
  const sent = { a: [] as string[], b: [] as string[] };
  const ends = { a: makeEnd('a'), b: makeEnd('b') };

  interface End {
    state: TransportState;
    messageListeners: Set<(text: string) => void>;
    stateListeners: Set<(state: TransportState, reason?: string) => void>;
    transport: CollabTransport;
  }

  function makeEnd(name: 'a' | 'b'): End {
    const messageListeners = new Set<(text: string) => void>();
    const stateListeners = new Set<(state: TransportState, reason?: string) => void>();
    const end: End = {
      state: 'open',
      messageListeners,
      stateListeners,
      transport: {
        kind,
        get state(): TransportState {
          return end.state;
        },
        send(text: string) {
          if (end.state === 'closed') return false;
          sent[name].push(text);
          queue.push({ to: name === 'a' ? 'b' : 'a', text });
          return true;
        },
        onMessage(listener: (text: string) => void) {
          messageListeners.add(listener);
          return () => messageListeners.delete(listener);
        },
        onState(listener: (state: TransportState, reason?: string) => void) {
          stateListeners.add(listener);
          return () => stateListeners.delete(listener);
        },
        close(reason?: string) {
          closeBoth(reason);
        },
      } satisfies CollabTransport,
    };
    return end;
  }

  function closeBoth(reason?: string) {
    for (const end of [ends.a, ends.b]) {
      if (end.state === 'closed') continue;
      end.state = 'closed';
      for (const listener of [...end.stateListeners]) listener('closed', reason);
    }
  }

  const pump = () => {
    let delivered = 0;
    while (queue.length > 0) {
      const { to, text } = queue.shift()!;
      const end = ends[to];
      if (end.state === 'closed') continue;
      delivered += 1;
      for (const listener of [...end.messageListeners]) listener(text);
    }
    return delivered;
  };

  return { a: ends.a.transport, b: ends.b.transport, pump, drop: () => closeBoth('dropped'), sent };
}
