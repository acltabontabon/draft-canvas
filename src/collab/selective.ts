/**
 * Undo and redo while other people are editing the same file.
 *
 * Alone, undo puts a whole-file snapshot back. Together, that would also take back everything anyone
 * else did since — so instead each history entry remembers what it touched (`changeKeys`), and
 * stepping back reverts exactly those things, and only where they still hold what this edit left
 * there. Something another person changed since is theirs now and is left alone; an undo that would
 * have to take away something another person built on it (a connector to the shape being un-added)
 * is refused rather than taking it.
 */
import type { DraftDocument } from '../document/types';
import { applyChanges } from './apply';
import { keyOf, ROOT_ROOM, type Change, type Collection, type RoomId } from './changes';
import { diffFile, nodeValue, wireSettings } from './diff';
import { sameExcept, sameValue } from './equal';
import { indexOf } from './fileIndex';
import { repairReferences } from './repair';

/** Everything an edit from `before` to `after` touched, nested contents of what it removed included. */
export function changeKeys(before: DraftDocument, after: DraftDocument): string[] {
  return [...new Set(diffFile(before, after, { implied: true }).map(keyOf))];
}

export interface SelectiveStep {
  /** The file after the step, or `current` itself when nothing could be taken back. */
  file: DraftDocument;
  /** Some of what the step would have reverted has been changed by somebody else since. */
  partial: boolean;
  /** Reverting would have removed something somebody else made; nothing was changed. */
  blocked: boolean;
}

/**
 * Takes `current` from what an entry left (`from`) back to what it found (`to`), for the `keys` the
 * entry touched. Undo passes `(entry.after, entry.before)`; redo the other way round.
 */
export function revertKeys(current: DraftDocument, from: DraftDocument, to: DraftDocument, keys: readonly string[]): SelectiveStep {
  return revertEach(current, keys.map((key) => ({ key, left: from, found: to })));
}

/** One thing to take back: `key`, from what an edit left there to what it found there. */
export interface KeyRevert {
  key: string;
  /** The file just after the last edit that touched `key`. */
  left: DraftDocument;
  /** The file just before the first edit that touched it. */
  found: DraftDocument;
}

/**
 * `revertKeys` for things touched at different times — one person's edits across a session, each
 * shape with its own before and after. The same rules: only where `current` still holds what was
 * left, and nothing that would take away something outside `reverts` (another person's connector to
 * a shape being un-added).
 */
export function revertEach(current: DraftDocument, reverts: readonly KeyRevert[]): SelectiveStep {
  // What the step may change: the keys it takes back, never one left alone because somebody changed
  // it since — repair taking that away (their relabelled connector to a shape being un-added) is
  // exactly the work of theirs a step must not remove.
  const wanted = new Set<string>();
  // One diff per pair of files, however many keys share it.
  const diffs = new Map<DraftDocument, Map<DraftDocument, Change[]>>();
  const diffOf = (left: DraftDocument, found: DraftDocument) => {
    let byFound = diffs.get(left);
    if (!byFound) diffs.set(left, (byFound = new Map()));
    let changes = byFound.get(found);
    if (!changes) byFound.set(found, (changes = diffFile(left, found, { implied: true })));
    return changes;
  };
  const kept: Change[] = [];
  const arrivals: Arrival[] = [];
  let partial = false;
  for (const revert of reverts) {
    const changes = diffOf(revert.left, revert.found).filter((change) => keyOf(change) === revert.key);
    if (changes.length === 0) {
      wanted.add(revert.key);
      continue;
    }
    if (!sameAt(current, revert.left, revert.key)) {
      partial = true;
      continue;
    }
    wanted.add(revert.key);
    kept.push(...changes);
    const arrival = arrivalOf(current, revert.found, revert.key);
    if (arrival) arrivals.push(arrival);
  }
  if (kept.length === 0) return { file: current, partial, blocked: false };

  const placed = placeArrivals(applyChanges(current, kept), arrivals);
  for (const key of placed.keys) wanted.add(key);
  const result = repairReferences(placed.file);
  // Anything else the step would change is somebody else's work hanging off it: a connector to the
  // shape being un-added (repair), a shape put inside it (its room goes with it).
  const extra = changeKeys(current, result).filter((key) => !wanted.has(key));
  if (extra.length > 0) return { file: current, partial, blocked: true };
  return { file: result, partial, blocked: false };
}

/** Something a revert brings back into a list it is not in now: undeleted, or moved back to its room. */
interface Arrival {
  id: string;
  room: RoomId;
  collection: Collection;
  /** The file it comes back from, which says where in the list it was. */
  found: DraftDocument;
}

const COLLECTION_OF = { node: 'nodes', edge: 'edges', flow: 'flows' } as const;

