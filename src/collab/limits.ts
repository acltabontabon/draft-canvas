/**
 * What every copy of a shared file is held to, whoever changed it: the document-wide limits
 * `validate.ts` enforces on a file from disk, and one element per id. The owner checks every
 * collaborator's patch against these; a collaborator checks every commit from the owner.
 */
import { totals } from '../depth/tree';
import { LIMITS } from '../document/limits';
import type { DraftDocument } from '../document/types';
import type { Change } from './changes';
import { nodeValue, wireSettings } from './diff';
import { indexOf } from './fileIndex';
import { MAX_MESSAGE_BYTES } from './protocol';

/**
 * The most a collaborator may grow the shared file to, as compact UTF-8 JSON. Every count limit can be
 * met by a file far past what reopens (5,000 code snippets of 200 KB), which autosave would then keep:
 * this keeps the file inside `LIMITS.maxFileBytes` even written out indented, as a `.draftcanvas`
 * file is (which can double a list-heavy file), and a fresh copy of it inside one message.
 */
export const MAX_SHARED_FILE_BYTES = Math.min(10 * 1024 * 1024, LIMITS.maxFileBytes / 2.4, MAX_MESSAGE_BYTES - 64 * 1024);

const encoder = new TextEncoder();

/** `value` as UTF-8 JSON bytes. */
export function jsonBytes(value: unknown): number {
  const text = JSON.stringify(value) ?? '';
  // ASCII is the common case and needs no encoding to count.
  return /^[ -~]*$/.test(text) ? text.length : encoder.encode(text).byteLength;
}

/** What a room's wrapper (`inside` and its empty lists) adds to the file when a first shape opens it. */
const NEW_ROOM_BYTES = 128;

/**
 * How much `changes` grow `before` by, counted element by element so it never costs a whole-file
 * serialisation — and never an estimate a collaborator could push one way or the other: a whole-file
 * measure to correct one would be theirs to ask for with every patch.
 */
export function growthOf(before: DraftDocument, after: DraftDocument, changes: readonly Change[]): { bytes: number; exact: boolean } {
  const index = indexOf(before);
  const next = indexOf(after);
  // Rooms opened less rooms closed, from both files' indexes (built for the diff already): counted
  // per change instead, a room opened and emptied again patch after patch only ever added.
  let bytes = (next.rooms.size - index.rooms.size) * NEW_ROOM_BYTES;
  // What a removed shape took with it, from its rooms: only what is really gone — something moved out
  // of it in the same edit is still in the file, and counting it as gone let the file grow unseen.
  const removed = new Set(changes.filter((change) => change.kind === 'node' && change.value === null && index.nodes.get(change.id)?.value.inside).map((change) => (change as { id: string }).id));
  if (removed.size > 0) {
    const inRemoved = (room: string) => index.rooms.get(room)?.path.some((id) => removed.has(id)) ?? false;
    for (const [id, located] of index.nodes) if (inRemoved(located.room) && !next.nodes.has(id)) bytes -= jsonBytes(nodeValue(located.value)) + 1;
    for (const [id, located] of index.edges) if (inRemoved(located.room) && !next.edges.has(id)) bytes -= jsonBytes(located.value) + 1;
    for (const [id, located] of index.flows) if (inRemoved(located.room) && !next.flows.has(id)) bytes -= jsonBytes(located.value) + 1;
  }
  const exact = true;
  /** Something new in a list: the comma before it. */
  const added = () => {
    bytes += 1;
  };
  for (const change of changes) {
    switch (change.kind) {
      case 'node': {
        const was = index.nodes.get(change.id)?.value;
        bytes += (change.value ? jsonBytes(change.value) : 0) - (was ? jsonBytes(nodeValue(was)) : 0);
        if (!was && change.value) added();
        break;
      }
      case 'edge':
      case 'flow': {
        const was = (change.kind === 'edge' ? index.edges : index.flows).get(change.id)?.value;
        bytes += (change.value ? jsonBytes(change.value) : 0) - (was ? jsonBytes(was) : 0);
        if (!was && change.value) added();
        break;
      }
      case 'point': {
        const was = before.openPoints.find((point) => point.id === change.id);
        bytes += (change.value ? jsonBytes(change.value) : 0) - (was ? jsonBytes(was) : 0) + (!was && change.value ? 1 : 0);
        break;
      }
      case 'title':
        bytes += jsonBytes(change.value) - jsonBytes(before.metadata.title);
        break;
      case 'settings':
        // Without an embedded image, which no change carries and applying keeps: counted, each
        // settings change would take its size off the total again.
        bytes += jsonBytes(change.value) - jsonBytes(wireSettings(before.settings));
        break;
      // A move or a reorder only rearranges what is there: the same bytes, elsewhere (the rooms it
      // opens or empties are counted above).
      case 'move':
      case 'order':
        break;
      case 'level': {
        const was = change.room === '' ? before.level : index.nodes.get(change.room)?.value.inside?.level;
        bytes += (change.value === null ? 0 : jsonBytes(change.value)) - (was === undefined ? 0 : jsonBytes(was));
        break;
      }
    }
  }
  return { bytes, exact };
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
