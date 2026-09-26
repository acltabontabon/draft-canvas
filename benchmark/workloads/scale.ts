/**
 * Deterministic scale fixtures for the interaction benchmark — Small / Medium / Large / Stress.
 *
 * Unlike the tiled-starter workloads (`generator.ts`), these are shaped like a C4-aware diagram
 * that has grown: system boundaries holding container boundaries holding shapes, a sub-boundary
 * three levels down, connectors that cross boundaries and each other, notes and code on shapes and
 * on connectors, a few shapes with a room inside them, and flows. That is exactly the mix
 * the interaction work has to survive, and none of it is in the starter tiles.
 *
 * Everything is derived from a seeded PRNG and explicit ids, so the same size always produces the
 * same bytes: a before/after comparison measures the app, never the fixture. Counts are of the root
 * canvas (what one screen has to draw); rooms are extra and reported separately.
 */

import { categoryOf, inferRelationship } from '../../src/document/connectorSemantics';
import { createAttachment, createDocument, createEdge, createNode } from '../../src/document/factory';
import type {
  ConnectorKind,
  DraftDocument,
  DraftEdge,
  DraftFlow,
  DraftNode,
  DraftNodeType,
  EdgeAnchor,
  EdgeRouting,
  Side,
} from '../../src/document/types';

export type ScaleName = 'small' | 'medium' | 'large' | 'stress';

export interface ScaleSpec {
  name: ScaleName;
  label: string;
  /** Root-canvas nodes, boundaries included. Exact. */
  nodes: number;
  /** Root-canvas connectors. Exact. */
  edges: number;
  /** Shapes that carry a small room (`inside`) of their own. */
  rooms: number;
}

export const SCALE_SPECS: Record<ScaleName, ScaleSpec> = {
  small: { name: 'small', label: 'Small', nodes: 50, edges: 75, rooms: 1 },
  medium: { name: 'medium', label: 'Medium', nodes: 200, edges: 300, rooms: 3 },
  large: { name: 'large', label: 'Large', nodes: 500, edges: 800, rooms: 6 },
  stress: { name: 'stress', label: 'Stress', nodes: 1000, edges: 1500, rooms: 10 },
};

export const SCALE_NAMES = Object.keys(SCALE_SPECS) as ScaleName[];

/** What a benchmark scenario needs to know about the fixture without re-deriving it. */
export interface ScaleManifest {
  spec: ScaleSpec;
  nodes: number;
  edges: number;
  boundaries: number;
  /** Deepest boundary nesting on the root canvas (system → container → sub-boundary = 3). */
  maxBoundaryDepth: number;
  crossBoundaryEdges: number;
  nodeAttachments: number;
  edgeAttachments: number;
  rooms: number;
  roomNodes: number;
  roomEdges: number;
  flows: number;
  /** Free-floating notes placed on open canvas, for the attach/drag scenarios. */
  looseNoteIds: string[];
}

/** mulberry32 — tiny, fast, and identical on every platform. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LEAF_TYPES: DraftNodeType[] = ['service', 'service', 'service', 'database', 'queue', 'component', 'service', 'actor'];
const LEAF_COLUMNS = 3;
const CELL_W = 236;
const CELL_H = 124;
const PAD_X = 28;
const PAD_TOP = 52;
const PAD_BOTTOM = 28;
const CONTAINER_GAP = 64;
const SYSTEM_GAP = 240;

const LABELS = [
  'GET /orders',
  'POST /payments',
  'order.created',
  'reserve stock',
  'auth check',
  'sync profile',
  'emit audit',
  'lookup',
  'retry after 3s',
  'publishes',
];

const NAMES = ['Orders', 'Payments', 'Billing', 'Catalog', 'Search', 'Identity', 'Shipping', 'Inventory', 'Ledger', 'Notify'];

interface LeafSlot {
  id: string;
  systemIndex: number;
  containerKey: string;
  node: DraftNode;
}

/** A leaf is placed inside a container (or a sub-boundary of one); this is one grid position. */
function leafAt(
  rand: () => number,
  id: string,
  ordinal: number,
  x: number,
  y: number,
  parentId: string,
): DraftNode {
  const type = LEAF_TYPES[Math.floor(rand() * LEAF_TYPES.length)]!;
  const name = NAMES[ordinal % NAMES.length]!;
  return createNode({
    id,
    type,
    x,
    y,
    z: 0,
    parentId,
    text: type === 'actor' ? `User ${ordinal}` : `${name} ${ordinal}`,
    ...(type === 'service' ? { serviceKind: rand() < 0.3 ? 'api' : 'generic' } : {}),
    ...(type === 'database' ? { databaseKind: rand() < 0.5 ? 'sql' : 'generic' } : {}),
    ...(type === 'queue' ? { queueKind: rand() < 0.4 ? 'topic' : 'queue' } : {}),
    ...(type === 'component' ? { componentKind: 'module' as const } : {}),
  });
}

