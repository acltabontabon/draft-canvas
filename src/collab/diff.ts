/**
 * The changes that turn one version of a file into another.
 *
 * The contract, and what the property tests hold it to: `applyChanges(a, diffFile(a, b))` is `b` —
 * every element, every room, every order and level, the title, the settings and the open points —
 * leaving out only what is never shared: each person's camera (the document's and every room's
 * viewport) and the file's own bookkeeping (`metadata` other than its title). A host broadcasting
 * the diff of each of its commits therefore keeps every collaborator's copy equal to its own.
 *
 * Operations share unchanged structure, so most comparisons end at identity; the rest compare values,
 * never serialized text — a keystroke in a thousand-shape diagram must not stringify the diagram.
 */
import type { DraftDocument, DraftNode, DraftSettings } from '../document/types';
import { ROOT_ROOM, type Change, type NodeValue, type RoomId } from './changes';
import { sameExcept, sameValue } from './equal';
import { indexOf, type FileIndex, type Located } from './fileIndex';

/** A node's own fields — what a change carries for it. */
export function nodeValue(node: DraftNode): NodeValue {
  if (!node.inside) return node;
  const { inside: _inside, ...own } = node;
  return own;
}

/**
 * Settings as they travel. An embedded background image is only ever on a file in transit
 * (`BackgroundSettings.image`); it is megabytes of base64 and never part of a shared edit.
 */
export function wireSettings(settings: DraftSettings): DraftSettings {
  if (settings.background.image === undefined) return settings;
  const { image: _image, ...background } = settings.background;
  return { ...settings, background };
}

export interface DiffOptions {
  /**
   * Also list what was removed only because the shape owning its room was. Applying doesn't need
   * them — removing the owner removes its rooms — but anything asking *which* elements an edit
   * touched does: undoing a deleted Service has to know what was inside it.
   */
  implied?: boolean;
}

export function diffFile(prev: DraftDocument, next: DraftDocument, options: DiffOptions = {}): Change[] {
  if (prev === next) return [];
  const before = indexOf(prev);
  const after = indexOf(next);
  const out: Change[] = [];

  if (prev.metadata.title !== next.metadata.title) out.push({ kind: 'title', value: next.metadata.title });
  if (prev.settings !== next.settings) {
    const settings = wireSettings(next.settings);
    if (!sameValue(wireSettings(prev.settings), settings)) out.push({ kind: 'settings', value: settings });
  }

  const implied = options.implied === true;
  diffElements(before, after, 'node', out, implied);
  diffElements(before, after, 'edge', out, implied);
  diffElements(before, after, 'flow', out, implied);
  diffRooms(before, after, out);
  diffPoints(prev, next, out);
  return out;
}

type ElementKind = 'node' | 'edge' | 'flow';

function locationsOf(index: FileIndex, kind: ElementKind): Map<string, Located<{ id: string }>> {
  return kind === 'node' ? index.nodes : kind === 'edge' ? index.edges : index.flows;
}

function sameElement(kind: ElementKind, a: { id: string }, b: { id: string }): boolean {
  if (a === b) return true;
  return kind === 'node'
    ? sameExcept(a as unknown as Record<string, unknown>, b as unknown as Record<string, unknown>, 'inside')
    : sameValue(a, b);
}

function diffElements(before: FileIndex, after: FileIndex, kind: ElementKind, out: Change[], implied: boolean): void {
  const was = locationsOf(before, kind);
  const now = locationsOf(after, kind);

  for (const [id, located] of now) {
    const old = was.get(id);
    if (!old) {
      out.push(changeOf(kind, id, located.room, located.value));
      continue;
    }
    if (old.room !== located.room) out.push({ kind: 'move', target: kind, id, room: located.room });
    if (!sameElement(kind, old.value, located.value)) out.push(changeOf(kind, id, located.room, located.value));
  }

  for (const [id, old] of was) {
    if (now.has(id)) continue;
    // Gone because the shape that owned its room is gone: removing the owner says so already.
    if (!implied && old.room !== ROOT_ROOM && !after.nodes.has(old.room)) continue;
    out.push(changeOf(kind, id, old.room, null));
  }
}

function changeOf(kind: ElementKind, id: string, room: RoomId, value: { id: string } | null): Change {
  if (kind === 'node') return { kind, id, room, value: value === null ? null : nodeValue(value as DraftNode) };
  return { kind, id, room, value } as Change;
}

const ROOM_COLLECTIONS = ['nodes', 'edges', 'flows'] as const;

function diffRooms(before: FileIndex, after: FileIndex, out: Change[]): void {
  for (const [room, { graph }] of after.rooms) {
    const old = before.rooms.get(room)?.graph;
    if ((old?.level ?? null) !== (graph.level ?? null)) out.push({ kind: 'level', room, value: graph.level ?? null });
    for (const collection of ROOM_COLLECTIONS) {
      const ids = graph[collection];
      if (old && old[collection] === ids) continue;
      const located = collection === 'nodes' ? before.nodes : collection === 'edges' ? before.edges : before.flows;
      const expected = expectedOrder(old?.[collection] ?? [], ids, room, located, collection === 'nodes');
      if (!sameIds(expected, ids)) out.push({ kind: 'order', room, collection, ids: ids.map((item) => item.id) });
    }
  }
}

/**
 * The order `applyChanges` leaves a collection in when it is told nothing about order: what stays,
 * in the order it was in, then what moved in and what was added — new shapes before what moved in,
 * because they are added before anything moves; connectors and flows the other way round. Each
 * group keeps the order it has in `next`, which is the order the diff lists it in.
 */
function expectedOrder(
  old: readonly { id: string }[],
  next: readonly { id: string }[],
  room: RoomId,
  locatedBefore: Map<string, Located<unknown>>,
  addsFirst: boolean,
): string[] {
  const here = new Set(next.map((item) => item.id));
  const kept = old.filter((item) => here.has(item.id)).map((item) => item.id);
  const keptSet = new Set(kept);
  const movedIn: string[] = [];
  const added: string[] = [];
  for (const item of next) {
    if (keptSet.has(item.id)) continue;
    const was = locatedBefore.get(item.id);
    if (!was) added.push(item.id);
    else if (was.room !== room) movedIn.push(item.id);
  }
  return addsFirst ? [...kept, ...added, ...movedIn] : [...kept, ...movedIn, ...added];
}

function sameIds(ids: readonly string[], items: readonly { id: string }[]): boolean {
  if (ids.length !== items.length) return false;
  for (let i = 0; i < ids.length; i += 1) if (ids[i] !== items[i]!.id) return false;
  return true;
}

function diffPoints(prev: DraftDocument, next: DraftDocument, out: Change[]): void {
  if (prev.openPoints === next.openPoints) return;
  const was = new Map(prev.openPoints.map((point) => [point.id, point]));
  const now = new Set<string>();
  for (const point of next.openPoints) {
    now.add(point.id);
    const old = was.get(point.id);
    if (!old || !sameValue(old, point)) out.push({ kind: 'point', id: point.id, value: point });
  }
  for (const point of prev.openPoints) if (!now.has(point.id)) out.push({ kind: 'point', id: point.id, value: null });

  const kept = prev.openPoints.filter((point) => now.has(point.id)).map((point) => point.id);
  const keptSet = new Set(kept);
  const expected = [...kept, ...next.openPoints.filter((point) => !keptSet.has(point.id)).map((point) => point.id)];
  if (!sameIds(expected, next.openPoints)) {
    out.push({ kind: 'order', room: ROOT_ROOM, collection: 'points', ids: next.openPoints.map((point) => point.id) });
  }
}
