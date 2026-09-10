import { categoryOf } from './connectorSemantics';
import { boundsOf } from './operations';
import { SHAPE_VERSION, type DraftEdge, type DraftNode, type LibraryShape, type ShapeKind } from './types';

/**
 * The library's topology fingerprint — see `LibraryShape` in `types.ts`.
 *
 * Pure and deterministic: the same nodes and edges always produce the same
 * bytes, so a summary rewritten on every autosave never churns for no reason.
 * It runs on the save path, so it is one pass plus two small sorts, never a
 * layout. Text, notes, and code cards are left out entirely — they are what a
 * diagram *says*; the fingerprint only records what it is *shaped like*.
 */

export const SHAPE_MAX_NODES = 24;
export const SHAPE_MAX_EDGES = 40;
const SHAPE_EXTENT = 1000;

const SHAPE_KINDS: ReadonlySet<string> = new Set<ShapeKind>([
  'service',
  'external',
  'database',
  'queue',
  'topic',
  'actor',
  'component',
  'junction',
  'boundary',
]);

/** Which silhouette a node contributes, or `null` for the ones a fingerprint ignores. */
export function shapeKindOf(node: DraftNode): ShapeKind | null {
  // `categoryOf` files a boundary under `generic` with the text kinds — for
  // connector semantics that is right (a boundary takes no arrows), for a
  // silhouette it is the most recognisable stroke on the canvas.
  if (node.type === 'group') return 'boundary';
  switch (categoryOf(node)) {
    case 'service':
    case 'worker':
    case 'scheduler':
    case 'gateway':
      return 'service';
    case 'external':
      return 'external';
    case 'database':
    case 'cache':
    case 'fileSystem':
    case 'objectStorage':
    case 'searchIndex':
      return 'database';
    case 'queue':
    case 'deadLetter':
      return 'queue';
    case 'topic':
      return 'topic';
    case 'actor':
      return 'actor';
    case 'component':
    case 'port':
      return 'component';
    case 'junction':
      return 'junction';
    default:
      return null;
  }
}

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Always returns a shape, even for a canvas of nothing but notes (`nodes: []`)
 * — a summary that could legitimately lack one would look identical to a
 * summary an older build never computed, and the startup backfill would
 * decrypt that canvas again on every launch to find out.
 */
export function libraryShapeOf(nodes: readonly DraftNode[], edges: readonly DraftEdge[]): LibraryShape {
  const kinds = new Map<string, ShapeKind>();
  const boundaries: DraftNode[] = [];
  const others: DraftNode[] = [];
  for (const node of nodes) {
    const kind = shapeKindOf(node);
    if (!kind) continue;
    kinds.set(node.id, kind);
    (kind === 'boundary' ? boundaries : others).push(node);
  }
  // Boundaries first (outermost first), then the biggest things on the
  // canvas: when the cap bites, what survives is the diagram's skeleton.
  boundaries.sort((a, b) => a.z - b.z || compareIds(a.id, b.id));
  others.sort((a, b) => b.width * b.height - a.width * a.height || compareIds(a.id, b.id));
  const kept = [...boundaries, ...others].slice(0, SHAPE_MAX_NODES);

  const bounds = boundsOf(kept);
  if (!bounds) return { v: SHAPE_VERSION, w: 0, h: 0, nodes: [], edges: [] };
  const scale = SHAPE_EXTENT / Math.max(bounds.width, bounds.height, 1);
  const unit = (value: number) => Math.max(1, Math.round(value * scale));

  const index = new Map(kept.map((node, i) => [node.id, i] as const));
  const shapeNodes: LibraryShape['nodes'] = kept.map((node) => [
    kinds.get(node.id)!,
    Math.round((node.x - bounds.x) * scale),
    Math.round((node.y - bounds.y) * scale),
    unit(node.width),
    unit(node.height),
  ]);

  const shapeEdges: LibraryShape['edges'] = [];
  for (const edge of edges) {
    const from = index.get(edge.source);
    const to = index.get(edge.target);
    if (from === undefined || to === undefined || from === to) continue;
    shapeEdges.push([from, to]);
    if (shapeEdges.length >= SHAPE_MAX_EDGES) break;
  }

  return { v: SHAPE_VERSION, w: unit(bounds.width), h: unit(bounds.height), nodes: shapeNodes, edges: shapeEdges };
}

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * Summaries are read straight out of IndexedDB and never pass through
 * `parseDocument`, so anything drawing a shape checks it here first. A wrong
 * `v` fails too: that is what makes bumping `SHAPE_VERSION` re-derive rows.
 */
export function isLibraryShape(value: unknown): value is LibraryShape {
  if (typeof value !== 'object' || value === null) return false;
  const shape = value as Record<string, unknown>;
  if (shape.v !== SHAPE_VERSION || !isFiniteNumber(shape.w) || !isFiniteNumber(shape.h)) return false;
  if (!Array.isArray(shape.nodes) || !Array.isArray(shape.edges)) return false;
  const nodesOk = shape.nodes.every(
    (entry) =>
      Array.isArray(entry) &&
      entry.length === 5 &&
      SHAPE_KINDS.has(entry[0] as string) &&
      entry.slice(1).every(isFiniteNumber),
  );
  if (!nodesOk) return false;
  const count = shape.nodes.length;
  return shape.edges.every(
    (entry) =>
      Array.isArray(entry) &&
      entry.length === 2 &&
      entry.every((i) => Number.isInteger(i) && (i as number) >= 0 && (i as number) < count),
  );
}