function boundary(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  text: string,
  preset: 'system' | 'boundary' | 'domain',
  parentId?: string,
): DraftNode {
  return createNode({
    id,
    type: 'group',
    x,
    y,
    width,
    height,
    z: 0,
    text,
    boundaryPreset: preset,
    ...(parentId ? { parentId } : {}),
  });
}

const SIDE_PAIRS: Array<[Side, Side]> = [
  ['right', 'left'],
  ['bottom', 'top'],
  ['left', 'right'],
  ['top', 'bottom'],
];

/** Which side of `from` faces `to` — the anchor a person dragging between them would have used. */
function facing(from: DraftNode, to: DraftNode): [Side, Side] {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? SIDE_PAIRS[0]! : SIDE_PAIRS[2]!;
  return dy >= 0 ? SIDE_PAIRS[1]! : SIDE_PAIRS[3]!;
}

function anchorFor(side: Side, offset: number): EdgeAnchor {
  return { side, offset };
}

function buildRoom(seed: number, nodeCount: number, prefix: string): {
  nodes: DraftNode[];
  edges: DraftEdge[];
} {
  const rand = rng(seed);
  const nodes: DraftNode[] = [];
  const edges: DraftEdge[] = [];
  for (let i = 0; i < nodeCount; i += 1) {
    const column = i % 3;
    const row = Math.floor(i / 3);
    nodes.push(
      leafAt(rand, `${prefix}n${i}`, i + 1, 60 + column * CELL_W, 60 + row * CELL_H, ''),
    );
    delete nodes[i]!.parentId;
  }
  for (let i = 1; i < nodeCount; i += 1) {
    const source = nodes[Math.floor((i - 1) / 2)]!;
    const target = nodes[i]!;
    const relationship = inferRelationship(source, target);
    edges.push(
      createEdge({
        id: `${prefix}e${i}`,
        source: source.id,
        target: target.id,
        semantic: relationship?.semantic,
        kind: relationship?.kind,
        async: relationship?.async,
        semanticsOrigin: relationship?.semantic ? 'inferred' : undefined,
      }),
    );
  }
  return { nodes, edges };
}

/**
 * Builds one fixture. Throws if the result does not match the spec exactly, so a drifting
 * generator fails here rather than producing a quietly different benchmark.
 */
