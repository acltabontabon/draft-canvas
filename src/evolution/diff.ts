/**
 * The semantic difference between two versions of a diagram: which elements were added, removed or
 * changed, in which rooms, and what kind of change each was. One engine, used by capture (to word a
 * revision), the timeline (session summaries, search), compare (overlays and the change list),
 * merge, the agent tools and the tests.
 *
 * It is built on `collab/diffFile` — elements matched by id across every room, never by label — and
 * adds what history needs: field-level detail, a category for every change, and labels to show.
 * Whether anything changed at all is not decided here: equal history bytes are (`snapshot.ts`).
 * `tests/evolution/diff.test.ts` holds the two to agreement: whenever the bytes differ, this lists
 * at least one change.
 */
import { ROOT_ROOM, type Change, type RoomId } from '../collab/changes';
import { diffFile } from '../collab/diff';
import { indexOf, type FileIndex } from '../collab/fileIndex';
import { classOfField, type FieldClass } from '../document/fieldClasses';
import type { DraftDocument, DraftEdge, DraftNode } from '../document/types';

export type Category =
  | 'structure'
  | 'relationships'
  | 'properties'
  | 'text'
  | 'layout'
  | 'style'
  | 'grouping'
  | 'navigation'
  | 'flows'
  | 'annotations'
  | 'metadata';

export const CATEGORIES: readonly Category[] = [
  'structure',
  'relationships',
  'properties',
  'text',
  'layout',
  'style',
  'grouping',
  'navigation',
  'flows',
  'annotations',
  'metadata',
];

/** Structure and relationships: what "only structural changes" keeps. */
export const STRUCTURAL: ReadonlySet<Category> = new Set(['structure', 'relationships', 'grouping', 'navigation']);

export type ElementKind = 'node' | 'edge' | 'flow' | 'ink' | 'point';

export interface ElementChange {
  kind: ElementKind;
  id: string;
  /** The room it is in after the change (before, for a removal). */
  room: RoomId;
  change: 'added' | 'removed' | 'modified';
  /** What to call it: a shape's name, a connector's ends, a flow's title. */
  label: string;
  /** The shape type, for a node. */
  type?: string;
  categories: Category[];
  /** Fields whose values differ, for a modification. */
  fields: string[];
  /** It moved between rooms. */
  roomMove?: { from: RoomId; to: RoomId };
  /** Shapes, connectors and flows inside a removed or added shape's rooms. */
  contained?: number;
}

export interface FileLevelChange {
  kind: 'title' | 'settings' | 'style' | 'level' | 'order';
  room?: RoomId;
  categories: Category[];
}

export interface SemanticDiff {
  elements: ElementChange[];
  file: FileLevelChange[];
  categories: Category[];
  /** Names of rooms by owner id, for wording ("in Checkout"). */
  rooms: Record<RoomId, string>;
}

const FIELD_CATEGORY: Record<FieldClass, Category> = {
  layout: 'layout',
  text: 'text',
  style: 'style',
  grouping: 'grouping',
  relationship: 'relationships',
  navigation: 'navigation',
  property: 'properties',
};

function nodeLabel(node: DraftNode | undefined): string {
  const text = node?.text?.trim();
  if (text) return text.split('\n')[0]!.slice(0, 80);
  return node ? typeLabel(node.type) : 'a shape';
}

export function typeLabel(type: string): string {
  return type.charAt(0).toUpperCase() + type.slice(1);
}

function edgeLabel(edge: DraftEdge, a: FileIndex, b: FileIndex): string {
  const end = (id: string) => nodeLabel(b.nodes.get(id)?.value ?? a.nodes.get(id)?.value);
  return `${end(edge.source)} → ${end(edge.target)}`;
}

function changedFields(before: object, after: object): string[] {
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const key of keys) {
    if (key === 'inside' || key === 'id') continue;
    if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) out.push(key);
  }
  return out.sort();
}

