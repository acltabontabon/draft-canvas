/**
 * A file with a list of changes applied — the other half of `diffFile`.
 *
 * Last writer wins, element by element: a change replaces the whole element it names, wherever that
 * element is now. Applying is deterministic and never invents anything (no ids, no timestamps), so
 * every copy that applies the same changes to the same file arrives at the same file.
 *
 * A change that cannot apply is skipped rather than failing the rest: an add into a room whose
 * owner is gone, a move that would nest a shape inside itself or deeper than `LIMITS.maxInsideDepth`.
 * The host's commit is what everyone then agrees on, and it simply does not contain what was skipped.
 *
 * An edit to a shape somebody else just deleted is not one of those: a change carries the whole
 * element, so it brings the shape back as its editor last saw it — last writer wins, as for any two
 * edits that cross — while its connectors and inside stay gone. The owner can take that person's
 * changes back (`authorship.ts`), which then keeps the deletion.
 *
 * Changes go through in four passes, whatever order they are listed in: new shapes, then moves, then
 * everything else in each room (outermost room first, so a shape added in this batch exists before
 * anything is added inside it), then the file's own fields. Within a room, adds keep the order they
 * are listed in. `diffFile` writes order changes against exactly this sequence.
 */
import { embed, ownerAt, viewOf, type DepthPath } from '../depth/tree';
import { LIMITS } from '../document/limits';
import { insideHeight } from '../document/operations';
import type { DraftDocument, DraftEdge, DraftFlow, DraftNode, DraftSettings, OpenPoint, ViewLevel } from '../document/types';
import { CAN_HOLD_INSIDE } from '../document/validate';
import type { Change, Collection, NodeValue, RoomId } from './changes';
import { indexOf, pathOf, type FileIndex } from './fileIndex';

export function canHoldInside(node: Pick<DraftNode, 'type'>): boolean {
  return CAN_HOLD_INSIDE.includes(node.type);
}

export function applyChanges(file: DraftDocument, changes: readonly Change[]): DraftDocument {
  if (changes.length === 0) return file;
  // New shapes first, so a move into a room owned by one of them has somewhere to go; moves before
  // removals, so a shape moved out of something deleted in the same edit leaves before it does.
  const before = indexOf(file);
  const adds = changes.filter((change) => change.kind === 'node' && change.value !== null && !before.nodes.has(change.id));
  let next = adds.length > 0 ? applyRooms(file, adds) : file;
  for (const change of changes) if (change.kind === 'move') next = move(next, change);
  next = applyRooms(next, changes);
  return applyFileFields(next, changes);
}

/* ------------------------------------------------------------------ moves -- */

function move(file: DraftDocument, change: Extract<Change, { kind: 'move' }>): DraftDocument {
  const index = indexOf(file);
  const located = (change.target === 'node' ? index.nodes : change.target === 'edge' ? index.edges : index.flows).get(change.id);
  if (!located || located.room === change.room) return file;
  const from = index.rooms.get(located.room)?.path;
  const to = pathOf(index, change.room);
  if (!from || !to) return file;

  if (change.target === 'node') {
    const node = located.value as DraftNode;
    // Into itself, or into something inside it: depth only ever points inward.
    if (to.includes(node.id)) return file;
    if (to.length + insideHeight(node) > LIMITS.maxInsideDepth) return file;
    if (to.length > 0 && !canHoldInside(index.nodes.get(change.room)!.value)) return file;
  }

  const key = change.target === 'node' ? 'nodes' : change.target === 'edge' ? 'edges' : 'flows';
  const removed = updateRoom(file, from, (view) => ({ ...view, [key]: (view[key] as { id: string }[]).filter((item) => item.id !== change.id) }));
  if (removed === file) return file;
  const added = updateRoom(removed, to, (view) => ({ ...view, [key]: [...(view[key] as unknown[]), located.value] }));
  // The destination stopped resolving: leave the element where it was rather than lose it.
  return added === removed ? file : added;
}

function updateRoom(file: DraftDocument, path: DepthPath, fn: (view: DraftDocument) => DraftDocument): DraftDocument {
  const view = viewOf(file, path);
  if (!view) return file;
  const next = fn(view);
  return next === view ? file : embed(file, path, next);
}

/* ------------------------------------------------------------------ rooms -- */

