/**
 * Git's blob id of a text, computed with WebCrypto: the same id `git hash-object` gives, in the
 * editor, the worker and the tests alike, without loading a Git library. Used to compare a working
 * copy with a revision (equal history content ⇔ equal blob id) and to key journal entries.
 */
import type { Oid } from './contracts';

const encoder = new TextEncoder();

export async function blobId(text: string): Promise<Oid> {
  const body = encoder.encode(text);
  const header = encoder.encode(`blob ${body.byteLength}\0`);
  const bytes = new Uint8Array(header.byteLength + body.byteLength);
  bytes.set(header, 0);
  bytes.set(body, header.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-1', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A short random id for repositories, alternatives, milestones and operations (`refs.ts` accepts it). */
export function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `${prefix}${[...bytes].map((byte) => byte.toString(36).padStart(2, '0')).join('').slice(0, 16)}`;
}