function countInside(node: DraftNode | undefined): number {
  if (!node?.inside) return 0;
  let n = 0;
  const visit = (room: NonNullable<DraftNode['inside']>) => {
    n += room.nodes.length + room.edges.length + room.flows.length;
    for (const child of room.nodes) if (child.inside) visit(child.inside);
  };
  visit(node.inside);
  return n;
}

function categoriesOfFields(kind: ElementKind, fields: string[]): Category[] {
  if (kind === 'flow') return ['flows'];
  if (kind === 'ink' || kind === 'point') return ['annotations'];
  const set = new Set<Category>();
  for (const field of fields) {
    if (field === 'attachments' || field === 'evidence') set.add('annotations');
    else if (field === 'sequence') set.add('structure');
    else set.add(FIELD_CATEGORY[classOfField(field)]);
  }
  return [...set];
}

function addedCategories(kind: ElementKind): Category[] {
  if (kind === 'node') return ['structure'];
  if (kind === 'edge') return ['relationships'];
  if (kind === 'flow') return ['flows'];
  return ['annotations'];
}

/**
 * The semantic difference from `before` to `after`. `before: null` lists `after` as one addition
 * (the first revision of a history).
 */
export function semanticDiff(before: DraftDocument | null, after: DraftDocument): SemanticDiff {
  const prev = before ?? { ...after, nodes: [], edges: [], flows: [], ink: [], openPoints: [], style: undefined, metadata: { ...after.metadata, title: '' } };
  const changes = diffFile(prev, after);
  const a = indexOf(prev);
  const b = indexOf(after);
  const byKey = new Map<string, ElementChange>();
  const file: FileLevelChange[] = [];

  const element = (kind: ElementKind, id: string): ElementChange | undefined => byKey.get(`${kind}:${id}`);

  for (const change of changes) {
    switch (change.kind) {
      case 'node':
      case 'edge':
      case 'flow':
      case 'ink':
        recordElement(change, a, b, byKey);
        break;
      case 'point': {
        const existed = prev.openPoints.some((point) => point.id === change.id);
        const label = (change.value ?? prev.openPoints.find((point) => point.id === change.id))?.context ?? 'Open point';
        byKey.set(`point:${change.id}`, {
          kind: 'point',
          id: change.id,
          room: ROOT_ROOM,
          change: change.value === null ? 'removed' : existed ? 'modified' : 'added',
          label: label.slice(0, 80) || 'Open point',
          categories: ['annotations'],
          fields: [],
        });
        break;
      }
      case 'move': {
        const known = element(change.target, change.id);
        const from = (change.target === 'node' ? a.nodes : change.target === 'edge' ? a.edges : change.target === 'flow' ? a.flows : a.ink).get(change.id)?.room ?? ROOT_ROOM;
        if (known) {
          known.roomMove = { from, to: change.room };
          if (!known.categories.includes('grouping')) known.categories.push('grouping');
        } else {
          const value = change.target === 'node' ? b.nodes.get(change.id)?.value : undefined;
          byKey.set(`${change.target}:${change.id}`, {
            kind: change.target,
            id: change.id,
            room: change.room,
            change: 'modified',
            label: change.target === 'node' ? nodeLabel(value) : change.target === 'edge' ? edgeLabel(b.edges.get(change.id)!.value, a, b) : change.target,
            ...(value ? { type: value.type } : {}),
            categories: ['grouping'],
            fields: [],
            roomMove: { from, to: change.room },
          });
        }
        break;
      }
      case 'title':
        file.push({ kind: 'title', categories: ['metadata'] });
        break;
      case 'settings':
        file.push({ kind: 'settings', categories: ['properties'] });
        break;
      case 'style':
        file.push({ kind: 'style', categories: ['style'] });
        break;
      case 'level':
        file.push({ kind: 'level', room: change.room, categories: ['properties'] });
        break;
      case 'order':
        file.push({ kind: 'order', room: change.room, categories: change.collection === 'flows' ? ['flows'] : ['layout'] });
        break;
    }
  }

  // What `diffFile` leaves out on purpose but history keeps: the file's own metadata besides the
  // title (`id`, `createdAt`, `origin`) and every flow step's camera. Cameras of rooms never count.
  if (before && (before.metadata.id !== after.metadata.id || before.metadata.createdAt !== after.metadata.createdAt || JSON.stringify(before.metadata.origin) !== JSON.stringify(after.metadata.origin))) {
    file.push({ kind: 'title', categories: ['metadata'] });
  }

  const elements = [...byKey.values()].sort(orderOfChanges);
  const categories = new Set<Category>();
  for (const change of elements) for (const category of change.categories) categories.add(category);
  for (const change of file) for (const category of change.categories) categories.add(category);
  const rooms: Record<RoomId, string> = {};
  for (const index of [a, b]) {
    for (const room of index.rooms.keys()) {
      if (room === ROOT_ROOM) continue;
      rooms[room] = nodeLabel(b.nodes.get(room)?.value ?? a.nodes.get(room)?.value);
    }
  }
  return { elements, file, categories: CATEGORIES.filter((category) => categories.has(category)), rooms };
}