interface ElementPlan<T> {
  /** By id: the new value, or `null` to remove. Later changes to the same id replace earlier ones. */
  set: Map<string, T | null>;
  /** Ids new to the file, in the order they were listed. */
  added: string[];
}

interface RoomPlan {
  nodes: ElementPlan<NodeValue>;
  edges: ElementPlan<DraftEdge>;
  flows: ElementPlan<DraftFlow>;
  level?: ViewLevel | null;
  orders: Map<Collection, string[]>;
}

function emptyPlan(): RoomPlan {
  return {
    nodes: { set: new Map(), added: [] },
    edges: { set: new Map(), added: [] },
    flows: { set: new Map(), added: [] },
    orders: new Map(),
  };
}

function applyRooms(file: DraftDocument, changes: readonly Change[]): DraftDocument {
  const index = indexOf(file);
  const plans = new Map<RoomId, RoomPlan>();
  /** Where each shape added in this batch goes, so a room inside it can be found before it exists. */
  const addedNodeRooms = new Map<string, RoomId>();
  /** Ids this batch adds, file-wide: an id may be new in only one room, or two rooms would hold it. */
  const adding = { node: new Map<string, RoomId>(), edge: new Map<string, RoomId>(), flow: new Map<string, RoomId>() };
  const planFor = (room: RoomId) => {
    let plan = plans.get(room);
    if (!plan) plans.set(room, (plan = emptyPlan()));
    return plan;
  };

  for (const change of changes) {
    switch (change.kind) {
      case 'node':
      case 'edge':
      case 'flow': {
        const located = (change.kind === 'node' ? index.nodes : change.kind === 'edge' ? index.edges : index.flows).get(change.id);
        if (!located && change.value === null) break;
        // A second add of the same new id, aimed at another room, is the same element: it goes where
        // the first one put it.
        const room = located ? located.room : (adding[change.kind].get(change.id) ?? change.room);
        if (!located) adding[change.kind].set(change.id, room);
        const plan = planFor(room)[`${change.kind}s`] as ElementPlan<unknown>;
        if (!located && !plan.set.has(change.id)) plan.added.push(change.id);
        plan.set.set(change.id, change.value);
        if (change.kind === 'node' && !located) addedNodeRooms.set(change.id, room);
        break;
      }
      case 'level':
        planFor(change.room).level = change.value;
        break;
      case 'order':
        if (change.collection !== 'points') planFor(change.room).orders.set(change.collection, change.ids);
        break;
      default:
        break;
    }
  }
  if (plans.size === 0) return file;

  const paths = new Map<RoomId, DepthPath | undefined>();
  const resolve = (room: RoomId): DepthPath | undefined => {
    // These owners came off the wire, not from the bounded document tree. Resolve iteratively:
    // thousands in a chain used to overflow the stack before the depth check below could run.
    const trail: RoomId[] = [];
    const seen = new Set<RoomId>();
    let current = room;
    while (!paths.has(current)) {
      const existing = pathOf(index, current);
      if (existing) {
        paths.set(current, existing);
        break;
      }
      const parent = addedNodeRooms.get(current);
      if (parent === undefined || seen.has(current)) {
        paths.set(current, undefined);
        break;
      }
      seen.add(current);
      trail.push(current);
      current = parent;
    }
    let path = paths.get(current);
    for (let i = trail.length - 1; i >= 0; i -= 1) {
      path = path && path.length < LIMITS.maxInsideDepth ? [...path, trail[i]!] : undefined;
      paths.set(trail[i]!, path);
    }
    return paths.get(room);
  };

  const ordered = [...plans.keys()]
    .map((room) => ({ room, path: resolve(room) }))
    .filter((entry): entry is { room: RoomId; path: DepthPath } => entry.path !== undefined && entry.path.length <= LIMITS.maxInsideDepth)
    .sort((a, b) => a.path.length - b.path.length);

  let next = file;
  for (const { room, path } of ordered) {
    if (path.length > 0) {
      // Outer rooms went first, so a shape added in this batch is there by now — or was refused.
      const owner = ownerAt(next, path);
      if (!owner || !canHoldInside(owner)) continue;
    }
    next = updateRoom(next, path, (view) => applyRoomPlan(view, plans.get(room)!, index));
  }
  return next;
}

