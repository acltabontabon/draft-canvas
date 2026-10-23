/**
 * What every copy of a shared file is held to, whoever changed it: the document-wide limits
 * `validate.ts` enforces on a file from disk, and one element per id. The owner checks every
 * collaborator's patch against these; a collaborator checks every commit from the owner.
 */
import { totals } from '../depth/tree';
import { LIMITS } from '../document/limits';
import type { DraftDocument, DraftNode } from '../document/types';
import type { Change } from './changes';
import { nodeValue, wireSettings } from './diff';
import { indexOf } from './fileIndex';
import { MAX_MESSAGE_BYTES } from './protocol';

/**
 * The most a collaborator may grow the shared file to, measured as a `.draftcanvas` file is written:
 * indented JSON (`serializeDocument`), which can be eight times a compact file of connectors with many
 * bends. Every count limit can be met by a file far past what reopens (`LIMITS.maxFileBytes`), which
 * autosave would then keep; this keeps the written file inside it with room to spare, and a fresh
 * copy (compact, so smaller still) inside one message.
 */
export const MAX_SHARED_FILE_BYTES = Math.min(LIMITS.maxFileBytes * 0.75, MAX_MESSAGE_BYTES - 256 * 1024);

const encoder = new TextEncoder();

function utf8Bytes(text: string): number {
  // ASCII is the common case and needs no encoding to count.
  return /^[ -~\n]*$/.test(text) ? text.length : encoder.encode(text).byteLength;
}

/** A whole file as it is written: indented JSON, in UTF-8 bytes. */
export function fileBytes(file: DraftDocument): number {
  return utf8Bytes(JSON.stringify(file, null, 2) ?? '');
}

/** `value` written at `level` levels of indentation, as it sits inside the file; and how many lines it takes. */
function written(value: unknown, level: number): { bytes: number; lines: number } {
  const text = JSON.stringify(value, null, 2) ?? '';
  let lines = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lines += 1;
  return { bytes: utf8Bytes(text) + lines * level * 2, lines };
}

/**
 * Lines `value` takes written out, by object: a shape moved keeps its object (rooms and all), so moving
 * a large container back and forth is counted once, not serialised again with every move.
 */
const linesOf = new WeakMap<object, number>();

function lines(value: object): number {
  let count = linesOf.get(value);
  if (count === undefined) linesOf.set(value, (count = written(value, 0).lines));
  return count;
}

/** What a room's wrapper (`inside`, its lists and camera, indented) adds when a first shape opens it. */
const NEW_ROOM_BYTES = 512;
/** Between two things in a list: the comma and the line break. */
const SEPARATOR_BYTES = 2;

/**
 * How much `changes` grow `before` by, as written (`MAX_SHARED_FILE_BYTES`), counted element by element
 * so it never costs a whole-file serialisation. Close, not exact — a shape and what is inside it
 * moved and edited together can be counted a little off — so near the cap `HostCore` measures.
 */