export function buildScaleDocument(spec: ScaleSpec): { document: DraftDocument; manifest: ScaleManifest } {
  const rand = rng(0xd7af7 + spec.nodes);
  const nodes: DraftNode[] = [];
  const nodeById = new Map<string, DraftNode>();
  const leaves: LeafSlot[] = [];
  const depthOf = new Map<string, number>();
  const parentOf = new Map<string, string | undefined>();

  const add = (node: DraftNode, depth: number) => {
    nodes.push(node);
    nodeById.set(node.id, node);
    depthOf.set(node.id, depth);
    parentOf.set(node.id, node.parentId);
  };

  // Loose notes on open canvas: the drag/attach scenarios need something to pick up that is not
  // already a member of anything. They come out of the node budget, so reserve it up front.
  const looseTarget = Math.min(6, Math.max(2, Math.floor(spec.nodes / 40)));
  const gridTarget = spec.nodes - looseTarget;

  // Systems are laid out in a near-square grid; each holds a 2×2 grid of containers, every other
  // container carrying a sub-boundary (the third nesting level).
  const perSystem = 31;
  const systemCount = Math.max(1, Math.ceil(gridTarget / perSystem));
  const systemColumns = Math.max(1, Math.ceil(Math.sqrt(systemCount * 1.4)));
  const containerW = LEAF_COLUMNS * CELL_W + PAD_X * 2;
  const containerH = PAD_TOP + 2 * CELL_H + PAD_BOTTOM + 40;
  const systemW = 2 * containerW + CONTAINER_GAP + PAD_X * 2;
  const systemH = 2 * containerH + CONTAINER_GAP + PAD_TOP + PAD_BOTTOM;

  let ordinal = 0;
  let systemIndex = 0;
  outer: for (systemIndex = 0; systemIndex < systemCount; systemIndex += 1) {
    const sx = (systemIndex % systemColumns) * (systemW + SYSTEM_GAP);
    const sy = Math.floor(systemIndex / systemColumns) * (systemH + SYSTEM_GAP);
    const systemId = `s${systemIndex}`;
    if (nodes.length >= gridTarget) break;
    add(boundary(systemId, sx, sy, systemW, systemH, `System ${systemIndex + 1}`, 'system'), 1);

    for (let c = 0; c < 4; c += 1) {
      if (nodes.length >= gridTarget) break outer;
      const cx = sx + PAD_X + (c % 2) * (containerW + CONTAINER_GAP);
      const cy = sy + PAD_TOP + Math.floor(c / 2) * (containerH + CONTAINER_GAP);
      const containerId = `s${systemIndex}c${c}`;
      add(boundary(containerId, cx, cy, containerW, containerH, `Container ${systemIndex + 1}.${c + 1}`, 'boundary', systemId), 2);

      const withSub = c % 2 === 0;
      // Row 0 is always direct leaves; row 1 is a sub-boundary (with leaves) or more direct leaves.
      for (let i = 0; i < LEAF_COLUMNS; i += 1) {
        if (nodes.length >= gridTarget) break outer;
        const id = `s${systemIndex}c${c}l${i}`;
        const leaf = leafAt(rand, id, ordinal += 1, cx + PAD_X + i * CELL_W + 30, cy + PAD_TOP + 20, containerId);
        add(leaf, 3);
        leaves.push({ id, systemIndex, containerKey: containerId, node: leaf });
      }
      if (withSub) {
        if (nodes.length >= gridTarget) break outer;
        const subId = `s${systemIndex}c${c}sub`;
        add(
          boundary(
            subId,
            cx + PAD_X - 8,
            cy + PAD_TOP + CELL_H - 12,
            LEAF_COLUMNS * CELL_W + 16,
            CELL_H + 16,
            `Domain ${systemIndex + 1}.${c + 1}`,
            'domain',
            containerId,
          ),
          3,
        );
        for (let i = 0; i < LEAF_COLUMNS; i += 1) {
          if (nodes.length >= gridTarget) break outer;
          const id = `s${systemIndex}c${c}m${i}`;
          const leaf = leafAt(rand, id, ordinal += 1, cx + PAD_X + i * CELL_W + 30, cy + PAD_TOP + CELL_H + 12, subId);
          add(leaf, 4);
          leaves.push({ id, systemIndex, containerKey: containerId, node: leaf });
        }
      } else {
        for (let i = 0; i < LEAF_COLUMNS; i += 1) {
          if (nodes.length >= gridTarget) break outer;
          const id = `s${systemIndex}c${c}m${i}`;
          const leaf = leafAt(rand, id, ordinal += 1, cx + PAD_X + i * CELL_W + 30, cy + PAD_TOP + CELL_H + 12, containerId);
          add(leaf, 3);
          leaves.push({ id, systemIndex, containerKey: containerId, node: leaf });
        }
      }
    }
  }

  const looseNoteIds: string[] = [];
  while (looseNoteIds.length < looseTarget) {
    const n = looseNoteIds.length;
    const id = `note${n}`;
    add(
      createNode({
        id,
        type: 'note',
        x: -320,
        y: 60 + n * 130,
        z: 0,
        text: 'Retries are idempotent — confirm with @Priya',
        noteKind: (['note', 'question', 'warning', 'decision'] as const)[n % 4],
      }),
      0,
    );
    looseNoteIds.push(id);
  }

  // Top-up: if the boundary/leaf grid stopped short of `spec.nodes` (it stops the moment it hits
  // the count, so it only falls short when every system is full), pad with extra leaves in the last
  // container — never reached for the four specs, but keeps the "exact" promise honest.
  let pad = 0;
  while (nodes.length < spec.nodes) {
    const id = `pad${pad}`;
    add(createNode({ id, type: 'service', x: -320 - (pad % 4) * 220, y: 900 + Math.floor(pad / 4) * 110, z: 0, text: `Extra ${pad}` }), 0);
    leaves.push({ id, systemIndex: 0, containerKey: 'pad', node: nodeById.get(id)! });
    pad += 1;
  }

  // ---- Edges -------------------------------------------------------------------------------
  const edges: DraftEdge[] = [];
  const edgeKeys = new Set<string>();
  let crossBoundary = 0;

  const byContainer = new Map<string, LeafSlot[]>();
  const bySystem = new Map<number, LeafSlot[]>();
  for (const slot of leaves) {
    (byContainer.get(slot.containerKey) ?? byContainer.set(slot.containerKey, []).get(slot.containerKey)!).push(slot);
    (bySystem.get(slot.systemIndex) ?? bySystem.set(slot.systemIndex, []).get(slot.systemIndex)!).push(slot);
  }

  const outermost = (id: string): string => {
    let current = id;
    for (let guard = 0; guard < 8; guard += 1) {
      const parent = parentOf.get(current);
      if (!parent) return current;
      current = parent;
    }
    return current;
  };

  const tryEdge = (sourceId: string, targetId: string, longRange: boolean): boolean => {
    if (sourceId === targetId) return false;
    const key = `${sourceId}>${targetId}`;
    const reverse = `${targetId}>${sourceId}`;
    if (edgeKeys.has(key) || edgeKeys.has(reverse)) return false;
    const source = nodeById.get(sourceId)!;
    const target = nodeById.get(targetId)!;
    edgeKeys.add(key);

    const index = edges.length;
    const roll = rand();
    const routing: EdgeRouting = roll < 0.82 ? 'smoothstep' : roll < 0.92 ? 'bezier' : 'straight';
    const relationship = inferRelationship(source, target);
    let kind: ConnectorKind | undefined = relationship?.kind;
    let asyncFlag = relationship?.async;
    const kindRoll = rand();
    if (!kind && kindRoll < 0.14) {
      kind = 'async';
      asyncFlag = true;
    } else if (!kind && kindRoll < 0.2) {
      kind = 'event';
    } else if (!kind && kindRoll < 0.24) {
      kind = 'conditional';
    }
    const [sourceSide, targetSide] = facing(source, target);
    // Long-range connectors pin their anchors (as a person dragging them would), so they do not all
    // funnel through the same side and instead cross the field the way real ones do.
    const pinned = longRange || rand() < 0.18;
    const isServicePair = categoryOf(source) === 'service' && categoryOf(target) === 'service';
    const edge = createEdge({
      id: `e${index}`,
      source: sourceId,
      target: targetId,
      routing,
      kind,
      async: asyncFlag,
      semantic: relationship?.semantic,
      semanticsOrigin: relationship?.semantic ? 'inferred' : undefined,
      hasResponse: isServicePair && rand() < 0.22,
      label: rand() < 0.3 ? LABELS[Math.floor(rand() * LABELS.length)] : undefined,
      condition: kind === 'conditional' ? 'approved' : undefined,
      ...(pinned
        ? {
            sourceAnchor: anchorFor(sourceSide, [0.25, 0.5, 0.75][Math.floor(rand() * 3)]!),
            targetAnchor: anchorFor(targetSide, [0.25, 0.5, 0.75][Math.floor(rand() * 3)]!),
          }
        : {}),
    });
    edges.push(edge);
    if (outermost(sourceId) !== outermost(targetId) || parentOf.get(sourceId) !== parentOf.get(targetId)) crossBoundary += 1;
    return true;
  };

  const pick = <T,>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const containerKeys = [...byContainer.keys()];
  const systemKeys = [...bySystem.keys()];

  let attempts = 0;
  while (edges.length < spec.edges && attempts < spec.edges * 40) {
    attempts += 1;
    const roll = rand();
    if (roll < 0.34) {
      // Inside one container: neighbours in the grid, the short well-behaved connectors.
      const container = byContainer.get(pick(containerKeys))!;
      const a = pick(container);
      const b = pick(container);
      tryEdge(a.id, b.id, false);
    } else if (roll < 0.6) {
      // Inside one system, across containers.
      const system = bySystem.get(pick(systemKeys))!;
      const a = pick(system);
      const b = pick(system);
      if (a.containerKey !== b.containerKey) tryEdge(a.id, b.id, false);
    } else if (roll < 0.86 || systemKeys.length < 2) {
      // Into a neighbouring system.
      const home = pick(systemKeys);
      const other = systemKeys[(systemKeys.indexOf(home) + 1 + Math.floor(rand() * 2)) % systemKeys.length]!;
      if (other !== home) tryEdge(pick(bySystem.get(home)!).id, pick(bySystem.get(other)!).id, false);
      else tryEdge(pick(leaves).id, pick(leaves).id, false);
    } else {
      // Long range — across the whole canvas, the connectors that cross everything.
      tryEdge(pick(leaves).id, pick(leaves).id, true);
    }
  }
  // Fill any shortfall with additional short connectors so the count stays exact.
  let fill = 0;
  while (edges.length < spec.edges && fill < leaves.length * leaves.length) {
    const a = leaves[fill % leaves.length]!;
    const b = leaves[(fill * 7 + 3) % leaves.length]!;
    tryEdge(a.id, b.id, false);
    fill += 1;
  }

  // ---- Attachments -------------------------------------------------------------------------
  let nodeAttachments = 0;
  let edgeAttachments = 0;
  const hosts = nodes.filter((n) => n.type !== 'group' && n.type !== 'note');
  const nodeHostEvery = Math.max(6, Math.floor(hosts.length / Math.max(1, Math.round(spec.nodes * 0.09))));
  hosts.forEach((host, i) => {
    if (i % nodeHostEvery !== 0) return;
    const count = i % (nodeHostEvery * 5) === 0 ? 3 : 1;
    host.attachments = [];
    for (let k = 0; k < count; k += 1) {
      host.attachments.push(
        k % 2 === 0
          ? createAttachment({ id: `${host.id}a${k}`, type: 'note', text: 'Owned by the platform team', noteKind: k === 0 ? 'note' : 'warning' })
          : createAttachment({
              id: `${host.id}a${k}`,
              type: 'code',
              language: 'json',
              code: '{\n  "retry": { "max": 3, "backoffMs": 250 }\n}',
            }),
      );
      nodeAttachments += 1;
    }
  });
  const edgeHostEvery = Math.max(7, Math.floor(edges.length / Math.max(1, Math.round(spec.edges * 0.06))));
  edges.forEach((edge, i) => {
    if (i % edgeHostEvery !== 0) return;
    const count = i % (edgeHostEvery * 4) === 0 ? 3 : 1;
    edge.attachments = [];
    for (let k = 0; k < count; k += 1) {
      edge.attachments.push(
        k % 2 === 0
          ? createAttachment({ id: `${edge.id}a${k}`, type: 'note', text: 'Timeout is 2s', noteKind: 'note' })
          : createAttachment({ id: `${edge.id}a${k}`, type: 'code', language: 'http', code: 'POST /v1/charge\nIdempotency-Key: <uuid>' }),
      );
      edgeAttachments += 1;
    }
  });

  // ---- Rooms -------------------------------------------------------------------------------
  let roomNodes = 0;
  let roomEdges = 0;
  let rooms = 0;
  const roomHosts = nodes.filter((n) => n.type === 'service');
  const roomStride = Math.max(1, Math.floor(roomHosts.length / Math.max(1, spec.rooms)));
  for (let i = 0; i < roomHosts.length && rooms < spec.rooms; i += roomStride) {
    const host = roomHosts[i]!;
    const built = buildRoom(0x51ed + i, 6 + (rooms % 3) * 2, `r${rooms}`);
    host.inside = {
      nodes: built.nodes,
      edges: built.edges,
      flows: [],
      viewport: { x: 0, y: 0, zoom: 1 },
      level: 'component',
    };
    roomNodes += built.nodes.length;
    roomEdges += built.edges.length;
    rooms += 1;
  }

  // ---- Flows ----------------------------------------------------------------------------
  const flows: DraftFlow[] = [];
  const flowCount = Math.min(4, Math.max(1, Math.floor(spec.nodes / 60)));
  for (let f = 0; f < flowCount; f += 1) {
    const steps = edges.slice(f * 9, f * 9 + 8).map((edge, s) => ({
      id: `f${f}s${s}`,
      edgeId: edge.id,
      caption: s === 0 ? 'Where the request enters' : undefined,
    }));
    if (steps.length > 0) flows.push({ id: `f${f}`, title: `Flow ${f + 1}`, steps, accent: (['teal', 'blue', 'violet', 'amber'] as const)[f % 4] });
  }

  // ---- Assemble ----------------------------------------------------------------------------
  const base = createDocument(`Benchmark — ${spec.label}`);
  const document: DraftDocument = {
    ...base,
    metadata: { ...base.metadata, id: `bench-${spec.name}`, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_000_000 },
    nodes,
    edges,
    flows,
    level: 'container',
    // Frames the first system, and the loose notes to its left, at a readable zoom; scenarios that
    // need the whole field ask for fit-to-view themselves.
    viewport: { x: 330, y: 110, zoom: 0.6 },
  };

  const manifest: ScaleManifest = {
    spec,
    nodes: nodes.length,
    edges: edges.length,
    boundaries: nodes.filter((n) => n.type === 'group').length,
    maxBoundaryDepth: Math.max(...[...depthOf.entries()].filter(([id]) => nodeById.get(id)!.type === 'group').map(([, d]) => d)),
    crossBoundaryEdges: crossBoundary,
    nodeAttachments,
    edgeAttachments,
    rooms,
    roomNodes,
    roomEdges,
    flows: flows.length,
    looseNoteIds,
  };

  if (manifest.nodes !== spec.nodes || manifest.edges !== spec.edges) {
    throw new Error(
      `Scale fixture "${spec.name}" drifted: wanted ${spec.nodes}/${spec.edges}, built ${manifest.nodes}/${manifest.edges}.`,
    );
  }
  return { document, manifest };
}