function applyRoomPlan(view: DraftDocument, plan: RoomPlan, index: FileIndex): DraftDocument {
  const nodes = applyElements(view.nodes, plan.nodes, index.nodes, (current, value) => {
    // A shape that holds a room may only become another kind that can — its inside would be lost.
    if (current.inside && !canHoldInside(value)) return current;
    return current.inside ? { ...value, inside: current.inside } : (value as DraftNode);
  });
  const edges = applyElements(view.edges, plan.edges, index.edges, (_current, value) => value);
  const flows = applyElements(view.flows, plan.flows, index.flows, (_current, value) => value);

  const ordered = {
    nodes: reorder(nodes, plan.orders.get('nodes')),
    edges: reorder(edges, plan.orders.get('edges')),
    flows: reorder(flows, plan.orders.get('flows')),
  };
  const levelChanged = plan.level !== undefined && (plan.level ?? undefined) !== view.level;
  if (ordered.nodes === view.nodes && ordered.edges === view.edges && ordered.flows === view.flows && !levelChanged) return view;

  const next: DraftDocument = { ...view, ...ordered };
  if (levelChanged) {
    if (plan.level === null) delete next.level;
    else next.level = plan.level!;
  }
  return next;
}

function applyElements<T extends { id: string }, V>(
  items: T[],
  plan: ElementPlan<V>,
  existing: Map<string, unknown>,
  replace: (current: T, value: V) => T,
): T[] {
  if (plan.set.size === 0) return items;
  let changed = false;
  const out: T[] = [];
  for (const item of items) {
    if (!plan.set.has(item.id)) {
      out.push(item);
      continue;
    }
    const value = plan.set.get(item.id);
    if (value === null || value === undefined) {
      changed = true;
      continue;
    }
    const replaced = replace(item, value);
    if (replaced !== item) changed = true;
    out.push(replaced);
  }
  for (const id of plan.added) {
    const value = plan.set.get(id);
    if (value === null || value === undefined || existing.has(id)) continue;
    changed = true;
    out.push(value as unknown as T);
  }
  return changed ? out : items;
}

/** `items` in the order `ids` names, then whatever `ids` left out, in the order it was in. */
export function reorder<T extends { id: string }>(items: T[], ids: readonly string[] | undefined): T[] {
  if (!ids) return items;
  const byId = new Map(items.map((item) => [item.id, item]));
  const out: T[] = [];
  const placed = new Set<string>();
  for (const id of ids) {
    const item = byId.get(id);
    if (!item || placed.has(id)) continue;
    placed.add(id);
    out.push(item);
  }
  for (const item of items) if (!placed.has(item.id)) out.push(item);
  return out.every((item, i) => item === items[i]) ? items : out;
}

/* ------------------------------------------------------------ file fields -- */

function applyFileFields(file: DraftDocument, changes: readonly Change[]): DraftDocument {
  let title: string | undefined;
  let settings: DraftSettings | undefined;
  const points: ElementPlan<OpenPoint> = { set: new Map(), added: [] };
  let pointOrder: string[] | undefined;
  const known = new Set(file.openPoints.map((point) => point.id));

  for (const change of changes) {
    if (change.kind === 'title') title = change.value;
    else if (change.kind === 'settings') settings = change.value;
    else if (change.kind === 'order' && change.collection === 'points') pointOrder = change.ids;
    else if (change.kind === 'point') {
      if (!known.has(change.id) && change.value === null) continue;
      if (!known.has(change.id) && !points.set.has(change.id)) points.added.push(change.id);
      points.set.set(change.id, change.value);
    }
  }

  let next = file;
  if (title !== undefined && title !== file.metadata.title) next = { ...next, metadata: { ...next.metadata, title } };
  if (settings !== undefined) {
    // An embedded image never travels (`wireSettings`); a copy that has one keeps it.
    const image = file.settings.background.image;
    next = { ...next, settings: image === undefined ? settings : { ...settings, background: { ...settings.background, image } } };
  }
  const openPoints = reorder(
    applyElements(file.openPoints, points, new Map([...known].map((id) => [id, true])), (_current, value) => value),
    pointOrder,
  );
  if (openPoints !== file.openPoints) next = { ...next, openPoints };
  return next;
}