export function growthOf(before: DraftDocument, after: DraftDocument, changes: readonly Change[]): { bytes: number } {
  const index = indexOf(before);
  const next = indexOf(after);
  // How deep a room's list items sit: the document's own lists are two levels in, and each room in
  // (the shape, its `inside`, that room's list) is three more.
  const depth = (of: typeof index, room: string) => 2 + 3 * (of.rooms.get(room)?.path.length ?? 0);
  // Rooms opened less rooms closed, from both files' indexes (built for the diff already): counted
  // per change instead, a room opened and emptied again patch after patch only ever added.
  let bytes = (next.rooms.size - index.rooms.size) * NEW_ROOM_BYTES;
  // What a removed shape took with it, from its rooms: only what is really gone — something moved out
  // of it in the same edit is still in the file, and counting it as gone let the file grow unseen.
  const removed = new Set(changes.filter((change) => change.kind === 'node' && change.value === null && index.nodes.get(change.id)?.value.inside).map((change) => (change as { id: string }).id));
  if (removed.size > 0) {
    const inRemoved = (room: string) => index.rooms.get(room)?.path.some((id) => removed.has(id)) ?? false;
    const gone = (value: unknown, room: string) => written(value, depth(index, room)).bytes + SEPARATOR_BYTES;
    for (const [id, located] of index.nodes) if (inRemoved(located.room) && !next.nodes.has(id)) bytes -= gone(nodeValue(located.value), located.room);
    for (const [id, located] of index.edges) if (inRemoved(located.room) && !next.edges.has(id)) bytes -= gone(located.value, located.room);
    for (const [id, located] of index.flows) if (inRemoved(located.room) && !next.flows.has(id)) bytes -= gone(located.value, located.room);
  }
  // Elements whose value this edit also sets: that change counts them at their new depth already.
  const valued = new Set(changes.filter((change) => (change.kind === 'node' || change.kind === 'edge' || change.kind === 'flow') && change.value !== null).map((change) => `${change.kind}:${(change as { id: string }).id}`));
  for (const change of changes) {
    switch (change.kind) {
      case 'node':
      case 'edge':
      case 'flow': {
        const lookup = change.kind === 'node' ? index.nodes : change.kind === 'edge' ? index.edges : index.flows;
        const was = lookup.get(change.id);
        const room = (change.kind === 'node' ? next.nodes : change.kind === 'edge' ? next.edges : next.flows).get(change.id)?.room ?? change.room;
        const own = (value: unknown) => (change.kind === 'node' ? nodeValue(value as DraftNode) : value);
        if (change.value) bytes += written(change.value, depth(next, room)).bytes + (was ? 0 : SEPARATOR_BYTES);
        if (was) bytes -= written(own(was.value), depth(index, was.room)).bytes + (change.value ? 0 : SEPARATOR_BYTES);
        break;
      }
      case 'point': {
        const was = before.openPoints.find((point) => point.id === change.id);
        bytes += (change.value ? written(change.value, 2).bytes : 0) - (was ? written(was, 2).bytes : 0) + (!was && change.value ? SEPARATOR_BYTES : 0);
        break;
      }
      case 'title':
        bytes += utf8Bytes(JSON.stringify(change.value)) - utf8Bytes(JSON.stringify(before.metadata.title));
        break;
      case 'settings':
        // Without an embedded image, which no change carries and applying keeps: counted, each
        // settings change would take its size off the total again.
        bytes += written(change.value, 1).bytes - written(wireSettings(before.settings), 1).bytes;
        break;
      // The same bytes elsewhere — but at another depth, every line of it indented more or less (a
      // shape takes its rooms along).
      case 'move': {
        const lookup = change.target === 'node' ? index.nodes : change.target === 'edge' ? index.edges : index.flows;
        const was = lookup.get(change.id);
        const now = (change.target === 'node' ? next.nodes : change.target === 'edge' ? next.edges : next.flows).get(change.id);
        if (!was || !now) break;
        const shift = depth(next, now.room) - depth(index, was.room);
        if (shift === 0) break;
        // Its own lines are counted by its value change, if it has one; what it carries inside is not.
        const own = valued.has(`${change.target}:${change.id}`) ? lines(change.target === 'node' ? nodeValue(was.value as DraftNode) : was.value) : 0;
        bytes += (lines(was.value) - own) * 2 * shift;
        break;
      }
      case 'order':
        break;
      case 'level': {
        const was = change.room === '' ? before.level : index.nodes.get(change.room)?.value.inside?.level;
        bytes += (change.value === null ? 0 : utf8Bytes(JSON.stringify(change.value)) + 16) - (was === undefined ? 0 : utf8Bytes(JSON.stringify(was)) + 16);
        break;
      }
    }
  }
  return { bytes };
}

/** Whether every node, connector and flow id appears once in the whole file — `indexOf` keeps one per id. */
export function idsUnique(file: DraftDocument): boolean {
  const count = totals(file);
  const index = indexOf(file);
  return index.nodes.size === count.nodes && index.edges.size === count.edges && index.flows.size === count.flows && new Set(file.openPoints.map((point) => point.id)).size === file.openPoints.length;
}

/** The document-wide limits `validate.ts` holds a file to, so the owner's file always reopens whole. */
export function withinLimits(file: DraftDocument): boolean {
  const count = totals(file);
  return (
    count.nodes <= LIMITS.maxNodes &&
    count.edges <= LIMITS.maxEdges &&
    count.flows <= LIMITS.maxFlows &&
    file.openPoints.length <= LIMITS.maxOpenPoints
  );
}