function arrivalOf(current: DraftDocument, found: DraftDocument, key: string): Arrival | null {
  const colon = key.indexOf(':');
  const kind = key.slice(0, colon);
  const id = key.slice(colon + 1);
  if (kind === 'point') {
    const back = found.openPoints.some((point) => point.id === id) && !current.openPoints.some((point) => point.id === id);
    return back ? { id, room: ROOT_ROOM, collection: 'points', found } : null;
  }
  if (kind !== 'node' && kind !== 'edge' && kind !== 'flow') return null;
  const collection = COLLECTION_OF[kind];
  const was = indexOf(found)[collection].get(id);
  if (!was || indexOf(current)[collection].get(id)?.room === was.room) return null;
  return { id, room: was.room, collection, found };
}

function idsIn(file: DraftDocument, room: RoomId, collection: Collection): string[] | null {
  if (collection === 'points') return room === ROOT_ROOM ? file.openPoints.map((point) => point.id) : null;
  return indexOf(file).rooms.get(room)?.graph[collection].map((item) => item.id) ?? null;
}

/**
 * Puts what a revert brought back where it was in its list, rather than at the end where adding
 * leaves it: a list's order is the Flows panel's order, and which connector draws over which. It goes
 * just after the nearest one before it that is still there, so a reorder somebody else made since
 * stands. The order keys this touches are part of the revert.
 */
function placeArrivals(file: DraftDocument, arrivals: readonly Arrival[]): { file: DraftDocument; keys: string[] } {
  const lists = new Map<string, { room: RoomId; collection: Collection; ids: string[]; arrivals: Arrival[] }>();
  for (const arrival of arrivals) {
    const key = `order:${arrival.room}:${arrival.collection}`;
    let list = lists.get(key);
    if (!list) {
      const ids = idsIn(file, arrival.room, arrival.collection);
      if (!ids) continue;
      lists.set(key, (list = { room: arrival.room, collection: arrival.collection, ids, arrivals: [] }));
    }
    list.arrivals.push(arrival);
  }
  const changes: Change[] = [];
  for (const [key, list] of lists) {
    const ids = [...list.ids];
    // In the order they had, so each can follow one placed just before it.
    const ordered = list.arrivals
      .map((arrival) => ({ arrival, was: idsIn(arrival.found, list.room, list.collection) ?? [] }))
      .sort((a, b) => a.was.indexOf(a.arrival.id) - b.was.indexOf(b.arrival.id));
    for (const { arrival, was } of ordered) {
      const from = ids.indexOf(arrival.id);
      const at = was.indexOf(arrival.id);
      if (from === -1 || at === -1) continue;
      ids.splice(from, 1);
      const previous = was.slice(0, at).reverse().find((id) => ids.includes(id));
      const following = previous === undefined ? was.slice(at + 1).find((id) => ids.includes(id)) : undefined;
      const index = previous !== undefined ? ids.indexOf(previous) + 1 : following !== undefined ? ids.indexOf(following) : ids.length;
      ids.splice(index, 0, arrival.id);
    }
    if (sameValue(ids, list.ids)) lists.delete(key);
    else changes.push({ kind: 'order', room: list.room, collection: list.collection, ids });
  }
  return changes.length === 0 ? { file, keys: [] } : { file: applyChanges(file, changes), keys: [...lists.keys()] };
}

/** Whether `current` still holds, for `key`, exactly what `left` holds — the edit's result untouched. */
export function sameAt(current: DraftDocument, left: DraftDocument, key: string): boolean {
  const colon = key.indexOf(':');
  const kind = colon === -1 ? key : key.slice(0, colon);
  const rest = colon === -1 ? '' : key.slice(colon + 1);
  const a = indexOf(current);
  const b = indexOf(left);
  switch (kind) {
    case 'node': {
      const x = a.nodes.get(rest);
      const y = b.nodes.get(rest);
      if (!x || !y) return !x && !y;
      return x.room === y.room && sameExcept(nodeValue(x.value) as unknown as Record<string, unknown>, nodeValue(y.value) as unknown as Record<string, unknown>, 'inside');
    }
    case 'edge':
    case 'flow': {
      const x = (kind === 'edge' ? a.edges : a.flows).get(rest);
      const y = (kind === 'edge' ? b.edges : b.flows).get(rest);
      if (!x || !y) return !x && !y;
      return x.room === y.room && sameValue(x.value, y.value);
    }
    case 'point':
      return sameValue(current.openPoints.find((p) => p.id === rest), left.openPoints.find((p) => p.id === rest));
    case 'title':
      return current.metadata.title === left.metadata.title;
    case 'settings':
      return sameValue(wireSettings(current.settings), wireSettings(left.settings));
    case 'level':
      return (a.rooms.get(rest)?.graph.level ?? null) === (b.rooms.get(rest)?.graph.level ?? null);
    case 'order': {
      const split = rest.lastIndexOf(':');
      const room = rest.slice(0, split);
      const collection = rest.slice(split + 1);
      const ids = (file: DraftDocument, index: typeof a) => {
        if (collection === 'points') return room === ROOT_ROOM ? file.openPoints.map((p) => p.id) : [];
        const graph = index.rooms.get(room)?.graph;
        return graph ? (graph[collection as 'nodes' | 'edges' | 'flows'] as { id: string }[]).map((item) => item.id) : [];
      };
      return sameValue(ids(current, a), ids(left, b));
    }
    default:
      return false;
  }
}
