/**
 * What the history worker answers. A plain dispatcher, so the same code serves the worker and — in
 * tests, or where workers are unavailable — the page directly.
 *
 * Two families:
 * - **compute** (both platforms): canonical text and blob id of a file, parsing a revision,
 *   semantic diffs and descriptions. Pure work kept off the drawing thread.
 * - **browser storage** (web only): the `HistoryBackend` and each repository's `VersionStore`,
 *   on isomorphic-git over IndexedDB. The desktop app keeps its histories in the shell instead.
 *
 * Every request names its method from a closed list; anything else is refused. Arguments are
 * structured-clone data, never code.
 */
import type { DraftDocument } from '../document/types';
import type { HistoryBackend } from './backend';
import { HistoryError, type VersionStore } from './contracts';
import { semanticDiff } from './diff';
import { blobId } from './hash';
import { historyText, readHistoryText } from './snapshot';
import { describe, touchedNames } from './summary';

export interface Prepared {
  text: string;
  blobId: string;
}

export const compute = {
  async prepare(file: DraftDocument): Promise<Prepared> {
    const text = historyText(file);
    return { text, blobId: await blobId(text) };
  },
  async parse(text: string): Promise<{ document: DraftDocument; repaired: boolean; blobId: string }> {
    const { document, repaired } = readHistoryText(text);
    return { document, repaired, blobId: await blobId(text) };
  },
  async diff(before: DraftDocument | null, after: DraftDocument) {
    return semanticDiff(before, after);
  },
  async describe(before: DraftDocument | null, after: DraftDocument) {
    const diff = semanticDiff(before, after);
    return { ...describe(diff), touched: touchedNames(diff) };
  },
};

export type ComputeMethod = keyof typeof compute;

const BACKEND_METHODS = new Set<keyof HistoryBackend>(['list', 'create', 'remove', 'binding', 'putBinding', 'deleteBinding', 'bindings', 'exportBundle', 'importBundle', 'usage']);
const STORE_METHODS = new Set<keyof VersionStore>([
  'meta',
  'writeMeta',
  'writeSnapshot',
  'updateRef',
  'readRef',
  'listRefs',
  'readCommit',
  'readSnapshot',
  'log',
  'mergeBases',
  'isAncestor',
  'writeTag',
  'listTags',
  'journalPut',
  'journalList',
  'journalDelete',
  'usage',
  'maintain',
]);

export type Request =
  | { family: 'compute'; method: ComputeMethod; args: unknown[] }
  | { family: 'backend'; method: keyof HistoryBackend; args: unknown[] }
  | { family: 'store'; repoId: string; method: keyof VersionStore; args: unknown[] };

export interface SerializedError {
  code: HistoryError['code'] | 'internal';
  message: string;
}

export function serializeError(error: unknown): SerializedError {
  if (error instanceof HistoryError) return { code: error.code, message: error.message };
  const quota = (error as { name?: string } | null)?.name === 'QuotaExceededError';
  if (quota) return { code: 'quota', message: 'Storage for history is full.' };
  return { code: 'internal', message: 'History could not complete that.' };
}

/** Answers one request. `backend` is absent where the shell keeps histories (desktop). */
export async function handle(request: Request, backend: HistoryBackend | undefined): Promise<unknown> {
  switch (request.family) {
    case 'compute': {
      const fn = (compute as Record<string, (...args: unknown[]) => Promise<unknown>>)[request.method];
      if (!Object.prototype.hasOwnProperty.call(compute, request.method) || !fn) throw new HistoryError('invalid', 'Unknown history request.');
      return fn(...request.args);
    }
    case 'backend': {
      if (!backend) throw new HistoryError('unavailable', 'History storage is not in this worker.');
      if (!BACKEND_METHODS.has(request.method)) throw new HistoryError('invalid', 'Unknown history request.');
      if (request.method === 'create') {
        await backend.create(request.args[0] as Parameters<HistoryBackend['create']>[0]);
        return undefined;
      }
      return (backend[request.method] as (...args: unknown[]) => Promise<unknown>).apply(backend, request.args);
    }
    case 'store': {
      if (!backend) throw new HistoryError('unavailable', 'History storage is not in this worker.');
      if (!STORE_METHODS.has(request.method)) throw new HistoryError('invalid', 'Unknown history request.');
      const store = await backend.open(request.repoId);
      if (!store) throw new HistoryError('not-found', 'That history is not on this device.');
      return (store[request.method] as (...args: unknown[]) => Promise<unknown>).apply(store, request.args);
    }
  }
}
