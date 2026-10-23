/**
 * What every copy of a shared file is held to, whoever changed it: the document-wide limits
 * `validate.ts` enforces on a file from disk, and one element per id. The owner checks every
 * collaborator's patch against these; a collaborator checks every commit from the owner.
 */
import { totals } from '../depth/tree';
import { LIMITS } from '../document/limits';
import type { DraftDocument } from '../document/types';
import type { Change } from './changes';
import { nodeValue } from './diff';
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

/**
 * How much `changes` grow `before` by, counted element by element so it never costs a whole-file
 * serialisation. Exact, except that removing a shape with rooms inside counts only the shape: then
 * `exact` is false and the result is an upper bound.
 */
export function growthOf(before: DraftDocument, changes: readonly Change[]): { bytes: number; exact: boolean } {
  const index = indexOf(before);
  let bytes = 0;
  let exact = true;
  for (const change of changes) {
    switch (change.kind) {
      case 'node': {
        const was = index.nodes.get(change.id)?.value;
        if (change.value === null && was?.inside) exact = false;
        bytes += (change.value ? jsonBytes(change.value) : 0) - (was ? jsonBytes(nodeValue(was)) : 0);
        break;
      }
      case 'edge':
      case 'flow': {
        const was = (change.kind === 'edge' ? index.edges : index.flows).get(change.id)?.value;
        bytes += (change.value ? jsonBytes(change.value) : 0) - (was ? jsonBytes(was) : 0);
        break;
      }
      case 'point': {
        const was = before.openPoints.find((point) => point.id === change.id);
        bytes += (change.value ? jsonBytes(change.value) : 0) - (was ? jsonBytes(was) : 0);
        break;
      }
      case 'title':
        bytes += jsonBytes(change.value) - jsonBytes(before.metadata.title);
        break;
      case 'settings':
        bytes += jsonBytes(change.value) - jsonBytes(before.settings);
        break;
      // Moves, levels and orders rearrange what is there; what they add is a few bytes at most.
      default:
        bytes += 64;
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