function recordElement(change: Extract<Change, { kind: 'node' | 'edge' | 'flow' | 'ink' }>, a: FileIndex, b: FileIndex, out: Map<string, ElementChange>): void {
  const kind = change.kind;
  const beforeMap = kind === 'node' ? a.nodes : kind === 'edge' ? a.edges : kind === 'flow' ? a.flows : a.ink;
  const old = beforeMap.get(change.id);
  const value = change.value;
  if (value === null) {
    const removed = old?.value as DraftNode | DraftEdge | undefined;
    out.set(`${kind}:${change.id}`, {
      kind,
      id: change.id,
      room: old?.room ?? change.room,
      change: 'removed',
      label: labelOf(kind, removed, a, b),
      ...(kind === 'node' && removed ? { type: (removed as DraftNode).type } : {}),
      categories: addedCategories(kind),
      fields: [],
      ...(kind === 'node' && countInside(removed as DraftNode) > 0 ? { contained: countInside(removed as DraftNode) } : {}),
    });
    return;
  }
  if (!old) {
    const added = (kind === 'node' ? b.nodes.get(change.id)?.value : value) as DraftNode | DraftEdge | undefined;
    out.set(`${kind}:${change.id}`, {
      kind,
      id: change.id,
      room: change.room,
      change: 'added',
      label: labelOf(kind, added, a, b),
      ...(kind === 'node' && added ? { type: (added as DraftNode).type } : {}),
      categories: addedCategories(kind),
      fields: [],
      ...(kind === 'node' && countInside(added as DraftNode) > 0 ? { contained: countInside(added as DraftNode) } : {}),
    });
    return;
  }
  const fields = changedFields(old.value as object, value as object);
  const current = (kind === 'node' ? b.nodes.get(change.id)?.value : value) as DraftNode | DraftEdge;
  out.set(`${kind}:${change.id}`, {
    kind,
    id: change.id,
    room: change.room,
    change: 'modified',
    label: labelOf(kind, current, a, b),
    ...(kind === 'node' ? { type: (current as DraftNode).type } : {}),
    categories: categoriesOfFields(kind, fields),
    fields,
  });
}

function labelOf(kind: ElementKind, value: unknown, a: FileIndex, b: FileIndex): string {
  if (kind === 'node') return nodeLabel(value as DraftNode | undefined);
  if (kind === 'edge') return value ? edgeLabel(value as DraftEdge, a, b) : 'a connector';
  if (kind === 'flow') return ((value as { title?: string } | undefined)?.title ?? 'a flow').slice(0, 80) || 'a flow';
  return 'a sketch';
}

const CHANGE_ORDER = { added: 0, removed: 1, modified: 2 } as const;
const KIND_ORDER = { node: 0, edge: 1, flow: 2, point: 3, ink: 4 } as const;

function orderOfChanges(x: ElementChange, y: ElementChange): number {
  return CHANGE_ORDER[x.change] - CHANGE_ORDER[y.change] || KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
}

/** Whether the diff has nothing in it. */
export function isEmptyDiff(diff: SemanticDiff): boolean {
  return diff.elements.length === 0 && diff.file.length === 0;
}
